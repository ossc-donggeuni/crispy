import type {
	SessionId,
	TabId,
	WebviewToHostWireMessage,
} from './messages';
import type {
	TerminalSessionStateSnapshot,
	TerminalStateValidationSnapshot,
	TerminalTabStateSnapshot,
} from './sessionState';

/** Host session 상태 검증이 외부에 노출하는 안정적인 오류 code union이다. */
export type StateValidationErrorCode =
	| 'unknown_tab'
	| 'unknown_session'
	| 'ownership_mismatch'
	| 'duplicate_start'
	| 'duplicate_restart'
	| 'invalid_session_state'
	| 'disposed_session';

/** 원본 ID나 terminal 본문을 반사하지 않는 상태 validation 오류다. */
export interface StateValidationError {
	readonly code: StateValidationErrorCode;
	readonly message: string;
	readonly field?: string;
}

/** 구조 검증을 통과한 메시지의 Host 상태 validation 결과다. */
export type StateValidationResult<Message> =
	| { readonly ok: true; readonly value: Message }
	| { readonly ok: false; readonly error: StateValidationError };

/**
 * 구조적 parser가 검증한 Webview 메시지를 현재 Host session 상태와 대조한다.
 * 입력 메시지와 snapshot을 조회만 하며 session lifecycle을 변경하지 않는다.
 *
 * @param message 구조적 parser를 통과한 Webview→Host 메시지
 * @param snapshot 한 검증 시점의 readonly tab/session 상태
 * @returns 현재 상태에서 허용된 메시지 또는 payload를 반사하지 않는 오류
 */
export function validateWebviewToHostMessageState(
	message: WebviewToHostWireMessage,
	snapshot: TerminalStateValidationSnapshot,
): StateValidationResult<WebviewToHostWireMessage> {
	switch (message.type) {
		case 'webview.ready':
			return stateValidationSuccess(message);
		case 'terminal.ready':
			return validateTerminalReady(message, snapshot);
		case 'terminal.restart':
			return validateTerminalRestart(message, snapshot);
		case 'terminal.input':
		case 'terminal.resize':
			return validateRunningSessionMessage(message, snapshot);
		case 'terminal.visible':
			return findTab(snapshot, message.tabId) === undefined
				? stateValidationFailure('unknown_tab', 'tabId')
				: stateValidationSuccess(message);
	}
}

/** terminal.ready의 최초 start 및 중복 start 규칙을 검증한다. */
function validateTerminalReady<Message extends Extract<
	WebviewToHostWireMessage,
	{ type: 'terminal.ready' }
>>(
	message: Message,
	snapshot: TerminalStateValidationSnapshot,
): StateValidationResult<Message> {
	const tab = findTab(snapshot, message.tabId);
	if (tab === undefined) {
		/* tabId는 Webview 소유이며 terminal.ready가 Host에 알리는 최초 start다. */
		return stateValidationSuccess(message);
	}
	if (tab.currentSessionId === null) {
		return stateValidationSuccess(message);
	}

	const session = findSession(snapshot, tab.currentSessionId);
	if (session === undefined) {
		return stateValidationFailure('unknown_session', 'sessionId');
	}
	if (session.tabId !== message.tabId) {
		return stateValidationFailure('ownership_mismatch', 'tabId');
	}
	if (isDisposed(session)) {
		return stateValidationFailure('disposed_session', 'sessionId');
	}
	if (
		session.state === 'starting'
		|| session.state === 'running'
		|| session.state === 'stopping'
	) {
		return stateValidationFailure('duplicate_start');
	}
	/* exited/error session은 ready 재전송 대신 terminal.restart를 사용해야 한다. */
	return stateValidationFailure('invalid_session_state');
}

/** terminal.restart의 소유 관계와 재시작 가능한 lifecycle을 검증한다. */
function validateTerminalRestart<Message extends Extract<
	WebviewToHostWireMessage,
	{ type: 'terminal.restart' }
