import * as assert from 'assert';
import { createAgentTabModel } from '../agent/UI/agentTabModel';
import type { AgentPanelUiCallbacks } from '../agent/UI/agentPanelUi';
import type {
	AgentActivityKind,
	GraphNodeEffect,
	GraphNodeEffectKind,
	GraphNodeEffectTarget,
	WebviewToExtensionMessage,
} from '../messages';
import {
	createGraphState,
	INITIAL_GRAPH_STATE,
	type GraphStateSnapshot,
} from '../webview/graph/graphState';
import type { Graph } from '../webview/graph/graphModel';
import type { GraphViewWorkspaceSnapshot } from '../webview/graph/graphView';
import { createDefaultTaskBlueprint } from '../task';
import type { WorkspaceTaskRecord } from '../task/workspaceTaskState';
import {
	WORKSPACE_PERSISTENT_STATE_VERSION,
	type WorkspacePersistentState,
} from '../workspace/workspaceMetadata';
import { serializeWorkspacePresentationForWebview } from '../workspace/workspacePresentation';
import { DEFAULT_PANEL_LAYOUT_STATE } from '../webview/panel/panelState';
import type { PanelLayoutState } from '../webview/panel/panelState';
import {
	createDefaultWebviewSessionState,
	parseWebviewSessionState,
	parseWebviewState,
	restoreWebviewState,
	saveWebviewState,
	serializeWebviewState,
	type PersistedWebviewState,
	type WebviewSessionState,
	type WebviewStateApi,
} from '../webview/webviewState';

suite('Webview Session State', () => {
	test('유효한 Session 상태를 파싱한다', () => {
		assert.deepStrictEqual(parseWebviewSessionState({
			panel: {
				preferredDock: 'left',
				sideSize: 380,
				verticalSize: 280,
				collapsed: true,
			},
			camera: { x: 120, y: -40, scale: 1.5 },
		}), {
			panel: {
				preferredDock: 'left',
				sideSize: 380,
				verticalSize: 280,
				collapsed: true,
			},
			camera: { x: 120, y: -40, scale: 1.5 },
		});
	});

	test('새 기본 Session 상태를 생성한다', () => {
		const first = createDefaultWebviewSessionState();
		const second = createDefaultWebviewSessionState();

		assert.deepStrictEqual(first, {
			panel: DEFAULT_PANEL_LAYOUT_STATE,
			camera: INITIAL_GRAPH_STATE.camera,
		});
		assert.notStrictEqual(first, second);
		assert.notStrictEqual(first.panel, second.panel);
		assert.notStrictEqual(first.camera, second.camera);
	});

	test('잘못된 Panel 상태를 거부한다', () => {
		assert.strictEqual(parseWebviewSessionState({
			panel: { ...DEFAULT_PANEL_LAYOUT_STATE, sideSize: 0 },
			camera: INITIAL_GRAPH_STATE.camera,
		}), undefined);
	});

	test('잘못된 Camera 상태를 거부한다', () => {
		assert.strictEqual(parseWebviewSessionState({
			panel: DEFAULT_PANEL_LAYOUT_STATE,
			camera: { x: 0, y: 0, scale: 10 },
		}), undefined);
	});

	test('입력 객체와 mutation을 공유하지 않는다', () => {
		const input = {
			panel: {
				preferredDock: 'right',
				sideSize: 420,
				verticalSize: 300,
				collapsed: false,
			} as const,
			camera: { x: 10, y: 20, scale: 2 },
		};
		const state = parseWebviewSessionState(input);

		assert.ok(state);
		input.camera.x = 999;

		assert.strictEqual(state.camera.x, 10);
		assert.notStrictEqual(state.panel, input.panel);
		assert.notStrictEqual(state.camera, input.camera);
	});
});

