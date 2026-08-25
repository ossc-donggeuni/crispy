import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server as HttpServer,
	type ServerResponse,
} from 'node:http';
import { performance } from 'node:perf_hooks';
import {
	createMcpHandler,
	hostHeaderValidationResponse,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	originValidationResponse,
	type McpHttpHandler,
	type CallToolResult,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
	ACTIVITY_IPC_MAX_UTF8_BYTES,
	createClearAgentActivityRequested,
	createSetAgentActivityRequested,
	normalizeAgentActivityPath,
	type AgentActivityKind,
	type AgentActivityRequested,
	type AgentActivityTargetKind,
} from './agentActivityProtocol';
import {
	RegistrationActivityAdmission,
	type MonotonicClock,
} from './activityAdmission';
import { responseProvesMcpActivity } from './activityDetection';
import {
	MCP_AUTHENTICATED_IN_FLIGHT_PER_REGISTRATION,
	MCP_HTTP_HEADERS_TIMEOUT_MS,
	MCP_HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS,
	MCP_HTTP_KEEP_ALIVE_TIMEOUT_MS,
	MCP_HTTP_MAX_CONNECTIONS,
	MCP_HTTP_MAX_REQUESTS_PER_SOCKET,
	MCP_HTTP_REQUEST_TIMEOUT_MS,
	isAllowedMcpContentType,
	MCP_LOOPBACK_HOST,
	matchesBearerToken,
	readBoundedJsonBody,
	writeSafeHttpResponse,
	writeTooManyRequestsResponse,
} from './httpPolicy';
import {
	assertValidMcpSessionCredentials,
	isValidMcpOpaqueId,
	type McpSessionCredentials,
} from './sessionCredentials';
import { sanitizeMcpSdkResponse } from './sdkResponsePolicy';
import {
	createActivityToolErrorResult,
	createActivityToolSuccessResult,
	createCrispyToolServer,
	CRISPY_PING_TOOL_NAME,
	isCrispyToolValidationFailure,
	normalizeCrispyToolCallArguments,
	type AgentActivityToolOperation,
} from './toolServer';

export interface McpActivityObservedEvent {
	readonly type: 'session.mcpActivityObserved';
	readonly generation: string;
	readonly sessionId: string;
}

export interface McpPingObservedEvent {
	readonly type: 'session.crispyPingObserved';
	readonly generation: string;
	readonly sessionId: string;
}

export interface McpProtocolServerOptions {
	readonly generation: string;
	readonly onActivityObserved?: (event: McpActivityObservedEvent) => void;
	readonly onPingObserved?: (event: McpPingObservedEvent) => void;
	readonly monotonicClock?: MonotonicClock;
	readonly agentActivityTransport?: AgentActivityIpcTransport;
}

export interface AgentActivityIpcTransport {
	isConnected(): boolean;
	send(
		event: AgentActivityRequested,
		callback: (error: Error | null) => void,
	): boolean;
}

export interface McpServerReady {
	readonly host: typeof MCP_LOOPBACK_HOST;
	readonly port: number;
}

export interface RegisteredMcpSession {
	readonly generation: string;
	readonly sessionId: string;
	readonly url: string;
}

type ServerLifecycle = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

interface AuthenticatedRequestSlot {
	release(): void;
}

interface ActiveRegistration extends McpSessionCredentials {
	readonly agentActivityCompatible: boolean;
	readonly activityAdmission: RegistrationActivityAdmission | undefined;
	readonly authenticatedRequestSlots: Set<AuthenticatedRequestSlot>;
	authenticatedInFlight: number;
	revoked: boolean;
	activityObserved: boolean;
	pingObserved: boolean;
}

interface SetActivityInput {
	readonly path: string;
	readonly targetKind: AgentActivityTargetKind;
	readonly activity: AgentActivityKind;
}

interface ClearActivityInput {
	readonly path: string;
	readonly targetKind: AgentActivityTargetKind;
}

const CLOSED_AGENT_ACTIVITY_TRANSPORT: AgentActivityIpcTransport = Object.freeze({
	isConnected: () => false,
	send: () => false,
});

/**
 * C1의 in-process protocol core다. C2 child entry가 이 객체를 소유하고 strict IPC를
 * register/revoke/shutdown 메서드에 연결한다.
 */
