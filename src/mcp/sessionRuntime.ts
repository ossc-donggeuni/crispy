import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
	createMcpFailure,
	type McpFailure,
	type McpFailureReason,
} from './failureReason';
import {
	parseMcpChildToHostMessage,
	type HostToMcpChildMessage,
	type McpChildToHostMessage,
} from './ipcProtocol';
import { MCP_CHILD_GENERATION_ENV } from './childBootstrap';
import {
	createMcpSessionCredentials,
	isValidMcpOpaqueId,
	type McpRandomBytes,
} from './sessionCredentials';

export type McpRuntimeLifecycle =
	| 'starting'
	| 'running'
	| 'stopping'
	| 'stopped'
	| 'crashed';

export interface McpRuntimeTimeouts {
	readonly readyMs: number;
	readonly registrationMs: number;
	readonly revokeMs: number;
	readonly shutdownMs: number;
	readonly killMs: number;
}

export const DEFAULT_MCP_RUNTIME_TIMEOUTS = Object.freeze({
	readyMs: 5000,
	registrationMs: 3000,
	revokeMs: 1000,
	shutdownMs: 2000,
	killMs: 1000,
} satisfies McpRuntimeTimeouts);

export type McpProviderAction = 'continue_without_mcp' | 'keep_running';

export interface McpRuntimeFailureEvent {
	readonly type: 'runtime.failure';
	readonly generation: string;
	readonly sessionId: string;
	readonly failure: McpFailure;
	readonly providerStarted: boolean;
	readonly providerAction: McpProviderAction;
}

export interface McpRuntimeActivityEvent {
	readonly type: 'session.mcpActivityObserved';
	readonly generation: string;
	readonly sessionId: string;
}

export type McpSessionRuntimeEvent =
	| McpRuntimeFailureEvent
	| McpRuntimeActivityEvent;

export type McpPrepareResult =
	| {
		readonly ok: true;
		readonly connection: McpConnectionDescriptor;
	}
	| {
		readonly ok: false;
		readonly failure: McpFailure;
		readonly providerAction: 'continue_without_mcp';
	};

/**
 * Provider serializer가 후속 Phase에서 명시적으로 접근할 Host-only credential 경계다.
 * ECMAScript private field와 toJSON으로 token이 일반 object snapshot에 나타나지 않는다.
 */
export class McpConnectionDescriptor {
	readonly generation: string;
	readonly sessionId: string;
	readonly url: string;
	#token: string | undefined;

	constructor(
		generation: string,
		sessionId: string,
		url: string,
		token: string,
	) {
		this.generation = generation;
		this.sessionId = sessionId;
		this.url = url;
		this.#token = token;
		Object.freeze(this);
	}

	withBearerToken<Result>(consumer: (token: string) => Result): Result {
		const token = this.#token;
		if (token === undefined) {
			throw new Error('MCP connection credential is no longer active.');
		}
		return consumer(token);
	}

	/** Runtime ownership 종료 시 이미 전달된 descriptor도 더 이상 credential을 주지 않는다. */
	invalidate(): void {
		this.#token = undefined;
	}

	toJSON(): Readonly<{
		generation: string;
		sessionId: string;
		url: string;
	}> {
		return Object.freeze({
			generation: this.generation,
			sessionId: this.sessionId,
			url: this.url,
		});
	}
}

export interface McpChildSpawnRequest {
	readonly executablePath: string;
	readonly childEntryPath: string;
	readonly generation: string;
	readonly environment: NodeJS.ProcessEnv;
}

export type McpChildSpawner = (request: McpChildSpawnRequest) => ChildProcess;

export interface McpHostRuntimeInfo {
	readonly platform: string;
	readonly arch: string;
	readonly nodeVersion: string;
	readonly executablePath: string;
}

