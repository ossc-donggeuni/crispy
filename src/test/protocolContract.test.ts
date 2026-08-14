import * as assert from 'assert';
import {
	ID_MAX_LENGTH,
	PROVIDER_IDS,
	TERMINAL_COLS_MAX,
	TERMINAL_COLS_MIN,
	TERMINAL_ERROR_CODES,
	TERMINAL_INPUT_MAX_BYTES,
	TERMINAL_ROWS_MAX,
	TERMINAL_ROWS_MIN,
	parseHostToWebviewMessage,
	parseWebviewToHostMessage,
	type MessageParseResult,
	type MessageValidationErrorCode,
	type ProviderRegistry,
} from '../agent/protocol/index';
import {
	HOST_TO_WEBVIEW_MESSAGE_SCHEMAS,
	WEBVIEW_TO_HOST_MESSAGE_SCHEMAS,
} from '../agent/protocol/schemas';

const TAB_ID = 'tab:contract';
const SESSION_ID = 'session-contract';

type Parser = (value: unknown) => MessageParseResult<unknown>;

interface MessageFixture {
	readonly message: Readonly<Record<string, unknown>>;
	readonly requiredFields: readonly string[];
}

const WEBVIEW_MESSAGE_FIXTURES: readonly MessageFixture[] = [
	{
		message: { type: 'webview.ready' },
		requiredFields: [],
	},
	{
		message: {
			type: 'terminal.ready',
			tabId: TAB_ID,
			providerId: PROVIDER_IDS[0],
			cols: TERMINAL_COLS_MIN,
			rows: TERMINAL_ROWS_MIN,
		},
		requiredFields: ['tabId', 'providerId', 'cols', 'rows'],
	},
	{
		message: {
			type: 'terminal.input',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: 'input',
		},
		requiredFields: ['tabId', 'sessionId', 'data'],
	},
	{
		message: {
			type: 'terminal.resize',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			cols: TERMINAL_COLS_MAX,
			rows: TERMINAL_ROWS_MAX,
		},
		requiredFields: ['tabId', 'sessionId', 'cols', 'rows'],
	},
	{
		message: {
			type: 'terminal.restart',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			cols: TERMINAL_COLS_MIN,
			rows: TERMINAL_ROWS_MAX,
		},
		requiredFields: ['tabId', 'sessionId', 'cols', 'rows'],
	},
	{
		message: {
			type: 'terminal.visible',
			tabId: TAB_ID,
			visible: true,
		},
		requiredFields: ['tabId', 'visible'],
	},
];

const HOST_MESSAGE_FIXTURES: readonly MessageFixture[] = [
	{
		message: { type: 'extension.ready' },
		requiredFields: [],
	},
	{
		message: { type: 'terminal.starting', tabId: TAB_ID },
		requiredFields: ['tabId'],
	},
	{
		message: {
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		},
		requiredFields: ['tabId', 'sessionId'],
	},
	{
		message: {
			type: 'terminal.output',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: 'output',
		},
		requiredFields: ['tabId', 'sessionId', 'data'],
	},
	{
		message: {
			type: 'terminal.exited',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			exitCode: 0,
			signal: 15,
		},
		requiredFields: ['tabId', 'sessionId'],
	},
	{
		message: {
			type: 'terminal.error',
			tabId: TAB_ID,
			sessionId: null,
			code: 'start_failed',
			message: 'Terminal start failed.',
			canRestart: true,
		},
		requiredFields: ['tabId', 'sessionId', 'code', 'message', 'canRestart'],
	},
	{
		message: {
			type: 'terminal.cleanupFailed',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			message: 'Terminal cleanup failed.',
		},
		requiredFields: ['tabId', 'sessionId', 'message'],
	},
];

