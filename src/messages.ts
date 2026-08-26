import type {
	HostToWebviewWireMessage,
	SessionId,
	WebviewToHostWireMessage,
} from './agent/protocol';
import { ID_MAX_LENGTH, ID_PATTERN } from './agent/protocol/limits';
import type { WebviewSessionState } from './webview/webviewState';
import type { TaskTransferSerializeFailureReason } from './task/taskTransfer';
import type { Graph } from './webview/graph/graphModel';
import {
	parseWorkspacePersistentState,
	type WorkspacePersistentState,
} from './workspace/workspaceMetadata';
import {
	parseWorkspacePresentation,
	type WorkspacePresentation,
} from './workspace/workspacePresentation';
import {
	validateWorkspaceRootId,
	type WorkspaceRootId,
} from './workspace/workspaceRootId';

/** Webview Session snapshot 변경을 Extension Host에 전달하는 상태 경계 메시지다. */
export interface WebviewStateChangedMessage {
	type: 'webview.stateChanged';
	state: WebviewSessionState;
}

/** Workspace Persistent State 전체 snapshot 변경을 Extension Host에 전달한다. */
export interface WorkspaceStateChangedMessage {
	type: 'workspace.stateChanged';
	/** Host가 발급하고 Webview가 그대로 반사하는 Root context epoch다. */
	contextGeneration: number;
	/** 이 snapshot을 만든 Webview Graph의 Project Root node IDs다. */
	rootIds: readonly WorkspaceRootId[];
	/** 같은 Root context 안의 Host 파일 mutation revision이다. */
	workspaceRevision?: number;
	state: WorkspacePersistentState;
}

/** Graph File ID로 Workspace 파일 열기를 Extension Host에 요청한다. */
export interface WorkspaceOpenFileMessage {
	type: 'workspace.openFile';
	fileId: string;
}

export type WorkspaceMutableNodeKind = 'file' | 'folder';

export interface WorkspaceNodeDetailsRequestMessage {
	type: 'workspace.nodeDetails.request';
	requestId: number;
	nodeId: string;
	kind: WorkspaceMutableNodeKind;
	workspaceRevision: number;
}

export interface WorkspaceNodeRenameRequestMessage {
	type: 'workspace.nodeRename.request';
	requestId: number;
	nodeId: string;
	kind: WorkspaceMutableNodeKind;
	newName: string;
	workspaceRevision: number;
	/** rename과 ID 이전이 공유하는 Webview의 최신 Workspace snapshot이다. */
	state: WorkspacePersistentState;
}

export interface WorkspaceNodeDeleteRequestMessage {
	type: 'workspace.nodeDelete.request';
	requestId: number;
	nodeId: string;
	kind: WorkspaceMutableNodeKind;
	workspaceRevision: number;
}

export type WorkspaceNodeRequestMessage =
	| WorkspaceNodeDetailsRequestMessage
	| WorkspaceNodeRenameRequestMessage
	| WorkspaceNodeDeleteRequestMessage;

export type WorkspaceFilePreview =
	| {
		readonly status: 'ready';
		readonly text: string;
		readonly languageId: string;
		/** Git HEAD 내용이다. 존재할 때 Webview는 inline diff로 표시한다. */
		readonly originalText?: string;
	}
	| { readonly status: 'too-large' | 'binary' | 'unavailable' };

export interface WorkspaceNodeDetails {
	readonly nodeId: string;
	readonly kind: WorkspaceMutableNodeKind;
	readonly name: string;
	readonly relativePath: string;
	readonly size?: number;
	readonly createdAt?: number;
	readonly modifiedAt?: number;
	readonly readonly: boolean;
	readonly canMutate: boolean;
	readonly childFileCount?: number;
	readonly childFolderCount?: number;
	readonly preview?: WorkspaceFilePreview;
}

export type WorkspaceNodeFailureReason =
	| 'stale'
	| 'not-found'
	| 'not-allowed'
	| 'read-only'
	| 'conflict'
	| 'invalid-name'
	| 'unsupported'
	| 'failed';

/** rename 전 Graph state ID를 rename 후 ID로 연결하는 Host 계산 변경표다. */
export type WorkspaceNodeStateIdChanges = Readonly<Record<string, string>>;

export type WorkspaceNodeDetailsResultMessage = {
	readonly type: 'workspace.nodeDetails.result';
	readonly requestId: number;
	readonly workspaceRevision: number;
} & (
	| { readonly status: 'success'; readonly details: WorkspaceNodeDetails }
	| { readonly status: 'error'; readonly reason: WorkspaceNodeFailureReason }
);

