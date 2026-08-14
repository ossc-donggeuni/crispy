import * as assert from 'assert';
import {
	createShellLaunchPolicyResolver,
	type ShellLaunchPolicyResolver,
} from '../../agent/host/shell/shellResolver';
import type {
	ShellFilesystemAdapter,
	ShellFilesystemEntry,
} from '../../agent/host/shell/shellFilesystem';
import type { ShellLaunchPolicyFailure } from '../../agent/host/shell/types';
import {
	createPrepareTerminalLaunch,
	prepareTerminalLaunch,
	type PrepareTerminalLaunch,
} from '../../agent/host/terminal/prepareTerminalLaunch';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
	WorkspaceValidationErrorCode,
} from '../../agent/host/workspace/types';
import {
	parseHostToWebviewMessage,
	parseWebviewToHostMessage,
} from '../../agent/protocol/validator';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

/** 전달된 타입 조건이 참인 경우에만 컴파일되는 테스트 전용 단언이다. */
type Assert<Condition extends true> = Condition;

/** 실행 준비 함수에는 Webview 실행 계약을 넣을 인자가 없음을 검증한다. */
type PreparationAcceptsOnlyValidatedIds = Assert<Equal<
	Parameters<PrepareTerminalLaunch>,
	[tabId: string, sessionId: string | null]
>>;

/** production 진입점도 initial/restart 공통 계약을 사용하는지 검증한다. */
type CanonicalPreparationMatchesContract = Assert<Equal<
	typeof prepareTerminalLaunch,
	PrepareTerminalLaunch
>>;

class FakeShellFilesystem implements ShellFilesystemAdapter {
	readonly calls: string[] = [];

	async stat(path: string): Promise<ShellFilesystemEntry> {
		this.calls.push(`stat:${path}`);
		return { isFile: true };
	}

	async checkExecutePermission(path: string): Promise<void> {
		this.calls.push(`execute:${path}`);
	}
}

function validatedRoot(fsPath: string): ValidatedWorkspaceRoot {
	return {
		scheme: 'file',
		fsPath: fsPath as ValidatedWorkspaceFsPath,
	} as ValidatedWorkspaceRoot;
}

const root = validatedRoot('/validated/workspace');

