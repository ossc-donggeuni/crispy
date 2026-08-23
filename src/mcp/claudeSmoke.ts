import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
	PtyExitEvent,
	PtyListenerDisposable,
	PtyProcessHandle,
} from '../agent/host/terminal/ptyAdapter';
import { nodePtyAdapter } from '../agent/host/terminal/nodePtyAdapter';
import { McpAdapterSupervisor } from './adapterSupervisor';
import {
	resolveAgentExecutable,
	type AgentExecutableResolver,
} from './agentExecutableResolver';
import {
	type AgentProcessSpawnRequest,
	createAgentProcessSpawnRequest,
} from './agentLaunchPlan';
import {
	resolveClaudeMcpCompatibility,
	type ClaudeMcpCompatibilityResolver,
} from './claudeCompatibility';
import { CLAUDE_MCP_TOKEN_ENVIRONMENT_VARIABLE } from './claudeConfig';
import { buildClaudeMcpLaunchPlan } from './claudeLaunchPlan';
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

export function createClaudeMcpSmokePrompt(serverName: string): string {
	const toolName = createClaudeMcpSmokeToolName(serverName);
	return [
		`Call the MCP tool ${toolName} exactly once.`,
		'Do not run shell commands and do not modify files.',
	].join(' ');
}

export function createClaudeMcpSmokeArgs(serverName: string): readonly string[] {
	const toolName = createClaudeMcpSmokeToolName(serverName);
	return Object.freeze([
		'--allowedTools',
		toolName,
		'-p',
		createClaudeMcpSmokePrompt(serverName),
	]);
}

function createClaudeMcpSmokeToolName(serverName: string): string {
	if (!/^crispy_canvas_[a-f0-9]{32}$/u.test(serverName)) {
		throw new Error('Claude smoke server name is invalid.');
	}
	return `mcp__${serverName}__crispy_ping`;
}

export const CLAUDE_SMOKE_FAILURE_REASONS = Object.freeze([
	...MCP_FAILURE_REASONS,
	'provider_unavailable',
	'provider_exited',
	'version_probe_failed',
	'version_incompatible',
	'stale_session',
	'negative_control_activity',
	'negative_control_inconclusive',
	'smoke_cancelled',
	'smoke_failed',
] as const);

export type ClaudeSmokeFailureReason = typeof CLAUDE_SMOKE_FAILURE_REASONS[number];
export type ClaudeSmokeStatus =
	| 'version_compatible'
	| 'adapter_ready'
	| 'awaiting_activity'
	| 'activity_observed'
	| 'negative_control_no_authenticated_activity'
	| `failed:${ClaudeSmokeFailureReason}`;
export type ClaudeSmokeCredentialMode = 'registered' | 'missing-negative-control';

export type ClaudeProviderPtySpawner = (
	request: AgentProcessSpawnRequest,
) => PtyProcessHandle;

export interface ClaudeSmokeSupervisor {
	prepareSession(sessionId: string): Promise<McpPrepareResult>;
	getSessionRuntime(sessionId: string): Pick<
		McpSessionRuntime,
		'generation' | 'markProviderStarted'
	> | undefined;
	dispose(): Promise<void>;
}

export interface RunClaudeMcpSmokeOptions {
	readonly supervisor: ClaudeSmokeSupervisor;
	readonly events: ClaudeSmokeEventObserver;
	readonly sessionId: string;
	readonly cwd: string;
	readonly baseEnvironment: NodeJS.ProcessEnv;
	readonly credentialMode: ClaudeSmokeCredentialMode;
	readonly claudeExecutable?: string;
	readonly randomBytes?: McpRandomBytes;
	readonly platform?: NodeJS.Platform;
	readonly resolveExecutable?: AgentExecutableResolver;
	readonly resolveCompatibility?: ClaudeMcpCompatibilityResolver;
	readonly spawnProvider?: ClaudeProviderPtySpawner;
	readonly terminateProvider?: (provider: PtyProcessHandle) => Promise<void>;
	readonly report?: (status: ClaudeSmokeStatus) => void;
	readonly signal?: AbortSignal;
}

type ClaudeSmokeOutcome =
	| { readonly type: 'ping' }
	| { readonly type: 'activity' }
	| ({ readonly type: 'provider_exit' } & PtyExitEvent)
	| { readonly type: 'failure'; readonly reason: McpFailureReason };

/** Filters child events to one current session and optionally observes any authenticated request. */
export class ClaudeSmokeEventObserver {
	private expectedGeneration: string | undefined;
	private settled = false;
	private readonly outcomePromise: Promise<ClaudeSmokeOutcome>;
	private resolveOutcome: ((outcome: ClaudeSmokeOutcome) => void) | undefined;

