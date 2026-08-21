import type { ResolvedAgentExecutable } from './agentExecutableResolver';
import {
	type AgentLaunchPlan,
	MCP_PROVIDER_ENVIRONMENT_REMOVALS,
} from './agentLaunchPlan';
import {
	CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE,
	createCodexMcpConfig,
} from './codexConfig';
import type { McpRandomBytes } from './sessionCredentials';
import type { McpConnectionDescriptor } from './sessionRuntime';

export interface BuildCodexBareLaunchPlanOptions {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly args?: readonly string[];
}

export interface BuildCodexMcpLaunchPlanOptions
	extends BuildCodexBareLaunchPlanOptions {
	readonly connection: McpConnectionDescriptor;
	readonly argsBeforeConfig?: readonly string[];
	readonly argsAfterConfig?: readonly string[];
	readonly randomBytes?: McpRandomBytes;
}

/** A fail-open Codex plan never contains an MCP credential or Electron child control. */
export function buildCodexBareLaunchPlan(
	options: BuildCodexBareLaunchPlanOptions,
): AgentLaunchPlan {
	return freezeCodexPlan({
		executable: options.executable,
		cwd: options.cwd,
		args: options.args ?? [],
		envOverlay: {},
		expectsMcp: false,
	});
}

/** Builds the authenticated Codex plan only from an active, registered connection. */
export function buildCodexMcpLaunchPlan(
	options: BuildCodexMcpLaunchPlanOptions,
): AgentLaunchPlan {
	const config = createCodexMcpConfig(options.connection, options.randomBytes);
	return options.connection.withBearerToken((token) => freezeCodexPlan({
		executable: options.executable,
		cwd: options.cwd,
		args: [
			...(options.argsBeforeConfig ?? options.args ?? []),
			...config.args,
			...(options.argsAfterConfig ?? []),
		],
		envOverlay: {
			[CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE]: token,
		},
		expectsMcp: true,
		mcpServerName: config.serverName,
	}));
}

function freezeCodexPlan(options: {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly envOverlay: Readonly<Record<string, string>>;
	readonly expectsMcp: boolean;
	readonly mcpServerName?: string;
}): AgentLaunchPlan {
	return Object.freeze({
		providerId: 'codex',
		executable: options.executable.executable,
		args: Object.freeze([...options.args]),
		cwd: options.cwd,
		envOverlay: Object.freeze({ ...options.envOverlay }),
		envRemove: MCP_PROVIDER_ENVIRONMENT_REMOVALS,
		launcherKind: options.executable.launcherKind,
		expectsMcp: options.expectsMcp,
		...(options.mcpServerName === undefined
			? {}
			: { mcpServerName: options.mcpServerName }),
	});
}
