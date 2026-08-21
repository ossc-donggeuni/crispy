import * as assert from 'assert';
import {
	CrispyExtensionApi,
	TerminalMessageHost,
	createCanvasRuntime,
	createInitialWebviewState,
	handleWebviewMessage as handleHostWebviewMessage,
	loadWorkspacePersistentStateForRoots,
	persistWorkspacePersistentStateForRoots,
} from '../extension';
import type {
	ExtensionToWebviewMessage,
	WebviewToExtensionMessage,
} from '../messages';
import {
	createDefaultWebviewSessionState,
	parseWebviewSessionState,
	serializeWebviewState,
	type PersistedWebviewState,
	type WebviewSessionState,
} from '../webview/webviewState';
import {
	createDefaultWorkspacePersistentState,
	parseWorkspacePersistentState,
	type WorkspacePersistentState,
} from '../workspace/workspaceMetadata';
import { deserializeGraphFromWebview } from '../webview/graph/graphTransport';
import type { Graph } from '../webview/graph/graphModel';
import {
	createCurrentWorkspaceGraph,
	createWorkspaceRefreshCoordinator,
} from '../workspace/workspaceRefresh';

import * as vscode from 'vscode';

const COMMAND_ID = 'crispy.openCanvas';

/** handleWebviewMessage가 호출하는 Host 경계를 그대로 만족하는 테스트 대역이다. */
interface TerminalHostStub extends TerminalMessageHost {
	handleTerminalReady(
		tabId: string,
		cols: number,
		rows: number,
	): Promise<unknown>;
	restartSession(tabId: string, sessionId: string): Promise<unknown>;
	restartMcpSession(tabId: string, sessionId: string): Promise<unknown>;
	createTab(tabId: string): void;
	switchTab(tabId: string): void;
	closeTab(tabId: string): void;
	switchAgent(
		tabId: string,
		providerId: Parameters<TerminalMessageHost['switchAgent']>[1],
	): Promise<unknown>;
	resetAgent(tabId: string): void;
	routeInput(message: unknown): void;
	routeResize(message: unknown): void;
}

/** Host 경계 호출을 type과 인자만 남겨 기록한 항목이다. */
interface TerminalHostCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

/**
 * 모든 Host 경계 호출을 기록하는 대역을 만든다.
 *
 * @returns 대역과 호출 기록을 함께 담은 객체
 */
function createTerminalHostStub(): {
	readonly host: TerminalHostStub;
	readonly calls: TerminalHostCall[];
} {
	const calls: TerminalHostCall[] = [];
	const record = (method: string, ...args: unknown[]): void => {
		calls.push({ method, args });
	};

	return {
		calls,
		host: {
			async handleTerminalReady(tabId, cols, rows) {
				record('handleTerminalReady', tabId, cols, rows);
			},
			async restartSession(tabId, sessionId) {
				record('restartSession', tabId, sessionId);
			},
			async restartMcpSession(tabId, sessionId) {
				record('restartMcpSession', tabId, sessionId);
			},
			createTab: (tabId) => record('createTab', tabId),
			switchTab: (tabId) => record('switchTab', tabId),
			closeTab: (tabId) => record('closeTab', tabId),
			async switchAgent(tabId, providerId) {
				record('switchAgent', tabId, providerId);
			},
			resetAgent: (tabId) => record('resetAgent', tabId),
			routeInput: (message) => record('routeInput', message),
			routeResize: (message) => record('routeResize', message),
		},
	};
}

