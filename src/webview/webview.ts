import type {
	ExtensionToWebviewMessage,
	WebviewToExtensionMessage,
} from '../messages';

import { initializeGraphView } from './graph/graphView';
import { initializePanelDock } from './panel/panelDock';
import { initializePanelResize } from './panel/panelResize';
import {
	restoreWebviewState,
	saveWebviewState,
	type PersistedWebviewState,
	type WebviewStateApi,
} from './webviewState';

declare function acquireVsCodeApi(): WebviewStateApi & {
	postMessage(message: WebviewToExtensionMessage): void;
};

/**
 * CSS 선택자에 해당하는 필수 DOM 요소를 조회한다.
 * 요소가 없으면 Webview 마크업 구성이 잘못된 것으로 간주하고 오류를 발생시킨다.
 *
 * @param selector 조회할 DOM 요소의 CSS 선택자
 * @returns 선택자와 일치하는 DOM 요소
 */
function getRequiredElement<T extends HTMLElement>(selector: string): T {
	const element = document.querySelector<T>(selector);

	if (!element) {
		throw new Error(`Missing Webview element: ${selector}`);
	}

	return element;
}

const vscodeApi = acquireVsCodeApi();
const serializedInitialState = document.currentScript?.getAttribute('data-webview-state')
	?? undefined;
const initialState = restoreWebviewState(vscodeApi, serializedInitialState);
const panelState = initialState.panel;

const layout = getRequiredElement<HTMLElement>('.crispy-layout');
const graphArea = getRequiredElement<HTMLElement>('#graph-area');
const dragHandle = getRequiredElement<HTMLButtonElement>('#chat-drag-handle');
const resizeHandle = getRequiredElement<HTMLElement>('#panel-resize-handle');
const dockPreview = getRequiredElement<HTMLElement>('#dock-preview');

const graphView = initializeGraphView(graphArea, initialState.graph);

const getCurrentWebviewState = (): PersistedWebviewState => ({
	panel: panelState,
	graph: graphView.state.getState(),
});

const persistWebviewState = () => {
	const state = getCurrentWebviewState();

	saveWebviewState(vscodeApi, state);
	vscodeApi.postMessage({
		type: 'webview.stateChanged',
		state,
	});
};

// Dock 초기화
const refreshDock = initializePanelDock(
	layout,
	dragHandle,
	dockPreview,
	panelState,
	persistWebviewState,
);
// Resize 초기화
initializePanelResize(
	layout,
	resizeHandle,
	panelState,
	refreshDock,
	persistWebviewState,
);

const unsubscribeGraphState = graphView.state.subscribe(persistWebviewState);

window.addEventListener('unload', () => {
	unsubscribeGraphState();
	graphView.dispose();
}, { once: true });

window.addEventListener('message', (event) => {
	const message = event.data as ExtensionToWebviewMessage;

	switch (message.type) {
		// Ready
		case 'extension.ready':
			console.log('[Crispy] Extension ready');
			break;
	}
});

vscodeApi.postMessage({
	type: 'webview.ready',
} satisfies WebviewToExtensionMessage);
