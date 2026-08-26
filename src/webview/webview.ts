import {
	initializeAgentPanelUi,
	type AgentPanelUiController,
} from '../agent/UI/agentPanelUi';
import { parseHostToWebviewMessage } from '../agent/protocol';
import { createAgentActivityStore } from '../agent/webview/agentActivityStore';
import { createAgentSessionColorRegistry } from '../agent/agentSessionColor';
import { createAgentSessionPresentationCoordinator } from '../agent/webview/agentSessionPresentationCoordinator';
import {
	createAgentSessionPresentationStore,
	type AgentSessionPresentationStore,
} from '../agent/webview/agentSessionPresentationStore';
import { createDefaultAgentTerminalPool } from '../agent/webview/agentTerminalPool';
import {
	parseAgentActivityTrackedClearMessage,
	getWorkspaceGraphRootIds,
	parseAgentActivityToWebviewMessage,
	parseGraphNodeEffectToWebviewMessage,
	parseWorkspaceRootIds,
	parseWorkspaceToWebviewMessage,
	type AgentActivityClearMessage,
	type AgentActivityClearSessionMessage,
	type WebviewToExtensionMessage,
} from '../messages';
import {
	createDefaultWorkspacePersistentState,
	parseWorkspacePersistentState,
	WORKSPACE_PERSISTENT_STATE_VERSION,
	type WorkspacePersistentState,
} from '../workspace/workspaceMetadata';
import { deserializeWorkspacePresentationFromWebview } from '../workspace/workspacePresentation';
import { createAgentActivityEffectReconciler } from './graph/agentActivityEffects';
import {
	initializeGraphView,
	type GraphViewWorkspaceSnapshot,
} from './graph/graphView';
import { resolveGraphVisibleArea } from './graph/graphVisibleArea';
import {
	haveSameWorkspaceRoots,
	mergeWorkspaceStateForRootTransition,
} from './workspaceRootTransition';
import { initializePanelCollapse } from './panel/panelCollapse';
import { initializePanelDock } from './panel/panelDock';
import { applyPanelSize, initializePanelResize } from './panel/panelResize';

