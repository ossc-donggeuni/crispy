/** Extension Host와 Chat Webview 사이의 3.5단계 메시지 계약을 정의한다. */

import {
	isChatTimelineItemKind,
	isChatTimelineItemState,
	type ChatTimelineItem,
} from '../chatTimeline';

/** 최근 대화 목록에 표시하는 메모리 내 대화 요약이다. */
export interface CodexChatSessionView {
	/** draft와 Codex Thread 모두를 Webview 선택에 사용하는 Host 식별자다. */
	id: string;
	/** 첫 사용자 메시지에서 만든 대화 제목이다. */
	title: string;
	/** 최근 상태 변경을 나타내는 ISO 8601 시각이다. */
	lastResponseAt: string;
}

/** 선택된 대화의 전체 표시 상태를 Webview에 전달하는 snapshot이다. */
export interface CodexChatViewSnapshot {
	/** 현재 Chat Panel에 표시할 draft 또는 Thread 대화 ID다. */
	selectedConversationId: string;
	/** 최근 대화 팝오버에 표시할 메모리 내 세션 목록이다. */
	sessions: readonly CodexChatSessionView[];
	/** 선택된 대화의 순서가 보존된 Provider 공통 timeline이다. */
	items: readonly ChatTimelineItem[];
	/** 선택된 Thread에 활성 Turn 또는 첫 전송 작업이 있는지 나타낸다. */
	isRunning: boolean;
	/** 연결과 Workspace가 준비되어 새 Turn을 보낼 수 있는지 나타낸다. */
	composerAvailable: boolean;
	/** 최근 요청 또는 Turn 실패를 사용자에게 표시하는 설명이다. */
	error: string | null;
}

/** Webview가 Host에 전달하는 준비 완료 메시지다. */
export interface CodexChatReadyMessage {
	/** 초기 snapshot을 요청하는 고정 discriminator다. */
	type: 'codexChat/ready';
}

/** Webview가 Host에 빈 draft 생성을 요청하는 메시지다. */
export interface CodexChatNewDraftMessage {
	/** 새 대화 버튼의 고정 discriminator다. */
	type: 'codexChat/newDraft';
}

/** Webview가 최근 대화 중 하나를 선택하는 메시지다. */
export interface CodexChatSelectConversationMessage {
	/** 세션 선택의 고정 discriminator다. */
	type: 'codexChat/selectConversation';
	/** Host가 발급한 대화 식별자를 포함하는 payload다. */
	payload: {
		/** 선택할 draft 또는 Thread 대화 ID다. */
		conversationId: string;
	};
}

/** Webview가 선택된 대화에 텍스트 Turn을 요청하는 메시지다. */
export interface CodexChatSendMessage {
	/** 사용자 입력 전송의 고정 discriminator다. */
	type: 'codexChat/send';
	/** 대상 대화와 공백 제거 전 원문을 포함하는 payload다. */
	payload: {
		/** snapshot에서 받은 draft 또는 Thread 대화 ID다. */
		conversationId: string;
		/** Codex에 보낼 사용자 텍스트다. */
		text: string;
	};
}

/** Webview가 검증을 Host에 위임할 외부 Markdown 링크 요청이다. */
export interface ChatOpenExternalMessage {
	/** Provider와 무관한 외부 링크 요청 discriminator다. */
	type: 'chat/openExternal';
	/** 사용자가 클릭한 원본 URL을 포함한다. */
	payload: {
		/** Host가 다시 파싱하고 scheme을 검증할 절대 URL이다. */
		url: string;
	};
}

/** Chat Webview가 보낼 수 있는 3단계 메시지 union이다. */
export type CodexChatWebviewMessage = CodexChatReadyMessage
	| CodexChatNewDraftMessage
	| CodexChatSelectConversationMessage
	| CodexChatSendMessage
	| ChatOpenExternalMessage;

/** Host가 Chat Webview에 보내는 snapshot 메시지다. */
export interface CodexChatSnapshotMessage {
	/** snapshot 갱신의 고정 discriminator다. */
	type: 'codexChat/snapshot';
	/** Webview가 한 번에 적용할 불변 표시 상태다. */
	payload: CodexChatViewSnapshot;
}

/** Extension Host가 Chat Webview에 보낼 수 있는 3단계 메시지 union이다. */
export type CodexChatHostMessage = CodexChatSnapshotMessage;

/**
 * Webview에서 받은 unknown 값이 허용된 3단계 메시지인지 검사한다.
 *
 * @param value VS Code Webview transport가 전달한 외부 값.
 * @returns discriminator와 method별 payload가 유효하면 `true`.
 */
