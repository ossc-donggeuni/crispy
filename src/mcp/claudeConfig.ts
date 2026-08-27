import { randomBytes } from 'node:crypto';
import { MCP_LOOPBACK_HOST } from './httpPolicy';
import { isValidMcpRouteId, type McpRandomBytes } from './sessionCredentials';
import type { McpConnectionDescriptor } from './sessionRuntime';
import { createCrispyMcpInstructions } from './agentActivityInstructions';

export const CLAUDE_MCP_CONFIG_ARGUMENT = '--mcp-config';
export const CLAUDE_APPEND_SYSTEM_PROMPT_ARGUMENT = '--append-system-prompt';
export const CLAUDE_MCP_TOKEN_ENVIRONMENT_VARIABLE = 'CRISPY_MCP_TOKEN';
export const CLAUDE_MCP_TOKEN_PLACEHOLDER = '${CRISPY_MCP_TOKEN}';
export const CLAUDE_MCP_SERVER_NAME_PREFIX = 'crispy_';
export const CLAUDE_MCP_SERVER_NAME_RANDOM_BYTES = 12;
export const CLAUDE_MCP_TOOL_NAME_MAX_LENGTH = 64;

export interface ClaudeMcpConfig {
	readonly serverName: string;
	readonly inlineConfig: string;
	readonly args: readonly string[];
}

/** Creates a provider-safe session name without reusing a user's `crispy` key. */
export function createClaudeMcpServerName(
	random: McpRandomBytes = randomBytes,
): string {
	const randomValue = random(CLAUDE_MCP_SERVER_NAME_RANDOM_BYTES);
	if (randomValue.byteLength !== CLAUDE_MCP_SERVER_NAME_RANDOM_BYTES) {
		throw new Error('Claude MCP server name generation failed.');
	}
	return `${CLAUDE_MCP_SERVER_NAME_PREFIX}${randomValue.toString('hex')}`;
}

/** Claude API Tool names are limited to 64 characters after MCP qualification. */
export function isValidClaudeMcpServerName(value: string): boolean {
	return new RegExp(
		`^${CLAUDE_MCP_SERVER_NAME_PREFIX}[a-f0-9]{${
			CLAUDE_MCP_SERVER_NAME_RANDOM_BYTES * 2
		}}$`,
		'u',
	).test(value);
}

export function createClaudeMcpQualifiedToolName(
	serverName: string,
	toolName: string,
): string {
	if (
		!isValidClaudeMcpServerName(serverName)
		|| !/^[A-Za-z0-9_-]+$/u.test(toolName)
	) {
		throw new Error('Claude MCP Tool name is invalid.');
	}
	const qualified = `mcp__${serverName}__${toolName}`;
	if (qualified.length > CLAUDE_MCP_TOOL_NAME_MAX_LENGTH) {
		throw new Error('Claude MCP Tool name exceeds the provider limit.');
	}
	return qualified;
}

/** Serializes a session-only Claude config whose argv contains only an env placeholder. */
export function createClaudeMcpConfig(
	connection: McpConnectionDescriptor,
	random?: McpRandomBytes,
	agentActivityCompatible = false,
	taskToolCompatible = false,
): ClaudeMcpConfig {
	assertValidClaudeMcpUrl(connection.url);
	const serverName = createClaudeMcpServerName(random);
	const inlineConfig = JSON.stringify({
		mcpServers: {
			[serverName]: {
				type: 'http',
				url: connection.url,
				headers: {
					Authorization: `Bearer ${CLAUDE_MCP_TOKEN_PLACEHOLDER}`,
				},
				alwaysLoad: true,
			},
		},
	});
	return Object.freeze({
		serverName,
		inlineConfig,
		args: Object.freeze([
			CLAUDE_APPEND_SYSTEM_PROMPT_ARGUMENT,
			createCrispyMcpInstructions(
				agentActivityCompatible,
				taskToolCompatible,
			),
			CLAUDE_MCP_CONFIG_ARGUMENT,
			inlineConfig,
		]),
	});
}

function assertValidClaudeMcpUrl(value: string): void {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error('Claude MCP URL is invalid.');
	}
	const routeMatch = /^\/mcp\/([^/]+)$/.exec(parsed.pathname);
	if (
		parsed.protocol !== 'http:'
		|| parsed.hostname !== MCP_LOOPBACK_HOST
		|| parsed.port === ''
		|| parsed.username !== ''
		|| parsed.password !== ''
		|| parsed.search !== ''
		|| parsed.hash !== ''
		|| routeMatch === null
		|| !isValidMcpRouteId(routeMatch[1])
	) {
		throw new Error('Claude MCP URL is invalid.');
	}
}
