import * as assert from 'node:assert/strict';
import { createPrepareCodexTerminalLaunch } from '../../mcp/codexTerminalLaunch';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
} from '../../agent/host/workspace/types';

const root = {
	scheme: 'file',
	fsPath: '/trusted/workspace' as ValidatedWorkspaceFsPath,
} as ValidatedWorkspaceRoot;

suite('Codex terminal launch preparation', () => {
	test('trusted cwd와 executable을 Shell resolution 없이 구조화해 반환한다', async () => {
		let workspaceCalls = 0;
		let executableCalls = 0;
		let configStyleCalls = 0;
		const prepare = createPrepareCodexTerminalLaunch({
			workspaceResolver: () => {
				workspaceCalls += 1;
				return { ok: true, root };
			},
			resolveExecutable: async (providerId, options) => {
				executableCalls += 1;
				assert.strictEqual(providerId, 'codex');
				assert.strictEqual(options?.override, '/opt/custom codex');
				return {
					ok: true,
					executable: {
						executable: '/opt/custom codex',
						launcherKind: 'direct',
					},
				};
			},
			readPlatform: () => 'linux',
			readEnvironment: () => ({ PATH: '/bin', TERM_PROGRAM: 'stale' }),
			getCliPath: () => '/opt/custom codex',
			resolveConfigStyle: async (options) => {
				configStyleCalls += 1;
				assert.strictEqual(options.executable.executable, '/opt/custom codex');
				return 'keyed-filters';
			},
		});

		const result = await prepare('tab-codex', 'session-codex');

		assert.strictEqual(result.ok, true);
		if (!result.ok) {
			return;
		}
		assert.strictEqual(workspaceCalls, 1);
		assert.strictEqual(executableCalls, 1);
		assert.strictEqual(configStyleCalls, 1);
		assert.deepStrictEqual(result.preparation.executable, {
			executable: '/opt/custom codex',
			launcherKind: 'direct',
		});
		assert.strictEqual(result.preparation.cwd, root.fsPath);
		assert.strictEqual(result.preparation.environment.TERM, 'xterm-256color');
		assert.strictEqual(result.preparation.environment.TERM_PROGRAM, undefined);
		assert.strictEqual(
			result.preparation.shellEnvironmentPolicyStyle,
			'keyed-filters',
		);
	});

	test('workspace failure는 executable probe 전에 기존 안전 오류로 반환한다', async () => {
		let executableCalls = 0;
		const prepare = createPrepareCodexTerminalLaunch({
			workspaceResolver: () => ({ ok: false, code: 'workspace_untrusted' }),
			resolveExecutable: async () => {
				executableCalls += 1;
				return { ok: false, reason: 'provider_unavailable' };
			},
			readPlatform: () => 'darwin',
			readEnvironment: () => ({}),
		});

		const result = await prepare('tab-codex', 'session-codex');

		assert.strictEqual(result.ok, false);
		assert.strictEqual(executableCalls, 0);
		if (!result.ok) {
			assert.strictEqual(result.error.code, 'workspace_untrusted');
		}
	});

	test('Windows 성공 path selection만 cache하고 실패는 다음 요청에서 재검사한다', async () => {
		let calls = 0;
		let available = false;
		const prepare = createPrepareCodexTerminalLaunch({
			workspaceResolver: () => ({ ok: true, root }),
			resolveExecutable: async () => {
				calls += 1;
				return available
					? {
						ok: true,
						executable: {
							executable: 'C:\\Tools\\codex.exe',
							launcherKind: 'direct',
						},
					}
					: { ok: false, reason: 'provider_unavailable' };
			},
			readPlatform: () => 'win32',
			readEnvironment: () => ({ PATH: 'C:\\Tools', PATHEXT: '.EXE;.CMD' }),
			resolveConfigStyle: async () => 'keyed-filters',
		});

		assert.strictEqual((await prepare('tab-one', 'session-one')).ok, false);
		available = true;
		assert.strictEqual((await prepare('tab-two', 'session-two')).ok, true);
		assert.strictEqual((await prepare('tab-three', 'session-three')).ok, true);
		assert.strictEqual(calls, 2);
	});

	test('version 확인 실패는 실행 준비를 막지 않고 MCP만 비활성화한다', async () => {
		const prepare = createPrepareCodexTerminalLaunch({
			workspaceResolver: () => ({ ok: true, root }),
			resolveExecutable: async () => ({
				ok: true,
				executable: {
					executable: '/opt/codex',
					launcherKind: 'direct',
				},
			}),
			readPlatform: () => 'linux',
			readEnvironment: () => ({ PATH: '/bin' }),
			resolveConfigStyle: async () => undefined,
		});

		const result = await prepare('tab-bare', 'session-bare');

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(
				result.preparation.shellEnvironmentPolicyStyle,
				undefined,
			);
		}
	});
});