export interface McpSessionRuntimeOptions {
	readonly generation: string;
	readonly sessionId: string;
	readonly childEntryPath: string;
	readonly parentEnvironment?: NodeJS.ProcessEnv;
	readonly hostRuntime?: McpHostRuntimeInfo;
	readonly timeouts?: Partial<McpRuntimeTimeouts>;
	readonly randomBytes?: McpRandomBytes;
	readonly spawnChild?: McpChildSpawner;
	readonly createRequestId?: () => string;
	readonly onEvent?: (event: McpSessionRuntimeEvent) => void;
}

interface PendingOperation {
	readonly expectedType: 'auth.registered' | 'auth.revoked';
	readonly sessionId: string;
	readonly resolve: (message: McpChildToHostMessage) => void;
	readonly reject: (error: RuntimeSignal) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

class RuntimeSignal extends Error {
	constructor(readonly kind: 'timeout' | 'child_ended' | 'protocol' | 'cancelled') {
		super('MCP runtime operation failed.');
	}
}

interface ReadyWaiter {
	readonly resolve: (port: number) => void;
	readonly reject: (error: RuntimeSignal) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface ExitWaiter {
	readonly resolve: () => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

const SUPPORTED_MCP_HOSTS = new Set([
	'darwin-arm64',
	'linux-x64',
	'win32-x64',
]);

/** ExtensionContext.extensionUri를 기준으로 production child asset을 찾는 Host API다. */
export function resolveMcpChildAssetPath(
	extensionUri: Readonly<{ fsPath: string }>,
): string {
	return path.join(extensionUri.fsPath, 'dist', 'mcp-server.mjs');
}

/** 대소문자 변형 token env를 제거하고 child 전용 Node mode와 generation만 더한다. */
export function createMcpChildEnvironment(
	parentEnvironment: NodeJS.ProcessEnv,
	generation: string,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(parentEnvironment)) {
		const upperName = name.toUpperCase();
		if (
			upperName === 'CRISPY_MCP_TOKEN'
			|| upperName === MCP_CHILD_GENERATION_ENV
			|| upperName === 'ELECTRON_RUN_AS_NODE'
		) {
			continue;
		}
		environment[name] = value;
	}
	environment.ELECTRON_RUN_AS_NODE = '1';
	environment[MCP_CHILD_GENERATION_ENV] = generation;
	return environment;
}

/** shell/system Node를 거치지 않고 Extension Host executable을 IPC child로 직접 시작한다. */
export function spawnMcpChild(request: McpChildSpawnRequest): ChildProcess {
	return spawn(request.executablePath, [request.childEntryPath], {
		env: request.environment,
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		shell: false,
		windowsHide: true,
	});
}

export function validateMcpHostRuntime(
	info: McpHostRuntimeInfo,
): McpFailureReason | undefined {
	if (!SUPPORTED_MCP_HOSTS.has(`${info.platform}-${info.arch}`)) {
		return 'unsupported_platform';
	}
	const majorVersion = /^(\d+)\./.exec(info.nodeVersion)?.[1];
	if (
		majorVersion === undefined
		|| Number(majorVersion) < 22
		|| info.executablePath.length === 0
	) {
		return 'unsupported_runtime';
	}
	return undefined;
}

/** Agent session 하나가 독립 child, port, route, token과 generation을 소유한다. */
export class McpSessionRuntime {
	readonly generation: string;
	readonly sessionId: string;
	private readonly childEntryPath: string;
	private readonly parentEnvironment: NodeJS.ProcessEnv;
	private readonly hostRuntime: McpHostRuntimeInfo;
	private readonly timeouts: McpRuntimeTimeouts;
	private readonly randomBytes: McpRandomBytes | undefined;
	private readonly spawnChild: McpChildSpawner;
	private readonly createRequestId: () => string;
	private readonly onEvent: (event: McpSessionRuntimeEvent) => void;
	private lifecycleValue: McpRuntimeLifecycle = 'stopped';
	private startedOnce = false;
	private stage: 'idle' | 'ready' | 'registering' | 'running' = 'idle';
	private startPromise: Promise<McpPrepareResult> | undefined;
	private cleanupPromise: Promise<void> | undefined;
	private child: ChildProcess | undefined;
	private readyWaiter: ReadyWaiter | undefined;
	private readySeen = false;
	private childEnded = false;
	private pendingOperations = new Map<string, PendingOperation>();
	private exitWaiters = new Set<ExitWaiter>();
	private registrationAttempted = false;
	private connection: McpConnectionDescriptor | undefined;
	private providerStarted = false;
	private activityObserved = false;
	private failureEmitted = false;

