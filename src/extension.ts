import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { isSelectionChangedMessage } from './model/webviewMessage';

const openGraphCommand = 'crispy.openGraph';

type OutputWriter = Pick<vscode.OutputChannel, 'appendLine'>;

export function handleWebviewMessage(
	message: unknown,
	outputChannel: OutputWriter,
): void {
	if (!isSelectionChangedMessage(message)) {
		return;
	}

	const { selectedNodeId } = message.payload;
	outputChannel.appendLine(
		selectedNodeId === undefined
			? '[Crispy] Selection cleared'
			: `[Crispy] Selected node: ${selectedNodeId}`,
	);
}

class CrispyGraphPanel {
	private static currentPanel: CrispyGraphPanel | undefined;

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private disposed = false;

	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		outputChannel: vscode.OutputChannel,
	) {
		this.panel = panel;
		this.panel.webview.html = this.getHtml(this.panel.webview, extensionUri);

		this.panel.onDidDispose(
			() => this.dispose(),
			undefined,
			this.disposables,
		);

		this.panel.webview.onDidReceiveMessage(
			(message: unknown) => handleWebviewMessage(message, outputChannel),
			undefined,
			this.disposables,
		);
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
		CrispyGraphPanel.currentPanel = undefined;

		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}

		this.panel.dispose();
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
