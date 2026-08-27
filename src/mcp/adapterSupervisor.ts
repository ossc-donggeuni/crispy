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
import {
	isValidTaskToolLease,
	type TaskToolLease,
} from './taskToolProtocol';

export type McpSessionRuntimeFactory = (
	options: McpSessionRuntimeOptions,
) => McpSessionRuntime;

/** Runtime callback의 실제 source object를 Host 경계까지 보존한다. */
export interface SupervisorRuntimeEvent {
	readonly sourceRuntime: McpSessionRuntime;
	readonly event: McpSessionRuntimeEvent;
}

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
	readonly onEvent?: (event: SupervisorRuntimeEvent) => void;
	readonly agentActivityCompatible?: boolean;
}

interface OwnedRuntimeIdentity {
	readonly sessionId: string;
	readonly generation: string;
}

/** Panel 단위로 session별 adapter runtime ownership과 stale generation 방어를 제공한다. */
export class McpAdapterSupervisor {
	private readonly childEntryPath: string;
	private readonly options: McpAdapterSupervisorOptions;
	private readonly createGeneration: () => string;
	private readonly createRuntime: McpSessionRuntimeFactory;
	private readonly onEvent: ((event: SupervisorRuntimeEvent) => void) | undefined;
	private readonly agentActivityCompatible: boolean;
	private readonly runtimes = new Map<string, McpSessionRuntime>();
	private readonly liveRuntimes = new Set<McpSessionRuntime>();
	private readonly ownedRuntimeIdentities = new Map<
		McpSessionRuntime,
		OwnedRuntimeIdentity
	>();
	private readonly retirements = new Map<McpSessionRuntime, Promise<void>>();
	private readonly prepares = new Map<string, Promise<McpPrepareResult>>();
	private readonly restarts = new Map<string, Promise<McpPrepareResult>>();
	private readonly stops = new Map<string, Promise<void>>();
	private readonly taskLeaseBySession = new Map<string, TaskToolLease>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;
	private resolveDispose: (() => void) | undefined;
	private runtimeCreationDepth = 0;
	private disposeRetirementStarted = false;

	constructor(options: McpAdapterSupervisorOptions) {
		this.options = options;
		this.childEntryPath = resolveMcpChildAssetPath(options.extensionUri);
		this.createGeneration = options.createGeneration
			?? (() => `generation-${randomUUID()}`);
		this.createRuntime = options.createRuntime
			?? ((runtimeOptions) => new McpSessionRuntime(runtimeOptions));
		this.onEvent = options.onEvent;
		this.agentActivityCompatible = options.agentActivityCompatible === true;
	}

