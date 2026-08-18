import * as assert from 'assert';
import {
	buildShellEnv,
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
	test('PTY env에서 색상을 끄는 설정을 제거하고 색상 계약을 고정한다', () => {
		const base: NodeJS.ProcessEnv = {
			SHELL: '/host/selected/shell',
			NO_COLOR: '1',
			CLICOLOR: '0',
			FORCE_COLOR: '0',
		};
		const result = buildShellEnv(base);

		assert.strictEqual(result.NO_COLOR, undefined);
		assert.strictEqual(result.CLICOLOR, undefined);
		assert.strictEqual(result.FORCE_COLOR, '3');
		assert.strictEqual(result.TERM, 'xterm-256color');
		assert.strictEqual(result.COLORTERM, 'truecolor');
		assert.strictEqual(base.NO_COLOR, '1');
		assert.strictEqual(base.CLICOLOR, '0');
		assert.strictEqual(base.FORCE_COLOR, '0');
		assert.strictEqual(base.TERM, undefined);
	});

	test('실행 환경에서 상속한 TERM과 COLORTERM을 렌더러 기준으로 덮어쓴다', () => {
		/* VS Code를 어디서 띄웠는지가 색 단계를 바꾸지 않아야 한다. */
		for (const inherited of [
			{ TERM: 'screen', COLORTERM: undefined },
			{ TERM: 'xterm', COLORTERM: undefined },
			{ TERM: 'screen-256color', COLORTERM: '24bit' },
			{ TERM: 'dumb', COLORTERM: undefined },
		]) {
			const result = buildShellEnv({ ...inherited, NO_COLOR: '' });

			assert.strictEqual(result.TERM, 'xterm-256color');
			assert.strictEqual(result.COLORTERM, 'truecolor');
			assert.strictEqual(result.FORCE_COLOR, '3');
			assert.strictEqual(result.NO_COLOR, undefined);
		}
	});

	test('상속된 COLORTERM 값은 xterm truecolor capability로 덮어쓴다', () => {
		for (const colorterm of ['truecolor', '24bit', '']) {
			const base: NodeJS.ProcessEnv = { COLORTERM: colorterm };
			const result = buildShellEnv(base);

			assert.strictEqual(result.COLORTERM, 'truecolor');
			assert.strictEqual(result.FORCE_COLOR, '3');
			assert.strictEqual(base.COLORTERM, colorterm);
		}
	});

	test('터미널 앱별 분기 근거가 되는 TERM_PROGRAM을 상속하지 않는다', () => {
		const base: NodeJS.ProcessEnv = {
			TERM_PROGRAM: 'Apple_Terminal',
			TERM_PROGRAM_VERSION: '455',
		};
		const result = buildShellEnv(base);

		assert.strictEqual(result.TERM_PROGRAM, undefined);
		assert.strictEqual(result.TERM_PROGRAM_VERSION, undefined);
		assert.strictEqual(base.TERM_PROGRAM, 'Apple_Terminal');
	});

	test('색상과 무관한 환경 변수는 그대로 전달한다', () => {
		const result = buildShellEnv({
			SHELL: '/host/selected/shell',
			CLICOLOR: '1',
			PATH: '/usr/bin',
		});

		assert.strictEqual(result.CLICOLOR, '1');
		assert.strictEqual(result.PATH, '/usr/bin');
	});

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
				assert.strictEqual(result.policy.env.NO_COLOR, undefined);
				assert.strictEqual(result.policy.env.FORCE_COLOR, '3');
				assert.strictEqual(result.policy.env.TERM, 'xterm-256color');
				assert.strictEqual(result.policy.env.COLORTERM, 'truecolor');
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
			assert.strictEqual(result.policy.env.TERM, 'xterm-256color');
			assert.strictEqual(result.policy.env.COLORTERM, 'truecolor');
			assert.strictEqual(result.policy.env.FORCE_COLOR, '3');
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
