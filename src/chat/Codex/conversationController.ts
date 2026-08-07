/** Chat UI 동작을 Codex app-server Thread·Turn 요청과 상태 snapshot에 연결한다. */

import { randomUUID } from 'node:crypto';

import type { ClientRequest } from './generated/ClientRequest';
import type { CodexAppServerClient } from './appServerClient';
import type {
	CodexChatSnapshotMessage,
	CodexChatViewSnapshot,
	CodexChatWebviewMessage,
} from './chatBridgeProtocol';
import type { CodexConnectionState } from './contracts';
import { CodexConversationStateStore } from './conversationState';
import type { CrispyThreadStartRequest, CrispyTurnStartRequest } from './protocol';
import type {
	CodexInboundMessage,
	CodexServerNotificationMessage,
} from './runtimeValidation';

/** controller가 테스트 대체 client와 공유하는 최소 app-server 계약이다. */
export type CodexConversationClient = Pick<
	CodexAppServerClient,
	'state' | 'createRequestId' | 'request'
>;

/** Webview snapshot을 받을 listener 계약이다. */
export type CodexConversationSnapshotListener = (
	message: CodexChatSnapshotMessage,
) => void;

/** controller의 app-server와 환경 의존성을 주입하는 옵션이다. */
export interface CodexConversationControllerOptions {
	/** ready 상태와 RPC 요청을 제공하는 app-server client다. */
	client: CodexConversationClient;
	/** thread/start의 cwd와 runtimeWorkspaceRoots에 사용할 단일 Workspace 경로다. */
	workspacePath: string | null;
	/** 테스트에서 결정적 ID를 공급할 수 있는 식별자 생성 함수다. */
	createId?: () => string;
	/** 테스트에서 결정적 시각을 공급할 수 있는 Unix milliseconds 함수다. */
	now?: () => number;
}

/**
 * Chat Webview 명령, app-server notification과 메모리 상태의 단일 조정자다.
 */
export class CodexConversationController {
	/** Thread·Turn·Item과 선택된 draft 상태를 관리하는 저장소다. */
	private readonly store: CodexConversationStateStore;
	/** Panel별 snapshot 구독자다. */
	private readonly listeners = new Set<CodexConversationSnapshotListener>();
	/** Thread 응답보다 먼저 도착한 notification을 Thread ID별로 보관한다. */
	private readonly deferredNotifications = new Map<
		string,
		CodexServerNotificationMessage[]
	>();
	/** 로컬 식별자 생성 함수다. */
	private readonly createId: () => string;
	/** Extension 생명주기 종료 뒤 비동기 결과를 무시하는 flag다. */
	private disposed = false;

	/**
	 * 초기 draft와 현재 app-server 연결 상태를 준비한다.
	 *
	 * @param options client, Workspace 경로와 테스트 교체 지점.
	 */
	public constructor(
		private readonly options: CodexConversationControllerOptions,
	) {
		this.createId = options.createId ?? randomUUID;
		this.store = new CodexConversationStateStore(this.createId, options.now);
		this.store.setConnectionState(options.client.state);
	}

