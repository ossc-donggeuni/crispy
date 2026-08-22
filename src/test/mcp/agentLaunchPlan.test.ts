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
			expectsMcp: true,
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

	test('bare plan은 overlay가 잘못 들어와도 credential과 Electron control을 거부한다', () => {
		const plan = createPlan({
			envOverlay: {
				crispy_mcp_token: 'must-not-survive',
				ELECTRON_RUN_AS_NODE: '1',
				SAFE: 'yes',
			},
			envRemove: [],
			expectsMcp: false,
		});

		assert.deepStrictEqual(createAgentProcessEnvironment(plan, {
			CrIsPy_McP_ToKeN: 'stale',
			Electron_Run_As_Node: '1',
		}, 'darwin'), { SAFE: 'yes' });
	});

	test('일반 overlay 이름은 POSIX에서 case-sensitive이고 Windows에서만 case-insensitive다', () => {
		const plan = createPlan({ envOverlay: { PATH: '/overlay' } });
		const base = {
			PATH: '/uppercase',
			Path: '/mixed',
			path: '/lowercase',
		};

		assert.deepStrictEqual(createAgentProcessEnvironment(plan, base, 'linux'), {
			PATH: '/overlay',
			Path: '/mixed',
			path: '/lowercase',
		});
		assert.deepStrictEqual(createAgentProcessEnvironment(plan, base, 'win32'), {
			PATH: '/overlay',
		});
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
			executable: 'C:\\Program Files\\%CRISPY_FIXTURE% 100% (한글)! & Codex\\codex.cmd',
			args: ['exec', 'value="quoted"', 'space value', '%CRISPY_FIXTURE%'],
			launcherKind: 'cmd-one-shot',
		});
		const request = createAgentProcessSpawnRequest(plan, {
			platform: 'win32',
			environment: {
				ComSpec: 'C:\\Windows\\System32\\cmd.exe',
				PATH: 'C:\\safe',
				CRISPY_FIXTURE: 'EXPANDED',
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
