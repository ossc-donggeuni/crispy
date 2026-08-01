import {
	createSelectionChangedMessage,
	isExtensionToWebviewMessage,
	type FileAnalysisRequestedMessage,
	type OpenWorkspaceFolderMessage,
	type WebviewReadyMessage,
	type WebviewToExtensionMessage,
} from '../model/webviewMessage';
import { GraphView } from './GraphView';
import './styles.css';

/** type VsCodeApi
 *
 * - Webview가 Extension Host에 타입 검증된 메시지를 전송할 최소 API를 정의한다.
 */
type VsCodeApi = {
	postMessage: (message: WebviewToExtensionMessage) => void;
};

declare function acquireVsCodeApi(): VsCodeApi;

const rootElement = document.getElementById('app');

if (!rootElement) {
	throw new Error('Crispy could not find its Webview root element.');
}

const root: HTMLElement = rootElement;
let graphView: GraphView | undefined;

try {
	const vscode = acquireVsCodeApi();

	/** function handleExtensionMessage( event )
	 *
	 * - Extension에서 받은 메시지를 런타임 검증한다.
	 * - Workspace 상태에 따라 GraphView 또는 안내 화면을 렌더링한다.
	 * - 파일 분석 결과는 현재 GraphView 인스턴스에 부분 반영한다.
	 *
	 * @param event Extension 메시지를 포함한 Window MessageEvent
	 * @returns 	반환값 없음
	 */
	const handleExtensionMessage = (event: MessageEvent<unknown>): void => {
		if (!isExtensionToWebviewMessage(event.data)) {
			return;
		}

		try {
			switch (event.data.type) {
				case 'workspaceLoading':
					// 새 Workspace 데이터를 기다리는 동안 기존 그래프를 정리한다.
					disposeGraphView();
					renderWorkspaceState('Loading workspace structure...');
					break;
				case 'workspaceEmpty':
					disposeGraphView();
					renderWorkspaceState(
						'No workspace opened.',
						undefined,
						{
							label: 'Open Folder',
							onClick: () => {
								vscode.postMessage({
									type: 'openWorkspaceFolder',
								} satisfies OpenWorkspaceFolderMessage);
							},
						},
					);
					break;
				case 'workspaceUnsupported':
					disposeGraphView();
					renderWorkspaceState(event.data.payload.message);
					break;
				case 'workspaceError':
					disposeGraphView();
					renderWorkspaceState(
						'Unable to load workspace structure.',
						event.data.payload.message,
						undefined,
						true,
					);
					break;
				case 'workspaceLoaded':
					// 실제 Workspace 노드를 입력 경계로 주입해 새 GraphView를 생성한다.
					disposeGraphView();
					graphView = new GraphView(root, {
						nodes: event.data.payload.nodes,
						planInfo: [],
						onSelectionChange: (selection) => {
							// 선택 상태는 메시지 생성 함수로 계약을 통일해 Extension에 전달한다.
							vscode.postMessage(createSelectionChangedMessage(selection));
						},
						onFileAnalysisRequest: (fileNode, requestId) => {
							if (!fileNode.relativePath) {
								return;
							}

							vscode.postMessage({
								type: 'fileAnalysisRequested',
								payload: {
									requestId,
									fileNodeId: fileNode.id,
									relativePath: fileNode.relativePath,
								},
							} satisfies FileAnalysisRequestedMessage);
						},
					});
					break;
				case 'fileAnalysisResult':
					// 전체 GraphView를 재생성하지 않고 최신 파일 분석 결과만 갱신한다.
					graphView?.setFileAnalysisResult(event.data.payload);
					break;
			}
		} catch (error) {
			const message = getErrorMessage(error);
			disposeGraphView();
			renderWorkspaceState(
				'Crispy failed to update the graph.',
				message,
				undefined,
				true,
			);
			console.error('[Crispy] Webview update failed:', error);
		}
	};

	// Extension 메시지 수신 준비가 끝난 후 ready handshake를 전송한다.
	window.addEventListener('message', handleExtensionMessage);
	renderWorkspaceState('Loading workspace structure...');
	vscode.postMessage({
		type: 'webviewReady',
	} satisfies WebviewReadyMessage);

	window.addEventListener(
		'beforeunload',
		() => {
			// Webview 종료 시 Window 이벤트와 GraphView 리소스를 정리한다.
			window.removeEventListener('message', handleExtensionMessage);
			disposeGraphView();
		},
		{ once: true },
	);
} catch (error) {
	const message = getErrorMessage(error);
	const errorState = document.createElement('div');
	errorState.className = 'webview-startup-error';
	const title = document.createElement('strong');
	title.textContent = 'Crispy failed to start.';
	const detail = document.createElement('span');
	detail.textContent = message;
	errorState.append(title, detail);
	root.replaceChildren(errorState);
	console.error('[Crispy] Webview startup failed:', error);
}

/** function disposeGraphView()
 *
 * - 현재 GraphView의 이벤트와 DOM 리소스를 정리하고 참조를 제거한다.
 *
 * @returns 반환값 없음
 */
function disposeGraphView(): void {
	graphView?.dispose();
	graphView = undefined;
}

/** function renderWorkspaceState( message, detail, action, isError )
 *
 * - Loading, 빈 Workspace, 미지원, 오류 상태를 공통 안내 화면으로 표시한다.
 * - 선택적으로 상세 메시지와 동작 버튼을 추가한다.
 *
 * @param message 화면의 주요 상태 메시지
 * @param detail 	선택적으로 표시할 상세 메시지
 * @param action 	선택적으로 표시할 버튼 정보
 * @param isError 오류 상태 강조 여부
 * @returns 		반환값 없음
 */
function renderWorkspaceState(
	message: string,
	detail?: string,
	action?: {
		label: string;
		onClick: () => void;
	},
	isError = false,
): void {
	const state = document.createElement('main');
	state.className = 'workspace-state';
	if (isError) {
		state.classList.add('is-error');
	}

	const messageElement = document.createElement('strong');
	messageElement.className = 'workspace-state-message';
	messageElement.textContent = message;
	state.append(messageElement);

	if (detail) {
		const detailElement = document.createElement('span');
		detailElement.className = 'workspace-state-detail';
		detailElement.textContent = detail;
		state.append(detailElement);
	}

	if (action) {
		const button = document.createElement('button');
		button.className = 'workspace-state-action';
		button.type = 'button';
		button.textContent = action.label;
		button.addEventListener('click', action.onClick);
		state.append(button);
	}

	root.replaceChildren(state);
}

/** function getErrorMessage( error )
 *
 * - 알 수 없는 Webview 오류 값을 화면에 표시할 문자열로 변환한다.
 *
 * @param error 변환할 오류 값
 * @returns 	오류 메시지 문자열
 */
function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
