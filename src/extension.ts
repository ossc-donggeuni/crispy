import * as crypto from 'crypto';
import * as vscode from 'vscode';
import {
	isWebviewToExtensionMessage,
	type ExtensionToWebviewMessage,
	type FileAnalysisRequestedMessage,
	type WebviewToExtensionMessage,
} from './model/webviewMessage';
import { analyzeDocumentSymbols } from './workspace/documentSymbolAnalyzer';
import { scanWorkspaceFolder } from './workspace/projectScanner';
import { disposeCodexRuns } from './agent/runCodex';
import {
	CodexAppServerClient,
	createCodexClientInfo,
} from './chat/Codex';
import { CrispyChatPanel } from './chat/chatPanel';

const openGraphCommand = 'crispy.openGraph';
const openChatCommand = 'crispy.openChat';
const openGraphAndChatCommand = 'crispy.openGraphAndChat';

/** Extension 활성화부터 비활성화까지 하나만 유지하는 Codex app-server 연결 소유자다. */
let codexAppServerClient: CodexAppServerClient | undefined;

/** 기존 VS Code Output Channel에서 메시지 기록에 필요한 최소 계약이다. */
type OutputWriter = Pick<vscode.OutputChannel, 'appendLine'>;

/** function handleWebviewMessage( message, outputChannel )
 *
 * - Webview에서 받은 메시지가 유효한지 검사한다.
 * - 선택 변경 메시지라면 Output Channel에 로그를 남긴다.
 * - 유효한 메시지. 또는 유효하지 않을 경우 undefined를 반환한다.
 *
 * @param message 			Webview에서 전달받은 원본 메시지
 * @param outputChannel 	로그를 출력할 채널 (appendLine 기능 한정)
 * @returns 				유효한 메시지. 또는 유효하지 않을 경우 undefined
 */
export function handleWebviewMessage(
	message: unknown,
	outputChannel: OutputWriter,
): WebviewToExtensionMessage | undefined {
	// Webview에서 받은 메시지가 유효한지 검사한다.
	if (!isWebviewToExtensionMessage(message)) {
		return undefined;
	}

	// 선택 변경 메시지라면 Output Channel에 로그를 남긴다.
	if (message.type === 'selectionChanged') {
		const { selectedNodeId } = message.payload;
		outputChannel.appendLine(
			selectedNodeId === undefined
				? '[Crispy] Selection cleared'
				: `[Crispy] Selected node: ${selectedNodeId}`,
		);
	}

	// 유효한 메시지. 또는 유효하지 않을 경우 undefined를 반환한다.
	return message;
}

/** class CrispyGraphPanel
 *
 * - Crispy Webview Panel을 하나만 생성하고 다시 표시한다.
 * - Workspace 구조 스캔과 파일 Symbol 분석 요청을 처리한다.
 * - Extension과 Webview 사이의 메시지 전송 및 리소스 정리를 관리한다.
 */
class CrispyGraphPanel {
	private static currentPanel: CrispyGraphPanel | undefined; // 현재 열려 있는 Crispy 패널 객체

	private readonly panel: vscode.WebviewPanel; // 실제 VS Code에 표시되는 Webview 탭
	private readonly outputChannel: vscode.OutputChannel; // Crispy 로그를 출력하는 VS Code Output Channel
	private readonly disposables: vscode.Disposable[] = []; // 나중에 정리해야 할 이벤트 등록 정보들
	private readonly fileAnalysisRequestIds = new Map<string, string>(); // 파일별 최신 분석 요청 인덱스
	private disposed = false; // 패널이 이미 종료되었는지
	private scanRequestId = 0; // Workspace 구조 분석 요청의 순번 인덱스

