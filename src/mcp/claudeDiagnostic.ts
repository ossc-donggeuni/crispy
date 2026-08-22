import type { McpFailureReason } from './failureReason';

export const CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION =
	'You cannot dynamically configure MCP servers when an enterprise MCP config is present';
export const CLAUDE_STARTUP_DIAGNOSTIC_MAX_BYTES = 16 * 1024;

export interface ClaudeStartupDiagnosticInput {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly reachedInteractivePrompt: boolean;
	readonly stderr: string;
	readonly expectedMcpServerName?: string;
}

/**
 * Only the documented workstation managed-MCP startup rejection is classified in L1.
 * Login, network, normal exit, and generic config errors remain deliberately unclassified.
 */
export function classifyClaudeStartupDiagnostic(
	input: ClaudeStartupDiagnosticInput,
): Extract<
	McpFailureReason,
	'provider_config_rejected' | 'provider_policy_blocked'
> | undefined {
	if (
		input.reachedInteractivePrompt
		|| input.signal !== null
		|| input.exitCode === null
		|| input.exitCode === 0
		|| Buffer.byteLength(input.stderr, 'utf8') > CLAUDE_STARTUP_DIAGNOSTIC_MAX_BYTES
	) {
		return undefined;
	}

	const lines = stripAnsi(input.stderr)
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.some((line) =>
		line === CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION
		|| line === `Error: ${CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION}`
	)) {
		return 'provider_policy_blocked';
	}

	const expectedServerName = input.expectedMcpServerName;
	if (
		expectedServerName !== undefined
		&& /^crispy_canvas_[a-f0-9]{32}$/u.test(expectedServerName)
		&& lines.length === 2
		&& lines[0] === 'Error: Invalid MCP configuration:'
		&& lines[1] === `mcpServers.${expectedServerName}: Does not adhere to MCP server configuration schema`
	) {
		return 'provider_config_rejected';
	}
	return undefined;
}

function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
}
