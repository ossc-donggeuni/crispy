import { randomUUID } from 'node:crypto';
import {
	spawn,
	type ChildProcess,
	type SpawnOptions,
} from 'node:child_process';
import path from 'node:path';
import { McpAdapterSupervisor } from './adapterSupervisor';
import {
	type AgentProcessSpawnRequest,
	createAgentProcessSpawnOptions,
	createAgentProcessSpawnRequest,
} from './agentLaunchPlan';
import {
	resolveAgentExecutable,
	type AgentExecutableResolver,
} from './agentExecutableResolver';
import { buildCodexMcpLaunchPlan } from './codexLaunchPlan';
import {
	MCP_FAILURE_REASONS,
	type McpFailureReason,
} from './failureReason';
import type { McpRandomBytes } from './sessionCredentials';
import type {
	McpPrepareResult,
	McpSessionRuntime,
	McpSessionRuntimeEvent,
} from './sessionRuntime';

export const CODEX_MCP_SMOKE_PROMPT = [
	'Call the crispy_ping MCP tool once.',
	'Do not run shell commands and do not modify files.',
].join(' ');

const CODEX_SMOKE_ARGS_BEFORE_CONFIG = Object.freeze([
	'--ask-for-approval',
	'never',
	'exec',
	'--ephemeral',
	'--color',
	'never',
	'--sandbox',
	'read-only',
]);

export const CODEX_SMOKE_FAILURE_REASONS = Object.freeze([
	...MCP_FAILURE_REASONS,
	'provider_unavailable',
	'provider_exited',
	'stale_session',
	'smoke_cancelled',
	'smoke_failed',
] as const);

export type CodexSmokeFailureReason = typeof CODEX_SMOKE_FAILURE_REASONS[number];
export type CodexSmokeStatus =
	| 'adapter_ready'
	| 'awaiting_activity'
	| 'activity_observed'
	| `failed:${CodexSmokeFailureReason}`;

export type CodexProviderSpawnRequest = AgentProcessSpawnRequest;

export type CodexProviderSpawner = (
	request: CodexProviderSpawnRequest,
) => ChildProcess;

export interface CodexSmokeSupervisor {
	prepareSession(sessionId: string): Promise<McpPrepareResult>;
	getSessionRuntime(sessionId: string): Pick<
		McpSessionRuntime,
		'generation' | 'markProviderStarted'
	> | undefined;
	dispose(): Promise<void>;
}

export interface RunCodexMcpSmokeOptions {
	readonly supervisor: CodexSmokeSupervisor;
	readonly events: CodexSmokeEventObserver;
	readonly sessionId: string;
	readonly cwd: string;
	readonly baseEnvironment: NodeJS.ProcessEnv;
	readonly codexExecutable?: string;
	readonly randomBytes?: McpRandomBytes;
	readonly platform?: NodeJS.Platform;
	readonly resolveExecutable?: AgentExecutableResolver;
	readonly spawnProvider?: CodexProviderSpawner;
	readonly terminateProvider?: (provider: ChildProcess) => Promise<void>;
	readonly report?: (status: CodexSmokeStatus) => void;
	readonly signal?: AbortSignal;
}

type CodexSmokeOutcome =
	| { readonly type: 'activity' }
	| { readonly type: 'failure'; readonly reason: CodexSmokeFailureReason };

/** Supervisor event를 current smoke session/generation에만 연결한다. */
export class CodexSmokeEventObserver {
	private expectedGeneration: string | undefined;
	private settled = false;
	private readonly outcomePromise: Promise<CodexSmokeOutcome>;
	private resolveOutcome: ((outcome: CodexSmokeOutcome) => void) | undefined;

	constructor(private readonly sessionId: string) {
		this.outcomePromise = new Promise((resolve) => {
			this.resolveOutcome = resolve;
		});
	}

	expectGeneration(generation: string): void {
		this.expectedGeneration = generation;
	}

	handle(event: McpSessionRuntimeEvent): void {
		if (
			this.settled
			|| this.expectedGeneration === undefined
			|| event.sessionId !== this.sessionId
			|| event.generation !== this.expectedGeneration
		) {
			return;
		}
		if (event.type === 'session.crispyPingObserved') {
			this.settle({ type: 'activity' });
			return;
		}
		if (event.type === 'session.mcpActivityObserved') {
			return;
		}
		this.settle({ type: 'failure', reason: event.failure.reason });
	}