export class CrispyMcpProtocolServer {
	private readonly generation: string;
	private readonly onActivityObserved: (
		event: McpActivityObservedEvent,
	) => void;
	private readonly onPingObserved: (event: McpPingObservedEvent) => void;
	private readonly monotonicClock: MonotonicClock;
	private readonly agentActivityTransport: AgentActivityIpcTransport;
	private readonly requestRegistrations = new WeakMap<Request, ActiveRegistration>();
	private readonly sdkHandler: McpHttpHandler;
	private lifecycle: ServerLifecycle = 'idle';
	private startPromise: Promise<McpServerReady> | undefined;
	private httpServer: HttpServer | undefined;
	private ready: McpServerReady | undefined;
	private registration: ActiveRegistration | undefined;
	private registrationAttempted = false;
	private shutdownPromise: Promise<void> | undefined;

	constructor(options: McpProtocolServerOptions) {
		if (!isValidMcpOpaqueId(options.generation)) {
			throw new Error('MCP server generation is invalid.');
		}
		this.generation = options.generation;
		this.onActivityObserved = options.onActivityObserved ?? (() => undefined);
		this.onPingObserved = options.onPingObserved ?? (() => undefined);
		this.monotonicClock = options.monotonicClock ?? (() => performance.now());
		this.agentActivityTransport = options.agentActivityTransport
			?? CLOSED_AGENT_ACTIVITY_TRANSPORT;
		this.sdkHandler = createMcpHandler(
			(context) => {
				const registration = context.requestInfo === undefined
					? undefined
					: this.requestRegistrations.get(context.requestInfo);
				return createCrispyToolServer({
					agentActivityCompatible:
						registration?.agentActivityCompatible === true,
					handleAgentActivity: (operation, input) => registration === undefined
						? createActivityToolErrorResult('registration_inactive')
						: this.handleAgentActivity(registration, operation, input),
				});
			},
			{
				legacy: 'stateless',
				/** SDK 원문 오류는 token/path/UI/log로 전달하지 않는다. */
				onerror: () => undefined,
			},
		);
	}

	/** Child가 직접 listen(0, 127.0.0.1)하고 실제 port를 반환한다. */
	start(): Promise<McpServerReady> {
		if (this.lifecycle === 'starting' && this.startPromise !== undefined) {
			return this.startPromise;
		}
		if (this.lifecycle === 'running' && this.ready !== undefined) {
			return this.startPromise ?? Promise.resolve(this.ready);
		}
		if (this.lifecycle !== 'idle') {
			return Promise.reject(new Error('MCP server cannot be started.'));
		}

		this.lifecycle = 'starting';
		this.startPromise = this.performStart();
		return this.startPromise;
	}

	private async performStart(): Promise<McpServerReady> {
		const server = createServer((request, response) => {
			void this.handleNodeRequest(request, response).catch(() => {
				writeSafeHttpResponse(response, 500, 'Internal server error.');
			});
		});
		server.maxHeadersCount = 64;
		server.maxConnections = MCP_HTTP_MAX_CONNECTIONS;
		server.headersTimeout = MCP_HTTP_HEADERS_TIMEOUT_MS;
		server.requestTimeout = MCP_HTTP_REQUEST_TIMEOUT_MS;
		server.keepAliveTimeout = MCP_HTTP_KEEP_ALIVE_TIMEOUT_MS;
		server.keepAliveTimeoutBuffer = MCP_HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS;
		server.maxRequestsPerSocket = MCP_HTTP_MAX_REQUESTS_PER_SOCKET;
		server.on('clientError', (_error, socket) => {
			if (socket.writable) {
				socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
			}
		});
		this.httpServer = server;

		try {
			await listenOnLoopback(server);
			if (this.lifecycle !== 'starting' || this.httpServer !== server) {
				throw new Error('MCP server start was cancelled.');
			}
			const address = server.address();
			if (
				address === null
				|| typeof address === 'string'
				|| address.address !== MCP_LOOPBACK_HOST
				|| !Number.isSafeInteger(address.port)
				|| address.port <= 0
			) {
				throw new Error('MCP server address is invalid.');
			}
			this.ready = Object.freeze({
				host: MCP_LOOPBACK_HOST,
				port: address.port,
			});
			this.lifecycle = 'running';
			return this.ready;
		} catch {
			if (this.httpServer === server) {
				this.httpServer = undefined;
			}
			if (this.lifecycle === 'starting') {
				this.lifecycle = 'stopped';
			}
			await closeHttpServer(server);
			throw new Error('MCP server failed to start.');
		}
	}

