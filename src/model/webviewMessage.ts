import type { ProjectNode, SharedSelection } from './projectNode';
import type {
	FileAnalysisResultStatus,
	SymbolDisplayKind,
	SymbolMetadata,
} from './fileAnalysis';

/** type WebviewReadyMessage
 *
 * - Webview 스크립트가 Extension 메시지를 받을 준비가 되었음을 알린다.
 */
export type WebviewReadyMessage = {
	type: 'webviewReady';
};

/** type OpenWorkspaceFolderMessage
 *
 * - Workspace가 없는 상태에서 폴더 선택 대화상자를 요청한다.
 */
export type OpenWorkspaceFolderMessage = {
	type: 'openWorkspaceFolder';
};

/** type SelectionChangedMessage
 *
 * - 현재 선택된 노드 ID 또는 선택 해제 상태를 Extension에 전달한다.
 */
export type SelectionChangedMessage = {
	type: 'selectionChanged';
	payload: {
		selectedNodeId?: string;
	};
};

/** type FileAnalysisRequestedMessage
 *
 * - 파일을 펼칠 때 Document Symbol 분석에 필요한 요청 식별자와 경로를 전달한다.
 */
export type FileAnalysisRequestedMessage = {
	type: 'fileAnalysisRequested';
	payload: {
		requestId: string;
		fileNodeId: string;
		relativePath: string;
	};
};

/** type WebviewToExtensionMessage
 *
 * - Webview에서 Extension Host로 전송할 수 있는 메시지 종류를 정의한다.
 */
export type WebviewToExtensionMessage =
	| WebviewReadyMessage
	| OpenWorkspaceFolderMessage
	| SelectionChangedMessage
	| FileAnalysisRequestedMessage;

/** type WorkspaceLoadingMessage
 *
 * - Extension Host가 Workspace 구조를 스캔하고 있음을 Webview에 알린다.
 */
export type WorkspaceLoadingMessage = {
	type: 'workspaceLoading';
};

/** type WorkspaceLoadedMessage
 *
 * - 스캔한 단일 Workspace 이름과 ProjectNode 목록을 Webview에 전달한다.
 */
export type WorkspaceLoadedMessage = {
	type: 'workspaceLoaded';
	payload: {
		workspaceName: string;
		nodes: ProjectNode[];
	};
};

/** type WorkspaceEmptyMessage
 *
 * - 현재 열린 Workspace Folder가 없음을 Webview에 알린다.
 */
export type WorkspaceEmptyMessage = {
	type: 'workspaceEmpty';
};

/** type WorkspaceUnsupportedMessage
 *
 * - 다중 Root처럼 현재 지원하지 않는 Workspace 상태와 이유를 전달한다.
 */
export type WorkspaceUnsupportedMessage = {
	type: 'workspaceUnsupported';
	payload: {
		message: string;
	};
};

/** type WorkspaceErrorMessage
 *
 * - Workspace 스캔 또는 폴더 열기 실패 메시지를 Webview에 전달한다.
 */
export type WorkspaceErrorMessage = {
	type: 'workspaceError';
	payload: {
		message: string;
	};
};

/** type FileAnalysisResultMessage
 *
 * - 파일별 Document Symbol 분석 완료 상태와 정규화된 결과를 Webview에 전달한다.
 */
export type FileAnalysisResultMessage = {
	type: 'fileAnalysisResult';
	payload: {
		requestId: string;
		fileNodeId: string;
		status: FileAnalysisResultStatus;
		symbolNodes: ProjectNode[];
		symbolMetadata: SymbolMetadata[];
		errorMessage?: string;
	};
};

/** type ExtensionToWebviewMessage
 *
 * - Extension Host에서 Webview로 전송할 수 있는 메시지 종류를 정의한다.
 */
export type ExtensionToWebviewMessage =
	| WorkspaceLoadingMessage
	| WorkspaceLoadedMessage
	| WorkspaceEmptyMessage
	| WorkspaceUnsupportedMessage
	| WorkspaceErrorMessage
	| FileAnalysisResultMessage;

/** function createSelectionChangedMessage( selection )
 *
 * - GraphView 선택 상태를 Webview에서 Extension으로 보낼 메시지로 변환한다.
 * - 선택이 해제된 경우 selectedNodeId 속성을 payload에서 생략한다.
 *
 * @param selection GraphView의 현재 공유 선택 상태
 * @returns 		선택 변경 메시지
 */
