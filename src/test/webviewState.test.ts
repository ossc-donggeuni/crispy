import * as assert from 'assert';
import type { WebviewToExtensionMessage } from '../messages';
import {
	createGraphState,
	INITIAL_GRAPH_STATE,
} from '../webview/graph/graphState';
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
	});

	test('저장한 Camera를 getState 결과로 제공해 새 Graph State 초기화에 복원한다', () => {
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
		});

		assert.deepStrictEqual(api.getState(), {
			panel: DEFAULT_PANEL_LAYOUT_STATE,
			graph: {
				camera: { x: 513, y: 324, scale: 1.2 },
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
	});
});

suite('Webview State Wiring', () => {
	test('Graph와 Panel 변경을 전체 Webview snapshot 저장 및 Host 메시지로 연결한다', () => {
		const initialState = createWebviewState('left', 35, -25, 1.25);
		const nextGraphState = {
			camera: { x: 120, y: -60, scale: 2 },
		};
		const savedStates: PersistedWebviewState[] = [];
		const postedMessages: WebviewToExtensionMessage[] = [];
		let currentGraphState = initialState.graph;
		let graphSubscriber: ((state: typeof currentGraphState) => void) | undefined;
		let panelState: PanelLayoutState | undefined;
		let persistPanelState: (() => void) | undefined;

		const graphViewModulePath = require.resolve('../webview/graph/graphView');
		const panelDockModulePath = require.resolve('../webview/panel/panelDock');
		const panelResizeModulePath = require.resolve('../webview/panel/panelResize');
		const webviewModulePath = require.resolve('../webview/webview');
		const graphViewModule = require(graphViewModulePath) as GraphViewModule;
		const panelDockModule = require(panelDockModulePath) as PanelDockModule;
		const panelResizeModule = require(panelResizeModulePath) as PanelResizeModule;
		const originalInitializeGraphView = graphViewModule.initializeGraphView;
		const originalInitializePanelDock = panelDockModule.initializePanelDock;
		const originalInitializePanelResize = panelResizeModule.initializePanelResize;
		const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
		const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
		const originalAcquireVsCodeApi = Object.getOwnPropertyDescriptor(
			globalThis,
			'acquireVsCodeApi',
		);

		graphViewModule.initializeGraphView = ((_root, restoredGraphState) => {
			assert.deepStrictEqual(restoredGraphState, initialState.graph);
			const graphState = restoredGraphState ?? INITIAL_GRAPH_STATE;
			currentGraphState = {
				camera: { ...graphState.camera },
			};

			return {
				state: {
					getState: () => currentGraphState,
					setState: (state) => {
						currentGraphState = {
							camera: { ...state.camera },
						};
					},
					subscribe: (subscriber) => {
						graphSubscriber = subscriber;

						return () => {
							graphSubscriber = undefined;
						};
					},
				},
				camera: {},
				dispose: () => undefined,
			};
		}) as typeof graphViewModule.initializeGraphView;

		panelDockModule.initializePanelDock = ((
			_layout,
			_dragHandle,
			_dockPreview,
			state,
			onPreferredDockChange,
		) => {
			panelState = state;
			persistPanelState = onPreferredDockChange;

			return () => undefined;
		}) as typeof panelDockModule.initializePanelDock;

		panelResizeModule.initializePanelResize = (() => undefined) as (
			typeof panelResizeModule.initializePanelResize
		);

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
		]);
		const documentMock = {
			currentScript: {
				getAttribute: () => null,
			},
			querySelector: (selector: string) => elements.get(selector) ?? null,
		};
		const windowMock = {
			addEventListener: () => undefined,
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
		} finally {
			delete require.cache[webviewModulePath];
			graphViewModule.initializeGraphView = originalInitializeGraphView;
			panelDockModule.initializePanelDock = originalInitializePanelDock;
			panelResizeModule.initializePanelResize = originalInitializePanelResize;
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
		},
	};
}