	/** 한 generation에는 정확히 한 session credential만 등록한다. */
	registerSession(
		credentials: McpSessionCredentials,
		agentActivityCompatible: boolean,
	): RegisteredMcpSession {
		if (
			this.lifecycle !== 'running'
			|| this.ready === undefined
			|| this.registrationAttempted
			|| credentials.generation !== this.generation
			|| typeof agentActivityCompatible !== 'boolean'
		) {
			throw new Error('MCP session registration failed.');
		}
		assertValidMcpSessionCredentials(credentials);
		this.registrationAttempted = true;
		this.registration = {
			generation: credentials.generation,
			sessionId: credentials.sessionId,
			routeId: credentials.routeId,
			token: credentials.token,
			agentActivityCompatible,
			activityAdmission: agentActivityCompatible
				? new RegistrationActivityAdmission(this.monotonicClock)
				: undefined,
			authenticatedRequestSlots: new Set(),
			authenticatedInFlight: 0,
			revoked: false,
			activityObserved: false,
			pingObserved: false,
		};
		return Object.freeze({
			generation: credentials.generation,
			sessionId: credentials.sessionId,
			url: `http://${MCP_LOOPBACK_HOST}:${this.ready.port}/mcp/${credentials.routeId}`,
		});
	}

	/** Stale generation/session revoke는 current registration을 변경하지 않는다. */
	revokeSession(generation: string, sessionId: string): boolean {
		const current = this.registration;
		if (
			current === undefined
			|| current.revoked
			|| current.generation !== generation
			|| current.sessionId !== sessionId
		) {
			return false;
		}
		current.activityAdmission?.close();
		current.revoked = true;
		return true;
	}

	/** Revoke, SDK handler close와 loopback listener close를 멱등적으로 수행한다. */
	shutdown(): Promise<void> {
		this.shutdownPromise ??= this.performShutdown();
		return this.shutdownPromise;
	}

	private async performShutdown(): Promise<void> {
		if (this.lifecycle === 'stopped') {
			return;
		}
		const pendingStart = this.lifecycle === 'starting'
			? this.startPromise
			: undefined;
		const registration = this.registration;
		if (registration !== undefined) {
			registration.activityAdmission?.close();
			registration.revoked = true;
		}
		this.lifecycle = 'stopping';
		const server = this.httpServer;
		this.httpServer = undefined;
		const serverClose = server === undefined
			? Promise.resolve()
			: closeHttpServer(server, true);
		/** closeAllConnections has synchronously terminalized the HTTP boundary. */
		if (registration !== undefined) {
			this.releaseAuthenticatedRequestSlots(registration);
		}
		await Promise.allSettled([
			this.sdkHandler.close(),
			serverClose,
			pendingStart ?? Promise.resolve(),
		]);
		this.ready = undefined;
		this.lifecycle = 'stopped';
	}

	private async handleNodeRequest(
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const registration = this.registration;
		if (
			this.lifecycle !== 'running'
			|| registration === undefined
			|| request.url !== `/mcp/${registration.routeId}`
		) {
			this.rejectWithoutBodyDrain(request, response, 404, 'Not found.');
			return;
		}
		if (request.method !== 'POST') {
			this.rejectWithoutBodyDrain(
				request,
				response,
				405,
				'Method not allowed.',
				{ Allow: 'POST' },
			);
			return;
		}

		const headerRejection = validateLoopbackHeaders(request.headers, request.url);
		if (headerRejection !== undefined) {
			request.pause();
			writeSafeHttpResponse(
				response,
				headerRejection.status,
				'Request headers rejected.',
				{ Connection: 'close' },
			);
			return;
		}
		if (
			registration.revoked
			|| !matchesBearerToken(request.headers.authorization, registration.token)
		) {
			this.rejectWithoutBodyDrain(request, response, 401, 'Unauthorized.', {
				'WWW-Authenticate': 'Bearer',
			});
			return;
		}

		const requestSlot = this.acquireAuthenticatedRequestSlot(registration);
		if (requestSlot === undefined) {
			request.pause();
			writeTooManyRequestsResponse(response);
			return;
		}
		try {
			if (!isAllowedMcpContentType(request.headers['content-type'])) {
				request.pause();
				writeSafeHttpResponse(response, 415, 'Unsupported media type.', {
					Connection: 'close',
				});
				return;
			}

			const body = await readBoundedJsonBody(request);
			if (!body.ok) {
				writeSafeHttpResponse(
					response,
					body.status,
					body.status === 413 ? 'Request body too large.' : 'Bad request.',
					body.closeConnection ? { Connection: 'close' } : undefined,
				);
				return;
			}
			const normalizedBody = normalizeCrispyToolCallArguments(
				body.parsedBody,
				registration.agentActivityCompatible,
			);

			const nodeHandler = toNodeHandler({
				fetch: async (webRequest, options) => {
					this.requestRegistrations.set(webRequest, registration);
					const rawSdkResponse = await this.sdkHandler.fetch(webRequest, {
						...options,
						parsedBody: normalizedBody,
					});
					const sdkResponse = await sanitizeMcpSdkResponse(rawSdkResponse);
					if (
						this.shouldObserveActivity(registration)
						|| this.shouldObservePing(registration, body.parsedBody)
					) {
						try {
							const observationResponse = sdkResponse.clone();
							await this.observeMcpResponse(
								registration,
								body.parsedBody,
								observationResponse,
							).catch(() => undefined);
						} catch {
							/** Response clone 실패는 실제 MCP response 전달을 막지 않는다. */
						}
					}
					return sdkResponse;
				},
			}, { onerror: () => undefined });
			await nodeHandler(request, response, normalizedBody);
		} finally {
			requestSlot.release();
		}
	}

