import type { SharedSelection } from './projectNode';

export type SelectionChangedMessage = {
	type: 'selectionChanged';
	payload: {
		selectedNodeId?: string;
	};
};

export type CrispyWebviewMessage = SelectionChangedMessage;

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
