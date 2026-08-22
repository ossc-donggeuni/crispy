import {
	spawn,
	type ChildProcess,
} from 'node:child_process';
import type { ProcessTreeController } from '../agent/host/terminal/processTreeController';
import { createHostProcessTreeController } from '../agent/host/terminal/processTreeControllerFactory';
import type { ResolvedAgentExecutable } from './agentExecutableResolver';
import {
	createAgentProcessSpawnOptions,
	createAgentProcessSpawnRequest,
} from './agentLaunchPlan';
import { buildClaudeBareLaunchPlan } from './claudeLaunchPlan';

export interface ClaudeSemanticVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
}

/** Official 2.1.121 release introduced config-level `alwaysLoad`. */
export const CLAUDE_MCP_MINIMUM_COMPATIBLE_VERSION = Object.freeze({
	major: 2,
	minor: 1,
	patch: 121,
} satisfies ClaudeSemanticVersion);
export const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 3_000;
const CLAUDE_VERSION_OUTPUT_LIMIT = 1_024;
const CLAUDE_VERSION_FALLBACK_KILL_WAIT_MS = 250;

export interface ResolveClaudeMcpCompatibilityOptions {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	readonly environment: NodeJS.ProcessEnv;
	readonly processTreeController?: ProcessTreeController;
	readonly versionProbeTimeoutMs?: number;
	readonly versionOutputLimit?: number;
}

export type ClaudeVersionProbeFailureReason =
	| 'request_invalid'
	| 'spawn_error'
	| 'exit_nonzero'
	| 'signal'
	| 'timeout'
	| 'output_limit'
	| 'unparsable_version';

export interface ClaudeMcpCompatibility {
	readonly version: ClaudeSemanticVersion;
	readonly compatible: boolean;
}

export type ClaudeMcpCompatibilityProbeResult =
	| Readonly<{
		readonly ok: true;
		readonly compatibility: ClaudeMcpCompatibility;
	}>
	| Readonly<{
		readonly ok: false;
		readonly reason: ClaudeVersionProbeFailureReason;
	}>;

export type ClaudeMcpCompatibilityResolver = (
	options: ResolveClaudeMcpCompatibilityOptions,
) => Promise<ClaudeMcpCompatibility | undefined>;

/** Unreadable or unsupported versions disable only MCP; callers may launch bare Claude. */
export const resolveClaudeMcpCompatibility: ClaudeMcpCompatibilityResolver = async (
	options,
) => {
	const result = await probeClaudeMcpCompatibility(options);
	return result.ok ? result.compatibility : undefined;
};

/** Runs a bounded, credential-free `claude --version` process. */
export async function probeClaudeMcpCompatibility(
	options: ResolveClaudeMcpCompatibilityOptions,
): Promise<ClaudeMcpCompatibilityProbeResult> {
	let request: ReturnType<typeof createAgentProcessSpawnRequest>;
	try {
		request = createAgentProcessSpawnRequest(buildClaudeBareLaunchPlan({
			executable: options.executable,
			cwd: options.cwd,
			args: ['--version'],
		}), {
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
	const version = parseClaudeVersionOutput(versionResult.output);
	if (version === undefined) {
		return failure('unparsable_version');
	}
	return Object.freeze({
		ok: true,
		compatibility: Object.freeze({
			version,
			compatible: compareClaudeVersions(
				version,
				CLAUDE_MCP_MINIMUM_COMPATIBLE_VERSION,
			) >= 0,
		}),
	});
}

/** Parses only a standalone stable semver line emitted by Claude's version command. */
export function parseClaudeVersionOutput(
	output: string,
): ClaudeSemanticVersion | undefined {
	for (const line of output.split(/\r?\n/u)) {
		const match = /^\s*(?:(?:claude(?:\s+code)?)\s+v?)?(\d+)\.(\d+)\.(\d+)(?:\s+\(Claude Code\))?\s*$/iu.exec(line);
		if (match === null) {
			continue;
		}
		const version = {
			major: Number(match[1]),
			minor: Number(match[2]),
			patch: Number(match[3]),
		};
		if (Object.values(version).every(Number.isSafeInteger)) {
			return Object.freeze(version);
		}
	}
	return undefined;
}

export function compareClaudeVersions(
	left: ClaudeSemanticVersion,
	right: ClaudeSemanticVersion,
): number {
	return left.major - right.major
		|| left.minor - right.minor
		|| left.patch - right.patch;
}

async function readVersionOutput(
	request: ReturnType<typeof createAgentProcessSpawnRequest>,
	options: ResolveClaudeMcpCompatibilityOptions,
): Promise<
	| Readonly<{ readonly ok: true; readonly output: string }>
	| Readonly<{ readonly ok: false; readonly reason: ClaudeVersionProbeFailureReason }>
> {
	let child: ChildProcess;
	try {
		child = spawn(request.executable, [...request.args], {
			...createAgentProcessSpawnOptions(request),
			stdio: ['ignore', 'pipe', 'pipe'],
		});
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
					readonly reason: ClaudeVersionProbeFailureReason;
				}>,
		): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			resolve(value);
		};
		const terminateAndSettle = async (
			reason: 'timeout' | 'output_limit',
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
		const append = (chunk: unknown): void => {
			if (settled || terminationStarted) {
				return;
			}
			output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
			if (output.length > (options.versionOutputLimit
				?? CLAUDE_VERSION_OUTPUT_LIMIT)) {
				void terminateAndSettle('output_limit');
			}
		};

		timer = setTimeout(() => {
			void terminateAndSettle('timeout');
		}, options.versionProbeTimeoutMs ?? CLAUDE_VERSION_PROBE_TIMEOUT_MS);
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
	options: ResolveClaudeMcpCompatibilityOptions,
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
		/** The root kill remains the bounded final probe cleanup. */
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
			const timer = setTimeout(resolve, CLAUDE_VERSION_FALLBACK_KILL_WAIT_MS);
			timer.unref?.();
		}),
	]);
}

function failure(
	reason: ClaudeVersionProbeFailureReason,
): Readonly<{
	readonly ok: false;
	readonly reason: ClaudeVersionProbeFailureReason;
}> {
	return Object.freeze({ ok: false, reason });
}
