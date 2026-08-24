import {
	spawn,
	type ChildProcess,
} from 'node:child_process';
import type { ProcessTreeController } from '../agent/host/terminal/processTreeController';
import { createHostProcessTreeController } from '../agent/host/terminal/processTreeControllerFactory';
import type {
	WorkspaceChildSpawnCwdResolver,
} from '../agent/host/workspace/workspaceChildSpawnPreflight';
import type { ResolvedAgentExecutable } from './agentExecutableResolver';
import {
	createAgentProcessSpawnOptions,
	createAgentProcessSpawnRequest,
} from './agentLaunchPlan';
import { buildCodexBareLaunchPlan } from './codexLaunchPlan';
import type { CodexShellEnvironmentPolicyStyle } from './codexConfig';

export const CODEX_KEYED_FILTER_CONSERVATIVE_BASELINE = Object.freeze({
	major: 0,
	minor: 149,
	patch: 0,
});
export const CODEX_VERSION_PROBE_TIMEOUT_MS = 3_000;
const CODEX_VERSION_OUTPUT_LIMIT = 1_024;
const CODEX_VERSION_FALLBACK_KILL_WAIT_MS = 250;

export interface ResolveCodexConfigStyleOptions {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	readonly environment: NodeJS.ProcessEnv;
	/** `spawn()` 바로 전에 current Workspace/Trust를 재검증해 fresh cwd를 반환한다. */
	readonly resolveWorkspaceCwdBeforeSpawn: WorkspaceChildSpawnCwdResolver;
	/** Session cleanup과 Workspace Trust revoke가 version child tree를 취소하는 신호다. */
	readonly signal?: AbortSignal;
	/** Test seam; production creates the same bounded Host controller lazily on failure. */
	readonly processTreeController?: ProcessTreeController;
	readonly versionProbeTimeoutMs?: number;
	readonly versionOutputLimit?: number;
}

export type CodexVersionProbeFailureReason =
	| 'request_invalid'
	| 'workspace_preflight_failed'
	| 'spawn_error'
	| 'exit_nonzero'
	| 'signal'
	| 'timeout'
	| 'output_limit'
	| 'unparsable_version';

export type CodexConfigStyleProbeResult =
	| Readonly<{
		readonly ok: true;
		readonly style: CodexShellEnvironmentPolicyStyle;
	}>
	| Readonly<{
		readonly ok: false;
		readonly reason: CodexVersionProbeFailureReason;
	}>;

export type CodexConfigStyleResolver = (
	options: ResolveCodexConfigStyleOptions,
) => Promise<CodexShellEnvironmentPolicyStyle | undefined>;

/**
 * Selects the canonical keyed filter for a conservatively verified Codex baseline and later
 * semver releases. Older releases retain the legacy exclusion syntax. An unreadable version
 * disables only MCP so the caller can continue with a bare Codex launch.
 */
export const resolveCodexConfigStyle: CodexConfigStyleResolver = async (
	options,
) => {
	const result = await probeCodexConfigStyle(options);
	return result.ok ? result.style : undefined;
};

/** Returns a stable, credential-free failure reason for compatibility smoke diagnostics. */
export async function probeCodexConfigStyle(
	options: ResolveCodexConfigStyleOptions,
): Promise<CodexConfigStyleProbeResult> {
	if (options.signal?.aborted) {
		return failure('signal');
	}
	let request: ReturnType<typeof createAgentProcessSpawnRequest>;
	try {
		const plan = buildCodexBareLaunchPlan({
			executable: options.executable,
			cwd: options.cwd,
			args: ['--version'],
		});
		request = createAgentProcessSpawnRequest(plan, {
			platform: options.platform,
			environment: options.environment,
		});
	} catch {
		return failure('request_invalid');
	}
	const versionResult = await readVersionOutput(request, options);
	if (!versionResult.ok) {
		return versionResult;
	}
	const style = selectCodexConfigStyleFromVersionOutput(versionResult.output);
	return style === undefined
		? failure('unparsable_version')
		: Object.freeze({ ok: true, style });
}

export function selectCodexConfigStyleFromVersionOutput(
	output: string,
): CodexShellEnvironmentPolicyStyle | undefined {
	const match = /(?:^|\s)codex(?:-cli)?\s+v?(\d+)\.(\d+)\.(\d+)(?=$|[-+\s])/iu.exec(output)
		?? /^\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?\s*$/u.exec(output);
	if (match === null) {
		return undefined;
	}
	const version = {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
	};
	if (!Object.values(version).every(Number.isSafeInteger)) {
		return undefined;
	}
	return compareVersion(version, CODEX_KEYED_FILTER_CONSERVATIVE_BASELINE) >= 0
		? 'keyed-filters'
		: 'legacy-exclude';
}