suite('Webview State', () => {
	test('저장 상태가 없으면 Panel 및 Graph 기본 상태를 새 snapshot으로 복원한다', () => {
		const state = restoreWebviewState(createStateApi(undefined));

		assert.deepStrictEqual(state, {
			panel: DEFAULT_PANEL_LAYOUT_STATE,
			graph: INITIAL_GRAPH_STATE,
		});
		assert.notStrictEqual(state.panel, DEFAULT_PANEL_LAYOUT_STATE);
		assert.notStrictEqual(state.graph, INITIAL_GRAPH_STATE);
		assert.notStrictEqual(state.graph.camera, INITIAL_GRAPH_STATE.camera);
		assert.notStrictEqual(state.graph.nodePositions, INITIAL_GRAPH_STATE.nodePositions);
		assert.notStrictEqual(
			state.graph.fileGroupPages,
			INITIAL_GRAPH_STATE.fileGroupPages,
		);
		assert.notStrictEqual(
			state.graph.openedFolders,
			INITIAL_GRAPH_STATE.openedFolders,
		);
		assert.notStrictEqual(
			state.graph.detachedRootNodeIds,
			INITIAL_GRAPH_STATE.detachedRootNodeIds,
		);
		assert.notStrictEqual(
			state.graph.hiddenNodeIds,
			INITIAL_GRAPH_STATE.hiddenNodeIds,
		);
	});

	test('이전 전체 getState에서는 Session만 복원하고 Host Workspace 상태를 유지한다', () => {
		const savedState = createWebviewState('left', 40, -30, 1.5);
		const htmlState = createWebviewState('bottom', 100, 200, 2);

		const state = restoreWebviewState(
			createStateApi(savedState),
			serializeWebviewState(htmlState),
		);

		assert.deepStrictEqual(state, {
			panel: savedState.panel,
			graph: {
				...htmlState.graph,
				camera: savedState.graph.camera,
			},
		});
		assert.notStrictEqual(state, savedState);
		assert.notStrictEqual(state.panel, savedState.panel);
		assert.notStrictEqual(state.graph, savedState.graph);
		assert.notStrictEqual(state.graph.camera, savedState.graph.camera);
		assert.notStrictEqual(
			state.graph.nodePositions,
			htmlState.graph.nodePositions,
		);
		assert.notStrictEqual(
			state.graph.fileGroupPages,
			htmlState.graph.fileGroupPages,
		);
		assert.notStrictEqual(
			state.graph.openedFolders,
			htmlState.graph.openedFolders,
		);
		assert.notStrictEqual(
			state.graph.detachedRootNodeIds,
			htmlState.graph.detachedRootNodeIds,
		);
		assert.notStrictEqual(
			state.graph.hiddenNodeIds,
			htmlState.graph.hiddenNodeIds,
		);
	});

	test('getState가 없으면 HTML의 data-webview-state를 복원한다', () => {
		const initialState = createWebviewState('top', -90, 70, 0.75);

		const state = restoreWebviewState(
			createStateApi(undefined),
			serializeWebviewState(initialState),
		);

		assert.deepStrictEqual(state, initialState);
		assert.notStrictEqual(state.panel, initialState.panel);
		assert.notStrictEqual(state.graph.camera, initialState.graph.camera);
		assert.notStrictEqual(
			state.graph.nodePositions,
			initialState.graph.nodePositions,
		);
		assert.notStrictEqual(
			state.graph.fileGroupPages,
			initialState.graph.fileGroupPages,
		);
		assert.notStrictEqual(
			state.graph.openedFolders,
			initialState.graph.openedFolders,
		);
		assert.notStrictEqual(
			state.graph.detachedRootNodeIds,
			initialState.graph.detachedRootNodeIds,
		);
		assert.notStrictEqual(
			state.graph.hiddenNodeIds,
			initialState.graph.hiddenNodeIds,
		);
	});

	test('Panel 접힘 상태를 저장하고 복원한다', () => {
		const collapsedState = createWebviewState('bottom', 12, 24, 1, true);

		const restored = restoreWebviewState(createStateApi(collapsedState));

		assert.strictEqual(restored.panel.collapsed, true);
		assert.deepStrictEqual(restored.panel, collapsedState.panel);
		assert.notStrictEqual(restored.panel, collapsedState.panel);
	});

	test('이전 저장 상태에 collapsed가 없어도 Dock과 크기를 유지해 복원한다', () => {
		const previousState = {
			panel: {
				preferredDock: 'left',
				sideSize: 360,
				verticalSize: 300,
			},
			graph: INITIAL_GRAPH_STATE,
		};

		const restored = restoreWebviewState(createStateApi(previousState));

		assert.deepStrictEqual(restored.panel, {
			preferredDock: 'left',
			sideSize: 360,
			verticalSize: 300,
			collapsed: false,
		});
		assert.deepStrictEqual(restored.graph, INITIAL_GRAPH_STATE);
	});

	test('이전 저장 상태에 부가 Graph 필드가 없어도 빈 상태로 호환 복원한다', () => {
		const previousState = {
			panel: DEFAULT_PANEL_LAYOUT_STATE,
			graph: {
				camera: { x: 10, y: 20, scale: 1 },
				nodePositions: {},
			},
		};

		const restored = restoreWebviewState(createStateApi(previousState));

		assert.deepStrictEqual(restored.graph.fileGroupPages, {});
		assert.deepStrictEqual(restored.graph.openedFolders, {});
		assert.deepStrictEqual(restored.graph.detachedRootNodeIds, {});
		assert.deepStrictEqual(restored.graph.hiddenNodeIds, {});
		assert.strictEqual(createGraphState(restored.graph).getFileGroupPage('missing'), 1);
		assert.strictEqual(
			createGraphState(restored.graph).isFolderOpened('folder:missing'),
			false,
		);
	});

	test('잘못된 저장 상태와 HTML 상태는 안전하게 기본값으로 처리한다', () => {
		const invalidStates: unknown[] = [
			null,
			{},
			{
				panel: DEFAULT_PANEL_LAYOUT_STATE,
				graph: { camera: { x: 0, y: 0, scale: Number.NaN } },
			},
			{
				panel: { ...DEFAULT_PANEL_LAYOUT_STATE, sideSize: -1 },
				graph: INITIAL_GRAPH_STATE,
			},
		];

		for (const invalidState of invalidStates) {
			assert.deepStrictEqual(
				restoreWebviewState(createStateApi(invalidState), '%invalid-json'),
				{
					panel: DEFAULT_PANEL_LAYOUT_STATE,
					graph: INITIAL_GRAPH_STATE,
				},
			);
			assert.strictEqual(parseWebviewState(invalidState), undefined);
		}
	});

	test('잘못된 getState 대신 유효한 HTML 초기 상태를 사용한다', () => {
		const initialState = createWebviewState('bottom', 25, 35, 2.5);

		assert.deepStrictEqual(
			restoreWebviewState(
				createStateApi({ panel: null, graph: null }),
				serializeWebviewState(initialState),
			),
			initialState,
		);
	});

	test('저장 시 Panel과 Camera만 독립적인 Session snapshot으로 setState에 전달한다', () => {
		let savedState: WebviewSessionState | undefined;
		const api: WebviewStateApi = {
			getState: () => undefined,
			setState: (state) => {
				savedState = state;
			},
		};
		const state: WebviewSessionState = {
			panel: {
				preferredDock: 'right',
				sideSize: 440,
				verticalSize: 260,
				collapsed: false,
			},
			camera: { x: 120, y: -60, scale: 3 },
		};

		saveWebviewState(api, state);

		assert.deepStrictEqual(savedState, state);
		assert.notStrictEqual(savedState, state);
		assert.notStrictEqual(savedState?.panel, state.panel);
		assert.notStrictEqual(savedState?.camera, state.camera);
		assert.deepStrictEqual(Object.keys(savedState ?? {}), ['panel', 'camera']);
		assert.strictEqual(Object.hasOwn(savedState ?? {}, 'nodePositions'), false);
		assert.strictEqual(Object.hasOwn(savedState ?? {}, 'fileGroupPages'), false);
		assert.strictEqual(Object.hasOwn(savedState ?? {}, 'openedFolders'), false);
		assert.strictEqual(
			Object.hasOwn(savedState ?? {}, 'detachedRootNodeIds'),
			false,
		);
		assert.strictEqual(Object.hasOwn(savedState ?? {}, 'hiddenNodeIds'), false);
	});

	test('Session Camera는 setState에서 복원하고 Workspace 필드는 Host 초기 상태를 유지한다', () => {
		let savedState: WebviewSessionState | undefined;
		const api: WebviewStateApi = {
			getState: () => savedState,
			setState: (state) => {
				savedState = state;
			},
		};
		const hostInitialState = createWebviewState('left', 10, 20, 1);
		hostInitialState.graph.nodePositions = {
			'folder:app': { x: 720, y: 180 },
		};
		hostInitialState.graph.fileGroupPages = { 'folder:app:files': 3 };
		hostInitialState.graph.openedFolders = { 'folder:app': true };
		hostInitialState.graph.detachedRootNodeIds = { 'folder:app': true };
		hostInitialState.graph.hiddenNodeIds = { 'folder:app/private': true };
		const sessionState: WebviewSessionState = {
			panel: {
				...hostInitialState.panel,
				preferredDock: 'bottom',
			},
			camera: { x: 513, y: 324, scale: 1.2 },
		};

		saveWebviewState(api, sessionState);

		assert.deepStrictEqual(api.getState(), sessionState);
		const restoredState = restoreWebviewState(
			api,
			serializeWebviewState(hostInitialState),
		);

		assert.deepStrictEqual(restoredState.panel, sessionState.panel);
		assert.deepStrictEqual(restoredState.graph.camera, sessionState.camera);
		assert.deepStrictEqual(
			restoredState.graph.nodePositions,
			hostInitialState.graph.nodePositions,
		);
		assert.deepStrictEqual(
			restoredState.graph.fileGroupPages,
			hostInitialState.graph.fileGroupPages,
		);
		assert.deepStrictEqual(
			restoredState.graph.openedFolders,
			hostInitialState.graph.openedFolders,
		);
		assert.deepStrictEqual(
			restoredState.graph.detachedRootNodeIds,
			hostInitialState.graph.detachedRootNodeIds,
		);
		assert.deepStrictEqual(
			restoredState.graph.hiddenNodeIds,
			hostInitialState.graph.hiddenNodeIds,
		);
	});

	test('serialize 후 restore해도 Workspace Graph 상태를 유지한다', () => {
		const state = createWebviewState('right', 10, -20, 1.25);
		state.graph.fileGroupPages = {
			'folder:src:files': 4,
			'folder:test:files': 2,
		};
		state.graph.openedFolders = {
			'folder:src': true,
			'folder:test': true,
		};
		state.graph.detachedRootNodeIds = {
			'folder:src': true,
			'file:test/index.ts': true,
		};
		state.graph.hiddenNodeIds = {
			'folder:src/private': true,
			'file:test/secret.ts': true,
		};

		const restored = restoreWebviewState(
			createStateApi(undefined),
			serializeWebviewState(state),
		);

		assert.deepStrictEqual(restored.graph.fileGroupPages, {
			'folder:src:files': 4,
			'folder:test:files': 2,
		});
		assert.deepStrictEqual(restored.graph.openedFolders, {
			'folder:src': true,
			'folder:test': true,
		});
		assert.deepStrictEqual(restored.graph.detachedRootNodeIds, {
			'folder:src': true,
			'file:test/index.ts': true,
		});
		assert.deepStrictEqual(restored.graph.hiddenNodeIds, {
			'folder:src/private': true,
			'file:test/secret.ts': true,
		});
	});

});