	constructor(
		private readonly sessionId: string,
		private readonly observeAnyActivity = false,
	) {
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
			this.settle({ type: 'ping' });
			return;
		}
		if (event.type === 'session.mcpActivityObserved') {
			if (this.observeAnyActivity) {
				this.settle({ type: 'activity' });
			}
			return;
		}
		this.settle({ type: 'failure', reason: event.failure.reason });
	}

	wait(): Promise<ClaudeSmokeOutcome> {
		return this.outcomePromise;
	}

	private settle(outcome: ClaudeSmokeOutcome): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.resolveOutcome?.(outcome);
		this.resolveOutcome = undefined;
	}
}

/** L1-only node-pty smoke. It does not connect Claude to TerminalHost product lifecycle. */
export async function runClaudeMcpSmoke(
	options: RunClaudeMcpSmokeOptions,
): Promise<boolean> {
	const report = (status: ClaudeSmokeStatus): void => {
		try {
			options.report?.(status);
		} catch {
			/** Diagnostic output cannot prevent credential cleanup. */
		}
	};
	const platform = options.platform ?? process.platform;
	const resolveExecutable = options.resolveExecutable ?? resolveAgentExecutable;
	const resolveCompatibility = options.resolveCompatibility
		?? resolveClaudeMcpCompatibility;
	const spawnProvider = options.spawnProvider ?? spawnClaudeProvider;
	const terminateProvider = options.terminateProvider ?? terminateClaudeProvider;
	let provider: PtyProcessHandle | undefined;
	let providerEndSubscription: PtyListenerDisposable | undefined;

	try {
		const executable = await resolveExecutable('claude', {
			platform,
			environment: options.baseEnvironment,
			override: options.claudeExecutable,
		});
		if (!executable.ok) {
			report('failed:provider_unavailable');
			return false;
		}
		const compatibility = await resolveCompatibility({
			executable: executable.executable,
			cwd: options.cwd,
			platform,
			environment: options.baseEnvironment,
		});
		if (compatibility === undefined) {
			report('failed:version_probe_failed');
			return false;
		}
		if (!compatibility.compatible) {
			report('failed:version_incompatible');
			return false;
		}
		report('version_compatible');

		const prepared = await options.supervisor.prepareSession(options.sessionId);
		if (!prepared.ok) {
			report(`failed:${prepared.failure.reason}`);
			return false;
		}
		options.events.expectGeneration(prepared.connection.generation);
		report('adapter_ready');

		let providerRequest: AgentProcessSpawnRequest;
		try {
			const plan = buildClaudeMcpLaunchPlan({
				executable: executable.executable,
				cwd: options.cwd,
				connection: prepared.connection,
				createArgs: createClaudeMcpSmokeArgs,
				randomBytes: options.randomBytes,
			});
			providerRequest = createAgentProcessSpawnRequest(plan, {
				platform,
				environment: options.baseEnvironment,
			});
			if (options.credentialMode === 'missing-negative-control') {
				providerRequest = removeMcpCredential(providerRequest);
			}
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
		providerEndSubscription = providerEnd.subscription;
		if (!await waitForProviderReady(provider, options.signal)) {
			report(options.signal?.aborted
				? 'failed:smoke_cancelled'
				: 'failed:provider_unavailable');
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
			providerEnd.promise,
			waitForAbort(options.signal),
		]);
		if (options.credentialMode === 'missing-negative-control') {
			if (outcome.type === 'provider_exit') {
				if (outcome.signal === undefined || outcome.signal === 0) {
					report('negative_control_no_authenticated_activity');
					return true;
				}
				report('failed:negative_control_inconclusive');
				return false;
			}
			if (outcome.type === 'ping' || outcome.type === 'activity') {
				report('failed:negative_control_activity');
				return false;
			}
			report(`failed:${outcome.reason}`);
			return false;
		}

		if (outcome.type === 'ping') {
			report('activity_observed');
			return true;
		}
		if (outcome.type === 'provider_exit') {
			report('failed:provider_exited');
			return false;
		}
		if (outcome.type === 'activity') {
			report('failed:smoke_failed');
			return false;
		}
		report(`failed:${outcome.reason}`);
		return false;
	} catch {
		report('failed:smoke_failed');
		return false;
	} finally {
		providerEndSubscription?.dispose();
		if (provider !== undefined) {
			await terminateProvider(provider).catch(() => undefined);
		}
		await options.supervisor.dispose().catch(() => undefined);
	}
}