	wait(): Promise<CodexSmokeOutcome> {
		return this.outcomePromise;
	}

	private settle(outcome: CodexSmokeOutcome): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.resolveOutcome?.(outcome);
		this.resolveOutcome = undefined;
	}
}

/** C3 전용 diagnostic transaction이며 TerminalHost/PTY product lifecycle에는 연결하지 않는다. */
export async function runCodexMcpSmoke(
	options: RunCodexMcpSmokeOptions,
): Promise<boolean> {
	const report = (status: CodexSmokeStatus): void => {
		try {
			options.report?.(status);
		} catch {
			/** Diagnostic reporter 실패가 credential cleanup을 막지 않게 한다. */
		}
	};
	const spawnProvider = options.spawnProvider ?? spawnCodexProvider;
	const terminateProvider = options.terminateProvider ?? terminateCodexProvider;
	const platform = options.platform ?? process.platform;
	const resolveExecutable = options.resolveExecutable ?? resolveAgentExecutable;
	let provider: ChildProcess | undefined;

	try {
		const prepared = await options.supervisor.prepareSession(options.sessionId);
		if (!prepared.ok) {
			report(`failed:${prepared.failure.reason}`);
			return false;
		}
		options.events.expectGeneration(prepared.connection.generation);
		report('adapter_ready');

		const executable = await resolveExecutable('codex', {
			platform,
			environment: options.baseEnvironment,
			override: options.codexExecutable,
		});
		if (!executable.ok) {
			report('failed:provider_unavailable');
			return false;
		}
		let providerRequest: CodexProviderSpawnRequest;
		try {
			const plan = buildCodexMcpLaunchPlan({
				executable: executable.executable,
				cwd: options.cwd,
				connection: prepared.connection,
				argsBeforeConfig: CODEX_SMOKE_ARGS_BEFORE_CONFIG,
				argsAfterConfig: [CODEX_MCP_SMOKE_PROMPT],
				randomBytes: options.randomBytes,
			});
			providerRequest = createAgentProcessSpawnRequest(plan, {
				platform,
				environment: options.baseEnvironment,
			});
		} catch {
			report('failed:provider_unavailable');
			return false;
		}
		report('awaiting_activity');

		try {
			provider = spawnProvider(providerRequest);
		} catch {
			report('failed:provider_unavailable');
			return false;
		}
		const providerEnd = waitForProviderEnd(provider);
		const spawned = await waitForProviderSpawn(provider, options.signal);
		if (spawned !== 'spawned') {
			report(`failed:${spawned}`);
			return false;
		}

		const runtime = options.supervisor.getSessionRuntime(options.sessionId);
		if (
			runtime === undefined
			|| runtime.generation !== prepared.connection.generation
			|| !runtime.markProviderStarted()
		) {
			report('failed:stale_session');
			return false;
		}

		const outcome = await Promise.race([
			options.events.wait(),
			providerEnd,
			waitForAbort(options.signal),
		]);
		if (outcome.type === 'activity') {
			report('activity_observed');
			return true;
		}
		report(`failed:${outcome.reason}`);
		return false;
	} catch {
		report('failed:smoke_failed');
		return false;
	} finally {
		if (provider !== undefined) {
			await terminateProvider(provider).catch(() => undefined);
		}
		await options.supervisor.dispose().catch(() => undefined);
	}
}

export function createCodexSmokeArgs(
	configArgs: readonly string[],
): readonly string[] {
	return Object.freeze([
		...CODEX_SMOKE_ARGS_BEFORE_CONFIG,
		...configArgs,
		CODEX_MCP_SMOKE_PROMPT,
	]);
}

export function createCodexSmokeSpawnOptions(
	request: CodexProviderSpawnRequest,
): SpawnOptions {
	return createAgentProcessSpawnOptions(request);
}

