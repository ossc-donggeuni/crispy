/** Codex Thread·Turn·core 5 Item을 Chat snapshot으로 축약하는 상태 저장소다. */

import type { ThreadStatus } from './generated/v2/ThreadStatus';
import type { TurnError } from './generated/v2/TurnError';
import type { TurnItemsView } from './generated/v2/TurnItemsView';
import type { TurnStatus } from './generated/v2/TurnStatus';
import type {
	CodexChatSessionView,
	CodexChatTimelineItemView,
	CodexChatViewSnapshot,
} from './chatBridgeProtocol';
import type { CodexConnectionState, CodexTimelineItem } from './contracts';
import type { CoreThreadItem } from './protocol';
import type { CodexServerNotificationMessage } from './runtimeValidation';

/** 제목이 비정상적으로 길어 최근 대화 팝오버를 밀어내지 않게 하는 최대 문자 수다. */
const conversationTitleLimit = 48;

/** 새 draft가 사용자 메시지를 받기 전 표시하는 기본 제목이다. */
const emptyConversationTitle = '새 대화';

/** 상태 저장소가 외부 비동기 요청에 제공하는 대화 정보다. */
export interface CodexConversationTarget {
	/** Host가 발급한 draft 또는 대화 식별자다. */
	conversationId: string;
	/** 첫 전송 뒤 연결된 Codex Thread ID이며 draft이면 존재하지 않는다. */
	threadId?: string;
}

/** 첫 전송과 후속 Turn 시작 전에 상태에 추가한 사용자 입력 정보다. */
export interface CodexPreparedTurn {
	/** 전송할 대화 식별자다. */
	conversationId: string;
	/** 이미 생성된 Codex Thread ID이며 첫 전송이면 존재하지 않는다. */
	threadId?: string;
	/** 중복 제거에 사용하는 Host 생성 clientUserMessageId다. */
	clientUserMessageId: string;
	/** 공백을 제거한 실제 사용자 입력이다. */
	text: string;
}

/** 상태 변경 알림이 알려진 Thread에 적용됐는지 나타내는 결과다. */
export type CodexNotificationApplyResult = 'applied' | 'unknownThread' | 'ignored';

/** 하나의 Turn에서 core Item 순서와 최종 상태를 보관한다. */
interface MutableTurnState {
	/** Codex가 발급한 Turn 식별자다. */
	id: string;
	/** Turn의 현재 실행 결과다. */
	status: TurnStatus;
	/** 응답에 포함된 Item 범위다. */
	itemsView: TurnItemsView;
	/** Item ID별 최신 원본과 lifecycle이다. */
	items: Map<string, CodexTimelineItem>;
	/** Map과 별개로 서버 timeline 순서를 보존한다. */
	itemOrder: string[];
	/** 실패한 Turn의 구조화된 오류다. */
	error: TurnError | null;
	/** Unix seconds 단위 시작 시각이다. */
	startedAt: number | null;
	/** Unix seconds 단위 완료 시각이다. */
	completedAt: number | null;
	/** 서버가 계산한 Turn 소요 시간이다. */
	durationMs: number | null;
}

/** draft와 연결된 Thread를 동일한 UI 단위로 관리하는 내부 상태다. */
interface MutableConversationState {
	/** Webview와 Host 사이에서 사용하는 안정적인 대화 식별자다. */
	id: string;
	/** 첫 전송 뒤 받은 Codex Thread ID다. */
	threadId?: string;
	/** 첫 사용자 메시지로 만든 최근 대화 제목이다. */
	title: string;
	/** 최근 상태 변경 Unix milliseconds 시각이다. */
	updatedAtMs: number;
	/** thread/start 또는 turn/start 응답을 기다리는지 나타낸다. */
	starting: boolean;
	/** 활성 Turn ID이며 요청 시작 직후에는 아직 존재하지 않을 수 있다. */
	activeTurnId?: string;
	/** Codex Thread의 최신 runtime 상태다. */
	threadStatus: ThreadStatus;
	/** Turn ID별 상태다. */
	turns: Map<string, MutableTurnState>;
	/** 여러 Turn의 timeline 순서를 보존한다. */
	turnOrder: string[];
	/** 서버 userMessage가 오기 전 표시하는 client ID별 사용자 입력이다. */
	pendingUsers: Map<string, CodexChatTimelineItemView>;
	/** 마지막 요청 또는 Turn 실패 설명이다. */
	error: string | null;
}

