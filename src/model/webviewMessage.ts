import type { ProjectNode, SharedSelection } from './projectNode';
import type {
	FileAnalysisResultStatus,
	SymbolDisplayKind,
	SymbolMetadata,
} from './fileAnalysis';

export type WebviewReadyMessage = {
	type: 'webviewReady';
};

export type OpenWorkspaceFolderMessage = {
	type: 'openWorkspaceFolder';
};

export type SelectionChangedMessage = {
	type: 'selectionChanged';
	payload: {
		selectedNodeId?: string;
	};
};

export type FileAnalysisRequestedMessage = {
	type: 'fileAnalysisRequested';
	payload: {
		requestId: string;
		fileNodeId: string;
		relativePath: string;
	};
};

export type WebviewToExtensionMessage =
	| WebviewReadyMessage
	| OpenWorkspaceFolderMessage
	| SelectionChangedMessage
	| FileAnalysisRequestedMessage;

export type WorkspaceLoadingMessage = {
	type: 'workspaceLoading';
};

export type WorkspaceLoadedMessage = {
	type: 'workspaceLoaded';
	payload: {
		workspaceName: string;
		nodes: ProjectNode[];
	};
};

export type WorkspaceEmptyMessage = {
	type: 'workspaceEmpty';
};

export type WorkspaceUnsupportedMessage = {
	type: 'workspaceUnsupported';
	payload: {
		message: string;
	};
};

export type WorkspaceErrorMessage = {
	type: 'workspaceError';
	payload: {
		message: string;
	};
};

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

export type ExtensionToWebviewMessage =
	| WorkspaceLoadingMessage
	| WorkspaceLoadedMessage
	| WorkspaceEmptyMessage
	| WorkspaceUnsupportedMessage
	| WorkspaceErrorMessage
	| FileAnalysisResultMessage;

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

function isFileAnalysisResultStatus(
	value: unknown,
): value is FileAnalysisResultStatus {
	return (
		value === 'unsupported'
		|| value === 'ready'
		|| value === 'failed'
	);
}

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

function isFileNodeId(value: unknown): value is string {
	return (
		isNonEmptyString(value)
		&& value.startsWith('file:')
		&& value.length > 'file:'.length
	);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

function isProjectNodeType(value: unknown): value is ProjectNode['type'] {
	return (
		value === 'project'
		|| value === 'application'
		|| value === 'directory'
		|| value === 'file'
		|| value === 'symbol'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