export type WorkspaceNodeMutationResultMessage = {
	readonly type: 'workspace.nodeMutation.result';
	readonly requestId: number;
	readonly operation: 'rename' | 'delete';
	readonly workspaceRevision: number;
} & (
	| {
		readonly status: 'success';
		readonly contextGeneration: number;
		readonly rootIds: readonly WorkspaceRootId[];
		readonly presentation: WorkspacePresentation;
		readonly state: WorkspacePersistentState;
		readonly nodeId?: string;
		readonly stateIdChanges?: WorkspaceNodeStateIdChanges;
	}
	| { readonly status: 'error'; readonly reason: WorkspaceNodeFailureReason }
);

/** Webview가 tracked clear 적용 직후 Host에 돌려주는 quota 정산 receipt다. */
export interface AgentActivityClearAppliedReceipt {
	readonly type: 'agent.activity.clearApplied';
	readonly receiptId: number;
}
  
/** 생성한 Task 전송 JSON을 Extension Host clipboard에 기록하도록 요청한다. */
export interface TaskJsonCopyMessage {
	type: 'task.copyJson';
	json: string;
}

/** Webview에서 Task 전송 JSON 생성 실패를 안전한 reason으로 알린다. */
export interface TaskJsonCopyFailedMessage {
	type: 'task.copyJsonFailed';
	reason: TaskTransferSerializeFailureReason;
}

/** Webview에서 Extension Host로 전송하는 Agent wire 및 상태 경계 메시지다. */
export type WebviewToExtensionMessage =
	| WebviewToHostWireMessage
	| WebviewStateChangedMessage
	| WorkspaceStateChangedMessage
	| WorkspaceOpenFileMessage
	| WorkspaceNodeRequestMessage
	| AgentActivityClearAppliedReceipt
	| TaskJsonCopyMessage
	| TaskJsonCopyFailedMessage;

/** Extension Host에서 Webview로 전송하는 Workspace 도메인 메시지다. */
export type WorkspaceToWebviewMessage = {
	type: 'workspace.snapshotUpdated';
	presentation: WorkspacePresentation;
	/** 같은 Root 집합의 ABA 전환까지 구분하는 Host 발급 epoch다. */
	contextGeneration: number;
	/** Graph와 state가 함께 채취된 Project Root context다. */
	rootIds: readonly WorkspaceRootId[];
	/** 같은 Root context 안의 Host 파일 mutation revision이다. */
	workspaceRevision?: number;
	/** Root 구성이 바뀔 때 Graph와 원자적으로 교체할 Workspace 상태다. */
	state?: WorkspacePersistentState;
};

/** Graph에서 표현할 수 있는 정규화된 Git file 상태다. */
export type WorkspaceGitFileStatus =
	| 'untracked'
	| 'added'
	| 'modified'
	| 'renamed'
	| 'deleted'
	| 'conflict';

/** 한 변경 파일과 그 변경을 집계할 현재 Workspace ancestor node IDs다. */
export interface WorkspaceGitStatusEntry {
	readonly status: WorkspaceGitFileStatus;
	/** 삭제 파일은 Graph node를 만들지 않으므로 direct node ID가 없다. */
	readonly nodeId?: string;
	readonly ancestorNodeIds: readonly string[];
}

/** 현재 Root context의 Git 변경 전체를 교체하는 runtime-only snapshot이다. */
export interface WorkspaceGitStatusUpdatedMessage {
	readonly type: 'workspace.gitStatusUpdated';
	readonly contextGeneration: number;
	readonly rootIds: readonly WorkspaceRootId[];
	readonly gitRevision: number;
	readonly entries: readonly WorkspaceGitStatusEntry[];
}

/** Host가 지정할 수 있는 Graph Node 시각 효과 종류다. */
export type GraphNodeEffectKind =
	| 'marching-dash'
	| 'pulse'
	| 'shimmer'
	| 'outline'
	| 'outline-strong'
	| 'icon';

/** Source Node 전체 또는 특정 Detached Root occurrence를 지정한다. */
export interface GraphNodeEffectTarget {
	readonly nodeId: string;
	readonly rootId?: string;
}

/** Agent가 Graph Target에 전달할 수 있는 의미 기반 Activity allowlist다. */
const AGENT_ACTIVITY_KINDS = [
	'planned',
	'active',
	'editing',
	'completed',
	'mentioned',
	'rejected',
] as const;

