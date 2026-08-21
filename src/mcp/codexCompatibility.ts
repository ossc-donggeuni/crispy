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
		return undefined;
	}
	const output = await readVersionOutput(request);
	return output === undefined
		? undefined
		: selectCodexConfigStyleFromVersionOutput(output);
};

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
): Promise<string | undefined> {
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
		return undefined;
	}

	return new Promise((resolve) => {
		let settled = false;
		let output = '';
		let timer: NodeJS.Timeout | undefined;
		const settle = (value: string | undefined): void => {
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
				settle(undefined);
			}
		};
		timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/** A failed compatibility probe only disables MCP for this launch. */
			}
			settle(undefined);
		}, CODEX_VERSION_PROBE_TIMEOUT_MS);

		child.stdout?.on('data', append);
		child.stderr?.on('data', append);
		child.once('error', () => settle(undefined));
		child.once('exit', (code, signal) => {
			settle(code === 0 && signal === null ? output : undefined);
		});
	});
}

function compareVersion(
	left: Readonly<{ major: number; minor: number; patch: number }>,
	right: Readonly<{ major: number; minor: number; patch: number }>,
): number {
	return left.major - right.major
		|| left.minor - right.minor
		|| left.patch - right.patch;
}
