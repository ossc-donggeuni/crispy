import * as assert from 'assert';
import { resolvePosixShellLaunchPolicy } from '../../agent/host/shell/posixShellResolver';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
} from '../../agent/host/workspace/types';
import { parseWebviewToHostMessage } from '../../agent/protocol/validator';

const workspaceFsPath = '/validated/workspace' as ValidatedWorkspaceFsPath;
const workspaceRoot = {
	scheme: 'file',
	fsPath: workspaceFsPath,
} as ValidatedWorkspaceRoot;

const platformCases = [
	{
		platform: 'darwin',
		shell: '/opt/host/bin/zsh',
	},
	{
		platform: 'linux',
		shell: '/opt/host/bin/fish',
	},
] as const satisfies readonly {
	readonly platform: 'darwin' | 'linux';
	readonly shell: string;
}[];

suite('POSIX Shell resolver', () => {
	for (const testCase of platformCases) {
		suite(testCase.platform, () => {
			test('주입된 SHELL과 검증된 workspace root를 그대로 선택한다', () => {
				const env: NodeJS.ProcessEnv = {
					SHELL: testCase.shell,
					PATH: '/host/controlled/path',
					CRISPY_TEST_VALUE: 'preserved',
				};
				const result = resolvePosixShellLaunchPolicy(env, workspaceRoot);

				assert.strictEqual(result.ok, true);
				if (result.ok) {
					assert.strictEqual(result.policy.executable, testCase.shell);
					assert.strictEqual(result.policy.cwd, workspaceRoot.fsPath);
					assert.deepStrictEqual(result.policy.env, env);
				}
			});

			test('args는 비어 있고 login shell 인자를 추가하지 않는다', () => {
				const result = resolvePosixShellLaunchPolicy(
					{ SHELL: testCase.shell },
					workspaceRoot,
				);

				assert.strictEqual(result.ok, true);
				if (result.ok) {
					assert.deepStrictEqual(result.policy.args, []);
				}
			});

			test('SHELL 누락과 빈 문자열을 typed failure로 반환한다', () => {
				for (const env of [
					{ PATH: '/bin:/usr/bin' },
					{ SHELL: '', PATH: '/bin:/usr/bin' },
				] satisfies readonly NodeJS.ProcessEnv[]) {
					assert.deepStrictEqual(
						resolvePosixShellLaunchPolicy(env, workspaceRoot),
						{
							ok: false,
							error: { code: 'shell_environment_missing' },
						},
					);
				}
			});

			test('누락되거나 잘못된 SHELL을 다른 실행 파일로 fallback하지 않는다', () => {
				const missing = resolvePosixShellLaunchPolicy({
					PATH: '/bin:/usr/bin',
				}, workspaceRoot);
				assert.strictEqual(missing.ok, false);

				const configuredPath = '/definitely/missing/custom-shell';
				const unvalidated = resolvePosixShellLaunchPolicy({
					SHELL: configuredPath,
					PATH: '/bin:/usr/bin',
				}, workspaceRoot);
				assert.strictEqual(unvalidated.ok, true);
				if (unvalidated.ok) {
					assert.strictEqual(unvalidated.policy.executable, configuredPath);
					assert.notStrictEqual(unvalidated.policy.executable, '/bin/sh');
					assert.notStrictEqual(unvalidated.policy.executable, '/bin/bash');
				}
			});

			test('입력 env 객체를 변경하지 않고 Host 환경 snapshot을 반환한다', () => {
				const env: NodeJS.ProcessEnv = {
					SHELL: testCase.shell,
					PATH: '/host/controlled/path',
				};
				const before = { ...env };
				const result = resolvePosixShellLaunchPolicy(env, workspaceRoot);

				assert.deepStrictEqual(env, before);
				assert.strictEqual(result.ok, true);
				if (result.ok) {
					assert.deepStrictEqual(result.policy.env, before);
					assert.notStrictEqual(result.policy.env, env);
				}
			});
		});
	}

	test('반환된 실행 계약을 Webview 요청으로 보내면 기존 validator가 거부한다', () => {
		const result = resolvePosixShellLaunchPolicy({
			SHELL: '/opt/host/bin/zsh',
		}, workspaceRoot);
		assert.strictEqual(result.ok, true);
		if (!result.ok) {
			return;
		}

		const parsed = parseWebviewToHostMessage({
			type: 'terminal.ready',
			tabId: 'tab-shell-boundary',
			cols: 80,
			rows: 24,
			...result.policy,
		});

		assert.deepStrictEqual(parsed, {
			ok: false,
			error: {
				code: 'forbidden_field',
				message: "Invalid field 'executable'.",
				field: 'executable',
			},
		});
	});
});
