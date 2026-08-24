import * as assert from 'assert';
import {
	AGENT_ACTIVITY_DEBUG_SESSION_IDS,
	CLEAR_AGENT_ACTIVITIES_COMMAND_ID,
	CLEAR_NODE_EFFECTS_COMMAND_ID,
	CrispyExtensionApi,
	DEBUG_AGENT_ACTIVITIES_COMMAND_ID,
	DEBUG_NODE_EFFECTS_COMMAND_ID,
	OPEN_CANVAS_COMMAND_ID,
	TerminalMessageHost,
	WorkspaceFileHost,
	createCanvasRuntime,
	createAgentActivityDebugClearMessages,
	createAgentActivityDebugMessages,
	createGraphNodeEffectDebugMessages,
	createInitialWebviewState,
	handleWebviewMessage as handleHostWebviewMessage,
	loadWorkspacePersistentStateForRoots,
	persistWorkspacePersistentStateForRoots,
	postAgentActivityDebugClearMessages,
	postAgentActivityDebugMessages,
} from '../extension';
import type {
	ExtensionToWebviewMessage,
	WebviewToExtensionMessage,
	WorkspaceToWebviewMessage,
} from '../messages';
import { parseAgentActivityToWebviewMessage } from '../messages';
import {
	createDefaultWebviewSessionState,
	parseWebviewState,
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
import {
	deserializeWorkspacePresentationFromWebview,
	type WorkspacePresentation,
} from '../workspace/workspacePresentation';
import { createGraphLayout } from '../webview/graph/graphLayout';
import {
	createSingleRootGraph,
	type Graph,
} from '../webview/graph/graphModel';
import { addGraphRoot } from '../webview/graph/graphRootPromotion';
import {
	createCurrentWorkspaceGraph,
	createWorkspaceRefreshCoordinator,
} from '../workspace/workspaceRefresh';

import * as vscode from 'vscode';

const COMMAND_ID = OPEN_CANVAS_COMMAND_ID;

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
		workspaceRootId: Parameters<TerminalMessageHost['switchAgent']>[2],
		switchAttemptId: Parameters<TerminalMessageHost['switchAgent']>[3],
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
			async switchAgent(tabId, providerId, workspaceRootId, switchAttemptId) {
				record(
					'switchAgent',
					tabId,
					providerId,
					workspaceRootId,
					switchAttemptId,
				);
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
		assert.ok(manifestCommands.some(
			({ command }) => command === DEBUG_NODE_EFFECTS_COMMAND_ID,
		));
		assert.ok(manifestCommands.some(
			({ command }) => command === CLEAR_NODE_EFFECTS_COMMAND_ID,
		));
		assert.ok(manifestCommands.some(
			({ command }) => command === DEBUG_AGENT_ACTIVITIES_COMMAND_ID,
		));
		assert.ok(manifestCommands.some(
			({ command }) => command === CLEAR_AGENT_ACTIVITIES_COMMAND_ID,
		));

		const registeredCommands = await vscode.commands.getCommands(true);
		assert.ok(registeredCommands.includes(COMMAND_ID));
		assert.ok(registeredCommands.includes(DEBUG_NODE_EFFECTS_COMMAND_ID));
		assert.ok(registeredCommands.includes(CLEAR_NODE_EFFECTS_COMMAND_ID));
		assert.ok(registeredCommands.includes(DEBUG_AGENT_ACTIVITIES_COMMAND_ID));
		assert.ok(registeredCommands.includes(CLEAR_AGENT_ACTIVITIES_COMMAND_ID));
	});

	test('Debug Effect 메시지는 Root 직계 Source 순서대로 6종과 icon 조합에 임의 색을 배정한다', () => {
		const project = {
			kind: 'project' as const,
			id: 'project:debug-effects',
			name: 'debug-effects',
			status: 'loaded' as const,
			children: Array.from({ length: 8 }, (_, index) => ({
				kind: 'file' as const,
				id: `file:debug-effects/${index + 1}.ts`,
				name: `${index + 1}.ts`,
			})),
		};
		const graph: Graph = {
			roots: [{ id: 'root:debug-effects', nodeId: project.id }],
			rootNodes: { [project.id]: project },
		};
		const randomValues = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875];
		let randomIndex = 0;
		const first = createGraphNodeEffectDebugMessages(
			graph,
			{},
			() => randomValues[randomIndex++] ?? 0,
		);
		let updatedRandomCalls = 0;
		const updated = createGraphNodeEffectDebugMessages(graph, {}, () => {
			updatedRandomCalls += 1;
			return 0.999;
		});

		assert.deepStrictEqual(first.map(({ target, effect }) => ({
			nodeId: target.nodeId,
			kind: effect.kind,
			icon: effect.kind === 'icon' ? effect.icon : undefined,
		})), [
			{ nodeId: project.children[0]?.id, kind: 'marching-dash', icon: undefined },
			{ nodeId: project.children[1]?.id, kind: 'pulse', icon: undefined },
			{ nodeId: project.children[2]?.id, kind: 'shimmer', icon: undefined },
			{ nodeId: project.children[3]?.id, kind: 'outline', icon: undefined },
			{ nodeId: project.children[4]?.id, kind: 'outline-strong', icon: undefined },
			{ nodeId: project.children[5]?.id, kind: 'icon', icon: 'check' },
			{ nodeId: project.children[6]?.id, kind: 'outline', icon: undefined },
			{ nodeId: project.children[6]?.id, kind: 'icon', icon: 'alert' },
			{ nodeId: project.children[7]?.id, kind: 'outline', icon: undefined },
			{ nodeId: project.children[7]?.id, kind: 'icon', icon: 'cancel' },
		]);
		assert.deepStrictEqual(
			updated.map(({ effect }) => effect.kind),
			first.map(({ effect }) => effect.kind),
		);
		assert.strictEqual(randomIndex, 8);
		assert.strictEqual(updatedRandomCalls, 8);
		assert.deepStrictEqual(first.map(({ effect }) => effect.color), [
			'hsl(0deg 84% 64%)',
			'hsl(45deg 84% 64%)',
			'hsl(90deg 84% 64%)',
			'hsl(135deg 84% 64%)',
			'hsl(180deg 84% 64%)',
			'hsl(225deg 84% 64%)',
			'hsl(270deg 84% 64%)',
			'hsl(270deg 84% 64%)',
			'hsl(315deg 84% 64%)',
			'hsl(315deg 84% 64%)',
		]);
		assert.ok(updated.every(({ effect }, index) => (
			effect.color !== first[index]?.effect.color
		)));
		assert.deepStrictEqual(
			createGraphNodeEffectDebugMessages({ roots: [], rootNodes: {} }),
			[],
		);
	});

	test('Debug 후보는 Root 직계 File/Folder만 사용하고 nested fallback을 하지 않는다', () => {
		const nestedFolder = {
			kind: 'folder' as const,
			id: 'folder:debug-root/folder-a/nested-folder',
			name: 'nested-folder',
			status: 'loaded' as const,
			children: [],
		};
		const nestedFile = {
			kind: 'file' as const,
			id: 'file:debug-root/folder-a/nested.ts',
			name: 'nested.ts',
		};
		const folderA = {
			kind: 'folder' as const,
			id: 'folder:debug-root/folder-a',
			name: 'folder-a',
			status: 'loaded' as const,
			children: [nestedFolder, nestedFile],
		};
		const rootFile = {
			kind: 'file' as const,
			id: 'file:debug-root/root-file.ts',
			name: 'root-file.ts',
		};
		const folderB = {
			kind: 'folder' as const,
			id: 'folder:debug-root/folder-b',
			name: 'folder-b',
			status: 'loaded' as const,
			children: [],
		};
		const project = {
			kind: 'project' as const,
			id: 'project:debug-root',
			name: 'debug-root',
			status: 'loaded' as const,
			children: [folderA, rootFile, folderB],
		};
		const messages = createGraphNodeEffectDebugMessages({
			roots: [{ id: 'root:debug-root', nodeId: project.id }],
			rootNodes: { [project.id]: project },
		});

		assert.deepStrictEqual(messages.map(({ target }) => target.nodeId), [
			folderA.id,
			rootFile.id,
			folderB.id,
		]);
		assert.strictEqual(messages.some(
			({ target }) => target.nodeId === project.id,
		), false);
		assert.strictEqual(messages.some(
			({ target }) => target.nodeId === nestedFolder.id,
		), false);
		assert.strictEqual(messages.some(
			({ target }) => target.nodeId === nestedFile.id,
		), false);
		assert.deepStrictEqual(messages.map(({ effect }) => effect.kind), [
			'marching-dash',
			'pulse',
			'shimmer',
		]);
	});

	test('Multi-root 직계 자식만 합치고 nested Detached Root와 Backlink를 후보에서 제외한다', () => {
		const nestedFile = {
			kind: 'file' as const,
			id: 'file:debug-root-a/src/a.ts',
			name: 'a.ts',
		};
		const src = {
			kind: 'folder' as const,
			id: 'folder:debug-root-a/src',
			name: 'src',
			status: 'loaded' as const,
			children: [nestedFile],
		};
		const readme = {
			kind: 'file' as const,
			id: 'file:debug-root-a/README.md',
			name: 'README.md',
		};
		const app = {
			kind: 'folder' as const,
			id: 'folder:debug-root-b/app',
			name: 'app',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:debug-root-b/app/main.ts',
				name: 'main.ts',
			}],
		};
		const packageFile = {
			kind: 'file' as const,
			id: 'file:debug-root-b/package.json',
			name: 'package.json',
		};
		const rootA = {
			kind: 'project' as const,
			id: 'project:debug-root-a',
			name: 'debug-root-a',
			status: 'loaded' as const,
			children: [src, readme],
		};
		const rootB = {
			kind: 'project' as const,
			id: 'project:debug-root-b',
			name: 'debug-root-b',
			status: 'loaded' as const,
			children: [app, packageFile],
		};
		const graph: Graph = {
			roots: [
				{ id: 'root:debug-root-a', nodeId: rootA.id },
				{ id: 'root:debug-root-b', nodeId: rootB.id },
			],
			rootNodes: {
				[rootA.id]: rootA,
				[rootB.id]: rootB,
			},
		};
		const addition = addGraphRoot(graph, nestedFile.id);

		assert.ok(addition);
		const messages = createGraphNodeEffectDebugMessages(addition.graph);
		const layout = createGraphLayout(addition.graph, {
			openedFolders: { [rootA.id]: true, [src.id]: true },
		});

		assert.ok(layout.nodes.some((node) => (
			node.kind === 'file-group'
			&& node.children.some((file) => file.presentation === 'backlink')
		)));
		assert.deepStrictEqual(messages.map(({ target }) => target.nodeId), [
			src.id,
			readme.id,
			app.id,
			packageFile.id,
		]);
		assert.strictEqual(messages.some(
			({ target }) => target.nodeId === nestedFile.id,
		), false);
	});

	test('Agent Activity Debug 메시지는 visible Layout 순서와 public set 계약으로 6종 및 Multi-Session 예시를 만든다', () => {
		const groupedFiles = ['a', 'b', 'c', 'd'].map((name) => ({
			kind: 'file' as const,
			id: `file:debug-agent/src/${name}.ts`,
			name: `${name}.ts`,
		}));
		const folder = {
			kind: 'folder' as const,
			id: 'folder:debug-agent/src',
			name: 'src',
			status: 'loaded' as const,
			children: groupedFiles,
		};
		const rootFiles = ['README.md', 'package.json'].map((name) => ({
			kind: 'file' as const,
			id: `file:debug-agent/${name}`,
			name,
		}));
		const project = {
			kind: 'project' as const,
			id: 'project:debug-agent',
			name: 'debug-agent',
			status: 'loaded' as const,
			children: [folder, ...rootFiles],
		};
		const graph = createSingleRootGraph(project, 'root:debug-agent');
		const graphState = {
			openedFolders: {
				[project.id]: true as const,
				[folder.id]: true as const,
			},
		};
		const first = createAgentActivityDebugMessages(graph, graphState);
		const second = createAgentActivityDebugMessages(graph, graphState);
		const coreMessages = first.slice(0, 6);
		const groupedTarget = { nodeId: groupedFiles[1]?.id ?? '' };
		const groupedActivities = first.filter(({ target }) => (
			target.nodeId === groupedTarget.nodeId && target.rootId === undefined
		));

		assert.deepStrictEqual(second, first);
		assert.deepStrictEqual(coreMessages.map(({ activity }) => activity), [
			'planned',
			'active',
			'editing',
			'completed',
			'mentioned',
			'rejected',
		]);
		assert.strictEqual(new Set(coreMessages.map(({ target }) => (
			JSON.stringify(target)
		))).size, 6);
		assert.deepStrictEqual(
			new Set(first.map(({ activity }) => activity)),
			new Set([
				'planned',
				'active',
				'editing',
				'completed',
				'mentioned',
				'rejected',
			]),
		);
		assert.ok(first.every((message) => (
			message.type === 'agent.activity.set'
			&& parseAgentActivityToWebviewMessage(message) !== undefined
			&& message.sessionId.startsWith('debug-g12-')
		)));
		assert.ok(first.some((message) => (
			message.target.nodeId === folder.id
			&& message.activity === 'active'
		)));
		assert.deepStrictEqual(
			groupedActivities.map(({ activity }) => activity),
			['editing', 'planned', 'mentioned'],
		);
	});

	test('Agent Activity Debug는 기존 Detached occurrence에 Source/override 예시만 추가한다', () => {
		const nestedFile = {
			kind: 'file' as const,
			id: 'file:debug-agent-detached/src/index.ts',
			name: 'index.ts',
		};
		const folder = {
			kind: 'folder' as const,
			id: 'folder:debug-agent-detached/src',
			name: 'src',
			status: 'loaded' as const,
			children: [nestedFile],
		};
		const project = {
			kind: 'project' as const,
			id: 'project:debug-agent-detached',
			name: 'debug-agent-detached',
			status: 'loaded' as const,
			children: [folder],
		};
		const addition = addGraphRoot(
			createSingleRootGraph(project, 'root:debug-agent-detached'),
			folder.id,
		);

		assert.ok(addition);
		const messages = createAgentActivityDebugMessages(addition.graph, {
			openedFolders: { [project.id]: true },
		});
		const detachedMessages = messages.filter(({ sessionId }) => (
			sessionId === 'debug-g12-detached'
			|| sessionId === 'debug-g12-extra'
		));

		assert.deepStrictEqual(detachedMessages, [
			{
				type: 'agent.activity.set',
				sessionId: 'debug-g12-detached',
				target: { nodeId: folder.id },
				activity: 'planned',
			},
			{
				type: 'agent.activity.set',
				sessionId: 'debug-g12-detached',
				target: { nodeId: folder.id, rootId: addition.root.id },
				activity: 'editing',
			},
			{
				type: 'agent.activity.set',
				sessionId: 'debug-g12-extra',
				target: { nodeId: folder.id, rootId: addition.root.id },
				activity: 'active',
			},
		]);
	});

	test('Agent Activity Debug clear는 reserved Session만 public clearSession 계약으로 생성한다', () => {
		const messages = createAgentActivityDebugClearMessages();

		assert.deepStrictEqual(
			messages.map(({ sessionId }) => sessionId),
			[...AGENT_ACTIVITY_DEBUG_SESSION_IDS],
		);
		assert.ok(messages.every((message) => (
			message.type === 'agent.activity.clearSession'
			&& message.sessionId.startsWith('debug-g12-')
			&& parseAgentActivityToWebviewMessage(message) !== undefined
		)));
		assert.strictEqual(messages.some(
			({ sessionId }) => sessionId === 'session-real-agent',
		), false);
	});

	test('Agent Activity Debug Command는 Canvas를 연다', async () => {
		await vscode.commands.executeCommand(DEBUG_AGENT_ACTIVITIES_COMMAND_ID);
		const panel = await openCanvas();

		assert.strictEqual(panel.visible, true);
	});

	test('Agent Activity Debug/Clear dispatch는 reserved clear 뒤 public set 메시지만 전송한다', async () => {
		const file = {
			kind: 'file' as const,
			id: 'file:debug-agent-command/index.ts',
			name: 'index.ts',
		};
		const project = {
			kind: 'project' as const,
			id: 'project:debug-agent-command',
			name: 'debug-agent-command',
			status: 'loaded' as const,
			children: [file],
		};
		const graph = createSingleRootGraph(project, 'root:debug-agent-command');
		const graphState = { openedFolders: { [project.id]: true as const } };
		const clearMessages = createAgentActivityDebugClearMessages();
		const setMessages = createAgentActivityDebugMessages(
			graph,
			graphState,
		);
		const debugMessages: ExtensionToWebviewMessage[] = [];

		await postAgentActivityDebugMessages(
			(message) => {
				debugMessages.push(message);
				return Promise.resolve(true);
			},
			graph,
			graphState,
		);

		assert.deepStrictEqual(debugMessages, [...clearMessages, ...setMessages]);

		const clearOnlyMessages: ExtensionToWebviewMessage[] = [];

		await postAgentActivityDebugClearMessages(
			(message) => {
				clearOnlyMessages.push(message);
				return Promise.resolve(true);
			},
		);

		assert.deepStrictEqual(clearOnlyMessages, clearMessages);
		assert.ok(clearMessages.every(({ sessionId }) => (
			sessionId.startsWith('debug-g12-')
		)));
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

	test('Canvas Close/Reopen은 이전 watcher를 제거하고 최신 초기 Graph와 watcher 하나만 복원한다', async () => {
		const firstWatcher = createWorkspaceWatcherStub();
		const reopenedWatcher = createWorkspaceWatcherStub();
		const firstGraph: Graph = { roots: [], rootNodes: {} };
		const reopenedProject = {
			kind: 'project' as const,
			id: 'project:reopened-workspace',
			name: 'reopened-workspace',
			status: 'loaded' as const,
			children: [],
		};
		const reopenedGraph: Graph = {
			roots: [{ id: 'root:reopened-workspace', nodeId: reopenedProject.id }],
			rootNodes: { [reopenedProject.id]: reopenedProject },
		};
		let currentWorkspaceGraph = firstGraph;
		const graphDependencies = {
			async createWorkspaceSnapshot() {
				return { roots: [] };
			},
			convertWorkspaceSnapshotToGraph() {
				return currentWorkspaceGraph;
			},
		};
		let firstRefreshRequests = 0;
		let firstRefreshDisposals = 0;
		let firstMessageDisposals = 0;
		const firstRuntime = createCanvasRuntime(
			{} as vscode.WebviewPanel,
			{ detach: () => undefined, terminate: () => undefined },
			[{ dispose: () => firstMessageDisposals += 1 }],
			{
				requestWorkspaceRefresh() {
					firstRefreshRequests += 1;
					return Promise.resolve();
				},
				dispose: () => firstRefreshDisposals += 1,
			},
			firstWatcher.watch,
		);

		assert.strictEqual(await createCurrentWorkspaceGraph(graphDependencies), firstGraph);
		assert.strictEqual(firstWatcher.watchCalls, 1);
		firstRuntime.markWebviewReady();
		assert.strictEqual(firstRefreshRequests, 0);
		firstWatcher.fireWorkspaceChange();
		assert.strictEqual(firstRefreshRequests, 1);

		firstRuntime.detach();
		currentWorkspaceGraph = reopenedGraph;
		firstWatcher.fireWorkspaceChange();
		assert.strictEqual(firstRefreshRequests, 1);
		assert.strictEqual(firstRefreshDisposals, 1);
		assert.strictEqual(firstMessageDisposals, 1);
		assert.strictEqual(firstWatcher.disposeCalls, 1);
		assert.strictEqual(
			await createCurrentWorkspaceGraph(graphDependencies),
			reopenedGraph,
		);

		let reopenedRefreshRequests = 0;
		let reopenedRefreshDisposals = 0;
		let reopenedMessageDisposals = 0;
		const reopenedRuntime = createCanvasRuntime(
			{} as vscode.WebviewPanel,
			{ detach: () => undefined, terminate: () => undefined },
			[{ dispose: () => reopenedMessageDisposals += 1 }],
			{
				requestWorkspaceRefresh() {
					reopenedRefreshRequests += 1;
					return Promise.resolve();
				},
				dispose: () => reopenedRefreshDisposals += 1,
			},
			reopenedWatcher.watch,
		);

		assert.strictEqual(reopenedWatcher.watchCalls, 1);
		reopenedRuntime.markWebviewReady();
		assert.strictEqual(reopenedRefreshRequests, 0);
		firstWatcher.fireWorkspaceChange();
		reopenedWatcher.fireWorkspaceChange();
		assert.strictEqual(firstRefreshRequests, 1);
		assert.strictEqual(reopenedRefreshRequests, 1);

		reopenedRuntime.detach();
		reopenedWatcher.fireWorkspaceChange();
		assert.strictEqual(reopenedRefreshRequests, 1);
		assert.strictEqual(reopenedRefreshDisposals, 1);
		assert.strictEqual(reopenedMessageDisposals, 1);
		assert.strictEqual(reopenedWatcher.disposeCalls, 1);
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
			readWorkspaceTrust: () => true,
			createWorkspaceRootCatalog: () => [],
			async postMessage(message: WorkspaceToWebviewMessage) {
				graphMessages.push(message.presentation.graph);
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
		watcher.fireWorkspaceChange();
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

	test('ready 전 pending 변경은 Canvas dispose 시 폐기된다', () => {
		const watcher = createWorkspaceWatcherStub();
		let refreshRequests = 0;
		let refreshDisposals = 0;
		const runtime = createCanvasRuntime(
			{} as vscode.WebviewPanel,
			{ detach: () => undefined, terminate: () => undefined },
			[],
			{
				requestWorkspaceRefresh() {
					refreshRequests += 1;
					return Promise.resolve();
				},
				dispose: () => refreshDisposals += 1,
			},
			watcher.watch,
		);

		watcher.fireWorkspaceChange();
		watcher.fireWorkspaceChange();
		runtime.detach();
		runtime.markWebviewReady();
		watcher.fireWorkspaceChange();

		assert.strictEqual(refreshRequests, 0);
		assert.strictEqual(refreshDisposals, 1);
		assert.strictEqual(watcher.disposeCalls, 1);
	});

	test('연속 watcher callback은 직렬 후속 Refresh 한 번으로 병합되고 최신 Graph로 끝난다', async () => {
		const firstSnapshot = createDeferred<void>();
		const watcher = createWorkspaceWatcherStub();
		let snapshotCalls = 0;
		let activeSnapshots = 0;
		let maxActiveSnapshots = 0;
		let conversionCalls = 0;
		const staleGraph: Graph = { roots: [], rootNodes: {} };
		const latestProject = {
			kind: 'project' as const,
			id: 'project:latest-workspace',
			name: 'latest-workspace',
			status: 'loaded' as const,
			children: [],
		};
		const latestGraph: Graph = {
			roots: [{ id: 'root:latest-workspace', nodeId: latestProject.id }],
			rootNodes: { [latestProject.id]: latestProject },
		};
		const graphMessages: Graph[] = [];
		const coordinator = createWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				snapshotCalls += 1;
				activeSnapshots += 1;
				maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);

				try {
					if (snapshotCalls === 1) {
						await firstSnapshot.promise;
					}

					return { roots: [] };
				} finally {
					activeSnapshots -= 1;
				}
			},
			convertWorkspaceSnapshotToGraph: () => {
				conversionCalls += 1;
				return conversionCalls === 1 ? staleGraph : latestGraph;
			},
			readWorkspaceTrust: () => true,
			createWorkspaceRootCatalog: () => [],
			async postMessage(message) {
				graphMessages.push(message.presentation.graph);
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
		watcher.fireWorkspaceChange();
		watcher.fireWorkspaceChange();

		assert.strictEqual(snapshotCalls, 1);
		firstSnapshot.resolve();
		await waitFor(() => graphMessages.length === 2);

		assert.strictEqual(snapshotCalls, 2);
		assert.strictEqual(maxActiveSnapshots, 1);
		assert.deepStrictEqual(graphMessages, [staleGraph, latestGraph]);
		runtime.detach();
	});

	test('Refresh Snapshot 중 Canvas dispose는 전송과 pending 후속 Refresh를 폐기한다', async () => {
		const snapshot = createDeferred<void>();
		const watcher = createWorkspaceWatcherStub();
		let snapshotCalls = 0;
		let conversionCalls = 0;
		let postMessageCalls = 0;
		const coordinator = createWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				snapshotCalls += 1;
				await snapshot.promise;
				return { roots: [] };
			},
			convertWorkspaceSnapshotToGraph() {
				conversionCalls += 1;
				return { roots: [], rootNodes: {} };
			},
			readWorkspaceTrust: () => true,
			createWorkspaceRootCatalog: () => [],
			async postMessage() {
				postMessageCalls += 1;
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
		const refreshCompletion = runtime.requestWorkspaceRefresh();
		watcher.fireWorkspaceChange();
		watcher.fireWorkspaceChange();
		runtime.detach();
		snapshot.resolve();
		await refreshCompletion;

		assert.strictEqual(snapshotCalls, 1);
		assert.strictEqual(conversionCalls, 1);
		assert.strictEqual(postMessageCalls, 0);
		assert.strictEqual(watcher.disposeCalls, 1);
		watcher.fireWorkspaceChange();
		await Promise.resolve();
		assert.strictEqual(snapshotCalls, 1);
		assert.strictEqual(postMessageCalls, 0);
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
		assert.ok(
			panel.webview.html.includes('<div id="agent-workspace-status-bar" hidden></div>'),
		);
		assert.ok(!panel.webview.html.includes('agent-provider-bar'));
		assert.ok(
			panel.webview.html.includes(`img-src ${panel.webview.cspSource};`),
		);
		assert.strictEqual(
			panel.webview.html.match(/data-workspace-presentation=/g)?.length,
			1,
		);
		assert.doesNotMatch(panel.webview.html, /data-workspace-(?:graph|catalog)=/);
	});

	test('Canvas command가 같은 현재 Workspace Root를 Graph와 Catalog 초기 데이터로 전달한다', async () => {
		const panel = await openCanvas();
		const presentation = getInitialWorkspacePresentation(panel);
		const graph = presentation.graph;
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];

		assert.strictEqual(graph.roots.length, workspaceFolders.length);
		assert.strictEqual(presentation.rootCatalog.length, workspaceFolders.length);
		for (const [index, workspaceFolder] of workspaceFolders.entries()) {
			const projectId = `workspace-root:${workspaceFolder.uri.toString()}`;
			const graphRoot = graph.roots[index];
			const project = graph.rootNodes[projectId];
			const catalogEntry = presentation.rootCatalog[index];

			assert.deepStrictEqual(graphRoot, {
				id: `root:${projectId}`,
				nodeId: projectId,
			});
			assert.ok(project && project.kind === 'project');
			assert.strictEqual(project.name, workspaceFolder.name);
			assert.strictEqual(project.status, 'loaded');
			assert.strictEqual(catalogEntry?.id, projectId);
			assert.strictEqual(catalogEntry?.name, workspaceFolder.name);
			assert.strictEqual(catalogEntry?.description, workspaceFolder.uri.toString());
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

	test('workspace.openFile은 File ID URI를 복원해 Active 일반 Editor Tab으로 연다', () => {
		const expectedUri = vscode.Uri.parse(
			'vscode-remote://ssh-remote+crispy/workspace/src/index.ts',
			true,
		);
		const opened: Array<{
			readonly uri: vscode.Uri;
			readonly options: vscode.TextDocumentShowOptions;
		}> = [];
		const workspaceFileHost: WorkspaceFileHost = {
			getWorkspaceFolder: (uri) => {
				assert.strictEqual(uri.toString(), expectedUri.toString());

				return {
					uri: vscode.Uri.parse(
						'vscode-remote://ssh-remote+crispy/workspace',
						true,
					),
					name: 'workspace',
					index: 0,
				};
			},
			showTextDocument: (uri, options) => {
				opened.push({ uri, options });
				return Promise.resolve(undefined);
			},
		};

		const result = handleHostWebviewMessage(
			{ postMessage: () => Promise.resolve(true) },
			{
				type: 'workspace.openFile',
				fileId: `file:${expectedUri.toString()}`,
			},
			undefined,
			undefined,
			workspaceFileHost,
		);

		assert.strictEqual(result, undefined);
		assert.strictEqual(opened.length, 1);
		assert.strictEqual(opened[0]?.uri.toString(), expectedUri.toString());
		assert.deepStrictEqual(opened[0]?.options, {
			viewColumn: vscode.ViewColumn.Active,
			preview: false,
			preserveFocus: false,
		});
	});

	test('잘못된 File ID, malformed payload와 Workspace 밖 URI는 열지 않는다', () => {
		let workspaceChecks = 0;
		let openCalls = 0;
		const workspaceFileHost: WorkspaceFileHost = {
			getWorkspaceFolder: () => {
				workspaceChecks += 1;
				return undefined;
			},
			showTextDocument: () => {
				openCalls += 1;
				return Promise.resolve(undefined);
			},
		};
		const messages: unknown[] = [{
			type: 'workspace.openFile',
			fileId: 'folder:file:///workspace/src/index.ts',
		}, {
			type: 'workspace.openFile',
			fileId: 'file:not-a-uri',
		}, {
			type: 'workspace.openFile',
		}, {
			type: 'workspace.openFile',
			fileId: 42,
		}, {
			type: 'workspace.openFile',
			fileId: 'file:file:///workspace/src/index.ts',
			unexpected: true,
		}, {
			type: 'workspace.openFile',
			fileId: 'file:file:///outside/index.ts',
		}];

		for (const message of messages) {
			assert.strictEqual(handleHostWebviewMessage(
				{ postMessage: () => Promise.resolve(true) },
				message,
				undefined,
				undefined,
				workspaceFileHost,
			), undefined);
		}

		assert.strictEqual(workspaceChecks, 1);
		assert.strictEqual(openCalls, 0);
	});

	test('File open 실패를 격리해 다음 Webview 메시지를 계속 처리한다', async () => {
		const postedMessages: ExtensionToWebviewMessage[] = [];
		let readyNotifications = 0;
		const workspaceFileHost: WorkspaceFileHost = {
			getWorkspaceFolder: (uri) => ({ uri, name: 'workspace', index: 0 }),
			showTextDocument: () => Promise.reject(new Error('file was deleted')),
		};

		handleHostWebviewMessage(
			{ postMessage: () => Promise.resolve(true) },
			{
				type: 'workspace.openFile',
				fileId: 'file:file:///workspace/deleted.ts',
			},
			undefined,
			undefined,
			workspaceFileHost,
		);
		const readyResult = handleHostWebviewMessage(
			{
				postMessage: (message: ExtensionToWebviewMessage) => {
					postedMessages.push(message);
					return Promise.resolve(true);
				},
			},
			{ type: 'webview.ready' },
			undefined,
			() => readyNotifications += 1,
			workspaceFileHost,
		);

		assert.ok(readyResult);
		assert.strictEqual(await readyResult, true);
		assert.strictEqual(readyNotifications, 1);
		assert.deepStrictEqual(postedMessages, [{ type: 'extension.ready' }]);
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
			{
				type: 'agent.switch',
				tabId: 'tab-lifecycle',
				providerId: 'codex',
				workspaceRootId: 'workspace-root:file:///workspace/lifecycle',
				switchAttemptId: 1,
			},
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
			{
				method: 'switchAgent',
				args: [
					'tab-lifecycle',
					'codex',
					'workspace-root:file:///workspace/lifecycle',
					1,
				],
			},
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
				workspaceRootId: 'workspace-root:file:///workspace/provider',
				switchAttemptId: 1,
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

function getInitialWorkspacePresentation(
	panel: vscode.WebviewPanel,
): WorkspacePresentation {
	const match = panel.webview.html.match(/data-workspace-presentation="([^"]*)"/);
	assert.ok(match, 'Webview 초기 HTML에 atomic Workspace Presentation이 있어야 한다.');
	return deserializeWorkspacePresentationFromWebview(match[1]);
}
