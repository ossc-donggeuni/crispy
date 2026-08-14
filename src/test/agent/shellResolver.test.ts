import * as assert from 'assert';
import {
	createShellLaunchPolicyResolver,
} from '../../agent/host/shell/shellResolver';
import type {
	ShellFilesystemAdapter,
	ShellFilesystemEntry,
} from '../../agent/host/shell/shellFilesystem';
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

class FakeShellFilesystem implements ShellFilesystemAdapter {
	readonly statCalls: string[] = [];
	readonly executePermissionCalls: string[] = [];
	statResult: ShellFilesystemEntry = { isFile: true };
	statError: unknown;
	executePermissionError: unknown;

	async stat(path: string): Promise<ShellFilesystemEntry> {
		this.statCalls.push(path);
		if (this.statError) {
			throw this.statError;
		}
		return this.statResult;
	}

	async checkExecutePermission(path: string): Promise<void> {
		this.executePermissionCalls.push(path);
		if (this.executePermissionError) {
			throw this.executePermissionError;
		}
	}
}

function filesystemError(code: string): NodeJS.ErrnoException {
	const error = new Error('filesystem details must not be exposed') as
		NodeJS.ErrnoException;
	error.code = code;
	return error;
}

suite('Host Shell resolver integration', () => {
	for (const platform of ['darwin', 'linux'] as const) {
		test(`${platform} 후보를 POSIX resolver에서 선택한 뒤 검증한다`, async () => {
			const filesystem = new FakeShellFilesystem();
			const resolveShellLaunchPolicy =
				createShellLaunchPolicyResolver(filesystem);
			const result = await resolveShellLaunchPolicy(platform, {
				SHELL: '/host/selected/shell',
				SystemRoot: 'C:\\must-not-be-used',
			}, posixWorkspaceRoot);

			assert.strictEqual(result.ok, true);
			if (result.ok) {
				assert.strictEqual(result.policy.executable, '/host/selected/shell');
				assert.strictEqual(result.policy.cwd, posixWorkspaceRoot.fsPath);
			}
			assert.deepStrictEqual(filesystem.statCalls, ['/host/selected/shell']);
			assert.deepStrictEqual(
				filesystem.executePermissionCalls,
				['/host/selected/shell'],
			);
		});
	}

	test('win32 후보를 Windows resolver에서 선택한 뒤 검증한다', async () => {
		const filesystem = new FakeShellFilesystem();
		const resolveShellLaunchPolicy =
			createShellLaunchPolicyResolver(filesystem);
		const executable =
			'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
		const result = await resolveShellLaunchPolicy('win32', {
			SystemRoot: 'C:\\Windows',
			SHELL: '/must/not/be/used',
		}, windowsWorkspaceRoot);

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.policy.executable, executable);
			assert.strictEqual(result.policy.cwd, windowsWorkspaceRoot.fsPath);
		}
		assert.deepStrictEqual(filesystem.statCalls, [executable]);
		assert.deepStrictEqual(filesystem.executePermissionCalls, []);
	});

	test('지원하지 않는 플랫폼은 filesystem 접근 없이 거부한다', async () => {
		const filesystem = new FakeShellFilesystem();
		const resolveShellLaunchPolicy =
			createShellLaunchPolicyResolver(filesystem);
		const secret = '/private/shell/path-should-not-leak';
		const result = await resolveShellLaunchPolicy('freebsd', {
			SHELL: secret,
			SystemRoot: secret,
		}, posixWorkspaceRoot);

		assert.deepStrictEqual(result, {
			ok: false,
			error: { code: 'unsupported_platform' },
		});
		assert.deepStrictEqual(filesystem.statCalls, []);
		assert.deepStrictEqual(filesystem.executePermissionCalls, []);
		assert.strictEqual(JSON.stringify(result).includes(secret), false);
	});

	test('후보 선택 실패는 filesystem 검증이나 fallback을 시작하지 않는다', async () => {
		const filesystem = new FakeShellFilesystem();
		const resolveShellLaunchPolicy =
			createShellLaunchPolicyResolver(filesystem);
		const result = await resolveShellLaunchPolicy(
			'darwin',
			{},
			posixWorkspaceRoot,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			error: { code: 'shell_environment_missing' },
		});
		assert.deepStrictEqual(filesystem.statCalls, []);
	});

	for (const testCase of [
		{
			platform: 'linux',
			env: {
				SHELL: '/missing/custom-shell',
				PATH: '/bin:/usr/bin',
			},
			workspaceRoot: posixWorkspaceRoot,
			executable: '/missing/custom-shell',
		},
		{
			platform: 'win32',
			env: {
				SystemRoot: 'Z:\\MissingWindows',
				PATH: 'C:\\Windows\\System32',
				ComSpec: 'C:\\Windows\\System32\\cmd.exe',
			},
			workspaceRoot: windowsWorkspaceRoot,
			executable:
				'Z:\\MissingWindows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
		},
	] as const) {
		test(`${testCase.platform} 검증 실패 시 선택된 경로만 확인하고 fallback하지 않는다`, async () => {
			const filesystem = new FakeShellFilesystem();
			filesystem.statError = filesystemError('ENOENT');
			const resolveShellLaunchPolicy =
				createShellLaunchPolicyResolver(filesystem);
			const result = await resolveShellLaunchPolicy(
				testCase.platform,
				testCase.env,
				testCase.workspaceRoot,
			);

			assert.deepStrictEqual(result, {
				ok: false,
				error: { code: 'shell_executable_not_found' },
			});
			assert.deepStrictEqual(filesystem.statCalls, [testCase.executable]);
			assert.deepStrictEqual(filesystem.executePermissionCalls, []);
		});
	}
});
