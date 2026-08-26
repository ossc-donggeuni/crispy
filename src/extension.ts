import * as vscode from 'vscode';
import {
	parseWebviewToHostMessage,
	type ProviderId,
	type WebviewToHostMessage,
} from './agent/protocol';
import { nodePtyAdapter } from './agent/host/terminal/nodePtyAdapter';
import { TerminalHost } from './agent/host/terminal/terminalHost';
import {
	createAgentActivityGraphBridge,
	type AgentActivityGraphBridge,
} from './agent/host/terminal/agentActivityGraphBridge';
import { createAgentAutoRunInputResolver } from './agent/host/agent/agentProviderLaunch';
import { McpAdapterSupervisor } from './mcp/adapterSupervisor';
import { createPrepareCodexTerminalLaunch } from './mcp/codexTerminalLaunch';
import { createPrepareClaudeTerminalLaunch } from './mcp/claudeTerminalLaunch';
import { resolveAgentExecutable } from './mcp/agentExecutableResolver';
import {
	isAgentActivityVscodeVersionAllowed,
} from './mcp/agentActivityCapability';
import { resolveCurrentWorkspace } from './agent/host/workspace/workspaceResolver';
import {
	createTerminalRuntimeCleanup,
	runCleanupWithTimeout,
	type DetachableTerminalRuntime,
} from './agent/host/terminal/terminalRuntimeCleanup';
import {
	getWorkspaceGraphRootIds,
	parseWorkspaceNodeRequestMessage,
	parseWorkspaceRootIds,
	clearAgentActivitiesBySession,
	setAgentActivity,
	type AgentActivityClearSessionMessage,
	type AgentActivityKind,
	type AgentActivitySetMessage,
	type AgentActivityToWebviewMessage,
	type ExtensionToWebviewMessage,
	type GraphNodeEffect,
	type GraphNodeEffectKind,
	type GraphNodeEffectSetMessage,
	type GraphNodeEffectTarget,
	type TaskJsonCopyFailedMessage,
	type TaskJsonCopyMessage,
	type WorkspaceOpenFileMessage,
	type WorkspaceToWebviewMessage,
} from './messages';
import {
	createDefaultWebviewSessionState,
	parseWebviewSessionState,
	serializeWebviewState,
	type PersistedWebviewState,
} from './webview/webviewState';
import {
	createDefaultWorkspacePersistentState,
	parseWorkspacePersistentState,
	type WorkspacePersistentState,
} from './workspace/workspaceMetadata';
import {
	createWorkspacePersistenceCoordinator,
	type WorkspaceRootStateWriter,
	type WorkspacePersistenceCoordinator,
} from './workspace/workspacePersistenceCoordinator';
import type { Graph } from './webview/graph/graphModel';
import {
	createGraphLayout,
	getGraphLayoutRootId,
	getGraphLayoutSourceId,
	getGraphRootLayoutNodeId,
	type GraphFileGroupNode,
	type GraphLayout,
} from './webview/graph/graphLayout';
import {
	getVisibleFileCount,
	type GraphState,
} from './webview/graph/graphState';
import {
	applyDetachedGraphRoots,
	isDetachedRootId,
} from './webview/graph/graphRootPromotion';
import {
	mergeContinuouslyRetainedWorkspaceGraphState,
	mergeContinuouslyRetainedWorkspaceTaskState,
} from './webview/workspaceRootTransition';
import {
	parseTaskTransferJson,
	TASK_TRANSFER_JSON_MAX_BYTES,
} from './task/taskTransfer';
import {
	createCurrentWorkspaceGraph,
	createCurrentWorkspacePresentation,
	createWorkspaceRootId,
	createWorkspaceRootCatalog,
	createWorkspaceRefreshCoordinator,
	createWorkspaceNodeRequestController,
	createWorkspaceGitStatusService,
	convertWorkspaceSnapshotToGraph,
	createWorkspaceSnapshot,
	loadOrCreateWorkspaceFilters,
	getBuiltInGitExtension,
	mergeWorkspacePersistentStates,
	partitionWorkspacePersistentStateByRoot,
	readWorkspacePersistentState,
	serializeWorkspacePresentationForWebview,
	watchWorkspaceChanges,
	writeWorkspacePersistentState,
	defaultWorkspaceNodeOperationHost,
	type WorkspacePresentation,
	type WorkspaceNodeRequestController,
	type WorkspaceGitStatusService,
	type WorkspaceRefreshCoordinator,
	type WorkspaceRootFilter,
} from './workspace';

/** MCP Host APIs remain exported for integration and deterministic tests. */
export { McpAdapterSupervisor } from './mcp/adapterSupervisor';
export {
	McpSessionRuntime,
	resolveMcpChildAssetPath,
} from './mcp/sessionRuntime';

/**
 * Panel 하나가 소유하는 Terminal runtime과 Webview 구독의 정리 경계다.
 * Panel dispose와 Extension deactivate가 같은 경계를 공유한다.
 */
interface CanvasRuntime {
	/** 정리 대상 Panel이며 deactivate에서 직접 dispose한다. */
	readonly panel: vscode.WebviewPanel;
	/** 이 Panel에 귀속된 직렬화 Workspace Refresh를 요청한다. */
	requestWorkspaceRefresh(): Promise<void>;
	/** Webview message listener가 준비된 뒤 초기화 중 Workspace 변경을 전달한다. */
	markWebviewReady(): void;

	/** Routing과 Webview 구독을 native 종료 없이 즉시 분리한다. */
	detach(): void;

	/** 분리 시 캡처한 session을 비동기 OS adapter로 한 번만 종료한다. */
	terminate(): Promise<void>;
}

let currentRuntime: CanvasRuntime | undefined;
let lastWebviewState: PersistedWebviewState | undefined;
let lastWorkspaceState: WorkspacePersistentState | undefined;
/** Persistence coordinator가 현재 desired/durable로 관리하는 Root context다. */
let workspacePersistenceContextKey: string | undefined;
/** 아직 모든 Root에 materialize되지 않은 공개 context generation이다. */
let pendingWorkspaceMaterializationGeneration: number | undefined;
let workspacePersistenceRootUris: readonly vscode.Uri[] = [];
/** Webview가 새 context snapshot으로 응답하기 전까지만 이전 context 편집을 병합한다. */
let workspaceContextGeneration = 0;
/** 같은 Root context 안에서 완료된 파일시스템 mutation의 단조 증가 revision이다. */
let workspaceRevision = 0;
let latestAcknowledgedWorkspaceRevision = -1;
let nextWorkspaceContextGeneration = 0;
/** 이미 current Host state에 반영됐다고 확인한 가장 최신 Webview epoch다. */
let latestAcknowledgedWorkspaceContextGeneration = -1;
const workspaceContextByGeneration = new Map<number, {
	readonly contextKey: string;
	readonly rootUris: readonly vscode.Uri[];
}>();
let activeWorkspacePersistence: WorkspacePersistenceCoordinator | undefined;
const pendingWorkspaceWrites = new Set<Promise<void>>();

export const OPEN_CANVAS_COMMAND_ID = 'crispy.openCanvas';
export const DEBUG_NODE_EFFECTS_COMMAND_ID = 'crispy.debugNodeEffects';
export const CLEAR_NODE_EFFECTS_COMMAND_ID = 'crispy.clearNodeEffects';
export const DEBUG_AGENT_ACTIVITIES_COMMAND_ID = 'crispy.debugAgentActivities';
export const CLEAR_AGENT_ACTIVITIES_COMMAND_ID = 'crispy.clearAgentActivities';

/** G-12 Debug Command가 독점 소유하고 clear할 수 있는 고정 Session ID다. */
export const AGENT_ACTIVITY_DEBUG_SESSION_IDS = [
	'debug-g12-planned',
	'debug-g12-active',
	'debug-g12-editing',
	'debug-g12-completed',
	'debug-g12-mentioned',
	'debug-g12-rejected',
	'debug-g12-detached',
	'debug-g12-extra',
] as const;

const AGENT_ACTIVITY_DEBUG_ASSIGNMENTS = [
	{ sessionId: 'debug-g12-planned', activity: 'planned' },
	{ sessionId: 'debug-g12-active', activity: 'active' },
	{ sessionId: 'debug-g12-editing', activity: 'editing' },
	{ sessionId: 'debug-g12-completed', activity: 'completed' },
	{ sessionId: 'debug-g12-mentioned', activity: 'mentioned' },
	{ sessionId: 'debug-g12-rejected', activity: 'rejected' },
] as const satisfies ReadonlyArray<{
	readonly sessionId: string;
	readonly activity: AgentActivityKind;
}>;

type AgentActivityDebugGraphState = Pick<
	GraphState,
	| 'fileGroupPages'
	| 'openedFolders'
	| 'hiddenNodeIds'
	| 'detachedRootNodeIds'
>;

type GraphNodeEffectDebugTemplate =
	| { readonly kind: Exclude<GraphNodeEffectKind, 'icon'> }
	| { readonly kind: 'icon'; readonly icon: 'check' | 'cancel' | 'alert' };

const GRAPH_NODE_EFFECT_DEBUG_TEMPLATES:
	readonly (readonly GraphNodeEffectDebugTemplate[])[] = [
		[{ kind: 'marching-dash' }],
		[{ kind: 'pulse' }],
		[{ kind: 'shimmer' }],
		[{ kind: 'outline' }],
		[{ kind: 'outline-strong' }],
		[{ kind: 'icon', icon: 'check' }],
		[{ kind: 'outline' }, { kind: 'icon', icon: 'alert' }],
		[{ kind: 'outline' }, { kind: 'icon', icon: 'cancel' }],
	];

/** Debug Effect가 매 호출마다 구분 가능한 밝은 임의 색상을 사용하도록 한다. */
function createRandomGraphNodeEffectColor(random: () => number): string {
	const hue = Math.floor(random() * 36_000) / 100;

	return `hsl(${hue}deg 84% 64%)`;
}