import {
	restoreWebviewState,
	saveWebviewState,
	type WebviewSessionState,
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

/** HTML attribute로 전달된 canonical Workspace snapshot을 안전하게 복원한다. */
function parseSerializedWorkspaceState(
	serializedState: string | undefined,
): WorkspacePersistentState {
	if (!serializedState) {
		return createDefaultWorkspacePersistentState();
	}
	try {
		return parseWorkspacePersistentState(JSON.parse(
			decodeURIComponent(serializedState),
		)) ?? createDefaultWorkspacePersistentState();
	} catch {
		return createDefaultWorkspacePersistentState();
	}
}

function parseWorkspaceContextGeneration(value: string | null): number {
	if (value === null || value.trim() === '') {
		return 0;
	}
	const parsed = Number(value);

	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

const vscodeApi = acquireVsCodeApi();
const currentScript = document.currentScript;
const serializedInitialState = currentScript?.getAttribute('data-webview-state')
	?? undefined;
const serializedWorkspaceState = currentScript?.getAttribute('data-workspace-state')
	?? undefined;
const serializedWorkspaceContextGeneration = currentScript?.getAttribute(
	'data-workspace-context-generation',
) ?? null;
const app = getRequiredElement<HTMLElement>('#app');
const serializedWorkspacePresentation = app.getAttribute(
	'data-workspace-presentation',
) ?? undefined;
const initialState = restoreWebviewState(vscodeApi, serializedInitialState);
let workspacePresentation = deserializeWorkspacePresentationFromWebview(
	serializedWorkspacePresentation,
);
const initialWorkspaceState = parseSerializedWorkspaceState(
	serializedWorkspaceState,
);
const initialWorkspaceRootIds = parseWorkspaceRootIds(getWorkspaceGraphRootIds(
	workspacePresentation.graph,
));
if (
	!initialWorkspaceRootIds
	|| !haveSameWorkspaceRoots(
		initialWorkspaceRootIds,
		workspacePresentation.rootCatalog.map(({ id }) => id),
	)
) {
	throw new Error('Invalid initial Workspace root context');
}
let currentWorkspaceRootIds = initialWorkspaceRootIds;
let currentWorkspaceContextGeneration = parseWorkspaceContextGeneration(
	serializedWorkspaceContextGeneration,
);
let lastIssuedSwitchAttemptId = 0;
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

/** Agent Activity는 Webview runtime에만 존재하며 Graph/Session 영속 상태에 포함하지 않는다. */
const agentActivityStore = createAgentActivityStore();
/** 탭과 Graph가 같은 세션을 같은 색으로 표시하도록 Webview 단위 할당을 공유한다. */
const agentSessionColors = createAgentSessionColorRegistry();
/** 세션 제목과 현재 PTY 메시지도 민감한 runtime 표시 상태로만 유지한다. */
const agentSessionPresentationStore = createAgentSessionPresentationStore(
	agentSessionColors.resolve,
);
const graphView = initializeGraphView(
	graphArea,
	initialState.graph,
	workspacePresentation.graph,
	{
		onFileOpenRequest: (fileId) => {
			vscodeApi.postMessage({
				type: 'workspace.openFile',
				fileId,
			});
		},
		onTaskJsonCopyRequest: (json) => {
			vscodeApi.postMessage({
				type: 'task.copyJson',
				json,
			});
		},
		onTaskJsonCopyFailure: (reason) => {
			vscodeApi.postMessage({
				type: 'task.copyJsonFailed',
				reason,
			});
		},
		resolveVisibleGraphArea: (viewport) => resolveGraphVisibleArea(
			viewport,
			chatPanel,
			panelState.preferredDock,
		),
	},
	initialWorkspaceState.tasks.map((record) => record.task),
	initialWorkspaceState.tasks,
	{ agentActivityStore, agentSessionPresentationStore },
);

const agentActivityEffects = createAgentActivityEffectReconciler(
	agentActivityStore,
	graphView.createNodeEffectOwner(),
	agentSessionPresentationStore,
);

let agentPanelUi: AgentPanelUiController | undefined;
let agentSessionPresentationCoordinator: ReturnType<
	typeof createAgentSessionPresentationCoordinator
> | undefined;

/** 탭마다 독립적인 xterm과 세션 소유 관계를 유지하는 Terminal 표면 모음이다. */
const terminalPool = createDefaultAgentTerminalPool(
	terminalArea,
	(message) => vscodeApi.postMessage(message),
	{
		isEligible: (tabId, sessionId) =>
			agentPanelUi?.model.canAttemptAutomaticTitle(tabId, sessionId) ?? false,
		onCandidate: ({ tabId, sessionId, candidates }) => {
			agentPanelUi?.model.applyAutomaticTitleCandidates(
				tabId,
				sessionId,
				candidates,
			);
		},
	},
	{
		onOutputPreview: ({ tabId, sessionId, message }) => {
			agentSessionPresentationStore.updateCurrentMessage(
				tabId,
				sessionId,
				message,
			);
		},
	},
);

/** 현재 Panel과 Camera를 Webview Session snapshot으로 복사한다. */
const getCurrentWebviewSessionState = (): WebviewSessionState => ({
	panel: {
		preferredDock: panelState.preferredDock,
		sideSize: panelState.sideSize,
		verticalSize: panelState.verticalSize,
		collapsed: panelState.collapsed,
	},
	camera: { ...graphView.state.getState().camera },
});

/** VS Code Webview Session state와 Extension Host snapshot을 함께 갱신한다. */
const persistWebviewSessionState = () => {
	const state = getCurrentWebviewSessionState();

	saveWebviewState(vscodeApi, state);
	vscodeApi.postMessage({
		type: 'webview.stateChanged',
		state,
	});
};

/** Runtime Graph State의 Workspace 소유 필드를 현재 version snapshot으로 복사한다. */
const createWorkspacePersistentState = (
	snapshot: GraphViewWorkspaceSnapshot,
): WorkspacePersistentState => ({
	version: WORKSPACE_PERSISTENT_STATE_VERSION,
	nodePositions: Object.fromEntries(
		Object.entries(snapshot.graph.nodePositions).map(([id, position]) => [
			id,
			{ x: position.x, y: position.y },
		]),
	),
	fileGroupPages: { ...snapshot.graph.fileGroupPages },
	openedFolders: { ...snapshot.graph.openedFolders },
	detachedRootNodeIds: { ...snapshot.graph.detachedRootNodeIds },
	hiddenNodeIds: { ...snapshot.graph.hiddenNodeIds },
	tasks: snapshot.tasks,
	taskRelocations: [],
	taskStorageReceipts: [],
});

/**
 * Agent UI 동작을 Host protocol로 연결하며, 전송 실패가 Graph, Dock, Layout이나
 * 다른 탭 Terminal로 전파되지 않도록 이 경계 안에서 격리한다.
 */
const postAgentMessage = (message: WebviewToExtensionMessage): boolean => {
	try {
		vscodeApi.postMessage(message);
		return true;
	} catch {
		/** Host 전송 실패가 나머지 Webview 기능으로 전파되지 않게 한다. */
		return false;
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

try {
	agentPanelUi = initializeAgentPanelUi(
		{
			topBar: getRequiredElement<HTMLElement>('#agent-top-bar'),
			tabStrip: getRequiredElement<HTMLElement>('#agent-tab-strip'),
			tabMenuHost: getRequiredElement<HTMLElement>('#agent-tab-menu-host'),
			providerPicker: getRequiredElement<HTMLElement>(
				'#agent-provider-picker-host',
			),
			workspaceStatusBar: getRequiredElement<HTMLElement>(
				'#agent-workspace-status-bar',
			),
			dialogHost: getRequiredElement<HTMLElement>('#agent-dialog-host'),
			renameDialogHost: getRequiredElement<HTMLElement>(
				'#agent-rename-dialog-host',
			),
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

			onProviderSelected(tabId, providerId, workspaceRootId) {
				lastIssuedSwitchAttemptId += 1;
				const posted = postAgentMessage({
					type: 'agent.switch',
					tabId,
					providerId,
					workspaceRootId,
					switchAttemptId: lastIssuedSwitchAttemptId,
				});
				return posted ? lastIssuedSwitchAttemptId : false;
			},

			onAgentReselectionRequested(tabId): boolean {
				if (!postAgentMessage({ type: 'agent.reset', tabId })) {
					return false;
				}
				agentSessionPresentationCoordinator?.endTabSession(tabId);
				/** Reset 요청과 동시에 이전 xterm input을 끊고 logical commit을 기다린다. */
				terminalPool.resetTab(tabId);
				return true;
			},

			onMcpRestartRequested(tabId, sessionId): boolean {
				return postAgentMessage({ type: 'mcp.restart', tabId, sessionId });
			},

			onTabClosed(tabId): void {
				postAgentMessage({ type: 'tab.close', tabId });
				agentSessionPresentationCoordinator?.endTabSession(tabId);
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
		undefined,
		{
			initialWorkspaceRootCatalog: workspacePresentation.rootCatalog,
			resolveSessionColor: agentSessionColors.resolve,
		},
	);
} catch {
	agentPanelUi = undefined;
}

if (agentPanelUi !== undefined) {
	agentSessionPresentationCoordinator = createAgentSessionPresentationCoordinator(
		agentPanelUi.model,
		agentSessionPresentationStore,
		agentActivityStore,
	);
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
	() => {
		persistWebviewSessionState();
	},
	() => terminalPool.scheduleActiveTerminalFit(),
	() => {
		/** Chat의 실제 transform 경계를 따라 Overlay를 같은 frame에 이동시킨다. */
		graphView.refreshVisibleGraphArea();
	},
);
/** Dock 초기화 */
const refreshDock = initializePanelDock(
	layout,
	dragHandle,
	dockPreview,
	panelState,
	persistWebviewSessionState,
	() => {
		/** Dock이 바뀌면 새 방향 기준으로 표시 크기와 Sticker 위치를 다시 맞춘다. */
		applyPanelSize(layout, panelState);
		refreshCollapse();
		graphView.refreshVisibleGraphArea();
		terminalPool.scheduleActiveTerminalFit();
	},
);
/** Resize 초기화 */
initializePanelResize(
	layout,
	resizeHandle,
	panelState,
	() => {
		refreshDock();
		graphView.refreshVisibleGraphArea();
	},
	persistWebviewSessionState,
	() => terminalPool.scheduleActiveTerminalFit(),
);

/** 초기 Dock/크기/접힘 상태가 DOM에 모두 반영된 뒤 Overlay 기준을 한 번 확정한다. */
graphView.refreshVisibleGraphArea();

/** 숨겨졌던 Webview가 돌아오면 transient 0 bounds를 버리고 현재 Layout으로 재측정한다. */
const handleWebviewVisibilityChange = () => {
	if (document.visibilityState !== 'visible') {
		return;
	}

	applyPanelSize(layout, panelState);
	refreshDock();
	refreshCollapse();
	graphView.refreshVisibleGraphArea();
	terminalPool.scheduleActiveTerminalFit();
};

document.addEventListener('visibilitychange', handleWebviewVisibilityChange);

let previousGraphState = graphView.state.getState();
const unsubscribeGraphState = graphView.state.subscribe((currentGraphState) => {
	const previousState = previousGraphState;
	previousGraphState = currentGraphState;

	if (
		previousState.camera.x !== currentGraphState.camera.x
		|| previousState.camera.y !== currentGraphState.camera.y
		|| previousState.camera.scale !== currentGraphState.camera.scale
	) {
		persistWebviewSessionState();
	}

});
const postWorkspaceSnapshot = (snapshot: GraphViewWorkspaceSnapshot): void => {
	vscodeApi.postMessage({
		type: 'workspace.stateChanged',
		contextGeneration: currentWorkspaceContextGeneration,
		rootIds: currentWorkspaceRootIds,
		state: createWorkspacePersistentState(snapshot),
	});
};
const unsubscribeWorkspaceSnapshot = graphView.subscribeWorkspaceSnapshot(
	postWorkspaceSnapshot,
);
const normalizedInitialWorkspaceState = createWorkspacePersistentState(
	graphView.getWorkspaceSnapshot(),
);

// 초기 Root 집합에서 접근할 수 없는 foreign target이 정리된 경우에도 별도
// 사용자 편집을 기다리지 않고 정리된 canonical snapshot을 disk에 반영한다.
if (
	JSON.stringify(normalizedInitialWorkspaceState)
	!== JSON.stringify({
		...initialWorkspaceState,
		// receipt는 Host가 보존하는 metadata이므로 Webview 정리 여부 비교에서 제외한다.
		taskStorageReceipts: [],
	})
) {
	postWorkspaceSnapshot(graphView.getWorkspaceSnapshot());
}

window.addEventListener('unload', () => {
	document.removeEventListener('visibilitychange', handleWebviewVisibilityChange);
	unsubscribeGraphState();
	unsubscribeWorkspaceSnapshot();
	agentActivityEffects.dispose();
	graphView.dispose();
	if (agentSessionPresentationCoordinator === undefined) {
		agentSessionPresentationStore.dispose();
	} else {
		agentSessionPresentationCoordinator.dispose();
	}
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
	const graphEffectMessage = parseGraphNodeEffectToWebviewMessage(message);

	if (graphEffectMessage) {
		if (graphEffectMessage.type === 'graph.nodeEffect.set') {
			graphView.setNodeEffect(
				graphEffectMessage.target,
				graphEffectMessage.effect,
			);
		} else {
			graphView.clearNodeEffect(
				graphEffectMessage.target,
				graphEffectMessage.kind,
			);
		}
		return;
	}

	const trackedClearMessage = parseAgentActivityTrackedClearMessage(message);
	if (trackedClearMessage) {
		applyAgentActivityClear(trackedClearMessage.publicMessage);
		vscodeApi.postMessage({
			type: 'agent.activity.clearApplied',
			receiptId: trackedClearMessage.receiptId,
		});
		return;
	}

	const agentActivityMessage = parseAgentActivityToWebviewMessage(message);

	if (agentActivityMessage) {
		if (agentActivityMessage.type === 'agent.activity.set') {
			ensureDebugAgentSession(
				agentActivityMessage.sessionId,
				agentActivityMessage.activity,
			);
			if (
				agentSessionPresentationStore.isKnownSession(
					agentActivityMessage.sessionId,
				)
			) {
				agentActivityStore.setAgentActivity(
					agentActivityMessage.sessionId,
					agentActivityMessage.target,
					agentActivityMessage.activity,
				);
			}
		} else {
			applyAgentActivityClear(agentActivityMessage);
		}
		return;
	}

	const workspaceMessage = parseWorkspaceToWebviewMessage(message);

	if (workspaceMessage) {
		if (workspaceMessage.contextGeneration < currentWorkspaceContextGeneration) {
			return;
		}
		const rootContextChanged = workspaceMessage.contextGeneration
			!== currentWorkspaceContextGeneration;
		const rootIdsChanged = !haveSameWorkspaceRoots(
			currentWorkspaceRootIds,
			workspaceMessage.rootIds,
		);

		if (!rootContextChanged && rootIdsChanged) {
			return;
		}

		if (workspaceMessage.state) {
			const currentWorkspaceState = createWorkspacePersistentState(
				graphView.getWorkspaceSnapshot(),
			);
			const workspaceState = rootContextChanged
					? mergeWorkspaceStateForRootTransition(
						currentWorkspaceState,
						workspaceMessage.state,
						currentWorkspaceRootIds,
						workspaceMessage.rootIds,
					)
					: workspaceMessage.state;

			// updateWorkspace의 final subscriber가 새 epoch로 응답하도록 먼저 바꾼다.
			currentWorkspaceRootIds = [...workspaceMessage.rootIds];
			currentWorkspaceContextGeneration = workspaceMessage.contextGeneration;
			workspacePresentation = workspaceMessage.presentation;
			graphView.updateWorkspace(
				workspaceMessage.presentation.graph,
				{
					graph: {
						nodePositions: workspaceState.nodePositions,
						fileGroupPages: workspaceState.fileGroupPages,
						openedFolders: workspaceState.openedFolders,
						detachedRootNodeIds:
							workspaceState.detachedRootNodeIds,
						hiddenNodeIds: workspaceState.hiddenNodeIds,
					},
					tasks: workspaceState.tasks,
				},
			);
			agentPanelUi?.updateWorkspaceRootCatalog(
				workspaceMessage.presentation.rootCatalog,
			);
		} else {
			if (rootContextChanged) {
				return;
			}
			currentWorkspaceRootIds = [...workspaceMessage.rootIds];
			workspacePresentation = workspaceMessage.presentation;
			graphView.updateGraph(workspaceMessage.presentation.graph);
			agentPanelUi?.updateWorkspaceRootCatalog(
				workspaceMessage.presentation.rootCatalog,
			);
		}
		return;
	}

	const parseResult = parseHostToWebviewMessage(message);
	if (!parseResult.ok) {
		return;
	}

	switch (parseResult.value.type) {
		case 'extension.ready':
			console.log('[Crispy] Extension ready');
			break;
		default: {
			const shouldForwardToTerminal =
				agentPanelUi?.handleHostMessage(parseResult.value) ?? true;
			if (shouldForwardToTerminal) {
				agentSessionPresentationCoordinator?.handleHostMessage(parseResult.value);
				terminalPool.handleHostMessage(parseResult.value);
			}
			break;
		}
	}
}

/** Public/tracked clear가 같은 synchronous Store 적용 경계를 공유한다. */
function applyAgentActivityClear(
	message: AgentActivityClearMessage | AgentActivityClearSessionMessage,
): void {
	if (message.type === 'agent.activity.clear') {
		agentActivityStore.clearAgentActivity(message.sessionId, message.target);
		cleanupDebugAgentSession(message.sessionId, agentSessionPresentationStore);
		return;
	}

	agentActivityStore.clearAgentActivitiesBySession(message.sessionId);
	cleanupDebugAgentSession(message.sessionId, agentSessionPresentationStore);
}

function ensureDebugAgentSession(sessionId: string, activity: string): void {
	if (!sessionId.startsWith('debug-g12-')) {
		return;
	}
	const tabId = `debug-tab:${sessionId}`;

	if (!agentSessionPresentationStore.isKnownSession(sessionId)) {
		agentSessionPresentationStore.startSession(tabId, sessionId, 'Activity Debug');
		agentSessionPresentationStore.activateSession(tabId, sessionId, 'Activity Debug');
	}
	agentSessionPresentationStore.updateCurrentMessage(
		tabId,
		sessionId,
		`Sample activity: ${activity}`,
	);
}

function cleanupDebugAgentSession(
	sessionId: string,
	presentationStore: AgentSessionPresentationStore,
): void {
	if (!sessionId.startsWith('debug-g12-')) {
		return;
	}
	const stillHasActivity = agentActivityStore.getSnapshot().some(({ activities }) => (
		activities.some((activity) => activity.sessionId === sessionId)
	));
	if (!stillHasActivity) {
		presentationStore.endSession(sessionId);
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