/** 생성된 Turn 응답에서 상태 저장소가 소비하는 검증 완료 값이다. */
interface ParsedTurn {
	/** Codex Turn ID다. */
	id: string;
	/** 응답에 포함된 core 5 Item이다. */
	items: CoreThreadItem[];
	/** Item 배열 로딩 범위다. */
	itemsView: TurnItemsView;
	/** 실행 상태다. */
	status: TurnStatus;
	/** 실패 정보다. */
	error: TurnError | null;
	/** Unix seconds 시작 시각이다. */
	startedAt: number | null;
	/** Unix seconds 완료 시각이다. */
	completedAt: number | null;
	/** Turn 소요 밀리초다. */
	durationMs: number | null;
}

/**
 * 메모리 내 draft와 Codex Thread를 관리하고 Webview snapshot을 생성한다.
 */
export class CodexConversationStateStore {
	/** 대화 ID별 mutable 상태다. */
	private readonly conversations = new Map<string, MutableConversationState>();
	/** Codex notification을 대화로 라우팅하는 Thread ID index다. */
	private readonly conversationIdByThreadId = new Map<string, string>();
	/** 현재 Webview에 표시할 대화 ID다. */
	private selectedConversationId: string;
	/** Composer 활성 여부를 결정하는 app-server 연결 상태다. */
	private connectionState: Readonly<CodexConnectionState> = { phase: 'stopped' };

	/**
	 * 초기 빈 draft를 만들고 상태 저장소를 시작한다.
	 *
	 * @param createId 서로 충돌하지 않는 로컬 식별자 생성 함수.
	 * @param now 현재 Unix milliseconds를 공급하는 함수.
	 */
	public constructor(
		private readonly createId: () => string,
		private readonly now: () => number = Date.now,
	) {
		this.selectedConversationId = this.createDraft();
	}

	/**
	 * 현재 연결 상태를 교체한다.
	 *
	 * @param state app-server client가 보고한 불변 상태.
	 */
	public setConnectionState(state: Readonly<CodexConnectionState>): void {
		this.connectionState = { ...state };
	}

	/**
	 * Thread를 시작하지 않고 비어 있는 새 draft를 생성하고 선택한다.
	 *
	 * @returns Host가 발급한 새 대화 ID.
	 */
	public createDraft(): string {
		const id = `draft-${this.createId()}`;
		this.conversations.set(id, {
			id,
			title: emptyConversationTitle,
			updatedAtMs: this.now(),
			starting: false,
			threadStatus: { type: 'notLoaded' },
			turns: new Map(),
			turnOrder: [],
			pendingUsers: new Map(),
			error: null,
		});
		this.selectedConversationId = id;
		return id;
	}

	/**
	 * 존재하는 draft 또는 Thread 대화를 선택한다.
	 *
	 * @param conversationId Webview snapshot에서 받은 대화 ID.
	 * @returns 대화가 존재해 선택됐으면 `true`.
	 */
	public selectConversation(conversationId: string): boolean {
		if (!this.conversations.has(conversationId)) {
			return false;
		}
		this.selectedConversationId = conversationId;
		return true;
	}

	/**
	 * 같은 Thread의 중복 Turn을 차단하고 pending 사용자 메시지를 추가한다.
	 *
	 * @param conversationId 전송 대상 대화 ID.
	 * @param text Webview에서 받은 사용자 원문.
	 * @param clientUserMessageId Host가 만든 중복 제거 ID.
	 * @returns RPC 요청에 사용할 정규화된 입력 정보.
	 * @throws 대화가 없거나 입력이 비었거나 이미 Turn이 실행 중인 경우.
	 */
	public prepareTurn(
		conversationId: string,
		text: string,
		clientUserMessageId: string,
	): CodexPreparedTurn {
		const conversation = this.requireConversation(conversationId);
		const normalizedText = text.trim();
		if (normalizedText.length === 0) {
			throw new Error('빈 메시지는 Codex에 보낼 수 없습니다.');
		}
		if (conversation.starting || conversation.activeTurnId) {
			throw new Error('같은 대화에서 이미 Turn이 실행 중입니다.');
		}

		conversation.starting = true;
		conversation.error = null;
		conversation.updatedAtMs = this.now();
		if (conversation.title === emptyConversationTitle) {
			conversation.title = makeConversationTitle(normalizedText);
		}
		conversation.pendingUsers.set(clientUserMessageId, {
			id: `pending-${clientUserMessageId}`,
			type: 'userMessage',
			text: normalizedText,
			createdAt: toIso(conversation.updatedAtMs),
			status: 'completed',
		});

		return {
			conversationId,
			threadId: conversation.threadId,
			clientUserMessageId,
			text: normalizedText,
		};
	}

