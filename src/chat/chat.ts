import './chat.css';
import { ChatHistoryControl } from './chatHistory';
import { createChatIcon } from './chatIcons';
import { ChatRuntimeSettingsControl } from './chatRuntimeSettings';

/** 대화 말풍선을 좌우에 배치하기 위해 사용하는 메시지 작성자 구분이다. */
export type ChatRole = 'user' | 'agent';

/** Agent 메시지가 아직 생성 중인지 완료되었는지 나타내는 렌더링 상태다. */
export type ChatMessageStatus = 'streaming' | 'completed';

/** 승인 요청 callback에 전달되는 사용자의 최종 결정이다. */
export type ChatApprovalDecision = 'approved' | 'rejected';

/** 최근 대화 기록 팝오버에 표시할 세션 요약 데이터다. */
export interface ChatSessionSummary {
	/** 세션 선택 callback에서 사용하는 안정적인 식별자다. */
	id: string;
	/** 최근 세션 목록에 표시할 대화 제목이다. */
	title: string;
	/** 상대 시간 계산의 기준이 되는 최근 응답 ISO 시각이다. */
	lastResponseAt: string;
}

/** 대화 출력 영역에 렌더링할 사용자 또는 Agent 메시지다. */
export interface ChatMessage {
	/** 메시지의 안정적인 식별자다. */
	id: string;
	/** 메시지의 발신자와 말풍선 정렬 방향이다. */
	role: ChatRole;
	/** HTML로 해석하지 않고 textContent로 출력할 메시지 본문이다. */
	text: string;
	/** 메시지 메타데이터에 표시할 생성 ISO 시각이다. */
	createdAt: string;
	/** 생략하면 이전 데이터와 호환되도록 완료된 메시지로 처리한다. */
	status?: ChatMessageStatus;
}

/** 스트리밍 delta 또는 완료 이벤트가 기존 메시지에서 변경할 수 있는 필드다. */
export type ChatMessagePatch = Partial<
	Pick<ChatMessage, 'text' | 'createdAt' | 'status'>
>;

/** Agent·모델·모델 옵션에서 공통으로 사용하는 선택 항목이다. */
export interface ChatSelectOption {
	/** 전송 요청에 포함되는 기계 판독용 값이다. */
	value: string;
	/** 실행 설정 UI에 표시되는 사용자용 이름이다. */
	label: string;
}

/** 대화와 Composer 사이의 승인 Dock에 표시할 단일 요청이다. */
export interface ChatApprovalRequest {
	/** 승인·거부 callback에서 원래 요청을 식별하는 값이다. */
	id: string;
	/** 승인할 작업을 요약하는 제목이다. */
	title: string;
	/** 사용자가 판단할 수 있도록 제공하는 요청 설명이다. */
	description: string;
}

/** 메시지 전송 시점에 선택되어 있는 Agent 실행 환경이다. */
export interface ChatSelection {
	/** 선택된 Agent 값이다. */
	agent: string;
	/** 선택된 모델 값이다. */
	model: string;
	/** 선택된 모델 옵션 값이다. */
	modelOption: string;
}

/** 선택된 실행 환경과 사용자 입력을 callback으로 전달하는 전송 요청이다. */
export interface ChatSendRequest extends ChatSelection {
	/** 공백을 제거한 사용자 메시지 본문이다. */
	text: string;
}

/** ChatView의 초기 데이터와 외부 연동 callback을 구성하는 옵션이다. */
export interface ChatViewOptions {
	/** 최근 대화 기록 팝오버의 초기 세션 목록이다. */
	sessions: readonly ChatSessionSummary[];
	/** 대화 출력 영역의 초기 메시지 목록이다. */
	messages: readonly ChatMessage[];
	/** 통합 실행 설정에서 선택 가능한 Agent 목록이다. */
	agents: readonly ChatSelectOption[];
	/** 통합 실행 설정에서 선택 가능한 모델 목록이다. */
	models: readonly ChatSelectOption[];
	/** 통합 실행 설정에서 선택 가능한 모델 옵션 목록이다. */
	modelOptions: readonly ChatSelectOption[];
	/** 처음부터 표시할 선택적 승인 요청이다. */
	approvalRequest?: ChatApprovalRequest;
	/** 로컬 메시지 전송 시 실행 환경과 본문을 전달한다. */
	onSend?: (request: ChatSendRequest) => void;
	/** 실행 중지 아이콘을 누르면 호출된다. */
	onStop?: () => void;
	/** 새 대화 아이콘을 누르고 로컬 상태를 초기화한 뒤 호출된다. */
	onNewChat?: () => void;
	/** 최근 세션을 선택했을 때 세션 ID를 전달한다. */
	onSessionSelect?: (sessionId: string) => void;
	/** 승인 Dock에서 승인 또는 거부를 결정했을 때 호출된다. */
	onApprovalDecision?: (
		requestId: string,
		decision: ChatApprovalDecision,
	) => void;
}

