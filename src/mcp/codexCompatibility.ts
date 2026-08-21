import {
	spawn,
	type ChildProcess,
} from 'node:child_process';
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

export interface ResolveCodexConfigStyleOptions {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	readonly environment: NodeJS.ProcessEnv;
}

export type CodexVersionProbeFailureReason =
	| 'request_invalid'
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
	const versionResult = await readVersionOutput(request);
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
): Promise<
	| Readonly<{ readonly ok: true; readonly output: string }>
	| Readonly<{ readonly ok: false; readonly reason: CodexVersionProbeFailureReason }>
> {
	let child: ChildProcess;
	try {
		child = spawn(
			request.executable,
			[...request.args],
			{
				...createAgentProcessSpawnOptions(request),
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
	} catch {
		return failure('spawn_error');
	}

	return new Promise((resolve) => {
		let settled = false;
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
			resolve(value);
		};
		const append = (chunk: unknown): void => {
			if (settled) {
				return;
			}
			output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
			if (output.length > CODEX_VERSION_OUTPUT_LIMIT) {
				try {
					child.kill();
				} catch {
					/** A failed compatibility probe only disables MCP for this launch. */
				}
				settle(failure('output_limit'));
			}
		};
		timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/** A failed compatibility probe only disables MCP for this launch. */
			}
			settle(failure('timeout'));
		}, CODEX_VERSION_PROBE_TIMEOUT_MS);

		child.stdout?.on('data', append);
		child.stderr?.on('data', append);
		child.once('error', () => settle(failure('spawn_error')));
		child.once('exit', (code, signal) => {
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
