import type { ResolvedAgentExecutable } from './agentExecutableResolver';
import {
	type AgentLaunchPlan,
	MCP_PROVIDER_ENVIRONMENT_REMOVALS,
} from './agentLaunchPlan';
import {
	CLAUDE_MCP_TOKEN_ENVIRONMENT_VARIABLE,
	createClaudeMcpConfig,
} from './claudeConfig';
import type { McpRandomBytes } from './sessionCredentials';
import type { McpConnectionDescriptor } from './sessionRuntime';

export interface BuildClaudeBareLaunchPlanOptions {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly args?: readonly string[];
}

export interface BuildClaudeMcpLaunchPlanOptions
	extends BuildClaudeBareLaunchPlanOptions {
	readonly connection: McpConnectionDescriptor;
	/** Host-owned immutable VS Code capability; omission is fail-closed. */
	readonly agentActivityCompatible?: boolean;
	readonly randomBytes?: McpRandomBytes;
	/** Diagnostic callers may derive a prompt from the generated non-secret server name. */
	readonly createArgs?: (serverName: string) => readonly string[];
}

/** A compatibility or fail-open launch never receives config or credentials. */
export function buildClaudeBareLaunchPlan(
	options: BuildClaudeBareLaunchPlanOptions,
): AgentLaunchPlan {
	return freezeClaudePlan({
		executable: options.executable,
		cwd: options.cwd,
		args: options.args ?? [],
		createEnvOverlay: () => Object.freeze({}),
		expectsMcp: false,
	});
}

/** Builds an authenticated plan after the common supervisor registered the session. */
export function buildClaudeMcpLaunchPlan(
	options: BuildClaudeMcpLaunchPlanOptions,
): AgentLaunchPlan {
	const config = createClaudeMcpConfig(
		options.connection,
		options.randomBytes,
		options.agentActivityCompatible === true,
	);
	if (options.args !== undefined && options.createArgs !== undefined) {
		throw new Error('Claude launch arguments are invalid.');
	}
	const args = options.createArgs?.(config.serverName) ?? options.args ?? [];
	options.connection.withBearerToken(() => undefined);
	return freezeClaudePlan({
		executable: options.executable,
		cwd: options.cwd,
		/** Keep MCP-generated additive instructions and config after user args. */
		args: [...args, ...config.args],
		createEnvOverlay: () => options.connection.withBearerToken((token) =>
			Object.freeze({
				[CLAUDE_MCP_TOKEN_ENVIRONMENT_VARIABLE]: token,
			})
		),
		expectsMcp: true,
		mcpServerName: config.serverName,
	});
}

function freezeClaudePlan(options: {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly args: readonly string[];
	readonly createEnvOverlay: () => Readonly<Record<string, string>>;
	readonly expectsMcp: boolean;
	readonly mcpServerName?: string;
}): AgentLaunchPlan {
	const plan = {
		providerId: 'claude' as const,
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
	Object.defineProperty(plan, 'envOverlay', {
		get: options.createEnvOverlay,
		enumerable: false,
		configurable: false,
	});
	return Object.freeze(plan) as unknown as AgentLaunchPlan;
}