/** 현재 Workspace Graph의 Source Node를 안정적인 traversal 순서로 Debug 메시지에 배정한다. */
export function createGraphNodeEffectDebugMessages(
	graph: Graph,
	graphState: Pick<
		GraphState,
		'fileGroupPages' | 'openedFolders' | 'hiddenNodeIds'
	> = {},
	random: () => number = Math.random,
): GraphNodeEffectSetMessage[] {
	const nodeIds: string[] = [];
	const visitedNodeIds = new Set<string>();
	const appendNodeId = (nodeId: string): void => {
		if (visitedNodeIds.has(nodeId)) {
			return;
		}

		visitedNodeIds.add(nodeId);
		nodeIds.push(nodeId);
	};

	for (const root of graph.roots) {
		const rootNode = graph.rootNodes[root.nodeId];

		// Workspace Root는 Project다. Detached Folder/File Root는 후보로 보지 않는다.
		if (rootNode?.kind !== 'project') {
			continue;
		}

		for (const child of rootNode.children) {
			if (graphState.hiddenNodeIds?.[child.id] !== true) {
				appendNodeId(child.id);
			}
		}
	}

	const messages: GraphNodeEffectSetMessage[] = [];

	for (
		let index = 0;
		index < Math.min(nodeIds.length, GRAPH_NODE_EFFECT_DEBUG_TEMPLATES.length);
		index += 1
	) {
		const nodeId = nodeIds[index];
		const templates = GRAPH_NODE_EFFECT_DEBUG_TEMPLATES[index];
		const color = createRandomGraphNodeEffectColor(random);

		if (!nodeId || !templates || !color) {
			continue;
		}

		for (const template of templates) {
			const effect: GraphNodeEffect = template.kind === 'icon'
				? { kind: 'icon', color, icon: template.icon }
				: { kind: template.kind, color };

			messages.push({
				type: 'graph.nodeEffect.set',
				target: { nodeId },
				effect,
			});
		}
	}

	return messages;
}

/** G-12 Debug Command가 소유한 Session만 지우는 public clearSession 메시지를 만든다. */
export function createAgentActivityDebugClearMessages(): AgentActivityClearSessionMessage[] {
	return AGENT_ACTIVITY_DEBUG_SESSION_IDS.map((sessionId) => (
		clearAgentActivitiesBySession(sessionId)
	));
}

/** 현재 Canvas에서 실제 표시되는 Graph Target을 Layout traversal 순서로 수집한다. */
function collectAgentActivityDebugTargets(
	layout: GraphLayout,
	graphState: AgentActivityDebugGraphState,
): GraphNodeEffectTarget[] {
	const targets: GraphNodeEffectTarget[] = [];
	const targetKeys = new Set<string>();
	const appendTarget = (layoutNodeId: string): void => {
		const target = toGraphNodeEffectTarget(layoutNodeId);
		const key = createEffectTargetKey(target);

		if (!targetKeys.has(key)) {
			targetKeys.add(key);
			targets.push(target);
		}
	};

	for (const node of layout.nodes) {
		if (node.hidden) {
			continue;
		}

		if (node.kind === 'folder') {
			appendTarget(node.id);
			continue;
		}

		if (node.kind !== 'file-group') {
			continue;
		}

		if (node.presentation === 'standalone') {
			const file = node.children.find((candidate) => (
				candidate.hidden !== true && candidate.presentation === 'normal'
			));

			if (file) {
				appendTarget(file.id);
			}
			continue;
		}

		for (const file of getVisibleNormalDebugFiles(node, graphState)) {
			appendTarget(file.id);
		}
	}

	return targets;
}

/** grouped File의 현재 page에서 실제 Renderer가 생성하는 normal Row만 반환한다. */
function getVisibleNormalDebugFiles(
	fileGroup: GraphFileGroupNode,
	graphState: AgentActivityDebugGraphState,
): GraphFileGroupNode['children'] {
	const sourceGroupId = getGraphLayoutSourceId(fileGroup.id);
	const page = graphState.fileGroupPages?.[fileGroup.id]
		?? graphState.fileGroupPages?.[sourceGroupId]
		?? 1;
	const visibleFileCount = getVisibleFileCount(fileGroup.children.length, page);

	return fileGroup.children
		.slice(0, visibleFileCount)
		.filter((file) => (
			file.hidden !== true && file.presentation === 'normal'
		));
}

/** grouped File Binding과 Folder subtree Effect를 함께 볼 수 있는 visible pair를 찾는다. */
function findAgentActivityGroupedDebugTargets(
	layout: GraphLayout,
	graphState: AgentActivityDebugGraphState,
): Readonly<{
	readonly folder: GraphNodeEffectTarget;
	readonly file: GraphNodeEffectTarget;
}> | undefined {
	const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
	let fallback: Readonly<{
		readonly folder: GraphNodeEffectTarget;
		readonly file: GraphNodeEffectTarget;
	}> | undefined;

	for (const node of layout.nodes) {
		if (
			node.kind !== 'file-group'
			|| node.presentation !== 'grouped'
			|| node.hidden
			|| !node.parentId
		) {
			continue;
		}
		const parent = nodesById.get(node.parentId);

		if (parent?.kind !== 'folder' || parent.hidden) {
			continue;
		}
		const files = getVisibleNormalDebugFiles(node, graphState);

		if (files.length === 0) {
			continue;
		}
		const fileIndex = files.length >= 4 ? 1 : 0;
		const file = files[fileIndex];

		if (!file) {
			continue;
		}
		const targets = {
			folder: toGraphNodeEffectTarget(parent.id),
			file: toGraphNodeEffectTarget(file.id),
		};

		if (files.length >= 4) {
			return targets;
		}
		fallback ??= targets;
	}

	return fallback;
}

/** Layout의 Source/Detached occurrence 식별 정보를 G-11 Target 계약으로 복원한다. */
function toGraphNodeEffectTarget(layoutNodeId: string): GraphNodeEffectTarget {
	const rootId = getGraphLayoutRootId(layoutNodeId);

	return {
		nodeId: getGraphLayoutSourceId(layoutNodeId),
		...(rootId ? { rootId } : {}),
	};
}

/**
 * 현재 Graph의 visible Target에 G-12 Activity 예시를 결정적인 순서로 배치한다.
 * 모든 메시지는 실제 G-12.1 public set 진입점을 사용한다.
 */
export function createAgentActivityDebugMessages(
	graph: Graph,
	graphState: AgentActivityDebugGraphState = {},
): AgentActivitySetMessage[] {
	const currentGraph = applyDetachedGraphRoots(
		graph,
		graphState.detachedRootNodeIds ?? {},
	);
	const layout = createGraphLayout(currentGraph, {
		fileGroupPages: graphState.fileGroupPages,
		openedFolders: graphState.openedFolders,
		hiddenNodeIds: graphState.hiddenNodeIds,
	});
	const targets = collectAgentActivityDebugTargets(layout, graphState);
	const messages: AgentActivitySetMessage[] = [];
	const messageKeys = new Set<string>();
	const appendActivity = (
		sessionId: string,
		target: GraphNodeEffectTarget,
		activity: AgentActivityKind,
	): void => {
		const key = JSON.stringify([
			sessionId,
			target.nodeId,
			target.rootId ?? null,
		]);

		if (messageKeys.has(key)) {
			return;
		}
		messageKeys.add(key);
		messages.push(setAgentActivity(sessionId, target, activity));
	};

	for (
		let index = 0;
		index < Math.min(targets.length, AGENT_ACTIVITY_DEBUG_ASSIGNMENTS.length);
		index += 1
	) {
		const target = targets[index];
		const assignment = AGENT_ACTIVITY_DEBUG_ASSIGNMENTS[index];

		if (target && assignment) {
			appendActivity(assignment.sessionId, target, assignment.activity);
		}
	}

	const groupedTargets = findAgentActivityGroupedDebugTargets(layout, graphState);
	const multiSessionTarget = groupedTargets?.file ?? targets[2] ?? targets[0];

	if (groupedTargets) {
		appendActivity('debug-g12-active', groupedTargets.folder, 'active');
	}
	if (multiSessionTarget) {
		appendActivity('debug-g12-editing', multiSessionTarget, 'editing');
		appendActivity('debug-g12-planned', multiSessionTarget, 'planned');
		appendActivity('debug-g12-mentioned', multiSessionTarget, 'mentioned');
	}

	const detachedRoot = currentGraph.roots.find((root) => (
		isDetachedRootId(root.id)
		&& layout.nodes.some((node) => (
			node.id === getGraphRootLayoutNodeId(root) && !node.hidden
		))
	));

	if (detachedRoot) {
		const sourceTarget = { nodeId: detachedRoot.nodeId };
		const occurrenceTarget = {
			nodeId: detachedRoot.nodeId,
			rootId: detachedRoot.id,
		};

		appendActivity('debug-g12-detached', sourceTarget, 'planned');
		appendActivity('debug-g12-detached', occurrenceTarget, 'editing');
		appendActivity('debug-g12-extra', occurrenceTarget, 'active');
	}

	return messages;
}

/** Agent Activity Debug 메시지를 실제 Command와 테스트가 공유하는 순서로 전달한다. */
export async function postAgentActivityDebugMessages(
	postMessage: (message: AgentActivityToWebviewMessage) => PromiseLike<unknown>,
	graph: Graph,
	graphState: AgentActivityDebugGraphState = {},
): Promise<void> {
	for (const message of createAgentActivityDebugClearMessages()) {
		await postMessage(message);
	}
	for (const message of createAgentActivityDebugMessages(graph, graphState)) {
		await postMessage(message);
	}
}

/** Agent Activity Debug가 소유한 Session clear를 결정적인 순서로 전달한다. */
export async function postAgentActivityDebugClearMessages(
	postMessage: (message: AgentActivityClearSessionMessage) => PromiseLike<unknown>,
): Promise<void> {
	for (const message of createAgentActivityDebugClearMessages()) {
		await postMessage(message);
	}
}

function collectEffectKindsByTarget(
	messages: readonly GraphNodeEffectSetMessage[],
): ReadonlyMap<string, ReadonlySet<GraphNodeEffectKind>> {
	const kindsByTarget = new Map<string, Set<GraphNodeEffectKind>>();

	for (const message of messages) {
		const key = createEffectTargetKey(message.target);
		const kinds = kindsByTarget.get(key) ?? new Set<GraphNodeEffectKind>();

		kinds.add(message.effect.kind);
		kindsByTarget.set(key, kinds);
	}

	return kindsByTarget;
}

function createEffectTargetKey(target: GraphNodeEffectTarget): string {
	return JSON.stringify([target.nodeId, target.rootId ?? null]);
}

/** 검증된 terminal 메시지를 실제 TerminalHost 경계로 전달하는 최소 계약이다. */
export interface TerminalMessageHost {
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
		providerId: ProviderId,
		workspaceRootId: Extract<
			WebviewToHostMessage,
			{ type: 'agent.switch' }
		>['workspaceRootId'],
		switchAttemptId: number,
	): Promise<unknown>;
	resetAgent(tabId: string): void;
	routeInput(
		message: Extract<WebviewToHostMessage, { type: 'terminal.input' }>,
	): void;
	routeResize(
		message: Extract<WebviewToHostMessage, { type: 'terminal.resize' }>,
	): void;
}