suite('Terminal launch Host preparation', () => {
	test('trusted single-root file workspace를 ShellLaunchPolicy.cwd로 연결한다', async () => {
		const filesystem = new FakeShellFilesystem();
		const prepare = createPrepareTerminalLaunch({
			workspaceResolver: () => ({
				ok: true,
				root,
			}),
			shellResolver: createShellLaunchPolicyResolver(filesystem),
			readPlatform: () => 'darwin',
			readEnvironment: () => ({
				SHELL: '/host/selected/shell',
			}),
		});

		const result = await prepare('tab-initial', null);

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.policy.cwd, root.fsPath);
			assert.strictEqual(
				result.policy.executable,
				'/host/selected/shell',
			);
			assert.strictEqual(parseHostToWebviewMessage(result).ok, false);
		}
		assert.deepStrictEqual(filesystem.calls, [
			'stat:/host/selected/shell',
			'execute:/host/selected/shell',
		]);
	});

	for (const code of [
		'workspace_not_found',
		'workspace_untrusted',
		'workspace_multi_root_unsupported',
		'workspace_virtual_unsupported',
		'workspace_path_invalid',
	] satisfies readonly WorkspaceValidationErrorCode[]) {
		test(`${code}는 Shell resolve 전에 안전하게 거부한다`, async () => {
			let shellCalls = 0;
			let hostStateReads = 0;
			const shellResolver: ShellLaunchPolicyResolver = async () => {
				shellCalls += 1;
				return {
					ok: false,
					error: { code: 'shell_path_invalid' },
				};
			};
			const prepare = createPrepareTerminalLaunch({
				workspaceResolver: () => ({
					ok: false,
					code,
				}),
				shellResolver,
				readPlatform: () => {
					hostStateReads += 1;
					return 'darwin';
				},
				readEnvironment: () => {
					hostStateReads += 1;
					return {};
				},
			});

			const result = await prepare('tab-workspace-failure', null);

			assert.strictEqual(result.ok, false);
			assert.strictEqual(shellCalls, 0);
			assert.strictEqual(hostStateReads, 0);
			if (!result.ok) {
				assert.strictEqual(result.error.code, code);
				assert.strictEqual(
					parseHostToWebviewMessage(result.error).ok,
					true,
				);
			}
		});
	}

	test('initial start와 restart가 같은 API에서 workspace와 Shell을 다시 평가한다', async () => {
		let workspaceCalls = 0;
		let platformReads = 0;
		let environmentReads = 0;
		const filesystem = new FakeShellFilesystem();
		const prepare = createPrepareTerminalLaunch({
			workspaceResolver: () => {
				workspaceCalls += 1;
				return { ok: true, root };
			},
			shellResolver: createShellLaunchPolicyResolver(filesystem),
			readPlatform: () => {
				platformReads += 1;
				return 'linux';
			},
			readEnvironment: () => {
				environmentReads += 1;
				return { SHELL: `/host/shell-${environmentReads}` };
			},
		});

		const initial = await prepare('tab-shared', null);
		const restart = await prepare('tab-shared', 'session-existing');

		assert.strictEqual(initial.ok, true);
		assert.strictEqual(restart.ok, true);
		assert.strictEqual(workspaceCalls, 2);
		assert.strictEqual(platformReads, 2);
		assert.strictEqual(environmentReads, 2);
		if (initial.ok && restart.ok) {
			assert.strictEqual(initial.policy.cwd, root.fsPath);
			assert.strictEqual(restart.policy.cwd, root.fsPath);
			assert.strictEqual(initial.policy.executable, '/host/shell-1');
			assert.strictEqual(restart.policy.executable, '/host/shell-2');
		}
	});

	test('Shell 실패를 경로와 내부 값을 제외한 고정 terminal.error로 변환한다', async () => {
		const secrets = [
			'/private/workspace/should-not-leak',
			'/private/executable/should-not-leak',
			'--secret-arg',
			'SECRET_ENV=token',
			'raw exception and stack should not leak',
		];
		const unsafeError = {
			code: 'shell_path_invalid' as const,
			executable: secrets[1],
			args: [secrets[2]],
			env: secrets[3],
			exception: new Error(secrets[4]),
		};
		const unsafeFailure: ShellLaunchPolicyFailure &
			Record<string, unknown> = {
			ok: false,
			error: unsafeError,
		};
		const prepare = createPrepareTerminalLaunch({
			workspaceResolver: () => ({
				ok: true,
				root: validatedRoot(secrets[0]),
			}),
			shellResolver: async () => unsafeFailure,
			readPlatform: () => 'darwin',
			readEnvironment: () => ({ SECRET_ENV: secrets[3] }),
		});

		const result = await prepare(
			'tab-shell-failure',
			'session-existing',
		);

		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.deepStrictEqual(result.error, {
				type: 'terminal.error',
				tabId: 'tab-shell-failure',
				sessionId: 'session-existing',
				code: 'shell_unavailable',
				message: 'Shell 경로 설정이 올바르지 않습니다.',
				canRestart: true,
			});
			const serialized = JSON.stringify(result.error);
			for (const secret of secrets) {
				assert.strictEqual(serialized.includes(secret), false);
			}
		}
	});

	test('API 생성과 Extension/Graph 흐름은 Shell availability를 즉시 평가하지 않는다', async () => {
		let dependencyCalls = 0;
		const prepare = createPrepareTerminalLaunch({
			workspaceResolver: () => {
				dependencyCalls += 1;
				return { ok: true, root };
			},
			shellResolver: async () => {
				dependencyCalls += 1;
				return {
					ok: false,
					error: { code: 'shell_executable_not_found' },
				};
			},
			readPlatform: () => 'darwin',
			readEnvironment: () => ({}),
		});

		assert.strictEqual(dependencyCalls, 0);
		const result = await prepare('tab-request-scoped', null);
		assert.strictEqual(result.ok, false);
		assert.strictEqual(dependencyCalls, 2);
	});

	test('기존 Webview validator가 실행 계약과 provider 우회를 준비 단계 전에 거부한다', () => {
		for (const field of [
			'executable',
			'args',
			'cwd',
			'env',
			'providerPolicy',
		] as const) {
			const parsed = parseWebviewToHostMessage({
				type: 'terminal.ready',
				tabId: 'tab-forbidden',
				providerId: 'codex',
				cols: 80,
				rows: 24,
				[field]: 'webview-controlled-value',
			});

			assert.strictEqual(parsed.ok, false);
			if (!parsed.ok) {
				assert.strictEqual(parsed.error.code, 'forbidden_field');
				assert.strictEqual(parsed.error.field, field);
			}
		}

		const providerOverride = parseWebviewToHostMessage({
			type: 'terminal.ready',
			tabId: 'tab-provider-override',
			providerId: 'untrusted-provider',
			cols: 80,
			rows: 24,
		});
		assert.strictEqual(providerOverride.ok, false);
		if (!providerOverride.ok) {
			assert.strictEqual(
				providerOverride.error.code,
				'provider_not_allowed',
			);
		}
	});
});