export function isCodexChatWebviewMessage(
	value: unknown,
): value is CodexChatWebviewMessage {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
	}

	switch (value.type) {
		case 'codexChat/ready':
		case 'codexChat/newDraft':
			return true;
		case 'codexChat/selectConversation':
			return isRecord(value.payload)
				&& isNonEmptyString(value.payload.conversationId);
		case 'codexChat/send':
			return isRecord(value.payload)
				&& isNonEmptyString(value.payload.conversationId)
				&& typeof value.payload.text === 'string';
		case 'chat/openExternal':
			return isRecord(value.payload)
				&& isNonEmptyString(value.payload.url);
		default:
			return false;
	}
}

/**
 * Host에서 받은 unknown 값이 완전한 snapshot 메시지인지 검사한다.
 *
 * @param value Webview message event가 전달한 외부 값.
 * @returns snapshot의 모든 UI 소비 필드가 유효하면 `true`.
 */
export function isCodexChatHostMessage(value: unknown): value is CodexChatHostMessage {
	return isRecord(value)
		&& value.type === 'codexChat/snapshot'
		&& isCodexChatViewSnapshot(value.payload);
}

/**
 * unknown 값을 Chat snapshot의 전체 표시 계약과 대조한다.
 *
 * @param value 검사할 snapshot 후보.
 * @returns 모든 중첩 session과 item이 유효하면 `true`.
 */
function isCodexChatViewSnapshot(value: unknown): value is CodexChatViewSnapshot {
	return isRecord(value)
		&& isNonEmptyString(value.selectedConversationId)
		&& Array.isArray(value.sessions)
		&& value.sessions.every(isSessionView)
		&& Array.isArray(value.items)
		&& value.items.every(isTimelineItemView)
		&& typeof value.isRunning === 'boolean'
		&& typeof value.composerAvailable === 'boolean'
		&& (value.error === null || typeof value.error === 'string');
}

/**
 * 세션 요약의 Webview 표시 필드를 검사한다.
 *
 * @param value 검사할 세션 후보.
 * @returns 필수 문자열이 모두 유효하면 `true`.
 */
function isSessionView(value: unknown): value is CodexChatSessionView {
	return isRecord(value)
		&& isNonEmptyString(value.id)
		&& typeof value.title === 'string'
		&& isIsoDateString(value.lastResponseAt);
}

/**
 * timeline Item의 core 5 discriminator와 표시 필드를 검사한다.
 *
 * @param value 검사할 timeline Item 후보.
 * @returns Webview가 안전하게 소비할 수 있으면 `true`.
 */
function isTimelineItemView(value: unknown): value is ChatTimelineItem {
	if (!isRecord(value)) {
		return false;
	}
	if (!isNonEmptyString(value.id)
		|| !isNonEmptyString(value.turnId)
		|| !isChatTimelineItemKind(value.kind)
		|| typeof value.text !== 'string'
		|| !isIsoDateString(value.createdAt)
		|| !isChatTimelineItemState(value.state)) {
		return false;
	}
	if (value.kind === 'assistantMessage') {
		return (value.assistantPhase === 'commentary' || value.assistantPhase === 'final')
			&& value.activity === undefined;
	}
	if (value.kind === 'reasoning'
		|| value.kind === 'execution'
		|| value.kind === 'fileChange') {
		return value.assistantPhase === undefined && isActivity(value.activity);
	}
	return value.assistantPhase === undefined && value.activity === undefined;
}

/** Provider 공통 Activity의 표시 필드를 runtime에서 검사한다. */
function isActivity(value: unknown): boolean {
	return isRecord(value)
		&& isNonEmptyString(value.label)
		&& typeof value.summary === 'string'
		&& (value.details === undefined || typeof value.details === 'string');
}

/** Host가 외부 브라우저로 열 수 있는 절대 HTTP(S) URL인지 검사한다. */
export function isAllowedExternalUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * 문자열이 해석 가능한 ISO 시각인지 검사한다.
 *
 * @param value 검사할 시각 후보.
 * @returns ISO 형태의 유효한 시각이면 `true`.
 */
function isIsoDateString(value: unknown): value is string {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * unknown 값이 null이 아닌 평범한 JSON 객체인지 검사한다.
 *
 * @param value 검사할 외부 값.
 * @returns 문자열 key를 조회할 수 있는 객체이면 `true`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * unknown 값이 비어 있지 않은 문자열인지 검사한다.
 *
 * @param value 검사할 외부 값.
 * @returns 하나 이상의 문자를 가진 문자열이면 `true`.
 */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}