/** Workspace 소속 확인과 Editor 열기를 제공하는 VS Code Host 경계다. */
export interface WorkspaceFileHost {
	getWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined;
	showTextDocument(
		uri: vscode.Uri,
		options: vscode.TextDocumentShowOptions,
	): Thenable<unknown>;
}

/** Task JSON clipboard 기록과 사용자 피드백을 제공하는 VS Code Host 경계다. */
export interface TaskClipboardHost {
	writeText(value: string): Thenable<void>;
	reportCopySuccess(): void;
	reportCopyFailure(reason?: TaskJsonCopyFailedMessage['reason']): void;
}

const defaultWorkspaceFileHost: WorkspaceFileHost = {
	getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri),
	showTextDocument: (uri, options) => vscode.window.showTextDocument(uri, options),
};

const defaultTaskClipboardHost: TaskClipboardHost = {
	writeText: (value) => vscode.env.clipboard.writeText(value),
	reportCopySuccess: () => {
		vscode.window.setStatusBarMessage(
			'Crispy: Task JSON을 클립보드에 복사했습니다.',
			2_000,
		);
	},
	reportCopyFailure: (reason) => {
		void vscode.window.showErrorMessage(
			reason === 'transfer_limit'
				? 'Crispy: Task가 JSON 내보내기 한도를 초과했습니다.'
				: reason === 'invalid_task'
					? 'Crispy: Task JSON을 생성하지 못했습니다.'
					: 'Crispy: Task JSON을 복사하지 못했습니다.',
		);
	},
};

/** VS Code가 실제 활성화한 extension module instance에서 제공하는 공개 API다. */
export interface CrispyExtensionApi {
	deactivate(): Promise<void>;
	requestWorkspaceRefresh(): Promise<void>;
	handleWebviewMessage(
		webview: Pick<vscode.Webview, 'postMessage'>,
		message: unknown,
		terminalHost?: TerminalMessageHost,
		onWebviewReady?: () => void,
		workspaceFileHost?: WorkspaceFileHost,
		taskClipboardHost?: TaskClipboardHost,
	): Thenable<boolean> | undefined;
}

/** Reads the production Host version without accepting provider or environment input. */
export function readAgentActivityCompatibilityFromHost(): boolean {
	return isAgentActivityVscodeVersionAllowed(vscode.version);
}

/**
 * Crispy 확장을 활성화하고 Canvas Webview를 여는 명령을 등록한다.
 *
 * @param context 확장의 구독 항목과 설치 경로를 제공하는 VS Code 확장 컨텍스트
 */
