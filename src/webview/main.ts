import { mockProjectNodes } from '../mock/projectNodes';
import { createSelectionChangedMessage } from '../model/webviewMessage';
import { GraphView } from './GraphView';
import './styles.css';

type VsCodeApi = {
	postMessage: (message: unknown) => void;
};

declare function acquireVsCodeApi(): VsCodeApi;

const root = document.getElementById('app');

if (!root) {
	throw new Error('Crispy could not find its Webview root element.');
}

try {
	const vscode = acquireVsCodeApi();
	const graphView = new GraphView(root, {
		nodes: mockProjectNodes,
		planInfo: [],
		onSelectionChange: (selection) => {
			vscode.postMessage(createSelectionChangedMessage(selection));
		},
	});

	window.addEventListener('beforeunload', () => graphView.dispose(), { once: true });
} catch (error) {
	const message = error instanceof Error ? error.message : 'Unknown startup error';
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
