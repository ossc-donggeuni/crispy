import { ChatView, createDemoChatOptions } from './chat';

/** Chat Webview HTML이 제공하는 단일 mount 지점이다. */
const rootElement = document.getElementById('chat-app');

if (!rootElement) {
	throw new Error('Crispy could not find its Chat Webview root element.');
}

/** 초기화 실패 화면을 포함해 Chat 화면 전체를 렌더링할 root 요소다. */
const root: HTMLElement = rootElement;

/** beforeunload와 초기화 오류에서 정리할 현재 ChatView instance다. */
let chatView: ChatView | undefined;

try {
	chatView = new ChatView(root, createDemoChatOptions());

	window.addEventListener(
		'beforeunload',
		() => {
			chatView?.dispose();
			chatView = undefined;
		},
		{ once: true },
	);
} catch (error) {
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

/**
 * 알 수 없는 초기화 오류를 사용자에게 표시할 문자열로 정규화한다.
 *
 * @param error ChatView 초기화 과정에서 전달된 오류 값.
 * @returns Error message 또는 오류 값의 문자열 표현.
 */
function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