suite('Crispy Extension Host', () => {
	let extension: vscode.Extension<CrispyExtensionApi>;
	let extensionModule: CrispyExtensionApi;

	suiteSetup(async () => {
		const installedExtension = vscode.extensions.all.find((candidate) =>
			candidate.packageJSON.name === 'crispy'
			&& candidate.packageJSON.contributes?.commands?.some(
				(command: { command?: string }) => command.command === COMMAND_ID,
			),
		);

		assert.ok(installedExtension, 'Crispy extension을 Extension Host에서 찾을 수 있어야 한다.');
		extension = installedExtension as vscode.Extension<CrispyExtensionApi>;
		extensionModule = await extension.activate();
		assert.strictEqual(extensionModule, extension.exports);
	});

	setup(async () => {
		await extensionModule.deactivate();
	});

	teardown(async () => {
		await extensionModule.deactivate();
	});

	test('Extension을 활성화하고 manifest의 Canvas command를 등록한다', async () => {
		assert.strictEqual(extension.isActive, true);

		const manifestCommands = extension.packageJSON.contributes.commands as Array<{
			command: string;
		}>;
		assert.ok(
			manifestCommands.some(({ command }) => command === COMMAND_ID),
		);

		const registeredCommands = await vscode.commands.getCommands(true);
		assert.ok(registeredCommands.includes(COMMAND_ID));
	});

	test('activate 반환 API가 VS Code extension exports와 같은 instance다', () => {
		assert.strictEqual(extensionModule, extension.exports);
		assert.strictEqual(Object.isFrozen(extensionModule), true);
		assert.strictEqual(typeof extensionModule.requestWorkspaceRefresh, 'function');
	});

	test('Workspace Refresh 진입점이 열린 Canvas runtime을 유지한 채 완료된다', async () => {
		const panel = await openCanvas();

		await extensionModule.requestWorkspaceRefresh();

		assert.strictEqual(await openCanvas(), panel);
	});

	test('Canvas가 없거나 종료된 동안 Refresh는 no-op이고 새 Canvas에서 다시 동작한다', async () => {
		await assert.doesNotReject(extensionModule.requestWorkspaceRefresh());
		const oldPanel = await openCanvas();

		await disposePanel(oldPanel);
		await assert.doesNotReject(extensionModule.requestWorkspaceRefresh());
		const newPanel = await openCanvas();

		await extensionModule.requestWorkspaceRefresh();
		assert.strictEqual(await openCanvas(), newPanel);
	});

	test('Canvas runtime은 watcher callback만 기존 Refresh 진입점에 연결하고 함께 dispose한다', () => {
		const watcher = createWorkspaceWatcherStub();
		let refreshRequests = 0;
		let refreshDisposals = 0;
		let terminalDetachments = 0;
		let messageDisposals = 0;
		const runtime = createCanvasRuntime(
			{} as vscode.WebviewPanel,
			{
				detach: () => terminalDetachments += 1,
				terminate: () => undefined,
			},
			[{ dispose: () => messageDisposals += 1 }],
			{
				requestWorkspaceRefresh() {
					refreshRequests += 1;
					return Promise.resolve();
				},
				dispose: () => refreshDisposals += 1,
			},
			watcher.watch,
		);

		assert.strictEqual(watcher.watchCalls, 1);
		assert.strictEqual(refreshRequests, 0);
		runtime.markWebviewReady();
		assert.strictEqual(refreshRequests, 0);

		watcher.fireWorkspaceChange();
		assert.strictEqual(refreshRequests, 1);

		runtime.detach();
		assert.strictEqual(refreshDisposals, 1);
		assert.strictEqual(terminalDetachments, 1);
		assert.strictEqual(messageDisposals, 1);
		assert.strictEqual(watcher.disposeCalls, 1);

		watcher.fireWorkspaceChange();
		runtime.detach();
		assert.strictEqual(refreshRequests, 1);
		assert.strictEqual(watcher.disposeCalls, 1);
	});

	test('초기 Graph 생성 중 변경은 ready 전 전송하지 않고 최신 Graph로 후속 Refresh한다', async () => {
		const initialSnapshot = createDeferred<void>();
		const watcher = createWorkspaceWatcherStub();
		const staleGraph: Graph = { roots: [], rootNodes: {} };
		const latestGraph: Graph = { roots: [], rootNodes: {} };
		const graphMessages: Graph[] = [];
		let snapshotCalls = 0;
		let conversionCalls = 0;
		const dependencies = {
			async createWorkspaceSnapshot() {
				snapshotCalls += 1;
				if (snapshotCalls === 1) {
					await initialSnapshot.promise;
				}

				return { roots: [] };
			},
			convertWorkspaceSnapshotToGraph() {
				conversionCalls += 1;
				return conversionCalls === 1 ? staleGraph : latestGraph;
			},
			async postMessage(message: { graph: Graph }) {
				graphMessages.push(message.graph);
				return true;
			},
		};
		const coordinator = createWorkspaceRefreshCoordinator(dependencies);
		const runtime = createCanvasRuntime(
			{} as vscode.WebviewPanel,
			{ detach: () => undefined, terminate: () => undefined },
			[],
			coordinator,
			watcher.watch,
		);
		const initialGraphPromise = createCurrentWorkspaceGraph(dependencies);

		await waitFor(() => snapshotCalls === 1);
		watcher.fireWorkspaceChange();
		assert.deepStrictEqual(graphMessages, []);

		initialSnapshot.resolve();
		assert.strictEqual(await initialGraphPromise, staleGraph);
		assert.deepStrictEqual(graphMessages, []);

		runtime.markWebviewReady();
		await waitFor(() => graphMessages.length === 1);

		assert.strictEqual(snapshotCalls, 2);
		assert.strictEqual(graphMessages[0], latestGraph);
		runtime.detach();
	});

	test('연속 watcher callback은 기존 Coordinator의 pending Refresh로 병합된다', async () => {
		const firstSnapshot = createDeferred<void>();
		const watcher = createWorkspaceWatcherStub();
		let snapshotCalls = 0;
		let graphMessages = 0;
		const coordinator = createWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				snapshotCalls += 1;
				if (snapshotCalls === 1) {
					await firstSnapshot.promise;
				}

				return { roots: [] };
			},
			convertWorkspaceSnapshotToGraph: () => ({
				roots: [],
				rootNodes: {},
			}),
			async postMessage() {
				graphMessages += 1;
				return true;
			},
		});
		const runtime = createCanvasRuntime(
			{} as vscode.WebviewPanel,
			{ detach: () => undefined, terminate: () => undefined },
			[],
			coordinator,
			watcher.watch,
		);
		runtime.markWebviewReady();

		watcher.fireWorkspaceChange();
		await waitFor(() => snapshotCalls === 1);
		watcher.fireWorkspaceChange();
		watcher.fireWorkspaceChange();

		assert.strictEqual(snapshotCalls, 1);
		firstSnapshot.resolve();
		await waitFor(() => graphMessages === 2);

		assert.strictEqual(snapshotCalls, 2);
		assert.strictEqual(graphMessages, 2);
		runtime.detach();
	});

	test('Canvas command가 실제 설정으로 WebviewPanel을 최초 생성한다', async () => {
		const panel = await openCanvas();

		assert.strictEqual(panel.viewType, 'crispy.webview');
		assert.strictEqual(panel.title, 'Crispy');
		assert.strictEqual(panel.viewColumn, vscode.ViewColumn.One);
		assert.strictEqual(panel.webview.options.enableScripts, true);
		assert.deepStrictEqual(
			panel.webview.options.localResourceRoots?.map((uri) => uri.toString()),
			[vscode.Uri.joinPath(extension.extensionUri, 'dist', 'webview').toString()],
		);
		assert.match(
			panel.webview.html,
			/default-src 'none'; img-src [^;]+; style-src [^;]+; style-src-elem [^;]+ 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src [^;]+;/,
		);
		assert.doesNotMatch(
			panel.webview.html,
			/style-src [^;]*'unsafe-inline'/,
		);
		assert.doesNotMatch(
			panel.webview.html,
			/script-src [^;]*'(?:unsafe-inline|unsafe-eval)'/,
		);
		assert.doesNotMatch(panel.webview.html, /'unsafe-eval'/);
		assert.ok(panel.webview.html.includes('<section id="agent-chat-area">'));
		/* 탭별 Terminal 표면은 Webview가 탭마다 만들어 이 컨테이너 안에 넣는다. */
		assert.ok(panel.webview.html.includes('<div id="agent-terminal-area">'));
		assert.ok(
			panel.webview.html.includes('<div id="agent-provider-picker-host" hidden></div>'),
		);
		assert.ok(!panel.webview.html.includes('agent-provider-bar'));
		assert.ok(
			panel.webview.html.includes(`img-src ${panel.webview.cspSource};`),
		);
	});

	test('Canvas command가 현재 Workspace Root를 Graph 초기 데이터로 전달한다', async () => {
		const panel = await openCanvas();
		const graph = getInitialWorkspaceGraph(panel);
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

		assert.strictEqual(graph.roots.length, workspaceFolders.length);
		for (const [index, workspaceFolder] of workspaceFolders.entries()) {
			const projectId = `workspace-root:${workspaceFolder.uri.toString()}`;
			const graphRoot = graph.roots[index];
			const project = graph.rootNodes[projectId];

			assert.deepStrictEqual(graphRoot, {
				id: `root:${projectId}`,
				nodeId: projectId,
			});
			assert.ok(project && project.kind === 'project');
			assert.strictEqual(project.name, workspaceFolder.name);
			assert.strictEqual(project.status, 'loaded');
		}
	});

	test('Host 메모리가 없는 새 실행은 Workspace metadata와 기본 Session을 조합한다', () => {
		const workspaceState = createWorkspacePersistentState();

		assert.deepStrictEqual(
			createInitialWebviewState(undefined, workspaceState),
			createPersistedStateFromSession(
				createDefaultWebviewSessionState(),
				workspaceState,
			),
		);
	});

	test('Multi-root metadata를 병합하고 한 Root의 read 실패를 격리한다', async () => {
		const frontendUri = vscode.Uri.file('/workspace/frontend');
		const backendUri = vscode.Uri.file('/workspace/backend');
		const frontendState = createWorkspacePersistentStateForRoot(
			frontendUri,
			2,
		);
		const backendState = createWorkspacePersistentStateForRoot(backendUri, 4);
		const states = new Map([
			[frontendUri.toString(), frontendState],
			[backendUri.toString(), backendState],
		]);
		const merged = await loadWorkspacePersistentStateForRoots(
			[frontendUri, backendUri],
			async (rootUri) => states.get(rootUri.toString())
				?? createDefaultWorkspacePersistentState(),
		);

		assert.deepStrictEqual(merged, mergeWorkspaceStates(
			frontendState,
			backendState,
		));

		const isolated = await loadWorkspacePersistentStateForRoots(
			[frontendUri, backendUri],
			async (rootUri) => {
				if (rootUri.toString() === frontendUri.toString()) {
					throw new Error('frontend read failed');
				}

				return backendState;
			},
		);

		assert.deepStrictEqual(isolated, backendState);
	});

	test('Workspace snapshot을 Root별로 write하고 실패 Root만 warning으로 격리한다', async () => {
		const frontendUri = vscode.Uri.file('/workspace/frontend');
		const backendUri = vscode.Uri.file('/workspace/backend');
		const frontendState = createWorkspacePersistentStateForRoot(
			frontendUri,
			2,
		);
		const hiddenFolderId = `folder:${vscode.Uri.joinPath(
			frontendUri,
			'private',
		).toString()}`;
		frontendState.nodePositions[hiddenFolderId] = { x: 900, y: 500 };
		frontendState.openedFolders[hiddenFolderId] = true;
		const backendState = createWorkspacePersistentStateForRoot(backendUri, 4);
		const writes: Array<{
			readonly rootUri: vscode.Uri;
			readonly state: WorkspacePersistentState;
		}> = [];
		const warnings: unknown[][] = [];

		await assert.doesNotReject(persistWorkspacePersistentStateForRoots(
			mergeWorkspaceStates(frontendState, backendState),
			[frontendUri, backendUri],
			async (rootUri, state) => {
				writes.push({ rootUri, state });
				if (rootUri.toString() === frontendUri.toString()) {
					throw new Error('frontend write failed');
				}
			},
			{ warn: (...values) => warnings.push(values) },
		));

		assert.deepStrictEqual(
			writes.map(({ rootUri }) => rootUri.toString()),
			[frontendUri.toString(), backendUri.toString()],
		);
		assert.deepStrictEqual(writes[0]?.state, frontendState);
		assert.deepStrictEqual(writes[1]?.state, backendState);
		assert.deepStrictEqual(
			writes[0]?.state.nodePositions[hiddenFolderId],
			{ x: 900, y: 500 },
		);
		assert.strictEqual(warnings.length, 1);
		assert.match(String(warnings[0]?.[0]), /frontend/);
	});

	test('열린 Canvas command를 다시 실행하면 같은 Panel을 재사용한다', async () => {
		const firstPanel = await openCanvas();
		const secondPanel = await openCanvas();

		assert.strictEqual(secondPanel, firstPanel);
	});

	test('Panel을 dispose한 뒤 Canvas command가 새 Panel을 생성한다', async () => {
		const disposedPanel = await openCanvas();
		await disposePanel(disposedPanel);

		const recreatedPanel = await openCanvas();

		assert.notStrictEqual(recreatedPanel, disposedPanel);
		assert.strictEqual(recreatedPanel.viewType, 'crispy.webview');
	});

	test('deactivate가 열린 Panel과 참조를 정리해 다음 생성에 영향을 주지 않는다', async () => {
		const deactivatedPanel = await openCanvas();
		const disposed = onceDisposed(deactivatedPanel);

		const deactivation = extensionModule.deactivate();
		await disposed;

		const recreatedPanel = await openCanvas();
		assert.notStrictEqual(recreatedPanel, deactivatedPanel);
		await deactivation;
		assert.strictEqual(await openCanvas(), recreatedPanel);
	});

	test('Panel이 hidden 상태가 되어도 dispose하지 않고 같은 Panel을 다시 표시한다', async () => {
		const panel = await openCanvas();
		let panelDisposed = false;
		panel.onDidDispose(() => {
			panelDisposed = true;
		});

		const document = await vscode.workspace.openTextDocument({ content: '' });
		await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
		assert.strictEqual(panel.visible, false);

		const revealedPanel = await openCanvas();

		assert.strictEqual(revealedPanel, panel);
		assert.strictEqual(panelDisposed, false);
	});

	test('deactivate가 상한 시간 안에 반환하고 반복 호출에도 실패하지 않는다', async () => {
		const panel = await openCanvas();
		const disposed = onceDisposed(panel);

		await extensionModule.deactivate();
		await disposed;
		await extensionModule.deactivate();

		const recreatedPanel = await openCanvas();
		assert.notStrictEqual(recreatedPanel, panel);
	});

	test('Panel dispose 후 Webview Session state를 복원하고 deactivate 시 초기화한다', async () => {
		const changedState: WebviewSessionState = {
			panel: {
				preferredDock: 'left',
				sideSize: 480,
				verticalSize: 260,
				collapsed: true,
			},
			camera: { x: 120, y: -45, scale: 1.5 },
		};
		const expectedInitialState = createPersistedStateFromSession(changedState);
		const initialPanel = await openCanvas();

		await sendWebviewState(initialPanel, changedState);
		await disposePanel(initialPanel);

		const restoredPanel = await openCanvas();
		assert.strictEqual(
			getSerializedInitialWebviewState(restoredPanel),
			serializeWebviewState(expectedInitialState),
		);

		await sendWebviewState(restoredPanel, changedState);
		const disposed = onceDisposed(restoredPanel);
		const deactivation = extensionModule.deactivate();
		await disposed;
		await deactivation;

		const panelAfterDeactivate = await openCanvas();
		assert.strictEqual(
			getSerializedInitialWebviewState(panelAfterDeactivate),
			serializeWebviewState(createPersistedStateFromSession(
				createDefaultWebviewSessionState(),
			)),
		);
	});

	test('workspace.stateChanged 후 Panel 재생성 시 Workspace 상태를 유지한다', async () => {
		const workspaceState = createWorkspacePersistentState();
		const panel = await openCanvas();

		await sendWorkspaceState(panel, workspaceState);
		await disposePanel(panel);

		const restoredPanel = await openCanvas();
		assert.strictEqual(
			getSerializedInitialWebviewState(restoredPanel),
			serializeWebviewState(createPersistedStateFromSession(
				createDefaultWebviewSessionState(),
				workspaceState,
			)),
		);
	});

	test('Session 뒤 Workspace 변경이 Panel/Camera와 Workspace 상태를 서로 덮어쓰지 않는다', async () => {
		const sessionState: WebviewSessionState = {
			panel: {
				preferredDock: 'top',
				sideSize: 510,
				verticalSize: 330,
				collapsed: true,
			},
			camera: { x: 210, y: -95, scale: 1.75 },
		};
		const workspaceState = createWorkspacePersistentState();
		const panel = await openCanvas();

		await sendWebviewState(panel, sessionState);
		await sendWorkspaceState(panel, workspaceState);
		await disposePanel(panel);

		const restoredPanel = await openCanvas();
		assert.strictEqual(
			getSerializedInitialWebviewState(restoredPanel),
			serializeWebviewState(createPersistedStateFromSession(
				sessionState,
				workspaceState,
			)),
		);
	});

	test('잘못된 webview.stateChanged snapshot은 마지막 유효 상태를 덮어쓰지 않는다', async () => {
		const changedState: WebviewSessionState = {
			panel: {
				preferredDock: 'bottom',
				sideSize: 410,
				verticalSize: 290,
				collapsed: false,
			},
			camera: { x: -80, y: 65, scale: 2 },
		};
		const panel = await openCanvas();

		await sendWebviewState(panel, changedState);
		extensionModule.handleWebviewMessage(panel.webview, {
			type: 'webview.stateChanged',
			state: {
				panel: changedState.panel,
				camera: { x: 0, y: 0, scale: Number.NaN },
			},
		});
		await disposePanel(panel);

		const restoredPanel = await openCanvas();
		assert.strictEqual(
			getSerializedInitialWebviewState(restoredPanel),
			serializeWebviewState(createPersistedStateFromSession(changedState)),
		);
	});

	test('webview.ready에 extension.ready로 응답한다', async () => {
		const postedMessages: ExtensionToWebviewMessage[] = [];
		let readyNotifications = 0;
		const webview = {
			postMessage: (message: ExtensionToWebviewMessage) => {
				postedMessages.push(message);
				return Promise.resolve(true);
			},
		};

		const result = handleHostWebviewMessage(
			webview,
			{ type: 'webview.ready' },
			undefined,
			() => readyNotifications += 1,
		);

		assert.ok(result);
		assert.strictEqual(await result, true);
		assert.strictEqual(readyNotifications, 1);
		assert.deepStrictEqual(postedMessages, [{ type: 'extension.ready' }]);
	});

	test('검증되지 않은 ready payload를 반사하지 않고 거부한다', () => {
		const postedMessages: unknown[] = [];
		const webview = {
			postMessage: (message: unknown) => {
				postedMessages.push(message);
				return Promise.resolve(true);
			},
		};

		const result = extensionModule.handleWebviewMessage(webview, {
			type: 'webview.ready',
			cwd: '/sensitive/workspace',
			token: 'sensitive-token',
		});

		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(postedMessages, []);
	});

	test('검증된 input과 resize를 input log 없이 TerminalHost로 전달한다', () => {
		const postedMessages: unknown[] = [];
		const loggedValues: unknown[][] = [];
		const routedInputs: unknown[] = [];
		const routedResizes: unknown[] = [];
		const originalConsoleLog = console.log;
		console.log = (...values: unknown[]) => {
			loggedValues.push(values);
		};

		try {
			const stub = createTerminalHostStub();
			const terminalHost: TerminalHostStub = {
				...stub.host,
				routeInput: (message: unknown) => routedInputs.push(message),
				routeResize: (message: unknown) => routedResizes.push(message),
			};
			const input = {
				type: 'terminal.input',
				tabId: 'tab:one',
				sessionId: 'session-1',
				data: 'authorization code=sensitive-token',
			};
			const resize = {
				type: 'terminal.resize',
				tabId: 'tab:one',
				sessionId: 'session-1',
				cols: 132,
				rows: 43,
			};
			const webview = {
				postMessage: (message: unknown) => {
					postedMessages.push(message);
					return Promise.resolve(true);
				},
			};

			const inputResult = extensionModule.handleWebviewMessage(
				webview,
				input,
				terminalHost,
			);
			const resizeResult = extensionModule.handleWebviewMessage(
				webview,
				resize,
				terminalHost,
			);

			assert.strictEqual(inputResult, undefined);
			assert.strictEqual(resizeResult, undefined);
		} finally {
			console.log = originalConsoleLog;
		}

		assert.deepStrictEqual(postedMessages, []);
		assert.deepStrictEqual(loggedValues, []);
		assert.strictEqual(routedInputs.length, 1);
		assert.strictEqual(routedResizes.length, 1);
	});

	test('검증된 terminal.ready 값만 TerminalHost ready 경계로 전달한다', () => {
		const { host, calls } = createTerminalHostStub();

		const result = extensionModule.handleWebviewMessage(
			{ postMessage: () => Promise.resolve(true) },
			{
				type: 'terminal.ready',
				tabId: 'tab-ready-dispatch',
				cols: 132,
				rows: 43,
			},
			host,
		);

		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(calls, [{
			method: 'handleTerminalReady',
			args: ['tab-ready-dispatch', 132, 43],
		}]);
	});

	test('검증된 tab 및 agent 메시지를 대응하는 Host 경계로 전달한다', () => {
		const { host, calls } = createTerminalHostStub();
		const messages = [
			{ type: 'tab.create', tabId: 'tab-lifecycle' },
			{ type: 'tab.switch', tabId: 'tab-lifecycle' },
			{ type: 'agent.switch', tabId: 'tab-lifecycle', providerId: 'codex' },
			{ type: 'agent.reset', tabId: 'tab-lifecycle' },
			{ type: 'tab.close', tabId: 'tab-lifecycle' },
		];

		for (const message of messages) {
			const result = extensionModule.handleWebviewMessage(
				{ postMessage: () => Promise.resolve(true) },
				message,
				host,
			);
			assert.strictEqual(result, undefined);
		}

		assert.deepStrictEqual(calls, [
			{ method: 'createTab', args: ['tab-lifecycle'] },
			{ method: 'switchTab', args: ['tab-lifecycle'] },
			{ method: 'switchAgent', args: ['tab-lifecycle', 'codex'] },
			{ method: 'resetAgent', args: ['tab-lifecycle'] },
			{ method: 'closeTab', args: ['tab-lifecycle'] },
		]);
	});

	test('allowlist 밖 provider의 agent.switch는 Host 경계 전에 거부한다', () => {
		const { host, calls } = createTerminalHostStub();

		const result = extensionModule.handleWebviewMessage(
			{ postMessage: () => Promise.resolve(true) },
			{
				type: 'agent.switch',
				tabId: 'tab-unknown-provider',
				providerId: 'unlisted-provider',
			},
			host,
		);

		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(calls, []);
	});

	test('검증된 terminal.restart의 소유 관계만 TerminalHost restart 경계로 전달한다', () => {
		const { host, calls } = createTerminalHostStub();

		const result = extensionModule.handleWebviewMessage(
			{ postMessage: () => Promise.resolve(true) },
			{
				type: 'terminal.restart',
				tabId: 'tab-restart-dispatch',
				sessionId: 'session-restart-dispatch',
			},
			host,
		);

		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(calls, [{
			method: 'restartSession',
			args: ['tab-restart-dispatch', 'session-restart-dispatch'],
		}]);
	});

	test('검증된 mcp.restart의 tab/session만 명시적 MCP restart 경계로 전달한다', () => {
		const { host, calls } = createTerminalHostStub();
		const result = extensionModule.handleWebviewMessage(
			{ postMessage: () => Promise.resolve(true) },
			{
				type: 'mcp.restart',
				tabId: 'tab-mcp-restart-dispatch',
				sessionId: 'session-mcp-restart-dispatch',
			},
			host,
		);

		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(calls, [{
			method: 'restartMcpSession',
			args: ['tab-mcp-restart-dispatch', 'session-mcp-restart-dispatch'],
		}]);
	});

	test('실행 계약을 포함한 terminal.restart는 restart 경계 전에 거부한다', () => {
		const { host: terminalHost, calls } = createTerminalHostStub();

		for (const forbidden of [
			{ executable: '/host/owned/shell' },
			{ cwd: '/workspace/root' },
			{ env: { FORCE_COLOR: '1' } },
			{ args: ['--login'] },
			{ pid: 4242 },
		]) {
			const result = extensionModule.handleWebviewMessage(
				{ postMessage: () => Promise.resolve(true) },
				{
					type: 'terminal.restart',
					tabId: 'tab-restart-forbidden',
					sessionId: 'session-restart-forbidden',
					...forbidden,
				},
				terminalHost,
			);

			assert.strictEqual(result, undefined);
		}

		assert.deepStrictEqual(calls, []);
	});

	test('실행 계약을 포함한 terminal.ready는 ready 경계 전에 거부한다', () => {
		const { host: terminalHost, calls } = createTerminalHostStub();

		const result = extensionModule.handleWebviewMessage(
			{ postMessage: () => Promise.resolve(true) },
			{
				type: 'terminal.ready',
				tabId: 'tab-forbidden-ready',
				cols: 80,
				rows: 24,
				executable: '/webview/controlled/shell',
				cwd: '/webview/controlled/workspace',
			},
			terminalHost,
		);

		assert.strictEqual(result, undefined);
		assert.deepStrictEqual(calls, []);
	});
});