	/** constructor ( panel, extensionUri, outputChannel )
	 *
	 * - Webview 패널과 Output Channel을 저장한다.
	 * - 패널 종료 및 Webview 메시지 이벤트를 등록한다.
	 * - Webview에 표시할 HTML을 생성해 적용한다.
	 *
	 * @param panel 		생성된 VS Code Webview 패널
	 * @param extensionUri 	Extension 리소스의 기준 경로
	 * @param outputChannel Crispy 로그를 출력할 채널
	 */
	private constructor(
		panel: vscode.WebviewPanel,
		extensionUri: vscode.Uri,
		outputChannel: vscode.OutputChannel,
	) {
		this.panel = panel;
		this.outputChannel = outputChannel;

		// onDidDispose : Webview 패널이 닫히면 이 함수를 실행한다.
		// 패널이 닫힐 때 실행할 함수는 this.dispose(), 이벤트 등록 정보를 disposables 배열에 저장한다.
		this.panel.onDidDispose(
			() => this.dispose(),
			undefined,
			this.disposables,
		);

		// onDidReceiveMessage : Webview에서 Extension으로 메시지가 올 때 실행한다.
		// 유효한 메시지일 때 handleIncomingMessage 실행. 이벤트 등록 정보를 disposables 배열에 저장한다.
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

		// getHtml() : Webview에서 사용할 HTML 문자열을 만든다.
		this.panel.webview.html = this.getHtml(this.panel.webview, extensionUri);
	}

	/** function createOrShow( extensionUri, outputChannel )
	 *
	 * - 기존 Crispy 패널이 있으면 현재 Editor 열에서 다시 표시한다.
	 * - 패널이 없으면 Webview 리소스 범위와 실행 옵션을 지정해 생성한다.
	 * - 생성한 패널을 Singleton 인스턴스로 저장한다.
	 *
	 * @param extensionUri 	Extension 리소스의 기준 경로
	 * @param outputChannel Crispy 로그를 출력할 채널
	 * @returns 			반환값 없음
	 */
	public static createOrShow(
		extensionUri: vscode.Uri,
		outputChannel: vscode.OutputChannel,
		viewColumn?: vscode.ViewColumn,
	): void {
		// 활성 Editor 열이 없으면 첫 번째 열에 Crispy 패널을 표시한다.
		const column = viewColumn
			?? vscode.window.activeTextEditor?.viewColumn
			?? vscode.ViewColumn.One;

		// 이미 열린 패널이 있으면 새로 만들지 않고 앞으로 가져온다.
		if (CrispyGraphPanel.currentPanel) {
			CrispyGraphPanel.currentPanel.panel.reveal(column);
			return;
		}

		// Webview가 빌드된 리소스만 읽을 수 있도록 로컬 리소스 범위를 제한한다.
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

	/** function disposeCurrent()
	 *
	 * - 현재 열려 있는 Crispy 패널이 있으면 종료한다.
	 *
	 * @returns 반환값 없음
	 */
	public static disposeCurrent(): void {
		CrispyGraphPanel.currentPanel?.dispose();
	}

	/** function dispose()
	 *
	 * - 중복 종료 요청을 무시한다.
	 * - 진행 중인 Workspace 및 파일 분석 요청을 무효화한다.
	 * - 등록한 이벤트와 Webview 패널 리소스를 정리한다.
	 *
	 * @returns 반환값 없음
	 */
	public dispose(): void {
		if (this.disposed) {
			return;
		}

		// 비동기 작업이 완료되어도 닫힌 패널에 결과를 보내지 않도록 요청 상태를 초기화한다.
		this.disposed = true;
		this.scanRequestId += 1;
		this.fileAnalysisRequestIds.clear();
		CrispyGraphPanel.currentPanel = undefined;

		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}

		this.panel.dispose();
	}

