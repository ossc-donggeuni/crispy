import * as assert from 'assert';
import {
	PROVIDER_IDS,
	parseWebviewToHostMessage,
	validateWebviewToHostMessageState,
	type ProviderId,
	type StateValidationErrorCode,
	type StateValidationResult,
	type TerminalSessionState,
	type TerminalSessionStateSnapshot,
	type TerminalStateValidationSnapshot,
	type WebviewToHostWireMessage,
} from '../agent/protocol/index';

const TAB_ID = 'tab:state';
const OTHER_TAB_ID = 'tab:other';
const SESSION_ID = 'session-state';
const OTHER_SESSION_ID = 'session-other';
const PROVIDER_ID = PROVIDER_IDS[0];

suite('Host session lifecycle completion contract', () => {
	suite('상태 validator 성공', () => {
		test('allowlist provider를 선택한 새 tab의 terminal.ready를 허용한다', () => {
			const message = readyMessage();
			assertStateSuccess(
				validateWebviewToHostMessageState(message, {
					tabs: [],
					sessions: [],
				}),
				message,
			);
		});

		test('정확한 tab/session의 running input과 resize를 허용한다', () => {
			const snapshot = createSnapshot('running');
			for (const message of [inputMessage(), resizeMessage()]) {
				assertStateSuccess(
					validateWebviewToHostMessageState(message, snapshot),
					message,
				);
			}
		});

		test('exited 또는 error session의 terminal.restart를 허용한다', () => {
			for (const state of ['exited', 'error'] as const) {
				const message = restartMessage();
				assertStateSuccess(
					validateWebviewToHostMessageState(
						message,
						createSnapshot(state),
					),
					message,
				);
			}
		});

		test('알려진 tab의 terminal.visible을 허용하고 session snapshot을 변경하지 않는다', () => {
			const session = Object.freeze(createSession('running'));
			const snapshot: TerminalStateValidationSnapshot = Object.freeze({
				tabs: Object.freeze([{
					tabId: TAB_ID,
					currentSessionId: SESSION_ID,
				}]),
				sessions: Object.freeze([session]),
			});
			const message = visibleMessage(false);

			assertStateSuccess(
				validateWebviewToHostMessageState(message, snapshot),
				message,
			);
			assert.strictEqual(session.state, 'running');
		});
	});

	suite('상태 validator 실패', () => {
		test('starting, running 및 stopping tab의 중복 terminal.ready를 거부한다', () => {
			for (const state of ['starting', 'running', 'stopping'] as const) {
				assertStateFailure(
					validateWebviewToHostMessageState(
						readyMessage(),
						createSnapshot(state),
					),
					'duplicate_start',
				);
			}
		});

		test('starting, running 및 stopping session의 terminal.restart를 거부한다', () => {
			for (const state of ['starting', 'running', 'stopping'] as const) {
				assertStateFailure(
					validateWebviewToHostMessageState(
						restartMessage(),
						createSnapshot(state),
					),
					'duplicate_restart',
				);
			}
		});

		test('tabId와 sessionId의 양방향 소유 관계 불일치를 거부한다', () => {
			const snapshot: TerminalStateValidationSnapshot = {
				tabs: [{ tabId: TAB_ID, currentSessionId: OTHER_SESSION_ID }],
				sessions: [createSession('running')],
			};

			assertStateFailure(
				validateWebviewToHostMessageState(inputMessage(), snapshot),
				'ownership_mismatch',
				'sessionId',
			);
		});

		test('기존 session과 다른 provider의 ready 재시도를 거부한다', () => {
			const differentProvider = 'future-provider' as ProviderId;
			assertStateFailure(
				validateWebviewToHostMessageState(
					readyMessage(),
					createSnapshot('exited', { providerId: differentProvider }),
				),
				'provider_mismatch',
				'providerId',
			);
		});

		test('알 수 없는 tab과 알 수 없는 session을 구분한다', () => {
			assertStateFailure(
				validateWebviewToHostMessageState(inputMessage(), {
					tabs: [],
					sessions: [],
				}),
				'unknown_tab',
				'tabId',
			);
			assertStateFailure(
				validateWebviewToHostMessageState(inputMessage(OTHER_SESSION_ID), {
					tabs: [{ tabId: TAB_ID, currentSessionId: OTHER_SESSION_ID }],
					sessions: [],
				}),
				'unknown_session',
				'sessionId',
			);
		});

		test('exited 및 stopping session의 input과 resize를 모두 거부한다', () => {
			for (const state of ['exited', 'stopping'] as const) {
				for (const message of [inputMessage(), resizeMessage()]) {
					assertStateFailure(
						validateWebviewToHostMessageState(
							message,
							createSnapshot(state),
						),
						'invalid_session_state',
					);
				}
			}
		});

		test('disposed session을 대상으로 하는 모든 session 요청을 거부한다', () => {
			const snapshot = createSnapshot('disposed');
			for (const message of [
				readyMessage(),
				restartMessage(),
				inputMessage(),
				resizeMessage(),
			]) {
				assertStateFailure(
					validateWebviewToHostMessageState(message, snapshot),
					'disposed_session',
					'sessionId',
				);
			}
		});
	});

	test('상태 오류에 input 본문, 인증 정보 또는 원본 ID를 포함하지 않는다', () => {
		const sensitiveInput = 'https://auth.example?code=authorization-code&token=secret';
		const result = validateWebviewToHostMessageState(
			inputMessage(SESSION_ID, sensitiveInput),
			createSnapshot('exited'),
		);

		assertStateFailure(result, 'invalid_session_state');
		assert.doesNotMatch(
			JSON.stringify(result),
			/auth\.example|authorization-code|token|secret|tab:state|session-state/i,
		);
	});
});