/** Canvas runtime 조립에서 Workspace watcher 등록과 dispose를 관찰한다. */
function createWorkspaceWatcherStub() {
	let listener: (() => void) | undefined;
	let disposed = false;
	let watchCalls = 0;
	let disposeCalls = 0;

	return {
		get watchCalls(): number {
			return watchCalls;
		},
		get disposeCalls(): number {
			return disposeCalls;
		},
		watch(onChange: () => void): vscode.Disposable {
			watchCalls += 1;
			listener = onChange;

			return {
				dispose(): void {
					if (disposed) {
						return;
					}
					disposed = true;
					disposeCalls += 1;
				},
			};
		},
		fireWorkspaceChange(): void {
			if (!disposed) {
				listener?.();
			}
		},
	};
}

/** 비동기 Refresh 경계를 테스트에서 명시적으로 완료한다. */
function createDeferred<Value>(): {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value) => void;
} {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((resolvePromise) => {
		resolve = resolvePromise;
	});

	return { promise, resolve };
}

/** Coordinator microtask가 기대 상태에 도달할 때까지 제한적으로 진행한다. */
async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
		await Promise.resolve();
	}

	assert.strictEqual(predicate(), true);
}

async function openCanvas(): Promise<vscode.WebviewPanel> {
	const panel = await vscode.commands.executeCommand<vscode.WebviewPanel>(COMMAND_ID);
	assert.ok(panel, `${COMMAND_ID} command가 생성하거나 재사용한 Panel을 반환해야 한다.`);
	return panel;
}

