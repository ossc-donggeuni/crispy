import * as assert from 'assert';
import { resolveShellLaunchPolicy } from '../../agent/host/shell/shellResolver';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
} from '../../agent/host/workspace/types';

const posixWorkspaceRoot = {
	scheme: 'file',
	fsPath: '/validated/workspace' as ValidatedWorkspaceFsPath,
} as ValidatedWorkspaceRoot;

const windowsWorkspaceRoot = {
	scheme: 'file',
	fsPath: 'C:\\validated\\workspace' as ValidatedWorkspaceFsPath,
} as ValidatedWorkspaceRoot;

suite('Host Shell resolver dispatcher', () => {
	for (const platform of ['darwin', 'linux'] as const) {
		test(`${platform}을 POSIX resolver로 전달한다`, () => {
			const result = resolveShellLaunchPolicy(platform, {
				SHELL: '/host/selected/shell',
				SystemRoot: 'C:\\must-not-be-used',
			}, posixWorkspaceRoot);

			assert.strictEqual(result.ok, true);
			if (result.ok) {
				assert.strictEqual(result.policy.executable, '/host/selected/shell');
				assert.strictEqual(result.policy.cwd, posixWorkspaceRoot.fsPath);
				assert.deepStrictEqual(result.policy.args, []);
			}
		});
	}

	test('win32를 Windows resolver로 전달한다', () => {
		const result = resolveShellLaunchPolicy('win32', {
			SystemRoot: 'C:\\Windows',
			SHELL: '/must/not/be/used',
		}, windowsWorkspaceRoot);

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(
				result.policy.executable,
				'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			);
			assert.strictEqual(result.policy.cwd, windowsWorkspaceRoot.fsPath);
			assert.deepStrictEqual(result.policy.args, []);
		}
	});

	test('지원하지 않는 플랫폼은 세부 입력을 반사하지 않는 typed failure다', () => {
		const secret = '/private/shell/path-should-not-leak';
		const result = resolveShellLaunchPolicy('freebsd', {
			SHELL: secret,
			SystemRoot: secret,
		}, posixWorkspaceRoot);

		assert.deepStrictEqual(result, {
			ok: false,
			error: { code: 'unsupported_platform' },
		});
		assert.strictEqual(JSON.stringify(result).includes(secret), false);
	});
});