	/** function handleIncomingMessage( message )
	 *
	 * - Webview 메시지 종류에 따라 Workspace 로드와 폴더 열기를 실행한다.
	 *
	 * @param message 	Webview 런타임 검증을 통과한 메시지
	 * @returns 		메시지 처리가 완료되면 끝나는 Promise
	 */
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
			case 'fileAnalysisRequested':
				await this.analyzeFile(message);
				break;
		}
	}

	/** function loadWorkspace()
	 *
	 * - 현재 Workspace Folder 개수에 맞는 Webview 상태를 전송한다.
	 * - 단일 Workspace를 스캔해 ProjectNode 목록을 전달한다.
	 * - 이전 요청이나 닫힌 패널의 결과를 무시하고 오류를 Output Channel에 기록한다.
	 *
	 * @returns Workspace 상태 전송이 완료되면 끝나는 Promise
	 */
	private async loadWorkspace(): Promise<void> {
		const requestId = ++this.scanRequestId;
		this.fileAnalysisRequestIds.clear();
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

		// Workspace가 없으면 폴더 열기 버튼이 있는 빈 상태를 표시한다.
		if (workspaceFolders.length === 0) {
			await this.postMessage({
				type: 'workspaceEmpty',
			});
			return;
		}

		// 다중 Root Workspace는 임의로 병합하지 않고 지원되지 않는 상태로 알린다.
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
			// Extension Host에서 실제 Workspace 구조를 스캔한다.
			const result = await scanWorkspaceFolder(workspaceFolders[0]);
			if (this.disposed || requestId !== this.scanRequestId) {
				return;
			}

			// 최신 스캔 결과만 로그와 Webview에 전달한다.
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
			// 무효화된 요청에서 발생한 오류는 사용자에게 노출하지 않는다.
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

	/** function analyzeFile( message )
	 *
	 * - 파일별 최신 requestId를 기록하고 Document Symbol 분석을 실행한다.
	 * - 단일 Workspace가 아니거나 분석에 실패한 경우 실패 결과를 만든다.
	 * - 최신 요청의 결과만 Webview에 전송하고 완료된 요청 인덱스를 제거한다.
	 *
	 * @param message 	검증을 통과한 파일 분석 요청 메시지
	 * @returns 		분석 결과 전송이 완료되면 끝나는 Promise
	 */
	private async analyzeFile(
		message: FileAnalysisRequestedMessage,
	): Promise<void> {
		const {
			requestId,
			fileNodeId,
			relativePath,
		} = message.payload;
		this.fileAnalysisRequestIds.set(fileNodeId, requestId);

		// 파일 분석은 정확히 하나의 Workspace Folder가 있을 때만 실행한다.
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		const result = workspaceFolders.length === 1
			? await analyzeDocumentSymbols(
				workspaceFolders[0],
				fileNodeId,
				relativePath,
			)
			: {
				status: 'failed' as const,
				symbolNodes: [],
				symbolMetadata: [],
				errorMessage: 'File analysis requires a single-folder Workspace.',
			};

		if (
			this.disposed
			|| this.fileAnalysisRequestIds.get(fileNodeId) !== requestId
		) {
			return;
		}

		// 실패 시 로그
		if (result.status === 'failed') {
			this.outputChannel.appendLine(
				`[Crispy] File analysis failed: ${relativePath}`,
			);
		}

		await this.postMessage({
			type: 'fileAnalysisResult',
			payload: {
				requestId,
				fileNodeId,
				status: result.status,
				symbolNodes: result.symbolNodes,
				symbolMetadata: result.symbolMetadata,
				...(result.errorMessage
					? { errorMessage: result.errorMessage }
					: {}),
			},
		});

		// 전송 도중 새 요청이 등록되지 않은 경우에만 완료된 인덱스를 정리한다.
		if (this.fileAnalysisRequestIds.get(fileNodeId) === requestId) {
			this.fileAnalysisRequestIds.delete(fileNodeId);
		}
	}

	/** function openWorkspaceFolder()
	 *
	 * - 사용자가 하나의 폴더를 선택할 수 있는 VS Code 대화상자를 연다.
	 * - 선택한 폴더를 현재 창의 Workspace로 연다.
	 * - 취소와 패널 종료는 조용히 무시하고 실제 오류만 Webview에 전달한다.
	 *
	 * @returns 폴더 열기 요청이 완료되면 끝나는 Promise
	 */
	private async openWorkspaceFolder(): Promise<void> {
		try {
			const selectedUris = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: 'Open Workspace',
			});
			const selectedUri = selectedUris?.[0];
			// 사용자가 선택을 취소했거나 패널이 닫혔다면 창을 변경하지 않는다.
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

	/** function postMessage( message )
	 *
	 * - 열린 Webview에 Extension 메시지를 안전하게 전송한다.
	 * - 패널이 닫혔거나 전송 중 오류가 발생하면 false를 반환한다.
	 *
	 * @param message 	Webview로 전달할 타입 검증된 메시지
	 * @returns 		메시지 전달 성공 여부
	 */
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

	/** function getHtml( webview, extensionUri )
	 *
	 * - 빌드된 Webview JavaScript와 CSS의 안전한 URI를 생성한다.
	 * - nonce 기반 Content Security Policy를 적용한다.
	 * - Crispy Webview의 루트 HTML 문자열을 반환한다.
	 *
	 * @param webview 		리소스 URI와 CSP 정보를 제공하는 Webview
	 * @param extensionUri Extension 리소스의 기준 경로
	 * @returns 			Webview에 삽입할 HTML 문자열
	 */
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

/** function activate( context )
 *
 * - 설치된 Extension manifest로 Codex client metadata를 만들고 app-server 연결을 시작한다.
 * - Graph와 Chat을 각각 독립 WebviewPanel로 여는 명령을 등록한다.
 * - Extension 종료 시 함께 정리되도록 구독 목록에 추가한다.
 *
 * @param context VS Code Extension 실행 컨텍스트
 * @returns 	  반환값 없음
 */
export function activate(context: vscode.ExtensionContext): void {
	const outputChannel = vscode.window.createOutputChannel('Crispy');
	codexAppServerClient = new CodexAppServerClient({
		clientInfo: createCodexClientInfo(
			context.extension.id,
			context.extension.packageJSON as unknown,
		),
		outputWriter: outputChannel,
	});
	void codexAppServerClient.start().catch(() => {
		// 연결 실패 원인은 client가 구조화된 Output Channel 로그와 상태에 기록한다.
	});
	const openGraph = vscode.commands.registerCommand(openGraphCommand, () => {
		CrispyGraphPanel.createOrShow(context.extensionUri, outputChannel);
	});
	const openChat = vscode.commands.registerCommand(openChatCommand, () => {
		CrispyChatPanel.createOrShow(context.extensionUri);
	});
	const openGraphAndChat = vscode.commands.registerCommand(
		openGraphAndChatCommand,
		() => {
			const graphColumn = vscode.window.activeTextEditor?.viewColumn
				?? vscode.ViewColumn.One;
			CrispyGraphPanel.createOrShow(
				context.extensionUri,
				outputChannel,
				graphColumn,
			);
			CrispyChatPanel.createOrShow(
				context.extensionUri,
				vscode.ViewColumn.Beside,
			);
		},
	);

	context.subscriptions.push(
		outputChannel,
		openGraph,
		openChat,
		openGraphAndChat,
	);
}

/** function deactivate()
 * - Extension Host가 종료될 때 Codex가 별도 process로 남지 않도록 app-server process tree를 정리한다.
 * - process만 종료하며 Codex가 디스크에 저장한 Thread 세션은 삭제하지 않는다.
 * - 기존 ChangePlan Codex 실행도 완료 또는 중단될 때까지 함께 기다린다.
 * - Extension 비활성화 시 현재 Crispy 패널을 정리한다.
 *
 * @returns 반환값 없음
 */
export async function deactivate(): Promise<void> {
	CrispyGraphPanel.disposeCurrent();
	CrispyChatPanel.disposeCurrent();
	const appServerClient = codexAppServerClient;
	codexAppServerClient = undefined;
	await Promise.all([
		disposeCodexRuns(),
		appServerClient?.stop(),
	]);
}

/** function getErrorMessage( error )
 *
 * - 알 수 없는 오류 값을 사용자에게 표시할 문자열로 변환한다.
 *
 * @param error 변환할 오류 값
 * @returns 	오류 메시지 문자열
 */
function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