export function spawnCodexProvider(
	request: CodexProviderSpawnRequest,
): ChildProcess {
	return spawn(
		request.executable,
		[...request.args],
		createCodexSmokeSpawnOptions(request),
	);
}

async function terminateCodexProvider(provider: ChildProcess): Promise<void> {
	if (provider.exitCode !== null || provider.signalCode !== null) {
		return;
	}
	try {
		provider.kill('SIGTERM');
	} catch {
		return;
	}
	if (await waitForExitWithin(provider, 1000)) {
		return;
	}
	try {
		provider.kill('SIGKILL');
	} catch {
		/** Best-effort diagnostic cleanup. */
	}
	await waitForExitWithin(provider, 1000);
}

function waitForProviderSpawn(
	provider: ChildProcess,
	signal?: AbortSignal,
): Promise<'spawned' | 'provider_unavailable' | 'smoke_cancelled'> {
	if (signal?.aborted) {
		return Promise.resolve('smoke_cancelled');
	}
	if (provider.pid !== undefined) {
		return Promise.resolve('spawned');
	}
	return new Promise((resolve) => {
		let settled = false;
		const finish = (
			outcome: 'spawned' | 'provider_unavailable' | 'smoke_cancelled',
		): void => {
			if (settled) {
				return;
			}
			settled = true;
			provider.removeListener('spawn', onSpawn);
			provider.removeListener('error', onError);
			signal?.removeEventListener('abort', onAbort);
			resolve(outcome);
		};
		const onSpawn = (): void => finish('spawned');
		const onError = (): void => finish('provider_unavailable');
		const onAbort = (): void => finish('smoke_cancelled');
		provider.once('spawn', onSpawn);
		provider.once('error', onError);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

function waitForProviderEnd(provider: ChildProcess): Promise<CodexSmokeOutcome> {
	if (provider.exitCode !== null || provider.signalCode !== null) {
		return Promise.resolve({ type: 'failure', reason: 'provider_exited' });
	}
	return new Promise((resolve) => {
		const finish = (): void => {
			provider.removeListener('exit', finish);
			provider.removeListener('error', finish);
			resolve({ type: 'failure', reason: 'provider_exited' });
		};
		provider.once('exit', finish);
		provider.once('error', finish);
	});
}

function waitForAbort(signal?: AbortSignal): Promise<CodexSmokeOutcome> {
	if (signal?.aborted) {
		return Promise.resolve({ type: 'failure', reason: 'smoke_cancelled' });
	}
	return new Promise((resolve) => {
		signal?.addEventListener('abort', () => resolve({
			type: 'failure',
			reason: 'smoke_cancelled',
		}), { once: true });
	});
}

function waitForExitWithin(
	provider: ChildProcess,
	timeoutMs: number,
): Promise<boolean> {
	if (provider.exitCode !== null || provider.signalCode !== null) {
		return Promise.resolve(true);
	}
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => finish(false), timeoutMs);
		const finish = (exited: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			provider.removeListener('exit', onExit);
			resolve(exited);
		};
		const onExit = (): void => finish(true);
		provider.once('exit', onExit);
	});
}

async function main(): Promise<void> {
	const sessionId = `codex-smoke-${randomUUID()}`;
	const repositoryRoot = path.resolve(__dirname, '..', '..');
	const controller = new AbortController();
	const observer = new CodexSmokeEventObserver(sessionId);
	const supervisor = new McpAdapterSupervisor({
		extensionUri: { fsPath: repositoryRoot },
		parentEnvironment: process.env,
		onEvent: (event) => observer.handle(event),
	});
	const abort = (): void => controller.abort();
	process.once('SIGINT', abort);
	process.once('SIGTERM', abort);
	try {
		const succeeded = await runCodexMcpSmoke({
			supervisor,
			events: observer,
			sessionId,
			cwd: repositoryRoot,
			baseEnvironment: process.env,
			report: (status) => console.log(status),
			signal: controller.signal,
		});
		process.exitCode = succeeded ? 0 : 1;
	} finally {
		process.removeListener('SIGINT', abort);
		process.removeListener('SIGTERM', abort);
	}
}

if (require.main === module) {
	void main().catch(() => {
		console.log('failed:smoke_failed');
		process.exitCode = 1;
	});
}
