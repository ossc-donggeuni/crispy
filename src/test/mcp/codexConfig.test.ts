import * as assert from 'assert';
import {
	CODEX_CONFIG_OVERRIDE_ARGUMENT,
	CODEX_MCP_SERVER_NAME_PREFIX,
	CODEX_MCP_SERVER_NAME_RANDOM_BYTES,
	CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE,
	CODEX_SHELL_SNAPSHOT_DISABLED_ASSIGNMENT,
	createCodexMcpConfig,
	createCodexMcpServerName,
	createCodexProviderEnvironment,
	sanitizeCodexProviderEnvironment,
} from '../../mcp/codexConfig';
import { McpConnectionDescriptor } from '../../mcp/sessionRuntime';
import { serializeCodexTomlString } from '../../mcp/codexConfig';
import { CRISPY_AGENT_ACTIVITY_INSTRUCTIONS } from '../../mcp/agentActivityInstructions';

const routeId = Buffer.alloc(24, 0x23).toString('base64url');
const bearerToken = Buffer.alloc(32, 0x45).toString('base64url');
const connectionUrl = `http://127.0.0.1:43123/mcp/${routeId}`;

suite('Codex MCP session config serializer', () => {
	test('unique server와 token 없는 structured override를 정확히 만든다', () => {
		const connection = createConnection();
		const config = createCodexMcpConfig(
			connection,
			(size) => Buffer.alloc(size, 0xab),
		);
		const expectedServerName = `${CODEX_MCP_SERVER_NAME_PREFIX}${'ab'.repeat(
			CODEX_MCP_SERVER_NAME_RANDOM_BYTES,
		)}`;

		assert.strictEqual(config.serverName, expectedServerName);
		assert.deepStrictEqual(config.args, [
			CODEX_CONFIG_OVERRIDE_ARGUMENT,
			`mcp_servers.${expectedServerName}.url="${connectionUrl}"`,
			CODEX_CONFIG_OVERRIDE_ARGUMENT,
			`mcp_servers.${expectedServerName}.bearer_token_env_var="${CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE}"`,
			CODEX_CONFIG_OVERRIDE_ARGUMENT,
			`mcp_servers.${expectedServerName}.required=false`,
			CODEX_CONFIG_OVERRIDE_ARGUMENT,
			`mcp_servers.${expectedServerName}.enabled_tools=["crispy_ping"]`,
			CODEX_CONFIG_OVERRIDE_ARGUMENT,
			CODEX_SHELL_SNAPSHOT_DISABLED_ASSIGNMENT,
			CODEX_CONFIG_OVERRIDE_ARGUMENT,
			`shell_environment_policy.filters.${CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE}="exclude"`,
		]);
		assert.strictEqual(config.serverName === 'crispy', false);
		assert.strictEqual(config.args.some((argument) => argument.includes(bearerToken)), false);
		assert.strictEqual(JSON.stringify(config).includes(bearerToken), false);
		assert.strictEqual(config.args.some((argument) => argument.includes(
			'shell_environment_policy.exclude',
		)), false);
		assert.strictEqual(config.args.some((argument) => argument.includes(
			'shell_environment_policy.include_only',
		)), false);
		assert.strictEqual(config.args.filter(
			(argument) => argument === CODEX_SHELL_SNAPSHOT_DISABLED_ASSIGNMENT,
		).length, 1);
		assert.strictEqual(hasDeveloperInstructionsOverride(config.args), false);
	});

	test('qualified gate serializes three tools and trusted graph instructions', () => {
		const config = createCodexMcpConfig(
			createConnection(),
			(size) => Buffer.alloc(size, 0xef),
			'keyed-filters',
			true,
		);

		assert.strictEqual(config.args.includes(
			`mcp_servers.${config.serverName}.enabled_tools=["crispy_ping","crispy_saa","crispy_caa"]`,
		), true);
		assert.strictEqual(hasDeveloperInstructionsOverride(config.args), true);
		assert.strictEqual(config.args.includes(
			`developer_instructions=${serializeCodexTomlString(
				CRISPY_AGENT_ACTIVITY_INSTRUCTIONS,
			)}`,
		), true);
		assert.strictEqual(config.args.filter(
			(argument) => argument.startsWith('developer_instructions='),
		).length, 1);
		assert.strictEqual(config.args.some((argument) => argument.includes(
			bearerToken,
		)), false);
	});

	test('Task lease gate는 completion/scope tool 세 개를 같은 session server에만 노출한다', () => {
		const config = createCodexMcpConfig(
			createConnection(),
			(size) => Buffer.alloc(size, 0xee),
			'keyed-filters',
			true,
			true,
		);

		assert.strictEqual(config.args.includes(
			`mcp_servers.${config.serverName}.enabled_tools=["crispy_ping","crispy_saa","crispy_caa","crispy_task_complete","crispy_task_scope_request","crispy_task_scope_result"]`,
		), true);
	});

	test('서로 다른 random source는 충돌하지 않는 TOML bare key를 만든다', () => {
		const first = createCodexMcpServerName(
			(size) => Buffer.alloc(size, 0x11),
		);
		const second = createCodexMcpServerName(
			(size) => Buffer.alloc(size, 0x22),
		);

		assert.notStrictEqual(first, second);
		assert.match(first, /^crispy_canvas_[a-f0-9]{32}$/);
		assert.match(second, /^crispy_canvas_[a-f0-9]{32}$/);
	});

	test('구버전 호환 모드는 같은 token을 legacy exclude array로만 직렬화한다', () => {
		const config = createCodexMcpConfig(
			createConnection(),
			(size) => Buffer.alloc(size, 0xcd),
			'legacy-exclude',
		);

		assert.strictEqual(config.args.includes(
			'shell_environment_policy.exclude=["CRISPY_MCP_TOKEN"]',
		), true);
		assert.strictEqual(config.args.some((argument) => argument.includes(
			'shell_environment_policy.filters',
		)), false);
		assert.strictEqual(
			config.args.includes(CODEX_SHELL_SNAPSHOT_DISABLED_ASSIGNMENT),
			true,
		);
	});

	test('random source byte 계약과 exact loopback session URL을 강제한다', () => {
		assert.throws(
			() => createCodexMcpServerName(() => Buffer.alloc(1)),
			(error: unknown) => error instanceof Error
				&& error.message === 'Codex MCP server name generation failed.',
		);
		for (const invalidUrl of [
			`https://127.0.0.1:43123/mcp/${routeId}`,
			`http://localhost:43123/mcp/${routeId}`,
			`http://127.0.0.1:43123/mcp/${routeId}?query=1`,
			'http://127.0.0.1:43123/mcp/not-a-valid-route',
		]) {
			const connection = new McpConnectionDescriptor(
				'generation-invalid-url',
				'session-invalid-url',
				invalidUrl,
				bearerToken,
			);
			assert.throws(
				() => createCodexMcpConfig(connection),
				(error: unknown) => error instanceof Error
					&& error.message === 'Codex MCP URL is invalid.'
					&& !error.message.includes(invalidUrl),
			);
		}
	});

	test('TOML basic string의 quote, slash, control과 Unicode를 결정적으로 처리한다', () => {
		assert.strictEqual(
			serializeCodexTomlString('quote" slash\\\b\t\n\f\r\u0001 한글😀'),
			'"quote\\" slash\\\\\\b\\t\\n\\f\\r\\u0001 한글😀"',
		);
		assert.throws(
			() => serializeCodexTomlString('\ud800'),
			(error: unknown) => error instanceof Error
				&& error.message === 'Codex config string is invalid.',
		);
	});
});

