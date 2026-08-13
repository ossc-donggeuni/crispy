import type {
	ExtensionToWebviewMessage,
	WebviewToExtensionMessage,
} from '../messages';

import { initializeGraphView } from './graph/graphView';
import { initializePanelDock } from './panel/panelDock';
import { initializePanelResize } from './panel/panelResize';
import {
	restorePanelLayoutState,
	savePanelLayoutState,
	type WebviewStateApi,
} from './panel/panelState';

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
const serializedInitialState = document.currentScript?.getAttribute('data-layout-state')
	?? undefined;
const state = restorePanelLayoutState(vscodeApi, serializedInitialState);

const layout = getRequiredElement<HTMLElement>('.crispy-layout');
const graphArea = getRequiredElement<HTMLElement>('#graph-area');
const dragHandle = getRequiredElement<HTMLButtonElement>('#chat-drag-handle');
const resizeHandle = getRequiredElement<HTMLElement>('#panel-resize-handle');
const dockPreview = getRequiredElement<HTMLElement>('#dock-preview');

const graphView = initializeGraphView(graphArea);

window.addEventListener('unload', () => graphView.dispose(), { once: true });

// Dock 초기화
const refreshDock = initializePanelDock(
	layout,
	dragHandle,
	dockPreview,
	state,
	() => savePanelLayoutState(vscodeApi, state),
);
// Resize 초기화
initializePanelResize(
	layout,
	resizeHandle,
	state,
	refreshDock,
	() => savePanelLayoutState(vscodeApi, state),
);

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