suite('Host↔Webview protocol completion contract', () => {
	suite('구조적 parser 성공', () => {
		test('모든 Webview→Host message type과 provider allowlist 값을 허용한다', () => {
			assertAllParseSuccessfully(
				parseWebviewToHostMessage,
				WEBVIEW_MESSAGE_FIXTURES,
			);
		});

		test('모든 Host→Webview message type을 허용한다', () => {
			assertAllParseSuccessfully(
				parseHostToWebviewMessage,
				HOST_MESSAGE_FIXTURES,
			);
		});

		test('terminal.exited는 유한 number와 생략된 종료 정보를 허용한다', () => {
			for (const pair of [
				{ exitCode: 0, signal: 15 },
				{},
			] as const) {
				assertSuccess(parseHostToWebviewMessage({
					type: 'terminal.exited',
					tabId: TAB_ID,
					sessionId: SESSION_ID,
					...pair,
				}));
			}
		});

		test('시작 전 terminal.error의 null sessionId를 허용한다', () => {
			assertSuccess(parseHostToWebviewMessage({
				type: 'terminal.error',
				tabId: TAB_ID,
				sessionId: null,
				code: 'start_failed',
				message: 'Unable to start terminal.',
				canRestart: true,
			}));
		});

		test('cols와 rows의 최소 및 최대 경계를 허용한다', () => {
			for (const dimensions of [
				{ cols: TERMINAL_COLS_MIN, rows: TERMINAL_ROWS_MIN },
				{ cols: TERMINAL_COLS_MAX, rows: TERMINAL_ROWS_MAX },
			]) {
				assertSuccess(parseWebviewToHostMessage({
					type: 'terminal.resize',
					tabId: TAB_ID,
					sessionId: SESSION_ID,
					...dimensions,
				}));
			}
		});
	});

	suite('구조적 parser 실패', () => {
		test('null, 배열, 문자열 및 숫자를 메시지로 거부한다', () => {
			for (const value of [null, [], 'message', 42]) {
				assertFailure(
					parseWebviewToHostMessage(value),
					'invalid_message',
				);
			}
		});

		test('type 누락과 알 수 없는 type을 구분한다', () => {
			assertFailure(
				parseWebviewToHostMessage({}),
				'missing_field',
				'type',
			);
			assertFailure(
				parseWebviewToHostMessage({ type: 'terminal.unknown' }),
				'unknown_type',
				'type',
			);
		});

		test('각 Webview→Host 메시지의 필수 필드 누락과 추가 필드를 거부한다', () => {
			assertRequiredAndUnexpectedFields(
				parseWebviewToHostMessage,
				WEBVIEW_MESSAGE_FIXTURES,
			);
		});

		test('각 Host→Webview 메시지의 필수 필드 누락과 추가 필드를 거부한다', () => {
			assertRequiredAndUnexpectedFields(
				parseHostToWebviewMessage,
				HOST_MESSAGE_FIXTURES,
			);
		});

		test('allowlist 밖의 providerId와 restart의 providerId 재지정을 거부한다', () => {
			assertFailure(parseWebviewToHostMessage({
				type: 'terminal.ready',
				tabId: TAB_ID,
				providerId: 'untrusted-provider',
				cols: 80,
				rows: 24,
			}), 'provider_not_allowed', 'providerId');

			assertFailure(parseWebviewToHostMessage({
				type: 'terminal.restart',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				providerId: PROVIDER_IDS[0],
				cols: 80,
				rows: 24,
			}), 'unexpected_field', 'providerId');
		});

		test('빈 ID, 허용하지 않는 문자 및 최대 길이 초과를 거부한다', () => {
			for (const tabId of ['', 'tab with space', `t${'a'.repeat(ID_MAX_LENGTH)}`]) {
				assertFailure(parseWebviewToHostMessage({
					type: 'terminal.visible',
					tabId,
					visible: true,
				}), tabId.length > ID_MAX_LENGTH ? 'value_out_of_range' : 'invalid_field', 'tabId');
			}

			for (const sessionId of [
				'',
				'session/invalid',
				`s${'a'.repeat(ID_MAX_LENGTH)}`,
			]) {
				assertFailure(parseWebviewToHostMessage({
					type: 'terminal.input',
					tabId: TAB_ID,
					sessionId,
					data: '',
				}), sessionId.length > ID_MAX_LENGTH ? 'value_out_of_range' : 'invalid_field', 'sessionId');
			}
		});

		test('cols와 rows의 소수, 비유한 값 및 범위 초과를 거부한다', () => {
			const base = {
				type: 'terminal.resize',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				cols: 80,
				rows: 24,
			};
			const cases = [
				{ field: 'cols', value: 1.5, code: 'invalid_field' },
				{ field: 'cols', value: Number.NaN, code: 'invalid_field' },
				{ field: 'cols', value: Number.POSITIVE_INFINITY, code: 'invalid_field' },
				{ field: 'cols', value: TERMINAL_COLS_MIN - 1, code: 'value_out_of_range' },
				{ field: 'cols', value: TERMINAL_COLS_MAX + 1, code: 'value_out_of_range' },
				{ field: 'rows', value: 1.5, code: 'invalid_field' },
				{ field: 'rows', value: Number.NaN, code: 'invalid_field' },
				{ field: 'rows', value: Number.NEGATIVE_INFINITY, code: 'invalid_field' },
				{ field: 'rows', value: TERMINAL_ROWS_MIN - 1, code: 'value_out_of_range' },
				{ field: 'rows', value: TERMINAL_ROWS_MAX + 1, code: 'value_out_of_range' },
			] as const;

			for (const testCase of cases) {
				assertFailure(
					parseWebviewToHostMessage({
						...base,
						[testCase.field]: testCase.value,
					}),
					testCase.code,
					testCase.field,
				);
			}
		});

		test('잘못된 input, visible, canRestart 및 TerminalErrorCode를 거부한다', () => {
			assertFailure(parseWebviewToHostMessage({
				type: 'terminal.input',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				data: 123,
			}), 'invalid_field', 'data');
			assertFailure(parseWebviewToHostMessage({
				type: 'terminal.visible',
				tabId: TAB_ID,
				visible: 'true',
			}), 'invalid_field', 'visible');
			assertFailure(parseHostToWebviewMessage({
				type: 'terminal.error',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				code: 'internal_error',
				message: 'Error.',
				canRestart: 1,
			}), 'invalid_field', 'canRestart');
			assertFailure(parseHostToWebviewMessage({
				type: 'terminal.error',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				code: 'unknown_error_code',
				message: 'Error.',
				canRestart: false,
			}), 'invalid_field', 'code');
		});
	});

	suite('Host 실행 계약 소유권', () => {
		test('모든 Host 전용 필드를 forbidden_field로 거부한다', () => {
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
			const baseMessages = [
				WEBVIEW_MESSAGE_FIXTURES[1].message,
				WEBVIEW_MESSAGE_FIXTURES[2].message,
				WEBVIEW_MESSAGE_FIXTURES[5].message,
			];

			for (const [index, field] of forbiddenFields.entries()) {
				assertFailure(parseWebviewToHostMessage({
					...baseMessages[index % baseMessages.length],
					[field]: 'host-owned-value',
				}), 'forbidden_field', field);
			}
		});

		test('typed registry와 providerId는 Host 정의를 선택하는 key로만 사용된다', () => {
			type HostProviderDefinition = {
				readonly executable: string;
				readonly timeoutMs: number;
			};
			const registry = {
				codex: {
					executable: 'host-owned-executable',
					timeoutMs: 30_000,
				},
			} satisfies ProviderRegistry<HostProviderDefinition>;

			assert.deepStrictEqual(Object.keys(registry), [...PROVIDER_IDS]);
			const result = parseWebviewToHostMessage(
				WEBVIEW_MESSAGE_FIXTURES[1].message,
			);
			assertSuccess(result);
			if (result.ok && result.value.type === 'terminal.ready') {
				assert.strictEqual(result.value.providerId, PROVIDER_IDS[0]);
				assert.strictEqual('executable' in result.value, false);
			}
		});
	});

	suite('UTF-8 input byte 제한', () => {
		test('ASCII, 한글, emoji 및 조합 문자열의 정확한 byte 경계를 검증한다', () => {
			const cases = [
				{
					label: 'ASCII',
					atLimit: 'a'.repeat(TERMINAL_INPUT_MAX_BYTES),
				},
				{
					label: '한글',
					atLimit: `${'가'.repeat(21_845)}a`,
				},
				{
					label: 'emoji',
					atLimit: '😀'.repeat(16_384),
				},
				{
					label: '조합 Unicode',
					atLimit: `${'e\u0301'.repeat(21_845)}a`,
				},
			] as const;

			for (const testCase of cases) {
				assert.strictEqual(
					Buffer.byteLength(testCase.atLimit, 'utf8'),
					TERMINAL_INPUT_MAX_BYTES,
					testCase.label,
				);
				assertSuccess(parseInput(testCase.atLimit));
				assertFailure(
					parseInput(`${testCase.atLimit}a`),
					'value_out_of_range',
					'data',
				);
			}
		});

		test('JavaScript 길이는 제한 이하지만 UTF-8 byte 제한을 넘는 입력을 거부한다', () => {
			const input = `${'e\u0301'.repeat(21_845)}ab`;
			assert.ok(input.length < TERMINAL_INPUT_MAX_BYTES);
			assert.ok(Buffer.byteLength(input, 'utf8') > TERMINAL_INPUT_MAX_BYTES);
			assertFailure(parseInput(input), 'value_out_of_range', 'data');
		});
	});

	suite('validation 보안', () => {
		test('input, output 및 인증 관련 원본 값을 parser 오류에 포함하지 않는다', () => {
			const authorizationUrl = 'https://auth.example/callback?code=authorization-code';
			const token = 'secret-access-token';
			const inputPayload = {
				type: 'terminal.input',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				data: `${authorizationUrl}&token=${token}`,
				unexpected: true,
			};
			const outputPayload = {
				type: 'terminal.output',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				data: { providerResponse: token },
			};

			const results = [
				parseWebviewToHostMessage(inputPayload),
				parseHostToWebviewMessage(outputPayload),
				parseWebviewToHostMessage({
					...WEBVIEW_MESSAGE_FIXTURES[1].message,
					cwd: authorizationUrl,
				}),
			];

			for (const result of results) {
				assert.strictEqual(result.ok, false);
				const serialized = JSON.stringify(result);
				assert.doesNotMatch(
					serialized,
					/auth\.example|authorization-code|secret-access-token|providerResponse/i,
				);
				assert.notStrictEqual(serialized, JSON.stringify(inputPayload));
				assert.notStrictEqual(serialized, JSON.stringify(outputPayload));
			}
		});

		test('오류는 안전한 code, 고정 message와 문제 필드 이름만 제공한다', () => {
			const result = parseWebviewToHostMessage({
				type: 'terminal.input',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				data: 123,
			});

			assert.deepStrictEqual(result, {
				ok: false,
				error: {
					code: 'invalid_field',
					message: "Invalid field 'data'.",
					field: 'data',
				},
			});
		});
	});

	suite('output 전달 계약', () => {
		test('terminal.output은 sessionId와 data를 필수로 요구한다', () => {
			for (const field of ['sessionId', 'data'] as const) {
				assertFailure(
					parseHostToWebviewMessage(withoutField(
						HOST_MESSAGE_FIXTURES[3].message,
						field,
					)),
					'missing_field',
					field,
				);
			}
		});

		test('ACK, sequence, 부분 폐기 및 replay protocol이 정의되어 있지 않다', () => {
			const messageTypes = [
				...Object.keys(WEBVIEW_TO_HOST_MESSAGE_SCHEMAS),
				...Object.keys(HOST_TO_WEBVIEW_MESSAGE_SCHEMAS),
			];
			assert.strictEqual(
				messageTypes.some((type) => /ack|partial|drop|discard|truncate|replay/i.test(type)),
				false,
			);
			assertFailure(parseHostToWebviewMessage({
				type: 'terminal.output',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				data: 'output',
				sequence: 1,
			}), 'unexpected_field', 'sequence');
		});
	});
});

