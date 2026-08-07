/** AI Provider와 무관하게 Chat Webview가 소비하는 공통 타임라인 계약이다. */

/** Chat 타임라인 항목의 의미를 구분하는 Provider 중립 discriminator다. */
export type ChatTimelineItemKind = 'userMessage'
	| 'assistantMessage'
	| 'reasoning'
	| 'execution'
	| 'fileChange'
	| 'status';

/** Assistant 메시지가 진행 설명인지 최종 답변인지 나타낸다. */
export type ChatAssistantPhase = 'commentary' | 'final';

/** 타임라인 항목의 표시용 진행 상태다. */
export type ChatTimelineItemState = 'pending'
	| 'streaming'
	| 'completed'
	| 'failed'
	| 'interrupted';

/** reasoning·execution·fileChange에 공통으로 사용하는 축약 및 세부 정보다. */
export interface ChatTimelineActivity {
	/** Activity 종류를 사용자에게 설명하는 Provider 중립 이름이다. */
	label: string;
	/** 접힌 상태에서 표시할 핵심 요약이다. */
	summary: string;
	/** 펼쳤을 때 plain text로 표시할 선택적 세부 내용이다. */
	details?: string;
}

/** Host가 Webview에 전달하는 단일 Provider 공통 타임라인 항목이다. */
export interface ChatTimelineItem {
	/** 대화 범위에서 DOM key로 사용하는 안정적인 식별자다. */
	id: string;
	/** 항목이 속한 Turn을 식별하는 서버 또는 임시 식별자다. */
	turnId: string;
	/** 항목의 의미와 렌더링 방식을 결정하는 공통 종류다. */
	kind: ChatTimelineItemKind;
	/** 메시지 또는 상태에서 표시할 본문이다. */
	text: string;
	/** 표시 순서와 시각 메타데이터에 사용하는 ISO 8601 시각이다. */
	createdAt: string;
	/** 항목이 대기·스트리밍·완료·실패·중단 중 어느 상태인지 나타낸다. */
	state: ChatTimelineItemState;
	/** Assistant 메시지에만 존재하는 공통 응답 단계다. */
	assistantPhase?: ChatAssistantPhase;
	/** Activity 종류에만 존재하는 축약 및 세부 표시 정보다. */
	activity?: ChatTimelineActivity;
}

/** 공통 타임라인 kind 후보를 runtime에서 검사한다. */
export function isChatTimelineItemKind(value: unknown): value is ChatTimelineItemKind {
	return value === 'userMessage'
		|| value === 'assistantMessage'
		|| value === 'reasoning'
		|| value === 'execution'
		|| value === 'fileChange'
		|| value === 'status';
}

/** 공통 타임라인 진행 상태 후보를 runtime에서 검사한다. */
export function isChatTimelineItemState(value: unknown): value is ChatTimelineItemState {
	return value === 'pending'
		|| value === 'streaming'
		|| value === 'completed'
		|| value === 'failed'
		|| value === 'interrupted';
}
