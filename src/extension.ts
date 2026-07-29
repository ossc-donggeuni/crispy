import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
	isWebviewToExtensionMessage,
	type ExtensionToWebviewMessage,
	type WebviewToExtensionMessage,
} from './model/webviewMessage';
import { scanWorkspaceFolder } from './workspace/projectScanner';

const openGraphCommand = 'crispy.openGraph';

type OutputWriter = Pick<vscode.OutputChannel, 'appendLine'>;

export function handleWebviewMessage(
	message: unknown,
	outputChannel: OutputWriter,
): WebviewToExtensionMessage | undefined {
	if (!isWebviewToExtensionMessage(message)) {
		return undefined;
	}

	if (message.type === 'selectionChanged') {
		const { selectedNodeId } = message.payload;
		outputChannel.appendLine(
			selectedNodeId === undefined
				? '[Crispy] Selection cleared'
				: `[Crispy] Selected node: ${selectedNodeId}`,
		);
	}

	return message;
}

class CrispyGraphPanel {
	private static currentPanel: CrispyGraphPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly outputChannel: vscode.OutputChannel;
	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;
	private scanRequestId = 0;

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		outputChannel: vscode.OutputChannel,
	) {
		this.panel = panel;
		this.outputChannel = outputChannel;

		this.panel.onDidDispose(
			() => this.dispose(),
			undefined,
			this.disposables,
		);

		this.panel.webview.onDidReceiveMessage(
			(message: unknown) => {
				const validMessage = handleWebviewMessage(message, outputChannel);
				if (validMessage) {
					void this.handleIncomingMessage(validMessage);
				}
			},
			undefined,
			this.disposables,
		);

		this.panel.webview.html = this.getHtml(this.panel.webview, extensionUri);
	}

	public static createOrShow(
		extensionUri: vscode.Uri,
		outputChannel: vscode.OutputChannel,
	): void {
		const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

		if (CrispyGraphPanel.currentPanel) {
			CrispyGraphPanel.currentPanel.panel.reveal(column);
			return;
		}

		const resourceRoot = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
		const panel = vscode.window.createWebviewPanel(
			'crispyGraph',
			'Crispy',
			column,
			{
				enableScripts: true,
				localResourceRoots: [resourceRoot],
				retainContextWhenHidden: true,
			},
		);

		CrispyGraphPanel.currentPanel = new CrispyGraphPanel(
			panel,
			extensionUri,
			outputChannel,
		);
	}

	public static disposeCurrent(): void {
		CrispyGraphPanel.currentPanel?.dispose();
	}

	public dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.scanRequestId += 1;
		CrispyGraphPanel.currentPanel = undefined;

		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}

		this.panel.dispose();
	}

	private async handleIncomingMessage(
		message: WebviewToExtensionMessage,
	): Promise<void> {
		switch (message.type) {
			case 'webviewReady':
				await this.loadWorkspace();
				break;
			case 'openWorkspaceFolder':
				await this.openWorkspaceFolder();
				break;
			case 'selectionChanged':
				break;
		}
	}

	private async loadWorkspace(): Promise<void> {
		const requestId = ++this.scanRequestId;
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

		if (workspaceFolders.length === 0) {
			await this.postMessage({
				type: 'workspaceEmpty',
			});
			return;
		}

		if (workspaceFolders.length > 1) {
			await this.postMessage({
				type: 'workspaceUnsupported',
				payload: {
					message: 'Multi-root workspaces are not supported yet.',
				},
			});
			return;
		}

		await this.postMessage({
			type: 'workspaceLoading',
		});

		try {
			const result = await scanWorkspaceFolder(workspaceFolders[0]);
			if (this.disposed || requestId !== this.scanRequestId) {
				return;
			}

			this.outputChannel.appendLine(
				`[Crispy] Loaded workspace: ${result.workspaceName} `
				+ `(${result.nodes.length} nodes, ${result.skippedEntries} skipped)`,
			);
			await this.postMessage({
				type: 'workspaceLoaded',
				payload: {
					workspaceName: result.workspaceName,
					nodes: result.nodes,
				},
			});
		} catch (error) {
			if (this.disposed || requestId !== this.scanRequestId) {
				return;
			}

			const message = getErrorMessage(error);
			this.outputChannel.appendLine(
				`[Crispy] Workspace scan failed: ${message}`,
			);
			await this.postMessage({
				type: 'workspaceError',
				payload: {
					message,
				},
			});
		}
	}

	private async openWorkspaceFolder(): Promise<void> {
		try {
			const selectedUris = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Open Workspace',
			});
			const selectedUri = selectedUris?.[0];
			if (!selectedUri || this.disposed) {
				return;
			}

			await vscode.commands.executeCommand(
				'vscode.openFolder',
				selectedUri,
				false,
			);
		} catch (error) {
			if (this.disposed) {
				return;
			}

			const message = getErrorMessage(error);
			this.outputChannel.appendLine(
				`[Crispy] Unable to open workspace: ${message}`,
			);
			await this.postMessage({
				type: 'workspaceError',
				payload: {
					message,
				},
			});
		}
	}

	private async postMessage(
		message: ExtensionToWebviewMessage,
	): Promise<boolean> {
		if (this.disposed) {
			return false;
		}

		try {
			return await this.panel.webview.postMessage(message);
		} catch (error) {
			if (!this.disposed) {
				this.outputChannel.appendLine(
					`[Crispy] Unable to update Webview: ${getErrorMessage(error)}`,
				);
			}
			return false;
		}
	}

	private getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'main.css'),
		);
		const nonce = crypto.randomBytes(18).toString('base64');

		return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta
					http-equiv="Content-Security-Policy"
					content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
				>
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleUri}" rel="stylesheet">
				<title>Crispy</title>
			</head>
			<body>
				<div id="app"></div>
				<noscript>Crispy requires JavaScript to render the graph view.</noscript>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel('Crispy');
	const openGraph = vscode.commands.registerCommand(openGraphCommand, () => {
		CrispyGraphPanel.createOrShow(context.extensionUri, outputChannel);
	});

	context.subscriptions.push(outputChannel, openGraph);
}

export function deactivate(): void {
	CrispyGraphPanel.disposeCurrent();
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
