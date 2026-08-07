import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
	CodexConversationController,
	isAllowedExternalUrl,
	isCodexChatWebviewMessage,
} from './Codex';

/** VS Code가 Crispy Chat WebviewPanel을 식별하는 고정 view type이다. */
export const crispyChatViewType = 'crispyChat';

/** 독립된 Editor Group에서 표시되는 Crispy Chat WebviewPanel을 관리한다. */
export class CrispyChatPanel {
	/** 한 번에 하나의 Chat Panel만 유지하기 위한 현재 singleton instance다. */
	private static currentPanel: CrispyChatPanel | undefined;

	/** Panel 생명주기에 묶인 VS Code disposable 목록이다. */
	private readonly disposables: vscode.Disposable[] = [];
	/** 중복 dispose와 재귀 dispose를 방지하는 생명주기 flag다. */
	private disposed = false;

	/**
	 * 생성된 VS Code Panel에 dispose listener와 CSP HTML을 연결한다.
	 *
	 * @param panel 관리할 Chat WebviewPanel.
	 * @param extensionUri 빌드된 Chat asset을 찾는 Extension root URI.
	 * @param controller Chat 명령과 Codex app-server 상태를 연결하는 controller.
	 */
	private constructor(
		private readonly panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		private readonly controller: CodexConversationController,
	) {
		this.panel.onDidDispose(
			() => this.dispose(),
			undefined,
			this.disposables,
		);
		this.panel.webview.onDidReceiveMessage(
			(message: unknown) => {
				if (!isCodexChatWebviewMessage(message)) {
					return;
				}
				if (message.type === 'chat/openExternal') {
					if (isAllowedExternalUrl(message.payload.url)) {
						void vscode.env.openExternal(vscode.Uri.parse(message.payload.url));
					}
					return;
				}
				void this.controller.handleWebviewMessage(message);
			},
			undefined,
			this.disposables,
		);
		const unsubscribe = this.controller.subscribe((message) => {
			void this.panel.webview.postMessage(message);
		});
		this.disposables.push(new vscode.Disposable(unsubscribe));
		this.panel.webview.html = this.getHtml(
			this.panel.webview,
			extensionUri,
		);
	}

	/**
	 * 기존 Chat Panel을 재사용하거나 지정한 Editor Group에 새 Panel을 연다.
	 *
	 * @param extensionUri 빌드된 Chat asset을 찾는 Extension root URI.
	 * @param controller Chat과 app-server의 Extension Host 상태를 소유하는 controller.
	 * @param viewColumn Chat Panel을 표시할 Editor Group. 기본값은 현재 Group 옆이다.
	 */
	public static createOrShow(
		extensionUri: vscode.Uri,
		controller: CodexConversationController,
		viewColumn: vscode.ViewColumn = vscode.ViewColumn.Beside,
	): void {
		if (CrispyChatPanel.currentPanel) {
			CrispyChatPanel.currentPanel.panel.reveal(viewColumn);
			return;
		}

		const resourceRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'chat');
		const panel = vscode.window.createWebviewPanel(
			crispyChatViewType,
			'Crispy Chat',
			viewColumn,
			{
				enableScripts: true,
				localResourceRoots: [resourceRoot],
				retainContextWhenHidden: true,
			},
		);

		CrispyChatPanel.currentPanel = new CrispyChatPanel(
			panel,
			extensionUri,
			controller,
		);
	}

	/** 현재 열려 있는 Chat Panel이 있으면 안전하게 정리한다. */
	public static disposeCurrent(): void {
		CrispyChatPanel.currentPanel?.dispose();
	}

	/** 등록된 VS Code resource와 singleton 참조 및 Panel을 정리한다. */
	public dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		CrispyChatPanel.currentPanel = undefined;
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
		this.panel.dispose();
	}

	/**
	 * 빌드된 Chat CSS·JavaScript만 허용하는 nonce 기반 CSP HTML을 생성한다.
	 *
	 * @param webview VS Code resource URI와 CSP source를 제공하는 Webview.
	 * @param extensionUri `dist/chat` asset을 찾는 Extension root URI.
	 * @returns `#chat-app` mount 지점과 Chat asset을 포함한 완전한 HTML 문서.
	 */
	private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(extensionUri, 'dist', 'chat', 'chat.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(extensionUri, 'dist', 'chat', 'chat.css'),
		);
		const nonce = crypto.randomBytes(18).toString('base64');

		return `<!DOCTYPE html>
			<html lang="ko">
			<head>
				<meta charset="UTF-8">
				<meta
					http-equiv="Content-Security-Policy"
					content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
				>
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleUri}" rel="stylesheet">
				<title>Crispy Chat</title>
			</head>
			<body>
				<div id="chat-app"></div>
				<noscript>Crispy Chat을 표시하려면 JavaScript가 필요합니다.</noscript>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}