	private readonly childMessageListener = (message: unknown): void => {
		this.handleChildMessage(message);
	};
	private readonly childErrorListener = (): void => {
		this.handleChildError();
	};
	private readonly childExitListener = (): void => {
		this.handleChildEnd();
	};

	constructor(options: McpSessionRuntimeOptions) {
		if (
			!isValidMcpOpaqueId(options.generation)
			|| !isValidMcpOpaqueId(options.sessionId)
		) {
			throw new Error('MCP runtime identity is invalid.');
		}
		this.generation = options.generation;
		this.sessionId = options.sessionId;
		this.childEntryPath = options.childEntryPath;
		this.parentEnvironment = options.parentEnvironment ?? process.env;
		this.hostRuntime = options.hostRuntime ?? {
			platform: process.platform,
			arch: process.arch,
			nodeVersion: process.versions.node,
			executablePath: process.execPath,
		};
		this.timeouts = normalizeTimeouts(options.timeouts);
		this.randomBytes = options.randomBytes;
		this.spawnChild = options.spawnChild ?? spawnMcpChild;
		this.createRequestId = options.createRequestId
			?? (() => `request-${randomUUID()}`);
		this.onEvent = options.onEvent ?? (() => undefined);
	}

	get lifecycle(): McpRuntimeLifecycle {
		return this.lifecycleValue;
	}

	start(): Promise<McpPrepareResult> {
		if (
			this.startPromise !== undefined
			&& (
				this.lifecycleValue === 'starting'
				|| this.lifecycleValue === 'running'
			)
		) {
			return this.startPromise;
		}
		if (this.startedOnce) {
			return Promise.resolve(failedPrepare(
				this.lifecycleValue === 'crashed'
					? 'adapter_exited'
					: 'adapter_start_failed',
			));
		}
		this.startedOnce = true;
		this.lifecycleValue = 'starting';
		this.startPromise = this.performStart();
		return this.startPromise;
	}

	markProviderStarted(): boolean {
		if (this.lifecycleValue !== 'running') {
			return false;
		}
		this.providerStarted = true;
		return true;
	}

	stop(): Promise<void> {
		if (this.cleanupPromise !== undefined) {
			return this.cleanupPromise;
		}
		this.startedOnce = true;
		if (this.lifecycleValue === 'crashed') {
			this.cleanupPromise = this.performCleanup(true);
			return this.cleanupPromise;
		}

		this.lifecycleValue = 'stopping';
		this.invalidateConnection();
		this.rejectAwaiters(new RuntimeSignal('cancelled'));
		this.cleanupPromise = this.performCleanup(false).finally(() => {
			this.lifecycleValue = 'stopped';
		});
		return this.cleanupPromise;
	}

