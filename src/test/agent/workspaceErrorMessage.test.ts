import * as assert from 'assert';
import { parseHostToWebviewMessage } from '../../agent/protocol/validator';
import {
	mapWorkspaceFailureToTerminalError,
	type WorkspaceTerminalErrorMessage,
} from '../../agent/host/workspace/workspaceErrorMessage';
import type {
	WorkspaceValidationFailure,
	WorkspaceValidationSuccess,
} from '../../agent/host/workspace/types';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

/** 전달된 타입 조건이 참인 경우에만 컴파일되는 테스트 전용 단언이다. */
type Assert<Condition extends true> = Condition;

/** mapper가 성공 root 대신 실패 결과만 입력받는지 검증한다. */
type MapperAcceptsOnlyFailure = Assert<Equal<
	Parameters<typeof mapWorkspaceFailureToTerminalError>[0],
	WorkspaceValidationFailure
>>;

/** Workspace 성공 결과를 mapper의 첫 인자로 전달할 수 없는지 검증한다. */
type MapperRejectsSuccess = Assert<Equal<
	WorkspaceValidationSuccess extends Parameters<
		typeof mapWorkspaceFailureToTerminalError
	>[0] ? true : false,
	false
>>;

const tabId = 'tab-workspace-policy';
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
		code: 'workspace_untrusted',
		message: '작업공간을 신뢰한 후 다시 시도하세요.',
		canRestart: true,
	},
	{
		code: 'workspace_root_unavailable',
		message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
		canRestart: true,
	},
	{
		code: 'workspace_virtual_unsupported',
		message: '로컬 파일 작업공간을 연 후 다시 시도하세요.',
		canRestart: true,
	},
	{
		code: 'workspace_path_invalid',
		message: '유효한 로컬 작업공간 폴더를 연 후 다시 시도하세요.',
		canRestart: true,
	},
] as const;

suite('Workspace terminal.error mapper', () => {
	for (const expected of expectedMessages) {
		test(`${expected.code}를 고정된 terminal.error로 변환한다`, () => {
			const message = mapWorkspaceFailureToTerminalError(
				{ ok: false, code: expected.code },
				tabId,
				null,
			);

			assert.deepStrictEqual(message, {
				type: 'terminal.error',
				tabId,
				sessionId: null,
				code: expected.code,
				message: expected.message,
				canRestart: expected.canRestart,
			});
		});
	}

	test('생성된 모든 메시지가 기존 Host→Webview parser를 통과한다', () => {
		for (const expected of expectedMessages) {
			const message = mapWorkspaceFailureToTerminalError(
				{ ok: false, code: expected.code },
				tabId,
				null,
			);

			const parsed = parseHostToWebviewMessage(message);
			assert.strictEqual(parsed.ok, true);
			if (parsed.ok) {
				assert.deepStrictEqual(parsed.value, message);
			}
		}
	});

	test('protocol schema의 정확한 필드만 생성한다', () => {
		for (const expected of expectedMessages) {
			const message = mapWorkspaceFailureToTerminalError(
				{ ok: false, code: expected.code },
				tabId,
				null,
			);

			assert.deepStrictEqual(Object.keys(message).sort(), expectedFields);
		}
	});

	test('시작 전 sessionId null과 기존 sessionId를 모두 지원한다', () => {
		const failure = {
			ok: false,
			code: 'workspace_untrusted',
		} satisfies WorkspaceValidationFailure;
		const beforeStart = mapWorkspaceFailureToTerminalError(
			failure,
			tabId,
			null,
		);
		const beforeRestart = mapWorkspaceFailureToTerminalError(
			failure,
			tabId,
			'session-existing',
		);

		assert.strictEqual(beforeStart.sessionId, null);
		assert.strictEqual(beforeRestart.sessionId, 'session-existing');
		assert.strictEqual(parseHostToWebviewMessage(beforeStart).ok, true);
		assert.strictEqual(parseHostToWebviewMessage(beforeRestart).ok, true);
	});

	test('path, URI, workspace 이름과 인증 정보를 결과에 포함하지 않는다', () => {
		const secrets = [
			'/private/workspace/should-not-leak',
			'file:///private/workspace/should-not-leak',
			'Confidential Workspace',
			'https://auth.example.test/device?code=secret-code',
			'access-token-should-not-leak',
		];
		const failureWithInternalValues = {
			ok: false,
			code: 'workspace_path_invalid',
			path: secrets[0],
			uri: secrets[1],
			workspaceName: secrets[2],
			authUrl: secrets[3],
			token: secrets[4],
		} satisfies WorkspaceValidationFailure & Record<string, unknown>;

		const serialized = JSON.stringify(mapWorkspaceFailureToTerminalError(
			failureWithInternalValues,
			tabId,
			null,
		));

		for (const secret of secrets) {
			assert.strictEqual(serialized.includes(secret), false);
		}
	});

	test('외부 오류 문자열이나 exception message를 Webview에 반사하지 않는다', () => {
		const externalMessage = 'spawn failed: prompt and response should not leak';
		const exceptionMessage = 'authentication code and token should not leak';
		const failureWithExceptions = {
			ok: false,
			code: 'workspace_root_unavailable',
			message: externalMessage,
			error: new Error(exceptionMessage),
		} satisfies WorkspaceValidationFailure & Record<string, unknown>;

		const result: WorkspaceTerminalErrorMessage =
			mapWorkspaceFailureToTerminalError(
				failureWithExceptions,
				tabId,
				null,
			);
		const serialized = JSON.stringify(result);

		assert.strictEqual(serialized.includes(externalMessage), false);
		assert.strictEqual(serialized.includes(exceptionMessage), false);
		assert.strictEqual(
			result.message,
			'선택한 작업공간 폴더를 다시 연 후 시도하세요.',
		);
	});
});
