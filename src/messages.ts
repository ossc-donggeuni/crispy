export type WebviewToExtensionMessage =
	| { type: 'webview.ready' };

export type ExtensionToWebviewMessage =
	| { type: 'extension.ready' };