	/**
	 * thread/start 응답의 Thread를 draft에 연결한다.
	 *
	 * @param conversationId thread/start를 시작한 draft ID.
	 * @param result 검증 전 app-server 응답 result.
	 * @returns 응답에서 검증한 Codex Thread ID.
	 * @throws 필수 Thread 필드가 잘못된 경우.
	 */
	public attachStartedThread(conversationId: string, result: unknown): string {
		const conversation = this.requireConversation(conversationId);
		const thread = parseThreadStartResult(result);
		conversation.threadId = thread.id;
		conversation.threadStatus = thread.status;
		conversation.updatedAtMs = secondsToMilliseconds(thread.updatedAt);
		this.conversationIdByThreadId.set(thread.id, conversationId);
		for (const turn of thread.turns) {
			this.mergeTurn(conversation, turn, false);
		}
		return thread.id;
	}

	/**
	 * turn/start 응답을 기존 대화 상태에 병합한다.
	 *
	 * @param conversationId Turn을 요청한 대화 ID.
	 * @param result 검증 전 app-server 응답 result.
	 * @returns 응답에서 검증한 Codex Turn ID.
	 * @throws Turn 응답 필드가 잘못된 경우.
	 */
	public attachStartedTurn(conversationId: string, result: unknown): string {
		const conversation = this.requireConversation(conversationId);
		const turn = parseTurnStartResult(result);
		this.mergeTurn(conversation, turn, false);
		const mergedTurn = conversation.turns.get(turn.id);
		conversation.starting = false;
		conversation.activeTurnId = mergedTurn?.status === 'inProgress'
			? turn.id
			: undefined;
		conversation.updatedAtMs = this.now();
		return turn.id;
	}

	/**
	 * thread/start 또는 turn/start 실패를 선택된 대화에 반영한다.
	 *
	 * @param conversationId 실패한 요청의 대화 ID.
	 * @param error 사용자에게 표시할 정규화 전 오류.
	 */
	public failTurnStart(conversationId: string, error: unknown): void {
		const conversation = this.conversations.get(conversationId);
		if (!conversation) {
			return;
		}
		conversation.starting = false;
		conversation.error = getErrorMessage(error);
		conversation.updatedAtMs = this.now();
	}

	/**
	 * 현재 실행 flag를 바꾸지 않고 입력 또는 환경 검증 오류만 기록한다.
	 *
	 * @param conversationId 오류를 표시할 대화 ID.
	 * @param error 사용자에게 표시할 정규화 전 오류.
	 */
	public reportError(conversationId: string, error: unknown): void {
		const conversation = this.conversations.get(conversationId);
		if (!conversation) {
			return;
		}
		conversation.error = getErrorMessage(error);
		conversation.updatedAtMs = this.now();
	}

	/**
	 * method별 runtime validation 뒤 notification을 Thread 상태에 적용한다.
	 *
	 * @param message envelope validation을 통과한 app-server notification.
	 * @returns 적용, 미등록 Thread, 현재 단계 무시 중 하나.
	 */
	public applyNotification(
		message: CodexServerNotificationMessage,
	): CodexNotificationApplyResult {
		const params = message.params;
		switch (message.method) {
			case 'thread/started':
				return 'ignored';
			case 'thread/status/changed':
				return this.applyThreadStatus(params);
			case 'turn/started':
				return this.applyTurn(params, false);
			case 'turn/completed':
				return this.applyTurn(params, true);
			case 'item/started':
				return this.applyItem(params, false);
			case 'item/completed':
				return this.applyItem(params, true);
			case 'item/agentMessage/delta':
				return this.applyDelta(params, 'agentMessage');
			case 'item/commandExecution/outputDelta':
				return this.applyDelta(params, 'commandExecution');
			default:
				return 'ignored';
		}
	}

	/**
	 * Thread ID가 현재 상태에 등록되어 있는지 확인한다.
	 *
	 * @param threadId Codex Thread ID.
	 * @returns notification을 즉시 적용할 수 있으면 `true`.
	 */
	public hasThread(threadId: string): boolean {
		return this.conversationIdByThreadId.has(threadId);
	}

	/**
	 * 선택된 대화의 불변 Webview snapshot을 생성한다.
	 *
	 * @param workspaceAvailable 현재 단일 Workspace 경로를 사용할 수 있는지 여부.
	 * @returns session, timeline, 실행 상태와 오류를 포함한 표시 상태.
	 */
	public snapshot(workspaceAvailable: boolean): CodexChatViewSnapshot {
		const selected = this.requireConversation(this.selectedConversationId);
		const sessions = [...this.conversations.values()]
			.sort((left, right) => right.updatedAtMs - left.updatedAtMs)
			.map<CodexChatSessionView>((conversation) => ({
				id: conversation.id,
				title: conversation.title,
				lastResponseAt: toIso(conversation.updatedAtMs),
			}));
		return {
			selectedConversationId: selected.id,
			sessions,
			items: this.createTimeline(selected),
			isRunning: selected.starting || selected.activeTurnId !== undefined,
			composerAvailable: workspaceAvailable
				&& this.connectionState.phase === 'ready',
			error: selected.error ?? this.connectionState.error ?? null,
		};
	}