export function createSelectionChangedMessage(
	selection: SharedSelection,
): SelectionChangedMessage {
	const payload: SelectionChangedMessage['payload'] = {};

	if (selection.selectedNodeId !== undefined) {
		payload.selectedNodeId = selection.selectedNodeId;
	}

	return {
		type: 'selectionChanged',
		payload,
	};
}

/** function isSelectionChangedMessage( message )
 *
 * - 알 수 없는 값이 selectionChanged 메시지 계약을 만족하는지 검사한다.
 *
 * @param message 검사할 원본 값
 * @returns 		selectionChanged 메시지 여부
 */
export function isSelectionChangedMessage(
	message: unknown,
): message is SelectionChangedMessage {
	if (!isRecord(message) || message.type !== 'selectionChanged') {
		return false;
	}

	const payload = message.payload;
	return (
		isRecord(payload)
		&& (
			payload.selectedNodeId === undefined
			|| typeof payload.selectedNodeId === 'string'
		)
	);
}

/** function isWebviewToExtensionMessage( message )
 *
 * - Webview에서 받은 원본 메시지의 공통 구조와 종류를 검사한다.
 * - payload가 있는 메시지는 해당 메시지별 검증 함수에 위임한다.
 *
 * @param message 검사할 원본 값
 * @returns 		WebviewToExtensionMessage 여부
 */
export function isWebviewToExtensionMessage(
	message: unknown,
): message is WebviewToExtensionMessage {
	if (!isRecord(message) || typeof message.type !== 'string') {
		return false;
	}

	switch (message.type) {
		case 'webviewReady':
		case 'openWorkspaceFolder':
			return true;
		case 'selectionChanged':
			return isSelectionChangedMessage(message);
		case 'fileAnalysisRequested':
			return isFileAnalysisRequestedMessage(message);
		default:
			return false;
	}
}

/** function isExtensionToWebviewMessage( message )
 *
 * - Extension에서 받은 원본 메시지의 공통 구조와 종류를 검사한다.
 * - Workspace 노드와 파일 분석 결과의 중첩 payload까지 런타임에 확인한다.
 *
 * @param message 검사할 원본 값
 * @returns 		ExtensionToWebviewMessage 여부
 */
export function isExtensionToWebviewMessage(
	message: unknown,
): message is ExtensionToWebviewMessage {
	if (!isRecord(message) || typeof message.type !== 'string') {
		return false;
	}

	switch (message.type) {
		case 'workspaceLoading':
		case 'workspaceEmpty':
			return true;
		case 'workspaceLoaded':
			return (
				isRecord(message.payload)
				&& typeof message.payload.workspaceName === 'string'
				&& Array.isArray(message.payload.nodes)
				&& message.payload.nodes.every(isProjectNode)
			);
		case 'workspaceUnsupported':
		case 'workspaceError':
			return (
				isRecord(message.payload)
				&& typeof message.payload.message === 'string'
			);
		case 'fileAnalysisResult':
			return isFileAnalysisResultMessage(message);
		default:
			return false;
	}
}

/** function isFileAnalysisRequestedMessage( message )
 *
 * - 파일 분석 요청의 requestId, fileNodeId, relativePath를 검사한다.
 *
 * @param message 공통 객체 검사를 통과한 메시지
 * @returns 		FileAnalysisRequestedMessage 여부
 */
function isFileAnalysisRequestedMessage(
	message: Record<string, unknown>,
): message is FileAnalysisRequestedMessage {
	if (!isRecord(message.payload)) {
		return false;
	}

	return (
		isNonEmptyString(message.payload.requestId)
		&& isFileNodeId(message.payload.fileNodeId)
		&& isNonEmptyString(message.payload.relativePath)
	);
}

/** function isFileAnalysisResultMessage( message )
 *
 * - 파일 분석 결과의 상태, Symbol 노드, 메타데이터를 검사한다.
 *
 * @param message 공통 객체 검사를 통과한 메시지
 * @returns 		FileAnalysisResultMessage 여부
 */
