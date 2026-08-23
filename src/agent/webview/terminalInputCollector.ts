import type { SessionId, TabId } from '../protocol';
import { createAutomaticAgentTabTitleCandidates } from '../UI/agentTabTitle';

/** 한 Terminal 세션에서 안전하게 복원하는 입력 buffer의 UTF-8 상한이다. */
export const TERMINAL_TITLE_BUFFER_MAX_BYTES = 16 * 1024;

/** xterm bracketed paste 시작 marker다. */
export const BRACKETED_PASTE_START = '\u001b[200~';

/** xterm bracketed paste 종료 marker다. */
export const BRACKETED_PASTE_END = '\u001b[201~';

/** xterm이 PTY 요청에 답하면서 `onData`로 내보내는 CSI 응답 형식이다. */
const XTERM_CSI_PROTOCOL_RESPONSE =
	/^\u001b\[(?:[IO]|[?>=]?\d+(?:;\d+)*c|\??\d+n|\??\d+;\d+R|\??\d+;[0-4]\$y|[468];\d+;\d+t)$/u;

/** xterm의 DECRQSS 응답 형식이다. */
const XTERM_DCS_PROTOCOL_RESPONSE =
	/^\u001bP(?:0|1\$r[\u0020-\u007e]*)\u001b\\$/u;

/** xterm의 palette, foreground, background, cursor 색상 응답 형식이다. */
const XTERM_OSC_COLOR_RESPONSE =
	/^\u001b\](?:4;\d{1,3}|1[012]);rgb:(?:[\da-f]{4}\/){2}[\da-f]{4}\u001b\\$/iu;

/**
 * xterm이 애플리케이션의 장치·상태 조회에 답하며 한 `onData` event로 보낸 값인지 판별한다.
 * 공개 `onData` API는 사용자 입력과 이 응답을 같은 경계로 노출하므로 자동 제목 복원에서만
 * 제외한다. 방향키, 편집키, bracketed paste marker와 임의 Escape sequence는 포함하지 않는다.
 *
 * @param data xterm의 단일 `onData` event 값
 * @returns xterm 자체가 생성하는 알려진 protocol 응답이면 true
 */
export function isXtermProtocolResponse(data: string): boolean {
	return XTERM_CSI_PROTOCOL_RESPONSE.test(data)
		|| XTERM_DCS_PROTOCOL_RESPONSE.test(data)
		|| XTERM_OSC_COLOR_RESPONSE.test(data);
}

/** 자동 제목 callback이 원문 대신 전달하는 파생 후보 정보다. */
export interface TerminalTitleCandidateEvent {
	readonly tabId: TabId;
	readonly sessionId: SessionId;
	readonly candidates: readonly string[];
}

/** 원문을 노출하지 않는 collector 진단 상태다. */
export interface TerminalInputCollectorState {
	readonly sessionId?: SessionId;
	readonly bufferByteLength: number;
	readonly inBracketedPaste: boolean;
	readonly abandoned: boolean;
	readonly attempted: boolean;
}

/** Terminal 입력 전달과 독립적으로 자동 제목용 입력을 복원하는 경계다. */
export interface TerminalInputCollector {
	/** 다른 식별자의 fresh session에서만 임시 상태를 초기화한다. */
	startSession(sessionId: SessionId): void;

	/** 정확한 current session이 끝난 경우 모든 원문 참조를 폐기한다. */
	endSession(sessionId: SessionId): void;

	/** current session의 xterm 입력 조각을 순서대로 처리한다. */
	handleData(sessionId: SessionId, data: string): void;

	/** 수동 이름처럼 현재 수집이 불필요해지면 미완성 입력만 폐기한다. */
	clearInput(): void;

	/** 원문을 포함하지 않는 현재 진단 상태를 반환한다. */
	getState(): TerminalInputCollectorState;

	/** 모든 원문과 session 참조를 제거하고 이후 입력을 무시한다. */
	dispose(): void;
}

/**
 * 탭 하나의 current Terminal session 입력을 fail-closed 방식으로 복원한다.
 * 지원하지 않는 제어 sequence나 16 KiB 초과가 발견되면 그 세션 전체를 포기한다.
 *
 * @param tabId collector를 소유하는 탭
 * @param onCandidate 안전 후보에서 파생된 제목 후보만 받는 callback
 * @returns session lifecycle과 입력 처리를 제공하는 collector
 */
