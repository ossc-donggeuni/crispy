import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { ShellTerminalController } from './agent/host/shellTerminalController';
import { resolveTerminalWorkspace } from './agent/workspace';
import {
	getPanelLayoutStateFromMessage,
	serializePanelLayoutState,
	type PanelLayoutState,
} from './webview/panelState';

let currentPanel: vscode.WebviewPanel | undefined;
let currentTerminalController: ShellTerminalController | undefined;
let lastLayoutState: PanelLayoutState | undefined;
const pendingTerminalCleanups = new Set<Promise<boolean>>();

/**
 * Crispy 확장을 활성화하고 Canvas Webview를 여는 명령을 등록한다.
 *
 * @param context 확장의 구독 항목과 설치 경로를 제공하는 VS Code 확장 컨텍스트
 */
export function activate(context: vscode.ExtensionContext) {
	/**
	 * 기존 WebviewPanel을 표시하거나 새 Panel에 Dock 및 Resize UI를 설정한다.
	 */
	const openCanvas = () => {
		if (currentPanel) {
			currentPanel.reveal();
			return;
		}

		const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
		const panel = vscode.window.createWebviewPanel(
			'crispy.webview',
			'Crispy',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
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
			const layoutState = getPanelLayoutStateFromMessage(message);

			if (layoutState) {
				lastLayoutState = layoutState;
			}
		});
		const terminalController = new ShellTerminalController(
			panel,
			resolveTerminalWorkspace(
				vscode.workspace.isTrusted,
				vscode.workspace.workspaceFolders,
			),
		);
		currentTerminalController = terminalController;

		panel.webview.html = getWebviewHtml(
			panel.webview,
			stylesUri,
			scriptUri,
			lastLayoutState,
		);

		panel.onDidDispose(() => {
			if (currentPanel === panel) {
				currentPanel = undefined;
			}
			if (currentTerminalController === terminalController) {
				currentTerminalController = undefined;
			}
			trackTerminalCleanup(terminalController.dispose());
		});
	};

	const disposable = vscode.commands.registerCommand('crispy.openCanvas', openCanvas);

	context.subscriptions.push(disposable);
}

/**
 * 확장이 비활성화될 때 열린 WebviewPanel과 참조를 정리한다.
 */
export async function deactivate(): Promise<void> {
	const panel = currentPanel;
	const terminalController = currentTerminalController;
	currentPanel = undefined;
	currentTerminalController = undefined;

	const cleanup = terminalController?.dispose();
	panel?.dispose();
	if (cleanup) {
		await cleanup;
	}
	await Promise.all([...pendingTerminalCleanups]);
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
	const nonce = crypto.randomBytes(18).toString('base64');

	return `<!DOCTYPE html>
			<html lang="ko">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
				<link rel="stylesheet" href="${stylesUri}">
				<title>Crispy</title>
			</head>
			<body>
				<main class="crispy-layout" data-dock="right">
					<section id="graph-area">Graph</section>
					<div id="panel-resize-handle"></div>
					<section id="agent-chat-area" aria-label="Crispy terminal">
						<div id="terminal-shell">
							<div id="terminal"></div>
							<div id="terminal-overlay" role="status" aria-live="polite">
								<p id="terminal-status">기본 shell을 시작하는 중입니다…</p>
								<button id="terminal-restart" type="button" hidden>Restart</button>
							</div>
						</div>
						<button id="chat-drag-handle" type="button" aria-label="Move Agent Chat" title="Move Agent Chat">⠿</button>
					</section>
					<div id="dock-preview" aria-hidden="true" hidden></div>
				</main>
				<script nonce="${nonce}" src="${scriptUri}" data-layout-state="${serializedLayoutState}"></script>
			</body>
			</html>`;
}

function trackTerminalCleanup(cleanup: Promise<boolean>): void {
	let tracked: Promise<boolean>;
	tracked = cleanup.finally(() => pendingTerminalCleanups.delete(tracked));
	pendingTerminalCleanups.add(tracked);
}