/** 화면에 표시하는 한국어 문구를 한곳에서 관리하기 위한 내부 copy 구조다. */
type ChatCopy = {
	chatLabel: string;
	recentSessions: string;
	newChat: string;
	emptyMessages: string;
	you: string;
	agent: string;
	agentSelector: string;
	modelSelector: string;
	modelOptionSelector: string;
	messageLabel: string;
	messagePlaceholder: string;
	send: string;
	stop: string;
	idleStatus: string;
	runningStatus: string;
	approvalHeading: string;
	approve: string;
	reject: string;
	approvedAnnouncement: string;
	rejectedAnnouncement: string;
	showMore: string;
	showLess: string;
};

/** 향후 언어별 copy 객체로 교체할 수 있도록 화면 문구를 한곳에서 관리한다. */
export const koreanChatCopy: Readonly<ChatCopy> = Object.freeze({
	chatLabel: 'Crispy Codex 대화',
	recentSessions: '최근 세션',
	newChat: '새 대화',
	emptyMessages: '새로운 대화를 시작해 보세요.',
	you: '나',
	agent: 'Codex',
	agentSelector: 'Agent',
	modelSelector: '모델',
	modelOptionSelector: '모델 옵션',
	messageLabel: '메시지',
	messagePlaceholder: 'Codex에게 요청할 내용을 입력하세요',
	send: '전송',
	stop: '실행 중지',
	idleStatus: '메시지를 입력할 수 있습니다.',
	runningStatus: 'Codex가 실행 중인 화면 예시입니다.',
	approvalHeading: '승인 요청',
	approve: '승인',
	reject: '거부',
	approvedAnnouncement: '승인했습니다.',
	rejectedAnnouncement: '거부했습니다.',
	showMore: '더 보기',
	showLess: '접기',
});

/** 완료된 메시지에서 기본으로 노출할 실제 렌더링 줄 수다. */
const collapsedMessageLineCount = 8;

/**
 * 독립 Chat WebviewPanel 안에서 동작하는 Chat UI다.
 *
 * 현재 단계에서는 모든 동작을 로컬 상태에 반영한다. callback과 공개 setter는 다음
 * 단계에서 Webview 메시지 및 AgentEvent를 연결할 때 같은 UI를 재사용하기 위한 경계다.
 */
export class ChatView {
	/** 현재 Chat UI가 사용하는 불변 한국어 copy다. */
	private readonly copy = koreanChatCopy;
	/** Extension 연동 단계에서 연결할 외부 이벤트 callback 모음이다. */
	private readonly callbacks: Pick<
		ChatViewOptions,
		'onSend'
		| 'onStop'
		| 'onNewChat'
		| 'onSessionSelect'
		| 'onApprovalDecision'
	>;
	private sessions: ChatSessionSummary[];
	private messages: ChatMessage[];
	private selectedSessionId: string | undefined;
	private approvalRequest: ChatApprovalRequest | undefined;
	private isRunning = false;
	private disposed = false;
	private localMessageSequence = 0;
	private announcementFrame: number | undefined;
	private messageMeasurementFrame: number | undefined;
	private lastMessageListWidth = -1;
	private readonly expandedMessageIds = new Set<string>();
	private messageResizeObserver: ResizeObserver | undefined;

	private historyControl!: ChatHistoryControl;
	private runtimeSettings!: ChatRuntimeSettingsControl;
	private messageList!: HTMLElement;
	private approvalHost!: HTMLElement;
	private decisionAnnouncer!: HTMLElement;
	private footer!: HTMLElement;
	private composerForm!: HTMLFormElement;
	private messageInput!: HTMLTextAreaElement;
	private submitButton!: HTMLButtonElement;
	private runStatus!: HTMLElement;

