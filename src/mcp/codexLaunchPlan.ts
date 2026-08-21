import type { ResolvedAgentExecutable } from './agentExecutableResolver';
import {
	type AgentLaunchPlan,
	MCP_PROVIDER_ENVIRONMENT_REMOVALS,
} from './agentLaunchPlan';
import {
	CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE,
	createCodexMcpConfig,
	type CodexShellEnvironmentPolicyStyle,
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
	readonly shellEnvironmentPolicyStyle: CodexShellEnvironmentPolicyStyle;
}

/** A fail-open Codex plan never contains an MCP credential or Electron child control. */
export function buildCodexBareLaunchPlan(
	options: BuildCodexBareLaunchPlanOptions,
): AgentLaunchPlan {
	return freezeCodexPlan({
		executable: options.executable,
		cwd: options.cwd,
		args: options.args ?? [],
		createEnvOverlay: () => Object.freeze({}),
		expectsMcp: false,
	});
}

/** Builds the authenticated Codex plan only from an active, registered connection. */
export function buildCodexMcpLaunchPlan(
	options: BuildCodexMcpLaunchPlanOptions,
): AgentLaunchPlan {
	const config = createCodexMcpConfig(
		options.connection,
		options.randomBytes,
		options.shellEnvironmentPolicyStyle,
	);
	/** Building and final environment materialization both require an active descriptor. */
	options.connection.withBearerToken(() => undefined);
	return freezeCodexPlan({
		executable: options.executable,
		cwd: options.cwd,
		args: [
			...(options.argsBeforeConfig ?? options.args ?? []),
			...config.args,
			...(options.argsAfterConfig ?? []),
		],
		createEnvOverlay: () => options.connection.withBearerToken((token) =>
			Object.freeze({
				[CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE]: token,
			})
		),
		expectsMcp: true,
		mcpServerName: config.serverName,
	});
}

function freezeCodexPlan(options: {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly createEnvOverlay: () => Readonly<Record<string, string>>;
	readonly expectsMcp: boolean;
	readonly mcpServerName?: string;
}): AgentLaunchPlan {
	const plan = {
		providerId: 'codex',
		executable: options.executable.executable,
		args: Object.freeze([...options.args]),
		cwd: options.cwd,
		envRemove: MCP_PROVIDER_ENVIRONMENT_REMOVALS,
		launcherKind: options.executable.launcherKind,
		expectsMcp: options.expectsMcp,
		...(options.mcpServerName === undefined
			? {}
			: { mcpServerName: options.mcpServerName }),
	};
	/** Credential-bearing overlay stays accessible to the final spawn boundary but out of snapshots. */
	Object.defineProperty(plan, 'envOverlay', {
		get: options.createEnvOverlay,
		enumerable: false,
		configurable: false,
	});
	return Object.freeze(plan) as unknown as AgentLaunchPlan;
}