export function activate(context: vscode.ExtensionContext): CrispyExtensionApi {
	/** Production capability is captured exactly once from the activated Host. */
	const agentActivityCompatible = readAgentActivityCompatibilityFromHost();
	const workspacePersistence = createWorkspacePersistenceCoordinator();
	activeWorkspacePersistence = workspacePersistence;
	const workspaceGraphDependencies = {
		loadWorkspaceFilters: () => loadOrCreateWorkspaceFilters(
			getCurrentWorkspaceRootUris(),
			context.extensionUri,
		),
		createWorkspaceSnapshot: (
			rootFilters: readonly WorkspaceRootFilter[],
		) => createWorkspaceSnapshot(
			vscode.workspace,
			vscode.workspace.fs,
			console,
			rootFilters,
		),
		convertWorkspaceSnapshotToGraph,
	};
	const workspacePresentationDependencies = {
		...workspaceGraphDependencies,
		readWorkspaceTrust: () => vscode.workspace.isTrusted,
		createWorkspaceRootCatalog: (
			snapshot: Parameters<typeof createWorkspaceRootCatalog>[0],
			isTrusted: boolean,
		) => createWorkspaceRootCatalog(snapshot, isTrusted, process.platform),
	};
	const refreshWorkspaceStateForDelivery = async (
		rootUris: readonly vscode.Uri[],
		signal: AbortSignal,
	): Promise<WorkspacePersistentState> => refreshWorkspacePersistenceContext(
		workspacePersistence,
		rootUris,
		signal,
		{ allowPendingPersistence: !vscode.workspace.isTrusted },
	);
	let debugEffectMessages: GraphNodeEffectSetMessage[] = [];
	let openingCanvas: Promise<vscode.WebviewPanel> | undefined;
	/**
	 * 새 Panel에 Dock 및 Resize UI를 설정하고 초기 Workspace context를 복원한다.
	 */
	const createCanvasPanel = async (): Promise<vscode.WebviewPanel> => {
		const webviewRoot = vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview');
		const panel = vscode.window.createWebviewPanel(
			'crispy.webview',
			'Crispy',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [webviewRoot],
				retainContextWhenHidden: true,
			},
		);
		const readProviderCliPath = (providerId: ProviderId): string | undefined =>
			vscode.workspace
				.getConfiguration('crispy')
				.get<string>(`${providerId}CliPath`);
		let requestWorkspaceTrustRefresh = (): void => undefined;
		let terminalHost!: TerminalHost;
		let agentActivityBridge: AgentActivityGraphBridge | undefined;
		const mcpSupervisor = new McpAdapterSupervisor({
			extensionUri: context.extensionUri,
			parentEnvironment: { ...process.env },
			agentActivityCompatible,
			onEvent: (event) => terminalHost?.handleMcpRuntimeEvent(event),
		});
		if (agentActivityCompatible) {
			agentActivityBridge = createAgentActivityGraphBridge({
				postMessage: (message) => panel.webview.postMessage(message),
				resolveWorkspace: resolveCurrentWorkspace,
				invalidateLease: (lease, failure) => {
					terminalHost.handleAgentActivityWorkspaceFailure(lease, failure);
				},
			});
		}
		terminalHost = new TerminalHost({
			ptyAdapter: nodePtyAdapter,
			agentActivityCompatible,
			readWorkspaceTrust: () => vscode.workspace.isTrusted,
			onWorkspaceTrustRevoked: () => requestWorkspaceTrustRefresh(),
			resolveAgentAutoRunInput: createAgentAutoRunInputResolver({
				getCliPath: readProviderCliPath,
			}),
			prepareCodexLaunch: createPrepareCodexTerminalLaunch({
				workspaceResolver: resolveCurrentWorkspace,
				resolveExecutable: resolveAgentExecutable,
				readPlatform: () => process.platform,
				readEnvironment: () => ({ ...process.env }),
				getCliPath: () => readProviderCliPath('codex'),
			}),
			prepareClaudeLaunch: createPrepareClaudeTerminalLaunch({
				workspaceResolver: resolveCurrentWorkspace,
				resolveExecutable: resolveAgentExecutable,
				readPlatform: () => process.platform,
				readEnvironment: () => ({ ...process.env }),
				getCliPath: () => readProviderCliPath('claude'),
			}),
			mcpSupervisor,
			onAgentActivityRequest: (request) => {
				agentActivityBridge?.handleAgentActivityRequest(request);
			},
			onActivityLeaseRevoked: (lease) => {
				agentActivityBridge?.revokeLease(lease);
			},
			emitMessage: (message) => {
				void Promise.resolve(panel.webview.postMessage(message)).catch(
					() => undefined,
				);
			},
		});

		const stylesUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(webviewRoot, 'styles.css'),
		);
		const monacoStylesUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(webviewRoot, 'webview.css'),
		);
		const scriptUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(webviewRoot, 'webview.js'),
		);
		const monacoWorkerUri = panel.webview.asWebviewUri(
			vscode.Uri.joinPath(webviewRoot, 'monacoEditorWorker.js'),
		);
		const workspaceGitStatusService: WorkspaceGitStatusService =
			createWorkspaceGitStatusService({
				workspace: vscode.workspace,
				getGitExtension: getBuiltInGitExtension,
				loadRootFilters: workspaceGraphDependencies.loadWorkspaceFilters,
				getWorkspaceContextGeneration: () => workspaceContextGeneration,
				postMessage: (message) => panel.webview.postMessage(message),
			});
		const workspaceNodeRequestController = createWorkspaceNodeRequestController({
			operationHost: defaultWorkspaceNodeOperationHost,
			getWorkspaceRevision: () => workspaceRevision,
			advanceWorkspaceRevision: () => {
				workspaceRevision = workspaceRevision < Number.MAX_SAFE_INTEGER
					? workspaceRevision + 1
					: workspaceRevision;
				return workspaceRevision;
			},
			getWorkspaceContextGeneration: () => workspaceContextGeneration,
			getWorkspaceState: () => workspacePersistence.getDesiredState()
				?? lastWorkspaceState
				?? createDefaultWorkspacePersistentState(),
			commitWorkspaceState: async (state) => {
				lastWorkspaceState = state;
				const sessionState = lastWebviewState
					? {
						panel: lastWebviewState.panel,
						camera: lastWebviewState.graph.camera,
					}
					: createDefaultWebviewSessionState();

				lastWebviewState = {
					panel: sessionState.panel,
					graph: {
						camera: sessionState.camera,
						nodePositions: state.nodePositions,
						fileGroupPages: state.fileGroupPages,
						openedFolders: state.openedFolders,
						detachedRootNodeIds: state.detachedRootNodeIds,
						hiddenNodeIds: state.hiddenNodeIds,
					},
				};
				const rootUris = workspacePersistenceRootUris.length > 0
					? [...workspacePersistenceRootUris]
					: getCurrentWorkspaceRootUris();
				const persistence = workspacePersistence.acceptSnapshot(state, rootUris);

				pendingWorkspaceWrites.add(persistence);
				try {
					await persistence.catch(() => undefined);
				} finally {
					pendingWorkspaceWrites.delete(persistence);
				}
			},
			createWorkspacePresentation: () => createCurrentWorkspacePresentation(
				workspacePresentationDependencies,
			),
			postMessage: (message) => panel.webview.postMessage(message),
			getGitRevision: () => workspaceGitStatusService.getGitRevision(),
			readGitOriginalText: (nodeId, maxBytes) => (
				workspaceGitStatusService.readOriginalText(nodeId, maxBytes)
			),
			requestGitRefresh: () => {
				void workspaceGitStatusService.requestRefresh();
			},
		});

		let runtime: CanvasRuntime;
		/** Webview snapshot과 Agent protocol을 각 validation boundary로 전달한다. */
		const messageSubscription = panel.webview.onDidReceiveMessage(
			(message: unknown) => {
				if (agentActivityBridge?.handleWebviewMessage(message) === true) {
					return;
				}
				handleWebviewMessage(
					panel.webview,
					message,
					terminalHost,
					() => {
						runtime?.markWebviewReady();
						workspaceGitStatusService.markWebviewReady();
					},
					undefined,
					undefined,
					workspacePersistence,
					workspaceNodeRequestController,
				);
			},
		);

		const workspaceRefresh = createWorkspaceRefreshCoordinator({
			...workspacePresentationDependencies,
			getWorkspaceContextGeneration: () => workspaceContextGeneration,
			getWorkspaceRevision: () => workspaceRevision,
			loadWorkspaceState: async (graph, _rootIds, signal) => {
				const rootUris = getWorkspaceRootUrisFromGraph(graph);
				const deliverState = shouldLoadWorkspacePersistenceState(
					rootUris,
					workspacePersistenceContextKey,
					undefined,
					latestAcknowledgedWorkspaceContextGeneration
						< workspaceContextGeneration
						|| latestAcknowledgedWorkspaceRevision < workspaceRevision,
				);

				return refreshWorkspacePersistenceForSnapshot(
					() => refreshWorkspaceStateForDelivery(rootUris, signal),
					{
						deliverState,
						retryPendingPersistence:
							workspacePersistence.hasPendingPersistence(),
					},
				);
			},
			postMessage: async (message: WorkspaceToWebviewMessage) => {
				const posted = await panel.webview.postMessage(message);

				// Root context가 먼저 교체된 뒤 같은 generation의 Git snapshot을
				// 후속 발행해 Webview의 stale-context 거부와 경합하지 않게 한다.
				void workspaceGitStatusService.requestRefresh();
				return posted;
			},
		});
		requestWorkspaceTrustRefresh = () => {
			void workspaceRefresh.requestWorkspaceRefresh();
		};
		const terminalRuntime: DetachableTerminalRuntime =
			agentActivityBridge === undefined
				? terminalHost
				: createAgentActivityCanvasTerminalRuntime(
					terminalHost,
					agentActivityBridge,
				);
		runtime = createCanvasRuntime(
			panel,
			terminalRuntime,
			[messageSubscription, workspaceGitStatusService],
			workspaceRefresh,
			undefined,
			(event) => terminalHost.handleAgentActivityWorkspaceFoldersChanged(
				event.removed.map(({ uri }) => createWorkspaceRootId(uri)),
			),
		);
		let panelDisposed = false;

		panel.onDidDispose(() => {
			panelDisposed = true;
			/** 이미 dispose된 Webview에는 cleanup clear를 post하지 않는다. */
			agentActivityBridge?.disposePanel();
			if (currentRuntime === runtime) {
				debugEffectMessages = [];
			}
			releaseCanvasRuntime(runtime);
			runtime.detach();
			void runtime.terminate().catch(() => undefined);
		});
		// 초기 async load 전부터 deactivate와 겹친 open 명령이 같은 runtime을
		// 관찰하게 해, dispose signal 없이 떠 있는 초기화를 만들지 않는다.
		currentRuntime = runtime;

		let workspacePresentation: WorkspacePresentation;
		let initialWorkspaceState: WorkspacePersistentState;

		try {
			workspacePresentation = await createCurrentWorkspacePresentation(
				workspacePresentationDependencies,
			);
			if (panelDisposed || workspaceRefresh.signal.aborted) {
				return panel;
			}
			const deliveredRootUris = getWorkspaceRootUrisFromGraph(
				workspacePresentation.graph,
			);

			initialWorkspaceState = await refreshWorkspaceStateForDelivery(
				deliveredRootUris,
				workspaceRefresh.signal,
			);
		} catch (error) {
			if (panelDisposed || workspaceRefresh.signal.aborted) {
				return panel;
			}
			releaseCanvasRuntime(runtime);
			runtime.detach();
			try {
				panel.dispose();
			} catch {
				/** 초기화 실패 Panel 정리 오류는 원래 실패를 대체하지 않는다. */
			}
			void runtime.terminate().catch(() => undefined);
			throw error;
		}
		if (panelDisposed || workspaceRefresh.signal.aborted) {
			return panel;
		}
		const initialWebviewState = createInitialWebviewState(
			lastWebviewState,
			initialWorkspaceState,
		);
		lastWebviewState = initialWebviewState;

		panel.webview.html = getWebviewHtml(
			panel.webview,
			stylesUri,
			monacoStylesUri,
			scriptUri,
			monacoWorkerUri,
			initialWebviewState,
			workspacePresentation,
			initialWorkspaceState,
			workspaceContextGeneration,
			workspaceRevision,
		);
		return panel;
	};
	/** 기존 Panel을 표시하고, 겹친 최초 명령은 같은 초기화 Promise를 공유한다. */
	const openCanvas = async (): Promise<vscode.WebviewPanel> => {
		if (openingCanvas && currentRuntime) {
			return openingCanvas;
		}
		// 초기 Panel이 dispose되어 currentRuntime에서 해제됐지만 async 초기화
		// Promise가 끝나지 않은 경우에는 disposed Panel을 재사용하지 않는다.
		if (openingCanvas && !currentRuntime) {
			openingCanvas = undefined;
		}
		if (currentRuntime) {
			/** 기존 Panel을 다시 표시하는 것은 dispose가 아니므로 세션을 그대로 유지한다. */
			currentRuntime.panel.reveal();
			return currentRuntime.panel;
		}
		const opening = createCanvasPanel();

		openingCanvas = opening;
		try {
			return await opening;
		} finally {
			if (openingCanvas === opening) {
				openingCanvas = undefined;
			}
		}
	};

	const postDebugMessage = async (
		panel: vscode.WebviewPanel,
		message: ExtensionToWebviewMessage,
	): Promise<void> => {
		try {
			await panel.webview.postMessage(message);
		} catch {
			/** Debug command 실패가 Canvas 또는 다른 Extension command로 전파되지 않는다. */
		}
	};
	const debugNodeEffects = async (): Promise<void> => {
		const panel = await openCanvas();
		let graph: Graph;

		try {
			graph = await createCurrentWorkspaceGraph(workspaceGraphDependencies);
		} catch {
			return;
		}

		if (currentRuntime?.panel !== panel) {
			return;
		}
		const nextMessages = createGraphNodeEffectDebugMessages(
			graph,
			lastWebviewState?.graph,
		);
		const nextKindsByTarget = collectEffectKindsByTarget(nextMessages);

		for (const previousMessage of debugEffectMessages) {
			const nextKinds = nextKindsByTarget.get(createEffectTargetKey(
				previousMessage.target,
			));

			if (!nextKinds?.has(previousMessage.effect.kind)) {
				await postDebugMessage(panel, {
					type: 'graph.nodeEffect.clear',
					target: previousMessage.target,
					kind: previousMessage.effect.kind,
				});
			}
		}

		for (const message of nextMessages) {
			await postDebugMessage(panel, message);
		}
		debugEffectMessages = nextMessages;
	};
	const clearNodeEffects = async (): Promise<void> => {
		const panel = currentRuntime?.panel;

		if (panel) {
			const targets = new Map(debugEffectMessages.map((message) => [
				createEffectTargetKey(message.target),
				message.target,
			]));

			for (const target of targets.values()) {
				await postDebugMessage(panel, {
					type: 'graph.nodeEffect.clear',
					target,
				});
			}
		}
		debugEffectMessages = [];
	};
	const debugAgentActivities = async (): Promise<void> => {
		const panel = await openCanvas();
		let graph: Graph;

		try {
			graph = await createCurrentWorkspaceGraph(workspaceGraphDependencies);
		} catch {
			return;
		}

		if (currentRuntime?.panel !== panel) {
			return;
		}

		await postAgentActivityDebugMessages(
			(message) => postDebugMessage(panel, message),
			graph,
			lastWebviewState?.graph,
		);
	};
	const clearAgentActivities = async (): Promise<void> => {
		const panel = currentRuntime?.panel;

		if (!panel) {
			return;
		}

		await postAgentActivityDebugClearMessages(
			(message) => postDebugMessage(panel, message),
		);
	};
	const openCanvasDisposable = vscode.commands.registerCommand(
		OPEN_CANVAS_COMMAND_ID,
		openCanvas,
	);
	const debugNodeEffectsDisposable = vscode.commands.registerCommand(
		DEBUG_NODE_EFFECTS_COMMAND_ID,
		debugNodeEffects,
	);
	const clearNodeEffectsDisposable = vscode.commands.registerCommand(
		CLEAR_NODE_EFFECTS_COMMAND_ID,
		clearNodeEffects,
	);
	const debugAgentActivitiesDisposable = vscode.commands.registerCommand(
		DEBUG_AGENT_ACTIVITIES_COMMAND_ID,
		debugAgentActivities,
	);
	const clearAgentActivitiesDisposable = vscode.commands.registerCommand(
		CLEAR_AGENT_ACTIVITIES_COMMAND_ID,
		clearAgentActivities,
	);

	context.subscriptions.push(
		openCanvasDisposable,
		debugNodeEffectsDisposable,
		clearNodeEffectsDisposable,
		debugAgentActivitiesDisposable,
		clearAgentActivitiesDisposable,
	);

	return Object.freeze({
		deactivate,
		requestWorkspaceRefresh,
		handleWebviewMessage,
	});
}

/**
 * Panel이 소유한 TerminalHost와 Webview 구독을 하나의 정리 경계로 묶는다.
 * 실제 정리 순서와 오류 격리는 Host 공용 cleanup 함수가 담당하며,
 * 반복 호출 시 첫 정리 Promise를 그대로 반환해 중복 정리를 하지 않는다.
 *
 * @param panel 정리 대상 Terminal을 표시하던 Webview Panel
 * @param terminalHost Panel이 소유한 Terminal session 및 PTY 정리 경계
 * @param subscriptions Host detach 전에 해제할 Webview message listener 구독 목록
 * @param workspaceRefresh Panel과 함께 유지할 Workspace Refresh coordinator
 * @param watchWorkspace Canvas에 귀속할 Workspace 변경 watcher 생성 함수
 * @param onWorkspaceFoldersChange Graph refresh 전에 Root ownership을 검사할 callback
 * @returns Panel dispose와 deactivate가 공유하는 멱등한 정리 경계
 */
