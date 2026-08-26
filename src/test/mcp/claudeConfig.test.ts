import * as assert from 'node:assert/strict';
import {
	CLAUDE_APPEND_SYSTEM_PROMPT_ARGUMENT,
	CLAUDE_MCP_CONFIG_ARGUMENT,
	CLAUDE_MCP_SERVER_NAME_PREFIX,
	CLAUDE_MCP_SERVER_NAME_RANDOM_BYTES,
	CLAUDE_MCP_TOKEN_PLACEHOLDER,
	createClaudeMcpConfig,
	createClaudeMcpServerName,
} from '../../mcp/claudeConfig';
import {
	CRISPY_AGENT_ACTIVITY_INSTRUCTIONS,
	CRISPY_PING_ONLY_INSTRUCTIONS,
} from '../../mcp/agentActivityInstructions';
import {
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
} from '../../mcp/toolNames';
import { McpConnectionDescriptor } from '../../mcp/sessionRuntime';

const routeId = Buffer.alloc(24, 0x23).toString('base64url');
const bearerToken = Buffer.alloc(32, 0x45).toString('base64url');
const connectionUrl = `http://127.0.0.1:43123/mcp/${routeId}`;

suite('Claude MCP session config serializer', () => {
	test('token-free inline HTTP config를 exact provider shape로 만든다', () => {
		const config = createClaudeMcpConfig(
			createConnection(),
			(size) => Buffer.alloc(size, 0xab),
		);
		const expectedName = `${CLAUDE_MCP_SERVER_NAME_PREFIX}${'ab'.repeat(
			CLAUDE_MCP_SERVER_NAME_RANDOM_BYTES,
		)}`;
		const parsed = JSON.parse(config.inlineConfig) as {
			readonly mcpServers: Readonly<Record<string, {
				readonly type: string;
				readonly url: string;
				readonly headers: Readonly<Record<string, string>>;
				readonly alwaysLoad: boolean;
			}>>;
		};

		assert.strictEqual(config.serverName, expectedName);
		assert.deepStrictEqual(config.args, [
			CLAUDE_APPEND_SYSTEM_PROMPT_ARGUMENT,
			CRISPY_PING_ONLY_INSTRUCTIONS,
			CLAUDE_MCP_CONFIG_ARGUMENT,
			config.inlineConfig,
		]);
		assert.deepStrictEqual(parsed, {
			mcpServers: {
				[expectedName]: {
					type: 'http',
					url: connectionUrl,
					headers: {
						Authorization: `Bearer ${CLAUDE_MCP_TOKEN_PLACEHOLDER}`,
					},
					alwaysLoad: true,
				},
			},
		});
		assert.strictEqual(config.inlineConfig.includes(bearerToken), false);
		assert.strictEqual(config.serverName === 'crispy', false);
	});

	test('qualified gate appends the shared cross-agent contract once', () => {
		const config = createClaudeMcpConfig(
			createConnection(),
			(size) => Buffer.alloc(size, 0xcd),
			true,
		);

		assert.deepStrictEqual(config.args, [
			CLAUDE_APPEND_SYSTEM_PROMPT_ARGUMENT,
			CRISPY_AGENT_ACTIVITY_INSTRUCTIONS,
			CLAUDE_MCP_CONFIG_ARGUMENT,
			config.inlineConfig,
		]);
		assert.strictEqual(config.inlineConfig.includes('alwaysLoad'), true);
		assert.strictEqual(config.inlineConfig.includes(bearerToken), false);
		assert.strictEqual(config.args.includes('--append-system-prompt'), true);
		assert.strictEqual(config.args.filter(
			(argument) => argument === CRISPY_AGENT_ACTIVITY_INSTRUCTIONS,
		).length, 1);
		assert.strictEqual(config.args[1].includes('completion anchor'), true);
	});

	test('strict, cache, global tool restriction을 config나 argv에 주입하지 않는다', () => {
		const config = createClaudeMcpConfig(createConnection());
		const serialized = JSON.stringify(config);
		for (const forbidden of [
			'--strict-mcp-config',
			'--tools',
			'--allowedTools',
			'--disallowedTools',
			'MCP_DISCOVERY_CACHE',
			'ENABLE_TOOL_SEARCH',
			'MCP_CONNECTION_NONBLOCKING',
		]) {
			assert.strictEqual(serialized.includes(forbidden), false);
		}
	});

	test('fully-qualified activity Tool names stay within Claude 64-char limit', () => {
		const serverName = createClaudeMcpServerName(
			(size) => Buffer.alloc(size, 0xee),
		);
		for (const toolName of [
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
		]) {
			const qualified = `mcp__${serverName}__${toolName}`;
			assert.ok(qualified.length <= 64, qualified);
		}
	});

	test('server name random contract와 exact loopback URL을 강제한다', () => {
		assert.throws(
			() => createClaudeMcpServerName(() => Buffer.alloc(1)),
			/Claude MCP server name generation failed/,
		);
		for (const invalidUrl of [
			`https://127.0.0.1:43123/mcp/${routeId}`,
			`http://localhost:43123/mcp/${routeId}`,
			`http://127.0.0.1:43123/mcp/${routeId}/`,
			`http://127.0.0.1:43123/mcp/${routeId}?query=1`,
			'http://127.0.0.1:43123/mcp/not-a-valid-route',
		]) {
			assert.throws(
				() => createClaudeMcpConfig(new McpConnectionDescriptor(
					'generation-invalid-claude-url',
					'session-invalid-claude-url',
					invalidUrl,
					bearerToken,
				)),
				(error: unknown) => error instanceof Error
					&& error.message === 'Claude MCP URL is invalid.'
					&& !error.message.includes(invalidUrl),
			);
		}
	});
});

function createConnection(): McpConnectionDescriptor {
	return new McpConnectionDescriptor(
		'generation-claude-config',
		'session-claude-config',
		connectionUrl,
		bearerToken,
	);
}
