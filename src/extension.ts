import * as vscode from 'vscode';
import type {
	ExtensionToWebviewMessage,
	WebviewToExtensionMessage,
} from './messages';
import {
	getPanelLayoutStateFromMessage,
	serializePanelLayoutState,
	type PanelLayoutState,
} from './webview/panelState';

let currentPanel: vscode.WebviewPanel | undefined;
let lastLayoutState: PanelLayoutState | undefined;

/**
 * Crispy 확장을 활성화하고 Canvas Webview를 여는 명령을 등록한다.
 *
 * @param context 확장의 구독 항목과 설치 경로를 제공하는 VS Code 확장 컨텍스트
 */
export function activate(context: vscode.ExtensionContext) {
	/**
	 * 기존 WebviewPanel을 표시하거나 새 Panel에 Dock 및 Resize UI를 설정한다.
	 */
	const openCanvas = (): vscode.WebviewPanel => {
		if (currentPanel) {
			currentPanel.reveal();
			return currentPanel;
		}

		const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
		const panel = vscode.window.createWebviewPanel(
			'crispy.webview',
			'Crispy',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [webviewRoot],
			},
		);
		currentPanel = panel;

		const stylesUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(webviewRoot, 'webview.css'),
		);
		const scriptUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(webviewRoot, 'webview.js'),
		);

		panel.webview.onDidReceiveMessage((message: unknown) => {
			// Layout State Message Handler
			const layoutState = getPanelLayoutStateFromMessage(message);
			if (layoutState) {
				lastLayoutState = layoutState;
				return;
			}

			handleWebviewMessage(panel.webview, message);
		});

		panel.webview.html = getWebviewHtml(
			panel.webview,
			stylesUri,
			scriptUri,
			lastLayoutState,
		);

		panel.onDidDispose(() => {
			currentPanel = undefined;
		});

		return panel;
	};

	const disposable = vscode.commands.registerCommand('crispy.openCanvas', openCanvas);

	context.subscriptions.push(disposable);
}

/**
 * Webview가 전송한 Extension 수준 메시지를 처리한다.
 *
 * @param webview 응답 메시지를 전송할 Webview
 * @param message Webview에서 수신한 메시지
 * @returns 메시지를 Webview에 전달한 결과 또는 처리 대상이 아닐 때 `undefined`
 */
export function handleWebviewMessage(
	webview: Pick<vscode.Webview, 'postMessage'>,
	message: unknown,
): Thenable<boolean> | undefined {
	if (!message || typeof message !== 'object') {
		return undefined;
	}

	const webviewMessage = message as WebviewToExtensionMessage;

	switch (webviewMessage.type) {
		case 'webview.ready':
			console.log('[Crispy] Webview ready');

			return webview.postMessage({
				type: 'extension.ready',
			} satisfies ExtensionToWebviewMessage);
	}

	return undefined;
}

/**
 * 확장이 비활성화될 때 열린 WebviewPanel과 참조를 정리한다.
 */
export function deactivate() {
	currentPanel?.dispose();
	currentPanel = undefined;
	lastLayoutState = undefined;
}

/**
 * Graph와 Agent Chat 영역 및 Webview 리소스 참조를 포함하는 HTML 문서를 생성한다.
 *
 * @param webview Content Security Policy에 사용할 Webview 인스턴스
 * @param stylesUri Webview 전용 CSS 리소스 URI
 * @param scriptUri Dock 및 Resize 동작을 실행하는 Webview 스크립트 URI
 * @param initialLayoutState 새 Panel에 전달할 마지막 Webview Layout 상태
 * @returns WebviewPanel에 설정할 완성된 HTML 문자열
 */
function getWebviewHtml(
	webview: vscode.Webview,
	stylesUri: vscode.Uri,
	scriptUri: vscode.Uri,
	initialLayoutState: PanelLayoutState | undefined,
): string {
	const serializedLayoutState = serializePanelLayoutState(initialLayoutState);

	return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
				<link rel="stylesheet" href="${stylesUri}">
				<title>Crispy</title>
			</head>
			<body>
				<main class="crispy-layout" data-dock="right">
					<section id="graph-area"></section>
					<div id="panel-resize-handle"></div>
					<section id="agent-chat-area">
						Agent Chat
						<button id="chat-drag-handle" type="button" aria-label="Move Agent Chat" title="Move Agent Chat">⠿</button>
					</section>
					<div id="dock-preview" aria-hidden="true" hidden></div>
				</main>
				<script src="${scriptUri}" data-layout-state="${serializedLayoutState}"></script>
			</body>
			</html>`;
}
