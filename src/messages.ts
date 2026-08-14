import type { PersistedWebviewState } from './webview/webviewState';

/** Webview에서 Extension Host로 전송하는 메시지. */
export type WebviewToExtensionMessage =
	/** webview.ready : Webview 초기화가 완료되었음을 알린다. */
	| { type: 'webview.ready' }
	/** webview.stateChanged : 현재 Panel 및 Graph 상태 snapshot을 전달한다. */
	| {
		type: 'webview.stateChanged';
		state: PersistedWebviewState;
	};

/** Extension Host에서 Webview로 전송하는 메시지. */
export type ExtensionToWebviewMessage =
	/** extension.ready : Extension Host가 Webview의 준비 메시지를 수신했음을 알린다. */
	| { type: 'extension.ready' };