	/**
	 * Chat mount 지점에 전체 UI를 생성하고 초기 더미 상태를 렌더링한다.
	 *
	 * @param root Webview HTML의 `#chat-app` mount 요소.
	 * @param options 초기 세션·메시지·실행 설정과 외부 callback.
	 */
	public constructor(
		private readonly root: HTMLElement,
		options: ChatViewOptions,
	) {
		this.sessions = options.sessions.map((session) => ({ ...session }));
		this.messages = options.messages.map((message) => ({ ...message }));
		this.approvalRequest = options.approvalRequest
			? { ...options.approvalRequest }
			: undefined;
		this.callbacks = {
			onSend: options.onSend,
			onStop: options.onStop,
			onNewChat: options.onNewChat,
			onSessionSelect: options.onSessionSelect,
			onApprovalDecision: options.onApprovalDecision,
		};

		this.renderShell(options);
		this.renderMessages();
		this.renderApproval();
		this.resizeMessageInput();
		this.updateComposerState();
	}

	/**
	 * 최근 세션 요약을 교체하며 더 이상 존재하지 않는 선택 상태를 정리한다.
	 *
	 * @param sessions 최근 대화 기록 팝오버에 새로 표시할 세션 목록.
	 */
	public setSessions(sessions: readonly ChatSessionSummary[]): void {
		if (this.disposed) {
			return;
		}

		this.sessions = sessions.map((session) => ({ ...session }));
		if (!this.sessions.some((session) => session.id === this.selectedSessionId)) {
			this.selectedSessionId = undefined;
		}
		this.historyControl.setSessions(this.sessions);
	}

	/**
	 * 사용자 또는 Agent 메시지를 안전한 text node로 목록 끝에 추가한다.
	 *
	 * @param message 대화 목록 끝에 추가할 메시지.
	 */
	public addMessage(message: ChatMessage): void {
		if (this.disposed) {
			return;
		}

		this.messages.push({ ...message });
		this.renderMessages();
		this.messageList.scrollTop = this.messageList.scrollHeight;
	}

	/**
	 * 스트리밍 본문과 완료 상태처럼 기존 메시지의 가변 필드만 갱신한다.
	 *
	 * @param messageId 갱신할 메시지의 안정적인 식별자.
	 * @param patch 새 본문·시각·상태 중 변경할 값.
	 */
	public updateMessage(messageId: string, patch: ChatMessagePatch): void {
		if (this.disposed) {
			return;
		}

		const message = this.messages.find((candidate) => candidate.id === messageId);
		if (!message) {
			return;
		}

		if (patch.text !== undefined) {
			message.text = patch.text;
		}
		if (patch.createdAt !== undefined) {
			message.createdAt = patch.createdAt;
		}
		if (patch.status !== undefined) {
			message.status = patch.status;
		}

		const wasNearBottom = this.messageList.scrollHeight
			- this.messageList.scrollTop
			- this.messageList.clientHeight < 32;
		this.renderMessages();
		if (wasNearBottom) {
			this.messageList.scrollTop = this.messageList.scrollHeight;
		}
	}

	/**
	 * 전송 버튼과 입력 도구를 idle 또는 실행 중 상태로 전환한다.
	 *
	 * @param running `true`이면 설정·입력을 잠그고 중지 아이콘을 표시한다.
	 */
	public setRunning(running: boolean): void {
		if (this.disposed || this.isRunning === running) {
			return;
		}

		this.isRunning = running;
		this.updateComposerState();
	}

	/**
	 * 새로운 승인 요청을 표시하거나 현재 승인 영역을 숨긴다.
	 *
	 * @param request 표시할 요청. `undefined`이면 승인 Dock을 즉시 제거한다.
	 */
	public setApprovalRequest(request?: ChatApprovalRequest): void {
		if (this.disposed) {
			return;
		}

		this.approvalRequest = request ? { ...request } : undefined;
		this.renderApproval();
	}