suite('Webview State Wiring', () => {
	test('Graph, Workspace 메시지, Panel, Agent와 Terminal wiring을 전체 Webview lifecycle에 연결한다', () => {
		const initialState = createWebviewState('left', 35, -25, 1.25);
		const initialWorkspaceGraph: Graph = {
			roots: [
				{ id: 'root:app', nodeId: 'workspace-root:project:app' },
				{ id: 'root:api', nodeId: 'workspace-root:project:api' },
			],
			rootNodes: {
				'workspace-root:project:app': {
					kind: 'project',
					id: 'workspace-root:project:app',
					name: 'app',
					status: 'loaded',
					children: [{
						kind: 'file',
						id: 'file:app/index.ts',
						name: 'index.ts',
					}],
				},
				'workspace-root:project:api': {
					kind: 'project',
					id: 'workspace-root:project:api',
					name: 'api',
					status: 'loaded',
					children: [],
				},
			},
		};
		const initialWorkspaceRootCatalog = [
			{
				id: 'workspace-root:project:app' as const,
				name: 'app',
				description: 'file:///workspace/app',
				selectable: true as const,
			},
			{
				id: 'workspace-root:project:api' as const,
				name: 'api',
				description: 'file:///workspace/api',
				selectable: true as const,
			},
		];
		const refreshedWorkspaceGraph: Graph = {
			roots: [
				{
					id: 'root:refreshed',
					nodeId: 'workspace-root:project:refreshed',
				},
				{
					id: 'root:sibling',
					nodeId: 'workspace-root:file:///workspace/sibling',
				},
			],
			rootNodes: {
				'workspace-root:project:refreshed': {
					kind: 'project',
					id: 'workspace-root:project:refreshed',
					name: 'refreshed',
					status: 'loaded',
					children: [],
				},
				'workspace-root:file:///workspace/sibling': {
					kind: 'project',
					id: 'workspace-root:file:///workspace/sibling',
					name: 'sibling',
					status: 'loaded',
					children: [],
				},
			},
		};
		const refreshedWorkspaceRootCatalog = [
			{
				id: 'workspace-root:project:refreshed' as const,
				name: 'refreshed',
				description: 'file:///workspace/refreshed',
				selectable: true as const,
			},
			{
				id: 'workspace-root:file:///workspace/sibling' as const,
				name: 'sibling',
				description: 'file:///workspace/sibling',
				selectable: true as const,
			},
		];
		let taskIdSequence = 0;
		const initialTask = createDefaultTaskBlueprint(
			{ title: 'Initial persisted Task' },
			() => `webview-initial-${++taskIdSequence}`,
		);
		const refreshedTask = createDefaultTaskBlueprint(
			{ title: 'Refreshed persisted Task' },
			() => `webview-refreshed-${++taskIdSequence}`,
		);
		const initialWorkspaceTasks: readonly WorkspaceTaskRecord[] = [{
			ownerRootId: 'workspace-root:project:app',
			storageRevision: 1,
			task: initialTask,
			targetOrigins: [],
		}];
		const refreshedWorkspaceTasks: readonly WorkspaceTaskRecord[] = [{
			ownerRootId: 'workspace-root:project:refreshed',
			storageRevision: 4,
			task: refreshedTask,
			targetOrigins: [],
		}];
		const initialWorkspaceState: WorkspacePersistentState = {
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
				tasks: initialWorkspaceTasks,
				taskRelocations: [],
				taskStorageReceipts: [],
		};
		const refreshedWorkspaceState: WorkspacePersistentState = {
			...initialWorkspaceState,
			tasks: refreshedWorkspaceTasks,
		};
		const agentTabId = 'agent-tab-test';
		const savedStates: WebviewSessionState[] = [];
		const postedMessages: WebviewToExtensionMessage[] = [];
		const ensuredTabs: string[] = [];
		const activeTabs: string[] = [];
		const graphUpdates: Graph[] = [];
		const workspaceUpdates: Array<{
			readonly graph: Graph;
			readonly snapshot: GraphViewWorkspaceSnapshot;
		}> = [];
		const graphEffectSets: Array<{
			readonly target: GraphNodeEffectTarget;
			readonly effect: GraphNodeEffect;
		}> = [];
		const graphEffectClears: Array<{
			readonly target: GraphNodeEffectTarget;
			readonly kind?: GraphNodeEffectKind;
		}> = [];
		const agentEffectSets: Array<{
			readonly target: GraphNodeEffectTarget;
			readonly effect: GraphNodeEffect;
		}> = [];
		const agentEffectClears: Array<{
			readonly target: GraphNodeEffectTarget;
			readonly kind?: GraphNodeEffectKind;
		}> = [];
		const agentActivitySets: Array<{
			readonly sessionId: string;
			readonly target: GraphNodeEffectTarget;
			readonly activity: AgentActivityKind;
		}> = [];
		const agentActivityClears: Array<{
			readonly sessionId: string;
			readonly target: GraphNodeEffectTarget;
		}> = [];
		const agentActivitySessionClears: string[] = [];
		const clearReceiptSnapshots: Array<{
			readonly receiptId: number;
			readonly targetClearCount: number;
			readonly sessionClearCount: number;
		}> = [];
		const terminalHostMessages: unknown[] = [];
		let currentGraphState: GraphStateSnapshot = {
			camera: initialState.graph.camera,
			nodePositions: initialState.graph.nodePositions,
			fileGroupPages: initialState.graph.fileGroupPages ?? {},
			openedFolders: initialState.graph.openedFolders ?? {},
			detachedRootNodeIds: initialState.graph.detachedRootNodeIds ?? {},
			hiddenNodeIds: initialState.graph.hiddenNodeIds ?? {},
		};
		let graphSubscriber: ((state: typeof currentGraphState) => void) | undefined;
		let workspaceSubscriber: ((
			snapshot: import('../webview/graph/graphView').GraphViewWorkspaceSnapshot,
		) => void) | undefined;
		let currentWorkspaceTasks = initialWorkspaceTasks;
		const getCurrentWorkspaceSnapshot = (): import(
			'../webview/graph/graphView'
		).GraphViewWorkspaceSnapshot => ({
			graph: {
				nodePositions: currentGraphState.nodePositions,
				fileGroupPages: currentGraphState.fileGroupPages,
				openedFolders: currentGraphState.openedFolders,
				detachedRootNodeIds: currentGraphState.detachedRootNodeIds,
				hiddenNodeIds: currentGraphState.hiddenNodeIds,
			},
			tasks: currentWorkspaceTasks,
		});
		const getCurrentWorkspacePersistentState = (): WorkspacePersistentState => ({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			nodePositions: currentGraphState.nodePositions,
			fileGroupPages: currentGraphState.fileGroupPages,
			openedFolders: currentGraphState.openedFolders,
			detachedRootNodeIds: currentGraphState.detachedRootNodeIds,
			hiddenNodeIds: currentGraphState.hiddenNodeIds,
				tasks: currentWorkspaceTasks,
				taskRelocations: [],
				taskStorageReceipts: [],
		});
		let panelState: PanelLayoutState | undefined;
		let persistPanelState: (() => void) | undefined;
		let dockFit: (() => void) | undefined;
		let persistCollapsedState: (() => void) | undefined;
		let collapseFit: (() => void) | undefined;
		let collapseRefreshCount = 0;
		let persistResizeState: (() => void) | undefined;
		let resizeRefresh: (() => void) | undefined;
		let resizeFit: (() => void) | undefined;
		let agentUiLayoutChange: (() => void) | undefined;
		let agentProviderSelect: AgentPanelUiCallbacks['onProviderSelected'];
		const agentWorkspaceCatalogUpdates: unknown[] = [];
		let initialAgentWorkspaceCatalog: unknown;
		let unloadHandler: (() => void) | undefined;
		let hostMessageHandler: ((event: MessageEvent) => void) | undefined;
		let graphInitializeCount = 0;
		let graphVisibleRefreshCount = 0;
		let graphViewInteractions:
			import('../webview/graph/graphView').GraphViewInteractions | undefined;
		let graphUnsubscribed = false;
		let workspaceUnsubscribed = false;
		let graphDisposed = false;
		let agentEffectOwnerDisposed = false;
		let agentPanelUiInitialized = false;
		let agentPanelUiDisposed = false;
		let terminalPoolDisposed = false;
		let terminalFitCount = 0;
		let graphAgentActivityStore: ReturnType<
			typeof import('../agent/webview/agentActivityStore').createAgentActivityStore
		> | undefined;
		let createdAgentActivityStore: typeof graphAgentActivityStore;

		const graphViewModulePath = require.resolve('../webview/graph/graphView');
		const panelDockModulePath = require.resolve('../webview/panel/panelDock');
		const panelResizeModulePath = require.resolve('../webview/panel/panelResize');
		const panelCollapseModulePath = require.resolve(
			'../webview/panel/panelCollapse',
		);
		const agentPanelUiModulePath = require.resolve('../agent/UI/agentPanelUi');
		const agentTerminalPoolModulePath = require.resolve(
			'../agent/webview/agentTerminalPool',
		);
		const agentActivityStoreModulePath = require.resolve(
			'../agent/webview/agentActivityStore',
		);
		const webviewModulePath = require.resolve('../webview/webview');
		const graphViewModule = require(graphViewModulePath) as GraphViewModule;
		const panelDockModule = require(panelDockModulePath) as PanelDockModule;
		const panelResizeModule = require(panelResizeModulePath) as PanelResizeModule;
		const panelCollapseModule = require(
			panelCollapseModulePath,
		) as PanelCollapseModule;
		const agentPanelUiModule = require(
			agentPanelUiModulePath,
		) as AgentPanelUiModule;
		const agentTerminalPoolModule = require(
			agentTerminalPoolModulePath,
		) as AgentTerminalPoolModule;
		const agentActivityStoreModule = require(
			agentActivityStoreModulePath,
		) as AgentActivityStoreModule;
		const originalInitializeGraphView = graphViewModule.initializeGraphView;
		const originalInitializePanelDock = panelDockModule.initializePanelDock;
		const originalInitializePanelResize = panelResizeModule.initializePanelResize;
		const originalInitializePanelCollapse =
			panelCollapseModule.initializePanelCollapse;
		const originalInitializeAgentPanelUi = agentPanelUiModule.initializeAgentPanelUi;
		const originalCreateDefaultAgentTerminalPool =
			agentTerminalPoolModule.createDefaultAgentTerminalPool;
		const originalCreateAgentActivityStore =
			agentActivityStoreModule.createAgentActivityStore;
		const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
		const originalAcquireVsCodeApi = Object.getOwnPropertyDescriptor(
			globalThis,
			'acquireVsCodeApi',
		);

		graphViewModule.initializeGraphView = ((
			_root,
			restoredGraphState,
			graph,
			interactions,
			_initialTasks,
			restoredWorkspaceTasks,
			options,
		) => {
			graphInitializeCount += 1;
			graphViewInteractions = interactions;
			graphAgentActivityStore = options?.agentActivityStore;
			assert.deepStrictEqual(restoredGraphState, initialState.graph);
			assert.deepStrictEqual(graph, initialWorkspaceGraph);
			assert.deepStrictEqual(restoredWorkspaceTasks, initialWorkspaceTasks);
			currentWorkspaceTasks = restoredWorkspaceTasks ?? [];
			const graphState = restoredGraphState ?? INITIAL_GRAPH_STATE;
			currentGraphState = {
				camera: { ...graphState.camera },
				nodePositions: { ...graphState.nodePositions },
				fileGroupPages: { ...graphState.fileGroupPages },
				openedFolders: { ...graphState.openedFolders },
				detachedRootNodeIds: { ...graphState.detachedRootNodeIds },
				hiddenNodeIds: { ...graphState.hiddenNodeIds },
			};

			return {
				state: {
					getState: () => currentGraphState,
					setState: (state) => {
					currentGraphState = {
						camera: { ...state.camera },
						nodePositions: { ...state.nodePositions },
						fileGroupPages: {
							...(state.fileGroupPages ?? currentGraphState.fileGroupPages),
						},
						openedFolders: {
							...(state.openedFolders
								?? currentGraphState.openedFolders),
						},
						detachedRootNodeIds: {
							...(state.detachedRootNodeIds
								?? currentGraphState.detachedRootNodeIds),
						},
						hiddenNodeIds: {
							...(state.hiddenNodeIds
								?? currentGraphState.hiddenNodeIds),
						},
					};
					},
					isFolderOpened: (folderId) => (
						currentGraphState.openedFolders[folderId] === true
					),
					toggleFolder: () => undefined,
					getFileGroupPage: (fileGroupId) => (
						currentGraphState.fileGroupPages[fileGroupId] ?? 1
					),
					showMoreFiles: () => undefined,
					collapseFileGroup: () => undefined,
					subscribe: (subscriber) => {
						graphSubscriber = subscriber;

						return () => {
							graphSubscriber = undefined;
							graphUnsubscribed = true;
						};
					},
				},
				camera: {} as ReturnType<
					typeof originalInitializeGraphView
				>['camera'],
				taskState: {} as ReturnType<
					typeof originalInitializeGraphView
				>['taskState'],
				getWorkspaceSnapshot: getCurrentWorkspaceSnapshot,
				subscribeWorkspaceSnapshot: (subscriber) => {
					workspaceSubscriber = subscriber;

					return () => {
						workspaceSubscriber = undefined;
						workspaceUnsubscribed = true;
					};
				},
				refreshVisibleGraphArea: () => {
					graphVisibleRefreshCount += 1;
				},
				updateGraph: (nextGraph) => {
					graphUpdates.push(nextGraph);
				},
				updateTasks: () => undefined,
				updateWorkspace: (nextGraph, snapshot) => {
					workspaceUpdates.push({ graph: nextGraph, snapshot });
					currentGraphState = {
						...currentGraphState,
						nodePositions: snapshot.graph.nodePositions,
						fileGroupPages: snapshot.graph.fileGroupPages,
						openedFolders: snapshot.graph.openedFolders,
						detachedRootNodeIds: snapshot.graph.detachedRootNodeIds,
						hiddenNodeIds: snapshot.graph.hiddenNodeIds,
					};
					currentWorkspaceTasks = snapshot.tasks;
				},
				setNodeEffect: (target, effect) => {
					graphEffectSets.push({ target, effect });
				},
				clearNodeEffect: (target, kind) => {
					graphEffectClears.push({ target, ...(kind ? { kind } : {}) });
				},
				createNodeEffectOwner: () => ({
					setNodeEffect(target, effect): void {
						agentEffectSets.push({ target, effect });
					},
					replaceNodeEffects(target, effects): void {
						for (const effect of effects) {
							agentEffectSets.push({ target, effect });
						}
					},
					clearNodeEffect(target, kind): void {
						agentEffectClears.push({
							target,
							...(kind ? { kind } : {}),
						});
					},
					dispose(): void {
						agentEffectOwnerDisposed = true;
					},
				}),
				dispose: () => {
					graphDisposed = true;
				},
			};
		}) as typeof graphViewModule.initializeGraphView;

		panelDockModule.initializePanelDock = ((
			_layout,
			_dragHandle,
			_dockPreview,
			state,
			onPreferredDockChange,
			onDockChange,
		) => {
			panelState = state;
			persistPanelState = onPreferredDockChange;
			dockFit = onDockChange;

			return () => undefined;
		}) as typeof panelDockModule.initializePanelDock;

		panelResizeModule.initializePanelResize = ((
			_layout,
			_resizeHandle,
			_state,
			onSizeChange,
			onResizeEnd,
			onLayoutResize,
		) => {
			resizeRefresh = onSizeChange;
			persistResizeState = onResizeEnd;
			resizeFit = onLayoutResize;
		}) as typeof panelResizeModule.initializePanelResize;

		panelCollapseModule.initializePanelCollapse = ((
			_elements,
			_state,
			onCollapsedChange,
			onExpand,
		) => {
			persistCollapsedState = onCollapsedChange;
			collapseFit = onExpand;

			return () => {
				collapseRefreshCount += 1;
			};
		}) as typeof panelCollapseModule.initializePanelCollapse;

		/** 실제 xterm 없이 Webview entrypoint가 호출하는 Terminal Pool API만 관찰한다. */
		agentTerminalPoolModule.createDefaultAgentTerminalPool = ((
			_container,
			_postMessage,
		) => ({
			ensureTab(tabId): void {
				ensuredTabs.push(tabId);
			},

			setActiveTab(tabId): void {
				activeTabs.push(tabId);
			},

			closeTab: () => undefined,

			resetTab: () => undefined,

			handleHostMessage: (message) => {
				terminalHostMessages.push(message);
			},

			scheduleActiveTerminalFit(): void {
				terminalFitCount += 1;
			},

			dispose(): void {
				terminalPoolDisposed = true;
			},
		})) as typeof agentTerminalPoolModule.createDefaultAgentTerminalPool;

		agentActivityStoreModule.createAgentActivityStore = (() => {
			const store = originalCreateAgentActivityStore();
			const recordingStore: ReturnType<
				typeof originalCreateAgentActivityStore
			> = {
				getActivities: store.getActivities,
				getSnapshot: store.getSnapshot,
				setAgentActivity(sessionId, target, activity): void {
					agentActivitySets.push({ sessionId, target, activity });
					store.setAgentActivity(sessionId, target, activity);
				},
				clearAgentActivity(sessionId, target): void {
					agentActivityClears.push({ sessionId, target });
					store.clearAgentActivity(sessionId, target);
				},
				clearAgentActivitiesBySession(sessionId): void {
					agentActivitySessionClears.push(sessionId);
					store.clearAgentActivitiesBySession(sessionId);
				},
				subscribe: store.subscribe,
			};

			createdAgentActivityStore = recordingStore;
			return recordingStore;
		}) as typeof agentActivityStoreModule.createAgentActivityStore;

		/**
		 * 실제 Agent DOM 대신 초기화 여부와 Webview로 전달되는 콜백만 노출한다.
		 * 실제 구현과 같이 초기 탭을 만들고 `onTabCreated`를 호출해 wiring을 재현한다.
		 */
		agentPanelUiModule.initializeAgentPanelUi = ((_elements, callbacks, _deps, options) => {
			agentPanelUiInitialized = true;
			agentUiLayoutChange = callbacks?.onLayoutChange;
			agentProviderSelect = callbacks?.onProviderSelected;
			initialAgentWorkspaceCatalog = options?.initialWorkspaceRootCatalog;

			const model = createAgentTabModel(() => agentTabId);
			callbacks?.onTabCreated?.(model.createTab());

			return {
				model,
				getSnapshot: () => model.getSnapshot(),
				getAssignmentState: () => undefined,
				updateWorkspaceRootCatalog: (catalog) => {
					agentWorkspaceCatalogUpdates.push(catalog);
				},
				handleHostMessage: (message) => (
					message.type !== 'agent.switchAccepted'
					|| message.switchAttemptId > 1
				),
				dispose(): void {
					agentPanelUiDisposed = true;
				},
			};
		}) as typeof agentPanelUiModule.initializeAgentPanelUi;

		const vscodeApi: WebviewStateApi & {
			postMessage(message: WebviewToExtensionMessage): void;
		} = {
			getState: () => initialState,
			setState: (state) => {
				savedStates.push(state);
			},
			postMessage: (message) => {
				if (message.type === 'agent.activity.clearApplied') {
					clearReceiptSnapshots.push({
						receiptId: message.receiptId,
						targetClearCount: agentActivityClears.length,
						sessionClearCount: agentActivitySessionClears.length,
					});
				}
				postedMessages.push(message);
			},
		};
		/** Dock 변경 뒤 실제 표시 크기 재계산이 실행되므로 최소한의 크기와 style만 제공한다. */
		const layoutElement = {
			dataset: {},
			style: { setProperty: () => undefined },
			clientWidth: 1000,
			clientHeight: 800,
			getAttribute: (attribute: string) => (
				attribute === 'data-workspace-presentation'
					? serializeWorkspacePresentationForWebview({
						graph: initialWorkspaceGraph,
						rootCatalog: initialWorkspaceRootCatalog,
					})
					: null
			),
		} as unknown as HTMLElement;
		const elements = new Map<string, HTMLElement>([
			['.crispy-layout', layoutElement],
			['#app', layoutElement],
			['#graph-area', {} as HTMLElement],
			['#agent-chat-area', {} as HTMLElement],
			['#chat-drag-handle', {} as HTMLElement],
			['#chat-collapse-toggle', {} as HTMLElement],
			['#chat-sticker-opener', {} as HTMLElement],
			['#panel-resize-handle', {} as HTMLElement],
			['#dock-preview', {} as HTMLElement],
			['#agent-terminal-area', {} as HTMLElement],
			['#agent-top-bar', {} as HTMLElement],
			['#agent-tab-strip', {} as HTMLElement],
			['#agent-tab-menu-host', {} as HTMLElement],
			['#agent-provider-picker-host', {} as HTMLElement],
			['#agent-workspace-status-bar', {} as HTMLElement],
			['#agent-dialog-host', {} as HTMLElement],
			['#agent-rename-dialog-host', {} as HTMLElement],
		]);
		const documentMock = {
			currentScript: {
				getAttribute: (attribute: string) => {
					if (attribute === 'data-workspace-state') {
						return encodeURIComponent(JSON.stringify(initialWorkspaceState));
					}
					if (attribute === 'data-workspace-context-generation') {
						return '0';
					}
					return null;
				},
			},
			querySelector: (selector: string) => elements.get(selector) ?? null,
		};
		const windowMock = {
			addEventListener: (
				type: string,
				listener: EventListenerOrEventListenerObject,
			) => {
				if (type === 'unload' && typeof listener === 'function') {
					unloadHandler = listener as () => void;
				}
				if (type === 'message' && typeof listener === 'function') {
					hostMessageHandler = listener as (event: MessageEvent) => void;
				}
			},
		};

		Object.defineProperty(globalThis, 'document', {
			configurable: true,
			value: documentMock,
		});
		Object.defineProperty(globalThis, 'window', {
			configurable: true,
			value: windowMock,
		});
		Object.defineProperty(globalThis, 'acquireVsCodeApi', {
			configurable: true,
			value: () => vscodeApi,
		});

		delete require.cache[webviewModulePath];

		try {
			require(webviewModulePath);

			/** Agent UI 초기화 실패가 조용히 무시되지 않았음을 먼저 확인한다. */
			assert.strictEqual(agentPanelUiInitialized, true);
			assert.ok(agentUiLayoutChange);
			assert.deepStrictEqual(getTabCreateMessages(postedMessages), [
				{ type: 'tab.create', tabId: agentTabId },
			]);
			assert.deepStrictEqual(ensuredTabs, [agentTabId]);
			assert.deepStrictEqual(activeTabs, [agentTabId]);
			assert.strictEqual(graphInitializeCount, 1);
			assert.strictEqual(graphAgentActivityStore, createdAgentActivityStore);
			assert.strictEqual(graphVisibleRefreshCount, 1);
			assert.ok(hostMessageHandler);
			assert.ok(agentProviderSelect);

			/** 초기 atomic Presentation의 Catalog를 Agent UI에도 같은 값으로 전달한다. */
			assert.deepStrictEqual(
				initialAgentWorkspaceCatalog,
				initialWorkspaceRootCatalog,
			);

			const taskJson = '{"format":"crispy.task"}';
			graphViewInteractions?.onTaskJsonCopyRequest?.(taskJson);
			assert.deepStrictEqual(
				postedMessages.filter(({ type }) => type === 'task.copyJson'),
				[{ type: 'task.copyJson', json: taskJson }],
			);
			graphViewInteractions?.onTaskJsonCopyFailure?.('transfer_limit');
			assert.deepStrictEqual(
				postedMessages.filter(({ type }) => type === 'task.copyJsonFailed'),
				[{ type: 'task.copyJsonFailed', reason: 'transfer_limit' }],
			);

			hostMessageHandler({
				data: {
					type: 'workspace.snapshotUpdated',
					presentation: {
						graph: initialWorkspaceGraph,
						rootCatalog: initialWorkspaceRootCatalog,
					},
					contextGeneration: 0,
					rootIds: initialWorkspaceGraph.roots.map(
						(root) => root.nodeId,
					),
				},
			} as MessageEvent);

			assert.deepStrictEqual(graphUpdates, [initialWorkspaceGraph]);
			assert.deepStrictEqual(agentWorkspaceCatalogUpdates, [
				initialWorkspaceRootCatalog,
			]);
			assert.deepStrictEqual(terminalHostMessages, []);
			assert.strictEqual(graphInitializeCount, 1);
			assert.strictEqual(graphDisposed, false);

			hostMessageHandler({
				data: {
					type: 'workspace.snapshotUpdated',
					presentation: {
						graph: refreshedWorkspaceGraph,
						rootCatalog: refreshedWorkspaceRootCatalog,
					},
					contextGeneration: 1,
					rootIds: refreshedWorkspaceGraph.roots.map(
						(root) => root.nodeId,
					),
					state: refreshedWorkspaceState,
				},
			} as MessageEvent);

			assert.deepStrictEqual(workspaceUpdates, [{
				graph: refreshedWorkspaceGraph,
				snapshot: {
					graph: {
						nodePositions: refreshedWorkspaceState.nodePositions,
						fileGroupPages: refreshedWorkspaceState.fileGroupPages,
						openedFolders: refreshedWorkspaceState.openedFolders,
						detachedRootNodeIds:
							refreshedWorkspaceState.detachedRootNodeIds,
						hiddenNodeIds: refreshedWorkspaceState.hiddenNodeIds,
					},
					tasks: refreshedWorkspaceTasks,
				},
			}]);
			assert.deepStrictEqual(currentWorkspaceTasks, refreshedWorkspaceTasks);
			assert.deepStrictEqual(graphUpdates, [initialWorkspaceGraph]);
			assert.deepStrictEqual(agentWorkspaceCatalogUpdates, [
				initialWorkspaceRootCatalog,
				refreshedWorkspaceRootCatalog,
			]);
			assert.strictEqual(agentProviderSelect(
				agentTabId,
				'claude',
				'workspace-root:project:refreshed',
			), 1);
			assert.deepStrictEqual(getAgentSwitchMessages(postedMessages), [{
				type: 'agent.switch',
				tabId: agentTabId,
				providerId: 'claude',
				workspaceRootId: 'workspace-root:project:refreshed',
				switchAttemptId: 1,
			}]);

			hostMessageHandler({
				data: {
					type: 'workspace.snapshotUpdated',
					presentation: {
						graph: refreshedWorkspaceGraph,
						rootCatalog: refreshedWorkspaceRootCatalog,
					},
					contextGeneration: 1,
					rootIds: refreshedWorkspaceGraph.roots.map(
						(root) => root.nodeId,
					),
				},
			} as MessageEvent);

			/** 여러 root에서는 UI가 명시적으로 고른 ID를 callback이 그대로 보낸다. */
			assert.strictEqual(agentProviderSelect(
				agentTabId,
				'codex',
				'workspace-root:file:///workspace/sibling',
			), 2);
			assert.strictEqual(getAgentSwitchMessages(postedMessages).length, 2);
			assert.deepStrictEqual(getAgentSwitchMessages(postedMessages)[1], {
				type: 'agent.switch',
				tabId: agentTabId,
				providerId: 'codex',
				workspaceRootId: 'workspace-root:file:///workspace/sibling',
				switchAttemptId: 2,
			});
			assert.deepStrictEqual(terminalHostMessages, []);
			assert.strictEqual(graphInitializeCount, 1);
			assert.strictEqual(graphDisposed, false);

			hostMessageHandler({
				data: {
					type: 'workspace.snapshotUpdated',
					presentation: {
						graph: refreshedWorkspaceGraph,
						rootCatalog: [{
							id: 'workspace-root:',
							name: 'invalid',
							description: 'invalid',
							selectable: true,
						}],
					},
					contextGeneration: 1,
					rootIds: refreshedWorkspaceGraph.roots.map(
						(root) => root.nodeId,
					),
				},
			} as MessageEvent);

			/** Catalog가 잘못되면 유효한 Graph도 부분 적용하지 않는다. */
			assert.deepStrictEqual(graphUpdates, [
				initialWorkspaceGraph,
				refreshedWorkspaceGraph,
			]);

			/** 이전 generation의 full snapshot은 Graph, Catalog, Task를 되돌리지 않는다. */
			hostMessageHandler({
				data: {
					type: 'workspace.snapshotUpdated',
					presentation: {
						graph: initialWorkspaceGraph,
						rootCatalog: initialWorkspaceRootCatalog,
					},
					contextGeneration: 0,
					rootIds: initialWorkspaceGraph.roots.map((root) => root.nodeId),
					state: initialWorkspaceState,
				},
			} as MessageEvent);
			assert.strictEqual(workspaceUpdates.length, 1);
			assert.deepStrictEqual(currentWorkspaceTasks, refreshedWorkspaceTasks);
			assert.strictEqual(agentWorkspaceCatalogUpdates.length, 3);

			hostMessageHandler({
				data: {
					type: 'graph.nodeEffect.set',
					target: { nodeId: 'file:app/index.ts' },
					effect: { kind: 'shimmer', color: '#ff0088' },
				},
			} as MessageEvent);
			hostMessageHandler({
				data: {
					type: 'graph.nodeEffect.clear',
					target: {
						nodeId: 'file:app/index.ts',
						rootId: 'detached:file:app/index.ts:1',
					},
					kind: 'shimmer',
				},
			} as MessageEvent);

			assert.deepStrictEqual(graphEffectSets, [{
				target: { nodeId: 'file:app/index.ts' },
				effect: { kind: 'shimmer', color: '#ff0088' },
			}]);
			assert.deepStrictEqual(graphEffectClears, [{
				target: {
					nodeId: 'file:app/index.ts',
					rootId: 'detached:file:app/index.ts:1',
				},
				kind: 'shimmer',
			}]);

			const activityTarget: GraphNodeEffectTarget = {
				nodeId: 'file:app/index.ts',
				rootId: 'detached:file:app/index.ts:1',
			};
			hostMessageHandler({
				data: {
					type: 'agent.activity.set',
					sessionId: 'session-activity-a',
					target: activityTarget,
					activity: 'editing',
				},
			} as MessageEvent);
			hostMessageHandler({
				data: {
					type: 'agent.activity.clear',
					sessionId: 'session-activity-a',
					target: activityTarget,
				},
			} as MessageEvent);
			hostMessageHandler({
				data: {
					type: 'agent.activity.clearSession',
					sessionId: 'session-activity-b',
				},
			} as MessageEvent);

			assert.deepStrictEqual(agentActivitySets, [{
				sessionId: 'session-activity-a',
				target: activityTarget,
				activity: 'editing',
			}]);
			assert.deepStrictEqual(agentActivityClears, [{
				sessionId: 'session-activity-a',
				target: activityTarget,
			}]);
			assert.deepStrictEqual(
				agentActivitySessionClears,
				['session-activity-b'],
			);
			assert.deepStrictEqual(agentEffectSets, [{
				target: activityTarget,
				effect: {
					kind: 'pulse',
					color: 'var(--graph-viewport-accent-color, #007acc)',
				},
			}]);
			assert.deepStrictEqual(agentEffectClears, [{
				target: activityTarget,
			}]);
			assert.deepStrictEqual(
				getAgentActivityClearAppliedReceipts(postedMessages),
				[],
			);

			hostMessageHandler({
				data: {
					type: 'agent.activity.clearTracked',
					receiptId: 0,
					publicMessage: {
						type: 'agent.activity.clear',
						sessionId: 'session-activity-a',
						target: activityTarget,
					},
				},
			} as MessageEvent);
			hostMessageHandler({
				data: {
					type: 'agent.activity.clearTracked',
					receiptId: 2,
					publicMessage: {
						type: 'agent.activity.clearSession',
						sessionId: 'session-activity-b',
					},
				},
			} as MessageEvent);

			assert.deepStrictEqual(agentActivityClears, [{
				sessionId: 'session-activity-a',
				target: activityTarget,
			}, {
				sessionId: 'session-activity-a',
				target: activityTarget,
			}]);
			assert.deepStrictEqual(
				agentActivitySessionClears,
				['session-activity-b', 'session-activity-b'],
			);
			assert.deepStrictEqual(
				getAgentActivityClearAppliedReceipts(postedMessages),
				[{
					type: 'agent.activity.clearApplied',
					receiptId: 0,
				}, {
					type: 'agent.activity.clearApplied',
					receiptId: 2,
				}],
			);
			assert.deepStrictEqual(clearReceiptSnapshots, [{
				receiptId: 0,
				targetClearCount: 2,
				sessionClearCount: 1,
			}, {
				receiptId: 2,
				targetClearCount: 2,
				sessionClearCount: 2,
			}]);

			const terminalStartingMessage = {
				type: 'terminal.starting',
				tabId: agentTabId,
				sessionId: 'session-starting',
			} as const;

			hostMessageHandler({ data: terminalStartingMessage } as MessageEvent);
			assert.deepStrictEqual(terminalHostMessages, [terminalStartingMessage]);

			const rejectedSwitchAccepted = {
				type: 'agent.switchAccepted',
				tabId: agentTabId,
				providerId: 'claude',
				workspaceRootId: 'workspace-root:project:refreshed',
				switchAttemptId: 1,
				assignmentRevision: 1,
			} as const;
			hostMessageHandler({ data: rejectedSwitchAccepted } as MessageEvent);
			assert.deepStrictEqual(terminalHostMessages, [terminalStartingMessage]);

			const acceptedSwitchAccepted = {
				...rejectedSwitchAccepted,
				switchAttemptId: 2,
				assignmentRevision: 3,
			} as const;
			hostMessageHandler({ data: acceptedSwitchAccepted } as MessageEvent);
			assert.deepStrictEqual(terminalHostMessages, [
				terminalStartingMessage,
				acceptedSwitchAccepted,
			]);
			assert.deepStrictEqual(graphUpdates, [
				initialWorkspaceGraph,
				refreshedWorkspaceGraph,
			]);

			const fitCountBeforeLayoutChange = terminalFitCount;
			agentUiLayoutChange();

			assert.strictEqual(terminalFitCount, fitCountBeforeLayoutChange + 1);

			assert.ok(postedMessages.some(({ type }) => type === 'webview.ready'));
			assert.ok(graphSubscriber);
			const cameraState: GraphStateSnapshot = {
				...currentGraphState,
				camera: { x: 120, y: -60, scale: 2 },
			};
			currentGraphState = cameraState;
			graphSubscriber(cameraState);

			assert.strictEqual(savedStates.length, 1);
			assert.deepStrictEqual(savedStates[0], {
				panel: initialState.panel,
				camera: cameraState.camera,
			});
			assert.deepStrictEqual(Object.keys(savedStates[0] ?? {}), [
				'panel',
				'camera',
			]);
			assert.deepStrictEqual(
				getWorkspaceStateChangedMessages(postedMessages),
				[],
			);

			const sessionMessages = getStateChangedMessages(postedMessages);
			assert.strictEqual(sessionMessages.length, 1);
			assert.deepStrictEqual(sessionMessages[0], {
				type: 'webview.stateChanged',
				state: savedStates[0],
			});

			const nodePositionState: GraphStateSnapshot = {
				...cameraState,
				nodePositions: { 'folder:src': { x: 800, y: 240 } },
			};
			currentGraphState = nodePositionState;
			assert.ok(workspaceSubscriber);
			workspaceSubscriber(getCurrentWorkspaceSnapshot());

			assert.strictEqual(savedStates.length, 1);
			assert.deepStrictEqual(getWorkspaceStateChangedMessages(postedMessages), [{
				type: 'workspace.stateChanged',
				contextGeneration: 1,
				rootIds: refreshedWorkspaceGraph.roots.map((root) => root.nodeId),
				state: getCurrentWorkspacePersistentState(),
			}]);

			const fileGroupPageState: GraphStateSnapshot = {
				...nodePositionState,
				fileGroupPages: { 'folder:src:files': 2 },
			};
			currentGraphState = fileGroupPageState;
			workspaceSubscriber(getCurrentWorkspaceSnapshot());

			assert.strictEqual(savedStates.length, 1);
			assert.strictEqual(
				getWorkspaceStateChangedMessages(postedMessages).length,
				2,
			);
			assert.deepStrictEqual(
				getWorkspaceStateChangedMessages(postedMessages)[1]?.state.fileGroupPages,
				{ 'folder:src:files': 2 },
			);

			const openedFolderState: GraphStateSnapshot = {
				...fileGroupPageState,
				openedFolders: { 'folder:src': true },
			};
			currentGraphState = openedFolderState;
			workspaceSubscriber(getCurrentWorkspaceSnapshot());

			assert.strictEqual(savedStates.length, 1);
			assert.strictEqual(
				getWorkspaceStateChangedMessages(postedMessages).length,
				3,
			);
			assert.deepStrictEqual(
				getWorkspaceStateChangedMessages(postedMessages)[2]?.state.openedFolders,
				{ 'folder:src': true },
			);

			const detachedRootState: GraphStateSnapshot = {
				...openedFolderState,
				detachedRootNodeIds: { 'folder:src': true },
			};
			currentGraphState = detachedRootState;
			workspaceSubscriber(getCurrentWorkspaceSnapshot());

			assert.strictEqual(savedStates.length, 1);
			assert.strictEqual(
				getWorkspaceStateChangedMessages(postedMessages).length,
				4,
			);
			assert.deepStrictEqual(
				getWorkspaceStateChangedMessages(postedMessages)[3]?.state,
				getCurrentWorkspacePersistentState(),
			);
			assert.strictEqual(getStateChangedMessages(postedMessages).length, 1);

			const reattachedRootState: GraphStateSnapshot = {
				...detachedRootState,
				nodePositions: {},
				detachedRootNodeIds: {},
			};
			currentGraphState = reattachedRootState;
			workspaceSubscriber(getCurrentWorkspaceSnapshot());

			assert.strictEqual(savedStates.length, 1);
			assert.strictEqual(
				getWorkspaceStateChangedMessages(postedMessages).length,
				5,
			);
			assert.deepStrictEqual(
				getWorkspaceStateChangedMessages(postedMessages)[4]?.state,
				getCurrentWorkspacePersistentState(),
			);
			assert.strictEqual(getStateChangedMessages(postedMessages).length, 1);

			const hiddenNodeState: GraphStateSnapshot = {
				...reattachedRootState,
				hiddenNodeIds: { 'folder:src/private': true },
			};
			currentGraphState = hiddenNodeState;
			workspaceSubscriber(getCurrentWorkspaceSnapshot());

			assert.strictEqual(savedStates.length, 1);
			assert.strictEqual(
				getWorkspaceStateChangedMessages(postedMessages).length,
				6,
			);
			assert.deepStrictEqual(
				getWorkspaceStateChangedMessages(postedMessages)[5]?.state,
				getCurrentWorkspacePersistentState(),
			);
			assert.strictEqual(getStateChangedMessages(postedMessages).length, 1);

			assert.ok(panelState);
			assert.ok(persistPanelState);
			panelState.preferredDock = 'bottom';
			panelState.verticalSize = 320;
			persistPanelState();

			assert.strictEqual(savedStates.length, 2);
			assert.deepStrictEqual(savedStates[1], {
				panel: {
					...initialState.panel,
					preferredDock: 'bottom',
					verticalSize: 320,
				},
				camera: cameraState.camera,
			});

			const panelMessages = getStateChangedMessages(postedMessages);
			assert.strictEqual(panelMessages.length, 2);
			const panelMessage = panelMessages[1];
			assert.ok(panelMessage);
			assert.deepStrictEqual(panelMessage, {
				type: 'webview.stateChanged',
				state: savedStates[1],
			});

			assert.ok(dockFit);
			const fitCountBeforeDock = terminalFitCount;
			const collapseRefreshBeforeDock = collapseRefreshCount;
			const graphRefreshBeforeDock = graphVisibleRefreshCount;
			dockFit();

			assert.strictEqual(terminalFitCount, fitCountBeforeDock + 1);
			assert.strictEqual(collapseRefreshCount, collapseRefreshBeforeDock + 1);
			assert.strictEqual(graphVisibleRefreshCount, graphRefreshBeforeDock + 1);

			assert.ok(persistResizeState);
			assert.ok(resizeRefresh);
			assert.ok(resizeFit);
			const graphRefreshBeforeResize = graphVisibleRefreshCount;
			resizeRefresh();
			assert.strictEqual(
				graphVisibleRefreshCount,
				graphRefreshBeforeResize + 1,
			);
			panelState.sideSize = 500;
			persistResizeState();

			assert.strictEqual(savedStates.length, 3);
			assert.deepStrictEqual(savedStates[2], {
				panel: {
					...initialState.panel,
					preferredDock: 'bottom',
					sideSize: 500,
					verticalSize: 320,
				},
				camera: cameraState.camera,
			});

			const resizeMessages = getStateChangedMessages(postedMessages);
			assert.strictEqual(resizeMessages.length, 3);
			const resizeMessage = resizeMessages[2];
			assert.ok(resizeMessage);
			assert.deepStrictEqual(resizeMessage, {
				type: 'webview.stateChanged',
				state: savedStates[2],
			});

			const fitCountBeforeResize = terminalFitCount;
			resizeFit();

			assert.strictEqual(terminalFitCount, fitCountBeforeResize + 1);

			assert.ok(persistCollapsedState);
			assert.ok(collapseFit);
			panelState.collapsed = true;
			const graphRefreshBeforeCollapse = graphVisibleRefreshCount;
			persistCollapsedState();
			assert.strictEqual(
				graphVisibleRefreshCount,
				graphRefreshBeforeCollapse + 1,
			);

			assert.strictEqual(savedStates.length, 4);
			assert.deepStrictEqual(savedStates[3], {
				panel: {
					...initialState.panel,
					preferredDock: 'bottom',
					sideSize: 500,
					verticalSize: 320,
					collapsed: true,
				},
				camera: cameraState.camera,
			});

			const collapseMessages = getStateChangedMessages(postedMessages);
			assert.strictEqual(collapseMessages.length, 4);
			assert.deepStrictEqual(collapseMessages[3], {
				type: 'webview.stateChanged',
				state: savedStates[3],
			});
			assert.strictEqual(
				getWorkspaceStateChangedMessages(postedMessages).length,
				6,
			);

			const fitCountBeforeExpand = terminalFitCount;
			collapseFit();

			assert.strictEqual(terminalFitCount, fitCountBeforeExpand + 1);

			assert.ok(unloadHandler);
			unloadHandler();

			assert.strictEqual(graphUnsubscribed, true);
			assert.strictEqual(workspaceUnsubscribed, true);
			assert.strictEqual(graphDisposed, true);
			assert.strictEqual(agentEffectOwnerDisposed, true);
			assert.strictEqual(terminalPoolDisposed, true);
			assert.strictEqual(agentPanelUiDisposed, true);
		} finally {
			delete require.cache[webviewModulePath];
			graphViewModule.initializeGraphView = originalInitializeGraphView;
			panelDockModule.initializePanelDock = originalInitializePanelDock;
			panelResizeModule.initializePanelResize = originalInitializePanelResize;
			panelCollapseModule.initializePanelCollapse = originalInitializePanelCollapse;
			agentPanelUiModule.initializeAgentPanelUi = originalInitializeAgentPanelUi;
			agentTerminalPoolModule.createDefaultAgentTerminalPool =
				originalCreateDefaultAgentTerminalPool;
			agentActivityStoreModule.createAgentActivityStore =
				originalCreateAgentActivityStore;
			restoreGlobalProperty('document', originalDocument);
			restoreGlobalProperty('window', originalWindow);
			restoreGlobalProperty('acquireVsCodeApi', originalAcquireVsCodeApi);
		}
	});
});

