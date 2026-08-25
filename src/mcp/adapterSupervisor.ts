import { randomUUID } from 'node:crypto';
import {
	McpSessionRuntime,
	resolveMcpChildAssetPath,
	type McpChildSpawner,
	type McpHostRuntimeInfo,
	type McpPrepareResult,
	type McpRuntimeTimeouts,
	type McpSessionRuntimeEvent,
	type McpSessionRuntimeOptions,
} from './sessionRuntime';
import { createMcpFailure } from './failureReason';
import { isValidMcpOpaqueId, type McpRandomBytes } from './sessionCredentials';

export type McpSessionRuntimeFactory = (
	options: McpSessionRuntimeOptions,
) => McpSessionRuntime;

export interface McpAdapterSupervisorOptions {
	readonly extensionUri: Readonly<{ fsPath: string }>;
	readonly parentEnvironment?: NodeJS.ProcessEnv;
	readonly hostRuntime?: McpHostRuntimeInfo;
	readonly timeouts?: Partial<McpRuntimeTimeouts>;
	readonly randomBytes?: McpRandomBytes;
	readonly spawnChild?: McpChildSpawner;
	readonly createRequestId?: () => string;
	readonly createGeneration?: () => string;
	readonly createRuntime?: McpSessionRuntimeFactory;
	readonly onEvent?: (event: McpSessionRuntimeEvent) => void;
	readonly agentActivityCompatible?: boolean;
}

