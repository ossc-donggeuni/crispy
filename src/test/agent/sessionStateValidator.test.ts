import * as assert from 'assert';
import {
	PROVIDER_IDS,
	parseWebviewToHostMessage,
	validateWebviewToHostMessageState,
	type StateValidationErrorCode,
	type StateValidationResult,
	type TerminalSessionState,
	type TerminalSessionStateSnapshot,
	type TerminalStateValidationSnapshot,
	type WebviewToHostWireMessage,
} from '../../agent/protocol/index';

const TAB_ID = 'tab:one';
const OTHER_TAB_ID = 'tab:two';
const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';
const PROVIDER_ID = PROVIDER_IDS[0];

suite('Host session state validator', () => {
	test('webview.ready는 terminal 상태와 무관하게 통과한다', () => {
		const message = parseMessage({ type: 'webview.ready' });
		const result = validateWebviewToHostMessageState(message, {
			tabs: [],
			sessions: [],
		});

		assertSuccess(result, message);
	});

	suite('terminal.ready', () => {
		test('알려진 tab에 현재 session이 없을 때 최초 start를 허용한다', () => {
			const message = readyMessage();
			const result = validateWebviewToHostMessageState(
				message,
				createSnapshotWithoutSession(),
			);

			assertSuccess(result, message);
		});

		test('Webview가 소유한 새 tab의 최초 start를 허용한다', () => {
			const message = readyMessage();
			assertSuccess(
				validateWebviewToHostMessageState(message, {
					tabs: [],
					sessions: [],
				}),
				message,
			);
		});

		test('starting, running, stopping session의 중복 start를 거부한다', () => {
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

		test('exited 또는 error session은 ready 대신 restart를 요구한다', () => {
			for (const state of ['exited', 'error'] as const) {
				assertStateFailure(
					validateWebviewToHostMessageState(
						readyMessage(),
						createSnapshot(state),
					),
					'invalid_session_state',
				);
			}
		});
	});

	suite('terminal.restart', () => {
		test('정확히 연결된 exited 또는 error session의 restart를 허용한다', () => {
			for (const state of ['exited', 'error'] as const) {
				const message = restartMessage();
				assertSuccess(
					validateWebviewToHostMessageState(message, createSnapshot(state)),
					message,
				);
			}
		});

		test('starting, running, stopping 상태의 중복 restart를 거부한다', () => {
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

		test('disposed 상태 또는 disposed 표지를 구분해 거부한다', () => {
			for (const snapshot of [
				createSnapshot('disposed'),
				createSnapshot('exited', { disposed: true }),
			]) {
				assertStateFailure(
					validateWebviewToHostMessageState(restartMessage(), snapshot),
					'disposed_session',
					'sessionId',
				);
			}
		});
	});

	suite('session ownership', () => {
		test('알 수 없는 tab과 session을 구분한다', () => {
			const message = inputMessage('safe input');

			assertStateFailure(
				validateWebviewToHostMessageState(message, {
					tabs: [],
					sessions: [],
				}),
				'unknown_tab',
				'tabId',
			);
			assertStateFailure(
				validateWebviewToHostMessageState(message, createSnapshotWithoutSession()),
				'unknown_session',
				'sessionId',
			);
		});

		test('session의 tabId 또는 tab의 현재 session이 다르면 거부한다', () => {
			const wrongSessionOwner = createSnapshot('running', {
				tabId: OTHER_TAB_ID,
			});
			const wrongCurrentSession: TerminalStateValidationSnapshot = {
				tabs: [{ tabId: TAB_ID, currentSessionId: OTHER_SESSION_ID }],
				sessions: [createSession('running')],
			};

			for (const snapshot of [wrongSessionOwner, wrongCurrentSession]) {
				assertStateFailure(
					validateWebviewToHostMessageState(
						inputMessage('safe input'),
						snapshot,
					),
					'ownership_mismatch',
					'sessionId',
				);
			}
		});
	});

	suite('terminal.input and terminal.resize', () => {
		test('소유 관계가 맞는 running session에서만 허용한다', () => {
			const snapshot = createSnapshot('running');
			const input = inputMessage('hello');
			const resize = resizeMessage();

			assertSuccess(
				validateWebviewToHostMessageState(input, snapshot),
				input,
			);
			assertSuccess(
				validateWebviewToHostMessageState(resize, snapshot),
				resize,
			);
		});

		test('running 이외의 lifecycle을 거부한다', () => {
			for (const state of [
				'starting',
				'stopping',
				'exited',
				'error',
			] as const) {
				assertStateFailure(
					validateWebviewToHostMessageState(
						resizeMessage(),
						createSnapshot(state),
					),
					'invalid_session_state',
				);
			}
		});

		test('input 검증 오류에 input 본문이나 원본 ID를 포함하지 않는다', () => {
			const sensitiveInput = 'authorization code=secret-token';
			const message = inputMessage(sensitiveInput);
			const result = validateWebviewToHostMessageState(
				message,
				createSnapshot('exited'),
			);

			assertStateFailure(result, 'invalid_session_state');
			assert.doesNotMatch(
				JSON.stringify(result),
				/authorization|secret-token|tab:one|session-1/i,
			);
		});
	});

	suite('terminal.visible', () => {
		test('알려진 tab만 허용하고 session lifecycle을 요구하지 않는다', () => {
			const message = visibleMessage();
			assertSuccess(
				validateWebviewToHostMessageState(message, createSnapshotWithoutSession()),
				message,
			);
			assertStateFailure(
				validateWebviewToHostMessageState(message, { tabs: [], sessions: [] }),
				'unknown_tab',
				'tabId',
			);
		});
	});

	suite('agent.reset', () => {
		test('알려진 tab은 session lifecycle과 무관하게 reset할 수 있다', () => {
			const message = parseMessage({ type: 'agent.reset', tabId: TAB_ID });
			assertSuccess(
				validateWebviewToHostMessageState(message, createSnapshot('running')),
				message,
			);
			assertStateFailure(
				validateWebviewToHostMessageState(message, { tabs: [], sessions: [] }),
				'unknown_tab',
				'tabId',
			);
		});
	});

	test('입력 메시지와 readonly snapshot을 변경하지 않는다', () => {
		const message = Object.freeze(inputMessage('immutable input'));
		const session = Object.freeze(createSession('running'));
		const tab = Object.freeze({ tabId: TAB_ID, currentSessionId: SESSION_ID });
		const snapshot: TerminalStateValidationSnapshot = Object.freeze({
			tabs: Object.freeze([tab]),
			sessions: Object.freeze([session]),
		});
		const before = JSON.stringify(snapshot);

		assertSuccess(
			validateWebviewToHostMessageState(message, snapshot),
			message,
		);
		assert.strictEqual(JSON.stringify(snapshot), before);
		assert.strictEqual(snapshot.tabs[0], tab);
		assert.strictEqual(snapshot.sessions[0], session);
	});
});

function createSnapshotWithoutSession(): TerminalStateValidationSnapshot {
	return {
		tabs: [{ tabId: TAB_ID, currentSessionId: null }],
		sessions: [],
	};
}

function createSnapshot(
	state: TerminalSessionState,
	overrides: Partial<TerminalSessionStateSnapshot> = {},
): TerminalStateValidationSnapshot {
	return {
		tabs: [{ tabId: TAB_ID, currentSessionId: SESSION_ID }],
		sessions: [createSession(state, overrides)],
	};
}

function createSession(
	state: TerminalSessionState,
	overrides: Partial<TerminalSessionStateSnapshot> = {},
): TerminalSessionStateSnapshot {
	return {
		tabId: TAB_ID,
		sessionId: SESSION_ID,
		providerId: PROVIDER_ID,
		state,
		disposed: false,
		...overrides,
	};
}

function readyMessage(): WebviewToHostWireMessage {
	return parseMessage({
		type: 'terminal.ready',
		tabId: TAB_ID,
		cols: 80,
		rows: 24,
	});
}

function restartMessage(): WebviewToHostWireMessage {
	return parseMessage({
		type: 'terminal.restart',
		tabId: TAB_ID,
		sessionId: SESSION_ID,
	});
}

function inputMessage(data: string): WebviewToHostWireMessage {
	return parseMessage({
		type: 'terminal.input',
		tabId: TAB_ID,
		sessionId: SESSION_ID,
		data,
	});
}

function resizeMessage(): WebviewToHostWireMessage {
	return parseMessage({
		type: 'terminal.resize',
		tabId: TAB_ID,
		sessionId: SESSION_ID,
		cols: 100,
		rows: 30,
	});
}

function visibleMessage(): WebviewToHostWireMessage {
	return parseMessage({
		type: 'terminal.visible',
		tabId: TAB_ID,
		visible: true,
	});
}

function parseMessage(value: unknown): WebviewToHostWireMessage {
	const result = parseWebviewToHostMessage(value);
	assert.strictEqual(result.ok, true);
	if (!result.ok) {
		throw new Error('Test fixture must pass structural validation.');
	}

	return result.value;
}

function assertSuccess<Message>(
	result: StateValidationResult<Message>,
	message: Message,
): void {
	assert.strictEqual(result.ok, true);
	if (result.ok) {
		assert.strictEqual(result.value, message);
	}
}

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