	/**
	 * Thread 상태 변경을 적용하되 idle을 Turn 성공 판정에 사용하지 않는다.
	 *
	 * @param params notification의 검증 전 params.
	 * @returns 상태 적용 결과.
	 */
	private applyThreadStatus(params: unknown): CodexNotificationApplyResult {
		if (!isRecord(params)
			|| typeof params.threadId !== 'string'
			|| !isThreadStatus(params.status)) {
			return 'ignored';
		}
		const conversation = this.findByThreadId(params.threadId);
		if (!conversation) {
			return 'unknownThread';
		}
		conversation.threadStatus = params.status;
		conversation.updatedAtMs = this.now();
		return 'applied';
	}

	/**
	 * Turn 시작 또는 완료 snapshot을 병합한다.
	 *
	 * @param params notification의 검증 전 params.
	 * @param completed 완료 notification이면 `true`.
	 * @returns 상태 적용 결과.
	 */
	private applyTurn(
		params: unknown,
		completed: boolean,
	): CodexNotificationApplyResult {
		if (!isRecord(params) || typeof params.threadId !== 'string') {
			return 'ignored';
		}
		const turn = parseTurn(params.turn);
		if (!turn) {
			return 'ignored';
		}
		const conversation = this.findByThreadId(params.threadId);
		if (!conversation) {
			return 'unknownThread';
		}
		this.mergeTurn(conversation, turn, completed);
		conversation.starting = false;
		conversation.activeTurnId = completed || turn.status !== 'inProgress'
			? undefined
			: turn.id;
		conversation.updatedAtMs = this.now();
		if (completed && turn.status === 'failed') {
			conversation.error = turn.error?.message ?? 'Codex Turn이 실패했습니다.';
		}
		return 'applied';
	}

	/**
	 * item/started 또는 authoritative item/completed를 적용한다.
	 *
	 * @param params notification의 검증 전 params.
	 * @param completed 완료 notification이면 `true`.
	 * @returns 상태 적용 결과.
	 */
	private applyItem(
		params: unknown,
		completed: boolean,
	): CodexNotificationApplyResult {
		if (!isRecord(params)
			|| typeof params.threadId !== 'string'
			|| typeof params.turnId !== 'string') {
			return 'ignored';
		}
		const item = parseCoreThreadItem(params.item);
		const timestamp = completed ? params.completedAtMs : params.startedAtMs;
		if (!item || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
			return 'ignored';
		}
		const conversation = this.findByThreadId(params.threadId);
		if (!conversation) {
			return 'unknownThread';
		}
		const turn = this.ensureTurn(conversation, params.turnId);
		const existing = turn.items.get(item.id);
		if (!turn.itemOrder.includes(item.id)) {
			turn.itemOrder.push(item.id);
		}
		turn.items.set(item.id, {
			threadId: params.threadId,
			turnId: params.turnId,
			item,
			lifecycle: completed ? 'completed' : 'started',
			startedAtMs: completed ? existing?.startedAtMs : timestamp,
			completedAtMs: completed ? timestamp : undefined,
		});
		if (item.type === 'userMessage' && item.clientId) {
			conversation.pendingUsers.delete(item.clientId);
		}
		conversation.updatedAtMs = timestamp;
		return 'applied';
	}

	/**
	 * Agent 본문 또는 command 출력을 기존 Item 뒤에 누적한다.
	 *
	 * @param params notification의 검증 전 params.
	 * @param expectedType delta가 대상으로 삼는 Item 종류.
	 * @returns 상태 적용 결과.
	 */
	private applyDelta(
		params: unknown,
		expectedType: 'agentMessage' | 'commandExecution',
	): CodexNotificationApplyResult {
		if (!isRecord(params)
			|| typeof params.threadId !== 'string'
			|| typeof params.turnId !== 'string'
			|| typeof params.itemId !== 'string'
			|| typeof params.delta !== 'string') {
			return 'ignored';
		}
		const conversation = this.findByThreadId(params.threadId);
		if (!conversation) {
			return 'unknownThread';
		}
		const turn = this.ensureTurn(conversation, params.turnId);
		const timeline = turn.items.get(params.itemId);
		if (!timeline || timeline.item.type !== expectedType) {
			return 'ignored';
		}
		const item = timeline.item;
		const nextItem: CoreThreadItem = item.type === 'agentMessage'
			? { ...item, text: item.text + params.delta }
			: {
				...item,
				aggregatedOutput: (item.aggregatedOutput ?? '') + params.delta,
			};
		turn.items.set(params.itemId, { ...timeline, item: nextItem });
		conversation.updatedAtMs = this.now();
		return 'applied';
	}

