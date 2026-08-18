import * as vscode from 'vscode';
import {
	parseWebviewToHostMessage,
	type ProviderId,
	type WebviewToHostMessage,
} from './agent/protocol';
import { nodePtyAdapter } from './agent/host/terminal/nodePtyAdapter';
import { TerminalHost } from './agent/host/terminal/terminalHost';
import { createAgentAutoRunInputResolver } from './agent/host/agent/agentProviderLaunch';
import {
	createTerminalRuntimeCleanup,
	runCleanupWithTimeout,
} from './agent/host/terminal/terminalRuntimeCleanup';
import type { ExtensionToWebviewMessage } from './messages';
import {
	getPanelLayoutStateFromMessage,
	serializePanelLayoutState,
	type PanelLayoutState,
} from './webview/panel/panelState';

/**
 * Panel 하나가 소유하는 Terminal runtime과 Webview 구독의 정리 경계다.
 * Panel dispose와 Extension deactivate가 같은 경계를 공유한다.
 */
interface CanvasRuntime {
	/** 정리 대상 Panel이며 deactivate에서 직접 dispose한다. */
	readonly panel: vscode.WebviewPanel;

	/** Routing과 Webview 구독을 native 종료 없이 즉시 분리한다. */
	detach(): void;

	/** 분리 시 캡처한 session을 비동기 OS adapter로 한 번만 종료한다. */
	terminate(): Promise<void>;
}

let currentRuntime: CanvasRuntime | undefined;
let lastLayoutState: PanelLayoutState | undefined;

/** 검증된 terminal 메시지를 실제 TerminalHost 경계로 전달하는 최소 계약이다. */
export interface TerminalMessageHost {
	handleTerminalReady(
		tabId: string,
		cols: number,
		rows: number,
	): Promise<unknown>;
	restartSession(tabId: string, sessionId: string): Promise<unknown>;
	createTab(tabId: string): void;
	switchTab(tabId: string): void;
	closeTab(tabId: string): void;
	switchAgent(tabId: string, providerId: ProviderId): Promise<unknown>;
	routeInput(
		message: Extract<WebviewToHostMessage, { type: 'terminal.input' }>,
	): void;
	routeResize(
		message: Extract<WebviewToHostMessage, { type: 'terminal.resize' }>,
	): void;
}

/** VS Code가 실제 활성화한 extension module instance에서 제공하는 공개 API다. */
export interface CrispyExtensionApi {
	deactivate(): Promise<void>;
	handleWebviewMessage(
		webview: Pick<vscode.Webview, 'postMessage'>,
		message: unknown,
		terminalHost?: TerminalMessageHost,
	): Thenable<boolean> | undefined;
}

/**
 * Crispy 확장을 활성화하고 Canvas Webview를 여는 명령을 등록한다.
 *
 * @param context 확장의 구독 항목과 설치 경로를 제공하는 VS Code 확장 컨텍스트
 */
