import { initializeAgentPanelUi } from '../agent/UI/agentPanelUi';
import { parseHostToWebviewMessage } from '../agent/protocol';
import { initializeShellTerminal } from '../agent/webview/shellTerminal';
import type { WebviewToExtensionMessage } from '../messages';
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
const terminalSurface = getRequiredElement<HTMLElement>('#terminal-surface');
const terminalMount = getRequiredElement<HTMLElement>('#terminal-mount');
const terminalOverlay = getRequiredElement<HTMLElement>('#terminal-overlay');

const graphView = initializeGraphView(graphArea);

const shellTerminal = initializeShellTerminal(
	terminalSurface,
	terminalMount,
	terminalOverlay,
	(message) => vscodeApi.postMessage(message),
);

/*
 * Agent UI 뼈대는 아직 Host와 연결되지 않은 mock 상태이며,
 * 초기화 실패가 Graph, Dock, Layout이나 Terminal로 전파되지 않도록 격리한다.
 */
let agentPanelUi: { dispose(): void } | undefined;
try {
	agentPanelUi = initializeAgentPanelUi(
		{
			topBar: getRequiredElement<HTMLElement>('#agent-top-bar'),
			tabStrip: getRequiredElement<HTMLElement>('#agent-tab-strip'),
			dialogHost: getRequiredElement<HTMLElement>('#agent-dialog-host'),
		},
		{
			/* 탭 strip 높이 변화가 xterm 크기에 반영되도록 fit을 다시 예약한다. */
			onLayoutChange: () => shellTerminal.scheduleTerminalFit(),
		},
	);
} catch {
	agentPanelUi = undefined;
}

// Dock 초기화
const refreshDock = initializePanelDock(
	layout,
	dragHandle,
	dockPreview,
	state,
	() => savePanelLayoutState(vscodeApi, state),
	shellTerminal.scheduleTerminalFit,
);
// Resize 초기화
initializePanelResize(
	layout,
	resizeHandle,
	state,
	refreshDock,
	() => savePanelLayoutState(vscodeApi, state),
	shellTerminal.scheduleTerminalFit,
);

window.addEventListener('unload', () => {
	graphView.dispose();
	shellTerminal.dispose();
	agentPanelUi?.dispose();
}, { once: true });

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
		default:
			shellTerminal.handleHostMessage(parseResult.value);
	}
}

/** Extension Host가 전송한 메시지를 Webview protocol 수신 경계로 전달한다. */
window.addEventListener('message', (event) => {
	handleHostMessage(event.data);
});

/** 현재 Webview 초기화 완료 사실을 Host에 알린다. Terminal ready는 초기 fit 뒤 별도로 전송된다. */
vscodeApi.postMessage({
	type: 'webview.ready',
} satisfies WebviewToExtensionMessage);