	private rejectWithoutBodyDrain(
		request: IncomingMessage,
		response: ServerResponse,
		status: number,
		body: string,
		headers?: Readonly<Record<string, string>>,
	): void {
		request.pause();
		writeSafeHttpResponse(response, status, body, {
			...headers,
			Connection: 'close',
		});
	}

	private acquireAuthenticatedRequestSlot(
		registration: ActiveRegistration,
	): AuthenticatedRequestSlot | undefined {
		if (
			registration.authenticatedInFlight
			>= MCP_AUTHENTICATED_IN_FLIGHT_PER_REGISTRATION
		) {
			return undefined;
		}
		registration.authenticatedInFlight += 1;
		let active = true;
		const slot: AuthenticatedRequestSlot = Object.freeze({
			release: (): void => {
				if (!active) {
					return;
				}
				active = false;
				registration.authenticatedRequestSlots.delete(slot);
				registration.authenticatedInFlight -= 1;
			},
		});
		registration.authenticatedRequestSlots.add(slot);
		return slot;
	}

	private releaseAuthenticatedRequestSlots(
		registration: ActiveRegistration,
	): void {
		for (const slot of [...registration.authenticatedRequestSlots].reverse()) {
			slot.release();
		}
	}

	private handleAgentActivity(
		registration: ActiveRegistration,
		operation: AgentActivityToolOperation,
		input: unknown,
	): CallToolResult {
		const admission = registration.activityAdmission;
		if (
			admission === undefined
			|| admission.state.closed
			|| registration.revoked
			|| this.registration !== registration
			|| this.lifecycle !== 'running'
		) {
			return createActivityToolErrorResult('registration_inactive');
		}
		if (!admission.acquireToken()) {
			return admission.state.closed
				? createActivityToolErrorResult('registration_inactive')
				: createActivityToolErrorResult('busy');
		}
		if (isCrispyToolValidationFailure(input)) {
			return createActivityToolErrorResult('invalid_input');
		}

		try {
			const pathInput = operation === 'set'
				? input as SetActivityInput
				: input as ClearActivityInput;
			const normalized = normalizeAgentActivityPath(
				pathInput.path,
				pathInput.targetKind,
			);
			if (!normalized.ok) {
				return createActivityToolErrorResult(normalized.error);
			}
			const event = operation === 'set'
				? createSetAgentActivityRequested({
					sessionId: registration.sessionId,
					generation: registration.generation,
					path: normalized.path,
					targetKind: pathInput.targetKind,
					activity: (pathInput as SetActivityInput).activity,
				})
				: createClearAgentActivityRequested({
					sessionId: registration.sessionId,
					generation: registration.generation,
					path: normalized.path,
					targetKind: pathInput.targetKind,
				});
			const serializedEvent = JSON.stringify(event);
			const eventBytes = Buffer.byteLength(serializedEvent, 'utf8');
			if (eventBytes > ACTIVITY_IPC_MAX_UTF8_BYTES) {
				return createActivityToolErrorResult('payload_too_large');
			}
			const reservation = admission.reserveChildEvent(eventBytes);
			if (reservation === undefined) {
				return createActivityToolErrorResult('busy');
			}

			try {
				if (!this.agentActivityTransport.isConnected()) {
					reservation.release();
					return createActivityToolErrorResult('registration_inactive');
				}
				if (
					admission.state.closed
					|| registration.revoked
					|| this.registration !== registration
					|| this.lifecycle !== 'running'
				) {
					reservation.release();
					return createActivityToolErrorResult('registration_inactive');
				}
				this.agentActivityTransport.send(event, () => reservation.release());
				return createActivityToolSuccessResult();
			} catch {
				reservation.release();
				return createActivityToolErrorResult('internal_error');
			}
		} catch {
			return createActivityToolErrorResult('internal_error');
		}
	}