	private async performStart(): Promise<McpPrepareResult> {
		const supportFailure = validateMcpHostRuntime(this.hostRuntime);
		if (supportFailure !== undefined) {
			this.lifecycleValue = 'stopped';
			return failedPrepare(supportFailure);
		}

		let failureReason: McpFailureReason = 'adapter_start_failed';
		try {
			const credentials = createMcpSessionCredentials(
				this.generation,
				this.sessionId,
				this.randomBytes,
			);
			const readyPromise = this.waitForReady();
			/** Synchronous spawn throw 전에도 waiter rejection이 unhandled가 되지 않게 한다. */
			void readyPromise.catch(() => undefined);
			this.child = this.spawnChild({
				executablePath: this.hostRuntime.executablePath,
				childEntryPath: this.childEntryPath,
				generation: this.generation,
				environment: createMcpChildEnvironment(
					this.parentEnvironment,
					this.generation,
				),
			});
			this.attachChild(this.child);
			this.stage = 'ready';
			const port = await readyPromise;
			this.assertCurrentStarting();

			this.stage = 'registering';
			this.registrationAttempted = true;
			failureReason = 'auth_registration_failed';
			await this.sendOperation({
				type: 'auth.register',
				requestId: this.nextRequestId(),
				generation: this.generation,
				sessionId: this.sessionId,
				routeId: credentials.routeId,
				token: credentials.token,
			}, 'auth.registered', this.timeouts.registrationMs);
			this.assertCurrentStarting();

			const connection = new McpConnectionDescriptor(
				this.generation,
				this.sessionId,
				`http://127.0.0.1:${port}/mcp/${credentials.routeId}`,
				credentials.token,
			);
			this.connection = connection;
			this.stage = 'running';
			this.lifecycleValue = 'running';
			return Object.freeze({ ok: true, connection });
		} catch (error) {
			if (error instanceof RuntimeSignal && error.kind === 'timeout') {
				failureReason = this.stage === 'ready'
					? 'adapter_ready_timeout'
					: failureReason;
			}
			await this.stop();
			return failedPrepare(failureReason);
		}
	}

