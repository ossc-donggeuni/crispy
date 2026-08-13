import { TERMINAL_POLICY } from './policy';

/** Webview에 표시 가능한 terminal 오류의 안정적인 식별자다. */
export type TerminalErrorCode =
	| 'invalid_workspace'
	| 'spawn_failed'
	| 'buffer_overflow'
	| 'cleanup_failed';

/** 1단계 Webview가 Host에 요청할 수 있는 terminal 동작이다. */
export type TerminalWebviewMessage =
	| { type: 'terminal/ready'; payload: TerminalDimensions }
	| { type: 'terminal/restart'; payload: TerminalDimensions }
	| { type: 'terminal/input'; payload: { sessionId: string; data: string } }
	| { type: 'terminal/resize'; payload: { sessionId: string } & TerminalDimensions };

/** Host가 Webview에 전달하는 session 상태와 순서 보존 출력이다. */
export type TerminalHostMessage =
	| { type: 'terminal/starting'; payload: { shellLabel: string } }
	| {
		type: 'terminal/started';
		payload: { sessionId: string; cwd: string; shellLabel: string };
	}
	| { type: 'terminal/output'; payload: { sessionId: string; data: string } }
	| {
		type: 'terminal/exited';
		payload: { sessionId: string; exitCode: number; signal?: number };
	}
	| {
		type: 'terminal/error';
		payload: {
			code: TerminalErrorCode;
			message: string;
			recoverable: boolean;
			sessionId?: string;
		};
	};

/** PTY와 xterm이 공유하는 검증된 terminal 크기다. */
interface TerminalDimensions {
	cols: number;
	rows: number;
}

/**
 * 값이 배열이 아닌 일반 객체인지 확인한다.
 *
 * @param value 검사할 원본 값
 * @returns 문자열 key를 가진 객체인지 여부
 */
const isRecord = (value: unknown): value is Record<string, unknown> => (
	typeof value === 'object' && value !== null && !Array.isArray(value)
);

/**
 * 객체가 허용된 key만 정확히 포함하는지 확인한다.
 *
 * @param value key를 검사할 객체
 * @param keys 허용할 key 목록
 * @returns 누락되거나 추가된 key 없이 정확히 일치하는지 여부
 */
const hasExactKeys = (
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean => {
	const actualKeys = Object.keys(value);
	return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
};

/**
 * 값이 정책 범위 안의 terminal 열 또는 행 수인지 확인한다.
 *
 * @param value 검사할 크기 후보
 * @returns 허용된 정수 크기인지 여부
 */
const isDimension = (value: unknown): value is number => (
	Number.isInteger(value)
	&& Number(value) >= TERMINAL_POLICY.minDimension
	&& Number(value) <= TERMINAL_POLICY.maxDimension
);

/**
 * 값이 유효한 열과 행을 모두 포함하는지 확인한다.
 *
 * @param value 검사할 terminal 크기 후보
 * @returns 유효한 TerminalDimensions인지 여부
 */
const isDimensions = (value: unknown): value is TerminalDimensions => (
	isRecord(value)
	&& hasExactKeys(value, ['cols', 'rows'])
	&& isDimension(value.cols)
	&& isDimension(value.rows)
);

/**
 * 문자열이 Host session ID 제한을 만족하는지 확인한다.
 *
 * @param value 검사할 session ID 후보
 * @returns 허용된 길이의 비어 있지 않은 문자열인지 여부
 */
const isSessionId = (value: unknown): value is string => (
	typeof value === 'string'
	&& value.length > 0
	&& value.length <= TERMINAL_POLICY.maxSessionIdLength
);

/**
 * Webview 원본 입력을 allowlist와 제한값으로 검증한다.
 *
 * @param value Webview에서 수신한 원본 값
 * @returns 허용된 Webview 메시지인지 여부
 */
export function isTerminalWebviewMessage(value: unknown): value is TerminalWebviewMessage {
	if (!isRecord(value) || !hasExactKeys(value, ['type', 'payload'])) {
		return false;
	}

	if (value.type === 'terminal/ready' || value.type === 'terminal/restart') {
		return isDimensions(value.payload);
	}

	if (!isRecord(value.payload)) {
		return false;
	}

	switch (value.type) {
		case 'terminal/input':
			return hasExactKeys(value.payload, ['sessionId', 'data'])
				&& isSessionId(value.payload.sessionId)
				&& typeof value.payload.data === 'string'
				&& new TextEncoder().encode(value.payload.data).byteLength
					<= TERMINAL_POLICY.maxInputBytes;
		case 'terminal/resize':
			return hasExactKeys(value.payload, ['sessionId', 'cols', 'rows'])
				&& isSessionId(value.payload.sessionId)
				&& isDimension(value.payload.cols)
				&& isDimension(value.payload.rows);
		default:
			return false;
	}
}

/**
 * Webview가 수신한 Host 메시지를 렌더링 전에 검증한다.
 *
 * @param value window message event에서 받은 원본 값
 * @returns 허용된 Host 메시지인지 여부
 */
export function isTerminalHostMessage(value: unknown): value is TerminalHostMessage {
	if (!isRecord(value) || !hasExactKeys(value, ['type', 'payload']) || !isRecord(value.payload)) {
		return false;
	}

	switch (value.type) {
		case 'terminal/starting':
			return hasExactKeys(value.payload, ['shellLabel'])
				&& typeof value.payload.shellLabel === 'string';
		case 'terminal/started':
			return hasExactKeys(value.payload, ['sessionId', 'cwd', 'shellLabel'])
				&& isSessionId(value.payload.sessionId)
				&& typeof value.payload.cwd === 'string'
				&& typeof value.payload.shellLabel === 'string';
		case 'terminal/output':
			return hasExactKeys(value.payload, ['sessionId', 'data'])
				&& isSessionId(value.payload.sessionId)
				&& typeof value.payload.data === 'string';
		case 'terminal/exited': {
			const keys = value.payload.signal === undefined
				? ['sessionId', 'exitCode']
				: ['sessionId', 'exitCode', 'signal'];
			return hasExactKeys(value.payload, keys)
				&& isSessionId(value.payload.sessionId)
				&& Number.isInteger(value.payload.exitCode)
				&& (value.payload.signal === undefined || Number.isInteger(value.payload.signal));
		}
		case 'terminal/error': {
			const keys = value.payload.sessionId === undefined
				? ['code', 'message', 'recoverable']
				: ['code', 'message', 'recoverable', 'sessionId'];
			return hasExactKeys(value.payload, keys)
				&& isTerminalErrorCode(value.payload.code)
				&& typeof value.payload.message === 'string'
				&& typeof value.payload.recoverable === 'boolean'
				&& (value.payload.sessionId === undefined || isSessionId(value.payload.sessionId));
		}
		default:
			return false;
	}
}

/**
 * 값이 알려진 terminal 오류 code인지 확인한다.
 *
 * @param value 검사할 오류 code 후보
 * @returns TerminalErrorCode allowlist에 포함되는지 여부
 */
function isTerminalErrorCode(value: unknown): value is TerminalErrorCode {
	return value === 'invalid_workspace'
		|| value === 'spawn_failed'
		|| value === 'buffer_overflow'
		|| value === 'cleanup_failed';
}