	private async observeMcpResponse(
		registration: ActiveRegistration,
		requestBody: unknown,
		response: Response,
	): Promise<void> {
		if (
			!this.shouldObserveActivity(registration)
			&& !this.shouldObservePing(registration, requestBody)
		) {
			cancelResponseBody(response.body);
			return;
		}
		if (!await responseProvesMcpActivity(requestBody, response)) {
			return;
		}
		this.emitActivityObserved(registration);
		if (isCrispyPingCall(requestBody)) {
			this.emitPingObserved(registration);
		}
	}

	private emitActivityObserved(registration: ActiveRegistration): void {
		/** Response를 읽는 동안 revoke/shutdown되거나 다른 요청이 먼저 관찰될 수 있다. */
		if (
			registration.revoked
			|| registration.activityObserved
			|| this.registration !== registration
			|| this.lifecycle !== 'running'
		) {
			return;
		}

		registration.activityObserved = true;
		try {
			this.onActivityObserved(Object.freeze({
				type: 'session.mcpActivityObserved',
				generation: registration.generation,
				sessionId: registration.sessionId,
			}));
		} catch {
			/** Observer 실패가 이미 생성된 MCP result를 오염시키지 않게 한다. */
		}
	}

	private shouldObserveActivity(registration: ActiveRegistration): boolean {
		return !registration.revoked
			&& !registration.activityObserved
			&& this.registration === registration
			&& this.lifecycle === 'running';
	}

	private shouldObservePing(
		registration: ActiveRegistration,
		requestBody: unknown,
	): boolean {
		return isCrispyPingCall(requestBody)
			&& !registration.revoked
			&& !registration.pingObserved
			&& this.registration === registration
			&& this.lifecycle === 'running';
	}

	private emitPingObserved(registration: ActiveRegistration): void {
		if (
			this.lifecycle !== 'running'
			|| registration.revoked
			|| registration.pingObserved
			|| this.registration !== registration
		) {
			return;
		}
		registration.pingObserved = true;
		try {
			this.onPingObserved(Object.freeze({
				type: 'session.crispyPingObserved',
				generation: registration.generation,
				sessionId: registration.sessionId,
			}));
		} catch {
			/** Diagnostic observer 실패가 MCP tool result를 오염시키지 않는다. */
		}
	}
}

function isCrispyPingCall(value: unknown): boolean {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const request = value as Record<string, unknown>;
	const params = request.params;
	if (params === null || typeof params !== 'object' || Array.isArray(params)) {
		return false;
	}
	const argumentsValue = (params as Record<string, unknown>).arguments;
	return request.method === 'tools/call'
		&& (params as Record<string, unknown>).name === CRISPY_PING_TOOL_NAME
		&& (
			argumentsValue === undefined
			|| (
				argumentsValue !== null
				&& typeof argumentsValue === 'object'
				&& !Array.isArray(argumentsValue)
				&& Object.keys(argumentsValue).length === 0
			)
		);
}

function cancelResponseBody(body: ReadableStream<Uint8Array> | null): void {
	if (body !== null) {
		void body.cancel().catch(() => undefined);
	}
}

function listenOnLoopback(server: HttpServer): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (): void => {
			server.off('listening', onListening);
			reject(new Error('MCP server listen failed.'));
		};
		const onListening = (): void => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(0, MCP_LOOPBACK_HOST);
	});
}

function closeHttpServer(
	server: HttpServer,
	terminateActiveConnections = false,
): Promise<void> {
	return new Promise((resolve) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close(() => resolve());
		if (terminateActiveConnections) {
			/** Dedicated loopback child이므로 shutdown 중인 active upload/response도 즉시 회수한다. */
			server.closeAllConnections();
		}
	});
}

function validateLoopbackHeaders(
	headers: IncomingHttpHeaders,
	path: string,
): Response | undefined {
	const request = new Request(`http://${MCP_LOOPBACK_HOST}${path}`, {
		method: 'POST',
		headers: nodeHeadersToWebHeaders(headers),
	});
	return hostHeaderValidationResponse(request, localhostAllowedHostnames())
		?? originValidationResponse(request, localhostAllowedOrigins());
}

function nodeHeadersToWebHeaders(headers: IncomingHttpHeaders): Headers {
	const result = new Headers();
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === 'string') {
			result.append(name, value);
		} else if (Array.isArray(value)) {
			for (const item of value) {
				result.append(name, item);
			}
		}
	}
	return result;
}