interface GraphViewModule {
	initializeGraphView: typeof import('../webview/graph/graphView').initializeGraphView;
}

interface PanelDockModule {
	initializePanelDock: typeof import('../webview/panel/panelDock').initializePanelDock;
}

interface PanelResizeModule {
	initializePanelResize: typeof import('../webview/panel/panelResize').initializePanelResize;
}

interface PanelCollapseModule {
	initializePanelCollapse:
		typeof import('../webview/panel/panelCollapse').initializePanelCollapse;
}

interface AgentPanelUiModule {
	initializeAgentPanelUi: typeof import('../agent/UI/agentPanelUi').initializeAgentPanelUi;
}

interface AgentTerminalPoolModule {
	createDefaultAgentTerminalPool:
		typeof import('../agent/webview/agentTerminalPool').createDefaultAgentTerminalPool;
}

interface AgentActivityStoreModule {
	createAgentActivityStore:
		typeof import('../agent/webview/agentActivityStore').createAgentActivityStore;
}

function getStateChangedMessages(
	messages: WebviewToExtensionMessage[],
): Array<Extract<WebviewToExtensionMessage, { type: 'webview.stateChanged' }>> {
	return messages.filter(
		(message): message is Extract<
			WebviewToExtensionMessage,
			{ type: 'webview.stateChanged' }
		> => message.type === 'webview.stateChanged',
	);
}

