import type * as vscode from 'vscode';

export function getWebviewHtml(webview: vscode.Webview, stylesUri: vscode.Uri): string {
	return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource};">
				<link rel="stylesheet" href="${stylesUri}">
				<title>Crispy</title>
			</head>
			<body>
				<main class="crispy-layout">
					<section id="graph-area">
						Graph
					</section>

					<section id="agent-chat-area">
						Agent Chat
					</section>
				</main>
			</body>
			</html>`;
}
