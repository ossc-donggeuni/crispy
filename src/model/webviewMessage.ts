import type { ProjectNode, SharedSelection } from './projectNode';

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

export type WebviewToExtensionMessage =
	| WebviewReadyMessage
	| OpenWorkspaceFolderMessage
	| SelectionChangedMessage;

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

export type ExtensionToWebviewMessage =
	| WorkspaceLoadingMessage
	| WorkspaceLoadedMessage
	| WorkspaceEmptyMessage
	| WorkspaceUnsupportedMessage
	| WorkspaceErrorMessage;

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
		default:
			return false;
	}
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