export function createTerminalInputCollector(
	tabId: TabId,
	onCandidate: (event: TerminalTitleCandidateEvent) => void,
): TerminalInputCollector {
	const encoder = new TextEncoder();
	let currentSessionId: SessionId | undefined;
	let buffer = '';
	let inBracketedPaste = false;
	let pendingEscape = '';
	let suppressNextLineFeed = false;
	let abandoned = false;
	let attempted = false;
	let disposed = false;

	/** 모든 복원 원문 참조와 부분 sequence를 제거한다. */
	const discardInput = (): void => {
		buffer = '';
		pendingEscape = '';
		inBracketedPaste = false;
		suppressNextLineFeed = false;
	};

	/** 현재 세션에서 더 이상 자동 제목을 시도하지 않게 한다. */
	const abandonSession = (): void => {
		discardInput();
		abandoned = true;
	};

	/** UTF-8 상한을 확인하며 복원 문자열을 추가한다. */
	const append = (value: string): boolean => {
		const nextBuffer = `${buffer}${value}`;
		if (encoder.encode(nextBuffer).byteLength > TERMINAL_TITLE_BUFFER_MAX_BYTES) {
			abandonSession();
			return false;
		}

		buffer = nextBuffer;
		return true;
	};

	/** Backspace를 Unicode code point 하나에만 적용한다. */
	const removeLastCodePoint = (): void => {
		const codePoints = Array.from(buffer);
		codePoints.pop();
		buffer = codePoints.join('');
	};

	/** Ctrl+W를 마지막 공백 구분 token과 앞쪽 공백에 적용한다. */
	const removeLastToken = (): void => {
		buffer = buffer.replace(/\s*\S+\s*$/u, '');
	};

	/** 제출된 한 행을 검사하고 원문을 즉시 폐기한다. */
	const submit = (): void => {
		const submittedInput = buffer;
		buffer = '';
		if (submittedInput.length === 0) {
			return;
		}

		let candidates: readonly string[] | undefined;
		try {
			candidates = createAutomaticAgentTabTitleCandidates(submittedInput);
		} catch {
			abandonSession();
			return;
		}

		if (candidates === undefined) {
			return;
		}

		attempted = true;
		const sessionId = currentSessionId;
		if (sessionId === undefined) {
			return;
		}

		try {
			onCandidate(Object.freeze({
				tabId,
				sessionId,
				candidates,
			}));
		} catch {
			/** 제목 UI 실패가 이미 전달된 Terminal 입력 경로로 전파되지 않게 한다. */
		}
	};

	/** Escape marker 한 글자를 이어 붙이고 완성 또는 실패를 판정한다. */
	const consumeEscapeCodePoint = (codePoint: string): void => {
		pendingEscape += codePoint;
		const expectedMarker = inBracketedPaste
			? BRACKETED_PASTE_END
			: BRACKETED_PASTE_START;

		if (expectedMarker === pendingEscape) {
			inBracketedPaste = !inBracketedPaste;
			pendingEscape = '';
			return;
		}

		if (!expectedMarker.startsWith(pendingEscape)) {
			abandonSession();
		}
	};

	return {
		startSession(sessionId): void {
			if (disposed || currentSessionId === sessionId) {
				return;
			}

			discardInput();
			currentSessionId = sessionId;
			abandoned = false;
			attempted = false;
		},

		endSession(sessionId): void {
			if (currentSessionId !== sessionId) {
				return;
			}

			discardInput();
			currentSessionId = undefined;
			abandoned = false;
			attempted = false;
		},

		handleData(sessionId, data): void {
			if (
				disposed
				|| currentSessionId !== sessionId
				|| abandoned
				|| attempted
			) {
				return;
			}

			for (const codePoint of data) {
				if (abandoned || attempted) {
					break;
				}

				if (pendingEscape.length > 0) {
					consumeEscapeCodePoint(codePoint);
					continue;
				}

				if (codePoint === '\u001b') {
					pendingEscape = codePoint;
					continue;
				}

				if (suppressNextLineFeed) {
					suppressNextLineFeed = false;
					if (codePoint === '\n') {
						continue;
					}
				}

				if (inBracketedPaste) {
					if (codePoint === '\r' || codePoint === '\n') {
						if (codePoint === '\r') {
							suppressNextLineFeed = true;
						}
						append(' ');
						continue;
					}
					if (/\p{Cc}/u.test(codePoint)) {
						abandonSession();
						continue;
					}
					append(codePoint);
					continue;
				}

				switch (codePoint) {
					case '\b':
					case '\u007f':
						removeLastCodePoint();
						break;
					case '\r':
						submit();
						suppressNextLineFeed = true;
						break;
					case '\n':
						submit();
						break;
					case '\u0003':
						buffer = '';
						break;
					case '\u0015':
						buffer = '';
						break;
					case '\u0017':
						removeLastToken();
						break;
					default:
						if (/\p{Cc}/u.test(codePoint)) {
							abandonSession();
						} else {
							append(codePoint);
						}
				}
			}
		},

		clearInput(): void {
			if (!disposed) {
				discardInput();
			}
		},

		getState(): TerminalInputCollectorState {
			return Object.freeze({
				...(currentSessionId === undefined ? {} : { sessionId: currentSessionId }),
				bufferByteLength: encoder.encode(buffer).byteLength,
				inBracketedPaste,
				abandoned,
				attempted,
			});
		},

		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			discardInput();
			currentSessionId = undefined;
			abandoned = false;
			attempted = false;
		},
	};
}