function onceDisposed(panel: vscode.WebviewPanel): Promise<void> {
	return new Promise((resolve) => {
		panel.onDidDispose(resolve);
	});
}

async function disposePanel(panel: vscode.WebviewPanel): Promise<void> {
	const disposed = onceDisposed(panel);
	panel.dispose();
	await disposed;
}

async function sendWebviewState(
	panel: vscode.WebviewPanel,
	state: WebviewSessionState,
): Promise<void> {
	const message: WebviewToExtensionMessage = {
		type: 'webview.stateChanged',
		state,
	};
	const received = onceWebviewMessage(
		panel.webview,
		(candidate) => getWebviewStateFromMessage(candidate) !== undefined,
	);

	panel.webview.html = createMessagePostingHtml(message);

	assert.deepStrictEqual(
		getWebviewStateFromMessage(await received),
		state,
	);
}

async function sendWorkspaceState(
	panel: vscode.WebviewPanel,
	state: WorkspacePersistentState,
): Promise<void> {
	const message: WebviewToExtensionMessage = {
		type: 'workspace.stateChanged',
		state,
	};
	const received = onceWebviewMessage(
		panel.webview,
		(candidate) => getWorkspaceStateFromMessage(candidate) !== undefined,
	);

	panel.webview.html = createMessagePostingHtml(message);

	assert.deepStrictEqual(
		getWorkspaceStateFromMessage(await received),
		state,
	);
}