export function createCanvasRuntime(
	panel: vscode.WebviewPanel,
	terminalHost: DetachableTerminalRuntime,
	subscriptions: readonly vscode.Disposable[],
	workspaceRefresh: WorkspaceRefreshCoordinator,
	watchWorkspace: (
		onChange: () => void,
		onWorkspaceFoldersChange?: (
			event: vscode.WorkspaceFoldersChangeEvent,
		) => void,
	) => vscode.Disposable = (onChange, onWorkspaceFoldersChange) => (
		watchWorkspaceChanges(
			onChange,
			vscode.workspace,
			onWorkspaceFoldersChange,
		)
	),
	onWorkspaceFoldersChange: (
		event: vscode.WorkspaceFoldersChangeEvent,
	) => void = () => undefined,
): CanvasRuntime {
	let webviewReady = false;
	let refreshPendingUntilReady = false;
	let detached = false;
	const workspaceWatcher = watchWorkspace(() => {
		if (detached) {
			return;
		}

		if (!webviewReady) {
			refreshPendingUntilReady = true;
			return;
		}

		void workspaceRefresh.requestWorkspaceRefresh();
	}, onWorkspaceFoldersChange);
	const cleanup = createTerminalRuntimeCleanup(
		terminalHost,
		[...subscriptions, workspaceWatcher],
	);

	return {
		panel,
		requestWorkspaceRefresh(): Promise<void> {
			if (detached) {
				return Promise.resolve();
			}
			if (!webviewReady) {
				refreshPendingUntilReady = true;
				return Promise.resolve();
			}
			return workspaceRefresh.requestWorkspaceRefresh();
		},
		markWebviewReady(): void {
			if (detached || webviewReady) {
				return;
			}

			webviewReady = true;
			if (refreshPendingUntilReady) {
				refreshPendingUntilReady = false;
				void workspaceRefresh.requestWorkspaceRefresh();
			}
		},
		detach(): void {
			detached = true;
			refreshPendingUntilReady = false;
			/** Webview/Terminal 정리보다 먼저 Refresh 결과와 pending 실행을 차단한다. */
			workspaceRefresh.dispose();
			cleanup.detach();
		},
		terminate: cleanup.terminate,
	};
}

/**
 * Live Canvas detach에서는 TerminalHost가 exact leases를 revoke하고 cleanup clear를
 * admission한 뒤 bridge를 panel에서 분리한다. 이미 dispose된 panel 경로는 호출자가
 * 먼저 `bridge.disposePanel()`을 실행해 post를 금지한다.
 */
export function createAgentActivityCanvasTerminalRuntime(
	terminalHost: DetachableTerminalRuntime,
	bridge: Pick<AgentActivityGraphBridge, 'disposePanel'>,
): DetachableTerminalRuntime {
	return {
		detach(): void {
			try {
				terminalHost.detach();
			} finally {
				bridge.disposePanel();
			}
		},
		terminate: () => terminalHost.terminate(),
	};
}

/** 현재 Canvas runtime에 직렬화 Workspace Refresh를 요청한다. */
export function requestWorkspaceRefresh(): Promise<void> {
	return currentRuntime?.requestWorkspaceRefresh() ?? Promise.resolve();
}

/**
 * 이미 정리되었거나 정리 중인 runtime을 현재 Panel 참조에서 분리한다.
 * 새 Panel이 등록된 뒤 이전 Panel의 dispose가 도착해도 참조를 지우지 않는다.
 *
 * @param runtime 현재 참조에서 분리할 Canvas runtime
 */
function releaseCanvasRuntime(runtime: CanvasRuntime): void {
	if (currentRuntime === runtime) {
		currentRuntime = undefined;
	}
}

/**
 * Webview가 전송한 unknown 메시지를 구조적으로 검증한 뒤 처리한다.
 * 검증 실패 시 원본 payload를 기록하거나 Webview로 반사하지 않으며,
 * 검증된 terminal 메시지만 별도의 실행 전 dispatch 경계로 전달한다.
 *
 * @param webview 응답 메시지를 전송할 Webview
 * @param message Webview에서 수신한 메시지
 * @param terminalHost 검증된 Terminal 메시지를 전달할 Host 경계
 * @param onWebviewReady 검증된 ready 뒤 Canvas 초기화 대기를 해제할 callback
 * @param workspaceFileHost Workspace 검증 및 Editor 열기를 수행할 Host 경계
 * @param taskClipboardHost 검증된 Task JSON을 clipboard에 기록할 Host 경계
 * @returns 메시지를 Webview에 전달한 결과 또는 처리 대상이 아닐 때 `undefined`
 */
export function handleWebviewMessage(
	webview: Pick<vscode.Webview, 'postMessage'>,
	message: unknown,
	terminalHost?: TerminalMessageHost,
	onWebviewReady?: () => void,
	workspaceFileHost: WorkspaceFileHost = defaultWorkspaceFileHost,
	taskClipboardHost: TaskClipboardHost = defaultTaskClipboardHost,
	workspacePersistence: WorkspacePersistenceCoordinator | undefined
		= activeWorkspacePersistence,
	workspaceNodeRequestController?: WorkspaceNodeRequestController,
): Thenable<boolean> | undefined {
	if (message && typeof message === 'object') {
		const candidate = message as Record<string, unknown>;

		if (typeof candidate.type === 'string'
			&& candidate.type.startsWith('workspace.node')) {
			const request = parseWorkspaceNodeRequestMessage(candidate);

			if (request) {
				workspaceNodeRequestController?.handle(request);
			}
			return undefined;
		}

		if (candidate.type === 'workspace.openFile') {
			const openFileMessage = parseWorkspaceOpenFileMessage(candidate);

			if (openFileMessage) {
				openWorkspaceFile(openFileMessage, workspaceFileHost);
			}

			return undefined;
		}

		if (candidate.type === 'task.copyJson') {
			const copyMessage = parseTaskJsonCopyMessage(candidate);

			if (copyMessage) {
				copyTaskJsonToClipboard(copyMessage, taskClipboardHost);
			}

			return undefined;
		}

		if (candidate.type === 'task.copyJsonFailed') {
			const failureMessage = parseTaskJsonCopyFailedMessage(candidate);

			if (failureMessage) {
				reportTaskJsonCopyFailure(failureMessage, taskClipboardHost);
			}

			return undefined;
		}

		if (candidate.type === 'webview.stateChanged') {
			const state = parseWebviewSessionState(candidate.state);

			if (state) {
				lastWebviewState = {
					panel: state.panel,
					graph: {
						camera: state.camera,
						nodePositions: lastWebviewState?.graph.nodePositions ?? {},
						fileGroupPages: lastWebviewState?.graph.fileGroupPages ?? {},
						openedFolders: lastWebviewState?.graph.openedFolders ?? {},
						detachedRootNodeIds:
							lastWebviewState?.graph.detachedRootNodeIds ?? {},
						hiddenNodeIds:
							lastWebviewState?.graph.hiddenNodeIds ?? {},
					},
				};
			}

			return undefined;
		}

		if (candidate.type === 'workspace.stateChanged') {
			const state = parseWorkspacePersistentState(candidate.state);
			const rootIds = parseWorkspaceRootIds(candidate.rootIds);
			const messageRootUris = rootIds
				? parseWorkspaceRootUris(rootIds)
				: undefined;
			const contextGeneration = Number.isSafeInteger(
				candidate.contextGeneration,
			) && (candidate.contextGeneration as number) >= 0
				? candidate.contextGeneration as number
				: undefined;
			const messageWorkspaceRevision = candidate.workspaceRevision === undefined
				? 0
				: Number.isSafeInteger(candidate.workspaceRevision)
					&& (candidate.workspaceRevision as number) >= 0
					? candidate.workspaceRevision as number
					: undefined;

			if (
				state
				&& messageRootUris
				&& contextGeneration !== undefined
				&& messageWorkspaceRevision === workspaceRevision
				&& (Object.keys(candidate).length === 4
					|| Object.keys(candidate).length === 5)
			) {
				const messageContextKey = createWorkspaceContextKey(messageRootUris);
				let stateToPersist = state;
				let rootUris = messageRootUris;

				latestAcknowledgedWorkspaceRevision = Math.max(
					latestAcknowledgedWorkspaceRevision,
					messageWorkspaceRevision,
				);

				if (workspacePersistence && workspacePersistenceContextKey) {
					if (
						contextGeneration === workspaceContextGeneration
						&& messageContextKey === workspacePersistenceContextKey
					) {
						rootUris = [...workspacePersistenceRootUris];
						latestAcknowledgedWorkspaceContextGeneration = Math.max(
							latestAcknowledgedWorkspaceContextGeneration,
							contextGeneration,
						);
						for (const generation of workspaceContextByGeneration.keys()) {
							if (generation < latestAcknowledgedWorkspaceContextGeneration) {
								workspaceContextByGeneration.delete(generation);
							}
						}
					} else {
						const previousContext = workspaceContextByGeneration.get(
							contextGeneration,
						);

						if (
							!canMergeRetainedWorkspaceContextGeneration(
								contextGeneration,
								workspaceContextGeneration,
								latestAcknowledgedWorkspaceContextGeneration,
							)
							|| !previousContext
							|| previousContext.contextKey !== messageContextKey
						) {
							return undefined;
						}
						const currentState = workspacePersistence.getDesiredState()
							?? lastWorkspaceState
							?? createDefaultWorkspacePersistentState();

						stateToPersist = mergeRetainedWorkspaceState(
							currentState,
							state,
							workspacePersistenceRootUris,
							previousContext.rootUris,
							collectContinuouslyRetainedRootKeys(
								contextGeneration,
								workspaceContextGeneration,
							),
						);
						rootUris = [...workspacePersistenceRootUris];
					}
				}
				if (workspacePersistence) {
					stateToPersist = preserveUnresolvedTaskRelocations(
						workspacePersistence.getDesiredState(),
						stateToPersist,
						rootUris,
					);
				}

				lastWorkspaceState = stateToPersist;
				const sessionState = lastWebviewState
					? {
						panel: lastWebviewState.panel,
						camera: lastWebviewState.graph.camera,
					}
					: createDefaultWebviewSessionState();

				lastWebviewState = {
					panel: sessionState.panel,
					graph: {
						camera: sessionState.camera,
						nodePositions: stateToPersist.nodePositions,
						fileGroupPages: stateToPersist.fileGroupPages,
						openedFolders: stateToPersist.openedFolders,
						detachedRootNodeIds: stateToPersist.detachedRootNodeIds,
						hiddenNodeIds: stateToPersist.hiddenNodeIds,
					},
				};
				const persistence = workspacePersistence
					? workspacePersistence.acceptSnapshot(stateToPersist, rootUris)
					: persistWorkspacePersistentStateForRoots(stateToPersist, rootUris);
				pendingWorkspaceWrites.add(persistence);
				void persistence.then(
					() => pendingWorkspaceWrites.delete(persistence),
					() => pendingWorkspaceWrites.delete(persistence),
				);
			}

			return undefined;
		}
	}

	const parseResult = parseWebviewToHostMessage(message);
	if (!parseResult.ok) {
		return undefined;
	}

	switch (parseResult.value.type) {
		case 'webview.ready':
			onWebviewReady?.();
			console.log('[Crispy] Webview ready');

			return webview.postMessage({
				type: 'extension.ready',
			} satisfies ExtensionToWebviewMessage);
		default:
			return handleTerminalMessage(parseResult.value, terminalHost);
	}
}