	/**
	 * summary 또는 full Turn Item을 기존 delta 상태에 병합한다.
	 *
	 * @param conversation 대상 대화 상태.
	 * @param parsed 검증된 Turn snapshot.
	 * @param authoritative 완료 Turn이면 `true`.
	 */
	private mergeTurn(
		conversation: MutableConversationState,
		parsed: ParsedTurn,
		authoritative: boolean,
	): void {
		const turn = this.ensureTurn(conversation, parsed.id);
		const hasFinalNotificationState = !authoritative
			&& turn.status !== 'inProgress'
			&& parsed.status === 'inProgress';
		if (!hasFinalNotificationState) {
			turn.status = parsed.status;
			turn.error = parsed.error;
			turn.completedAt = parsed.completedAt;
			turn.durationMs = parsed.durationMs;
		}
		turn.itemsView = parsed.itemsView;
		turn.startedAt = parsed.startedAt;
		for (const item of parsed.items) {
			const existing = turn.items.get(item.id);
			if (!turn.itemOrder.includes(item.id)) {
				turn.itemOrder.push(item.id);
			}
			turn.items.set(item.id, {
				threadId: conversation.threadId ?? '',
				turnId: parsed.id,
				item,
				lifecycle: authoritative || parsed.status !== 'inProgress'
					? 'completed'
					: existing?.lifecycle ?? 'started',
				startedAtMs: existing?.startedAtMs,
				completedAtMs: existing?.completedAtMs,
			});
			if (item.type === 'userMessage' && item.clientId) {
				conversation.pendingUsers.delete(item.clientId);
			}
		}
	}

	/**
	 * 없는 Turn은 최소 inProgress 상태로 생성한다.
	 *
	 * @param conversation Turn을 포함할 대화.
	 * @param turnId Codex Turn ID.
	 * @returns 기존 또는 새 mutable Turn 상태.
	 */
	private ensureTurn(
		conversation: MutableConversationState,
		turnId: string,
	): MutableTurnState {
		const existing = conversation.turns.get(turnId);
		if (existing) {
			return existing;
		}
		const created: MutableTurnState = {
			id: turnId,
			status: 'inProgress',
			itemsView: 'notLoaded',
			items: new Map(),
			itemOrder: [],
			error: null,
			startedAt: null,
			completedAt: null,
			durationMs: null,
		};
		conversation.turns.set(turnId, created);
		conversation.turnOrder.push(turnId);
		return created;
	}

	/**
	 * 선택된 대화의 pending 메시지와 Turn Item을 시간·Turn 순서로 펼친다.
	 *
	 * @param conversation snapshot을 만들 대화.
	 * @returns Webview 전용 core 5 timeline 배열.
	 */
	private createTimeline(
		conversation: MutableConversationState,
	): CodexChatTimelineItemView[] {
		const timeline: CodexChatTimelineItemView[] = [];
		for (const turnId of conversation.turnOrder) {
			const turn = conversation.turns.get(turnId);
			if (!turn) {
				continue;
			}
			for (const itemId of turn.itemOrder) {
				const item = turn.items.get(itemId);
				if (item) {
					timeline.push(toTimelineView(item, turn.startedAt));
				}
			}
		}
		timeline.push(...conversation.pendingUsers.values());
		return timeline;
	}

	/**
	 * Thread ID index로 대화 상태를 찾는다.
	 *
	 * @param threadId Codex Thread ID.
	 * @returns 연결된 대화 또는 `undefined`.
	 */
	private findByThreadId(threadId: string): MutableConversationState | undefined {
		const conversationId = this.conversationIdByThreadId.get(threadId);
		return conversationId ? this.conversations.get(conversationId) : undefined;
	}

	/**
	 * 반드시 존재해야 하는 대화를 조회한다.
	 *
	 * @param conversationId Host 대화 ID.
	 * @returns 존재하는 mutable 대화 상태.
	 * @throws 대화 ID가 현재 상태에 없을 때.
	 */
	private requireConversation(conversationId: string): MutableConversationState {
		const conversation = this.conversations.get(conversationId);
		if (!conversation) {
			throw new Error(`존재하지 않는 대화입니다: ${conversationId}`);
		}
		return conversation;
	}
}