export function activate(context: vscode.ExtensionContext): CrispyExtensionApi {
	/**
	 * 기존 WebviewPanel을 표시하거나 새 Panel에 Dock 및 Resize UI를 설정한다.
	 */
	const openCanvas = (): vscode.WebviewPanel => {
		if (currentRuntime) {
			/** 기존 Panel을 다시 표시하는 것은 dispose가 아니므로 세션을 그대로 유지한다. */
			currentRuntime.panel.reveal();
			return currentRuntime.panel;
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
		const terminalHost = new TerminalHost({
			ptyAdapter: nodePtyAdapter,
			resolveAgentAutoRunInput: createAgentAutoRunInputResolver({
				getCliPath: (providerId) => vscode.workspace
					.getConfiguration('crispy')
					.get<string>(`${providerId}CliPath`),
			}),
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
		const messageSubscription = panel.webview.onDidReceiveMessage(
			(message: unknown) => {
				const layoutState = getPanelLayoutStateFromMessage(message);
				if (layoutState) {
					lastLayoutState = layoutState;
					return;
				}

				handleWebviewMessage(panel.webview, message, terminalHost);
			},
		);

		panel.webview.html = getWebviewHtml(
			panel.webview,
			stylesUri,
			scriptUri,
			lastLayoutState,
		);

		const runtime = createCanvasRuntime(panel, terminalHost, [
			messageSubscription,
		]);
		currentRuntime = runtime;

		panel.onDidDispose(() => {
			releaseCanvasRuntime(runtime);
			runtime.detach();
			void runtime.terminate().catch(() => undefined);
		});

		return panel;
	};

	const disposable = vscode.commands.registerCommand('crispy.openCanvas', openCanvas);

	context.subscriptions.push(disposable);

	return Object.freeze({
		deactivate,
		handleWebviewMessage,
	});
}

/**
 * Panel이 소유한 TerminalHost와 Webview 구독을 하나의 정리 경계로 묶는다.
 * 실제 정리 순서와 오류 격리는 Host 공용 cleanup 함수가 담당하며,
 * 반복 호출 시 첫 정리 Promise를 그대로 반환해 중복 정리를 하지 않는다.
 *
 * @param panel 정리 대상 Terminal을 표시하던 Webview Panel
 * @param terminalHost Panel이 소유한 Terminal session 및 PTY 정리 경계
 * @param subscriptions Host 정리 뒤 해제할 Webview message listener 구독 목록
 * @returns Panel dispose와 deactivate가 공유하는 멱등한 정리 경계
 */
function createCanvasRuntime(
	panel: vscode.WebviewPanel,
	terminalHost: TerminalHost,
	subscriptions: readonly vscode.Disposable[],
): CanvasRuntime {
	const cleanup = createTerminalRuntimeCleanup(terminalHost, subscriptions);

	return {
		panel,
		detach: cleanup.detach,
		terminate: cleanup.terminate,
	};
}

/**
 * 이미 정리되었거나 정리 중인 runtime을 현재 Panel 참조에서 분리한다.
 * 새 Panel이 등록된 뒤 이전 Panel의 dispose가 도착해도 참조를 지우지 않는다.
 *
 * @param runtime 현재 참조에서 분리할 Canvas runtime
 */
function releaseCanvasRuntime(runtime: CanvasRuntime): void {
	if (currentRuntime === runtime) {
		currentRuntime = undefined;
	}
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
 * 구조 검증을 통과한 terminal 및 tab 메시지를 현재 구현된 Host 경계로 전달한다.
 * ready는 탭 표면 준비로, `agent.switch`는 provider 지정 시작·재시작으로,
 * restart는 같은 provider 재시작으로, input과 resize는 실행 중 PTY routing으로
 * 연결하며 아직 구현하지 않은 lifecycle 메시지는 실행하지 않는다.
 *
 * @param message 허용된 type과 필드만 포함하는 terminal protocol 메시지
 * @param terminalHost 검증된 tab/agent/terminal 메시지를 처리할 Host 경계
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
		case 'tab.create':
			terminalHost.createTab(message.tabId);
			break;
		case 'tab.switch':
			terminalHost.switchTab(message.tabId);
			break;
		case 'tab.close':
			terminalHost.closeTab(message.tabId);
			break;
		case 'agent.switch':
			void terminalHost.switchAgent(
				message.tabId,
				message.providerId,
			).catch(() => undefined);
			break;
		case 'terminal.ready':
			void terminalHost.handleTerminalReady(
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
 * 확장이 비활성화될 때 열린 Terminal runtime과 WebviewPanel 참조를 정리한다.
 * Terminal session, PTY, PTY listener와 Webview message listener만 정리 대상이며
 * PTY 종료가 지연되어도 VS Code 종료를 막지 않도록 상한 시간을 적용한 뒤
 * 남은 정리는 best-effort로 진행한다.
 *
 * @returns Terminal runtime 정리가 끝나거나 상한 시간에 도달하면 이행되는 Promise
 */
export async function deactivate(): Promise<void> {
	const runtime = currentRuntime;
	currentRuntime = undefined;
	if (runtime === undefined) {
		return;
	}

	runtime.detach();

	try {
		runtime.panel.dispose();
	} catch {
		/** Panel 정리 실패가 확장 비활성화를 막지 않게 한다. */
	}

	await runCleanupWithTimeout(() => runtime.terminate());
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

	/** xterm DOM renderer가 ANSI 팔레트용 <style>을 생성하므로 element만 inline을 허용한다. */
	/** script-src와 style attribute fallback은 Webview source로 계속 제한한다. */
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
						<div id="agent-panel-header">
							<div id="agent-tab-strip"></div>
							<div id="agent-top-bar"></div>
							<button id="chat-drag-handle" type="button" aria-label="Move Agent Chat" title="Move Agent Chat">⠿</button>
						</div>
						<div id="agent-terminal-area"></div>
						<div id="agent-provider-bar"></div>
						<div id="agent-dialog-host" hidden></div>
					</section>
					<div id="dock-preview" aria-hidden="true" hidden></div>
				</main>
				<script src="${scriptUri}" data-layout-state="${serializedLayoutState}"></script>
			</body>
			</html>`;
}