/** 모든 fixture가 parser를 통과하고 허용 필드만 새 객체로 복사되는지 확인한다. */
function assertAllParseSuccessfully(
	parser: Parser,
	fixtures: readonly MessageFixture[],
): void {
	for (const fixture of fixtures) {
		const result = parser(fixture.message);
		assertSuccess(result);
		if (result.ok) {
			assert.deepStrictEqual(result.value, fixture.message);
			assert.notStrictEqual(result.value, fixture.message);
		}
	}
}

/** 각 메시지의 필수 필드와 정확한 추가 필드 거부 계약을 전수 검사한다. */
function assertRequiredAndUnexpectedFields(
	parser: Parser,
	fixtures: readonly MessageFixture[],
): void {
	for (const fixture of fixtures) {
		for (const field of fixture.requiredFields) {
			assertFailure(
				parser(withoutField(fixture.message, field)),
				'missing_field',
				field,
			);
		}
		assertFailure(
			parser({ ...fixture.message, unexpected: true }),
			'unexpected_field',
			'unexpected',
		);
	}
}

/** 원본 fixture를 변경하지 않고 지정 필드를 제외한 메시지 후보를 만든다. */
function withoutField(
	message: Readonly<Record<string, unknown>>,
	field: string,
): Record<string, unknown> {
	const candidate = { ...message };
	delete candidate[field];
	return candidate;
}

/** terminal.input fixture를 공통 ID와 주어진 본문으로 검증한다. */
function parseInput(data: unknown): MessageParseResult<unknown> {
	return parseWebviewToHostMessage({
		type: 'terminal.input',
		tabId: TAB_ID,
		sessionId: SESSION_ID,
		data,
	});
}

/** parser 성공 결과인지 단언한다. */
function assertSuccess<Message>(result: MessageParseResult<Message>): void {
	assert.strictEqual(result.ok, true);
}

/** parser 실패 code와 문제 필드 이름이 예상값과 같은지 단언한다. */
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
}