function getWorkspaceStateChangedMessages(
	messages: WebviewToExtensionMessage[],
): Array<Extract<WebviewToExtensionMessage, { type: 'workspace.stateChanged' }>> {
	return messages.filter(
		(message): message is Extract<
			WebviewToExtensionMessage,
			{ type: 'workspace.stateChanged' }
		> => message.type === 'workspace.stateChanged',
	);
}

function getAgentActivityClearAppliedReceipts(
	messages: WebviewToExtensionMessage[],
): Array<Extract<
	WebviewToExtensionMessage,
	{ type: 'agent.activity.clearApplied' }
>> {
	return messages.filter(
		(message): message is Extract<
			WebviewToExtensionMessage,
			{ type: 'agent.activity.clearApplied' }
		> => message.type === 'agent.activity.clearApplied',
	);
}

function getTabCreateMessages(
	messages: WebviewToExtensionMessage[],
): Array<Extract<WebviewToExtensionMessage, { type: 'tab.create' }>> {
	return messages.filter(
		(message): message is Extract<
			WebviewToExtensionMessage,
			{ type: 'tab.create' }
		> => message.type === 'tab.create',
	);
}

function getAgentSwitchMessages(
	messages: WebviewToExtensionMessage[],
): Array<Extract<WebviewToExtensionMessage, { type: 'agent.switch' }>> {
	return messages.filter(
		(message): message is Extract<
			WebviewToExtensionMessage,
			{ type: 'agent.switch' }
		> => message.type === 'agent.switch',
	);
}

function restoreGlobalProperty(
	property: string,
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor) {
		Object.defineProperty(globalThis, property, descriptor);
		return;
	}

	delete (globalThis as Record<string, unknown>)[property];
}

function createStateApi(state: unknown): WebviewStateApi {
	return {
		getState: () => state,
		setState: () => undefined,
	};
}

function createWebviewState(
	preferredDock: PersistedWebviewState['panel']['preferredDock'],
	x: number,
	y: number,
	scale: number,
	collapsed = false,
): PersistedWebviewState {
	return {
		panel: {
			preferredDock,
			sideSize: 440,
			verticalSize: 260,
			collapsed,
		},
		graph: {
			camera: { x, y, scale },
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
		},
	};
}
