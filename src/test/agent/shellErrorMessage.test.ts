import * as assert from 'assert';
import {
	mapShellLaunchFailureToTerminalError,
	type ShellTerminalErrorMessage,
} from '../../agent/host/shell/shellErrorMessage';
import type {
	ShellLaunchPolicyFailure,
	ShellLaunchPolicySuccess,
} from '../../agent/host/shell/types';
import { parseHostToWebviewMessage } from '../../agent/protocol/validator';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

/** 전달된 타입 조건이 참인 경우에만 컴파일되는 테스트 전용 단언이다. */
type Assert<Condition extends true> = Condition;

type MapperAcceptsOnlyFailure = Assert<Equal<
	Parameters<typeof mapShellLaunchFailureToTerminalError>[0],
	ShellLaunchPolicyFailure
>>;

type MapperRejectsSuccess = Assert<Equal<
	ShellLaunchPolicySuccess extends Parameters<
		typeof mapShellLaunchFailureToTerminalError
	>[0] ? true : false,
	false
>>;

const tabId = 'tab-shell-policy';
const expectedFields = [
	'canRestart',
	'code',
	'message',
	'sessionId',
	'tabId',
	'type',
];

const expectedMessages = [
	{
		internalCode: 'unsupported_platform',
		message: '현재 운영체제에서는 Shell terminal을 지원하지 않습니다.',
		canRestart: false,
	},
	{
		internalCode: 'shell_environment_missing',
		message: 'Shell 환경 설정을 찾을 수 없습니다.',
		canRestart: true,
	},
	{
		internalCode: 'shell_path_invalid',
		message: 'Shell 경로 설정이 올바르지 않습니다.',
		canRestart: true,
	},
	{
		internalCode: 'shell_executable_not_found',
		message: '설정된 Shell 실행 파일을 찾을 수 없습니다.',
		canRestart: true,
	},
	{
		internalCode: 'shell_path_not_file',
		message: '설정된 Shell 경로가 실행 파일이 아닙니다.',
		canRestart: true,
	},
	{
		internalCode: 'shell_not_executable',
		message: '설정된 Shell을 실행할 권한이 없습니다.',
		canRestart: true,
	},
] as const;

suite('Shell terminal.error boundary', () => {
	for (const expected of expectedMessages) {
		test(`${expected.internalCode}를 기존 protocol의 안전한 오류로 변환한다`, () => {
			const message = mapShellLaunchFailureToTerminalError({
				ok: false,
				error: { code: expected.internalCode },
			}, tabId, null);

			assert.deepStrictEqual(message, {
				type: 'terminal.error',
				tabId,
				sessionId: null,
				code: 'shell_unavailable',
				message: expected.message,
				canRestart: expected.canRestart,
			});
			assert.strictEqual(parseHostToWebviewMessage(message).ok, true);
		});
	}

	test('내부 세부 code를 protocol code로 추가하지 않는다', () => {
		for (const expected of expectedMessages) {
			const message = mapShellLaunchFailureToTerminalError({
				ok: false,
				error: { code: expected.internalCode },
			}, tabId, null);

			assert.strictEqual(message.code, 'shell_unavailable');
			assert.deepStrictEqual(Object.keys(message).sort(), expectedFields);
		}
	});

	test('시작 전 null sessionId와 기존 sessionId를 모두 지원한다', () => {
		const failure = {
			ok: false,
			error: { code: 'shell_environment_missing' },
		} satisfies ShellLaunchPolicyFailure;
		const beforeStart = mapShellLaunchFailureToTerminalError(
			failure,
			tabId,
			null,
		);
		const existingSession = mapShellLaunchFailureToTerminalError(
			failure,
			tabId,
			'session-existing',
		);

		assert.strictEqual(beforeStart.sessionId, null);
		assert.strictEqual(existingSession.sessionId, 'session-existing');
		assert.strictEqual(parseHostToWebviewMessage(beforeStart).ok, true);
		assert.strictEqual(parseHostToWebviewMessage(existingSession).ok, true);
	});

	test('경로, 환경, 사용자 입력과 원본 exception을 Webview에 반사하지 않는다', () => {
		const secrets = [
			'/private/shell/should-not-leak',
			'PATH=/private/bin',
			'user-input-should-not-leak',
			'prompt-response-should-not-leak',
			'https://auth.example.test/device?code=secret-code',
			'access-token-should-not-leak',
		];
		const unsafeError = {
			code: 'shell_not_executable' as const,
			path: secrets[0],
			env: secrets[1],
			input: secrets[2],
			response: secrets[3],
			authUrl: secrets[4],
			token: secrets[5],
			exception: new Error(secrets.join(' ')),
		};
		const failureWithInternalValues: ShellLaunchPolicyFailure &
			Record<string, unknown> = {
			ok: false,
			error: unsafeError,
		};

		const result: ShellTerminalErrorMessage =
			mapShellLaunchFailureToTerminalError(
				failureWithInternalValues,
				tabId,
				null,
			);
		const serialized = JSON.stringify(result);

		for (const secret of secrets) {
			assert.strictEqual(serialized.includes(secret), false);
		}
	});
});