/** Panel 단위로 session별 adapter runtime ownership과 stale generation 방어를 제공한다. */
export class McpAdapterSupervisor {
	private readonly childEntryPath: string;
	private readonly options: McpAdapterSupervisorOptions;
	private readonly createGeneration: () => string;
	private readonly createRuntime: McpSessionRuntimeFactory;
	private readonly runtimes = new Map<string, McpSessionRuntime>();
	private readonly prepares = new Map<string, Promise<McpPrepareResult>>();
	private readonly restarts = new Map<string, Promise<McpPrepareResult>>();
	private readonly stops = new Map<string, Promise<void>>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: McpAdapterSupervisorOptions) {
		this.options = options;
		this.childEntryPath = resolveMcpChildAssetPath(options.extensionUri);
		this.createGeneration = options.createGeneration
			?? (() => `generation-${randomUUID()}`);
		this.createRuntime = options.createRuntime
			?? ((runtimeOptions) => new McpSessionRuntime(runtimeOptions));
	}

	prepareSession(sessionId: string): Promise<McpPrepareResult> {
		if (this.disposed || !isValidMcpOpaqueId(sessionId)) {
			return Promise.resolve(supervisorFailure('adapter_start_failed'));
		}
		if (this.stops.has(sessionId)) {
			return Promise.resolve(supervisorFailure('adapter_start_failed'));
		}
		const restarting = this.restarts.get(sessionId);
		if (restarting !== undefined) {
			return restarting;
		}
		const existingPrepare = this.prepares.get(sessionId);
		if (existingPrepare !== undefined) {
			return existingPrepare;
		}

		let runtime = this.runtimes.get(sessionId);
		if (runtime === undefined) {
			runtime = this.createOwnedRuntime(sessionId);
			if (runtime === undefined) {
				return Promise.resolve(supervisorFailure('adapter_start_failed'));
			}
			this.runtimes.set(sessionId, runtime);
		}

		const prepare = this.performPrepare(sessionId, runtime);
		this.prepares.set(sessionId, prepare);
		return prepare;
	}

	stopSession(sessionId: string): Promise<void> {
		const existingStop = this.stops.get(sessionId);
		if (existingStop !== undefined) {
			return existingStop;
		}
		const stop = this.performStop(sessionId).finally(() => {
			if (this.stops.get(sessionId) === stop) {
				this.stops.delete(sessionId);
			}
		});
		this.stops.set(sessionId, stop);
		return stop;
	}

	restartSession(sessionId: string): Promise<McpPrepareResult> {
		if (this.disposed || !isValidMcpOpaqueId(sessionId)) {
			return Promise.resolve(supervisorFailure('adapter_start_failed'));
		}
		const existingRestart = this.restarts.get(sessionId);
		if (existingRestart !== undefined) {
			return existingRestart;
		}
		const restart = this.performRestart(sessionId).finally(() => {
			if (this.restarts.get(sessionId) === restart) {
				this.restarts.delete(sessionId);
			}
		});
		this.restarts.set(sessionId, restart);
		return restart;
	}

	dispose(): Promise<void> {
		if (this.disposePromise !== undefined) {
			return this.disposePromise;
		}
		this.disposed = true;
		this.prepares.clear();
		this.restarts.clear();
		this.stops.clear();
		const ownedRuntimes = [...this.runtimes.values()];
		this.runtimes.clear();
		this.disposePromise = Promise.allSettled(
			ownedRuntimes.map((runtime) => runtime.stop()),
		).then(() => undefined);
		return this.disposePromise;
	}

	/** Host integration과 deterministic test가 현재 ownership만 조회하는 read-only 경계다. */
	getSessionRuntime(sessionId: string): McpSessionRuntime | undefined {
		return this.runtimes.get(sessionId);
	}

	private async performPrepare(
		sessionId: string,
		runtime: McpSessionRuntime,
	): Promise<McpPrepareResult> {
		const result = await runtime.start();
		if (
			this.disposed
			|| this.runtimes.get(sessionId) !== runtime
			|| runtime.generation !== resultGeneration(result, runtime.generation)
		) {
			await runtime.stop();
			return supervisorFailure('adapter_start_failed');
		}
		return result;
	}

	private async performRestart(sessionId: string): Promise<McpPrepareResult> {
		const previous = this.runtimes.get(sessionId);
		this.prepares.delete(sessionId);
		if (previous !== undefined) {
			await previous.stop();
			if (this.runtimes.get(sessionId) === previous) {
				this.runtimes.delete(sessionId);
			}
		}
		if (this.disposed) {
			return supervisorFailure('adapter_start_failed');
		}
		this.prepares.delete(sessionId);
		const runtime = this.createOwnedRuntime(sessionId);
		if (runtime === undefined) {
			return supervisorFailure('adapter_start_failed');
		}
		this.runtimes.set(sessionId, runtime);
		const prepare = this.performPrepare(sessionId, runtime);
		this.prepares.set(sessionId, prepare);
		return prepare;
	}

	private async performStop(sessionId: string): Promise<void> {
		const restarting = this.restarts.get(sessionId);
		if (restarting !== undefined) {
			await restarting.catch(() => undefined);
		}
		this.prepares.delete(sessionId);
		const runtime = this.runtimes.get(sessionId);
		if (runtime === undefined) {
			return;
		}
		await runtime.stop();
		if (this.runtimes.get(sessionId) === runtime) {
			this.runtimes.delete(sessionId);
		}
	}

	private createOwnedRuntime(sessionId: string): McpSessionRuntime | undefined {
		const generation = this.createGeneration();
		if (!isValidMcpOpaqueId(generation)) {
			return undefined;
		}
		return this.createRuntime({
			generation,
			sessionId,
			childEntryPath: this.childEntryPath,
			parentEnvironment: this.options.parentEnvironment,
			hostRuntime: this.options.hostRuntime,
			timeouts: this.options.timeouts,
			randomBytes: this.options.randomBytes,
			spawnChild: this.options.spawnChild,
			createRequestId: this.options.createRequestId,
			agentActivityCompatible:
				this.options.agentActivityCompatible === true,
			onEvent: (event) => this.handleRuntimeEvent(event),
		});
	}

	private handleRuntimeEvent(event: McpSessionRuntimeEvent): void {
		const current = this.runtimes.get(event.sessionId);
		if (
			this.disposed
			|| current === undefined
			|| current.generation !== event.generation
		) {
			return;
		}
		if (event.type === 'runtime.failure') {
			this.prepares.delete(event.sessionId);
		}
		try {
			this.options.onEvent?.(event);
		} catch {
			/** Panel consumer 실패가 다른 session lifecycle을 변경하지 않게 한다. */
		}
	}
}

function supervisorFailure(
	reason: 'adapter_start_failed',
): McpPrepareResult {
	return Object.freeze({
		ok: false,
		failure: createMcpFailure(reason),
		providerAction: 'continue_without_mcp',
	});
}

function resultGeneration(
	result: McpPrepareResult,
	fallback: string,
): string {
	return result.ok ? result.connection.generation : fallback;
}
