import * as assert from 'assert';
import {
	validateShellExecutable,
} from '../../agent/host/shell/shellExecutableValidator';
import type {
	ShellFilesystemAdapter,
	ShellFilesystemEntry,
} from '../../agent/host/shell/shellFilesystem';
import {
	mapShellLaunchFailureToTerminalError,
} from '../../agent/host/shell/shellErrorMessage';
import type {
	ShellLaunchPolicy,
	SupportedShellPlatform,
} from '../../agent/host/shell/types';

class FakeShellFilesystem implements ShellFilesystemAdapter {
	readonly calls: string[] = [];
	statResult: ShellFilesystemEntry = { isFile: true };
	statError: unknown;
	executePermissionError: unknown;

	async stat(path: string): Promise<ShellFilesystemEntry> {
		this.calls.push(`stat:${path}`);
		if (this.statError) {
			throw this.statError;
		}
		return this.statResult;
	}

	async checkExecutePermission(path: string): Promise<void> {
		this.calls.push(`execute:${path}`);
		if (this.executePermissionError) {
			throw this.executePermissionError;
		}
	}
}

function policy(executable = '/selected/shell'): ShellLaunchPolicy {
	return {
		executable,
		args: [],
		cwd: '/validated/workspace',
		env: { SHELL: executable },
	};
}

function filesystemError(
	code: string,
	message = 'raw filesystem exception',
	path = '/private/path/should-not-leak',
): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	error.path = path;
	return error;
}

suite('Shell executable validator', () => {
	for (const platform of ['darwin', 'linux'] as const) {
		test(`${platform}에서 file 존재와 실행 권한을 순서대로 확인한다`, async () => {
			const filesystem = new FakeShellFilesystem();
			const candidate = policy();
			const result = await validateShellExecutable(
				platform,
				candidate,
				filesystem,
			);

			assert.deepStrictEqual(result, { ok: true, policy: candidate });
			assert.deepStrictEqual(filesystem.calls, [
				'stat:/selected/shell',
				'execute:/selected/shell',
			]);
		});
	}

	for (const platform of [
		'darwin',
		'linux',
		'win32',
	] satisfies readonly SupportedShellPlatform[]) {
		test(`${platform}에서 존재하지 않는 executable을 구분해 거부한다`, async () => {
			const filesystem = new FakeShellFilesystem();
			filesystem.statError = filesystemError('ENOENT');

			const result = await validateShellExecutable(
				platform,
				policy(),
				filesystem,
			);

			assert.deepStrictEqual(result, {
				ok: false,
				error: { code: 'shell_executable_not_found' },
			});
			assert.deepStrictEqual(filesystem.calls, ['stat:/selected/shell']);
		});

		test(`${platform}에서 디렉터리와 기타 non-file 경로를 거부한다`, async () => {
			const filesystem = new FakeShellFilesystem();
			filesystem.statResult = { isFile: false };

			const result = await validateShellExecutable(
				platform,
				policy(),
				filesystem,
			);

			assert.deepStrictEqual(result, {
				ok: false,
				error: { code: 'shell_path_not_file' },
			});
			assert.deepStrictEqual(filesystem.calls, ['stat:/selected/shell']);
		});
	}

	for (const platform of ['darwin', 'linux'] as const) {
		test(`${platform} 실행 권한 없음을 구분해 거부한다`, async () => {
			const filesystem = new FakeShellFilesystem();
			filesystem.executePermissionError = filesystemError('EACCES');

			const result = await validateShellExecutable(
				platform,
				policy(),
				filesystem,
			);

			assert.deepStrictEqual(result, {
				ok: false,
				error: { code: 'shell_not_executable' },
			});
			assert.deepStrictEqual(filesystem.calls, [
				'stat:/selected/shell',
				'execute:/selected/shell',
			]);
		});
	}

	test('Windows file 검증에는 POSIX 실행 권한 검사를 적용하지 않는다', async () => {
		const filesystem = new FakeShellFilesystem();
		filesystem.executePermissionError = filesystemError('EACCES');
		const candidate = policy('C:\\Windows\\powershell.exe');

		const result = await validateShellExecutable(
			'win32',
			candidate,
			filesystem,
		);

		assert.deepStrictEqual(result, { ok: true, policy: candidate });
		assert.deepStrictEqual(filesystem.calls, [
			'stat:C:\\Windows\\powershell.exe',
		]);
	});

	test('filesystem exception의 원문과 경로를 typed 실패나 Webview 오류에 반사하지 않는다', async () => {
		const filesystem = new FakeShellFilesystem();
		const secretMessage = 'raw exception with secret token';
		const secretPath = '/private/shell/path-should-not-leak';
		filesystem.statError = filesystemError(
			'EIO',
			secretMessage,
			secretPath,
		);

		const result = await validateShellExecutable(
			'linux',
			policy(secretPath),
			filesystem,
		);
		assert.strictEqual(result.ok, false);
		if (result.ok) {
			return;
		}

		assert.deepStrictEqual(result, {
			ok: false,
			error: { code: 'shell_path_invalid' },
		});
		const terminalError = mapShellLaunchFailureToTerminalError(
			result,
			'tab-shell-validator',
			null,
		);
		const serialized = JSON.stringify({ result, terminalError });
		assert.strictEqual(serialized.includes(secretMessage), false);
		assert.strictEqual(serialized.includes(secretPath), false);
	});

	test('validator는 주입된 filesystem 연산만 사용한다', async () => {
		for (const platform of [
			'darwin',
			'linux',
			'win32',
		] satisfies readonly SupportedShellPlatform[]) {
			const filesystem = new FakeShellFilesystem();
			await validateShellExecutable(platform, policy(), filesystem);

			assert.deepStrictEqual(
				filesystem.calls,
				platform === 'win32'
					? ['stat:/selected/shell']
					: ['stat:/selected/shell', 'execute:/selected/shell'],
			);
		}
	});
});
