import '@xterm/xterm/css/xterm.css';
import { initializePanelDock } from './panelDock';
import { initializePanelResize } from './panelResize';
import './webview.css';
import {
	initializeShellTerminal,
	type TerminalWebviewApi,
} from '../agent/webview/shellTerminalView';
import {
	restorePanelLayoutState,
	savePanelLayoutState,
	type WebviewStateApi,
} from './panelState';

type CrispyWebviewApi = Omit<WebviewStateApi, 'postMessage'> & TerminalWebviewApi & {
	postMessage(message: Parameters<WebviewStateApi['postMessage']>[0]): void;
};

declare function acquireVsCodeApi(): CrispyWebviewApi;

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
const dragHandle = getRequiredElement<HTMLButtonElement>('#chat-drag-handle');
const resizeHandle = getRequiredElement<HTMLElement>('#panel-resize-handle');
const dockPreview = getRequiredElement<HTMLElement>('#dock-preview');
const terminalContainer = getRequiredElement<HTMLElement>('#terminal');
const terminalOverlay = getRequiredElement<HTMLElement>('#terminal-overlay');
const terminalStatus = getRequiredElement<HTMLElement>('#terminal-status');
const terminalRestart = getRequiredElement<HTMLButtonElement>('#terminal-restart');

const terminalView = initializeShellTerminal(
	{
		container: terminalContainer,
		overlay: terminalOverlay,
		status: terminalStatus,
		restartButton: terminalRestart,
	},
	vscodeApi,
);

// Dock 초기화
const refreshDock = initializePanelDock(
	layout,
	dragHandle,
	dockPreview,
	state,
	() => {
		savePanelLayoutState(vscodeApi, state);
		terminalView.restoreVisibleTerminal();
	},
);
// Resize 초기화
initializePanelResize(
	layout,
	resizeHandle,
	state,
	() => {
		refreshDock();
		terminalView.scheduleFit();
	},
	() => {
		savePanelLayoutState(vscodeApi, state);
		terminalView.restoreVisibleTerminal();
	},
);
