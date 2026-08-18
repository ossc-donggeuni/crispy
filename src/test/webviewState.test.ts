import * as assert from 'assert';
import { createAgentTabModel } from '../agent/UI/agentTabModel';
import type { WebviewToExtensionMessage } from '../messages';
import {
	createGraphState,
	INITIAL_GRAPH_STATE,
	type GraphStateSnapshot,
} from '../webview/graph/graphState';
import type { Graph } from '../webview/graph/graphModel';
import { serializeGraphForWebview } from '../webview/graph/graphTransport';
import { DEFAULT_PANEL_LAYOUT_STATE } from '../webview/panel/panelState';
import type { PanelLayoutState } from '../webview/panel/panelState';
import {
	parseWebviewState,
	restoreWebviewState,
	saveWebviewState,
	serializeWebviewState,
	type PersistedWebviewState,
	type WebviewStateApi,
} from '../webview/webviewState';

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
	});

	test('getState의 전체 Webview 상태를 외부 객체와 분리해 우선 복원한다', () => {
		const savedState = createWebviewState('left', 40, -30, 1.5);
		const htmlState = createWebviewState('bottom', 100, 200, 2);

		const state = restoreWebviewState(
			createStateApi(savedState),
			serializeWebviewState(htmlState),
		);

		assert.deepStrictEqual(state, savedState);
		assert.notStrictEqual(state, savedState);
		assert.notStrictEqual(state.panel, savedState.panel);
		assert.notStrictEqual(state.graph, savedState.graph);
		assert.notStrictEqual(state.graph.camera, savedState.graph.camera);
		assert.notStrictEqual(
			state.graph.nodePositions,
			savedState.graph.nodePositions,
		);
		assert.notStrictEqual(
			state.graph.fileGroupPages,
			savedState.graph.fileGroupPages,
		);
		assert.notStrictEqual(
			state.graph.openedFolders,
			savedState.graph.openedFolders,
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

	test('저장 시 Panel과 Graph를 함께 독립적인 snapshot으로 setState에 전달한다', () => {
		let savedState: PersistedWebviewState | undefined;
		const api: WebviewStateApi = {
			getState: () => undefined,
			setState: (state) => {
				savedState = state;
			},
		};
		const state = createWebviewState('right', 120, -60, 3);

		saveWebviewState(api, state);

		assert.deepStrictEqual(savedState, state);
		assert.notStrictEqual(savedState, state);
		assert.notStrictEqual(savedState?.panel, state.panel);
		assert.notStrictEqual(savedState?.graph, state.graph);
		assert.notStrictEqual(savedState?.graph.camera, state.graph.camera);
		assert.notStrictEqual(
			savedState?.graph.nodePositions,
			state.graph.nodePositions,
		);
		assert.notStrictEqual(
			savedState?.graph.fileGroupPages,
			state.graph.fileGroupPages,
		);
		assert.notStrictEqual(
			savedState?.graph.openedFolders,
			state.graph.openedFolders,
		);
	});

	test('Graph snapshot을 저장하고 새 Store로 Round Trip한다', () => {
		let savedState: PersistedWebviewState | undefined;
		const api: WebviewStateApi = {
			getState: () => savedState,
			setState: (state) => {
				savedState = state;
			},
		};
		const initialState = restoreWebviewState(api);
		const graphState = createGraphState(initialState.graph);
		const unsubscribe = graphState.subscribe((graph) => {
			saveWebviewState(api, {
				panel: initialState.panel,
				graph,
			});
		});

		graphState.setState({
			camera: { x: 513, y: 324, scale: 1.2 },
			nodePositions: {
				'folder:app': { x: 720, y: 180 },
				'folder:app/src:files': { x: 1040, y: 360 },
			},
		});
		graphState.showMoreFiles('folder:app/src:files');
		graphState.showMoreFiles('folder:app/src:files');
		graphState.toggleFolder('folder:app');

		assert.deepStrictEqual(api.getState(), {
			panel: DEFAULT_PANEL_LAYOUT_STATE,
			graph: {
				camera: { x: 513, y: 324, scale: 1.2 },
				nodePositions: {
					'folder:app': { x: 720, y: 180 },
					'folder:app/src:files': { x: 1040, y: 360 },
				},
				fileGroupPages: { 'folder:app/src:files': 3 },
				openedFolders: { 'folder:app': true },
			},
		});
		unsubscribe();

		const restoredState = restoreWebviewState(api);
		const reinitializedGraphState = createGraphState(restoredState.graph);

		assert.notStrictEqual(reinitializedGraphState, graphState);
		assert.deepStrictEqual(reinitializedGraphState.getState().camera, {
			x: 513,
			y: 324,
			scale: 1.2,
		});
		assert.deepStrictEqual(reinitializedGraphState.getState().nodePositions, {
			'folder:app': { x: 720, y: 180 },
			'folder:app/src:files': { x: 1040, y: 360 },
		});
		assert.strictEqual(
			reinitializedGraphState.getFileGroupPage('folder:app/src:files'),
			3,
		);
		assert.strictEqual(
			reinitializedGraphState.isFolderOpened('folder:app'),
			true,
		);
	});

	test('serialize 후 restore해도 파일 그룹 page와 열린 Folder 상태를 유지한다', () => {
		const state = createWebviewState('right', 10, -20, 1.25);
		state.graph.fileGroupPages = {
			'folder:src:files': 4,
			'folder:test:files': 2,
		};
		state.graph.openedFolders = {
			'folder:src': true,
			'folder:test': true,
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
	});

});

suite('Webview State Wiring', () => {
	test('Graph, Panel, Agent와 Terminal wiring을 전체 Webview lifecycle에 연결한다', () => {
		const initialState = createWebviewState('left', 35, -25, 1.25);
		const initialWorkspaceGraph: Graph = {
			roots: [
				{ id: 'root:app', nodeId: 'project:app' },
				{ id: 'root:api', nodeId: 'project:api' },
			],
			rootNodes: {
				'project:app': {
					kind: 'project',
					id: 'project:app',
					name: 'app',
					children: [{
						kind: 'file',
						id: 'file:app/index.ts',
						name: 'index.ts',
					}],
				},
				'project:api': {
					kind: 'project',
					id: 'project:api',
					name: 'api',
					children: [],
				},
			},
		};
		const nextGraphState = {
			camera: { x: 120, y: -60, scale: 2 },
			nodePositions: { 'folder:src': { x: 800, y: 240 } },
			fileGroupPages: {},
			openedFolders: { 'folder:src': true as const },
		};
		const agentTabId = 'agent-tab-test';
		const savedStates: PersistedWebviewState[] = [];
		const postedMessages: WebviewToExtensionMessage[] = [];
		const ensuredTabs: string[] = [];
		const activeTabs: string[] = [];
		let currentGraphState: GraphStateSnapshot = {
			camera: initialState.graph.camera,
			nodePositions: initialState.graph.nodePositions,
			fileGroupPages: initialState.graph.fileGroupPages ?? {},
			openedFolders: initialState.graph.openedFolders ?? {},
		};
		let graphSubscriber: ((state: typeof currentGraphState) => void) | undefined;
		let panelState: PanelLayoutState | undefined;
		let persistPanelState: (() => void) | undefined;
		let dockFit: (() => void) | undefined;
		let persistResizeState: (() => void) | undefined;
		let resizeFit: (() => void) | undefined;
		let agentUiLayoutChange: (() => void) | undefined;
		let unloadHandler: (() => void) | undefined;
		let graphUnsubscribed = false;
		let graphDisposed = false;
		let agentPanelUiInitialized = false;
		let agentPanelUiDisposed = false;
		let terminalPoolDisposed = false;
		let terminalFitCount = 0;

		const graphViewModulePath = require.resolve('../webview/graph/graphView');
		const panelDockModulePath = require.resolve('../webview/panel/panelDock');
		const panelResizeModulePath = require.resolve('../webview/panel/panelResize');
		const agentPanelUiModulePath = require.resolve('../agent/UI/agentPanelUi');
		const agentTerminalPoolModulePath = require.resolve(
			'../agent/webview/agentTerminalPool',
		);
		const webviewModulePath = require.resolve('../webview/webview');
		const graphViewModule = require(graphViewModulePath) as GraphViewModule;
		const panelDockModule = require(panelDockModulePath) as PanelDockModule;
		const panelResizeModule = require(panelResizeModulePath) as PanelResizeModule;
		const agentPanelUiModule = require(
			agentPanelUiModulePath,
		) as AgentPanelUiModule;
		const agentTerminalPoolModule = require(
			agentTerminalPoolModulePath,
		) as AgentTerminalPoolModule;
		const originalInitializeGraphView = graphViewModule.initializeGraphView;
		const originalInitializePanelDock = panelDockModule.initializePanelDock;
		const originalInitializePanelResize = panelResizeModule.initializePanelResize;
		const originalInitializeAgentPanelUi = agentPanelUiModule.initializeAgentPanelUi;
		const originalCreateDefaultAgentTerminalPool =
			agentTerminalPoolModule.createDefaultAgentTerminalPool;
		const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
		const originalAcquireVsCodeApi = Object.getOwnPropertyDescriptor(
			globalThis,
			'acquireVsCodeApi',
		);

		graphViewModule.initializeGraphView = ((_root, restoredGraphState, graph) => {
			assert.deepStrictEqual(restoredGraphState, initialState.graph);
			assert.deepStrictEqual(graph, initialWorkspaceGraph);
			const graphState = restoredGraphState ?? INITIAL_GRAPH_STATE;
			currentGraphState = {
				camera: { ...graphState.camera },
				nodePositions: { ...graphState.nodePositions },
				fileGroupPages: { ...graphState.fileGroupPages },
				openedFolders: { ...graphState.openedFolders },
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
			_onSizeChange,
			onResizeEnd,
			onLayoutResize,
		) => {
			persistResizeState = onResizeEnd;
			resizeFit = onLayoutResize;
		}) as typeof panelResizeModule.initializePanelResize;

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

			handleHostMessage: () => undefined,

			scheduleActiveTerminalFit(): void {
				terminalFitCount += 1;
			},

			dispose(): void {
				terminalPoolDisposed = true;
			},
		})) as typeof agentTerminalPoolModule.createDefaultAgentTerminalPool;

		/**
		 * 실제 Agent DOM 대신 초기화 여부와 Webview로 전달되는 콜백만 노출한다.
		 * 실제 구현과 같이 초기 탭을 만들고 `onTabCreated`를 호출해 wiring을 재현한다.
		 */
		agentPanelUiModule.initializeAgentPanelUi = ((_elements, callbacks) => {
			agentPanelUiInitialized = true;
			agentUiLayoutChange = callbacks?.onLayoutChange;

			const model = createAgentTabModel(() => agentTabId);
			callbacks?.onTabCreated?.(model.createTab());

			return {
				model,
				getSnapshot: () => model.getSnapshot(),
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
				postedMessages.push(message);
			},
		};
		const elements = new Map<string, HTMLElement>([
			['.crispy-layout', {} as HTMLElement],
			['#graph-area', {} as HTMLElement],
			['#chat-drag-handle', {} as HTMLElement],
			['#panel-resize-handle', {} as HTMLElement],
			['#dock-preview', {} as HTMLElement],
			['#agent-terminal-area', {} as HTMLElement],
			['#agent-top-bar', {} as HTMLElement],
			['#agent-tab-strip', {} as HTMLElement],
			['#agent-provider-picker-host', {} as HTMLElement],
			['#agent-dialog-host', {} as HTMLElement],
		]);
		const documentMock = {
			currentScript: {
				getAttribute: (attribute: string) => (
					attribute === 'data-workspace-graph'
						? serializeGraphForWebview(initialWorkspaceGraph)
						: null
				),
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

			const fitCountBeforeLayoutChange = terminalFitCount;
			agentUiLayoutChange();

			assert.strictEqual(terminalFitCount, fitCountBeforeLayoutChange + 1);

			assert.ok(postedMessages.some(({ type }) => type === 'webview.ready'));
			assert.ok(graphSubscriber);
			currentGraphState = nextGraphState;
			graphSubscriber(nextGraphState);

			assert.strictEqual(savedStates.length, 1);
			assert.deepStrictEqual(savedStates[0], {
				panel: initialState.panel,
				graph: nextGraphState,
			});

			const graphMessages = getStateChangedMessages(postedMessages);
			assert.strictEqual(graphMessages.length, 1);
			const graphMessage = graphMessages[0];
			assert.ok(graphMessage);
			assert.deepStrictEqual(graphMessage, {
				type: 'webview.stateChanged',
				state: savedStates[0],
			});

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
				graph: nextGraphState,
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
			dockFit();

			assert.strictEqual(terminalFitCount, fitCountBeforeDock + 1);

			assert.ok(persistResizeState);
			assert.ok(resizeFit);
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
				graph: nextGraphState,
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

			assert.ok(unloadHandler);
			unloadHandler();

			assert.strictEqual(graphUnsubscribed, true);
			assert.strictEqual(graphDisposed, true);
			assert.strictEqual(terminalPoolDisposed, true);
			assert.strictEqual(agentPanelUiDisposed, true);
		} finally {
			delete require.cache[webviewModulePath];
			graphViewModule.initializeGraphView = originalInitializeGraphView;
			panelDockModule.initializePanelDock = originalInitializePanelDock;
			panelResizeModule.initializePanelResize = originalInitializePanelResize;
			agentPanelUiModule.initializeAgentPanelUi = originalInitializeAgentPanelUi;
			agentTerminalPoolModule.createDefaultAgentTerminalPool =
				originalCreateDefaultAgentTerminalPool;
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

interface AgentPanelUiModule {
	initializeAgentPanelUi: typeof import('../agent/UI/agentPanelUi').initializeAgentPanelUi;
}

interface AgentTerminalPoolModule {
	createDefaultAgentTerminalPool:
		typeof import('../agent/webview/agentTerminalPool').createDefaultAgentTerminalPool;
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
): PersistedWebviewState {
	return {
		panel: {
			preferredDock,
			sideSize: 440,
			verticalSize: 260,
		},
		graph: {
			camera: { x, y, scale },
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
		},
	};
}
