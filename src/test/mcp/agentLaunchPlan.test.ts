import * as assert from 'assert';
import {
	createAgentProcessEnvironment,
	createAgentProcessSpawnOptions,
	createAgentProcessSpawnRequest,
	type AgentLaunchPlan,
} from '../../mcp/agentLaunchPlan';

suite('Agent launch plan process boundary', () => {
	test('final sanitizer가 stale token casing과 Electron control을 제거한 뒤 overlay만 넣는다', () => {
		const plan = createPlan({
			envOverlay: { CRISPY_MCP_TOKEN: 'fresh-token', KEEP: 'overlay' },
		});
		const base: NodeJS.ProcessEnv = {
			CRISPY_MCP_TOKEN: 'stale-one',
			crispy_mcp_token: 'stale-two',
			Electron_Run_As_Node: '1',
			KEEP: 'base',
			UNDEFINED_VALUE: undefined,
		};
		const before = { ...base };
		const environment = createAgentProcessEnvironment(plan, base, 'linux');

		assert.deepStrictEqual(environment, {
			CRISPY_MCP_TOKEN: 'fresh-token',
			KEEP: 'overlay',
		});
		assert.deepStrictEqual(base, before);
		assert.strictEqual(Object.isFrozen(environment), true);
	});

	test('direct plan은 executable, argv, cwd와 concrete env를 그대로 보존한다', () => {
		const plan = createPlan();
		const request = createAgentProcessSpawnRequest(plan, {
			platform: 'darwin',
			environment: { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' },
		});
		const options = createAgentProcessSpawnOptions(request);

		assert.deepStrictEqual(request, {
			executable: '/opt/codex',
			args: ['--version'],
			cwd: '/workspace',
			environment: { PATH: '/bin' },
			windowsVerbatimArguments: false,
		});
		assert.strictEqual(options.shell, false);
		assert.strictEqual(options.windowsVerbatimArguments, false);
	});

	test('Windows cmd shim은 ComSpec /d /s /v:off /c one-shot으로만 실행한다', () => {
		const plan = createPlan({
			executable: 'C:\\Program Files\\100% (한글)! & Codex\\codex.cmd',
			args: ['exec', 'value="quoted"', 'space value'],
			launcherKind: 'cmd-one-shot',
		});
		const request = createAgentProcessSpawnRequest(plan, {
			platform: 'win32',
			environment: {
				ComSpec: 'C:\\Windows\\System32\\cmd.exe',
				PATH: 'C:\\safe',
			},
		});

		assert.strictEqual(request.executable, 'C:\\Windows\\System32\\cmd.exe');
		assert.deepStrictEqual(request.args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
		assert.match(request.args[4], /codex\.cmd/);
		assert.doesNotMatch(request.args[4], /(^|[^\^])&/);
		assert.strictEqual(request.windowsVerbatimArguments, true);
		assert.strictEqual(request.environment.ComSpec, 'C:\\Windows\\System32\\cmd.exe');
	});

	test('cmd-one-shot은 Windows와 검증된 ComSpec 없이는 생성되지 않는다', () => {
		const plan = createPlan({ launcherKind: 'cmd-one-shot' });
		assert.throws(
			() => createAgentProcessSpawnRequest(plan, {
				platform: 'linux',
				environment: {},
			}),
			/unsupported/,
		);
		assert.throws(
			() => createAgentProcessSpawnRequest(plan, {
				platform: 'win32',
				environment: {},
			}),
			/command processor is unavailable/,
		);
	});
});

function createPlan(overrides: Partial<AgentLaunchPlan> = {}): AgentLaunchPlan {
	return {
		providerId: 'codex',
		executable: '/opt/codex',
		args: ['--version'],
		cwd: '/workspace',
		envOverlay: {},
		envRemove: ['CRISPY_MCP_TOKEN', 'ELECTRON_RUN_AS_NODE'],
		launcherKind: 'direct',
		expectsMcp: false,
		...overrides,
	};
}