/**
 * 현재 epoch보다 오래됐지만 그 뒤 이미 ack된 epoch에는 선행하지 않는 snapshot만
 * pre-ack retained merge 후보로 허용한다.
 */
export function canMergeRetainedWorkspaceContextGeneration(
	messageGeneration: number,
	currentGeneration: number,
	latestAcknowledgedGeneration: number,
): boolean {
	return messageGeneration < currentGeneration
		&& messageGeneration >= latestAcknowledgedGeneration;
}

/** Task JSON clipboard 요청의 exact field, 문자열 및 크기 제한을 검증한다. */
function parseTaskJsonCopyMessage(
	value: Record<string, unknown>,
): TaskJsonCopyMessage | undefined {
	if (
		value.type !== 'task.copyJson'
		|| Object.keys(value).length !== 2
		|| typeof value.json !== 'string'
		|| value.json.length === 0
		|| new TextEncoder().encode(value.json).byteLength
			> TASK_TRANSFER_JSON_MAX_BYTES
		|| !parseTaskTransferJson(value.json).ok
	) {
		return undefined;
	}

	return { type: 'task.copyJson', json: value.json };
}

/** Task JSON 생성 실패 메시지의 exact field와 reason allowlist를 검증한다. */
function parseTaskJsonCopyFailedMessage(
	value: Record<string, unknown>,
): TaskJsonCopyFailedMessage | undefined {
	if (
		value.type !== 'task.copyJsonFailed'
		|| Object.keys(value).length !== 2
		|| (
			value.reason !== 'transfer_limit'
			&& value.reason !== 'invalid_task'
		)
	) {
		return undefined;
	}

	return { type: 'task.copyJsonFailed', reason: value.reason };
}

/** 검증된 Webview export 실패만 사용자 알림 경계로 전달한다. */
function reportTaskJsonCopyFailure(
	message: TaskJsonCopyFailedMessage,
	host: TaskClipboardHost,
): void {
	try {
		host.reportCopyFailure(message.reason);
	} catch {
		/** 사용자 알림 실패가 다른 Webview 메시지 처리로 전파되지 않게 한다. */
	}
}

/** 검증된 Task JSON만 clipboard에 기록하고 완료 상태만 사용자에게 알린다. */
function copyTaskJsonToClipboard(
	message: TaskJsonCopyMessage,
	host: TaskClipboardHost,
): void {
	try {
		void Promise.resolve(host.writeText(message.json)).then(
			() => host.reportCopySuccess(),
			() => host.reportCopyFailure(),
		);
	} catch {
		host.reportCopyFailure();
	}
}

/** Workspace File Open payload의 type, exact field 및 Crispy File ID를 검증한다. */
function parseWorkspaceOpenFileMessage(
	value: Record<string, unknown>,
): WorkspaceOpenFileMessage | undefined {
	if (
		value.type !== 'workspace.openFile'
		|| Object.keys(value).length !== 2
		|| typeof value.fileId !== 'string'
		|| !value.fileId.startsWith('file:')
	) {
		return undefined;
	}

	return {
		type: 'workspace.openFile',
		fileId: value.fileId,
	};
}

/** Crispy File ID의 URI를 복원해 현재 Workspace의 활성 Editor Group에 연다. */
function openWorkspaceFile(
	message: WorkspaceOpenFileMessage,
	workspaceFileHost: WorkspaceFileHost,
): void {
	try {
		const uri = vscode.Uri.parse(message.fileId.slice('file:'.length), true);

		if (!workspaceFileHost.getWorkspaceFolder(uri)) {
			return;
		}

		void Promise.resolve(workspaceFileHost.showTextDocument(uri, {
			viewColumn: vscode.ViewColumn.Active,
			preview: false,
			preserveFocus: false,
		})).catch(() => undefined);
	} catch {
		/** 잘못되었거나 사라진 File은 다른 Webview 메시지 처리에 영향을 주지 않는다. */
	}
}

/** 현재 열린 Workspace Folder의 Root URI를 순서대로 복사한다. */
function getCurrentWorkspaceRootUris(): vscode.Uri[] {
	return (vscode.workspace.workspaceFolders ?? []).map(({ uri }) => uri);
}

/** Root 순서 변경은 동일 context로 보되 Root 추가/제거는 구분하는 stable key다. */
function createWorkspaceContextKey(rootUris: readonly vscode.Uri[]): string {
	return JSON.stringify(rootUris.map((uri) => uri.toString()).sort());
}

/** 새 Root context, 미완료 materialization 또는 Webview 미확인 epoch만 full state를 싣는다. */
export function shouldLoadWorkspacePersistenceState(
	rootUris: readonly vscode.Uri[],
	currentContextKey: string | undefined,
	pendingMaterializationGeneration: number | undefined,
	hasUnacknowledgedContext = false,
): boolean {
	return createWorkspaceContextKey(rootUris) !== currentContextKey
		|| pendingMaterializationGeneration !== undefined
		|| hasUnacknowledgedContext;
}

/**
 * Workspace state 전달과 disk retry를 분리한다. 같은 epoch가 이미 확인된 뒤에는
 * pending write만 재시도하고, 그 과정에서 읽은 Host state를 Webview에 재전송하지 않는다.
 */
export async function refreshWorkspacePersistenceForSnapshot(
	refreshState: () => Promise<WorkspacePersistentState>,
	options: Readonly<{
		deliverState: boolean;
		retryPendingPersistence: boolean;
	}>,
): Promise<WorkspacePersistentState | undefined> {
	if (!options.deliverState && !options.retryPendingPersistence) {
		return undefined;
	}
	const state = await refreshState();

	return options.deliverState ? state : undefined;
}

/** Project Root semantic IDs를 URI 배열로 엄격히 복원한다. */
function parseWorkspaceRootUris(
	rootIds: readonly string[],
): vscode.Uri[] | undefined {
	const rootUris: vscode.Uri[] = [];

	for (const rootId of rootIds) {
		if (!rootId.startsWith('workspace-root:')) {
			return undefined;
		}
		try {
			rootUris.push(vscode.Uri.parse(
				rootId.slice('workspace-root:'.length),
				true,
			));
		} catch {
			return undefined;
		}
	}
	return rootUris;
}

/** Webview에 전달한 Graph의 Project Root IDs를 실제 persistence URI로 복원한다. */
function getWorkspaceRootUrisFromGraph(graph: Graph): vscode.Uri[] {
	return parseWorkspaceRootUris(getWorkspaceGraphRootIds(graph)) ?? [];
}

/**
 * 전환 전 Webview snapshot은 old/current topology에서 owner가 그대로인 entry만
 * overlay하고, 새·재추가·ownership 이동 entry는 현재 Host desired를 유지한다.
 */
function mergeRetainedWorkspaceState(
	currentState: WorkspacePersistentState,
	previousContextState: WorkspacePersistentState,
	currentRootUris: readonly vscode.Uri[],
	previousRootUris: readonly vscode.Uri[],
	retainedRootKeys: ReadonlySet<string> = new Set(
		previousRootUris.map((rootUri) => rootUri.toString()),
	),
): WorkspacePersistentState {
	const createRootId = (rootUri: vscode.Uri): string => (
		`workspace-root:${rootUri.toString()}`
	);
	const graphState = mergeContinuouslyRetainedWorkspaceGraphState(
		currentState,
		previousContextState,
		previousRootUris.map(createRootId),
		currentRootUris.map(createRootId),
		new Set([...retainedRootKeys].map((rootKey) => (
			`workspace-root:${rootKey}`
		))),
	);
	const taskState = mergeContinuouslyRetainedWorkspaceTaskState(
		currentState,
		previousContextState,
		previousRootUris.map(createRootId),
		currentRootUris.map(createRootId),
		new Set([...retainedRootKeys].map((rootKey) => (
			`workspace-root:${rootKey}`
		))),
	);

	return {
		version: currentState.version,
		...graphState,
		...taskState,
		taskStorageReceipts: currentState.taskStorageReceipts,
	};
}

/** from epoch부터 current epoch까지 한 번도 빠지지 않은 Root URI만 반환한다. */
function collectContinuouslyRetainedRootKeys(
	fromGeneration: number,
	toGeneration: number,
): ReadonlySet<string> {
	const source = workspaceContextByGeneration.get(fromGeneration);
	const retained = new Set(
		source?.rootUris.map((rootUri) => rootUri.toString()) ?? [],
	);

	for (
		let generation = fromGeneration + 1;
		generation <= toGeneration;
		generation += 1
	) {
		const context = workspaceContextByGeneration.get(generation);

		if (!context) {
			return new Set();
		}
		const activeKeys = new Set(
			context.rootUris.map((rootUri) => rootUri.toString()),
		);

		for (const key of retained) {
			if (!activeKeys.has(key)) {
				retained.delete(key);
			}
		}
	}
	return retained;
}

/**
 * Webview가 알 필요 없는 source journal은 destination Root가 비활성일 때만 보존한다.
 * 활성 destination에서 Task가 없으면 삭제/후속 이동으로 해석하고, Task가 있으면
 * coordinator가 destination-first write를 수행할 수 있으므로 오래된 journal을 정리한다.
 */
export function preserveUnresolvedTaskRelocations(
	currentState: WorkspacePersistentState | undefined,
	nextState: WorkspacePersistentState,
	rootUris: readonly vscode.Uri[],
): WorkspacePersistentState {
	const activeRootIds = new Set(rootUris.map(
		(rootUri) => `workspace-root:${rootUri.toString()}`,
	));
	const relocations = new Map<string, WorkspacePersistentState[
		'taskRelocations'
	][number]>();
	const receipts = new Map<string, WorkspacePersistentState[
		'taskStorageReceipts'
	][number]>();

	for (const relocation of [
		...(currentState?.taskRelocations ?? []),
		...nextState.taskRelocations,
	]) {
		if (
			!activeRootIds.has(relocation.sourceRootId)
			|| activeRootIds.has(relocation.record.ownerRootId)
		) {
			continue;
		}
		const key = JSON.stringify([
			relocation.sourceRootId,
			relocation.record.task.id,
		]);
		const existing = relocations.get(key);

		if (
			!existing
			|| relocation.record.storageRevision
				> existing.record.storageRevision
		) {
			relocations.set(key, relocation);
		}
	}
	const mergeReceipt = (
		receipt: WorkspacePersistentState['taskStorageReceipts'][number],
	): void => {
		if (!activeRootIds.has(receipt.ownerRootId)) {
			return;
		}
		const key = JSON.stringify([receipt.ownerRootId, receipt.taskId]);
		const existing = receipts.get(key);

		if (!existing || receipt.storageRevision > existing.storageRevision) {
			receipts.set(key, receipt);
		}
	};

	for (const receipt of [
		...(currentState?.taskStorageReceipts ?? []),
		...nextState.taskStorageReceipts,
	]) {
		mergeReceipt(receipt);
	}
	for (const record of [
		...(currentState?.tasks ?? []),
		...nextState.tasks,
	]) {
		mergeReceipt({
			ownerRootId: record.ownerRootId,
			taskId: record.task.id,
			storageRevision: record.storageRevision,
		});
	}

	return {
		...nextState,
		taskRelocations: [...relocations.values()],
		taskStorageReceipts: [...receipts.values()],
	};
}