function isFileAnalysisResultMessage(
	message: Record<string, unknown>,
): message is FileAnalysisResultMessage {
	if (!isRecord(message.payload)) {
		return false;
	}

	return (
		isNonEmptyString(message.payload.requestId)
		&& isFileNodeId(message.payload.fileNodeId)
		&& isFileAnalysisResultStatus(message.payload.status)
		&& Array.isArray(message.payload.symbolNodes)
		&& message.payload.symbolNodes.every(isProjectNode)
		&& Array.isArray(message.payload.symbolMetadata)
		&& message.payload.symbolMetadata.every(isSymbolMetadata)
		&& (
			message.payload.errorMessage === undefined
			|| typeof message.payload.errorMessage === 'string'
		)
	);
}

/** function isProjectNode( value )
 *
 * - 알 수 없는 값이 공통 ProjectNode 구조를 만족하는지 검사한다.
 *
 * @param value 검사할 원본 값
 * @returns 	ProjectNode 여부
 */
function isProjectNode(value: unknown): value is ProjectNode {
	if (
		!isRecord(value)
		|| typeof value.id !== 'string'
		|| !isProjectNodeType(value.type)
		|| typeof value.name !== 'string'
		|| !Array.isArray(value.childrenIds)
		|| !value.childrenIds.every((childId) => typeof childId === 'string')
	) {
		return false;
	}

	return (
		(value.relativePath === undefined || typeof value.relativePath === 'string')
		&& (value.parentId === undefined || typeof value.parentId === 'string')
	);
}

/** function isSymbolMetadata( value )
 *
 * - Symbol 메타데이터의 ID, 종류, 1-based 줄 번호와 상세 정보를 검사한다.
 *
 * @param value 검사할 원본 값
 * @returns 	SymbolMetadata 여부
 */
function isSymbolMetadata(value: unknown): value is SymbolMetadata {
	return (
		isRecord(value)
		&& isNonEmptyString(value.nodeId)
		&& isSymbolDisplayKind(value.kind)
		&& typeof value.startLine === 'number'
		&& Number.isInteger(value.startLine)
		&& value.startLine >= 1
		&& (value.detail === undefined || typeof value.detail === 'string')
	);
}

/** function isFileAnalysisResultStatus( value )
 *
 * - 값이 Webview로 전송 가능한 파일 분석 완료 상태인지 검사한다.
 *
 * @param value 검사할 원본 값
 * @returns 	FileAnalysisResultStatus 여부
 */
function isFileAnalysisResultStatus(
	value: unknown,
): value is FileAnalysisResultStatus {
	return (
		value === 'unsupported'
		|| value === 'ready'
		|| value === 'failed'
	);
}

/** function isSymbolDisplayKind( value )
 *
 * - 값이 UI에서 지원하는 Symbol 표시 종류인지 검사한다.
 *
 * @param value 검사할 원본 값
 * @returns 	SymbolDisplayKind 여부
 */
function isSymbolDisplayKind(value: unknown): value is SymbolDisplayKind {
	return (
		value === 'function'
		|| value === 'class'
		|| value === 'method'
		|| value === 'constructor'
		|| value === 'interface'
		|| value === 'enum'
		|| value === 'struct'
		|| value === 'module'
	);
}

/** function isFileNodeId( value )
 *
 * - 값이 비어 있지 않은 file: 접두사 노드 ID인지 검사한다.
 *
 * @param value 검사할 원본 값
 * @returns 	파일 노드 ID 여부
 */
function isFileNodeId(value: unknown): value is string {
	return (
		isNonEmptyString(value)
		&& value.startsWith('file:')
		&& value.length > 'file:'.length
	);
}

/** function isNonEmptyString( value )
 *
 * - 값이 공백만 포함하지 않는 문자열인지 검사한다.
 *
 * @param value 검사할 원본 값
 * @returns 	비어 있지 않은 문자열 여부
 */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/** function isProjectNodeType( value )
 *
 * - 값이 ProjectNode에서 허용하는 노드 종류인지 검사한다.
 *
 * @param value 검사할 원본 값
 * @returns 	ProjectNodeType 여부
 */
function isProjectNodeType(value: unknown): value is ProjectNode['type'] {
	return (
		value === 'project'
		|| value === 'application'
		|| value === 'directory'
		|| value === 'file'
		|| value === 'symbol'
	);
}

/** function isRecord( value )
 *
 * - 값이 null이 아닌 객체인지 검사해 안전한 속성 접근을 허용한다.
 *
 * @param value 검사할 원본 값
 * @returns 	문자열 키 객체 여부
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
