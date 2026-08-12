/** Webview에서 Extension Host로 전송하는 메시지. */
export type WebviewToExtensionMessage =
	/** webview.ready : Webview 초기화가 완료되었음을 알린다. */
	| { type: 'webview.ready' };

/** Extension Host에서 Webview로 전송하는 메시지. */
export type ExtensionToWebviewMessage =
	/** extension.ready : Extension Host가 Webview의 준비 메시지를 수신했음을 알린다. */
	| { type: 'extension.ready' };
