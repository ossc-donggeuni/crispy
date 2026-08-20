import {
	initializeAgentPanelUi,
	type AgentPanelUiController,
} from '../agent/UI/agentPanelUi';
import { parseHostToWebviewMessage } from '../agent/protocol';
import { createDefaultAgentTerminalPool } from '../agent/webview/agentTerminalPool';
import type { WebviewToExtensionMessage } from '../messages';
import { initializeGraphView } from './graph/graphView';
import { deserializeGraphFromWebview } from './graph/graphTransport';
import { initializePanelCollapse } from './panel/panelCollapse';
import { initializePanelDock } from './panel/panelDock';
import { applyPanelSize, initializePanelResize } from './panel/panelResize';

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
const currentScript = document.currentScript;
const serializedInitialState = currentScript?.getAttribute('data-webview-state')
	?? undefined;
const serializedWorkspaceGraph = currentScript?.getAttribute('data-workspace-graph')
	?? undefined;
const initialState = restoreWebviewState(vscodeApi, serializedInitialState);
const workspaceGraph = deserializeGraphFromWebview(serializedWorkspaceGraph);
const panelState = initialState.panel;

const layout = getRequiredElement<HTMLElement>('.crispy-layout');
const graphArea = getRequiredElement<HTMLElement>('#graph-area');
const chatPanel = getRequiredElement<HTMLElement>('#agent-chat-area');
const dragHandle = getRequiredElement<HTMLButtonElement>('#chat-drag-handle');
const collapseButton = getRequiredElement<HTMLButtonElement>('#chat-collapse-toggle');
const stickerOpener = getRequiredElement<HTMLButtonElement>('#chat-sticker-opener');
const resizeHandle = getRequiredElement<HTMLElement>('#panel-resize-handle');
const dockPreview = getRequiredElement<HTMLElement>('#dock-preview');
const terminalArea = getRequiredElement<HTMLElement>('#agent-terminal-area');

const graphView = initializeGraphView(graphArea, initialState.graph, workspaceGraph);

/** 탭마다 독립적인 xterm과 세션 소유 관계를 유지하는 Terminal 표면 모음이다. */
const terminalPool = createDefaultAgentTerminalPool(
	terminalArea,
	(message) => vscodeApi.postMessage(message),
);

/** Panel과 Graph의 현재 상태를 하나의 저장 가능한 snapshot으로 읽는다. */
const getCurrentWebviewState = (): PersistedWebviewState => ({
	panel: panelState,
	graph: graphView.state.getState(),
});

/** VS Code Webview state와 Extension Host snapshot을 함께 갱신한다. */
const persistWebviewState = () => {
	const state = getCurrentWebviewState();

	saveWebviewState(vscodeApi, state);
	vscodeApi.postMessage({
		type: 'webview.stateChanged',
		state,
	});
};

/**
 * Agent UI 동작을 Host protocol로 연결하며, 전송 실패가 Graph, Dock, Layout이나
 * 다른 탭 Terminal로 전파되지 않도록 이 경계 안에서 격리한다.
 */
const postAgentMessage = (message: WebviewToExtensionMessage): void => {
	try {
		vscodeApi.postMessage(message);
	} catch {
		/** Host 전송 실패가 나머지 Webview 기능으로 전파되지 않게 한다. */
	}
};

/**
 * 활성 탭 전환을 Host와 Terminal 표면에 함께 반영한다.
 *
 * @param tabId 새로 활성화된 탭 식별자
 */
const activateTab = (tabId: string): void => {
	postAgentMessage({ type: 'tab.switch', tabId });
	terminalPool.setActiveTab(tabId);
};

let agentPanelUi: AgentPanelUiController | undefined;
try {
	agentPanelUi = initializeAgentPanelUi(
		{
			topBar: getRequiredElement<HTMLElement>('#agent-top-bar'),
			tabStrip: getRequiredElement<HTMLElement>('#agent-tab-strip'),
			providerPicker: getRequiredElement<HTMLElement>(
				'#agent-provider-picker-host',
			),
			dialogHost: getRequiredElement<HTMLElement>('#agent-dialog-host'),
		},
		{
			onTabCreated(tabId): void {
				/** provider가 정해지기 전이므로 Host는 탭만 등록하고 세션은 만들지 않는다. */
				postAgentMessage({ type: 'tab.create', tabId });
				terminalPool.ensureTab(tabId);
				terminalPool.setActiveTab(tabId);
			},

			onTabActivated(tabId): void {
				activateTab(tabId);
			},

			onProviderSelected(tabId, providerId): void {
				postAgentMessage({ type: 'agent.switch', tabId, providerId });
			},

			onAgentReselectionRequested(tabId): void {
				/** Host PTY와 기존 xterm을 정리한 뒤 같은 탭에 빈 표면을 다시 만든다. */
				postAgentMessage({ type: 'agent.reset', tabId });
				terminalPool.resetTab(tabId);
			},

			onTabClosed(tabId): void {
				postAgentMessage({ type: 'tab.close', tabId });
				terminalPool.closeTab(tabId);

				/** 탭 상태가 이미 이웃 탭으로 옮겨졌으므로 표면 표시도 함께 맞춘다. */
				const nextActiveTabId = agentPanelUi?.getSnapshot().activeTabId;
				if (nextActiveTabId !== undefined) {
					activateTab(nextActiveTabId);
				}
			},

			/** 탭 strip 높이 변화가 xterm 크기에 반영되도록 fit을 다시 예약한다. */
			onLayoutChange: () => terminalPool.scheduleActiveTerminalFit(),
		},
	);
} catch {
	agentPanelUi = undefined;
}

/** Collapse 초기화 */
const refreshCollapse = initializePanelCollapse(
	{
		chatPanel,
		resizeHandle,
		collapseButton,
		stickerOpener,
	},
	panelState,
	persistWebviewState,
	() => terminalPool.scheduleActiveTerminalFit(),
);
/** Dock 초기화 */
const refreshDock = initializePanelDock(
	layout,
	dragHandle,
	dockPreview,
	panelState,
	persistWebviewState,
	() => {
		/** Dock이 바뀌면 새 방향 기준으로 표시 크기와 Sticker 위치를 다시 맞춘다. */
		applyPanelSize(layout, panelState);
		refreshCollapse();
		terminalPool.scheduleActiveTerminalFit();
	},
);
/** Resize 초기화 */
initializePanelResize(
	layout,
	resizeHandle,
	panelState,
	refreshDock,
	persistWebviewState,
	() => terminalPool.scheduleActiveTerminalFit(),
);

const unsubscribeGraphState = graphView.state.subscribe(persistWebviewState);

window.addEventListener('unload', () => {
	unsubscribeGraphState();
	graphView.dispose();
	terminalPool.dispose();
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
			terminalPool.handleHostMessage(parseResult.value);
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