function hasDeveloperInstructionsOverride(args: readonly string[]): boolean {
	return args.some((argument) => argument.startsWith('developer_instructions='));
}

suite('Codex provider environment', () => {
	test('stale credential과 Electron control 변형을 제거하고 입력을 보존한다', () => {
		const baseEnvironment: NodeJS.ProcessEnv = {
			CRISPY_MCP_TOKEN: 'stale-one',
			crispy_mcp_token: 'stale-two',
			CrIsPy_McP_ToKeN: 'stale-three',
			ELECTRON_RUN_AS_NODE: '1',
			electron_run_as_node: '1',
			KEEP_ME: 'preserved',
		};
		const originalEntries = Object.entries(baseEnvironment);
		const sanitized = sanitizeCodexProviderEnvironment(baseEnvironment);

		assert.strictEqual(sanitized.KEEP_ME, 'preserved');
		assert.strictEqual(Object.keys(sanitized).some(
			(name) => name.toUpperCase() === CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE,
		), false);
		assert.strictEqual(Object.keys(sanitized).some(
			(name) => name.toUpperCase() === 'ELECTRON_RUN_AS_NODE',
		), false);
		assert.deepStrictEqual(Object.entries(baseEnvironment), originalEntries);
	});

	test('auth 등록 descriptor에서 canonical token을 provider env에 한 번만 넣는다', () => {
		const connection = createConnection();
		const baseEnvironment: NodeJS.ProcessEnv = {
			crispy_mcp_token: 'stale',
			Electron_Run_As_Node: '1',
			PATH: '/safe/bin',
		};
		const environment = createCodexProviderEnvironment(
			connection,
			baseEnvironment,
		);
		const tokenNames = Object.keys(environment).filter(
			(name) => name.toUpperCase() === CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE,
		);

		assert.deepStrictEqual(tokenNames, [CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE]);
		assert.strictEqual(
			environment[CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE],
			bearerToken,
		);
		assert.strictEqual(environment.PATH, '/safe/bin');
		assert.strictEqual(baseEnvironment.crispy_mcp_token, 'stale');
		assert.strictEqual(baseEnvironment.Electron_Run_As_Node, '1');
	});

	test('revoke된 descriptor는 token getter를 우회하지 않고 안전하게 실패한다', () => {
		const connection = createConnection();
		connection.invalidate();

		assert.throws(
			() => createCodexProviderEnvironment(connection, {}),
			(error: unknown) => error instanceof Error
				&& error.message === 'MCP connection credential is no longer active.'
				&& !error.message.includes(bearerToken),
		);
	});

	test('process.env를 base로 사용해도 Host environment를 mutate하지 않는다', () => {
		const connection = createConnection();
		const tokenBefore = process.env[CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE];
		const electronBefore = process.env.ELECTRON_RUN_AS_NODE;
		const environment = createCodexProviderEnvironment(connection, process.env);

		assert.strictEqual(
			environment[CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE],
			bearerToken,
		);
		assert.strictEqual(
			process.env[CODEX_MCP_TOKEN_ENVIRONMENT_VARIABLE],
			tokenBefore,
		);
		assert.strictEqual(process.env.ELECTRON_RUN_AS_NODE, electronBefore);
	});
});

function createConnection(): McpConnectionDescriptor {
	return new McpConnectionDescriptor(
		'generation-codex-config',
		'session-codex-config',
		connectionUrl,
		bearerToken,
	);
}