function getWebviewStateFromMessage(
	message: unknown,
): WebviewSessionState | undefined {
	if (!message || typeof message !== 'object') {
		return undefined;
	}

	const candidate = message as Record<string, unknown>;

	return candidate.type === 'webview.stateChanged'
		? parseWebviewSessionState(candidate.state)
		: undefined;
}

function getWorkspaceStateFromMessage(
	message: unknown,
): WorkspacePersistentState | undefined {
	if (!message || typeof message !== 'object') {
		return undefined;
	}

	const candidate = message as Record<string, unknown>;

	return candidate.type === 'workspace.stateChanged'
		? parseWorkspacePersistentState(candidate.state)
		: undefined;
}

function createPersistedStateFromSession(
	state: WebviewSessionState,
	workspaceState?: WorkspacePersistentState,
): PersistedWebviewState {
	return {
		panel: state.panel,
		graph: {
			camera: state.camera,
			nodePositions: workspaceState?.nodePositions ?? {},
			fileGroupPages: workspaceState?.fileGroupPages ?? {},
			openedFolders: workspaceState?.openedFolders ?? {},
			detachedRootNodeIds: workspaceState?.detachedRootNodeIds ?? {},
			hiddenNodeIds: workspaceState?.hiddenNodeIds ?? {},
		},
	};
}

