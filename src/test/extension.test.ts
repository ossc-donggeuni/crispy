import * as assert from 'assert';
import type {
	CrispyExtensionApi,
	TerminalMessageHost,
} from '../extension';
import type {
	ExtensionToWebviewMessage,
	WebviewToExtensionMessage,
} from '../messages';
import {
	parseWebviewState,
	serializeWebviewState,
	type PersistedWebviewState,
} from '../webview/webviewState';
import { deserializeGraphFromWebview } from '../webview/graph/graphTransport';
import type { Graph } from '../webview/graph/graphModel';

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

	test('Panel dispose 후 전체 Webview state를 복원하고 deactivate 시 초기화한다', async () => {
		const changedState: PersistedWebviewState = {
			panel: {
				preferredDock: 'left',
				sideSize: 480,
				verticalSize: 260,
				collapsed: true,
			},
			graph: {
				camera: { x: 120, y: -45, scale: 1.5 },
				nodePositions: {},
				fileGroupPages: {},
				openedFolders: { 'folder:src': true },
				detachedRootNodeIds: { 'folder:src': true },
			},
		};
		const initialPanel = await openCanvas();

		await sendWebviewState(initialPanel, changedState);
		await disposePanel(initialPanel);

		const restoredPanel = await openCanvas();
		assert.strictEqual(
			getSerializedInitialWebviewState(restoredPanel),
			serializeWebviewState(changedState),
		);

		await sendWebviewState(restoredPanel, changedState);
		const disposed = onceDisposed(restoredPanel);
		const deactivation = extensionModule.deactivate();
		await disposed;
		await deactivation;

		const panelAfterDeactivate = await openCanvas();
		assert.strictEqual(
			getSerializedInitialWebviewState(panelAfterDeactivate),
			serializeWebviewState(undefined),
		);
	});

	test('잘못된 webview.stateChanged snapshot은 마지막 유효 상태를 덮어쓰지 않는다', async () => {
		const changedState: PersistedWebviewState = {
			panel: {
				preferredDock: 'bottom',
				sideSize: 410,
				verticalSize: 290,
				collapsed: false,
			},
			graph: {
				camera: { x: -80, y: 65, scale: 2 },
				nodePositions: {},
				fileGroupPages: {},
				openedFolders: {},
				detachedRootNodeIds: {},
			},
		};
		const panel = await openCanvas();

		await sendWebviewState(panel, changedState);
		extensionModule.handleWebviewMessage(panel.webview, {
			type: 'webview.stateChanged',
			state: {
				panel: changedState.panel,
				graph: { camera: { x: 0, y: 0, scale: Number.NaN } },
			},
		});
		await disposePanel(panel);

		const restoredPanel = await openCanvas();
		assert.strictEqual(
			getSerializedInitialWebviewState(restoredPanel),
			serializeWebviewState(changedState),
		);
	});

	test('webview.ready에 extension.ready로 응답한다', async () => {
		const postedMessages: ExtensionToWebviewMessage[] = [];
		const webview = {
			postMessage: (message: ExtensionToWebviewMessage) => {
				postedMessages.push(message);
				return Promise.resolve(true);
			},
		};

		const result = extensionModule.handleWebviewMessage(
			webview,
			{ type: 'webview.ready' },
		);

		assert.ok(result);
		assert.strictEqual(await result, true);
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
	state: PersistedWebviewState,
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

function getWebviewStateFromMessage(
	message: unknown,
): PersistedWebviewState | undefined {
	if (!message || typeof message !== 'object') {
		return undefined;
	}

	const candidate = message as Record<string, unknown>;

	return candidate.type === 'webview.stateChanged'
		? parseWebviewState(candidate.state)
		: undefined;
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