/** 기본 tab/session 소유 관계를 갖는 readonly 상태 snapshot을 만든다. */
function createSnapshot(
	state: TerminalSessionState,
	overrides: Partial<TerminalSessionStateSnapshot> = {},
): TerminalStateValidationSnapshot {
	return {
		tabs: [{ tabId: TAB_ID, currentSessionId: SESSION_ID }],
		sessions: [createSession(state, overrides)],
	};
}

/** 기본 식별자와 provider를 갖는 session snapshot을 만든다. */
function createSession(
	state: TerminalSessionState,
	overrides: Partial<TerminalSessionStateSnapshot> = {},
): TerminalSessionStateSnapshot {
	return {
		tabId: TAB_ID,
		sessionId: SESSION_ID,
		providerId: PROVIDER_ID,
		state,
		disposed: state === 'disposed',
		...overrides,
	};
}

/** allowlist provider를 선택하는 terminal.ready fixture를 만든다. */
function readyMessage(): WebviewToHostWireMessage {
	return parseMessage({
		type: 'terminal.ready',
		tabId: TAB_ID,
		providerId: PROVIDER_ID,
		cols: 80,
		rows: 24,
	});
}

/** Host가 소유한 기존 session을 재사용하는 terminal.restart fixture를 만든다. */
function restartMessage(): WebviewToHostWireMessage {
	return parseMessage({
		type: 'terminal.restart',
		tabId: TAB_ID,
		sessionId: SESSION_ID,
		cols: 80,
		rows: 24,
	});
}

/** 지정 session과 본문을 사용하는 terminal.input fixture를 만든다. */
function inputMessage(
	sessionId: string = SESSION_ID,
	data: string = 'input',
): WebviewToHostWireMessage {
	return parseMessage({
		type: 'terminal.input',
		tabId: TAB_ID,
		sessionId,
		data,
	});
}

/** 기본 terminal 크기를 사용하는 terminal.resize fixture를 만든다. */
function resizeMessage(): WebviewToHostWireMessage {
	return parseMessage({
		type: 'terminal.resize',
		tabId: TAB_ID,
		sessionId: SESSION_ID,
		cols: 100,
		rows: 30,
	});
}

/** Webview visibility 변경 fixture를 만든다. */
function visibleMessage(visible: boolean): WebviewToHostWireMessage {
	return parseMessage({
		type: 'terminal.visible',
		tabId: TAB_ID,
		visible,
	});
}

/** 구조 검증을 통과한 상태 validator 입력 fixture를 반환한다. */
function parseMessage(value: unknown): WebviewToHostWireMessage {
	const result = parseWebviewToHostMessage(value);
	assert.strictEqual(result.ok, true);
	if (!result.ok) {
		throw new Error('상태 검증 fixture가 구조 검증을 통과해야 한다.');
	}

	return result.value;
}

/** 상태 validator 성공 결과와 입력 객체 보존을 단언한다. */
function assertStateSuccess<Message>(
	result: StateValidationResult<Message>,
	message: Message,
): void {
	assert.strictEqual(result.ok, true);
	if (result.ok) {
		assert.strictEqual(result.value, message);
	}
}

/** 상태 validator 실패 code와 문제 필드를 단언한다. */
function assertStateFailure<Message>(
	result: StateValidationResult<Message>,
	code: StateValidationErrorCode,
	field?: string,
): void {
	assert.strictEqual(result.ok, false);
	if (result.ok) {
		return;
	}

	assert.strictEqual(result.error.code, code);
	assert.strictEqual(result.error.field, field);
}
