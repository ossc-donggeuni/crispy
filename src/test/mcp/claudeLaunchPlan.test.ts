import * as assert from 'node:assert/strict';
import { createAgentProcessEnvironment } from '../../mcp/agentLaunchPlan';
import {
	buildClaudeBareLaunchPlan,
	buildClaudeMcpLaunchPlan,
} from '../../mcp/claudeLaunchPlan';
import { McpConnectionDescriptor } from '../../mcp/sessionRuntime';
import { CRISPY_AGENT_ACTIVITY_INSTRUCTIONS } from '../../mcp/agentActivityInstructions';

const token = Buffer.alloc(32, 0x42).toString('base64url');
const route = Buffer.alloc(24, 0x24).toString('base64url');

suite('Claude AgentLaunchPlan builder', () => {
	test('bare plan에는 token, Electron control, MCP config가 없다', () => {
		const plan = buildClaudeBareLaunchPlan({
			executable: { executable: '/opt/claude', launcherKind: 'direct' },
			cwd: '/workspace',
			args: ['--version'],
		});
		const environment = createAgentProcessEnvironment(plan, {
			CRISPY_MCP_TOKEN: 'stale-one',
			crispy_mcp_token: 'stale-two',
			ELECTRON_RUN_AS_NODE: '1',
			KEEP: 'yes',
		}, 'linux');

		assert.strictEqual(plan.providerId, 'claude');
		assert.strictEqual(plan.expectsMcp, false);
		assert.strictEqual(plan.mcpServerName, undefined);
		assert.deepStrictEqual(plan.envOverlay, {});
		assert.deepStrictEqual(environment, { KEEP: 'yes' });
	});

	test('registered connection만 공통 Activity prompt와 placeholder token env를 만든다', () => {
		const plan = buildClaudeMcpLaunchPlan({
			executable: {
				executable: 'C:\\npm\\claude.cmd',
				launcherKind: 'cmd-one-shot',
			},
			cwd: 'C:\\workspace',
			connection: createConnection(),
			createArgs: (serverName) => ['-p', `call mcp__${serverName}__crispy_ping`],
			randomBytes: (size) => Buffer.alloc(size, 0xab),
			agentActivityCompatible: true,
		});
		const environment = createAgentProcessEnvironment(plan, {
			crispy_mcp_token: 'stale',
			ELECTRON_RUN_AS_NODE: '1',
		}, 'win32');
		const configIndex = plan.args.indexOf('--mcp-config');

		assert.strictEqual(plan.providerId, 'claude');
		assert.strictEqual(plan.expectsMcp, true);
		assert.match(plan.mcpServerName ?? '', /^crispy_canvas_[a-f0-9]{32}$/u);
		assert.strictEqual(plan.args.includes('--append-system-prompt'), true);
		assert.deepStrictEqual(plan.args.slice(0, 2), [
			'-p',
			`call mcp__${plan.mcpServerName}__crispy_ping`,
		]);
		assert.deepStrictEqual(plan.args.slice(2, 4), [
			'--append-system-prompt',
			CRISPY_AGENT_ACTIVITY_INSTRUCTIONS,
		]);
		assert.strictEqual(configIndex, plan.args.length - 2);
		assert.strictEqual(plan.args.some((argument) => argument.includes(token)), false);
		assert.strictEqual(plan.args[configIndex + 1].includes(
			'Bearer ${CRISPY_MCP_TOKEN}',
		), true);
		assert.strictEqual(JSON.stringify(plan).includes(token), false);
		assert.strictEqual(Object.keys(plan).includes('envOverlay'), false);
		assert.strictEqual(environment.CRISPY_MCP_TOKEN, token);
		assert.strictEqual(environment.crispy_mcp_token, undefined);
		assert.strictEqual(environment.ELECTRON_RUN_AS_NODE, undefined);
	});

	test('static args와 server-name args factory를 함께 받지 않는다', () => {
		assert.throws(
			() => buildClaudeMcpLaunchPlan({
				executable: { executable: '/opt/claude', launcherKind: 'direct' },
				cwd: '/workspace',
				connection: createConnection(),
				args: ['-p'],
				createArgs: () => ['-p', 'prompt'],
			}),
			/launch arguments are invalid/,
		);
	});

	test('revoked descriptor는 build와 final environment 양쪽에서 거부된다', () => {
		const revoked = createConnection();
		revoked.invalidate();
		assert.throws(
			() => buildClaudeMcpLaunchPlan({
				executable: { executable: '/opt/claude', launcherKind: 'direct' },
				cwd: '/workspace',
				connection: revoked,
			}),
			/credential is no longer active/,
		);

		const active = createConnection();
		const plan = buildClaudeMcpLaunchPlan({
			executable: { executable: '/opt/claude', launcherKind: 'direct' },
			cwd: '/workspace',
			connection: active,
		});
		active.invalidate();
		assert.throws(
			() => createAgentProcessEnvironment(plan, {}, 'linux'),
			/credential is no longer active/,
		);
	});
});

function createConnection(): McpConnectionDescriptor {
	return new McpConnectionDescriptor(
		'generation-claude-plan',
		'session-claude-plan',
		`http://127.0.0.1:43123/mcp/${route}`,
		token,
	);
}
