import './chat.css';
import {
	ChatView,
	createConnectedChatOptions,
} from './chat';
import { createChatMarkdownRenderer } from './chatMarkdown';
import {
	isCodexChatHostMessage,
	type CodexChatViewSnapshot,
	type CodexChatWebviewMessage,
} from './Codex/chatBridgeProtocol';

/** VS Code Webview가 Extension Host와 통신할 때 제공하는 최소 API다. */
interface VsCodeWebviewApi {
	/** runtime validation 대상 메시지를 Extension Host에 전달한다. */
	postMessage(message: CodexChatWebviewMessage): void;
}

/** VS Code가 Webview 전역에 주입하는 API 획득 함수다. */
declare function acquireVsCodeApi(): VsCodeWebviewApi;

/** Chat Webview HTML이 제공하는 단일 mount 지점이다. */
const rootElement = document.getElementById('chat-app');

if (!rootElement) {
	throw new Error('Crispy could not find its Chat Webview root element.');
}

/** 초기화 실패 화면을 포함해 Chat 화면 전체를 렌더링할 root 요소다. */
const root: HTMLElement = rootElement;

/** beforeunload와 초기화 오류에서 정리할 현재 ChatView instance다. */
let chatView: ChatView | undefined;

/** Host snapshot에서 받은 현재 draft 또는 Thread 대화 ID다. */
let selectedConversationId: string | undefined;

/** ESM Markdown parser를 준비한 뒤 Host와 연결된 ChatView를 시작한다. */
async function startChat(): Promise<void> {
	const vscodeApi = acquireVsCodeApi();
	const renderMarkdown = await createChatMarkdownRenderer();
	chatView = new ChatView(root, createConnectedChatOptions({
		onSend: ({ text }) => {
			if (!selectedConversationId) {
				return;
			}
			vscodeApi.postMessage({
				type: 'codexChat/send',
				payload: { conversationId: selectedConversationId, text },
			});
		},
		onNewChat: () => {
			vscodeApi.postMessage({ type: 'codexChat/newDraft' });
		},
		onSessionSelect: (conversationId) => {
			vscodeApi.postMessage({
				type: 'codexChat/selectConversation',
				payload: { conversationId },
			});
		},
		onOpenExternal: (url) => {
			vscodeApi.postMessage({
				type: 'chat/openExternal',
				payload: { url },
			});
		},
	}, renderMarkdown));

	window.addEventListener('message', (event: MessageEvent<unknown>) => {
		if (!isCodexChatHostMessage(event.data) || !chatView) {
			return;
		}
		applySnapshot(chatView, event.data.payload);
	});
	vscodeApi.postMessage({ type: 'codexChat/ready' });

	window.addEventListener(
		'beforeunload',
		() => {
			chatView?.dispose();
			chatView = undefined;
		},
		{ once: true },
	);
}

/** 초기화 오류를 기존 Chat mount 지점에 안전한 plain text로 표시한다. */
function renderStartupError(error: unknown): void {
	chatView?.dispose();
	chatView = undefined;
	const errorState = document.createElement('div');
	errorState.className = 'chat-startup-error';
	const title = document.createElement('strong');
	title.className = 'chat-startup-error-title';
	title.textContent = 'Crispy Chat을 시작하지 못했습니다.';
	const detail = document.createElement('span');
	detail.className = 'chat-startup-error-detail';
	detail.textContent = getErrorMessage(error);
	errorState.append(title, detail);
	root.replaceChildren(errorState);
	console.error('[Crispy Chat] Webview startup failed:', error);
}

/** Host의 authoritative snapshot을 현재 ChatView에 한 번에 반영한다. */
function applySnapshot(view: ChatView, snapshot: CodexChatViewSnapshot): void {
	selectedConversationId = snapshot.selectedConversationId;
	view.setSessions(snapshot.sessions);
	view.setMessages(snapshot.items);
	view.setRunning(snapshot.isRunning);
	view.setComposerAvailable(snapshot.composerAvailable);
	view.setError(snapshot.error);
}

/** 알 수 없는 초기화 오류를 사용자에게 표시할 문자열로 정규화한다. */
function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

void startChat().catch(renderStartupError);