/** Agent가 Graph Target에 대해 발생시킨 의미 기반 Activity다. */
export type AgentActivityKind = typeof AGENT_ACTIVITY_KINDS[number];

/** 어떤 Session이 어떤 Graph Target에 Activity를 발생시켰는지 표현한다. */
export interface AgentActivityEvent {
	readonly sessionId: SessionId;
	readonly target: GraphNodeEffectTarget;
	readonly activity: AgentActivityKind;
}

/** Session과 Target 쌍의 현재 Activity를 설정한다. */
export interface AgentActivitySetMessage extends AgentActivityEvent {
	readonly type: 'agent.activity.set';
}

/** Session과 Target 쌍의 Activity를 제거한다. */
export interface AgentActivityClearMessage {
	readonly type: 'agent.activity.clear';
	readonly sessionId: SessionId;
	readonly target: GraphNodeEffectTarget;
}

/** 한 Session이 발생시킨 모든 Target Activity를 제거한다. */
export interface AgentActivityClearSessionMessage {
	readonly type: 'agent.activity.clearSession';
	readonly sessionId: SessionId;
}

/** Host가 clear 적용과 quota 정산을 연결할 때만 사용하는 tracked wrapper다. */
export interface AgentActivityTrackedClearMessage {
	readonly type: 'agent.activity.clearTracked';
	readonly receiptId: number;
	readonly publicMessage:
		| AgentActivityClearMessage
		| AgentActivityClearSessionMessage;
}

/** Extension Host에서 Webview로 전달하는 Agent Activity 변경 계약이다. */
export type AgentActivityToWebviewMessage =
	| AgentActivitySetMessage
	| AgentActivityClearMessage
	| AgentActivityClearSessionMessage;

/** Session과 Target 쌍의 Activity set 메시지를 만드는 공통 진입점이다. */
export function setAgentActivity(
	sessionId: SessionId,
	target: GraphNodeEffectTarget,
	activity: AgentActivityKind,
): AgentActivitySetMessage {
	return { type: 'agent.activity.set', sessionId, target, activity };
}

/** Session과 Target 쌍의 Activity clear 메시지를 만든다. */
export function clearAgentActivity(
	sessionId: SessionId,
	target: GraphNodeEffectTarget,
): AgentActivityClearMessage {
	return { type: 'agent.activity.clear', sessionId, target };
}

/** 한 Session의 전체 Activity clear 메시지를 만든다. */
export function clearAgentActivitiesBySession(
	sessionId: SessionId,
): AgentActivityClearSessionMessage {
	return { type: 'agent.activity.clearSession', sessionId };
}

/** Webview가 의미 상태를 해석하지 않고 그대로 표현하는 시각 효과 계약이다. */
export type GraphNodeEffect =
	| {
		readonly kind: 'marching-dash' | 'pulse' | 'shimmer' | 'outline'
			| 'outline-strong';
		readonly color: string;
	}
	| {
		readonly kind: 'icon';
		readonly color: string;
		readonly icon: 'check' | 'cancel' | 'alert';
	};

/** Graph Node에 같은 kind의 기존 효과를 교체하며 적용한다. */
export interface GraphNodeEffectSetMessage {
	type: 'graph.nodeEffect.set';
	target: GraphNodeEffectTarget;
	effect: GraphNodeEffect;
}

/** Graph Node의 특정 kind 또는 모든 효과를 제거한다. */
export interface GraphNodeEffectClearMessage {
	type: 'graph.nodeEffect.clear';
	target: GraphNodeEffectTarget;
	kind?: GraphNodeEffectKind;
}

/** Extension Host에서 Webview로 전송하는 transient Graph 효과 메시지다. */
export type GraphNodeEffectToWebviewMessage =
	| GraphNodeEffectSetMessage
	| GraphNodeEffectClearMessage;

/** Extension Host에서 Webview로 전송하는 Agent wire 및 Workspace 메시지다. */
export type ExtensionToWebviewMessage =
	| HostToWebviewWireMessage
	| WorkspaceToWebviewMessage
	| WorkspaceGitStatusUpdatedMessage
	| WorkspaceNodeDetailsResultMessage
	| WorkspaceNodeMutationResultMessage
	| AgentActivityToWebviewMessage
	| AgentActivityTrackedClearMessage
	| GraphNodeEffectToWebviewMessage;