function createWorkspacePersistentState(): WorkspacePersistentState {
	return {
		version: 1,
		nodePositions: {
			'folder:file:///workspace/app/src': { x: 640, y: 280 },
		},
		fileGroupPages: {
			'folder:file:///workspace/app/src:files': 3,
		},
		openedFolders: {
			'folder:file:///workspace/app/src': true,
		},
		detachedRootNodeIds: {
			'file:file:///workspace/app/index.ts': true,
		},
		hiddenNodeIds: {
			'folder:file:///workspace/app/private': true,
		},
	};
}

function createWorkspacePersistentStateForRoot(
	rootUri: vscode.Uri,
	page: number,
): WorkspacePersistentState {
	const folderId = `folder:${vscode.Uri.joinPath(rootUri, 'src').toString()}`;
	const fileId = `file:${vscode.Uri.joinPath(
		rootUri,
		'src',
		'index.ts',
	).toString()}`;

	return {
		version: 1,
		nodePositions: { [folderId]: { x: page * 100, y: page * 50 } },
		fileGroupPages: { [`${folderId}:files`]: page },
		openedFolders: { [folderId]: true },
		detachedRootNodeIds: { [fileId]: true },
		hiddenNodeIds: { [folderId]: true },
	};
}

function mergeWorkspaceStates(
	...states: readonly WorkspacePersistentState[]
): WorkspacePersistentState {
	return {
		version: 1,
		nodePositions: Object.assign({}, ...states.map((state) => state.nodePositions)),
		fileGroupPages: Object.assign({}, ...states.map((state) => state.fileGroupPages)),
		openedFolders: Object.assign({}, ...states.map((state) => state.openedFolders)),
		detachedRootNodeIds: Object.assign(
			{},
			...states.map((state) => state.detachedRootNodeIds),
		),
		hiddenNodeIds: Object.assign(
			{},
			...states.map((state) => state.hiddenNodeIds),
		),
	};
}