	prepareSession(
		sessionId: string,
		taskLease?: TaskToolLease,
	): Promise<McpPrepareResult> {
		if (this.disposed || !isValidMcpOpaqueId(sessionId)) {
			return Promise.resolve(supervisorFailure('adapter_start_failed'));
		}
		if (taskLease !== undefined) {
			if (!isValidTaskToolLease(taskLease)) {
				return Promise.resolve(supervisorFailure('adapter_start_failed'));
			}
			const existingLease = this.taskLeaseBySession.get(sessionId);
			if (
				existingLease !== undefined
				&& (
					existingLease.executionId !== taskLease.executionId
					|| existingLease.workNodeId !== taskLease.workNodeId
				)
			) {
				return Promise.resolve(supervisorFailure('adapter_start_failed'));
			}
			this.taskLeaseBySession.set(sessionId, Object.freeze({ ...taskLease }));
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
		const runtime = this.runtimes.get(sessionId);
		const stop = Promise.resolve().then(
			() => this.performStop(runtime),
		).finally(() => {
			if (this.stops.get(sessionId) === stop) {
				this.stops.delete(sessionId);
			}
			this.taskLeaseBySession.delete(sessionId);
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
		if (this.stops.has(sessionId)) {
			return Promise.resolve(supervisorFailure('adapter_start_failed'));
		}
		const previous = this.runtimes.get(sessionId);
		const restart = Promise.resolve().then(
			() => this.performRestart(sessionId, previous),
		).finally(() => {
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
		this.runtimes.clear();
		this.prepares.clear();
		this.restarts.clear();
		this.stops.clear();
		this.taskLeaseBySession.clear();
		const dispose = new Promise<void>((resolve) => {
			this.resolveDispose = resolve;
		});
		this.disposePromise = dispose;
		if (this.runtimeCreationDepth === 0) {
			this.beginDisposeRetirement();
		}
		return dispose;
	}

	/** Host integration과 deterministic test가 현재 ownership만 조회하는 read-only 경계다. */
	getSessionRuntime(sessionId: string): McpSessionRuntime | undefined {
		return this.runtimes.get(sessionId);
	}

	/** 이 Supervisor가 소유한 exact runtime object만 detach하고 한 번 정리한다. */
	retireExactRuntime(runtime: McpSessionRuntime): Promise<void> {
		const existingRetirement = this.retirements.get(runtime);
		if (existingRetirement !== undefined) {
			return existingRetirement;
		}
		const identity = this.ownedRuntimeIdentities.get(runtime);
		if (!this.liveRuntimes.has(runtime) || identity === undefined) {
			return Promise.resolve();
		}

		let resolveRetirement!: () => void;
		const retirement = new Promise<void>((resolve) => {
			resolveRetirement = resolve;
		});
		this.retirements.set(runtime, retirement);
		if (this.runtimes.get(identity.sessionId) === runtime) {
			this.runtimes.delete(identity.sessionId);
			this.prepares.delete(identity.sessionId);
			this.taskLeaseBySession.delete(identity.sessionId);
		}
		void this.settleRuntimeRetirement(
			runtime,
			retirement,
			resolveRetirement,
		);
		return retirement;
	}

	private async performPrepare(
		sessionId: string,
		runtime: McpSessionRuntime,
	): Promise<McpPrepareResult> {
		let result: McpPrepareResult;
		try {
			result = await runtime.start();
		} catch {
			await this.retireExactRuntime(runtime);
			return supervisorFailure('adapter_start_failed');
		}
		const identity = this.ownedRuntimeIdentities.get(runtime);
		if (
			this.disposed
			|| identity === undefined
			|| identity.sessionId !== sessionId
			|| runtime.sessionId !== identity.sessionId
			|| runtime.generation !== identity.generation
			|| this.runtimes.get(sessionId) !== runtime
			|| (
				result.ok
				&& (
					result.connection.sessionId !== identity.sessionId
					|| result.connection.generation !== identity.generation
				)
			)
		) {
			await this.retireExactRuntime(runtime);
			return supervisorFailure('adapter_start_failed');
		}
		return result;
	}

	private async performRestart(
		sessionId: string,
		previous: McpSessionRuntime | undefined,
	): Promise<McpPrepareResult> {
		const taskLease = this.taskLeaseBySession.get(sessionId);
		if (previous !== undefined) {
			await this.retireExactRuntime(previous);
		}
		if (this.disposed) {
			return supervisorFailure('adapter_start_failed');
		}
		if (taskLease !== undefined) {
			this.taskLeaseBySession.set(sessionId, taskLease);
		}
		this.prepares.delete(sessionId);
		if (this.runtimes.has(sessionId)) {
			return supervisorFailure('adapter_start_failed');
		}
		const runtime = this.createOwnedRuntime(sessionId);
		if (runtime === undefined) {
			return supervisorFailure('adapter_start_failed');
		}
		this.runtimes.set(sessionId, runtime);
		const prepare = this.performPrepare(sessionId, runtime);
		this.prepares.set(sessionId, prepare);
		return prepare;
	}

	private async performStop(
		runtime: McpSessionRuntime | undefined,
	): Promise<void> {
		if (runtime !== undefined) {
			await this.retireExactRuntime(runtime);
		}
	}

	private createOwnedRuntime(sessionId: string): McpSessionRuntime | undefined {
		this.runtimeCreationDepth += 1;
		try {
			const generation = this.createGeneration();
			if (!isValidMcpOpaqueId(generation)) {
				return undefined;
			}
			let sourceRuntime: McpSessionRuntime | undefined;
			const runtime = this.createRuntime({
				generation,
				sessionId,
				childEntryPath: this.childEntryPath,
				parentEnvironment: this.options.parentEnvironment,
				hostRuntime: this.options.hostRuntime,
				timeouts: this.options.timeouts,
				randomBytes: this.options.randomBytes,
				spawnChild: this.options.spawnChild,
				createRequestId: this.options.createRequestId,
				agentActivityCompatible: this.agentActivityCompatible,
				...(this.taskLeaseBySession.get(sessionId) === undefined
					? {}
					: { taskLease: this.taskLeaseBySession.get(sessionId) }),
				onEvent: (event) => {
					if (sourceRuntime !== undefined) {
						this.handleRuntimeEvent(sourceRuntime, event);
					}
				},
			});
			sourceRuntime = runtime;
			if (this.liveRuntimes.has(runtime)) {
				return undefined;
			}
			this.ownedRuntimeIdentities.set(runtime, Object.freeze({
				sessionId,
				generation,
			}));
			this.liveRuntimes.add(runtime);
			if (
				this.disposed
				|| runtime.sessionId !== sessionId
				|| runtime.generation !== generation
			) {
				void this.retireExactRuntime(runtime);
				return undefined;
			}
			return runtime;
		} catch {
			return undefined;
		} finally {
			this.runtimeCreationDepth -= 1;
			if (this.disposed && this.runtimeCreationDepth === 0) {
				this.beginDisposeRetirement();
			}
		}
	}

	private handleRuntimeEvent(
		sourceRuntime: McpSessionRuntime,
		event: McpSessionRuntimeEvent,
	): void {
		const identity = this.ownedRuntimeIdentities.get(sourceRuntime);
		if (
			identity === undefined
			|| event.sessionId !== identity.sessionId
			|| event.generation !== identity.generation
		) {
			void this.retireExactRuntime(sourceRuntime);
			return;
		}
		const current = this.runtimes.get(identity.sessionId);
		if (
			this.disposed
			|| current !== sourceRuntime
		) {
			return;
		}
		if (event.type === 'runtime.failure') {
			this.prepares.delete(event.sessionId);
		}
		try {
			this.onEvent?.(Object.freeze({ sourceRuntime, event }));
		} catch {
			/** Panel consumer 실패가 다른 session lifecycle을 변경하지 않게 한다. */
		}
	}

	private async settleRuntimeRetirement(
		runtime: McpSessionRuntime,
		retirement: Promise<void>,
		resolveRetirement: () => void,
	): Promise<void> {
		try {
			await runtime.stop();
		} catch {
			/** Runtime cleanup 실패도 exact ownership release를 막지 않는다. */
		} finally {
			this.liveRuntimes.delete(runtime);
			this.ownedRuntimeIdentities.delete(runtime);
			if (this.retirements.get(runtime) === retirement) {
				this.retirements.delete(runtime);
			}
			resolveRetirement();
		}
	}

	/** Admission-close 중 reentrant factory가 만든 runtime까지 같은 dispose barrier에 넣는다. */
	private beginDisposeRetirement(): void {
		if (this.disposeRetirementStarted || this.disposePromise === undefined) {
			return;
		}
		this.disposeRetirementStarted = true;
		const ownedRuntimes = [...this.liveRuntimes];
		void Promise.allSettled(
			ownedRuntimes.map((runtime) => this.retireExactRuntime(runtime)),
		).then(() => {
			const resolve = this.resolveDispose;
			this.resolveDispose = undefined;
			resolve?.();
		});
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