/** unknown 값에서 순수 Agent Activity Event 계약을 strict하게 검증한다. */
export function parseAgentActivityEvent(
	value: unknown,
): AgentActivityEvent | undefined {
	return isRecord(value)
		? parseAgentActivityEventRecord(
			value,
			['sessionId', 'target', 'activity'],
		)
		: undefined;
}

/** unknown Host 메시지에서 Agent Activity 변경 계약을 strict하게 검증한다. */
export function parseAgentActivityToWebviewMessage(
	value: unknown,
): AgentActivityToWebviewMessage | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (value.type === 'agent.activity.set') {
		const event = parseAgentActivityEventRecord(
			value,
			['type', 'sessionId', 'target', 'activity'],
		);

		return event ? { type: 'agent.activity.set', ...event } : undefined;
	}

	if (value.type === 'agent.activity.clear') {
		if (
			!hasExactKeys(value, ['type', 'sessionId', 'target'])
			|| !isSessionId(value.sessionId)
		) {
			return undefined;
		}
		const target = parseGraphNodeEffectTarget(value.target);

		return target
			? { type: 'agent.activity.clear', sessionId: value.sessionId, target }
			: undefined;
	}

	if (
		value.type === 'agent.activity.clearSession'
		&& hasExactKeys(value, ['type', 'sessionId'])
		&& isSessionId(value.sessionId)
	) {
		return { type: 'agent.activity.clearSession', sessionId: value.sessionId };
	}

	return undefined;
}

/** tracked wrapper를 exact own-key로 검증하고 nested public clear parser를 재사용한다. */
export function parseAgentActivityTrackedClearMessage(
	value: unknown,
): AgentActivityTrackedClearMessage | undefined {
	if (
		!isRecord(value)
		|| value.type !== 'agent.activity.clearTracked'
		|| !hasExactOwnKeys(value, ['type', 'receiptId', 'publicMessage'])
		|| !isReceiptId(value.receiptId)
		|| !hasExactTrackedPublicClearKeys(value.publicMessage)
	) {
		return undefined;
	}

	const publicMessage = parseAgentActivityToWebviewMessage(value.publicMessage);
	if (
		publicMessage === undefined
		|| publicMessage.type === 'agent.activity.set'
	) {
		return undefined;
	}

	return {
		type: 'agent.activity.clearTracked',
		receiptId: value.receiptId,
		publicMessage,
	};
}

/** Webview clear receipt를 payload 반사 없이 exact own-key로 검증한다. */
export function parseAgentActivityClearAppliedReceipt(
	value: unknown,
): AgentActivityClearAppliedReceipt | undefined {
	if (
		!isRecord(value)
		|| value.type !== 'agent.activity.clearApplied'
		|| !hasExactOwnKeys(value, ['type', 'receiptId'])
		|| !isReceiptId(value.receiptId)
	) {
		return undefined;
	}

	return {
		type: 'agent.activity.clearApplied',
		receiptId: value.receiptId,
	};
}

/** unknown Host 메시지에서 transient Graph 효과 계약을 구조적으로 검증한다. */
export function parseGraphNodeEffectToWebviewMessage(
	value: unknown,
): GraphNodeEffectToWebviewMessage | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	if (value.type === 'graph.nodeEffect.set') {
		if (!hasExactKeys(value, ['type', 'target', 'effect'])) {
			return undefined;
		}
		const target = parseGraphNodeEffectTarget(value.target);
		const effect = parseGraphNodeEffect(value.effect);

		return target && effect
			? { type: 'graph.nodeEffect.set', target, effect }
			: undefined;
	}

	if (value.type === 'graph.nodeEffect.clear') {
		if (!hasOnlyKeys(value, ['type', 'target', 'kind'])) {
			return undefined;
		}
		const target = parseGraphNodeEffectTarget(value.target);
		const kind = value.kind;

		if (
			!target
			|| (kind !== undefined && !isGraphNodeEffectKind(kind))
		) {
			return undefined;
		}

		return {
			type: 'graph.nodeEffect.clear',
			target,
			...(kind ? { kind } : {}),
		};
	}

	return undefined;
}

function parseGraphNodeEffectTarget(
	value: unknown,
): GraphNodeEffectTarget | undefined {
	if (
		!isRecord(value)
		|| !hasOnlyKeys(value, ['nodeId', 'rootId'])
		|| typeof value.nodeId !== 'string'
		|| value.nodeId.length === 0
		|| (
			value.rootId !== undefined
			&& (typeof value.rootId !== 'string' || value.rootId.length === 0)
		)
	) {
		return undefined;
	}

	return {
		nodeId: value.nodeId,
		...(typeof value.rootId === 'string' ? { rootId: value.rootId } : {}),
	};
}