	/** ChatView가 등록한 하위 컨트롤·animation frame·DOM을 정리한다. */
	public dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.historyControl.dispose();
		this.runtimeSettings.dispose();
		if (this.announcementFrame !== undefined) {
			cancelAnimationFrame(this.announcementFrame);
			this.announcementFrame = undefined;
		}
		if (this.messageMeasurementFrame !== undefined) {
			cancelAnimationFrame(this.messageMeasurementFrame);
			this.messageMeasurementFrame = undefined;
		}
		this.messageResizeObserver?.disconnect();
		this.messageResizeObserver = undefined;
		this.root.replaceChildren();
	}

	/**
	 * 상단 도구, 대화 영역, 승인 Dock host, Composer로 구성된 고정 shell을 만든다.
	 *
	 * @param options 실행 설정 컨트롤을 초기화할 선택 항목 목록.
	 */
	private renderShell(options: ChatViewOptions): void {
		this.root.replaceChildren();

		const shell = createElement('main', 'chat-shell');
		shell.setAttribute('aria-label', this.copy.chatLabel);

		const toolbar = createElement('header', 'chat-toolbar');
		const toolbarActions = createElement('div', 'chat-toolbar-actions');
		const newChatButton = createElement('button', 'chat-toolbar-button');
		newChatButton.type = 'button';
		newChatButton.title = this.copy.newChat;
		newChatButton.setAttribute('aria-label', this.copy.newChat);
		newChatButton.append(createChatIcon('plus'));
		newChatButton.addEventListener('click', () => this.startNewChat());
		toolbarActions.append(newChatButton);
		this.historyControl = new ChatHistoryControl({
			parent: toolbarActions,
			sessions: this.sessions,
			onSelect: (sessionId) => {
				this.selectedSessionId = sessionId;
				this.invokeSafely(
					() => this.callbacks.onSessionSelect?.(sessionId),
					'세션 선택 callback',
				);
			},
		});
		toolbar.append(toolbarActions);

		this.messageList = createElement('section', 'chat-message-list');
		this.messageList.setAttribute('role', 'log');
		this.messageList.setAttribute('aria-live', 'polite');
		this.messageList.setAttribute('aria-relevant', 'additions');
		this.messageList.setAttribute('aria-label', '대화 메시지');
		if (typeof ResizeObserver !== 'undefined') {
			this.messageResizeObserver = new ResizeObserver((entries) => {
				const width = entries[0]?.contentRect.width
					?? this.messageList.clientWidth;
				if (Math.abs(width - this.lastMessageListWidth) < 0.5) {
					return;
				}
				this.lastMessageListWidth = width;
				this.scheduleMessageOverflowMeasurement();
			});
			this.messageResizeObserver.observe(this.messageList);
		}
		this.approvalHost = createElement('aside', 'chat-approval-dock-host');
		this.approvalHost.hidden = true;
		this.approvalHost.setAttribute('aria-live', 'polite');
		this.approvalHost.setAttribute('aria-atomic', 'true');

		this.footer = createElement('footer', 'chat-footer');
		this.composerForm = createElement('form', 'chat-composer');
		this.composerForm.addEventListener('submit', (event) => {
			event.preventDefault();
			if (this.isRunning) {
				this.stopRun();
			} else {
				this.sendMessage();
			}
		});

		const composerSurface = createElement('div', 'chat-composer-surface');
		const messageField = createElement('label', 'chat-message-field');
		const messageLabel = createElement(
			'span',
			'chat-visually-hidden',
			this.copy.messageLabel,
		);
		this.messageInput = createElement('textarea', 'chat-message-input');
		this.messageInput.rows = 3;
		this.messageInput.placeholder = this.copy.messagePlaceholder;
		this.messageInput.addEventListener('input', () => {
			this.resizeMessageInput();
			this.updateComposerState();
		});
		this.messageInput.addEventListener('keydown', (event) => {
			if (
				event.key === 'Enter'
				&& !event.shiftKey
				&& !event.isComposing
				&& event.keyCode !== 229
			) {
				event.preventDefault();
				this.sendMessage();
			}
		});
		messageField.append(messageLabel, this.messageInput);

		const composerTools = createElement('div', 'chat-composer-tools');
		const composerActions = createElement('div', 'chat-composer-actions');
		this.runtimeSettings = new ChatRuntimeSettingsControl({
			parent: composerActions,
			agents: options.agents,
			models: options.models,
			modelOptions: options.modelOptions,
		});
		this.submitButton = createElement('button', 'chat-submit-button');
		this.submitButton.type = 'submit';
		composerActions.append(this.submitButton);
		composerTools.append(composerActions);
		composerSurface.append(messageField, composerTools);

		this.runStatus = createElement('span', 'chat-visually-hidden');
		this.runStatus.setAttribute('aria-live', 'polite');
		this.composerForm.append(composerSurface, this.runStatus);
		this.footer.append(this.composerForm);

		const actionSlot = createElement('div', 'chat-action-slot');
		actionSlot.append(this.approvalHost, this.footer);

		this.decisionAnnouncer = createElement(
			'div',
			'chat-visually-hidden',
		);
		this.decisionAnnouncer.setAttribute('role', 'status');
		this.decisionAnnouncer.setAttribute('aria-live', 'polite');
		this.decisionAnnouncer.setAttribute('aria-atomic', 'true');

		shell.append(
			toolbar,
			this.messageList,
			actionSlot,
		);
		this.root.append(shell, this.decisionAnnouncer);
	}

	/** 현재 메시지 배열을 역할별 좌우 말풍선 또는 빈 상태로 다시 렌더링한다. */
	private renderMessages(): void {
		this.messageList.replaceChildren();

		if (this.messages.length === 0) {
			const empty = createElement(
				'p',
				'chat-message-empty',
				this.copy.emptyMessages,
			);
			this.messageList.append(empty);
		} else {
			for (const [index, message] of this.messages.entries()) {
				const article = createElement(
					'article',
					`chat-message is-${message.role}`,
				);
				const metadata = createElement('div', 'chat-message-metadata');
				const sender = createElement(
					'span',
					'chat-message-sender',
					message.role === 'user' ? this.copy.you : this.copy.agent,
				);
				const time = createElement(
					'time',
					'chat-message-time',
					formatClockTime(message.createdAt),
				);
				time.dateTime = message.createdAt;
				const content = createElement('div', 'chat-message-content');
				content.dataset.messageId = message.id;
				const body = createElement('p', 'chat-message-body', message.text);
				body.id = `chat-message-body-${index}`;
				const overflowControls = createElement(
					'div',
					'chat-message-overflow-controls',
				);
				overflowControls.hidden = true;
				const ellipsis = createElement('span', 'chat-message-ellipsis', '…');
				ellipsis.setAttribute('aria-hidden', 'true');
				const toggleButton = createElement(
					'button',
					'chat-message-toggle',
					this.copy.showMore,
				);
				toggleButton.type = 'button';
				toggleButton.setAttribute('aria-controls', body.id);
				toggleButton.setAttribute('aria-expanded', 'false');
				toggleButton.addEventListener('click', () => {
					this.toggleMessageExpansion(message.id, article);
				});
				overflowControls.append(ellipsis, toggleButton);
				content.append(body, overflowControls);
				metadata.append(sender, time);
				article.append(metadata, content);
				this.messageList.append(article);
			}
		}

		this.scheduleMessageOverflowMeasurement();
	}

	/** 현재 승인 요청을 조건부 Dock으로 렌더링하고 요청이 없으면 공간을 회수한다. */
	private renderApproval(): void {
		this.approvalHost.replaceChildren();
		this.approvalHost.hidden = this.approvalRequest === undefined;
		this.footer.hidden = this.approvalRequest !== undefined;
		if (!this.approvalRequest) {
			this.updateComposerState();
			return;
		}

		const card = createElement('section', 'chat-approval-dock');
		card.setAttribute('aria-labelledby', 'chat-approval-heading');
		const content = createElement('div', 'chat-approval-content');
		const eyebrow = createElement(
			'span',
			'chat-approval-eyebrow',
			this.copy.approvalHeading,
		);
		const heading = createElement(
			'h3',
			'chat-approval-title',
			this.approvalRequest.title,
		);
		heading.id = 'chat-approval-heading';
		const description = createElement(
			'p',
			'chat-approval-description',
			this.approvalRequest.description,
		);
		content.append(eyebrow, heading, description);
		const actions = createElement('div', 'chat-approval-actions');
		const rejectButton = createElement(
			'button',
			'chat-approval-button is-reject',
			this.copy.reject,
		);
		rejectButton.type = 'button';
		rejectButton.addEventListener('click', () => {
			this.decideApproval('rejected');
		});
		const approveButton = createElement(
			'button',
			'chat-approval-button is-approve',
			this.copy.approve,
		);
		approveButton.type = 'button';
		approveButton.addEventListener('click', () => {
			this.decideApproval('approved');
		});
		actions.append(rejectButton, approveButton);
		card.append(content, actions);

		this.approvalHost.append(card);
	}

	/** 대화 관련 로컬 상태만 초기화하고 실행 설정 선택값은 유지한다. */
	private startNewChat(): void {
		this.selectedSessionId = undefined;
		this.messages = [];
		this.expandedMessageIds.clear();
		this.approvalRequest = undefined;
		this.isRunning = false;
		this.messageInput.value = '';
		this.resetMessageInputHeight();
		this.historyControl.clearSelection();
		this.historyControl.close();
		this.runtimeSettings.close();
		this.renderMessages();
		this.renderApproval();
		this.updateComposerState();
		this.messageInput.focus();
		this.invokeSafely(this.callbacks.onNewChat, '새 대화 callback');
	}

	/** 메시지의 펼침 상태를 바꾸고 접힐 때 현재 카드가 화면에 남도록 보정한다. */
	private toggleMessageExpansion(messageId: string, article: HTMLElement): void {
		const wasExpanded = this.expandedMessageIds.has(messageId);
		if (wasExpanded) {
			this.expandedMessageIds.delete(messageId);
		} else {
			this.expandedMessageIds.add(messageId);
		}

		this.measureMessageOverflow();
		if (wasExpanded) {
			requestAnimationFrame(() => {
				if (!this.disposed) {
					article.scrollIntoView({ block: 'nearest' });
				}
			});
		}
	}

	/** 다음 paint 직전에 모든 완료 메시지의 실제 8줄 초과 여부를 한 번 측정한다. */
	private scheduleMessageOverflowMeasurement(): void {
		if (this.disposed || this.messageMeasurementFrame !== undefined) {
			return;
		}

		this.messageMeasurementFrame = requestAnimationFrame(() => {
			this.messageMeasurementFrame = undefined;
			this.measureMessageOverflow();
		});
	}

	/** 원문 높이와 계산된 line-height를 비교해 각 메시지의 접기 UI를 동기화한다. */
	private measureMessageOverflow(): void {
		if (this.disposed) {
			return;
		}

		const messagesById = new Map(this.messages.map((message) => [message.id, message]));
		const contents = this.messageList.querySelectorAll<HTMLElement>(
			'.chat-message-content[data-message-id]',
		);
		for (const content of contents) {
			const messageId = content.dataset.messageId;
			const message = messageId ? messagesById.get(messageId) : undefined;
			const body = content.querySelector<HTMLElement>('.chat-message-body');
			const controls = content.querySelector<HTMLElement>(
				'.chat-message-overflow-controls',
			);
			const button = controls?.querySelector<HTMLButtonElement>(
				'.chat-message-toggle',
			);
			if (!messageId || !message || !body || !controls || !button) {
				continue;
			}

			body.classList.remove('is-collapsed');
			content.classList.remove('is-collapsible', 'is-collapsed', 'is-expanded');
			const isStreaming = message.role === 'agent'
				&& message.status === 'streaming';
			const bodyStyles = getComputedStyle(body);
			const lineHeight = parsePixelValue(bodyStyles.lineHeight, 18);
			const verticalPadding = parsePixelValue(bodyStyles.paddingTop, 0)
				+ parsePixelValue(bodyStyles.paddingBottom, 0);
			const renderedTextHeight = Math.max(0, body.scrollHeight - verticalPadding);
			const collapsedHeight = lineHeight * collapsedMessageLineCount;
			const isOverflowing = !isStreaming
				&& renderedTextHeight > Math.ceil(collapsedHeight) + 1;
			if (!isOverflowing) {
				controls.hidden = true;
				button.setAttribute('aria-expanded', 'false');
				continue;
			}

			const isExpanded = this.expandedMessageIds.has(messageId);
			controls.hidden = false;
			content.classList.add('is-collapsible');
			content.classList.toggle('is-collapsed', !isExpanded);
			content.classList.toggle('is-expanded', isExpanded);
			body.classList.toggle('is-collapsed', !isExpanded);
			button.textContent = isExpanded ? this.copy.showLess : this.copy.showMore;
			button.setAttribute('aria-expanded', String(isExpanded));
			button.setAttribute(
				'aria-label',
				isExpanded ? '메시지 접기' : '메시지 더 보기',
			);
		}
	}
	
	/** 유효한 입력을 사용자 메시지로 추가하고 선택된 실행 환경과 함께 전달한다. */
	private sendMessage(): void {
		if (this.disposed || this.isRunning) {
			return;
		}

		const text = this.messageInput.value.trim();
		if (!text) {
			this.updateComposerState();
			return;
		}

		const selection: ChatSelection = {
			agent: this.runtimeSettings.agentValue,
			model: this.runtimeSettings.modelValue,
			modelOption: this.runtimeSettings.modelOptionValue,
		};
		this.addMessage({
			id: `local-user-${Date.now()}-${++this.localMessageSequence}`,
			role: 'user',
			text,
			createdAt: new Date().toISOString(),
		});
		this.messageInput.value = '';
		this.resetMessageInputHeight();
		this.setRunning(true);
		this.invokeSafely(
			() => this.callbacks.onSend?.({ ...selection, text }),
			'메시지 전송 callback',
		);
	}

	/** 로컬 실행 상태를 해제하고 외부 실행 중지 callback을 호출한다. */
	private stopRun(): void {
		if (!this.isRunning) {
			return;
		}

		this.setRunning(false);
		this.messageInput.focus();
		this.invokeSafely(this.callbacks.onStop, '실행 중지 callback');
	}

	/**
	 * 현재 승인 요청의 결정을 전달한 뒤 Dock을 즉시 제거한다.
	 *
	 * @param decision 사용자가 선택한 승인 또는 거부 결과.
	 */
	private decideApproval(decision: ChatApprovalDecision): void {
		if (!this.approvalRequest) {
			return;
		}

		const requestId = this.approvalRequest.id;
		this.invokeSafely(
			() => this.callbacks.onApprovalDecision?.(requestId, decision),
			'승인 결정 callback',
		);
		this.approvalRequest = undefined;
		this.renderApproval();
		this.announceDecision(decision);
	}

	/**
	 * 승인 결과를 다음 animation frame에 aria-live 영역으로 알린다.
	 *
	 * @param decision 보조 기술에 전달할 승인 또는 거부 결과.
	 */
	private announceDecision(decision: ChatApprovalDecision): void {
		if (this.announcementFrame !== undefined) {
			cancelAnimationFrame(this.announcementFrame);
		}
		this.decisionAnnouncer.textContent = '';
		this.announcementFrame = requestAnimationFrame(() => {
			this.announcementFrame = undefined;
			if (!this.disposed) {
				this.decisionAnnouncer.textContent = decision === 'approved'
					? this.copy.approvedAnnouncement
					: this.copy.rejectedAnnouncement;
			}
		});
	}

	/** 실행 여부와 입력 유무에 맞춰 설정·textarea·전송 버튼 상태를 동기화한다. */
	private updateComposerState(): void {
		if (!this.submitButton) {
			return;
		}

		const hasMessage = this.messageInput.value.trim().length > 0;
		this.composerForm.setAttribute('aria-busy', String(this.isRunning));
		this.runtimeSettings.disabled = this.isRunning;
		this.messageInput.disabled = this.isRunning;
		this.submitButton.disabled = !this.isRunning && !hasMessage;
		this.submitButton.classList.toggle('is-running', this.isRunning);
		this.submitButton.setAttribute(
			'aria-label',
			this.isRunning ? '실행 중지' : '메시지 전송',
		);
		this.submitButton.title = this.isRunning ? '실행 중지' : '메시지 전송';
		this.submitButton.replaceChildren(
			createChatIcon(this.isRunning ? 'stop' : 'send'),
		);
		this.runStatus.textContent = this.isRunning
			? this.copy.runningStatus
			: '';
	}

	/** textarea를 CSS 최소·최대 높이 안에서 자동 확장하고 초과분만 내부 스크롤한다. */
	private resizeMessageInput(): void {
		this.messageInput.style.height = 'auto';
		const styles = getComputedStyle(this.messageInput);
		const minimumHeight = parsePixelValue(styles.minHeight, 58);
		const maximumHeight = parsePixelValue(styles.maxHeight, 180);
		const contentHeight = this.messageInput.scrollHeight;
		const nextHeight = clamp(contentHeight, minimumHeight, maximumHeight);
		this.messageInput.style.height = `${nextHeight}px`;
		this.messageInput.style.overflowY = contentHeight > maximumHeight
			? 'auto'
			: 'hidden';
	}

	/** 전송 또는 새 대화 이후 textarea의 inline 높이와 overflow를 기본값으로 돌린다. */
	private resetMessageInputHeight(): void {
		this.messageInput.style.height = '';
		this.messageInput.style.overflowY = 'hidden';
	}

	/**
	 * 선택적 외부 callback 오류가 Webview 렌더링 생명주기를 중단하지 않게 보호한다.
	 *
	 * @param callback 호출할 선택적 callback.
	 * @param label 오류 로그에서 callback 종류를 식별할 설명.
	 */
	private invokeSafely(callback: (() => void) | undefined, label: string): void {
		if (!callback) {
			return;
		}

		try {
			callback();
		} catch (error) {
			console.error(`[Crispy Chat] ${label} 실행 실패:`, error);
		}
	}
}