/**
 * Root 전환에서 retained Root는 Host desired, 새 Root는 disk를 택한다. 동시에
 * 제거된 source의 journal만 receipt-aware Task winner 계산에 참여시켜
 * A-only→B-only 전환을 복구하되 source의 Graph/live 상태는 가져오지 않는다.
 */
export function mergeWorkspacePersistenceRootTransition(
	latestDesired: WorkspacePersistentState | undefined,
	loaded: WorkspacePersistentState,
	previousRootUris: readonly vscode.Uri[],
	nextRootUris: readonly vscode.Uri[],
): WorkspacePersistentState {
	const previousRootKeys = new Set(previousRootUris.map((uri) => uri.toString()));
	const nextRootKeys = new Set(nextRootUris.map((uri) => uri.toString()));
	const desiredByRoot = latestDesired
		? new Map(partitionWorkspacePersistentStateByRoot(
			latestDesired,
			nextRootUris,
		).map((rootState) => [rootState.rootUri.toString(), rootState]))
		: new Map<string, ReturnType<
			typeof partitionWorkspacePersistentStateByRoot
		>[number]>();
	const loadedByRoot = new Map(partitionWorkspacePersistentStateByRoot(
		loaded,
		nextRootUris,
	).map((rootState) => [rootState.rootUri.toString(), rootState]));
	const selectedRootStates = nextRootUris.flatMap((rootUri) => {
		const key = rootUri.toString();
		const selected = previousRootKeys.has(key)
			? desiredByRoot.get(key) ?? loadedByRoot.get(key)
			: loadedByRoot.get(key);

		return selected ? [selected] : [];
	});
	const merged = mergeWorkspacePersistentStates(selectedRootStates);

	if (!latestDesired) {
		return merged;
	}
	const removedSourceStates = previousRootUris.flatMap((rootUri) => {
		if (nextRootKeys.has(rootUri.toString())) {
			return [];
		}
		const sourceRootId = `workspace-root:${rootUri.toString()}`;
		const taskRelocations = latestDesired.taskRelocations.filter(
			(relocation) => relocation.sourceRootId === sourceRootId,
		);

		return taskRelocations.length === 0
			? []
			: [{
				rootUri,
				state: {
					...createDefaultWorkspacePersistentState(),
					taskRelocations,
				},
			}];
	});

	if (removedSourceStates.length === 0) {
		return merged;
	}
	const recovered = mergeWorkspacePersistentStates([
		...selectedRootStates,
		...removedSourceStates,
	]);
	const nextRootIds = new Set(nextRootUris.map(
		(rootUri) => `workspace-root:${rootUri.toString()}`,
	));

	return {
		...merged,
		tasks: recovered.tasks.filter((record) => (
			nextRootIds.has(record.ownerRootId)
		)),
		taskStorageReceipts: recovered.taskStorageReceipts.filter((receipt) => (
			nextRootIds.has(receipt.ownerRootId)
		)),
	};
}

/**
 * live Root 변경 시 retained Root는 최신 Host desired state를, 새 Root는 disk state를
 * 사용해 하나의 canonical snapshot으로 합친다. 단순 파일 변화나 Root reorder는
 * 현재 desired snapshot을 그대로 유지해 pending Webview 편집을 되돌리지 않는다.
 */
export async function refreshWorkspacePersistenceContext(
	coordinator: WorkspacePersistenceCoordinator,
	rootUris: readonly vscode.Uri[],
	signal?: AbortSignal,
	options: Readonly<{
		allowPendingPersistence?: boolean;
	}> = {},
): Promise<WorkspacePersistentState> {
	assertWorkspacePersistenceRefreshActive(signal);
	const contextKey = createWorkspaceContextKey(rootUris);
	const desired = coordinator.getDesiredState() ?? lastWorkspaceState;

	if (contextKey === workspacePersistenceContextKey && desired) {
		const currentGeneration = workspaceContextGeneration;
		const fullyPersisted = await flushWorkspacePersistenceForRefresh(
			coordinator,
			options.allowPendingPersistence === true,
			signal,
		);

		assertWorkspacePersistenceRefreshActive(signal);
		if (
			workspacePersistenceContextKey !== contextKey
			|| workspaceContextGeneration !== currentGeneration
		) {
			throw new Error('Workspace persistence context was superseded.');
		}
		if (!fullyPersisted) {
			return coordinator.getDesiredState() ?? desired;
		}
		workspacePersistenceRootUris = [...rootUris];
		workspaceContextByGeneration.set(workspaceContextGeneration, {
			contextKey,
			rootUris: [...rootUris],
		});
		if (pendingWorkspaceMaterializationGeneration === currentGeneration) {
			pendingWorkspaceMaterializationGeneration = undefined;
		}
		return coordinator.getDesiredState() ?? desired;
	}

	await flushWorkspacePersistenceForRefresh(
		coordinator,
		options.allowPendingPersistence === true,
		signal,
	);
	assertWorkspacePersistenceRefreshActive(signal);
	const loaded = await loadWorkspacePersistentStateForRoots(rootUris);
	assertWorkspacePersistenceRefreshActive(signal);
	// Disk read 중 이전 Webview가 retained Root를 편집했을 수 있다. 두 번째
	// flush 뒤에는 다음 await 없이 latest desired를 병합해 baseline 교체 race를 닫는다.
	await flushWorkspacePersistenceForRefresh(
		coordinator,
		options.allowPendingPersistence === true,
		signal,
	);
	assertWorkspacePersistenceRefreshActive(signal);
	const latestDesired = coordinator.getDesiredState()
		?? lastWorkspaceState
		?? desired;
	const merged = mergeWorkspacePersistenceRootTransition(
		latestDesired,
		loaded,
		workspacePersistenceRootUris,
		rootUris,
	);
	const nextGeneration = nextWorkspaceContextGeneration + 1;

	// loaded는 현재 Root들의 실제 disk baseline이고 merged는 retained Host 상태와
	// 새 Root disk 상태를 새 topology로 repartition한 desired snapshot이다.
	// accept를 항상 수행해야 journal recovery와 nested ownership 이관이 ack 전에도
	// 각 목적지 Root에 materialize된다.
	let persisted: WorkspacePersistentState;

	try {
		persisted = await materializeWorkspacePersistenceContext(
			coordinator,
			loaded,
			merged,
			rootUris,
			signal,
			() => {
				// accept 예약과 다음 await 사이에 epoch를 공개한다. 이 구간의 old
				// Webview snapshot은 새 context로 retained merge되어 desired를 갱신한다.
				pendingWorkspaceMaterializationGeneration = nextGeneration;
				lastWorkspaceState = merged;
				workspacePersistenceContextKey = contextKey;
				workspacePersistenceRootUris = [...rootUris];
				workspaceContextGeneration = nextGeneration;
				nextWorkspaceContextGeneration = nextGeneration;
				workspaceContextByGeneration.set(workspaceContextGeneration, {
					contextKey,
					rootUris: [...rootUris],
				});
			},
		);
	} catch (error) {
		if (
			options.allowPendingPersistence !== true
			|| signal?.aborted === true
			|| !coordinator.hasPendingPersistence()
			|| workspaceContextGeneration !== nextGeneration
			|| workspacePersistenceContextKey !== contextKey
		) {
			throw error;
		}
		// Trust 전에는 새 Root context와 desired state만 원자적으로 공개한다.
		// pending materialization은 Trust grant의 같은-context refresh가 확정한다.
		return coordinator.getDesiredState() ?? merged;
	}
	if (
		workspaceContextGeneration !== nextGeneration
		|| workspacePersistenceContextKey !== contextKey
	) {
		throw new Error('Workspace persistence context was superseded.');
	}

	if (pendingWorkspaceMaterializationGeneration === nextGeneration) {
		pendingWorkspaceMaterializationGeneration = undefined;
	}
	lastWorkspaceState = persisted;
	return persisted;
}

/** Trust 때문에 보류된 write만 context refresh 진행과 분리한다. */
async function flushWorkspacePersistenceForRefresh(
	coordinator: WorkspacePersistenceCoordinator,
	allowPendingPersistence: boolean,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		await coordinator.flush();
		return true;
	} catch (error) {
		if (
			!allowPendingPersistence
			|| signal?.aborted === true
			|| !coordinator.hasPendingPersistence()
		) {
			throw error;
		}
		return false;
	}
}

/**
 * 실제 disk baseline과 topology 합성 desired를 coordinator에 연속 등록하고,
 * destination materialization이 끝날 때까지 기다린다.
 */
export async function materializeWorkspacePersistenceContext(
	coordinator: WorkspacePersistenceCoordinator,
	loadedState: WorkspacePersistentState,
	desiredState: WorkspacePersistentState,
	rootUris: readonly vscode.Uri[],
	signal?: AbortSignal,
	onAccepted: () => void = () => undefined,
): Promise<WorkspacePersistentState> {
	assertWorkspacePersistenceRefreshActive(signal);
	coordinator.setInitialState(loadedState, rootUris);
	const persistence = coordinator.acceptSnapshot(desiredState, rootUris);

	onAccepted();
	await persistence;
	await coordinator.flush();
	assertWorkspacePersistenceRefreshActive(signal);
	return coordinator.getDesiredState() ?? desiredState;
}

/** dispose된 Canvas의 async metadata 결과가 Host context를 commit하지 않게 한다. */
function assertWorkspacePersistenceRefreshActive(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new Error('Workspace persistence refresh was cancelled.');
	}
}

