import * as vscode from 'vscode';
import {
	parseWebviewToHostMessage,
	type WebviewToHostMessage,
} from './agent/protocol';
import { nodePtyAdapter } from './agent/host/terminal/nodePtyAdapter';
import { TerminalHost } from './agent/host/terminal/terminalHost';
import type { ExtensionToWebviewMessage } from './messages';
import {
	getPanelLayoutStateFromMessage,
	serializePanelLayoutState,
	type PanelLayoutState,
} from './webview/panel/panelState';

let currentPanel: vscode.WebviewPanel | undefined;
let lastLayoutState: PanelLayoutState | undefined;

/** 검증된 terminal 메시지를 실제 TerminalHost 경계로 전달하는 최소 계약이다. */
export interface TerminalMessageHost {
	startSession(tabId: string, cols: number, rows: number): Promise<unknown>;
	restartSession(tabId: string, sessionId: string): Promise<unknown>;
	routeInput(
		message: Extract<WebviewToHostMessage, { type: 'terminal.input' }>,
	): void;
	routeResize(
		message: Extract<WebviewToHostMessage, { type: 'terminal.resize' }>,
	): void;
}

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
		const terminalHost = new TerminalHost({
			ptyAdapter: nodePtyAdapter,
			emitMessage: (message) => {
				void Promise.resolve(panel.webview.postMessage(message)).catch(
					() => undefined,
				);
			},
		});

		const stylesUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(webviewRoot, 'webview.css'),
		);
		const scriptUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(webviewRoot, 'webview.js'),
		);

		/**
		 * Webview 메시지 중 레이아웃 상태를 기존 경계에서 먼저 처리하고,
		 * 나머지 메시지만 Host protocol 수신 경계로 전달한다.
		 */
		panel.webview.onDidReceiveMessage((message: unknown) => {
			const layoutState = getPanelLayoutStateFromMessage(message);
			if (layoutState) {
				lastLayoutState = layoutState;
				return;
			}

			handleWebviewMessage(panel.webview, message, terminalHost);
		});

		panel.webview.html = getWebviewHtml(
			panel.webview,
			stylesUri,
			scriptUri,
			lastLayoutState,
		);

		panel.onDidDispose(() => {
			terminalHost.stopMessageDelivery();
			currentPanel = undefined;
		});

		return panel;
	};

	const disposable = vscode.commands.registerCommand('crispy.openCanvas', openCanvas);

	context.subscriptions.push(disposable);
}

/**
 * Webview가 전송한 unknown 메시지를 구조적으로 검증한 뒤 처리한다.
 * 검증 실패 시 원본 payload를 기록하거나 Webview로 반사하지 않으며,
 * 검증된 terminal 메시지만 별도의 실행 전 dispatch 경계로 전달한다.
 *
 * @param webview 응답 메시지를 전송할 Webview
 * @param message Webview에서 수신한 메시지
 * @returns 메시지를 Webview에 전달한 결과 또는 처리 대상이 아닐 때 `undefined`
 */
export function handleWebviewMessage(
	webview: Pick<vscode.Webview, 'postMessage'>,
	message: unknown,
	terminalHost?: TerminalMessageHost,
): Thenable<boolean> | undefined {
	const parseResult = parseWebviewToHostMessage(message);
	if (!parseResult.ok) {
		return undefined;
	}

	switch (parseResult.value.type) {
		case 'webview.ready':
			console.log('[Crispy] Webview ready');

			return webview.postMessage({
				type: 'extension.ready',
			} satisfies ExtensionToWebviewMessage);
		default:
			return handleTerminalMessage(parseResult.value, terminalHost);
	}
}

/**
 * 구조 검증을 통과한 terminal 메시지를 현재 구현된 Host 경계로 전달한다.
 * ready는 세션 시작으로, restart는 새 세션 재시작으로, input과 resize는 실행 중
 * PTY routing으로 연결하며 아직 구현하지 않은 lifecycle 메시지는 실행하지 않는다.
 *
 * @param message 허용된 type과 필드만 포함하는 terminal protocol 메시지
 * @param terminalHost 검증된 ready/restart/input/resize를 처리할 Host 경계
 * @returns 메시지 전송은 TerminalHost emitter가 담당하므로 직접 응답하지 않음
 */
function handleTerminalMessage(
	message: WebviewToHostMessage,
	terminalHost: TerminalMessageHost | undefined,
): undefined {
	if (terminalHost === undefined) {
		return undefined;
	}

	switch (message.type) {
		case 'terminal.ready':
			void terminalHost.startSession(
				message.tabId,
				message.cols,
				message.rows,
			).catch(() => undefined);
			break;
		case 'terminal.restart':
			void terminalHost.restartSession(
				message.tabId,
				message.sessionId,
			).catch(() => undefined);
			break;
		case 'terminal.input':
			terminalHost.routeInput(message);
			break;
		case 'terminal.resize':
			terminalHost.routeResize(message);
			break;
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

	// xterm DOM renderer가 ANSI 팔레트용 <style>을 생성하므로 element만 inline을 허용한다.
	// script-src와 style attribute fallback은 Webview source로 계속 제한한다.
	return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; style-src-elem ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource};">
				<link rel="stylesheet" href="${stylesUri}">
				<title>Crispy</title>
			</head>
			<body>
				<main class="crispy-layout" data-dock="right">
					<section id="graph-area"></section>
					<div id="panel-resize-handle"></div>
					<section id="agent-chat-area">
						<button id="chat-drag-handle" type="button" aria-label="Move Agent Chat" title="Move Agent Chat">⠿</button>
						<div id="terminal-surface" data-state="ready">
							<div id="terminal-mount"></div>
							<div id="terminal-overlay" aria-live="polite" hidden></div>
						</div>
					</section>
					<div id="dock-preview" aria-hidden="true" hidden></div>
				</main>
				<script src="${scriptUri}" data-layout-state="${serializedLayoutState}"></script>
			</body>
			</html>`;
}