/**
 * 실제 사용자, Workspace 또는 특정 컴퓨터 경로에 의존하지 않는 UI 검토 데이터를 만든다.
 *
 * @param now 상대 시각이 매번 달라지지 않도록 주입할 기준 시각.
 * @returns 세션·메시지·실행 설정·승인 요청을 포함한 더미 Chat 옵션.
 */
export function createDemoChatOptions(now = new Date()): ChatViewOptions {
	const minute = 60_000;
	const isoBefore = (milliseconds: number): string =>
		new Date(now.getTime() - milliseconds).toISOString();

	return {
		sessions: [
			{
				id: 'session-agent-ui',
				title: 'Agent 대화 UI 구성',
				lastResponseAt: isoBefore(8 * minute),
			},
			{
				id: 'session-workspace-analysis',
				title: 'Workspace 구조 분석 검토',
				lastResponseAt: isoBefore(47 * minute),
			},
			{
				id: 'session-plan-validation',
				title: 'ChangePlan 검증 규칙 정리',
				lastResponseAt: isoBefore(26 * 60 * minute),
			},
		],
		messages: [
			{
				id: 'message-user-demo',
				role: 'user',
				text: '현재 프로젝트 구조를 확인하고 다음 구현 계획을 정리해 줘.',
				createdAt: isoBefore(12 * minute),
				status: 'completed',
			},
			{
				id: 'message-agent-demo',
				role: 'agent',
				text: [
					'프로젝트 구조를 확인했습니다.',
					'변경 대상과 검증 순서를 포함한 계획을 준비했습니다.',
					'',
					'1. 기존 Chat 렌더링 구조를 유지합니다.',
					'2. 승인 요청은 하단 Action Slot에 표시합니다.',
					'3. Composer 입력 초안은 승인 대기 중에도 보존합니다.',
					'4. 완료된 긴 메시지는 실제 렌더링 높이를 측정합니다.',
					'5. 8줄을 초과하면 더 보기 버튼을 표시합니다.',
					'6. Panel 폭이 바뀌면 접기 여부를 다시 계산합니다.',
					'7. 좁은 화면과 낮은 화면을 함께 검증합니다.',
				].join(' '),
				createdAt: isoBefore(8 * minute),
				status: 'completed',
			},
		],
		agents: [{ value: 'codex', label: 'Codex' }],
		models: [{ value: 'default', label: '기본 모델' }],
		modelOptions: [{ value: 'default', label: '기본 옵션' }],
		approvalRequest: {
			id: 'approval-demo',
			title: '계획 적용 승인',
			description: 'Agent가 준비한 ChangePlan을 다음 단계로 전달하도록 승인하시겠습니까?',
		},
	};
}

