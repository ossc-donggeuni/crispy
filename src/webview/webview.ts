import { parseHostToWebviewMessage } from '../agent/protocol';
import { assertWebviewTerminalRuntimeAvailable } from '../agent/webview/runtimeDependencies';
import type { WebviewToExtensionMessage } from '../messages';
import { initializePanelDock } from './panelDock';
import { initializePanelResize } from './panelResize';
import {
	restorePanelLayoutState,
	savePanelLayoutState,
	type WebviewStateApi,
} from './panelState';

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
assertWebviewTerminalRuntimeAvailable();

const serializedInitialState = document.currentScript?.getAttribute('data-layout-state')
	?? undefined;
const state = restorePanelLayoutState(vscodeApi, serializedInitialState);

const layout = getRequiredElement<HTMLElement>('.crispy-layout');
const dragHandle = getRequiredElement<HTMLButtonElement>('#chat-drag-handle');
const resizeHandle = getRequiredElement<HTMLElement>('#panel-resize-handle');
const dockPreview = getRequiredElement<HTMLElement>('#dock-preview');

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

/**
 * Extension Host에서 받은 unknown 메시지를 구조적으로 검증한 뒤 처리한다.
 * 검증되지 않은 payload는 내용이나 민감 정보를 기록하지 않고 무시한다.
 *
 * @param message Extension Host에서 수신한 검증 전 메시지
 */
function handleHostMessage(message: unknown): void {
	const parseResult = parseHostToWebviewMessage(message);
	if (!parseResult.ok) {
		return;
	}

	switch (parseResult.value.type) {
		case 'extension.ready':
			console.log('[Crispy] Extension ready');
			break;
	}
}

/** Extension Host가 전송한 메시지를 Webview protocol 수신 경계로 전달한다. */
window.addEventListener('message', (event) => {
	handleHostMessage(event.data);
});

/** 현재 Webview 초기화 완료 사실만 Host에 알리며 terminal.ready는 전송하지 않는다. */
vscodeApi.postMessage({
	type: 'webview.ready',
} satisfies WebviewToExtensionMessage);
