import * as assert from 'assert';
import {
	resolveDarwinShellLaunchPolicy,
	resolveLinuxShellLaunchPolicy,
} from '../../agent/host/shell/posixShellResolver';
import { resolveWindowsShellLaunchPolicy } from '../../agent/host/shell/windowsShellResolver';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
} from '../../agent/host/workspace/types';

const workspaceFsPath = 'C:\\validated\\workspace' as ValidatedWorkspaceFsPath;
const workspaceRoot = {
	scheme: 'file',
	fsPath: workspaceFsPath,
} as ValidatedWorkspaceRoot;

suite('Windows Shell resolver', () => {
	test('SystemRoot에서 Windows PowerShell 5.1 경로를 정확히 구성한다', () => {
		const result = resolveWindowsShellLaunchPolicy({
			SystemRoot: 'C:\\Windows',
		}, workspaceRoot);

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(
				result.policy.executable,
				'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			);
			assert.strictEqual(result.policy.cwd, workspaceRoot.fsPath);
		}
	});

	test('현재 OS와 무관하게 Windows 구분자로 경로를 결합한다', () => {
		const result = resolveWindowsShellLaunchPolicy({
			SystemRoot: 'D:/AlternateWindows/',
		}, workspaceRoot);

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(
				result.policy.executable,
				'D:\\AlternateWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			);
			assert.strictEqual(result.policy.executable.includes('/'), false);
		}
	});

	test('args는 항상 빈 배열이다', () => {
		const result = resolveWindowsShellLaunchPolicy({
			SystemRoot: 'C:\\Windows',
		}, workspaceRoot);

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.deepStrictEqual(result.policy.args, []);
		}
	});

	test('SystemRoot 누락과 빈 문자열을 typed failure로 반환한다', () => {
		for (const env of [
			{},
			{ SystemRoot: '' },
		] satisfies readonly NodeJS.ProcessEnv[]) {
			assert.deepStrictEqual(
				resolveWindowsShellLaunchPolicy(env, workspaceRoot),
				{
					ok: false,
					error: { code: 'shell_environment_missing' },
				},
			);
		}
	});

	test('PATH, pwsh, WSL, cmd.exe 또는 ComSpec으로 fallback하지 않는다', () => {
		const fallbackOnlyEnv: NodeJS.ProcessEnv = {
			PATH: 'C:\\PowerShell7;C:\\Windows\\System32',
			ComSpec: 'C:\\Windows\\System32\\cmd.exe',
			SHELL: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
			WSL_DISTRO_NAME: 'Ubuntu',
		};
		assert.deepStrictEqual(
			resolveWindowsShellLaunchPolicy(fallbackOnlyEnv, workspaceRoot),
			{
				ok: false,
				error: { code: 'shell_environment_missing' },
			},
		);

		const result = resolveWindowsShellLaunchPolicy({
			...fallbackOnlyEnv,
			SystemRoot: 'Z:\\NotInstalledWindows',
		}, workspaceRoot);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(
				result.policy.executable,
				'Z:\\NotInstalledWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
			);
			assert.strictEqual(result.policy.executable.includes('pwsh.exe'), false);
			assert.strictEqual(result.policy.executable.includes('cmd.exe'), false);
			assert.strictEqual(result.policy.executable.includes('wsl.exe'), false);
		}
	});

	test('입력 env 객체를 변경하지 않고 Host 환경 snapshot을 반환한다', () => {
		const env: NodeJS.ProcessEnv = {
			SystemRoot: 'C:\\Windows',
			PATH: 'C:\\host\\controlled\\path',
			CRISPY_TEST_VALUE: 'preserved',
		};
		const before = { ...env };
		const result = resolveWindowsShellLaunchPolicy(env, workspaceRoot);

		assert.deepStrictEqual(env, before);
		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.deepStrictEqual(result.policy.env, before);
			assert.notStrictEqual(result.policy.env, env);
		}
	});

	test('Windows와 macOS/Linux 환경 선택 로직을 서로 섞지 않는다', () => {
		const windowsOnlyEnv = { SystemRoot: 'C:\\Windows' };
		assert.strictEqual(
			resolveDarwinShellLaunchPolicy(windowsOnlyEnv, workspaceRoot).ok,
			false,
		);
		assert.strictEqual(
			resolveLinuxShellLaunchPolicy(windowsOnlyEnv, workspaceRoot).ok,
			false,
		);

		const posixOnlyEnv = { SHELL: '/bin/zsh' };
		assert.strictEqual(
			resolveWindowsShellLaunchPolicy(posixOnlyEnv, workspaceRoot).ok,
			false,
		);
	});
});
