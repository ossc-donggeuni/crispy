import * as assert from 'assert';
import {
	ID_MAX_LENGTH,
	TERMINAL_COLS_MAX,
	TERMINAL_COLS_MIN,
	TERMINAL_INPUT_MAX_BYTES,
	TERMINAL_ROWS_MAX,
	TERMINAL_ROWS_MIN,
	parseHostToWebviewMessage,
	parseWebviewToHostMessage,
	type MessageParseResult,
	type MessageValidationErrorCode,
} from '../agent/protocol/index';

const TAB_ID = 'tab:one';
const SESSION_ID = 'session-1';

suite('Host↔Webview protocol runtime validator', () => {
	suite('Webview→Host', () => {
		test('null, 배열 및 primitive를 메시지로 거부한다', () => {
			for (const value of [null, [], undefined, true, 1, 'message']) {
				assertFailure(
					parseWebviewToHostMessage(value),
					'invalid_message',
				);
			}
		});

		test('type 누락과 알려지지 않은 type을 구분한다', () => {
			assertFailure(parseWebviewToHostMessage({}), 'missing_field', 'type');
			assertFailure(
				parseWebviewToHostMessage({ type: 42 }),
				'invalid_field',
				'type',
			);
			assertFailure(
				parseWebviewToHostMessage({ type: 'panel.layoutState' }),
				'unknown_type',
				'type',
			);
		});

		test('ready handshake와 모든 terminal 메시지를 검증한다', () => {
			const messages = [
				{ type: 'webview.ready' },
				{
					type: 'terminal.ready',
					tabId: TAB_ID,
					cols: TERMINAL_COLS_MIN,
					rows: TERMINAL_ROWS_MAX,
				},
				{
					type: 'terminal.input',
					tabId: TAB_ID,
					sessionId: SESSION_ID,
					data: 'hello',
				},
				{
					type: 'terminal.resize',
					tabId: TAB_ID,
					sessionId: SESSION_ID,
					cols: TERMINAL_COLS_MAX,
					rows: TERMINAL_ROWS_MIN,
				},
				{
					type: 'terminal.restart',
					tabId: TAB_ID,
					sessionId: SESSION_ID,
				},
				{ type: 'terminal.visible', tabId: TAB_ID, visible: false },
			];

			for (const message of messages) {
				const result = parseWebviewToHostMessage(message);
				assert.strictEqual(result.ok, true);
				if (result.ok) {
					assert.deepStrictEqual(result.value, message);
					assert.notStrictEqual(result.value, message);
				}
			}
		});

		test('필수 필드 누락과 추가 필드를 구분한다', () => {
			assertFailure(
				parseWebviewToHostMessage({
					type: 'terminal.input',
					tabId: TAB_ID,
					sessionId: SESSION_ID,
				}),
				'missing_field',
				'data',
			);
			assertFailure(
				parseWebviewToHostMessage({ type: 'webview.ready', extra: true }),
				'unexpected_field',
				'extra',
			);
		});

		test('Host 소유 실행 필드는 unexpected_field보다 먼저 forbidden_field로 거부한다', () => {
			const forbiddenFields = [
				'workspaceRoot',
				'workspace',
				'root',
				'cwd',
				'executable',
				'command',
				'args',
				'env',
				'pid',
				'pty',
				'providerPolicy',
				'providerConfig',
				'timeout',
				'limits',
			] as const;

			for (const field of forbiddenFields) {
				assertFailure(
					parseWebviewToHostMessage({
						type: 'terminal.ready',
						tabId: TAB_ID,
						cols: 80,
						rows: 24,
						extra: true,
						[field]: 'secret-value',
					}),
					'forbidden_field',
					field,
				);
			}
		});

		test('Webview provider 선택을 terminal.ready 추가 필드로 거부한다', () => {
			const result = parseWebviewToHostMessage({
				type: 'terminal.ready',
				tabId: TAB_ID,
				providerId: 'secret-provider-name',
				cols: 80,
				rows: 24,
			});

			assertFailure(result, 'unexpected_field', 'providerId');
			assert.doesNotMatch(JSON.stringify(result), /secret-provider-name/);
		});

		test('tabId와 sessionId 형식 및 최대 길이를 검증한다', () => {
			assertFailure(
				parseWebviewToHostMessage({
					type: 'terminal.visible',
					tabId: 'invalid id',
					visible: true,
				}),
				'invalid_field',
				'tabId',
			);
			assertFailure(
				parseWebviewToHostMessage({
					type: 'terminal.input',
					tabId: TAB_ID,
					sessionId: `s${'a'.repeat(ID_MAX_LENGTH)}`,
					data: '',
				}),
				'value_out_of_range',
				'sessionId',
			);
		});

		test('terminal 크기가 정수이며 범위 안인지 검증한다', () => {
			const base = {
				type: 'terminal.resize',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				cols: 80,
				rows: 24,
			};

			assertFailure(
				parseWebviewToHostMessage({ ...base, cols: 1.5 }),
				'invalid_field',
				'cols',
			);
			assertFailure(
				parseWebviewToHostMessage({ ...base, rows: TERMINAL_ROWS_MAX + 1 }),
				'value_out_of_range',
				'rows',
			);
		});

		test('terminal.input 제한을 UTF-8 byte 수로 검증한다', () => {
			const base = {
				type: 'terminal.input',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
			};
			const withinLimit = `${'가'.repeat(21_845)}a`;
			const overLimit = `${withinLimit}a`;
			const emojiAtLimit = '😀'.repeat(16_384);

			assert.strictEqual(withinLimit.length < TERMINAL_INPUT_MAX_BYTES, true);
			assert.strictEqual(parseWebviewToHostMessage({
				...base,
				data: withinLimit,
			}).ok, true);
			assert.strictEqual(parseWebviewToHostMessage({
				...base,
				data: emojiAtLimit,
			}).ok, true);
			assertFailure(
				parseWebviewToHostMessage({ ...base, data: overLimit }),
				'value_out_of_range',
				'data',
			);
			assertFailure(
				parseWebviewToHostMessage({ ...base, data: 123 }),
				'invalid_field',
				'data',
			);
		});

		test('visible은 boolean만 허용한다', () => {
			assertFailure(
				parseWebviewToHostMessage({
					type: 'terminal.visible',
					tabId: TAB_ID,
					visible: 1,
				}),
				'invalid_field',
				'visible',
			);
		});
	});

	suite('Host→Webview', () => {
		test('ready handshake와 모든 terminal 메시지를 검증해 새 객체로 복사한다', () => {
			const messages = [
				{ type: 'extension.ready' },
				{ type: 'terminal.starting', tabId: TAB_ID },
				{ type: 'terminal.started', tabId: TAB_ID, sessionId: SESSION_ID },
				{
					type: 'terminal.output',
					tabId: TAB_ID,
					sessionId: SESSION_ID,
					data: 'output',
				},
				{
					type: 'terminal.exited',
					tabId: TAB_ID,
					sessionId: SESSION_ID,
					exitCode: 0,
				},
				{
					type: 'terminal.error',
					tabId: TAB_ID,
					sessionId: null,
					code: 'start_failed',
					message: 'Unable to start.',
					canRestart: true,
				},
				{
					type: 'terminal.cleanupFailed',
					tabId: TAB_ID,
					sessionId: SESSION_ID,
					message: 'Unable to clean up.',
				},
			];

			for (const message of messages) {
				const result = parseHostToWebviewMessage(message);
				assert.strictEqual(result.ok, true);
				if (result.ok) {
					assert.deepStrictEqual(result.value, message);
					assert.notStrictEqual(result.value, message);
				}
			}
		});

		test('output 데이터와 오류 code를 검증하며 잘못된 값을 반사하지 않는다', () => {
			const outputResult = parseHostToWebviewMessage({
				type: 'terminal.output',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				data: { token: 'secret-output-token' },
			});
			const errorResult = parseHostToWebviewMessage({
				type: 'terminal.error',
				tabId: TAB_ID,
				sessionId: null,
				code: 'secret-error-code',
				message: 'provider response',
				canRestart: false,
			});

			assertFailure(outputResult, 'invalid_field', 'data');
			assertFailure(errorResult, 'invalid_field', 'code');
			assert.doesNotMatch(JSON.stringify(outputResult), /secret-output-token/);
			assert.doesNotMatch(JSON.stringify(errorResult), /secret-error-code/);
		});

		test('exitCode와 signal은 생략 가능하며 포함 시 유한 number만 허용한다', () => {
			const base = {
				type: 'terminal.exited',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
			};

			assertFailure(
				parseHostToWebviewMessage({ ...base, exitCode: '0' }),
				'invalid_field',
				'exitCode',
			);
			assertFailure(
				parseHostToWebviewMessage({ ...base, signal: Number.NaN }),
				'invalid_field',
				'signal',
			);
		});

		test('canRestart 타입, 필수 필드와 추가 필드를 검증한다', () => {
			const base = {
				type: 'terminal.error',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				code: 'internal_error',
				message: 'Internal error.',
				canRestart: false,
			};

			assertFailure(
				parseHostToWebviewMessage({ ...base, canRestart: 'false' }),
				'invalid_field',
				'canRestart',
			);
			const { message: unusedMessage, ...withoutMessage } = base;
			assert.strictEqual(unusedMessage, 'Internal error.');
			assertFailure(
				parseHostToWebviewMessage(withoutMessage),
				'missing_field',
				'message',
			);
			assertFailure(
				parseHostToWebviewMessage({ type: 'extension.ready', prompt: 'secret' }),
				'unexpected_field',
				'prompt',
			);
		});
	});
});

function assertFailure<Message>(
	result: MessageParseResult<Message>,
	code: MessageValidationErrorCode,
	field?: string,
): void {
	assert.strictEqual(result.ok, false);
	if (result.ok) {
		return;
	}

	assert.strictEqual(result.error.code, code);
	assert.strictEqual(result.error.field, field);
	assert.doesNotMatch(result.error.message, /secret-value|provider response|token/i);
}
