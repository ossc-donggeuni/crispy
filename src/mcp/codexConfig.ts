import { randomBytes } from 'node:crypto';
import { MCP_LOOPBACK_HOST } from './httpPolicy';
import { isValidMcpRouteId, type McpRandomBytes } from './sessionCredentials';
import type { McpConnectionDescriptor } from './sessionRuntime';
import { CRISPY_PING_TOOL_NAME } from './toolServer';

export const CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE = 'CRISPY_MCP_TOKEN';
export const CODEX_MCP_SERVER_NAME_PREFIX = 'crispy_canvas_';
export const CODEX_MCP_SERVER_NAME_RANDOM_BYTES = 16;
export const CODEX_CONFIG_OVERRIDE_ARGUMENT = '--config';
export const CODEX_SHELL_SNAPSHOT_DISABLED_ASSIGNMENT =
	'features.shell_snapshot=false';

export type CodexShellEnvironmentPolicyStyle =
	| 'keyed-filters'
	| 'legacy-exclude';

const BLOCKED_CODEX_PROVIDER_ENVIRONMENT_NAMES = new Set([
	CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE,
	'ELECTRON_RUN_AS_NODE',
]);

export interface CodexMcpConfig {
	readonly serverName: string;
	readonly args: readonly string[];
}

/**
 * User의 기존 `crispy` server와 충돌하지 않는 session 전용 TOML bare key를 만든다.
 * random source 주입은 결정적인 test에서만 사용한다.
 */
export function createCodexMcpServerName(
	random: McpRandomBytes = randomBytes,
): string {
	const randomValue = random(CODEX_MCP_SERVER_NAME_RANDOM_BYTES);
	if (randomValue.byteLength !== CODEX_MCP_SERVER_NAME_RANDOM_BYTES) {
		throw new Error('Codex MCP server name generation failed.');
	}
	return `${CODEX_MCP_SERVER_NAME_PREFIX}${randomValue.toString('hex')}`;
}

/** Token을 포함하지 않는 Codex session-only MCP config argv를 직렬화한다. */
export function createCodexMcpConfig(
	connection: McpConnectionDescriptor,
	random?: McpRandomBytes,
	shellEnvironmentPolicyStyle: CodexShellEnvironmentPolicyStyle = 'keyed-filters',
): CodexMcpConfig {
	assertValidCodexMcpUrl(connection.url);
	const serverName = createCodexMcpServerName(random);
	const serverKey = `mcp_servers.${serverName}`;
	const assignments = [
		`${serverKey}.url=${serializeCodexTomlString(connection.url)}`,
		`${serverKey}.bearer_token_env_var=${serializeCodexTomlString(CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE)}`,
		`${serverKey}.required=false`,
		`${serverKey}.enabled_tools=[${serializeCodexTomlString(CRISPY_PING_TOOL_NAME)}]`,
		CODEX_SHELL_SNAPSHOT_DISABLED_ASSIGNMENT,
		createShellEnvironmentPolicyAssignment(shellEnvironmentPolicyStyle),
	];
	const args = Object.freeze(assignments.flatMap((assignment) => [
		CODEX_CONFIG_OVERRIDE_ARGUMENT,
		assignment,
	]));
	return Object.freeze({ serverName, args });
}

function createShellEnvironmentPolicyAssignment(
	style: CodexShellEnvironmentPolicyStyle,
): string {
	if (style === 'legacy-exclude') {
		return `shell_environment_policy.exclude=[${serializeCodexTomlString(CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE)}]`;
	}
	return `shell_environment_policy.filters.${CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE}=${serializeCodexTomlString('exclude')}`;
}

/**
 * Provider process가 상속하면 안 되는 Host/Electron control과 stale credential을
 * case-insensitive하게 제거한다. 입력 객체와 process.env는 변경하지 않는다.
 */
export function sanitizeCodexProviderEnvironment(
	baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(baseEnvironment)) {
		if (BLOCKED_CODEX_PROVIDER_ENVIRONMENT_NAMES.has(name.toUpperCase())) {
			continue;
		}
		environment[name] = value;
	}
	return environment;
}

/** auth.registered 뒤의 Host-only descriptor에서 provider env로 token을 한 번만 옮긴다. */
export function createCodexProviderEnvironment(
	connection: McpConnectionDescriptor,
	baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
	return connection.withBearerToken((token) => {
		const environment = sanitizeCodexProviderEnvironment(baseEnvironment);
		environment[CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE] = token;
		return Object.freeze(environment);
	});
}

/** Codex `--config key=value`의 TOML basic string에 필요한 좁은 serializer다. */
export function serializeCodexTomlString(value: string): string {
	let serialized = '"';
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				throw new Error('Codex config string is invalid.');
			}
			serialized += character + value[index + 1];
			index += 1;
			continue;
		}
		if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			throw new Error('Codex config string is invalid.');
		}
		switch (character) {
			case '"':
				serialized += '\\"';
				break;
			case '\\':
				serialized += '\\\\';
				break;
			case '\b':
				serialized += '\\b';
				break;
			case '\t':
				serialized += '\\t';
				break;
			case '\n':
				serialized += '\\n';
				break;
			case '\f':
				serialized += '\\f';
				break;
			case '\r':
				serialized += '\\r';
				break;
			default:
				serialized += codeUnit <= 0x1f || codeUnit === 0x7f
					? `\\u${codeUnit.toString(16).padStart(4, '0').toUpperCase()}`
					: character;
		}
	}
	return `${serialized}"`;
}

function assertValidCodexMcpUrl(value: string): void {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error('Codex MCP URL is invalid.');
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
		throw new Error('Codex MCP URL is invalid.');
	}
}
