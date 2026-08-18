import * as assert from 'assert';
import {
	SHELL_LAUNCH_ERROR_CODES,
	type ShellLaunchErrorCode,
	type ShellLaunchPolicy,
	type ShellLaunchPolicyError,
	type ShellLaunchPolicyFailure,
	type ShellLaunchPolicyResult,
	type SupportedShellPlatform,
} from '../../agent/host/shell/types';

// @ts-expect-error ShellLaunchPolicy는 protocol 공개 타입이 아니다.
import type { ShellLaunchPolicy as ProtocolShellLaunchPolicy } from '../../agent/protocol';
// @ts-expect-error legacy Webview 메시지 경로도 Host 실행 계약을 재노출하지 않는다.
import type { ShellLaunchPolicy as MessageShellLaunchPolicy } from '../../messages';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

/** 전달된 타입 조건이 참인 경우에만 컴파일되는 테스트 전용 단언이다. */
type Assert<Condition extends true> = Condition;

type ExpectedShellLaunchErrorCode =
	| 'unsupported_platform'
	| 'shell_environment_missing'
	| 'shell_path_invalid'
	| 'shell_executable_not_found'
	| 'shell_path_not_file'
	| 'shell_not_executable';

type SupportedPlatformsAreExact = Assert<Equal<
	SupportedShellPlatform,
	'darwin' | 'linux' | 'win32'
>>;

type ShellErrorCodesAreExact = Assert<Equal<
	ShellLaunchErrorCode,
	ExpectedShellLaunchErrorCode
>>;

type ShellPolicyShapeIsExact = Assert<Equal<
	ShellLaunchPolicy,
	{
		executable: string;
		args: readonly string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
	}
>>;

type ShellErrorContainsOnlyCode = Assert<Equal<
	keyof ShellLaunchPolicyError,
	'code'
>>;

type ShellFailureContainsOnlyTypedError = Assert<Equal<
	keyof ShellLaunchPolicyFailure,
	'ok' | 'error'
>>;

/** 성공 결과로 좁혀진 경우에만 Host 실행 정책을 반환한다. */
function resolvedPolicy(
	result: ShellLaunchPolicyResult,
): ShellLaunchPolicy | undefined {
	return result.ok ? result.policy : undefined;
}

suite('Shell Host type contract', () => {
	test('지원 플랫폼과 내부 실패 code allowlist를 정확히 정의한다', () => {
		const platforms: readonly SupportedShellPlatform[] = [
			'darwin',
			'linux',
			'win32',
		];
		const expectedCodes: readonly ExpectedShellLaunchErrorCode[] = [
			'unsupported_platform',
			'shell_environment_missing',
			'shell_path_invalid',
			'shell_executable_not_found',
			'shell_path_not_file',
			'shell_not_executable',
		];

		assert.deepStrictEqual(platforms, ['darwin', 'linux', 'win32']);
		assert.deepStrictEqual(SHELL_LAUNCH_ERROR_CODES, expectedCodes);
	});

	test('성공 결과에서만 Host 전용 실행 정책을 얻는다', () => {
		const policy: ShellLaunchPolicy = {
			executable: '/host/selected/shell',
			args: ['--host-owned'],
			cwd: '/validated/workspace',
			env: { PATH: '/host/selected/path' },
		};
		const success = { ok: true, policy } satisfies ShellLaunchPolicyResult;
		const failure = {
			ok: false,
			error: { code: 'shell_path_invalid' },
		} satisfies ShellLaunchPolicyResult;

		assert.strictEqual(resolvedPolicy(success), policy);
		assert.strictEqual(resolvedPolicy(failure), undefined);
	});

	test('실패 객체에는 경로, 환경, 입력 또는 원본 exception 저장 공간이 없다', () => {
		const failure: ShellLaunchPolicyFailure = {
			ok: false,
			error: { code: 'shell_executable_not_found' },
		};

		assert.deepStrictEqual(Object.keys(failure).sort(), ['error', 'ok']);
		assert.deepStrictEqual(Object.keys(failure.error), ['code']);
	});
});
