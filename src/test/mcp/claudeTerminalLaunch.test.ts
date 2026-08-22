import * as assert from 'node:assert/strict';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
} from '../../agent/host/workspace/types';
import { createPrepareClaudeTerminalLaunch } from '../../mcp/claudeTerminalLaunch';

const root = {
	scheme: 'file',
	fsPath: '/trusted/workspace' as ValidatedWorkspaceFsPath,
} as ValidatedWorkspaceRoot;

suite('Claude terminal launch preparation', () => {
	test('resolved executable 뒤 bounded compatibility 결과를 구조화한다', async () => {
		let compatibilityCalls = 0;
		const prepare = createPrepareClaudeTerminalLaunch({
			workspaceResolver: () => ({ ok: true, root }),
			resolveExecutable: async (providerId, options) => {
				assert.strictEqual(providerId, 'claude');
				assert.strictEqual(options?.override, '/opt/custom claude');
				return {
					ok: true,
					executable: {
						executable: '/opt/custom claude',
						launcherKind: 'direct',
					},
				};
			},
			readPlatform: () => 'linux',
			readEnvironment: () => ({ PATH: '/bin', TERM_PROGRAM: 'stale' }),
			getCliPath: () => '/opt/custom claude',
			resolveCompatibility: async (options) => {
				compatibilityCalls += 1;
				assert.strictEqual(options.executable.executable, '/opt/custom claude');
				return {
					version: { major: 2, minor: 1, patch: 121 },
					compatible: true,
				};
			},
		});

		const result = await prepare('tab-claude', 'session-claude');

		assert.strictEqual(result.ok, true);
		if (!result.ok) {
			return;
		}
		assert.strictEqual(compatibilityCalls, 1);
		assert.deepStrictEqual(result.preparation.executable, {
			executable: '/opt/custom claude',
			launcherKind: 'direct',
		});
		assert.strictEqual(result.preparation.cwd, root.fsPath);
		assert.strictEqual(result.preparation.environment.TERM, 'xterm-256color');
		assert.strictEqual(result.preparation.environment.TERM_PROGRAM, undefined);
		assert.strictEqual(result.preparation.mcpCompatible, true);
	});

	test('probe failure와 minimum 미만은 executable을 보존하고 MCP만 비활성화한다', async () => {
		for (const compatibility of [
			undefined,
			{
				version: { major: 2, minor: 1, patch: 120 },
				compatible: false,
			},
		]) {
			const prepare = createPrepareClaudeTerminalLaunch({
				workspaceResolver: () => ({ ok: true, root }),
				resolveExecutable: async () => ({
					ok: true,
					executable: {
						executable: '/opt/claude',
						launcherKind: 'direct',
					},
				}),
				readPlatform: () => 'linux',
				readEnvironment: () => ({ PATH: '/bin' }),
				resolveCompatibility: async () => compatibility,
			});

			const result = await prepare('tab-bare', 'session-bare');
			assert.strictEqual(result.ok, true);
			if (result.ok) {
				assert.strictEqual(result.preparation.mcpCompatible, false);
				assert.strictEqual(result.preparation.executable.executable, '/opt/claude');
			}
		}
	});

	test('workspace/executable failure는 compatibility probe 전에 안전 오류로 반환한다', async () => {
		let compatibilityCalls = 0;
		const prepare = createPrepareClaudeTerminalLaunch({
			workspaceResolver: () => ({ ok: false, code: 'workspace_untrusted' }),
			resolveExecutable: async () => ({
				ok: false,
				reason: 'provider_unavailable',
			}),
			readPlatform: () => 'darwin',
			readEnvironment: () => ({}),
			resolveCompatibility: async () => {
				compatibilityCalls += 1;
				return undefined;
			},
		});

		const result = await prepare('tab-claude', 'session-claude');

		assert.strictEqual(result.ok, false);
		assert.strictEqual(compatibilityCalls, 0);
		if (!result.ok) {
			assert.strictEqual(result.error.code, 'workspace_untrusted');
		}
	});

	test('Windows 성공 executable selection만 cache한다', async () => {
		let calls = 0;
		let available = false;
		const prepare = createPrepareClaudeTerminalLaunch({
			workspaceResolver: () => ({ ok: true, root }),
			resolveExecutable: async () => {
				calls += 1;
				return available
					? {
						ok: true,
						executable: {
							executable: 'C:\\Tools\\claude.exe',
							launcherKind: 'direct',
						},
					}
					: { ok: false, reason: 'provider_unavailable' };
			},
			readPlatform: () => 'win32',
			readEnvironment: () => ({ PATH: 'C:\\Tools', PATHEXT: '.EXE;.CMD' }),
			resolveCompatibility: async () => ({
				version: { major: 2, minor: 1, patch: 121 },
				compatible: true,
			}),
		});

		assert.strictEqual((await prepare('tab-one', 'session-one')).ok, false);
		available = true;
		assert.strictEqual((await prepare('tab-two', 'session-two')).ok, true);
		assert.strictEqual((await prepare('tab-three', 'session-three')).ok, true);
		assert.strictEqual(calls, 2);
	});
});