/**
 * thread/start result에서 상태 저장소에 필요한 Thread 필드를 검증한다.
 *
 * @param value app-server가 반환한 unknown result.
 * @returns 검증한 Thread 요약.
 * @throws result 또는 Thread 필드가 현재 생성 스키마와 맞지 않을 때.
 */
function parseThreadStartResult(value: unknown): {
	id: string;
	updatedAt: number;
	status: ThreadStatus;
	turns: ParsedTurn[];
} {
	if (!isRecord(value) || !isRecord(value.thread)) {
		throw new Error('thread/start 응답에 유효한 thread가 없습니다.');
	}
	const thread = value.thread;
	if (typeof thread.id !== 'string'
		|| typeof thread.updatedAt !== 'number'
		|| !isThreadStatus(thread.status)
		|| !Array.isArray(thread.turns)) {
		throw new Error('thread/start 응답의 필수 Thread 필드가 잘못되었습니다.');
	}
	const turns = thread.turns.map(parseTurn);
	if (turns.some((turn) => turn === undefined)) {
		throw new Error('thread/start 응답에 유효하지 않은 Turn이 있습니다.');
	}
	return {
		id: thread.id,
		updatedAt: thread.updatedAt,
		status: thread.status,
		turns: turns as ParsedTurn[],
	};
}

/**
 * turn/start result에서 Turn을 검증한다.
 *
 * @param value app-server가 반환한 unknown result.
 * @returns 검증한 Turn.
 * @throws result에 유효한 Turn이 없을 때.
 */
function parseTurnStartResult(value: unknown): ParsedTurn {
	const parsed = isRecord(value) ? parseTurn(value.turn) : undefined;
	if (!parsed) {
		throw new Error('turn/start 응답에 유효한 turn이 없습니다.');
	}
	return parsed;
}

/**
 * 생성 Turn에서 상태 저장소가 사용하는 모든 필드를 runtime 검증한다.
 *
 * @param value 검사할 Turn 후보.
 * @returns 검증한 Turn 또는 `undefined`.
 */
function parseTurn(value: unknown): ParsedTurn | undefined {
	if (!isRecord(value)
		|| typeof value.id !== 'string'
		|| !Array.isArray(value.items)
		|| !isTurnItemsView(value.itemsView)
		|| !isTurnStatus(value.status)
		|| !isNullableNumber(value.startedAt)
		|| !isNullableNumber(value.completedAt)
		|| !isNullableNumber(value.durationMs)
		|| !isTurnError(value.error)) {
		return undefined;
	}
	const items = value.items
		.map(parseCoreThreadItem)
		.filter((item): item is CoreThreadItem => item !== undefined);
	return {
		id: value.id,
		items,
		itemsView: value.itemsView,
		status: value.status,
		error: value.error,
		startedAt: value.startedAt,
		completedAt: value.completedAt,
		durationMs: value.durationMs,
	};
}

/**
 * 생성 ThreadItem 중 core 5 분기를 각 필수 필드와 함께 검증한다.
 *
 * @param value 검사할 ThreadItem 후보.
 * @returns 검증된 생성 core Item 또는 지원 범위 밖이면 `undefined`.
 */
function parseCoreThreadItem(value: unknown): CoreThreadItem | undefined {
	if (!isRecord(value) || typeof value.id !== 'string') {
		return undefined;
	}
	switch (value.type) {
		case 'userMessage':
			return (value.clientId === null || typeof value.clientId === 'string')
				&& Array.isArray(value.content)
				&& value.content.every(isUserInput)
				? value as CoreThreadItem
				: undefined;
		case 'agentMessage':
			return typeof value.text === 'string'
				&& (value.phase === null
					|| value.phase === 'commentary'
					|| value.phase === 'final_answer')
				&& (value.memoryCitation === null || isRecord(value.memoryCitation))
				? value as CoreThreadItem
				: undefined;
		case 'reasoning':
			return isStringArray(value.summary) && isStringArray(value.content)
				? value as CoreThreadItem
				: undefined;
		case 'commandExecution':
			return isCommandExecutionItem(value) ? value as CoreThreadItem : undefined;
		case 'fileChange':
			return Array.isArray(value.changes)
				&& value.changes.every(isFileUpdateChange)
				&& isExecutionStatus(value.status)
				? value as CoreThreadItem
				: undefined;
		default:
			return undefined;
	}
}