function parseAgentActivityEventRecord(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): AgentActivityEvent | undefined {
	if (
		!hasExactKeys(value, keys)
		|| !isSessionId(value.sessionId)
		|| !isAgentActivityKind(value.activity)
	) {
		return undefined;
	}
	const target = parseGraphNodeEffectTarget(value.target);

	return target
		? { sessionId: value.sessionId, target, activity: value.activity }
		: undefined;
}

function isSessionId(value: unknown): value is SessionId {
	return typeof value === 'string'
		&& value.length <= ID_MAX_LENGTH
		&& ID_PATTERN.test(value);
}

function isAgentActivityKind(value: unknown): value is AgentActivityKind {
	return typeof value === 'string'
		&& (AGENT_ACTIVITY_KINDS as readonly string[]).includes(value);
}

function isReceiptId(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseGraphNodeEffect(value: unknown): GraphNodeEffect | undefined {
	if (
		!isRecord(value)
		|| typeof value.color !== 'string'
		|| value.color.length === 0
		|| !isGraphNodeEffectKind(value.kind)
	) {
		return undefined;
	}

	if (value.kind === 'icon') {
		if (
			!hasExactKeys(value, ['kind', 'color', 'icon'])
			|| (
				value.icon !== 'check'
				&& value.icon !== 'cancel'
				&& value.icon !== 'alert'
			)
		) {
			return undefined;
		}

		return { kind: value.kind, color: value.color, icon: value.icon };
	}

	return hasExactKeys(value, ['kind', 'color'])
		? { kind: value.kind, color: value.color }
		: undefined;
}

function isGraphNodeEffectKind(value: unknown): value is GraphNodeEffectKind {
	return value === 'marching-dash'
		|| value === 'pulse'
		|| value === 'shimmer'
		|| value === 'outline'
		|| value === 'outline-strong'
		|| value === 'icon';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	return Object.keys(value).length === keys.length && hasOnlyKeys(value, keys);
}

function hasOnlyKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	const allowed = new Set(keys);

	return Object.keys(value).every((key) => allowed.has(key));
}

/** 새 tracked wire만 enumerable 여부와 symbol을 포함한 exact own-key로 제한한다. */
function hasExactOwnKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	const allowed = new Set(keys);
	const ownKeys = Reflect.ownKeys(value);
	return ownKeys.length === keys.length
		&& ownKeys.every((key) => typeof key === 'string' && allowed.has(key));
}

/** Nested public parser 동작은 유지하면서 tracked wrapper 안의 wire만 exact하게 고정한다. */
function hasExactTrackedPublicClearKeys(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}
	if (value.type === 'agent.activity.clear') {
		return hasExactOwnKeys(value, ['type', 'sessionId', 'target']);
	}
	return value.type === 'agent.activity.clearSession'
		&& hasExactOwnKeys(value, ['type', 'sessionId']);
}

/** Graph의 실제 Project Root node IDs를 표시 순서대로 반환한다. */
export function getWorkspaceGraphRootIds(graph: Graph): string[] {
	return graph.roots.flatMap((root) => (
		graph.rootNodes[root.nodeId]?.kind === 'project' ? [root.nodeId] : []
	));
}

/** Workspace context Root ID 배열의 문법·중복 불변 조건을 검증한다. */
export function parseWorkspaceRootIds(
	value: unknown,
): WorkspaceRootId[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const rootIds: WorkspaceRootId[] = [];
	const seen = new Set<string>();

	for (const entry of value) {
		const validation = validateWorkspaceRootId(entry);

		if (!validation.ok || seen.has(validation.value)) {
			return undefined;
		}
		seen.add(validation.value);
		rootIds.push(validation.value);
	}
	return rootIds;
}