	private waitForReady(): Promise<number> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.readyWaiter?.timer !== timer) {
					return;
				}
				this.readyWaiter = undefined;
				reject(new RuntimeSignal('timeout'));
			}, this.timeouts.readyMs);
			this.readyWaiter = { resolve, reject, timer };
		});
	}

	private sendOperation(
		message: HostToMcpChildMessage,
		expectedType: PendingOperation['expectedType'],
		timeoutMs: number,
	): Promise<McpChildToHostMessage> {
		return new Promise((resolve, reject) => {
			const child = this.child;
			if (child === undefined || this.childEnded || !child.connected) {
				reject(new RuntimeSignal('child_ended'));
				return;
			}
			const timer = setTimeout(() => {
				const pending = this.pendingOperations.get(message.requestId);
				if (pending?.timer !== timer) {
					return;
				}
				this.pendingOperations.delete(message.requestId);
				reject(new RuntimeSignal('timeout'));
			}, timeoutMs);
			this.pendingOperations.set(message.requestId, {
				expectedType,
				sessionId: this.sessionId,
				resolve,
				reject,
				timer,
			});
			try {
				child.send(message, (error) => {
					if (error !== null) {
						this.rejectOperation(message.requestId, new RuntimeSignal('child_ended'));
					}
				});
			} catch {
				this.rejectOperation(message.requestId, new RuntimeSignal('child_ended'));
			}
		});
	}

	private handleChildMessage(value: unknown): void {
		const parsed = parseMcpChildToHostMessage(value);
		if (!parsed.ok) {
			this.failProtocol();
			return;
		}
		const message = parsed.value;
		if (message.generation !== this.generation) {
			return;
		}

		switch (message.type) {
			case 'server.ready':
				if (this.readySeen) {
					this.failProtocol();
					return;
				}
				this.readySeen = true;
				if (this.readyWaiter !== undefined) {
					const waiter = this.readyWaiter;
					this.readyWaiter = undefined;
					clearTimeout(waiter.timer);
					waiter.resolve(message.port);
				}
				return;
			case 'auth.registered':
			case 'auth.revoked':
				this.resolveOperation(message);
				return;
			case 'operation.failed':
				if (message.requestId !== undefined) {
					this.rejectOperationFailure(message);
				} else {
					this.failProtocol();
				}
				return;
			case 'session.mcpActivityObserved':
				if (
					this.lifecycleValue === 'running'
					&& message.sessionId === this.sessionId
					&& !this.activityObserved
				) {
					this.activityObserved = true;
					this.emit({
						type: message.type,
						generation: message.generation,
						sessionId: message.sessionId,
					});
				}
				return;
		}
	}

	private resolveOperation(
		message: Extract<McpChildToHostMessage, {
			readonly type: 'auth.registered' | 'auth.revoked';
		}>,
	): void {
		const pending = this.pendingOperations.get(message.requestId);
		if (
			pending === undefined
			|| pending.expectedType !== message.type
			|| pending.sessionId !== message.sessionId
		) {
			return;
		}
		this.pendingOperations.delete(message.requestId);
		clearTimeout(pending.timer);
		pending.resolve(message);
	}

	private rejectOperation(requestId: string, error: RuntimeSignal): void {
		const pending = this.pendingOperations.get(requestId);
		if (pending === undefined) {
			return;
		}
		this.pendingOperations.delete(requestId);
		clearTimeout(pending.timer);
		pending.reject(error);
	}

	private rejectOperationFailure(
		message: Extract<McpChildToHostMessage, { readonly type: 'operation.failed' }>,
	): void {
		const requestId = message.requestId;
		if (requestId === undefined) {
			return;
		}
		const pending = this.pendingOperations.get(requestId);
		if (
			pending === undefined
			|| (
				message.sessionId !== undefined
				&& message.sessionId !== pending.sessionId
			)
			|| (
				pending.expectedType === 'auth.registered'
				&& message.reason !== 'auth_registration_failed'
			)
			|| (
				pending.expectedType === 'auth.revoked'
				&& message.reason !== 'auth_revoke_failed'
			)
		) {
			return;
		}
		this.rejectOperation(requestId, new RuntimeSignal('protocol'));
	}

	private failProtocol(): void {
		this.rejectAwaiters(new RuntimeSignal('protocol'));
		if (this.lifecycleValue === 'running') {
			this.beginCrash();
		}
	}

	private handleChildEnd(): void {
		if (this.childEnded) {
			return;
		}
		this.childEnded = true;
		for (const waiter of this.exitWaiters) {
			clearTimeout(waiter.timer);
			waiter.resolve();
		}
		this.exitWaiters.clear();
		this.rejectAwaiters(new RuntimeSignal('child_ended'));
		if (this.lifecycleValue === 'running') {
			this.beginCrash();
		}
	}

	private handleChildError(): void {
		this.rejectAwaiters(new RuntimeSignal('child_ended'));
		if (this.lifecycleValue === 'running') {
			this.beginCrash();
		}
	}

	private beginCrash(): void {
		if (
			this.lifecycleValue === 'stopping'
			|| this.lifecycleValue === 'stopped'
			|| this.lifecycleValue === 'crashed'
		) {
			return;
		}
		this.lifecycleValue = 'crashed';
		this.invalidateConnection();
		this.emitFailure();
		this.cleanupPromise ??= this.performCleanup(true);
	}

	private emitFailure(): void {
		if (this.failureEmitted) {
			return;
		}
		this.failureEmitted = true;
		this.emit(Object.freeze({
			type: 'runtime.failure',
			generation: this.generation,
			sessionId: this.sessionId,
			failure: createMcpFailure('adapter_exited'),
			providerStarted: this.providerStarted,
			providerAction: this.providerStarted
				? 'keep_running'
				: 'continue_without_mcp',
		}));
	}

	private async performCleanup(preserveCrash: boolean): Promise<void> {
		this.invalidateConnection();
		const child = this.child;
		try {
			if (
				child !== undefined
				&& !this.childEnded
				&& child.connected
				&& this.registrationAttempted
			) {
				try {
					await this.sendOperation({
						type: 'auth.revoke',
						requestId: this.nextRequestId(),
						generation: this.generation,
						sessionId: this.sessionId,
					}, 'auth.revoked', this.timeouts.revokeMs);
				} catch {
					/** Revoke 실패도 bounded shutdown과 kill fallback을 계속 수행한다. */
				}
			}

			if (child !== undefined && !this.childEnded) {
				this.sendShutdown(child);
				if (!await this.waitForExit(this.timeouts.shutdownMs)) {
					try {
						child.kill('SIGKILL');
					} catch {
						/** 이미 종료된 child kill 실패는 domain failure를 만들지 않는다. */
					}
					await this.waitForExit(this.timeouts.killMs);
				}
			}
		} finally {
			this.detachChild();
			this.rejectAwaiters(new RuntimeSignal('cancelled'));
			this.stage = 'idle';
			if (!preserveCrash && this.lifecycleValue !== 'crashed') {
				this.lifecycleValue = 'stopped';
			}
		}
	}

	private sendShutdown(child: ChildProcess): void {
		if (!child.connected) {
			return;
		}
		try {
			child.send({
				type: 'server.shutdown',
				requestId: this.nextRequestId(),
				generation: this.generation,
			} satisfies HostToMcpChildMessage, () => undefined);
		} catch {
			/** Exit/kill fallback이 IPC send 실패를 처리한다. */
		}
	}

	private waitForExit(timeoutMs: number): Promise<boolean> {
		if (this.childEnded) {
			return Promise.resolve(true);
		}
		return new Promise((resolve) => {
			const waiter: ExitWaiter = {
				resolve: () => resolve(true),
				timer: setTimeout(() => {
					this.exitWaiters.delete(waiter);
					resolve(false);
				}, timeoutMs),
			};
			this.exitWaiters.add(waiter);
		});
	}

	private attachChild(child: ChildProcess): void {
		child.on('message', this.childMessageListener);
		child.once('error', this.childErrorListener);
		child.once('exit', this.childExitListener);
	}

	private detachChild(): void {
		const child = this.child;
		if (child !== undefined) {
			child.off('message', this.childMessageListener);
			child.off('error', this.childErrorListener);
			child.off('exit', this.childExitListener);
		}
		this.child = undefined;
		for (const waiter of this.exitWaiters) {
			clearTimeout(waiter.timer);
			waiter.resolve();
		}
		this.exitWaiters.clear();
	}

	private rejectAwaiters(error: RuntimeSignal): void {
		if (this.readyWaiter !== undefined) {
			const waiter = this.readyWaiter;
			this.readyWaiter = undefined;
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		for (const [requestId] of this.pendingOperations) {
			this.rejectOperation(requestId, error);
		}
	}

	private assertCurrentStarting(): void {
		if (this.lifecycleValue !== 'starting' || this.childEnded) {
			throw new RuntimeSignal('cancelled');
		}
	}

	private invalidateConnection(): void {
		this.connection?.invalidate();
		this.connection = undefined;
	}

	private nextRequestId(): string {
		const requestId = this.createRequestId();
		if (!isValidMcpOpaqueId(requestId)) {
			throw new RuntimeSignal('protocol');
		}
		return requestId;
	}

	private emit(event: McpSessionRuntimeEvent): void {
		try {
			this.onEvent(event);
		} catch {
			/** Observer 실패가 child/runtime lifecycle을 변경하지 않게 한다. */
		}
	}
}

function failedPrepare(reason: McpFailureReason): McpPrepareResult {
	return Object.freeze({
		ok: false,
		failure: createMcpFailure(reason),
		providerAction: 'continue_without_mcp',
	});
}

function normalizeTimeouts(
	overrides: Partial<McpRuntimeTimeouts> | undefined,
): McpRuntimeTimeouts {
	const result = { ...DEFAULT_MCP_RUNTIME_TIMEOUTS, ...overrides };
	for (const value of Object.values(result)) {
		if (!Number.isFinite(value) || value < 0) {
			throw new Error('MCP runtime timeout is invalid.');
		}
	}
	return Object.freeze(result);
}