/**
 * commandExecution 생성 분기의 필수 필드를 검증한다.
 *
 * @param value discriminator가 확인된 command Item 후보.
 * @returns 생성 타입의 필수 필드가 모두 유효하면 `true`.
 */
function isCommandExecutionItem(value: Record<string, unknown>): boolean {
	return isNullableString(value.pluginId)
		&& isNullableString(value.scriptPath)
		&& typeof value.command === 'string'
		&& typeof value.cwd === 'string'
		&& isNullableString(value.processId)
		&& (value.source === 'agent'
			|| value.source === 'userShell'
			|| value.source === 'unifiedExecStartup'
			|| value.source === 'unifiedExecInteraction')
		&& isExecutionStatus(value.status)
		&& Array.isArray(value.commandActions)
		&& value.commandActions.every(isCommandAction)
		&& isNullableString(value.aggregatedOutput)
		&& isNullableNumber(value.exitCode)
		&& isNullableNumber(value.durationMs);
}

/**
 * 사용자 입력 union의 method별 필수 표시 필드를 검증한다.
 *
 * @param value 검사할 UserInput 후보.
 * @returns 생성 UserInput 분기 중 하나이면 `true`.
 */
function isUserInput(value: unknown): boolean {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
	}
	switch (value.type) {
		case 'text':
			return typeof value.text === 'string' && Array.isArray(value.text_elements);
		case 'image':
		case 'audio':
			return typeof value.url === 'string';
		case 'localImage':
		case 'localAudio':
			return typeof value.path === 'string';
		case 'skill':
		case 'mention':
			return typeof value.name === 'string' && typeof value.path === 'string';
		default:
			return false;
	}
}

/**
 * command action의 생성 union 필드를 검증한다.
 *
 * @param value 검사할 command action 후보.
 * @returns 지원하는 action 분기이면 `true`.
 */
function isCommandAction(value: unknown): boolean {
	if (!isRecord(value) || typeof value.command !== 'string') {
		return false;
	}
	switch (value.type) {
		case 'read':
			return typeof value.name === 'string' && typeof value.path === 'string';
		case 'listFiles':
			return isNullableString(value.path);
		case 'search':
			return isNullableString(value.query) && isNullableString(value.path);
		case 'unknown':
			return true;
		default:
			return false;
	}
}

/**
 * fileChange의 단일 파일 변경 필드를 검증한다.
 *
 * @param value 검사할 파일 변경 후보.
 * @returns path, kind, diff가 생성 계약과 맞으면 `true`.
 */
function isFileUpdateChange(value: unknown): boolean {
	return isRecord(value)
		&& typeof value.path === 'string'
		&& isPatchChangeKind(value.kind)
		&& typeof value.diff === 'string';
}

/**
 * 파일 변경 종류의 생성 객체 union을 검증한다.
 *
 * @param value 검사할 PatchChangeKind 후보.
 * @returns add, delete 또는 nullable 이동 경로가 있는 update 객체이면 `true`.
 */
function isPatchChangeKind(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}
	if (value.type === 'add' || value.type === 'delete') {
		return true;
	}
	return value.type === 'update' && isNullableString(value.move_path);
}

/**
 * 내부 timeline Item을 Webview 전용 표시 모델로 변환한다.
 *
 * @param timeline 생성 Item과 lifecycle metadata.
 * @param turnStartedAt Item 시각이 없을 때 사용할 Unix seconds Turn 시각.
 * @returns HTML을 포함하지 않는 표시 모델.
 */
function toTimelineView(
	timeline: CodexTimelineItem,
	turnStartedAt: number | null,
): CodexChatTimelineItemView {
	const timestamp = timeline.startedAtMs
		?? timeline.completedAtMs
		?? (turnStartedAt === null ? Date.now() : secondsToMilliseconds(turnStartedAt));
	return {
		id: `${timeline.turnId}:${timeline.item.id}`,
		type: timeline.item.type,
		text: formatCoreItem(timeline.item),
		createdAt: toIso(timestamp),
		status: timeline.lifecycle === 'completed' ? 'completed' : 'streaming',
	};
}

/**
 * core 5 생성 Item을 읽기 쉬운 plain text로 변환한다.
 *
 * @param item runtime validation을 통과한 생성 Item.
 * @returns Webview가 textContent로 표시할 본문.
 */