export function spawnClaudeProvider(
	request: AgentProcessSpawnRequest,
): PtyProcessHandle {
	return nodePtyAdapter.spawn({
		executable: request.executable,
		args: request.windowsVerbatimArguments
			? request.args.join(' ')
			: [...request.args],
		cwd: request.cwd,
		env: request.environment,
		cols: 100,
		rows: 30,
	});
}

function removeMcpCredential(
	request: AgentProcessSpawnRequest,
): AgentProcessSpawnRequest {
	const environment = Object.fromEntries(Object.entries(request.environment).filter(
		([name]) => name.toUpperCase() !== CLAUDE_MCP_TOKEN_ENVIRONMENT_VARIABLE,
	));
	return Object.freeze({
		...request,
		environment: Object.freeze(environment),
	});
}

async function waitForProviderReady(
	provider: PtyProcessHandle,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) {
		return false;
	}
	try {
		const pid = await Promise.race([
			provider.waitForReadyPid({ timeoutMs: 10_000 }),
			waitForAbortSignal(signal),
		]);
		return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1;
	} catch {
		return false;
	}
}

function waitForProviderEnd(provider: PtyProcessHandle): {
	readonly promise: Promise<{
		readonly type: 'provider_exit';
		readonly exitCode: number;
		readonly signal?: number;
	}>;
	readonly subscription: PtyListenerDisposable;
} {
	let subscription: PtyListenerDisposable;
	const promise = new Promise<{
		readonly type: 'provider_exit';
		readonly exitCode: number;
		readonly signal?: number;
	}>((resolve) => {
		subscription = provider.onExit((event) => resolve({
			type: 'provider_exit',
			exitCode: event.exitCode,
			...(event.signal === undefined ? {} : { signal: event.signal }),
		}));
	});
	return { promise, subscription: subscription! };
}

function waitForAbort(
	signal?: AbortSignal,
): Promise<{ readonly type: 'failure'; readonly reason: 'smoke_cancelled' }> {
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

function waitForAbortSignal(signal?: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error('Smoke cancelled.'));
			return;
		}
		signal?.addEventListener(
			'abort',
			() => reject(new Error('Smoke cancelled.')),
			{ once: true },
		);
	});
}

async function terminateClaudeProvider(provider: PtyProcessHandle): Promise<void> {
	let subscription: PtyListenerDisposable | undefined;
	const exited = new Promise<void>((resolve) => {
		subscription = provider.onExit(() => resolve());
	});
	try {
		provider.kill();
	} catch {
		subscription?.dispose();
		return;
	}
	await Promise.race([
		exited,
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 1_000);
			timer.unref?.();
		}),
	]);
	subscription?.dispose();
}

async function runMainSmoke(
	repositoryRoot: string,
	claudeExecutable: string | undefined,
	credentialMode: ClaudeSmokeCredentialMode,
): Promise<boolean> {
	const sessionId = `claude-smoke-${randomUUID()}`;
	const controller = new AbortController();
	const observer = new ClaudeSmokeEventObserver(
		sessionId,
		credentialMode === 'missing-negative-control',
	);
	const supervisor = new McpAdapterSupervisor({
		extensionUri: { fsPath: repositoryRoot },
		parentEnvironment: process.env,
		onEvent: (event) => observer.handle(event),
	});
	const abort = (): void => controller.abort();
	process.once('SIGINT', abort);
	process.once('SIGTERM', abort);
	try {
		return await runClaudeMcpSmoke({
			supervisor,
			events: observer,
			sessionId,
			cwd: repositoryRoot,
			baseEnvironment: process.env,
			credentialMode,
			claudeExecutable,
			report: (status) => console.log(status),
			signal: controller.signal,
		});
	} finally {
		process.removeListener('SIGINT', abort);
		process.removeListener('SIGTERM', abort);
	}
}

async function main(): Promise<void> {
	const executableArgument = process.argv.indexOf('--claude-executable');
	const claudeExecutable = executableArgument < 0
		? undefined
		: process.argv[executableArgument + 1];
	if (executableArgument >= 0 && claudeExecutable === undefined) {
		console.log('failed:provider_unavailable');
		process.exitCode = 1;
		return;
	}
	const repositoryRoot = path.resolve(__dirname, '..', '..');
	const positive = await runMainSmoke(
		repositoryRoot,
		claudeExecutable,
		'registered',
	);
	if (!positive) {
		process.exitCode = 1;
		return;
	}
	const negative = await runMainSmoke(
		repositoryRoot,
		claudeExecutable,
		'missing-negative-control',
	);
	process.exitCode = negative ? 0 : 1;
}

if (require.main === module) {
	void main().catch(() => {
		console.log('failed:smoke_failed');
		process.exitCode = 1;
	});
}