/**
 * 클래스와 선택적 textContent를 지정해 안전한 HTML 요소를 생성한다.
 *
 * @param tagName 생성할 HTML 태그 이름.
 * @param className 요소에 적용할 CSS class 문자열.
 * @param text HTML로 해석하지 않고 textContent에 넣을 선택적 문자열.
 * @returns 태그 이름에 대응하는 구체적인 HTMLElement.
 */
function createElement<K extends keyof HTMLElementTagNameMap>(
	tagName: K,
	className: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tagName);
	element.className = className;
	if (text !== undefined) {
		element.textContent = text;
	}
	return element;
}

/**
 * ISO 시각을 한국어 시·분 표기로 변환한다.
 *
 * @param value ISO 시각 또는 파싱할 수 없는 원본 문자열.
 * @returns 유효하면 한국어 시각, 유효하지 않으면 원본 값.
 */
function formatClockTime(value: string): string {
	const time = new Date(value);
	if (!Number.isFinite(time.getTime())) {
		return value;
	}

	return new Intl.DateTimeFormat('ko-KR', {
		hour: '2-digit',
		minute: '2-digit',
	}).format(time);
}

/**
 * 계산된 CSS pixel 문자열을 양의 숫자로 변환한다.
 *
 * @param value `getComputedStyle()`에서 읽은 CSS 값.
 * @param fallback 값이 유효하지 않을 때 사용할 기본 pixel 값.
 * @returns 변환한 양의 pixel 값 또는 fallback.
 */
function parsePixelValue(value: string, fallback: number): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 숫자를 주어진 최소·최대 범위 안으로 제한한다.
 *
 * @param value 제한할 값.
 * @param minimum 허용할 최솟값.
 * @param maximum 허용할 최댓값.
 * @returns 범위 안으로 제한된 값.
 */
function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