function formatCoreItem(item: CoreThreadItem): string {
	switch (item.type) {
		case 'userMessage':
			return item.content
				.filter((input) => input.type === 'text')
				.map((input) => input.text)
				.join('\n');
		case 'agentMessage':
			return item.text;
		case 'reasoning':
			return [...item.summary, ...item.content].join('\n');
		case 'commandExecution': {
			const output = item.aggregatedOutput?.trimEnd();
			return output ? `$ ${item.command}\n${output}` : `$ ${item.command}`;
		}
		case 'fileChange':
			return item.changes.map((change) => {
				const diff = change.diff.trimEnd();
				const kind = change.kind.type;
				return diff
					? `[${kind}] ${change.path}\n${diff}`
					: `[${kind}] ${change.path}`;
			}).join('\n\n');
	}
}

/**
 * 첫 사용자 입력을 한 줄 제목으로 제한한다.
 *
 * @param text 정규화된 사용자 입력.
 * @returns 최근 대화 목록용 제목.
 */
function makeConversationTitle(text: string): string {
	const singleLine = text.replace(/\s+/g, ' ').trim();
	return singleLine.length <= conversationTitleLimit
		? singleLine
		: `${singleLine.slice(0, conversationTitleLimit - 1)}…`;
}

/**
 * Thread status discriminator와 activeFlags를 검증한다.
 *
 * @param value 검사할 status 후보.
 * @returns 생성 ThreadStatus와 맞으면 `true`.
 */
function isThreadStatus(value: unknown): value is ThreadStatus {
	if (!isRecord(value) || typeof value.type !== 'string') {
		return false;
	}
	if (value.type === 'notLoaded' || value.type === 'idle' || value.type === 'systemError') {
		return true;
	}
	return value.type === 'active'
		&& Array.isArray(value.activeFlags)
		&& value.activeFlags.every((flag) =>
			flag === 'waitingOnApproval' || flag === 'waitingOnUserInput');
}

/**
 * Turn status가 생성 enum인지 검사한다.
 *
 * @param value 검사할 status 후보.
 * @returns 허용 status이면 `true`.
 */
function isTurnStatus(value: unknown): value is TurnStatus {
	return value === 'completed'
		|| value === 'interrupted'
		|| value === 'failed'
		|| value === 'inProgress';
}

/**
 * Turn Item 로딩 범위가 생성 enum인지 검사한다.
 *
 * @param value 검사할 itemsView 후보.
 * @returns 허용 범위이면 `true`.
 */
function isTurnItemsView(value: unknown): value is TurnItemsView {
	return value === 'notLoaded' || value === 'summary' || value === 'full';
}

/**
 * Turn 오류의 필수 표시 필드와 nullable 상세 정보를 검증한다.
 *
 * @param value 검사할 Turn 오류 후보.
 * @returns `null` 또는 생성 오류 구조이면 `true`.
 */
function isTurnError(value: unknown): value is TurnError | null {
	return value === null || (isRecord(value)
		&& typeof value.message === 'string'
		&& (value.codexErrorInfo === null || isRecord(value.codexErrorInfo))
		&& isNullableString(value.additionalDetails));
}

/**
 * command와 file 실행 상태 enum을 검사한다.
 *
 * @param value 검사할 상태 후보.
 * @returns core Item에서 허용하는 상태이면 `true`.
 */
function isExecutionStatus(value: unknown): boolean {
	return value === 'inProgress'
		|| value === 'completed'
		|| value === 'failed'
		|| value === 'declined';
}

/**
 * 문자열 배열인지 검사한다.
 *
 * @param value 검사할 배열 후보.
 * @returns 모든 원소가 문자열이면 `true`.
 */
function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * null 또는 문자열인지 검사한다.
 *
 * @param value 검사할 값.
 * @returns nullable 문자열이면 `true`.
 */
function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

/**
 * null 또는 유한한 숫자인지 검사한다.
 *
 * @param value 검사할 값.
 * @returns nullable 유한 숫자이면 `true`.
 */
function isNullableNumber(value: unknown): value is number | null {
	return value === null || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * unknown 값을 JSON 객체로 좁힌다.
 *
 * @param value 검사할 값.
 * @returns 배열이 아닌 객체이면 `true`.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unix seconds를 milliseconds로 바꾼다.
 *
 * @param seconds Unix seconds.
 * @returns Unix milliseconds.
 */
function secondsToMilliseconds(seconds: number): number {
	return seconds * 1_000;
}

/**
 * Unix milliseconds를 ISO 8601 문자열로 바꾼다.
 *
 * @param milliseconds 변환할 Unix milliseconds.
 * @returns ISO 8601 시각.
 */
function toIso(milliseconds: number): string {
	return new Date(milliseconds).toISOString();
}

/**
 * unknown 오류를 사용자용 문자열로 정규화한다.
 *
 * @param error 비동기 요청에서 발생한 값.
 * @returns 오류 메시지 문자열.
 */
function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