>>(
	message: Message,
	snapshot: TerminalStateValidationSnapshot,
): StateValidationResult<Message> {
	const lookup = findOwnedSession(snapshot, message.tabId, message.sessionId);
	if (!lookup.ok) {
		return lookup;
	}

	const { session } = lookup;
	if (isDisposed(session)) {
		return stateValidationFailure('disposed_session', 'sessionId');
	}
	if (
		session.state === 'starting'
		|| session.state === 'running'
		|| session.state === 'stopping'
	) {
		return stateValidationFailure('duplicate_restart');
	}
	if (session.state !== 'exited' && session.state !== 'error') {
		return stateValidationFailure('invalid_session_state');
	}

	/* providerId는 요청에서 받지 않고 session에 기록된 값을 manager가 재사용한다. */
	return stateValidationSuccess(message);
}

/** terminal.input과 terminal.resize가 실행 중인 소유 session을 가리키는지 검증한다. */
function validateRunningSessionMessage<Message extends Extract<
	WebviewToHostWireMessage,
	{ type: 'terminal.input' | 'terminal.resize' }
>>(
	message: Message,
	snapshot: TerminalStateValidationSnapshot,
): StateValidationResult<Message> {
	const lookup = findOwnedSession(snapshot, message.tabId, message.sessionId);
	if (!lookup.ok) {
		return lookup;
	}
	if (isDisposed(lookup.session)) {
		return stateValidationFailure('disposed_session', 'sessionId');
	}
	if (lookup.session.state !== 'running') {
		return stateValidationFailure('invalid_session_state');
	}

	return stateValidationSuccess(message);
}

type OwnedSessionLookup =
	| {
		readonly ok: true;
		readonly tab: TerminalTabStateSnapshot;
		readonly session: TerminalSessionStateSnapshot;
	}
	| { readonly ok: false; readonly error: StateValidationError };

/** tab과 session의 존재 및 양방향 소유 관계를 공통 순서로 검증한다. */
function findOwnedSession(
	snapshot: TerminalStateValidationSnapshot,
	tabId: TabId,
	sessionId: SessionId,
): OwnedSessionLookup {
	const tab = findTab(snapshot, tabId);
	if (tab === undefined) {
		return stateValidationFailure('unknown_tab', 'tabId');
	}

	const session = findSession(snapshot, sessionId);
	if (session === undefined) {
		return stateValidationFailure('unknown_session', 'sessionId');
	}
	if (session.tabId !== tabId || tab.currentSessionId !== sessionId) {
		return stateValidationFailure('ownership_mismatch', 'sessionId');
	}

	return { ok: true, tab, session };
}

/** 알려진 tab을 원본 snapshot 변경 없이 조회한다. */
function findTab(
	snapshot: TerminalStateValidationSnapshot,
	tabId: TabId,
): TerminalTabStateSnapshot | undefined {
	return snapshot.tabs.find((tab) => tab.tabId === tabId);
}

/** 알려진 session을 원본 snapshot 변경 없이 조회한다. */
function findSession(
	snapshot: TerminalStateValidationSnapshot,
	sessionId: SessionId,
): TerminalSessionStateSnapshot | undefined {
	return snapshot.sessions.find((session) => session.sessionId === sessionId);
}

/** state와 별도 disposed 표지를 모두 종료된 session으로 처리한다. */
function isDisposed(session: TerminalSessionStateSnapshot): boolean {
	return session.disposed || session.state === 'disposed';
}

/** 검증된 입력 메시지 인스턴스를 변경 없이 성공 결과로 감싼다. */
function stateValidationSuccess<Value>(value: Value): StateValidationResult<Value> {
	return { ok: true, value };
}

/** payload 값을 포함하지 않는 고정 상태 validation 오류를 생성한다. */
function stateValidationFailure(
	code: StateValidationErrorCode,
	field?: string,
): { readonly ok: false; readonly error: StateValidationError } {
	return {
		ok: false,
		error: {
			code,
			message: STATE_VALIDATION_ERROR_MESSAGES[code],
			...(field === undefined ? {} : { field }),
		},
	};
}

/** 민감한 입력이나 식별자를 포함하지 않는 오류 문구 allowlist다. */
const STATE_VALIDATION_ERROR_MESSAGES: Readonly<
	Record<StateValidationErrorCode, string>
> = Object.freeze({
	unknown_tab: 'Unknown terminal tab.',
	unknown_session: 'Unknown terminal session.',
	ownership_mismatch: 'Terminal session ownership does not match.',
	duplicate_start: 'Terminal start is already in progress.',
	duplicate_restart: 'Terminal restart is already in progress.',
	invalid_session_state: 'Terminal session state does not allow this message.',
	disposed_session: 'Terminal session is disposed.',
});
