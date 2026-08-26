import { spawnSync } from 'node:child_process';
import {
	resolveAgentExecutable,
	type AgentExecutableResolver,
	type ResolvedAgentExecutable,
} from './agentExecutableResolver';
import {
	createAgentProcessSpawnOptions,
	createAgentProcessSpawnRequest,
} from './agentLaunchPlan';
import {
	CLAUDE_MCP_MINIMUM_COMPATIBLE_VERSION,
	probeClaudeMcpCompatibility,
	type ClaudeMcpCompatibilityProbeResult,
	type ClaudeSemanticVersion,
} from './claudeCompatibility';
import { buildClaudeBareLaunchPlan } from './claudeLaunchPlan';

export const CLAUDE_CONFIG_COMPAT_HELP_TIMEOUT_MS = 5_000;
export const CLAUDE_CONFIG_COMPAT_HELP_OUTPUT_LIMIT = 128 * 1024;

export type ClaudeConfigCompatSmokeFailureReason =
	| 'provider_unavailable'
	| 'version_probe_failed'
	| 'version_incompatible'
	| 'help_probe_failed'
	| 'session_config_surface_unavailable';

export type ClaudeConfigCompatSmokeResult =
	| Readonly<{
		readonly ok: true;
		readonly version: ClaudeSemanticVersion;
	}>
	| Readonly<{
		readonly ok: false;
		readonly reason: ClaudeConfigCompatSmokeFailureReason;
	}>;

export interface RunClaudeConfigCompatSmokeOptions {
	readonly cwd: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly claudeExecutable?: string;
	readonly resolveExecutable?: AgentExecutableResolver;
	readonly probeCompatibility?: (
		executable: ResolvedAgentExecutable,
	) => Promise<ClaudeMcpCompatibilityProbeResult>;
	readonly readHelpOutput?: (
		executable: ResolvedAgentExecutable,
	) => string | undefined;
}

/**
 * Credential-free scheduled smoke for the installed CLI surface. Full header expansion and
 * authenticated MCP behavior remain covered by the separate login-required Claude smoke.
 */
export async function runClaudeConfigCompatSmoke(
	options: RunClaudeConfigCompatSmokeOptions,
): Promise<ClaudeConfigCompatSmokeResult> {
	const platform = options.platform ?? process.platform;
	const resolution = await (options.resolveExecutable ?? resolveAgentExecutable)(
		'claude',
		{
			platform,
			environment: options.environment,
			override: options.claudeExecutable,
		},
	);
	if (!resolution.ok) {
		return failure('provider_unavailable');
	}

	const probeCompatibility = options.probeCompatibility
		?? ((executable: ResolvedAgentExecutable) => probeClaudeMcpCompatibility({
			executable,
			cwd: options.cwd,
			platform,
			environment: options.environment,
			resolveWorkspaceCwdBeforeSpawn: () => options.cwd,
		}));
	const compatibility = await probeCompatibility(resolution.executable);
	if (!compatibility.ok) {
		return failure('version_probe_failed');
	}
	if (!compatibility.compatibility.compatible) {
		return failure('version_incompatible');
	}

	const readHelpOutput = options.readHelpOutput
		?? ((executable: ResolvedAgentExecutable) => readClaudeHelpOutput({
			executable,
			cwd: options.cwd,
			platform,
			environment: options.environment,
		}));
	const helpOutput = readHelpOutput(resolution.executable);
	if (helpOutput === undefined) {
		return failure('help_probe_failed');
	}
	if (!hasClaudeSessionMcpConfigSurface(helpOutput)) {
		return failure('session_config_surface_unavailable');
	}

	return Object.freeze({
		ok: true,
		version: compatibility.compatibility.version,
	});
}

export function hasClaudeSessionMcpConfigSurface(helpOutput: string): boolean {
	return /(?:^|\s)--mcp-config(?:\s|,|$)/u.test(helpOutput)
		&& /(?:^|\s)--strict-mcp-config(?:\s|,|$)/u.test(helpOutput)
		&& /(?:^|\s)--append-system-prompt(?:\s|,|$)/u.test(helpOutput);
}

function readClaudeHelpOutput(options: {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	readonly environment: NodeJS.ProcessEnv;
}): string | undefined {
	let request: ReturnType<typeof createAgentProcessSpawnRequest>;
	try {
		request = createAgentProcessSpawnRequest(buildClaudeBareLaunchPlan({
			executable: options.executable,
			cwd: options.cwd,
			args: ['--help'],
		}), {
			platform: options.platform,
			environment: options.environment,
		});
	} catch {
		return undefined;
	}

	const result = spawnSync(request.executable, [...request.args], {
		...createAgentProcessSpawnOptions(request),
		stdio: ['ignore', 'pipe', 'pipe'],
		encoding: 'utf8',
		timeout: CLAUDE_CONFIG_COMPAT_HELP_TIMEOUT_MS,
		maxBuffer: CLAUDE_CONFIG_COMPAT_HELP_OUTPUT_LIMIT,
	});
	if (
		result.error !== undefined
		|| result.signal !== null
		|| result.status !== 0
	) {
		return undefined;
	}
	return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function failure(
	reason: ClaudeConfigCompatSmokeFailureReason,
): ClaudeConfigCompatSmokeResult {
	return Object.freeze({ ok: false, reason });
}

function formatVersion(version: ClaudeSemanticVersion): string {
	return `${version.major}.${version.minor}.${version.patch}`;
}

async function main(): Promise<void> {
	const executableArgument = process.argv.indexOf('--claude-executable');
	const claudeExecutable = executableArgument < 0
		? undefined
		: process.argv[executableArgument + 1];
	if (executableArgument >= 0 && claudeExecutable === undefined) {
		console.log('[claude-config-compat-smoke] failed:provider_unavailable');
		process.exitCode = 1;
		return;
	}

	const result = await runClaudeConfigCompatSmoke({
		cwd: process.cwd(),
		environment: process.env,
		claudeExecutable,
	});
	if (!result.ok) {
		console.log(`[claude-config-compat-smoke] failed:${result.reason}`);
		process.exitCode = 1;
		return;
	}

	console.log(
		`[claude-config-compat-smoke] version=${formatVersion(result.version)} minimum=${formatVersion(CLAUDE_MCP_MINIMUM_COMPATIBLE_VERSION)} session MCP config CLI surface available.`,
	);
}

if (require.main === module) {
	void main().catch(() => {
		console.log('[claude-config-compat-smoke] failed:help_probe_failed');
		process.exitCode = 1;
	});
}