async function readVersionOutput(
	request: ReturnType<typeof createAgentProcessSpawnRequest>,
	options: ResolveCodexConfigStyleOptions,
): Promise<
	| Readonly<{ readonly ok: true; readonly output: string }>
	| Readonly<{ readonly ok: false; readonly reason: CodexVersionProbeFailureReason }>
> {
	if (options.signal?.aborted) {
		return failure('signal');
	}
	let freshCwd: string | undefined;
	try {
		/** 이 동기 resolver 성공과 아래 spawn 사이에는 await가 없어야 한다. */
		freshCwd = options.resolveWorkspaceCwdBeforeSpawn();
	} catch {
		return failure('workspace_preflight_failed');
	}
	if (freshCwd === undefined) {
		return failure('workspace_preflight_failed');
	}
	if (options.signal?.aborted) {
		return failure('signal');
	}
	const freshRequest = Object.freeze({
		...request,
		cwd: freshCwd,
	});
	let child: ChildProcess;
	try {
		child = spawn(
			freshRequest.executable,
			[...freshRequest.args],
			{
				...createAgentProcessSpawnOptions(freshRequest),
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
	} catch {
		return failure('spawn_error');
	}

	return new Promise((resolve) => {
		let settled = false;
		let terminationStarted = false;
		let output = '';
		let timer: NodeJS.Timeout | undefined;
		const settle = (
			value:
				| Readonly<{ readonly ok: true; readonly output: string }>
				| Readonly<{
					readonly ok: false;
					readonly reason: CodexVersionProbeFailureReason;
				}>,
		): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			options.signal?.removeEventListener('abort', handleAbort);
			resolve(value);
		};
		const append = (chunk: unknown): void => {
			if (settled || terminationStarted) {
				return;
			}
			output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
			if (output.length > (options.versionOutputLimit
				?? CODEX_VERSION_OUTPUT_LIMIT)) {
				void terminateAndSettle('output_limit');
			}
		};
		const terminateAndSettle = async (
			reason: 'timeout' | 'output_limit' | 'signal',
		): Promise<void> => {
			if (settled || terminationStarted) {
				return;
			}
			terminationStarted = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			await terminateVersionProcessTree(child, options);
			settle(failure(reason));
		};
		const handleAbort = (): void => {
			void terminateAndSettle('signal');
		};
		timer = setTimeout(() => {
			void terminateAndSettle('timeout');
		}, options.versionProbeTimeoutMs ?? CODEX_VERSION_PROBE_TIMEOUT_MS);
		options.signal?.addEventListener('abort', handleAbort, { once: true });
		if (options.signal?.aborted) {
			handleAbort();
		}

		child.stdout?.on('data', append);
		child.stderr?.on('data', append);
		child.once('error', () => {
			if (!terminationStarted) {
				settle(failure('spawn_error'));
			}
		});
		child.once('exit', (code, signal) => {
			if (terminationStarted) {
				return;
			}
			if (signal !== null) {
				settle(failure('signal'));
				return;
			}
			settle(code === 0
				? Object.freeze({ ok: true, output })
				: failure('exit_nonzero'));
		});
	});
}

async function terminateVersionProcessTree(
	child: ChildProcess,
	options: ResolveCodexConfigStyleOptions,
): Promise<void> {
	const pid = child.pid;
	if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 1) {
		await killVersionProcessRoot(child);
		return;
	}

	try {
		const controller = options.processTreeController
			?? createHostProcessTreeController({
				readPlatform: () => options.platform,
				timeoutMs: 1_000,
			});
		const capture = await controller.capture(pid as number);
		if (capture.status === 'captured') {
			const result = await controller.terminate(capture.snapshot);
			if (
				result.outcome === 'gracefully_terminated'
				|| result.outcome === 'already_terminated'
				|| result.outcome === 'force_terminated'
			) {
				return;
			}
		}
	} catch {
		/** Root kill below remains the bounded last resort for probe cleanup. */
	}

	await killVersionProcessRoot(child);
}

async function killVersionProcessRoot(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	const exited = new Promise<void>((resolve) => {
		child.once('exit', () => resolve());
	});
	try {
		child.kill();
	} catch {
		return;
	}
	await Promise.race([
		exited,
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, CODEX_VERSION_FALLBACK_KILL_WAIT_MS);
			timer.unref?.();
		}),
	]);
}

function failure(
	reason: CodexVersionProbeFailureReason,
): Readonly<{ readonly ok: false; readonly reason: CodexVersionProbeFailureReason }> {
	return Object.freeze({ ok: false, reason });
}

function compareVersion(
	left: Readonly<{ major: number; minor: number; patch: number }>,
	right: Readonly<{ major: number; minor: number; patch: number }>,
): number {
	return left.major - right.major
		|| left.minor - right.minor
		|| left.patch - right.patch;
}
