import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server as HttpServer,
	type ServerResponse,
} from 'node:http';
import {
	createMcpHandler,
	hostHeaderValidationResponse,
	localhostAllowedHostnames,
	localhostAllowedOrigins,
	originValidationResponse,
	type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { responseProvesMcpActivity } from './activityDetection';
import {
	isAllowedMcpContentType,
	MCP_LOOPBACK_HOST,
	matchesBearerToken,
	readBoundedJsonBody,
	writeSafeHttpResponse,
} from './httpPolicy';
import {
	assertValidMcpSessionCredentials,
	isValidMcpOpaqueId,
	type McpSessionCredentials,
} from './sessionCredentials';
import {
	createCrispyToolServer,
	CRISPY_PING_TOOL_NAME,
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

interface ActiveRegistration extends McpSessionCredentials {
	revoked: boolean;
	activityObserved: boolean;
	pingObserved: boolean;
}

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
		this.sdkHandler = createMcpHandler(
			() => createCrispyToolServer(),
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
	registerSession(credentials: McpSessionCredentials): RegisteredMcpSession {
		if (
			this.lifecycle !== 'running'
			|| this.ready === undefined
			|| this.registrationAttempted
			|| credentials.generation !== this.generation
		) {
			throw new Error('MCP session registration failed.');
		}
		assertValidMcpSessionCredentials(credentials);
		this.registrationAttempted = true;
		this.registration = {
			...credentials,
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
		this.lifecycle = 'stopping';
		if (this.registration !== undefined) {
			this.registration.revoked = true;
		}
		const server = this.httpServer;
		this.httpServer = undefined;
		await Promise.allSettled([
			this.sdkHandler.close(),
			server === undefined ? Promise.resolve() : closeHttpServer(server, true),
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
			request.resume();
			writeSafeHttpResponse(response, 404, 'Not found.');
			return;
		}
		if (request.method !== 'POST') {
			request.resume();
			writeSafeHttpResponse(response, 405, 'Method not allowed.', { Allow: 'POST' });
			return;
		}

		const headerRejection = validateLoopbackHeaders(request.headers, request.url);
		if (headerRejection !== undefined) {
			request.resume();
			await writeWebResponse(response, headerRejection);
			return;
		}
		if (
			registration.revoked
			|| !matchesBearerToken(request.headers.authorization, registration.token)
		) {
			request.resume();
			writeSafeHttpResponse(response, 401, 'Unauthorized.', {
				'WWW-Authenticate': 'Bearer',
			});
			return;
		}
		if (!isAllowedMcpContentType(request.headers['content-type'])) {
			request.resume();
			writeSafeHttpResponse(response, 415, 'Unsupported media type.');
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

		const nodeHandler = toNodeHandler({
			fetch: async (webRequest, options) => {
				const sdkResponse = await this.sdkHandler.fetch(webRequest, options);
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
		await nodeHandler(request, response, body.parsedBody);
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

async function writeWebResponse(
	response: ServerResponse,
	webResponse: Response,
): Promise<void> {
	if (response.headersSent || response.destroyed) {
		return;
	}
	const body = await webResponse.text();
	const headers: Record<string, string> = {};
	webResponse.headers.forEach((value, name) => {
		headers[name] = value;
	});
	response.writeHead(webResponse.status, headers);
	response.end(body);
}