/** Root별 metadata를 모두 읽은 뒤 기존 ownership 검증으로 병합한다. */
export async function loadWorkspacePersistentStateForRoots(
	rootUris: readonly vscode.Uri[],
	readState: (
		rootUri: vscode.Uri,
	) => Promise<WorkspacePersistentState> = readWorkspacePersistentState,
): Promise<WorkspacePersistentState> {
	const rootStates = await Promise.all(rootUris.map(async (rootUri) => ({
		rootUri,
		state: await readState(rootUri),
	})));

	return mergeWorkspacePersistentStates(rootStates);
}

/**
 * 새 Extension 세션은 disk metadata를 사용하고, 같은 Extension 세션의 Panel
 * 재생성은 아직 write 중일 수 있는 Host 메모리 snapshot을 우선한다.
 */
export function createInitialWebviewState(
	previousState: PersistedWebviewState | undefined,
	loadedWorkspaceState: WorkspacePersistentState,
): PersistedWebviewState {
	const sessionState = previousState
		? parseWebviewSessionState({
			panel: previousState.panel,
			camera: previousState.graph.camera,
		}) ?? createDefaultWebviewSessionState()
		: createDefaultWebviewSessionState();
	// Workspace 상태의 Host 메모리 우선 여부는 호출자가 Root-set context와 함께
	// 결정한다. 이 함수는 이전 Panel에서 UI Session만 복원하고, Workspace 필드는
	// 항상 전달받은 canonical snapshot을 사용한다.
	const workspaceState = parseWorkspacePersistentState(loadedWorkspaceState)
		?? createDefaultWorkspacePersistentState();

	return {
		panel: sessionState.panel,
		graph: {
			camera: sessionState.camera,
			nodePositions: workspaceState.nodePositions,
			fileGroupPages: workspaceState.fileGroupPages,
			openedFolders: workspaceState.openedFolders,
			detachedRootNodeIds: workspaceState.detachedRootNodeIds,
			hiddenNodeIds: workspaceState.hiddenNodeIds,
		},
	};
}

/** 기존 partition/write 함수로 모든 Root write를 시작하고 실패를 Root별로 격리한다. */
export async function persistWorkspacePersistentStateForRoots(
	state: WorkspacePersistentState,
	rootUris: readonly vscode.Uri[],
	writeState: WorkspaceRootStateWriter = writeWorkspacePersistentState,
	logger: Pick<Console, 'warn'> = console,
): Promise<void> {
	const rootStates = partitionWorkspacePersistentStateByRoot(state, rootUris);

	await Promise.all(rootStates.map(async ({ rootUri, state: rootState }) => {
		try {
			await writeState(rootUri, rootState);
		} catch (error) {
			logger.warn(
				`[Crispy] Failed to write Workspace State: ${rootUri.toString()}`,
				error,
			);
		}
	}));
}

/**
 * 구조 검증을 통과한 terminal 및 tab 메시지를 현재 구현된 Host 경계로 전달한다.
 * ready는 탭 표면 준비로, `agent.switch`는 provider 지정 시작·재시작으로,
 * `agent.reset`은 현재 CLI 종료와 provider 미선택 상태 복귀로,
 * restart는 같은 provider 재시작으로, input과 resize는 실행 중 PTY routing으로
 * 연결하며 아직 구현하지 않은 lifecycle 메시지는 실행하지 않는다.
 *
 * @param message 허용된 type과 필드만 포함하는 terminal protocol 메시지
 * @param terminalHost 검증된 tab/agent/terminal 메시지를 처리할 Host 경계
 * @returns 메시지 전송은 TerminalHost emitter가 담당하므로 직접 응답하지 않음
 */
function handleTerminalMessage(
	message: WebviewToHostMessage,
	terminalHost: TerminalMessageHost | undefined,
): undefined {
	if (terminalHost === undefined) {
		return undefined;
	}

	switch (message.type) {
		case 'tab.create':
			terminalHost.createTab(message.tabId);
			break;
		case 'tab.switch':
			terminalHost.switchTab(message.tabId);
			break;
		case 'tab.close':
			terminalHost.closeTab(message.tabId);
			break;
		case 'agent.switch':
			void terminalHost.switchAgent(
					message.tabId,
					message.providerId,
					message.workspaceRootId,
					message.switchAttemptId,
				).catch(() => undefined);
			break;
		case 'agent.reset':
			terminalHost.resetAgent(message.tabId);
			break;
		case 'terminal.ready':
			void terminalHost.handleTerminalReady(
				message.tabId,
				message.cols,
				message.rows,
			).catch(() => undefined);
			break;
		case 'terminal.restart':
			void terminalHost.restartSession(
				message.tabId,
				message.sessionId,
			).catch(() => undefined);
			break;
		case 'mcp.restart':
			void terminalHost.restartMcpSession(
				message.tabId,
				message.sessionId,
			).catch(() => undefined);
			break;
		case 'terminal.input':
			terminalHost.routeInput(message);
			break;
		case 'terminal.resize':
			terminalHost.routeResize(message);
			break;
	}

	return undefined;
}

/**
 * 확장이 비활성화될 때 열린 Terminal runtime과 WebviewPanel 참조를 정리한다.
 * Terminal session, PTY, PTY listener와 Webview message listener만 정리 대상이며
 * PTY 종료가 지연되어도 VS Code 종료를 막지 않도록 상한 시간을 적용한 뒤
 * 남은 정리는 best-effort로 진행한다.
 *
 * @returns Terminal runtime 정리가 끝나거나 상한 시간에 도달하면 이행되는 Promise
 */
export async function deactivate(): Promise<void> {
	const runtime = currentRuntime;
	const workspacePersistence = activeWorkspacePersistence;
	currentRuntime = undefined;
	activeWorkspacePersistence = undefined;
	lastWebviewState = undefined;
	lastWorkspaceState = undefined;
	workspacePersistenceContextKey = undefined;
	pendingWorkspaceMaterializationGeneration = undefined;
	workspacePersistenceRootUris = [];
	workspaceContextGeneration = 0;
	workspaceRevision = 0;
	latestAcknowledgedWorkspaceRevision = -1;
	nextWorkspaceContextGeneration = 0;
	latestAcknowledgedWorkspaceContextGeneration = -1;
	workspaceContextByGeneration.clear();
	if (runtime === undefined) {
		await Promise.all([
			...pendingWorkspaceWrites,
			workspacePersistence?.flush().catch(() => undefined) ?? Promise.resolve(),
		]);
		workspacePersistence?.dispose();
		return;
	}

	runtime.detach();

	try {
		runtime.panel.dispose();
	} catch {
		/** Panel 정리 실패가 확장 비활성화를 막지 않게 한다. */
	}

	await Promise.all([
		runCleanupWithTimeout(() => runtime.terminate()),
		...pendingWorkspaceWrites,
		workspacePersistence?.flush().catch(() => undefined) ?? Promise.resolve(),
	]);
	workspacePersistence?.dispose();
}

/**
 * 전체 영역 Graph 위에 Floating Agent Chat을 얹는 구조와 Webview 리소스 참조를 포함하는 HTML 문서를 생성한다.
 *
 * @param webview Content Security Policy에 사용할 Webview 인스턴스
 * @param stylesUri Webview 전용 CSS 리소스 URI
 * @param scriptUri Dock, Resize 및 Collapse 동작을 실행하는 Webview 스크립트 URI
 * @param initialWebviewState 새 Panel에 전달할 마지막 Webview 상태
 * @param workspacePresentation 같은 Workspace Snapshot에서 생성한 초기 Graph와 Catalog
 * @param workspaceState 초기 Task record를 포함하는 Workspace canonical 상태
 * @param contextGeneration 초기 Graph/상태 Root context의 Host epoch
 * @returns WebviewPanel에 설정할 완성된 HTML 문자열
 */
function getWebviewHtml(
	webview: vscode.Webview,
	stylesUri: vscode.Uri,
	monacoStylesUri: vscode.Uri,
	scriptUri: vscode.Uri,
	monacoWorkerUri: vscode.Uri,
	initialWebviewState: PersistedWebviewState | undefined,
	workspacePresentation: WorkspacePresentation,
	workspaceState: WorkspacePersistentState,
	contextGeneration: number,
	workspaceMutationRevision: number,
): string {
	const serializedWebviewState = serializeWebviewState(initialWebviewState);
	const serializedWorkspaceState = encodeURIComponent(JSON.stringify(
		parseWorkspacePersistentState(workspaceState)
			?? createDefaultWorkspacePersistentState(),
	));
	const serializedWorkspacePresentation =
		serializeWorkspacePresentationForWebview(workspacePresentation);

	/** xterm DOM renderer가 팔레트용 <style>과 truecolor용 style attribute를 생성한다. */
	/** 두 style 경계만 inline을 허용하고 script와 외부 stylesheet는 Webview source로 제한한다. */
	return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; style-src-elem ${webview.cspSource} 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src ${webview.cspSource}; worker-src ${webview.cspSource} blob:; font-src ${webview.cspSource};">
				<link rel="stylesheet" href="${stylesUri}">
				<link rel="stylesheet" href="${monacoStylesUri}">
				<title>Crispy</title>
			</head>
			<body>
				<main id="app" class="crispy-layout" data-dock="right" data-workspace-presentation="${serializedWorkspacePresentation}">
					<section id="graph-area"></section>
					<div id="panel-resize-handle"></div>
					<section id="agent-chat-area">
						<div id="agent-panel-header">
							<div id="agent-tab-strip"></div>
							<div id="agent-top-bar"></div>
							<button id="chat-drag-handle" type="button" aria-label="Move Agent Chat" title="Move Agent Chat"></button>
							<button id="chat-collapse-toggle" type="button" aria-label="Hide Agent Chat" title="Hide Agent Chat" data-panel-icon="panel-right.svg"></button>
						</div>
						<div id="agent-terminal-area">
							<div id="agent-provider-picker-host" hidden></div>
						</div>
						<div id="agent-workspace-status-bar" hidden></div>
						<div id="agent-tab-menu-host" hidden></div>
						<div id="agent-dialog-host" hidden></div>
						<div id="agent-rename-dialog-host" hidden></div>
					</section>
					<button id="chat-sticker-opener" type="button" aria-label="Show Agent Chat" title="Show Agent Chat" data-panel-icon="panel-left.svg" hidden></button>
					<div id="dock-preview" aria-hidden="true" hidden></div>
				</main>
				<script src="${scriptUri}" data-webview-state="${serializedWebviewState}" data-workspace-state="${serializedWorkspaceState}" data-workspace-context-generation="${contextGeneration}" data-workspace-revision="${workspaceMutationRevision}" data-monaco-worker-uri="${monacoWorkerUri}"></script>
			</body>
			</html>`;
}