/** Webview의 Workspace node 조회/mutation 요청을 exact-key로 검증한다. */
export function parseWorkspaceNodeRequestMessage(
	value: unknown,
): WorkspaceNodeRequestMessage | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const baseKeys = ['type', 'requestId', 'nodeId', 'kind', 'workspaceRevision'];
	const keys = value.type === 'workspace.nodeRename.request'
		? [...baseKeys, 'newName', 'state']
		: baseKeys;

	if (
		!hasExactKeys(value, keys)
		|| !isWorkspaceNodeRequestBase(value)
	) {
		return undefined;
	}
	if (value.type === 'workspace.nodeDetails.request') {
		return {
			type: value.type,
			requestId: value.requestId as number,
			nodeId: value.nodeId as string,
			kind: value.kind as WorkspaceMutableNodeKind,
			workspaceRevision: value.workspaceRevision as number,
		};
	}
	if (value.type === 'workspace.nodeDelete.request') {
		return {
			type: value.type,
			requestId: value.requestId as number,
			nodeId: value.nodeId as string,
			kind: value.kind as WorkspaceMutableNodeKind,
			workspaceRevision: value.workspaceRevision as number,
		};
	}
	if (
		value.type !== 'workspace.nodeRename.request'
		|| typeof value.newName !== 'string'
		|| value.newName.length > 4_096
	) {
		return undefined;
	}
	const state = parseWorkspacePersistentState(value.state);

	if (!state) {
		return undefined;
	}
	return {
		type: value.type,
		requestId: value.requestId as number,
		nodeId: value.nodeId as string,
		kind: value.kind as WorkspaceMutableNodeKind,
		newName: value.newName,
		workspaceRevision: value.workspaceRevision as number,
		state,
	};
}

/** Host의 Workspace node 상세 응답을 민감 정보가 새지 않도록 strict하게 검증한다. */
export function parseWorkspaceNodeDetailsResultMessage(
	value: unknown,
): WorkspaceNodeDetailsResultMessage | undefined {
	if (
		!isRecord(value)
		|| value.type !== 'workspace.nodeDetails.result'
		|| !isSafeRevision(value.requestId)
		|| !isSafeRevision(value.workspaceRevision)
		|| (value.status !== 'success' && value.status !== 'error')
	) {
		return undefined;
	}
	if (value.status === 'error') {
		return hasExactKeys(value, [
			'type', 'requestId', 'workspaceRevision', 'status', 'reason',
		]) && isWorkspaceNodeFailureReason(value.reason)
			? value as WorkspaceNodeDetailsResultMessage
			: undefined;
	}
	return hasExactKeys(value, [
		'type', 'requestId', 'workspaceRevision', 'status', 'details',
	]) && isWorkspaceNodeDetails(value.details)
		? value as WorkspaceNodeDetailsResultMessage
		: undefined;
}

/** mutation 성공 payload의 Presentation/State/Root context를 함께 검증한다. */
export function parseWorkspaceNodeMutationResultMessage(
	value: unknown,
): WorkspaceNodeMutationResultMessage | undefined {
	if (
		!isRecord(value)
		|| value.type !== 'workspace.nodeMutation.result'
		|| !isSafeRevision(value.requestId)
		|| !isSafeRevision(value.workspaceRevision)
		|| (value.operation !== 'rename' && value.operation !== 'delete')
		|| (value.status !== 'success' && value.status !== 'error')
	) {
		return undefined;
	}
	if (value.status === 'error') {
		return hasExactKeys(value, [
			'type', 'requestId', 'operation', 'workspaceRevision', 'status', 'reason',
		]) && isWorkspaceNodeFailureReason(value.reason)
			? value as WorkspaceNodeMutationResultMessage
			: undefined;
	}
	if (!hasOnlyKeys(value, [
		'type', 'requestId', 'operation', 'workspaceRevision', 'status',
		'contextGeneration', 'rootIds', 'presentation', 'state', 'nodeId',
		'stateIdChanges',
	]) || !Object.hasOwn(value, 'contextGeneration')
		|| !Object.hasOwn(value, 'rootIds')
		|| !Object.hasOwn(value, 'presentation')
		|| !Object.hasOwn(value, 'state')
		|| !isSafeRevision(value.contextGeneration)
		|| (value.nodeId !== undefined && typeof value.nodeId !== 'string')
		|| !isWorkspaceNodeMutationStateIdChanges(
			value.operation,
			value.stateIdChanges,
		)) {
		return undefined;
	}
	const presentation = parseWorkspacePresentation(value.presentation);
	const state = parseWorkspacePersistentState(value.state);
	const rootIds = parseWorkspaceRootIds(value.rootIds);
	const graphRootIds = presentation
		? getWorkspaceGraphRootIds(presentation.graph)
		: undefined;

	return presentation && state && rootIds && graphRootIds
		&& haveSameOrderedStrings(rootIds, graphRootIds)
		&& haveSameOrderedStrings(rootIds, presentation.rootCatalog.map(({ id }) => id))
		? {
			type: value.type,
			requestId: value.requestId as number,
			operation: value.operation,
			workspaceRevision: value.workspaceRevision as number,
			status: 'success',
			contextGeneration: value.contextGeneration as number,
			rootIds,
			presentation,
			state,
			...(typeof value.nodeId === 'string' ? { nodeId: value.nodeId } : {}),
			...(isRecord(value.stateIdChanges)
				? { stateIdChanges: { ...value.stateIdChanges } as Record<string, string> }
				: {}),
		}
		: undefined;
}