	/**
	 * Panel에 snapshot listener를 등록한다.
	 *
	 * @param listener 상태 변경 때 호출할 listener.
	 * @returns 해당 listener만 제거하는 정리 함수.
	 */
	public subscribe(listener: CodexConversationSnapshotListener): () => void {
		if (this.disposed) {
			return () => undefined;
		}
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * 현재 선택된 대화 상태를 Webview 메시지로 감싼다.
	 *
	 * @returns Panel이 즉시 전송할 수 있는 snapshot 메시지.
	 */
	public snapshotMessage(): CodexChatSnapshotMessage {
		return {
			type: 'codexChat/snapshot',
			payload: this.snapshot,
		};
	}

	/**
	 * 현재 선택된 대화의 불변 표시 snapshot을 반환한다.
	 *
	 * @returns Webview가 안전하게 렌더링할 표시 상태.
	 */
	public get snapshot(): CodexChatViewSnapshot {
		return this.store.snapshot(this.options.workspacePath !== null);
	}

	/**
	 * runtime validation을 통과한 Webview 명령을 처리한다.
	 *
	 * @param message Panel이 검증한 Webview 메시지.
	 * @returns 비동기 전송 작업이 끝나면 완료되는 Promise.
	 */
	public async handleWebviewMessage(
		message: CodexChatWebviewMessage,
	): Promise<void> {
		if (this.disposed) {
			return;
		}
		switch (message.type) {
			case 'codexChat/ready':
				this.emitSnapshot();
				break;
			case 'codexChat/newDraft':
				this.store.createDraft();
				this.emitSnapshot();
				break;
			case 'codexChat/selectConversation':
				if (this.store.selectConversation(message.payload.conversationId)) {
					this.emitSnapshot();
				}
				break;
			case 'codexChat/send':
				await this.sendText(
					message.payload.conversationId,
					message.payload.text,
				);
				break;
		}
	}

	/**
	 * app-server client의 연결 상태 callback을 상태 저장소에 반영한다.
	 *
	 * @param state client가 전달한 불변 연결 상태.
	 */
	public handleConnectionStateChanged(
		state: Readonly<CodexConnectionState>,
	): void {
		if (this.disposed) {
			return;
		}
		this.store.setConnectionState(state);
		this.emitSnapshot();
	}

	/**
	 * app-server의 notification만 method별 상태 reducer로 전달한다.
	 *
	 * @param message stdio envelope validation을 통과한 inbound 메시지.
	 */
	public handleAppServerMessage(message: CodexInboundMessage): void {
		if (this.disposed || message.kind !== 'notification') {
			return;
		}
		const result = this.store.applyNotification(message);
		if (result === 'unknownThread') {
			const threadId = getNotificationThreadId(message);
			if (threadId) {
				const pending = this.deferredNotifications.get(threadId) ?? [];
				pending.push(message);
				this.deferredNotifications.set(threadId, pending);
			}
			return;
		}
		if (result === 'applied') {
			this.emitSnapshot();
		}
	}

	/** listener와 지연 notification을 제거하고 이후 비동기 갱신을 막는다. */
	public dispose(): void {
		this.disposed = true;
		this.listeners.clear();
		this.deferredNotifications.clear();
	}

	/**
	 * 첫 전송에만 Thread를 만들고 모든 전송에 client ID가 있는 Turn을 시작한다.
	 *
	 * @param conversationId Webview snapshot에서 받은 대상 대화 ID.
	 * @param text 사용자 입력 원문.
	 */
	private async sendText(conversationId: string, text: string): Promise<void> {
		if (this.options.client.state.phase !== 'ready') {
			this.store.reportError(
				conversationId,
				'Codex app-server 연결이 아직 준비되지 않았습니다.',
			);
			this.emitSnapshot();
			return;
		}
		const workspacePath = this.options.workspacePath;
		if (!workspacePath) {
			this.store.reportError(
				conversationId,
				'Codex 대화를 시작하려면 Workspace 폴더를 열어야 합니다.',
			);
			this.emitSnapshot();
			return;
		}

		let prepared;
		try {
			prepared = this.store.prepareTurn(
				conversationId,
				text,
				this.createId(),
			);
		} catch (error) {
			this.store.reportError(conversationId, error);
			this.emitSnapshot();
			return;
		}

		try {
			this.emitSnapshot();
			let threadId = prepared.threadId;
			if (!threadId) {
				const threadRequest: CrispyThreadStartRequest = {
					id: this.options.client.createRequestId(),
					method: 'thread/start',
					params: {
						cwd: workspacePath,
						runtimeWorkspaceRoots: [workspacePath],
						approvalPolicy: 'on-request',
						approvalsReviewer: 'user',
						sandbox: 'workspace-write',
						ephemeral: false,
						threadSource: 'crispy',
					},
				};
				const threadResult = await this.requestUnknown(threadRequest);
				threadId = this.store.attachStartedThread(conversationId, threadResult);
				this.flushDeferredNotifications(threadId);
				this.emitSnapshot();
			}

			const turnRequest: CrispyTurnStartRequest = {
				id: this.options.client.createRequestId(),
				method: 'turn/start',
				params: {
					threadId,
					clientUserMessageId: prepared.clientUserMessageId,
					input: [{
						type: 'text',
						text: prepared.text,
						text_elements: [],
					}],
				},
			};
			const turnResult = await this.requestUnknown(turnRequest);
			this.store.attachStartedTurn(conversationId, turnResult);
			this.emitSnapshot();
		} catch (error) {
			this.store.failTurnStart(conversationId, error);
			this.emitSnapshot();
		}
	}

	/**
	 * generic client의 요청 결과를 method별 state validator가 받을 unknown으로 유지한다.
	 *
	 * @param request 생성 ClientRequest union을 만족하는 요청.
	 * @returns app-server의 아직 method validation 전인 result.
	 */
	private requestUnknown(request: ClientRequest): Promise<unknown> {
		return this.options.client.request<unknown>(request);
	}

	/**
	 * Thread 연결 전에 도착했던 notification을 원래 순서대로 재적용한다.
	 *
	 * @param threadId 새로 상태에 등록된 Codex Thread ID.
	 */
	private flushDeferredNotifications(threadId: string): void {
		const pending = this.deferredNotifications.get(threadId);
		if (!pending) {
			return;
		}
		this.deferredNotifications.delete(threadId);
		for (const notification of pending) {
			this.store.applyNotification(notification);
		}
	}

	/** 모든 Panel listener에 동일한 최신 snapshot을 동기적으로 전달한다. */
	private emitSnapshot(): void {
		if (this.disposed) {
			return;
		}
		const message = this.snapshotMessage();
		for (const listener of this.listeners) {
			listener(message);
		}
	}
}

/**
 * notification params에서 지연 라우팅에 필요한 Thread ID를 안전하게 읽는다.
 *
 * @param message envelope 검증을 통과한 app-server notification.
 * @returns method params의 Thread ID 또는 `undefined`.
 */
function getNotificationThreadId(
	message: CodexServerNotificationMessage,
): string | undefined {
	const params = message.params;
	if (typeof params !== 'object' || params === null || Array.isArray(params)) {
		return undefined;
	}
	const threadId = (params as Record<string, unknown>).threadId;
	return typeof threadId === 'string' && threadId.length > 0
		? threadId
		: undefined;
}
