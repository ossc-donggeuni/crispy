import * as vscode from 'vscode';
import { getWebviewHtml } from './webview/webview';

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('crispy.openCanvas', () => {
		const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
		const panel = vscode.window.createWebviewPanel(
			'crispy.webview',
			'Crispy',
			vscode.ViewColumn.One,
			{
				localResourceRoots: [webviewRoot],
			},
		);

		const stylesUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(webviewRoot, 'webview.css'),
		);

		panel.webview.html = getWebviewHtml(panel.webview, stylesUri);
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