function isWorkspaceNodeMutationStateIdChanges(
	operation: 'rename' | 'delete',
	value: unknown,
): boolean {
	if (operation === 'delete') {
		return value === undefined;
	}
	return isRecord(value) && Object.entries(value).every(([previousId, nextId]) => (
		previousId.length > 0
		&& typeof nextId === 'string'
		&& nextId.length > 0
		&& previousId !== nextId
	));
}

function isWorkspaceNodeRequestBase(value: Record<string, unknown>): boolean {
	if (
		value.type !== 'workspace.nodeDetails.request'
		&& value.type !== 'workspace.nodeRename.request'
		&& value.type !== 'workspace.nodeDelete.request'
	) {
		return false;
	}
	if (
		!isSafeRevision(value.requestId)
		|| !isSafeRevision(value.workspaceRevision)
		|| (value.kind !== 'file' && value.kind !== 'folder')
		|| typeof value.nodeId !== 'string'
	) {
		return false;
	}
	return value.nodeId.startsWith(`${value.kind}:`)
		&& value.nodeId.length > `${value.kind}:`.length
		&& value.nodeId.length <= 8_192;
}

function isWorkspaceNodeDetails(value: unknown): value is WorkspaceNodeDetails {
	if (!isRecord(value) || !hasOnlyKeys(value, [
		'nodeId', 'kind', 'name', 'relativePath', 'size', 'createdAt', 'modifiedAt',
		'readonly', 'canMutate', 'childFileCount', 'childFolderCount', 'preview',
	])) {
		return false;
	}
	return typeof value.nodeId === 'string'
		&& (value.kind === 'file' || value.kind === 'folder')
		&& value.nodeId.startsWith(`${value.kind}:`)
		&& typeof value.name === 'string'
		&& typeof value.relativePath === 'string'
		&& typeof value.readonly === 'boolean'
		&& typeof value.canMutate === 'boolean'
		&& isOptionalSafeNonNegative(value.size)
		&& isOptionalSafeNonNegative(value.createdAt)
		&& isOptionalSafeNonNegative(value.modifiedAt)
		&& isOptionalSafeNonNegative(value.childFileCount)
		&& isOptionalSafeNonNegative(value.childFolderCount)
		&& (value.preview === undefined || isWorkspaceFilePreview(value.preview));
}

function isWorkspaceFilePreview(value: unknown): value is WorkspaceFilePreview {
	if (!isRecord(value)) {
		return false;
	}
	if (value.status === 'ready') {
		return hasOnlyKeys(value, ['status', 'text', 'languageId', 'originalText'])
			&& Object.hasOwn(value, 'text')
			&& Object.hasOwn(value, 'languageId')
			&& typeof value.text === 'string'
			&& value.text.length <= 1_048_576
			&& typeof value.languageId === 'string'
			&& (value.originalText === undefined
				|| typeof value.originalText === 'string'
				&& value.originalText.length <= 1_048_576);
	}
	return (value.status === 'too-large'
		|| value.status === 'binary'
		|| value.status === 'unavailable')
		&& hasExactKeys(value, ['status']);
}

function isWorkspaceNodeFailureReason(value: unknown): value is WorkspaceNodeFailureReason {
	return value === 'stale' || value === 'not-found' || value === 'not-allowed'
		|| value === 'read-only' || value === 'conflict' || value === 'invalid-name'
		|| value === 'unsupported' || value === 'failed';
}

function isSafeRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isOptionalSafeNonNegative(value: unknown): boolean {
	return value === undefined
		|| (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function haveSameOrderedStrings(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return left.length === right.length
		&& left.every((entry, index) => entry === right[index]);
}

/**
 * unknown Host 메시지에서 현재 Workspace 도메인 계약만 구조적으로 검증한다.
 * 다른 도메인 메시지와 잘못된 Graph는 기존 수신 정책과 같이 조용히 무시한다.
 */
export function parseWorkspaceToWebviewMessage(
	value: unknown,
): WorkspaceToWebviewMessage | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;

	if (
		candidate.type !== 'workspace.snapshotUpdated'
		|| !hasOnlyKeys(candidate, [
			'type',
			'presentation',
			'contextGeneration',
			'rootIds',
			'workspaceRevision',
			'state',
		])
		|| !Object.hasOwn(candidate, 'presentation')
		|| !Object.hasOwn(candidate, 'contextGeneration')
		|| !Object.hasOwn(candidate, 'rootIds')
		|| !Number.isSafeInteger(candidate.contextGeneration)
		|| (candidate.contextGeneration as number) < 0
		|| (candidate.workspaceRevision !== undefined
			&& !isSafeRevision(candidate.workspaceRevision))
	) {
		return undefined;
	}

	const presentation = parseWorkspacePresentation(candidate.presentation);
	const rootIds = parseWorkspaceRootIds(candidate.rootIds);
	const state = candidate.state === undefined
		? undefined
		: parseWorkspacePersistentState(candidate.state);
	const graphRootIds = presentation
		? getWorkspaceGraphRootIds(presentation.graph)
		: undefined;
	const catalogRootIds = presentation
		? presentation.rootCatalog.map(({ id }) => id)
		: undefined;
	const hasMatchingRootContext = rootIds && graphRootIds && catalogRootIds
		&& rootIds.length === graphRootIds.length
		&& rootIds.length === catalogRootIds.length
		&& rootIds.every((rootId, index) => (
			rootId === graphRootIds[index]
			&& rootId === catalogRootIds[index]
		));

	return presentation
		&& hasMatchingRootContext
		&& (candidate.state === undefined || state)
		? {
			type: 'workspace.snapshotUpdated',
			presentation,
			contextGeneration: candidate.contextGeneration as number,
			rootIds,
			...(candidate.workspaceRevision !== undefined
				? { workspaceRevision: candidate.workspaceRevision as number }
				: {}),
			...(state ? { state } : {}),
		}
		: undefined;
}

/** unknown Host 메시지에서 Git runtime snapshot 계약만 strict하게 검증한다. */
export function parseWorkspaceGitStatusUpdatedMessage(
	value: unknown,
): WorkspaceGitStatusUpdatedMessage | undefined {
	if (
		!isRecord(value)
		|| value.type !== 'workspace.gitStatusUpdated'
		|| !hasExactOwnKeys(value, [
			'type',
			'contextGeneration',
			'rootIds',
			'gitRevision',
			'entries',
		])
		|| !isSafeRevision(value.contextGeneration)
		|| !isSafeRevision(value.gitRevision)
		|| !Array.isArray(value.entries)
		|| value.entries.length > 100_000
	) {
		return undefined;
	}

	const rootIds = parseWorkspaceRootIds(value.rootIds);
	const entries = value.entries.map(parseWorkspaceGitStatusEntry);

	return rootIds && entries.every(
		(entry): entry is WorkspaceGitStatusEntry => entry !== undefined,
	)
		? {
			type: 'workspace.gitStatusUpdated',
			contextGeneration: value.contextGeneration,
			rootIds,
			gitRevision: value.gitRevision,
			entries,
		}
		: undefined;
}

function parseWorkspaceGitStatusEntry(
	value: unknown,
): WorkspaceGitStatusEntry | undefined {
	if (
		!isRecord(value)
		|| !hasOnlyKeys(value, ['status', 'nodeId', 'ancestorNodeIds'])
		|| !Object.hasOwn(value, 'status')
		|| !Object.hasOwn(value, 'ancestorNodeIds')
		|| !isWorkspaceGitFileStatus(value.status)
		|| (value.nodeId !== undefined && !isWorkspaceGraphNodeId(value.nodeId))
		|| !Array.isArray(value.ancestorNodeIds)
		|| value.ancestorNodeIds.length > 1_024
		|| !value.ancestorNodeIds.every(isWorkspaceGraphNodeId)
	) {
		return undefined;
	}

	return {
		status: value.status,
		...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }),
		ancestorNodeIds: [...value.ancestorNodeIds],
	};
}

function isWorkspaceGitFileStatus(
	value: unknown,
): value is WorkspaceGitFileStatus {
	return value === 'untracked'
		|| value === 'added'
		|| value === 'modified'
		|| value === 'renamed'
		|| value === 'deleted'
		|| value === 'conflict';
}

function isWorkspaceGraphNodeId(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= 8_192
		&& (value.startsWith('file:')
			|| value.startsWith('folder:')
			|| value.startsWith('workspace-root:'));
}

/** `src/agent/protocol`이 공개하는 타입을 기존 import 경로에서도 재노출한다. */
export type * from './agent/protocol';
