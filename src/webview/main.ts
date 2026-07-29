import {
	createSelectionChangedMessage,
	isExtensionToWebviewMessage,
	type OpenWorkspaceFolderMessage,
	type WebviewReadyMessage,
	type WebviewToExtensionMessage,
} from '../model/webviewMessage';
import { GraphView } from './GraphView';
import './styles.css';

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
	const handleExtensionMessage = (event: MessageEvent<unknown>): void => {
		if (!isExtensionToWebviewMessage(event.data)) {
			return;
		}

		try {
			switch (event.data.type) {
				case 'workspaceLoading':
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
					disposeGraphView();
					graphView = new GraphView(root, {
						nodes: event.data.payload.nodes,
						planInfo: [],
						onSelectionChange: (selection) => {
							vscode.postMessage(createSelectionChangedMessage(selection));
						},
					});
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

	window.addEventListener('message', handleExtensionMessage);
	renderWorkspaceState('Loading workspace structure...');
	vscode.postMessage({
		type: 'webviewReady',
	} satisfies WebviewReadyMessage);

	window.addEventListener(
		'beforeunload',
		() => {
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

function disposeGraphView(): void {
	graphView?.dispose();
	graphView = undefined;
}

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

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