function onceWebviewMessage(
	webview: vscode.Webview,
	predicate: (message: unknown) => boolean,
): Promise<unknown> {
	return new Promise((resolve) => {
		const subscription = webview.onDidReceiveMessage((message: unknown) => {
			if (!predicate(message)) {
				return;
			}

			subscription.dispose();
			resolve(message);
		});
	});
}

function createMessagePostingHtml(message: WebviewToExtensionMessage): string {
	const serializedMessage = JSON.stringify(message).replaceAll('<', '\\u003c');

	return `<!DOCTYPE html>
		<html lang="en">
		<body>
			<script>
				acquireVsCodeApi().postMessage(${serializedMessage});
			</script>
		</body>
		</html>`;
}

function getSerializedInitialWebviewState(panel: vscode.WebviewPanel): string {
	const match = panel.webview.html.match(/data-webview-state="([^"]*)"/);
	assert.ok(match, 'Webview 초기 HTML에 serialized Webview state가 있어야 한다.');
	return match[1];
}

function getInitialWorkspaceGraph(panel: vscode.WebviewPanel): Graph {
	const match = panel.webview.html.match(/data-workspace-graph="([^"]*)"/);
	assert.ok(match, 'Webview 초기 HTML에 serialized Workspace Graph가 있어야 한다.');
	return deserializeGraphFromWebview(match[1]);
}
