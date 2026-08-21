import * as assert from 'assert';
import {
	createAgentProcessEnvironment,
} from '../../mcp/agentLaunchPlan';
import {
	buildCodexBareLaunchPlan,
	buildCodexMcpLaunchPlan,
} from '../../mcp/codexLaunchPlan';
import { McpConnectionDescriptor } from '../../mcp/sessionRuntime';

const token = Buffer.alloc(32, 0x42).toString('base64url');
const route = Buffer.alloc(24, 0x24).toString('base64url');

suite('Codex AgentLaunchPlan builder', () => {
	test('bare plan에는 token, Electron control, MCP config가 존재하지 않는다', () => {
		const plan = buildCodexBareLaunchPlan({
			executable: { executable: '/opt/codex', launcherKind: 'direct' },
			cwd: '/workspace',
			args: ['--version'],
		});
		const environment = createAgentProcessEnvironment(plan, {
			CRISPY_MCP_TOKEN: 'stale-one',
			crispy_mcp_token: 'stale-two',
			ELECTRON_RUN_AS_NODE: '1',
			KEEP: 'yes',
		}, 'linux');

		assert.strictEqual(plan.providerId, 'codex');
		assert.strictEqual(plan.expectsMcp, false);
		assert.strictEqual(plan.mcpServerName, undefined);
		assert.deepStrictEqual(plan.envOverlay, {});
		assert.deepStrictEqual(environment, { KEEP: 'yes' });
		assert.strictEqual(JSON.stringify(plan).includes(token), false);
	});

	test('registered connection만 MCP config와 canonical token overlay를 만든다', () => {
		const connection = createConnection();
		const plan = buildCodexMcpLaunchPlan({
			executable: { executable: 'C:\\npm\\codex.cmd', launcherKind: 'cmd-one-shot' },
			cwd: 'C:\\workspace',
			connection,
			argsBeforeConfig: ['exec'],
			argsAfterConfig: ['ping'],
			randomBytes: (size) => Buffer.alloc(size, 0xab),
		});
		const environment = createAgentProcessEnvironment(plan, {
			crispy_mcp_token: 'stale',
			ELECTRON_RUN_AS_NODE: '1',
		}, 'win32');

		assert.strictEqual(plan.expectsMcp, true);
		assert.match(plan.mcpServerName ?? '', /^crispy_canvas_[a-f0-9]{32}$/);
		assert.strictEqual(plan.args[0], 'exec');
		assert.strictEqual(plan.args.at(-1), 'ping');
		assert.strictEqual(plan.args.some((argument) => argument.includes(token)), false);
		assert.strictEqual(JSON.stringify(plan).includes(token), false);
		assert.strictEqual(Object.keys(plan).includes('envOverlay'), false);
		assert.strictEqual(environment.CRISPY_MCP_TOKEN, token);
		assert.strictEqual(environment.crispy_mcp_token, undefined);
		assert.strictEqual(environment.ELECTRON_RUN_AS_NODE, undefined);
	});

	test('revoked connection으로 MCP plan을 만들 수 없다', () => {
		const connection = createConnection();
		connection.invalidate();
		assert.throws(
			() => buildCodexMcpLaunchPlan({
				executable: { executable: '/opt/codex', launcherKind: 'direct' },
				cwd: '/workspace',
				connection,
			}),
			/credential is no longer active/,
		);
	});

	test('plan 생성 뒤 revoke되면 final environment에서 credential을 다시 얻지 못한다', () => {
		const connection = createConnection();
		const plan = buildCodexMcpLaunchPlan({
			executable: { executable: '/opt/codex', launcherKind: 'direct' },
			cwd: '/workspace',
			connection,
		});
		connection.invalidate();

		assert.throws(
			() => createAgentProcessEnvironment(plan, {}, 'linux'),
			/credential is no longer active/,
		);
	});
});

function createConnection(): McpConnectionDescriptor {
	return new McpConnectionDescriptor(
		'generation-codex-plan',
		'session-codex-plan',
		`http://127.0.0.1:43123/mcp/${route}`,
		token,
	);
}
