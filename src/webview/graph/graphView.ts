import {
	initializeGraphCamera,
	type GraphCamera,
} from './graphCamera';
import {
	createFileGroupId,
	createGraphLayout,
	createGraphLayoutNodeId,
	getGraphLayoutRootId,
	getGraphLayoutSourceId,
	getGraphRootLayoutNodeId,
	resolveGraphLayoutNodePosition,
	type GraphLayout,
	type GraphLayoutNode,
	type GraphLayoutPosition,
} from './graphLayout';
import {
	calculateDetachedRootDuplicatePosition,
	classifyGraphLayoutNodeArrangement,
	collectGraphLayoutSubtreeNodeIds,
	rebaseNodePositions,
	translateDetachedSubtree,
} from './graphLayoutTransition';
import type { Graph, GraphRoot, GraphRootNode } from './graphModel';
import {
	addGraphRoot,
	applyDetachedGraphRoots,
	findGraphNode,
	getDetachedRootOriginId,
	getDetachedRootNodeId,
	isDetachedRootId,
	removeGraphRoot,
} from './graphRootPromotion';
import {
	initializeGraphNavigator,
	type GraphNavigator,
} from './graphNavigator';
import { createGraphNavigatorRoots } from './graphNavigatorRoots';
import { createGraphArrangeAllConfirmDialog } from './graphArrangeAllConfirmDialog';
import {
	initializeGraphRenderer,
	type GraphLayoutApplyOptions,
	type GraphRenderer,
	type GraphNodeArrangementRequest,
	type GraphRootReattachRequest,
	type GraphRootReattachResult,
	type GraphSourceDragRequest,
	type GraphSourceDropResult,
} from './graphRenderer';
import { createGraphReattachConfirmDialog } from './graphReattachConfirmDialog';
import { createTaskStopConfirmDialog } from '../task/taskStopConfirmDialog';
import type { GraphDetachDropRequest } from './graphDetachDrag';
import {
	createFullGraphVisibleArea,
	type GraphVisibleArea,
} from './graphVisibleArea';
import {
	createGraphState,
	type GraphState,
	type GraphStateSnapshot,
	type GraphStateStore,
} from './graphState';
import type {
	GraphNodeEffect,
	GraphNodeEffectKind,
	GraphNodeEffectTarget,
	WorkspaceNodeStateIdChanges,
} from '../../messages';
import {
	createGraphNodeEffects,
	type GraphNodeEffectOwner,
} from './graphNodeEffects';
import type { AgentActivityStore } from '../../agent/webview/agentActivityStore';
import type { AgentSessionPresentationStore } from '../../agent/webview/agentSessionPresentationStore';
import {
	AGENT_ACTIVITY_BINDING_TOP_GAP,
	createAgentActivityBindings,
	getAgentActivityBindingBlockHeight,
} from './agentActivityBindings';
import {
	createAgentActivityTargetRevealState,
	resolveAgentActivityTargetFocusPoint,
} from './agentActivityFocus';
import type { GitDecorationBindings } from './gitDecorationStore';
import {
	initializeAgentActivityNotificationCenter,
	type AgentActivityNotificationCenter,
} from './agentActivityNotificationCenter';
import type {
	AgentActivityNotificationScheduler,
} from './agentActivityFloatingNotifications';
import type { AgentActivityNotificationEntry } from './agentActivityNotifications';
import { initializeTaskAgentSessionEndNoticeStack } from './taskAgentSessionEndNotices';
import {
	createTaskExecutionActivitySessionId,
	createTaskExecutionActivityTabId,
	TASK_DEFAULT_END_POSITION,
	isTaskExecutionActive,
	type TaskBlueprint,
	type TaskExecutionSnapshot,
	type TaskNodePosition,
	type TaskOrigin,
} from '../../task';
import {
	createWorkspaceTaskState,
	type TaskGraphTargetOrigin,
	type WorkspaceTaskRecord,
	type WorkspaceTaskStateStore,
} from '../../task/workspaceTaskState';
import {
	materializeTaskTransfer,
	parseTaskTransferJson,
	trySerializeTaskTransfer,
	type TaskTransferSerializeFailureReason,
} from '../../task/taskTransfer';
import {
	createTaskGraphLayout,
	TASK_NODE_HEIGHT,
	TASK_NODE_WIDTH,
	isTaskGraphScopeLayoutNode,
	type TaskGraphLayout,
	type TaskGraphTargetAreaKind,
	type TaskLayoutNode,
} from '../task/taskLayout';
import { initializeTaskRenderer } from '../task/taskRenderer';
import {
	createTaskGraphScopeLayout,
	createTaskGraphScopeNodePositions,
	createTaskGraphTargetIndex,
	sortTaskGraphTargetIds,
	type TaskGraphScopeLayout,
} from '../task/taskGraphTargetLayout';
import {
	initializeTaskInspector,
	type FocusedTaskNode,
	type TaskInspectorFieldInput,
	type TaskInspectorRootOption,
} from '../task/taskInspector';
import { createTaskImportDialog } from '../task/taskImportDialog';

/** Graph DOM 계층과 State, Camera lifecycle을 하나로 제공한다. */
export interface GraphView {
	/** Camera, Node 위치, File Group page, Open, Detached Root 및 Filter를 관리하는 Store다. */
	readonly state: GraphStateStore;
	/** Pan/Zoom과 Viewport/World 좌표 변환을 제공하는 Camera다. */
	readonly camera: GraphCamera;
	/** Task 생성, 연결과 explicit Node 위치의 source of truth인 Domain Store다. */
	readonly taskState: WorkspaceTaskStateStore;
	/** Workspace owner/provenance와 projection 전 Graph 위치를 함께 반환한다. */
	getWorkspaceSnapshot(): GraphViewWorkspaceSnapshot;
	/** Workspace 영속 snapshot 변경을 구독한다. */
	subscribeWorkspaceSnapshot(
		subscriber: (snapshot: GraphViewWorkspaceSnapshot) => void,
	): () => void;
	/** Panel/Dock/Webview 변화 뒤 Visible Graph 기반 Overlay를 즉시 다시 배치한다. */
	refreshVisibleGraphArea(): void;
	/** 기존 View와 State를 유지하며 새로운 Workspace Graph를 적용한다. */
	updateGraph(graph: Graph): void;
	/** 기존 View와 Workspace Graph를 유지하며 Task Blueprint 목록을 적용한다. */
	updateTasks(tasks: readonly TaskBlueprint[]): void;
	/** Host-owned Task 실행 snapshot을 Node runtime presentation에 적용한다. */
	applyTaskExecutionSnapshot?(snapshot: TaskExecutionSnapshot): void;
	/** Work용 실제 Agent 세션을 Task Node Activity 표시와 추적에 연결한다. */
	assignTaskWorkAgentSession?(
		executionId: string,
		workNodeId: string,
		sessionId: string,
	): void;
	/** 정리된 Task-owned 실제 Agent 세션의 중앙 하단 안내를 표시한다. */
	showTaskAgentSessionEndedNotice(sessionId: string, sessionTitle: string): void;
	/** Root Graph와 해당 Root들에서 복원한 전체 Workspace 상태를 원자적으로 적용한다. */
	updateWorkspace(
		graph: Graph,
		snapshot: GraphViewWorkspaceSnapshot,
		stateIdChanges?: WorkspaceNodeStateIdChanges,
	): void;
	/** Host가 지정한 transient 시각 효과를 같은 kind 기준으로 적용 또는 교체한다. */
	setNodeEffect(target: GraphNodeEffectTarget, effect: GraphNodeEffect): void;
	/** 특정 target의 한 kind 또는 모든 transient 시각 효과를 제거한다. */
	clearNodeEffect(target: GraphNodeEffectTarget, kind?: GraphNodeEffectKind): void;
	/** 한 기능이 소유한 Effect만 독립적으로 정리할 수 있는 범위를 만든다. */
	createNodeEffectOwner(): GraphNodeEffectOwner;
	/** Navigator, Renderer, Camera와 생성한 Viewport DOM을 정리한다. */
	dispose(): void;
}

/** Webview가 `.crispy/state.json`으로 전달할 projection-free Workspace 상태다. */
export interface GraphViewWorkspaceSnapshot {
	readonly graph: Pick<
		GraphStateSnapshot,
		| 'nodePositions'
		| 'fileGroupPages'
		| 'openedFolders'
		| 'detachedRootNodeIds'
		| 'hiddenNodeIds'
	>;
	readonly tasks: readonly WorkspaceTaskRecord[];
}

/** Graph View의 비영속 runtime integration만 선택적으로 주입한다. */
export interface GraphViewRuntimeOptions {
	readonly agentActivityStore?: AgentActivityStore;
	readonly agentSessionPresentationStore?: AgentSessionPresentationStore;
	readonly agentActivityNotificationScheduler?: AgentActivityNotificationScheduler;
	readonly gitDecorations?: GitDecorationBindings;
}

/** Task Scope bounds에서 Card와 Agent Binding의 전체 표시 높이를 반환한다. */
function getTaskScopeGraphNodeHeight(node: GraphLayoutNode): number {
	const renderedHeight = node.renderedHeight ?? node.height;
	const bindingBlockHeight = getAgentActivityBindingBlockHeight(
		node.agentActivityBindingCount ?? 0,
	);

	if (bindingBlockHeight === 0) {
		return renderedHeight;
	}

	const bindingBottom = node.agentActivityBindingTop === undefined
		? renderedHeight + bindingBlockHeight
		: node.agentActivityBindingTop
			+ bindingBlockHeight
			- AGENT_ACTIVITY_BINDING_TOP_GAP;

	return Math.max(renderedHeight, bindingBottom);
}

/** Edge/Card geometry를 바꾸지 않고 Task Scope footprint 계산용 높이만 확장한다. */
function createTaskScopeBoundsGraphLayout(layout: GraphLayout): GraphLayout {
	let changed = false;
	const nodes = layout.nodes.map((node): GraphLayoutNode => {
		const height = getTaskScopeGraphNodeHeight(node);

		if (height === node.height) {
			return node;
		}
		changed = true;
		return { ...node, height };
	});

	return changed ? { ...layout, nodes } : layout;
}

const TASK_CREATION_OFFSET = 32;
const DEFAULT_TASK_LAYOUT_WIDTH = TASK_DEFAULT_END_POSITION.x
	+ TASK_NODE_WIDTH;

/** 새 Task만 처음 식별 가능하게 두며, 생성 이후 좌표에는 충돌 제약을 적용하지 않는다. */
function createTaskOriginInVisibleArea(
	camera: GraphCamera,
	visibleArea: GraphVisibleArea,
	tasks: readonly TaskBlueprint[],
): TaskOrigin {
	const center = camera.viewportToWorld(visibleArea.center);
	const baseOrigin = {
		x: center.x - DEFAULT_TASK_LAYOUT_WIDTH / 2,
		y: center.y - TASK_NODE_HEIGHT / 2,
	};

	for (let slot = 0; slot <= tasks.length; slot += 1) {
		const candidate = {
			x: baseOrigin.x + slot * TASK_CREATION_OFFSET,
			y: baseOrigin.y + slot * TASK_CREATION_OFFSET,
		};

		if (!tasks.some((task) => (
			task.origin.x === candidate.x && task.origin.y === candidate.y
		))) {
			return candidate;
		}
	}

	return baseOrigin;
}

/** 원본 Workspace Graph의 Project Root만 owner 후보로 노출한다. */
export function createTaskWorkspaceRootOptions(
	graph: Graph,
): readonly TaskInspectorRootOption[] {
	const roots = graph.roots.flatMap((root) => {
		const node = graph.rootNodes[root.nodeId];

		return node?.kind === 'project'
			? [{ value: root.nodeId, label: node.name }]
			: [];
	});
	const labelCounts = new Map<string, number>();

	for (const root of roots) {
		labelCounts.set(root.label, (labelCounts.get(root.label) ?? 0) + 1);
	}
	return roots.map((root) => ({
		value: root.value,
		label: (labelCounts.get(root.label) ?? 0) > 1
			? `${root.label} — ${root.value.replace(/^workspace-root:/, '')}`
			: root.label,
	}));
}

/** 기존 GraphView의 Blueprint 초기 입력을 owner/provenance가 완전한 record로 보강한다. */
function createInitialWorkspaceTaskRecords(
	tasks: readonly TaskBlueprint[],
	graph: Graph,
	targetIndex: ReturnType<typeof createTaskGraphTargetIndex>,
): WorkspaceTaskRecord[] {
	const ownerRootId = createTaskWorkspaceRootOptions(graph)[0]?.value
		?? 'workspace-root:transient';

	return tasks.map((task) => ({
		ownerRootId,
		storageRevision: 1,
		task,
		targetOrigins: collectTaskTargetOrigins(task, ownerRootId, targetIndex),
	}));
}

function collectTaskTargetOrigins(
	task: TaskBlueprint,
	fallbackRootId: string,
	targetIndex: ReturnType<typeof createTaskGraphTargetIndex>,
): TaskGraphTargetOrigin[] {
	const origins: TaskGraphTargetOrigin[] = [];
	const appendTargets = (
		nodeId: string,
		area: 'reference' | 'work',
		sourceIds: readonly string[],
	): void => {
		for (const sourceId of sourceIds) {
			origins.push({
				nodeId,
				area,
				sourceId,
				sourceRootId: targetIndex.get(sourceId)?.sourceRootId ?? fallbackRootId,
			});
		}
	};
	const start = task.nodes.find((node) => node.kind === 'start');

	if (start) {
		appendTargets(start.id, 'reference', task.defaultGraphTargets.reference);
		appendTargets(start.id, 'work', task.defaultGraphTargets.work);
	}
	for (const node of task.nodes) {
		if (node.kind === 'work') {
			appendTargets(node.id, 'reference', node.graphTargets.reference);
			appendTargets(node.id, 'work', node.graphTargets.work);
		}
	}
	return origins;
}

function createTaskTargetOriginKey(
	nodeId: string,
	area: 'reference' | 'work',
	sourceId: string,
): string {
	return [nodeId, area, sourceId].join('\u0000');
}

/**
 * 현재 열려 있는 Project Root 집합에 맞지 않는 Task와 영역 참조를 제거한다.
 * owner Root가 사라진 Task는 표시하지 않고, 외부 Root provenance가 사라진
 * membership은 Blueprint와 provenance 양쪽에서 같은 transaction으로 정리한다.
 */
export function sanitizeWorkspaceTaskRecords(
	records: readonly WorkspaceTaskRecord[],
	graph: Graph,
): WorkspaceTaskRecord[] {
	const activeRootIds = new Set(
		createTaskWorkspaceRootOptions(graph).map((option) => option.value),
	);
	const targetIndex = createTaskGraphTargetIndex(graph);

	return records.flatMap((record) => {
		if (!activeRootIds.has(record.ownerRootId)) {
			return [];
		}

		const removedOriginKeys = new Set<string>();
		let provenanceChanged = false;
		const targetOrigins = record.targetOrigins.flatMap((origin) => {
			const currentSource = targetIndex.get(origin.sourceId);

			if (currentSource) {
				if (currentSource.sourceRootId !== origin.sourceRootId) {
					provenanceChanged = true;
					return [{
						...origin,
						sourceRootId: currentSource.sourceRootId,
					}];
				}
				return [origin];
			}
			if (activeRootIds.has(origin.sourceRootId)) {
				// 같은 Root가 활성 상태라면 일시적인 scan 누락으로 보고 보존한다.
				return [origin];
			}
			provenanceChanged = true;
			removedOriginKeys.add(createTaskTargetOriginKey(
					origin.nodeId,
					origin.area,
					origin.sourceId,
				));
			return [];
		});

		if (!provenanceChanged) {
			return [record];
		}

		const removeUnavailableTargets = (
			nodeId: string,
			area: 'reference' | 'work',
			sourceIds: readonly string[],
		): string[] => sourceIds.filter((sourceId) => !removedOriginKeys.has(
			createTaskTargetOriginKey(nodeId, area, sourceId),
		));
		const start = record.task.nodes.find((node) => node.kind === 'start');
		const task: TaskBlueprint = {
			...record.task,
			defaultGraphTargets: start
				? {
					reference: removeUnavailableTargets(
						start.id,
						'reference',
						record.task.defaultGraphTargets.reference,
					),
					work: removeUnavailableTargets(
						start.id,
						'work',
						record.task.defaultGraphTargets.work,
					),
				}
				: record.task.defaultGraphTargets,
			nodes: record.task.nodes.map((node) => node.kind === 'work'
				? {
					...node,
					graphTargets: {
						reference: removeUnavailableTargets(
							node.id,
							'reference',
							node.graphTargets.reference,
						),
						work: removeUnavailableTargets(
							node.id,
							'work',
							node.graphTargets.work,
						),
					},
				}
				: node),
		};

		return [{
			...record,
			storageRevision: record.storageRevision < Number.MAX_SAFE_INTEGER
				? record.storageRevision + 1
				: record.storageRevision,
			task,
			targetOrigins,
		}];
	});
}

/** Graph View가 Renderer의 향후 Root Promotion 요청을 전달할 상위 계약이다. */
export interface GraphViewInteractions {
	/** 내부 Promotion 처리 뒤 Detach 완료 요청을 관찰하는 선택적 callback이다. */
	onDetachDrop?: (request: GraphDetachDropRequest) => void;
	/** Session별 Activity Animation Binding이 가리킨 정확한 Session을 Agent Panel에 표시한다. */
	onAgentSessionOpenRequest?: (sessionId: string) => void;
	/** 일반 File Row의 Editor 열기 요청을 안정적인 File ID로 전달한다. */
	onFileOpenRequest?: (fileId: string) => void;
	/** 생성한 Task 전송 JSON을 Host clipboard 경계로 전달한다. */
	onTaskJsonCopyRequest?: (json: string) => void;
	/** Task 전송 JSON 생성 실패를 안전한 reason으로 전달한다. */
	onTaskJsonCopyFailure?: (reason: TaskTransferSerializeFailureReason) => void;
	/** Ready Start 실행 요청을 현재 persisted revision과 함께 Host 경계로 전달한다. */
	onTaskExecutionStart?: (taskId: string, storageRevision: number) => void;
	/** 완료 알림 삭제나 강제 종료로 수명이 끝난 Task-owned Agent 세션과 탭을 정리한다. */
	onTaskAgentSessionCleanupRequest?: (
		targets: readonly TaskAgentSessionCleanupTarget[],
	) => void;
	/** Floating Overlay를 제외한 현재 Graph 표시 영역을 Viewport local 좌표로 계산한다. */
	resolveVisibleGraphArea?: (viewport: HTMLElement) => GraphVisibleArea;
}

/** 완료 Activity에서 검증한 Work 실행과 실제 Agent 세션·탭의 exact binding이다. */
export interface TaskAgentSessionCleanupTarget {
	readonly executionId: string;
	readonly workNodeId: string;
	readonly sessionId: string;
	readonly tabId: string;
}

/** 상위 Root Instance 아래에서 분리된 Root와 origin chain 깊이다. */
interface DescendantDetachedRoot {
	readonly root: GraphRoot;
	readonly depth: number;
}

/** Start 기본 Scope 또는 Work 고유 Scope 영역 하나를 가리키는 Domain 주소다. */
interface TaskGraphScopeAddress {
	readonly taskId: string;
	readonly nodeId: string;
	readonly area: TaskGraphTargetAreaKind;
}

/** 영역의 canonical Source membership과 실제 occurrence 소유권을 연결한다. */
interface TaskGraphScopeBinding extends TaskGraphScopeAddress {
	readonly sourceId: string;
}

function createTaskGraphScopeBindingKey(
	binding: TaskGraphScopeBinding,
): string {
	return [
		binding.taskId,
		binding.nodeId,
		binding.area,
		binding.sourceId,
	].join('\u0000');
}

function isSameTaskGraphScopeAddress(
	left: TaskGraphScopeAddress,
	right: TaskGraphScopeAddress,
): boolean {
	return left.taskId === right.taskId
		&& left.nodeId === right.nodeId
		&& left.area === right.area;
}

function createTaskGraphScopeAreaKey(
	taskId: string,
	nodeId: string,
	area: TaskGraphTargetAreaKind,
): string {
	return `${taskId}\u0000${nodeId}\u0000${area}`;
}

/**
 * `detached-from` origin chain을 따라 특정 Root Instance의 모든 하위 분리를 찾는다.
 * Source nodeId가 같아도 다른 Root Instance에서 시작한 분리는 포함하지 않는다.
 */
function collectDescendantDetachedRoots(
	graph: Graph,
	targetRootId: string,
): readonly DescendantDetachedRoot[] {
	const rootsByOrigin = new Map<string, GraphRoot[]>();

	for (const root of graph.roots) {
		const originRootId = getDetachedRootOriginId(root.id);

		if (!originRootId) {
			continue;
		}
		const roots = rootsByOrigin.get(originRootId) ?? [];

		roots.push(root);
		rootsByOrigin.set(originRootId, roots);
	}

	const descendants: DescendantDetachedRoot[] = [];
	const visitedRootIds = new Set<string>();
	const visit = (originRootId: string, depth: number): void => {
		for (const root of rootsByOrigin.get(originRootId) ?? []) {
			if (visitedRootIds.has(root.id)) {
				continue;
			}

			visitedRootIds.add(root.id);
			descendants.push({ root, depth });
			visit(root.id, depth + 1);
		}
	};

	visit(targetRootId, 1);
	return descendants;
}

/** 접힌 Node와 비정렬 Node도 포함하는 Root Instance별 논리 Parent 계층을 구성한다. */
function createGraphLogicalParentByChild(
	graph: Graph,
): ReadonlyMap<string, string> {
	const parentByChild = new Map<string, string>();
	const detachedOccurrenceKeys = new Set(graph.roots
		.filter((root) => isDetachedRootId(root.id))
		.map((root) => createDetachedOccurrenceKey(
			root.nodeId,
			getDetachedRootOriginId(root.id),
		)));
	const visit = (node: GraphRootNode, layoutRoot: GraphRoot): void => {
		if (node.kind === 'file') {
			return;
		}
		const parentId = createGraphLayoutNodeId(layoutRoot.id, node.id);
		const occurrenceRootId = isDetachedRootId(layoutRoot.id)
			? layoutRoot.id
			: undefined;
		const directFiles = node.children.filter((child) => child.kind === 'file');

		if (directFiles.length > 0) {
			parentByChild.set(
				createGraphLayoutNodeId(
					layoutRoot.id,
					createFileGroupId(node.id),
				),
				parentId,
			);
		}

		for (const child of node.children) {
			if (detachedOccurrenceKeys.has(createDetachedOccurrenceKey(
				child.id,
				occurrenceRootId,
			))) {
				continue;
			}
			const childId = createGraphLayoutNodeId(layoutRoot.id, child.id);

			parentByChild.set(childId, parentId);
			if (child.kind === 'folder') {
				visit(child, layoutRoot);
			}
		}
	};

	for (const root of graph.roots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (rootNode) {
			visit(rootNode, root);
		}
	}

	return parentByChild;
}

function createDetachedOccurrenceKey(
	nodeId: string,
	originRootId: string | undefined,
): string {
	return `${originRootId ?? ''}\u0000${nodeId}`;
}

/** Parent index의 역방향을 따라 Root 자신과 모든 논리 Descendant를 수집한다. */
function collectGraphLogicalSubtreeNodeIds(
	rootNodeId: string,
	parentByChild: ReadonlyMap<string, string>,
): ReadonlySet<string> {
	const childrenByParent = new Map<string, string[]>();

	for (const [childId, parentId] of parentByChild) {
		const children = childrenByParent.get(parentId) ?? [];

		children.push(childId);
		childrenByParent.set(parentId, children);
	}
	const nodeIds = new Set<string>();
	const pending = [rootNodeId];

	while (pending.length > 0) {
		const nodeId = pending.pop();

		if (!nodeId || nodeIds.has(nodeId)) {
			continue;
		}
		nodeIds.add(nodeId);
		pending.push(...(childrenByParent.get(nodeId) ?? []));
	}

	return nodeIds;
}

/** Source occurrence의 저장 좌표를 새 Root Instance로 상대 이동해 복사한다. */
function cloneDetachedSubtreePositions(
	basePositions: GraphStateSnapshot['nodePositions'],
	sourcePositions: GraphStateSnapshot['nodePositions'],
	previousLayout: GraphLayout,
	sourceRootNodeId: string,
	targetRootId: string,
	targetPosition: { readonly x: number; readonly y: number },
	logicalParentByChild: ReadonlyMap<string, string>,
	removeSourceOccurrence: boolean,
): Record<string, { x: number; y: number }> {
	const positions = Object.fromEntries(Object.entries(basePositions).map(
		([nodeId, position]) => [nodeId, { ...position }],
	));
	const sourceRoot = previousLayout.nodes.find(
		(node) => node.id === sourceRootNodeId,
	);
	const sourceRootPosition = sourcePositions[sourceRootNodeId]
		?? sourceRoot?.position;
	const sourceSubtreeNodeIds = collectGraphLogicalSubtreeNodeIds(
		sourceRootNodeId,
		logicalParentByChild,
	);

	for (const sourceNodeId of sourceSubtreeNodeIds) {
		const sourcePosition = sourcePositions[sourceNodeId];

		if (sourcePosition && sourceRootPosition) {
			const targetNodeId = createGraphLayoutNodeId(
				targetRootId,
				getGraphLayoutSourceId(sourceNodeId),
			);

			positions[targetNodeId] = {
				x: targetPosition.x + sourcePosition.x - sourceRootPosition.x,
				y: targetPosition.y + sourcePosition.y - sourceRootPosition.y,
			};
		}
		if (removeSourceOccurrence) {
			delete positions[sourceNodeId];
		}
	}

	positions[createGraphLayoutNodeId(
		targetRootId,
		getGraphLayoutSourceId(sourceRootNodeId),
	)] = { ...targetPosition };
	return positions;
}

/** Source occurrence의 독립 정렬 상태를 새 Root-scoped Visual ID로 복사한다. */
function cloneDetachedSubtreeArrangement(
	unarrangedNodeIds: ReadonlySet<string>,
	sourceRootNodeId: string,
	targetRootId: string,
	logicalParentByChild: ReadonlyMap<string, string>,
	removeSourceOccurrence: boolean,
): Set<string> {
	const nextUnarrangedNodeIds = new Set(unarrangedNodeIds);

	for (const sourceNodeId of collectGraphLogicalSubtreeNodeIds(
		sourceRootNodeId,
		logicalParentByChild,
	)) {
		if (unarrangedNodeIds.has(sourceNodeId)) {
			nextUnarrangedNodeIds.add(createGraphLayoutNodeId(
				targetRootId,
				getGraphLayoutSourceId(sourceNodeId),
			));
		}
		if (removeSourceOccurrence) {
			nextUnarrangedNodeIds.delete(sourceNodeId);
		}
	}

	return nextUnarrangedNodeIds;
}

/** 제거할 Detached Instance 상태를 정리하고 마지막 Instance면 원래 occurrence로 돌린다. */
function reattachDetachedSubtreeArrangement(
	unarrangedNodeIds: ReadonlySet<string>,
	sourceRootNodeId: string,
	destinationRootNodeId: string,
	logicalParentByChild: ReadonlyMap<string, string>,
	restoreOccurrence: boolean,
): Set<string> {
	const nextUnarrangedNodeIds = new Set(unarrangedNodeIds);

	for (const sourceNodeId of collectGraphLogicalSubtreeNodeIds(
		sourceRootNodeId,
		logicalParentByChild,
	)) {
		nextUnarrangedNodeIds.delete(sourceNodeId);
		if (
			restoreOccurrence
			&& sourceNodeId !== sourceRootNodeId
			&& unarrangedNodeIds.has(sourceNodeId)
		) {
			nextUnarrangedNodeIds.add(toInstanceStateId(
				getGraphLayoutRootId(destinationRootNodeId),
				getGraphLayoutSourceId(sourceNodeId),
			));
		}
	}

	return nextUnarrangedNodeIds;
}

/** Reattach Source의 실제 좌표를 Destination ID로 옮겨 직계 Parent local 입력을 만든다. */
function transferReattachedSubtreePositions(
	basePositions: GraphStateSnapshot['nodePositions'],
	sourcePositions: GraphStateSnapshot['nodePositions'],
	previousLayout: GraphLayout,
	nextLayout: GraphLayout,
	sourceRootNodeId: string,
	destinationRootNodeId: string,
	logicalParentByChild: ReadonlyMap<string, string>,
	restoreOccurrence: boolean,
): Record<string, { x: number; y: number }> {
	const positions = Object.fromEntries(Object.entries(basePositions).map(
		([nodeId, position]) => [nodeId, { ...position }],
	));
	const previousNodesById = new Map(
		previousLayout.nodes.map((node) => [node.id, node]),
	);
	const sourceRootPosition = sourcePositions[sourceRootNodeId]
		?? previousNodesById.get(sourceRootNodeId)?.position;
	const destinationRoot = nextLayout.nodes.find(
		(node) => node.id === destinationRootNodeId,
	);
	const destinationRootSeed = destinationRoot?.position;

	for (const sourceNodeId of collectGraphLogicalSubtreeNodeIds(
		sourceRootNodeId,
		logicalParentByChild,
	)) {
		delete positions[sourceNodeId];
		const sourcePosition = sourcePositions[sourceNodeId]
			?? previousNodesById.get(sourceNodeId)?.position;

		if (
			!restoreOccurrence
			|| !sourcePosition
			|| !sourceRootPosition
			|| !destinationRootSeed
		) {
			continue;
		}
		const destinationNodeId = toInstanceStateId(
			getGraphLayoutRootId(destinationRootNodeId),
			getGraphLayoutSourceId(sourceNodeId),
		);
		positions[destinationNodeId] = {
			x: destinationRootSeed.x
				+ sourcePosition.x - sourceRootPosition.x,
			y: destinationRootSeed.y
				+ sourcePosition.y - sourceRootPosition.y,
		};
	}

	return positions;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * 현재 Layout 입력인 File Group page, opened Folder 또는 hidden Node reference가 바뀔 때만
 * 다음 Layout을 적용한다.
 * Layout factory를 분리해 Camera/Drag-only 변경 fast-path를 직접 검증할 수 있다.
 */
export function initializeGraphLayoutReflow(
	state: GraphStateStore,
	renderer: Pick<GraphRenderer, 'applyLayout'>,
	navigator: Pick<GraphNavigator, 'setLayout'>,
	getCurrentLayout: () => GraphLayout,
	createLayout: (state: GraphStateSnapshot) => GraphLayout,
	getLogicalParentByChild: () => ReadonlyMap<string, string> = () => new Map(),
	onHiddenNodeIdsChange: (state: GraphStateSnapshot) => void = () => undefined,
	shouldSkipLayoutReflow: () => boolean = () => false,
	projectNodePositions: (
		layout: GraphLayout,
		nodePositions: GraphStateSnapshot['nodePositions'],
		state: GraphStateSnapshot,
	) => GraphStateSnapshot['nodePositions'] = (_layout, nodePositions) => (
		nodePositions
	),
	commitState: (
		nextState: GraphState,
		baseNodePositions: GraphStateSnapshot['nodePositions'],
	) => void = (nextState) => state.setState(nextState),
	getBaseNodePositions: (
		state: GraphStateSnapshot,
	) => GraphStateSnapshot['nodePositions'] = (snapshot) => snapshot.nodePositions,
): () => void {
	let active = true;
	let renderedFileGroupPages = state.getState().fileGroupPages;
	let renderedOpenedFolders = state.getState().openedFolders;
	let renderedHiddenNodeIds = state.getState().hiddenNodeIds;
	const unsubscribe = state.subscribe((nextState) => {
		if (
			!active
			|| (
				nextState.fileGroupPages === renderedFileGroupPages
				&& nextState.openedFolders === renderedOpenedFolders
				&& nextState.hiddenNodeIds === renderedHiddenNodeIds
			)
		) {
			return;
		}

		const hiddenNodeIdsChanged = nextState.hiddenNodeIds !== renderedHiddenNodeIds;
		const hasNewlyClosedFolder = Object.entries(renderedOpenedFolders).some(
			([nodeId, wasOpened]) => wasOpened && !nextState.openedFolders[nodeId],
		);
		renderedFileGroupPages = nextState.fileGroupPages;
		renderedOpenedFolders = nextState.openedFolders;
		renderedHiddenNodeIds = nextState.hiddenNodeIds;
		if (shouldSkipLayoutReflow()) {
			if (hiddenNodeIdsChanged) {
				onHiddenNodeIdsChange(nextState);
			}
			return;
		}
		const previousLayout = getCurrentLayout();
		const nextLayout = createLayout(nextState);
		const baseNodePositions = getBaseNodePositions(nextState);
		const rebasedNodePositions = normalizeGraphNodePositions(
			nextLayout,
			rebaseNodePositions(
				previousLayout,
				nextLayout,
				baseNodePositions,
				{
					captureCollapsedNodePositions: hasNewlyClosedFolder,
					logicalParentByChild: getLogicalParentByChild(),
				},
			),
		);
		const projectedNodePositions = projectNodePositions(
			nextLayout,
			rebasedNodePositions,
			nextState,
		);

		applyGraphLayout(
			renderer,
			navigator,
			nextLayout,
			projectedNodePositions,
		);
		if (hiddenNodeIdsChanged) {
			onHiddenNodeIdsChange(nextState);
		}
		commitState({
			camera: nextState.camera,
			nodePositions: projectedNodePositions,
			fileGroupPages: nextState.fileGroupPages,
			openedFolders: nextState.openedFolders,
			detachedRootNodeIds: nextState.detachedRootNodeIds,
			hiddenNodeIds: nextState.hiddenNodeIds,
		}, rebasedNodePositions);
	});

	return () => {
		active = false;
		unsubscribe();
	};
}

/** Renderer와 Navigator에 한 번 생성한 동일 Layout reference를 함께 적용한다. */
export function applyGraphLayout(
	renderer: Pick<GraphRenderer, 'applyLayout'>,
	navigator: Pick<GraphNavigator, 'setLayout'>,
	layout: GraphLayout,
	nodePositions?: GraphStateSnapshot['nodePositions'],
	options?: GraphLayoutApplyOptions,
): void {
	renderer.applyLayout(layout, nodePositions, options);
	navigator.setLayout(layout);
}

/** Parent-relative 좌표를 정규화하고 정적 Backlink의 독립 저장 좌표는 제거한다. */
function normalizeGraphNodePositions(
	layout: GraphLayout,
	nodePositions: GraphStateSnapshot['nodePositions'],
): Record<string, { x: number; y: number }> {
	const backlinkNodeIds = new Set(layout.nodes
		.filter((node) => (
			node.kind === 'folder-backlink'
			|| (
				node.kind === 'file-group'
					&& node.presentation === 'standalone'
					&& node.children.some(
						(file) => file.presentation === 'backlink',
					)
			)
		))
		.map((node) => node.id));

	const positionsWithoutBacklinks = Object.fromEntries(
		Object.entries(nodePositions).filter(
			([nodeId]) => !backlinkNodeIds.has(nodeId),
		),
	);
	const detectedArrangement = classifyGraphLayoutNodeArrangement(
		layout,
		positionsWithoutBacklinks,
	);

	return rebaseNodePositions(
		layout,
		layout,
		positionsWithoutBacklinks,
		{
			unarrangedNodeIds: new Set([
				...layout.unarrangedNodeIds,
				...detectedArrangement.unarrangedNodeIds,
			]),
		},
	);
}

/** 복원된 Root는 Instance ID로 정규화하고 아직 없는 Source 항목은 그대로 보존한다. */
function normalizeDetachedRootNodeIds(
	graph: Graph,
	persistedIds: Readonly<Record<string, true>>,
): Record<string, true> {
	const normalized: Record<string, true> = {};
	const detachedRoots = graph.roots.filter((root) => isDetachedRootId(root.id));

	for (const persistedId of Object.keys(persistedIds)) {
		const sourceNodeId = getDetachedRootNodeId(persistedId) ?? persistedId;
		const restored = detachedRoots.some((root) => (
			root.id === persistedId
			|| (!isDetachedRootId(persistedId) && root.nodeId === sourceNodeId)
		));

		if (!restored) {
			normalized[persistedId] = true;
		}
	}

	for (const root of detachedRoots) {
		normalized[root.id] = true;
	}

	return normalized;
}

/** 기존 Source-keyed 위치를 복원된 Detached Root의 Instance-scoped 위치로 이관한다. */
function scopeDetachedNodePositions(
	graph: Graph,
	layout: GraphLayout,
	nodePositions: GraphStateSnapshot['nodePositions'],
): Record<string, { x: number; y: number }> {
	const scoped = Object.fromEntries(Object.entries(nodePositions).map(
		([nodeId, position]) => [nodeId, { ...position }],
	));
	const visibleNodeIds = new Set(layout.nodes.map((node) => node.id));
	const logicalParentByChild = createGraphLogicalParentByChild(graph);
	const copiedSourceNodeIds = new Set<string>();

	for (const root of graph.roots.filter((candidate) => (
		isDetachedRootId(candidate.id)
	))) {
		for (const nodeId of collectGraphLogicalSubtreeNodeIds(
			getGraphRootLayoutNodeId(root),
			logicalParentByChild,
		)) {
			if (scoped[nodeId]) {
				continue;
			}

			const sourceNodeId = getGraphLayoutSourceId(nodeId);
			const sourcePosition = nodePositions[sourceNodeId];

			if (!sourcePosition) {
				continue;
			}

			scoped[nodeId] = { ...sourcePosition };
			copiedSourceNodeIds.add(sourceNodeId);
		}
	}

	for (const sourceNodeId of copiedSourceNodeIds) {
		if (!visibleNodeIds.has(sourceNodeId)) {
			delete scoped[sourceNodeId];
		}
	}

	return scoped;
}

interface GraphInstanceVisualState {
	readonly openedFolders: Record<string, true>;
	readonly fileGroupPages: Record<string, number>;
}

/** Source subtree에서 Instance별로 보존할 Folder와 File Group Source ID를 수집한다. */
function collectSubtreeVisualStateIds(rootNode: GraphRootNode): {
	readonly folderIds: readonly string[];
	readonly fileGroupIds: readonly string[];
} {
	const folderIds: string[] = [];
	const fileGroupIds: string[] = [];
	const visit = (node: GraphRootNode): void => {
		if (node.kind === 'file') {
			return;
		}

		folderIds.push(node.id);
		if (node.children.some((child) => child.kind === 'file')) {
			fileGroupIds.push(createFileGroupId(node.id));
		}

		for (const child of node.children) {
			visit(child);
		}
	};

	visit(rootNode);
	return { folderIds, fileGroupIds };
}

function toInstanceStateId(rootId: string | undefined, sourceId: string): string {
	return rootId ? createGraphLayoutNodeId(rootId, sourceId) : sourceId;
}

/** 한 occurrence의 Visual 상태를 새 Detached Root로 복사하고 원래 Card 상태를 정리한다. */
function cloneDetachedInstanceVisualState(
	snapshot: GraphStateSnapshot,
	rootNode: GraphRootNode,
	templateRootId: string | undefined,
	newRootId: string,
	replacedOccurrenceRootId: string | undefined,
	removeReplacedOccurrence: boolean,
): GraphInstanceVisualState {
	const openedFolders = { ...snapshot.openedFolders };
	const fileGroupPages = { ...snapshot.fileGroupPages };
	const { folderIds, fileGroupIds } = collectSubtreeVisualStateIds(rootNode);

	for (const sourceId of folderIds) {
		const templateId = toInstanceStateId(templateRootId, sourceId);
		const nextId = createGraphLayoutNodeId(newRootId, sourceId);

		if (snapshot.openedFolders[templateId] === true) {
			openedFolders[nextId] = true;
		} else {
			delete openedFolders[nextId];
		}
		if (removeReplacedOccurrence) {
			delete openedFolders[toInstanceStateId(
				replacedOccurrenceRootId,
				sourceId,
			)];
		}
	}

	for (const sourceId of fileGroupIds) {
		const templateId = toInstanceStateId(templateRootId, sourceId);
		const nextId = createGraphLayoutNodeId(newRootId, sourceId);
		const page = snapshot.fileGroupPages[templateId];

		if (page === undefined) {
			delete fileGroupPages[nextId];
		} else {
			fileGroupPages[nextId] = page;
		}
		if (removeReplacedOccurrence) {
			delete fileGroupPages[toInstanceStateId(
				replacedOccurrenceRootId,
				sourceId,
			)];
		}
	}

	return { openedFolders, fileGroupPages };
}

/** 선택 Root의 Visual 상태를 삭제하고 마지막 Instance면 정확한 원래 occurrence로 돌린다. */
function reattachInstanceVisualState(
	snapshot: GraphStateSnapshot,
	rootNode: GraphRootNode,
	root: GraphRoot,
	restoreOccurrence: boolean,
): GraphInstanceVisualState {
	const openedFolders = { ...snapshot.openedFolders };
	const fileGroupPages = { ...snapshot.fileGroupPages };
	const originRootId = getDetachedRootOriginId(root.id);
	const { folderIds, fileGroupIds } = collectSubtreeVisualStateIds(rootNode);

	for (const sourceId of folderIds) {
		const detachedId = createGraphLayoutNodeId(root.id, sourceId);
		const destinationId = toInstanceStateId(originRootId, sourceId);

		if (restoreOccurrence && snapshot.openedFolders[detachedId] === true) {
			openedFolders[destinationId] = true;
		} else if (restoreOccurrence) {
			delete openedFolders[destinationId];
		}
		delete openedFolders[detachedId];
	}

	for (const sourceId of fileGroupIds) {
		const detachedId = createGraphLayoutNodeId(root.id, sourceId);
		const destinationId = toInstanceStateId(originRootId, sourceId);
		const page = snapshot.fileGroupPages[detachedId];

		if (restoreOccurrence && page !== undefined) {
			fileGroupPages[destinationId] = page;
		} else if (restoreOccurrence) {
			delete fileGroupPages[destinationId];
		}
		delete fileGroupPages[detachedId];
	}

	return { openedFolders, fileGroupPages };
}

/** 모든 Detached occurrence 상태를 가장 깊은 Root부터 원래 occurrence로 복원한다. */
function restoreAllDetachedInstanceVisualState(
	graph: Graph,
	snapshot: GraphStateSnapshot,
): GraphInstanceVisualState {
	const rootsById = new Map(graph.roots.map((root) => [root.id, root]));
	const depthByRootId = new Map<string, number>();
	const resolveDepth = (root: GraphRoot, visiting = new Set<string>()): number => {
		const cached = depthByRootId.get(root.id);

		if (cached !== undefined) {
			return cached;
		}
		if (visiting.has(root.id)) {
			return 1;
		}
		const originRootId = getDetachedRootOriginId(root.id);
		const originRoot = originRootId ? rootsById.get(originRootId) : undefined;
		const nextVisiting = new Set(visiting).add(root.id);
		const depth = originRoot && isDetachedRootId(originRoot.id)
			? resolveDepth(originRoot, nextVisiting) + 1
			: 1;

		depthByRootId.set(root.id, depth);
		return depth;
	};
	const detachedRoots = graph.roots
		.filter((root) => isDetachedRootId(root.id))
		.slice()
		.sort((left, right) => resolveDepth(right) - resolveDepth(left));
	const remainingRootIds = new Set(graph.roots.map((root) => root.id));
	let currentSnapshot = snapshot;

	for (const root of detachedRoots) {
		remainingRootIds.delete(root.id);
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			continue;
		}
		const originRootId = getDetachedRootOriginId(root.id);
		const restoreOccurrence = !graph.roots.some((candidate) => (
			remainingRootIds.has(candidate.id)
			&& candidate.nodeId === root.nodeId
			&& getDetachedRootOriginId(candidate.id) === originRootId
		));
		const visualState = reattachInstanceVisualState(
			currentSnapshot,
			rootNode,
			root,
			restoreOccurrence,
		);

		currentSnapshot = { ...currentSnapshot, ...visualState };
	}

	return {
		openedFolders: { ...currentSnapshot.openedFolders },
		fileGroupPages: { ...currentSnapshot.fileGroupPages },
	};
}

/** Persisted legacy Source-keyed Visual 상태를 복원된 모든 Root Instance로 이관한다. */
function normalizeDetachedInstanceVisualState(
	graph: Graph,
	snapshot: GraphStateSnapshot,
): GraphInstanceVisualState {
	let openedFolders = { ...snapshot.openedFolders };
	let fileGroupPages = { ...snapshot.fileGroupPages };
	const detachedRoots = graph.roots.filter((root) => isDetachedRootId(root.id));

	for (const root of detachedRoots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			continue;
		}
		const originRootId = getDetachedRootOriginId(root.id);
		const { folderIds, fileGroupIds } = collectSubtreeVisualStateIds(rootNode);

		for (const sourceId of folderIds) {
			const originId = toInstanceStateId(originRootId, sourceId);
			const scopedId = createGraphLayoutNodeId(root.id, sourceId);

			if (
				openedFolders[scopedId] !== true
				&& openedFolders[originId] === true
			) {
				openedFolders[scopedId] = true;
			}
		}
		for (const sourceId of fileGroupIds) {
			const originId = toInstanceStateId(originRootId, sourceId);
			const scopedId = createGraphLayoutNodeId(root.id, sourceId);

			if (
				fileGroupPages[scopedId] === undefined
				&& fileGroupPages[originId] !== undefined
			) {
				fileGroupPages[scopedId] = fileGroupPages[originId];
			}
		}
	}

	for (const root of detachedRoots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			continue;
		}
		const originRootId = getDetachedRootOriginId(root.id);
		const { folderIds, fileGroupIds } = collectSubtreeVisualStateIds(rootNode);

		for (const sourceId of folderIds) {
			delete openedFolders[toInstanceStateId(originRootId, sourceId)];
		}
		for (const sourceId of fileGroupIds) {
			delete fileGroupPages[toInstanceStateId(originRootId, sourceId)];
		}
	}

	return { openedFolders, fileGroupPages };
}

/**
 * 최신 Graph/Layout/State에서 Root 중심을 구해 공통 Camera Focus를 요청한다.
 * 저장 위치가 없을 때만 현재 Layout 기본 위치를 사용한다.
 */
export function focusGraphRoot(
	graph: Graph,
	layout: GraphLayout,
	state: Pick<GraphStateStore, 'getState'>,
	camera: Pick<GraphCamera, 'focusOn'>,
	targetRootId: string,
): boolean {
	const targetRoot = graph.roots.find((root) => root.id === targetRootId);

	if (!targetRoot) {
		return false;
	}

	const rootNodeId = getGraphRootLayoutNodeId(targetRoot);
	const rootNode = layout.nodes.find((node) => node.id === rootNodeId);

	if (!rootNode) {
		return false;
	}

	const rootPosition = state.getState().nodePositions[rootNodeId]
		?? rootNode.position;

	camera.focusOn({
		x: rootPosition.x + rootNode.width / 2,
		y: rootPosition.y + rootNode.height / 2,
	});

	return true;
}

/** Backlink DOM의 client 중심을 Viewport local과 World 좌표로 변환해 Focus한다. */
export function focusGraphBacklink(
	renderer: Pick<GraphRenderer, 'getBacklinkClientCenter'>,
	viewport: HTMLElement,
	camera: Pick<GraphCamera, 'viewportToWorld' | 'focusOn'>,
	targetRootId: string,
): boolean {
	const backlinkCenter = renderer.getBacklinkClientCenter(targetRootId);

	if (!backlinkCenter) {
		return false;
	}

	const viewportBounds = viewport.getBoundingClientRect();
	const worldPoint = camera.viewportToWorld({
		x: backlinkCenter.clientX - viewportBounds.left,
		y: backlinkCenter.clientY - viewportBounds.top,
	});

	camera.focusOn(worldPoint);
	return true;
}

/**
 * Graph가 렌더링될 Viewport, World, Edge/Node/Overlay Layer를 생성하고
 * 전달받은 Graph 기반 Layout, Renderer, Camera, Navigator를 초기화한다.
 *
 * @param root Graph View를 마운트할 요소
 * @param initialState 복원할 초기 Graph 상태
 * @param graph 렌더링할 Root 목록과 Project Tree
 * @param interactions Detach 완료 요청을 Graph 변경 없이 전달할 callback
 * @param initialTasks 같은 World에 최초 렌더링할 Task Blueprint 목록
 * @param initialWorkspaceTasks Host가 복원한 owner/provenance 포함 Task record
 * @param runtimeOptions Agent Activity처럼 영속 상태와 분리된 runtime integration
 * @returns State와 Camera 및 전체 lifecycle을 제공하는 Graph View
 */
export function initializeGraphView(
	root: HTMLElement,
	initialState: GraphState,
	graph: Graph,
	interactions: GraphViewInteractions = {},
	initialTasks: readonly TaskBlueprint[] = [],
	initialWorkspaceTasks?: readonly WorkspaceTaskRecord[],
	runtimeOptions: GraphViewRuntimeOptions = {},
): GraphView {
	const ownerDocument = root.ownerDocument;
	const viewport = ownerDocument.createElement('div');
	const world = ownerDocument.createElement('div');
	const edgeLayer = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
	const effectRegionLayer = ownerDocument.createElement('div');
	const nodeLayer = ownerDocument.createElement('div');
	const overlayLayer = ownerDocument.createElement('div');

	viewport.className = 'graph-viewport';
	world.className = 'graph-world';
	edgeLayer.classList.add('graph-edge-layer');
	edgeLayer.setAttribute('aria-hidden', 'true');
	effectRegionLayer.className = 'graph-node-effect-region-layer';
	effectRegionLayer.setAttribute('aria-hidden', 'true');
	nodeLayer.className = 'graph-node-layer';
	overlayLayer.className = 'graph-overlay-layer';

	world.append(edgeLayer, nodeLayer, effectRegionLayer);
	viewport.append(world, overlayLayer);
	root.append(viewport);
	const reattachConfirmDialog = createGraphReattachConfirmDialog(overlayLayer);
	const arrangeAllConfirmDialog = createGraphArrangeAllConfirmDialog(overlayLayer);
	const taskStopConfirmDialog = createTaskStopConfirmDialog(overlayLayer);
	const taskImportDialog = createTaskImportDialog(overlayLayer);
	const nodeEffects = createGraphNodeEffects(
		ownerDocument,
		undefined,
		effectRegionLayer,
	);
	const taskWorkAgentSessions = new Map<string, Readonly<{
		actualSessionId: string;
	}>>();
	const createTaskWorkAgentSessionKey = (
		executionId: string,
		workNodeId: string,
	): string => JSON.stringify([executionId, workNodeId]);
	const taskActivityKindsBySessionId = new Map<
		string,
		Map<string, 'planned' | 'active' | 'editing' | 'completed' | 'rejected'>
	>();
	const agentActivityBindings = runtimeOptions.agentActivityStore
		? createAgentActivityBindings(
			runtimeOptions.agentActivityStore,
			nodeEffects.createLocalEffectHost,
			runtimeOptions.agentSessionPresentationStore,
			{
				onSessionOpenRequest: (sessionId) => {
					interactions.onAgentSessionOpenRequest?.(sessionId);
				},
			},
		)
		: undefined;
	const state = createGraphState(initialState);
	let workspaceGraph = graph;
	let pendingWorkspaceTaskRecords: readonly WorkspaceTaskRecord[] | undefined;
	let pendingWorkspaceGraphState: GraphViewWorkspaceSnapshot['graph'] | undefined;
	let taskGraphTargetIndex = createTaskGraphTargetIndex(workspaceGraph);
	const initialRecords = initialWorkspaceTasks
		? sanitizeWorkspaceTaskRecords(initialWorkspaceTasks, workspaceGraph)
		: createInitialWorkspaceTaskRecords(
			initialTasks,
			workspaceGraph,
			taskGraphTargetIndex,
		);
	const taskState = createWorkspaceTaskState(initialRecords, {
		defaultOwnerRootId: createTaskWorkspaceRootOptions(workspaceGraph)[0]?.value
			?? 'workspace-root:transient',
	});
	let disposed = false;
	/** 활성 Task Scope가 World 위치를 소유하는 actual Graph occurrence Root다. */
	let currentTaskScopeBoundaryNodeIds = new Set<string>();
	/** 기본 접힘의 예외로 현재 펼쳐진 Start/Work Scope Area다. */
	const expandedTaskGraphScopeAreaKeys = new Set<string>();
	/**
	 * target이 있는 Area는 펼침을 강제하고, 사라진 owner의 transient 예외만
	 * 정리한다. 새 빈 Area는 Set에 없으므로 별도 초기화 없이 접힘이 기본이다.
	 */
	const reconcileExpandedTaskGraphScopeAreas = (): void => {
		const currentAreaKeys = new Set<string>();

		for (const task of taskState.getSnapshot().tasks) {
			for (const node of task.nodes) {
				if (node.kind === 'end') {
					continue;
				}
				const graphTargets = node.kind === 'start'
					? task.defaultGraphTargets
					: node.graphTargets;

				for (const area of ['reference', 'work'] as const) {
					const key = createTaskGraphScopeAreaKey(task.id, node.id, area);

					currentAreaKeys.add(key);
					if (graphTargets[area].length > 0) {
						expandedTaskGraphScopeAreaKeys.add(key);
					}
				}
			}
		}

		for (const key of expandedTaskGraphScopeAreaKeys) {
			if (!currentAreaKeys.has(key)) {
				expandedTaskGraphScopeAreaKeys.delete(key);
			}
		}
	};
	reconcileExpandedTaskGraphScopeAreas();
	let initialGraphState = state.getState();
	let currentGraph = applyDetachedGraphRoots(
		workspaceGraph,
		initialGraphState.detachedRootNodeIds,
	);
	let currentLogicalParentByChild = createGraphLogicalParentByChild(
		currentGraph,
	);
	const normalizedInitialDetachedRootNodeIds = normalizeDetachedRootNodeIds(
		currentGraph,
		initialGraphState.detachedRootNodeIds,
	);
	const normalizedInitialVisualState = normalizeDetachedInstanceVisualState(
		currentGraph,
		initialGraphState,
	);
	const getVisibleGraphArea = (): GraphVisibleArea => (
		interactions.resolveVisibleGraphArea?.(viewport)
		?? createFullGraphVisibleArea({
			width: viewport.clientWidth,
			height: viewport.clientHeight,
		})
	);
	const camera = initializeGraphCamera(viewport, world, state, {
		getVisibleGraphArea,
	});
	const createLayout = (
		targetGraph: Graph,
		snapshot: GraphStateSnapshot,
		manualUnarrangedNodeIds: ReadonlySet<string> = new Set(),
	): GraphLayout => createGraphLayout(targetGraph, {
		fileGroupPages: snapshot.fileGroupPages,
		openedFolders: snapshot.openedFolders,
		hiddenNodeIds: snapshot.hiddenNodeIds,
		// Scope boundary는 실제 Graph occurrence의 위치만 Task가 소유한다.
		// 사용자 Drag로 만든 manual arrangement와 provenance를 섞지 않되,
		// Layout에는 둘 다 sibling flow 밖의 actual Node로 전달한다.
		unarrangedNodeIds: new Set([
			...manualUnarrangedNodeIds,
			...currentTaskScopeBoundaryNodeIds,
		]),
		pinnedNodeIds: currentTaskScopeBoundaryNodeIds,
		getAgentActivityBindingCount: agentActivityBindings?.getBindingCount,
	});
	const normalizedInitialSnapshot = {
		...initialGraphState,
		...normalizedInitialVisualState,
	};
	const initialBaselineLayout = createLayout(
		currentGraph,
		normalizedInitialSnapshot,
	);
	// Filter projection에는 포함하지 않되, 숨겨진 subtree의 저장 좌표와
	// arrangement를 복원할 때는 동일 Graph의 전체 논리 Layout을 사용한다.
	const initialStateLayout = Object.keys(initialGraphState.hiddenNodeIds).length === 0
		? initialBaselineLayout
		: createLayout(currentGraph, {
			...normalizedInitialSnapshot,
			hiddenNodeIds: {},
		});
	const scopedInitialNodePositions = scopeDetachedNodePositions(
		currentGraph,
		initialStateLayout,
		initialGraphState.nodePositions,
	);
	state.setState({
		camera: initialGraphState.camera,
		nodePositions: normalizeGraphNodePositions(
			initialStateLayout,
			scopedInitialNodePositions,
		),
		fileGroupPages: normalizedInitialVisualState.fileGroupPages,
		openedFolders: normalizedInitialVisualState.openedFolders,
		detachedRootNodeIds: normalizedInitialDetachedRootNodeIds,
		hiddenNodeIds: initialGraphState.hiddenNodeIds,
	});
	initialGraphState = state.getState();
	const initialArrangement = classifyGraphLayoutNodeArrangement(
		initialStateLayout,
		initialGraphState.nodePositions,
	);
	let currentManualUnarrangedNodeIds = new Set([
		...initialArrangement.unarrangedNodeIds,
		...currentGraph.roots
			.filter((root) => isDetachedRootId(root.id))
			.map(getGraphRootLayoutNodeId),
	]);
	let currentLayout = currentManualUnarrangedNodeIds.size === 0
		? initialBaselineLayout
		: createLayout(
			currentGraph,
			initialGraphState,
			currentManualUnarrangedNodeIds,
		);
	let renderer: GraphRenderer;
	let navigator: GraphNavigator;
	let agentActivityNotificationCenter: AgentActivityNotificationCenter | undefined;
	let pendingAgentActivityNotificationFocus:
		| AgentActivityNotificationEntry
		| undefined;
	let taskRenderer: ReturnType<typeof initializeTaskRenderer>;
	const taskScopeOccurrencesByBinding = new Map<string, Set<string>>();
	let applyingTaskState = false;
	let handleGraphSourceDragMove = (_request: GraphSourceDragRequest): void => {
		return;
	};
	let handleGraphSourceDrop = (
		_request: GraphSourceDragRequest,
	): GraphSourceDropResult | false => false;
	let handleGraphSourceDragCancel = (): void => {
		return;
	};
	let skipGraphLayoutReflow = false;
	let persistentNodePositions: GraphStateSnapshot['nodePositions'] = {
		...initialGraphState.nodePositions,
	};
	let suppressPersistentGraphCapture = 0;
	let suppressWorkspaceNotifications = 0;
	let observedPersistentGraphState = state.getState();
	const workspaceSubscribers = new Set<(
		snapshot: GraphViewWorkspaceSnapshot,
	) => void>();
	const getWorkspaceSnapshot = (): GraphViewWorkspaceSnapshot => {
		const snapshot = state.getState();

		return {
			graph: {
				nodePositions: Object.fromEntries(Object.entries(
					persistentNodePositions,
				).map(([nodeId, position]) => [nodeId, { ...position }])),
				fileGroupPages: { ...snapshot.fileGroupPages },
				openedFolders: { ...snapshot.openedFolders },
				detachedRootNodeIds: { ...snapshot.detachedRootNodeIds },
				hiddenNodeIds: { ...snapshot.hiddenNodeIds },
			},
			tasks: taskState.getWorkspaceSnapshot().records,
		};
	};
	const notifyWorkspaceSubscribers = (): void => {
		if (
			disposed
			|| suppressWorkspaceNotifications > 0
			|| workspaceSubscribers.size === 0
		) {
			return;
		}
		const snapshot = getWorkspaceSnapshot();

		for (const subscriber of [...workspaceSubscribers]) {
			subscriber(snapshot);
		}
	};
	const collectTaskProjectionOwnedNodeIds = (): Set<string> => {
		const ownedNodeIds = new Set<string>();

		for (const boundaryNodeId of currentTaskScopeBoundaryNodeIds) {
			for (const nodeId of collectGraphLayoutSubtreeNodeIds(
				currentLayout,
				boundaryNodeId,
			)) {
				ownedNodeIds.add(nodeId);
			}
			for (const nodeId of collectGraphLogicalSubtreeNodeIds(
				boundaryNodeId,
				currentLogicalParentByChild,
			)) {
				ownedNodeIds.add(nodeId);
			}
		}
		return ownedNodeIds;
	};
	const captureProjectionFreeNodePositions = (
		nodePositions: GraphStateSnapshot['nodePositions'],
	): void => {
		const nextNodePositions: Record<string, GraphLayoutPosition> = Object.fromEntries(
			Object.entries(nodePositions).map(([nodeId, position]) => [
				nodeId,
				{ ...position },
			]),
		);

		for (const nodeId of collectTaskProjectionOwnedNodeIds()) {
			const persistentPosition = persistentNodePositions[nodeId];

			if (persistentPosition) {
				nextNodePositions[nodeId] = { ...persistentPosition };
			} else {
				delete nextNodePositions[nodeId];
			}
		}
		persistentNodePositions = nextNodePositions;
	};
	const commitRuntimeGraphState = (
		nextState: GraphState,
		options: {
			readonly baseNodePositions?: GraphStateSnapshot['nodePositions'];
			readonly projectionOnly?: boolean;
		} = {},
	): void => {
		if (options.baseNodePositions) {
			persistentNodePositions = Object.fromEntries(Object.entries(
				options.baseNodePositions,
			).map(([nodeId, position]) => [nodeId, { ...position }]));
		}

		const previous = state.getState();

		suppressPersistentGraphCapture += 1;
		try {
			state.setState(nextState);
		} finally {
			suppressPersistentGraphCapture -= 1;
		}
		const current = state.getState();
		const workspaceGraphChanged = options.baseNodePositions !== undefined
			|| previous.fileGroupPages !== current.fileGroupPages
			|| previous.openedFolders !== current.openedFolders
			|| previous.detachedRootNodeIds !== current.detachedRootNodeIds
			|| previous.hiddenNodeIds !== current.hiddenNodeIds;

		if (!options.projectionOnly && workspaceGraphChanged) {
			notifyWorkspaceSubscribers();
		}
	};
	const unsubscribeWorkspaceGraphState = state.subscribe((snapshot) => {
		const previous = observedPersistentGraphState;

		observedPersistentGraphState = snapshot;
		if (suppressPersistentGraphCapture > 0) {
			return;
		}
		let changed = false;

		if (previous.nodePositions !== snapshot.nodePositions) {
			captureProjectionFreeNodePositions(snapshot.nodePositions);
			changed = true;
		}
		if (
			previous.fileGroupPages !== snapshot.fileGroupPages
			|| previous.openedFolders !== snapshot.openedFolders
			|| previous.detachedRootNodeIds !== snapshot.detachedRootNodeIds
			|| previous.hiddenNodeIds !== snapshot.hiddenNodeIds
		) {
			changed = true;
		}
		if (changed) {
			notifyWorkspaceSubscribers();
		}
	});
	const unsubscribeWorkspaceTasks = taskState.subscribeWorkspaceTasks(
		() => notifyWorkspaceSubscribers(),
	);
	const syncNavigatorRoots = (
		snapshot: GraphStateSnapshot = state.getState(),
	): void => {
		navigator.setRoots(createGraphNavigatorRoots(
			currentGraph,
			snapshot.hiddenNodeIds,
		));
	};
	const createCurrentLayout = (snapshot: GraphStateSnapshot): GraphLayout => {
		// 초기 복원 이후 arrangement는 Drag callback이 명시적으로 갱신한다.
		// 위치가 우연히 Layout 기본점과 같아도 open/close가 독립 상태를 지우면 안 된다.
		currentLayout = createLayout(
			currentGraph,
			snapshot,
			currentManualUnarrangedNodeIds,
		);

		return currentLayout;
	};
	/** Drag Detach와 Hover Duplicate가 공유하는 Multiple Detach Instance 추가 경로다. */
	const addDetachedRootInstance = (
		request: Pick<GraphDetachDropRequest, 'nodeId' | 'instanceRootId'>,
		targetPosition: { readonly x: number; readonly y: number },
		templateRootIdOverride?: string,
		animationSourceRootId?: string,
	): string | undefined => {
		const occurrenceRoots = currentGraph.roots.filter((root) => (
			root.nodeId === request.nodeId
			&& getDetachedRootOriginId(root.id) === request.instanceRootId
		));
		const templateRootId = templateRootIdOverride
			?? occurrenceRoots.at(-1)?.id
			?? request.instanceRootId;
		const sourceRootNodeId = toInstanceStateId(
			templateRootId,
			request.nodeId,
		);
		const removeReplacedOccurrence = occurrenceRoots.length === 0;
		const addition = addGraphRoot(
			currentGraph,
			request.nodeId,
			request.instanceRootId,
		);

		if (!addition) {
			return undefined;
		}

		const snapshot = state.getState();
		const detachedRootNode = addition.graph.rootNodes[addition.root.nodeId];

		if (!detachedRootNode) {
			return undefined;
		}
		const visualState = cloneDetachedInstanceVisualState(
			snapshot,
			detachedRootNode,
			templateRootId,
			addition.root.id,
			request.instanceRootId,
			removeReplacedOccurrence,
		);
		const nextSnapshot = { ...snapshot, ...visualState };
		const previousLayout = currentLayout;
		const unarrangedNodeIds = cloneDetachedSubtreeArrangement(
			currentManualUnarrangedNodeIds,
			sourceRootNodeId,
			addition.root.id,
			currentLogicalParentByChild,
			removeReplacedOccurrence,
		);

		const detachedRootNodeId = getGraphRootLayoutNodeId(addition.root);

		unarrangedNodeIds.add(detachedRootNodeId);
		currentManualUnarrangedNodeIds = unarrangedNodeIds;
		const nextLayout = createLayout(
			addition.graph,
			nextSnapshot,
			unarrangedNodeIds,
		);
		const rebasedNodePositions = normalizeGraphNodePositions(
			nextLayout,
			rebaseNodePositions(
				previousLayout,
				nextLayout,
				persistentNodePositions,
				{
					logicalParentByChild: createGraphLogicalParentByChild(
						addition.graph,
					),
				},
			),
		);
		const translatedNodePositions = translateDetachedSubtree(
			previousLayout,
			nextLayout,
			persistentNodePositions,
			detachedRootNodeId,
			targetPosition,
			{ baseNodePositions: rebasedNodePositions },
		);
		const nodePositions = cloneDetachedSubtreePositions(
			translatedNodePositions,
			persistentNodePositions,
			previousLayout,
			sourceRootNodeId,
			addition.root.id,
			targetPosition,
			currentLogicalParentByChild,
			removeReplacedOccurrence,
		);
		const detachedRootNodeIds = {
			...snapshot.detachedRootNodeIds,
			[addition.root.id]: true as const,
		};

		currentGraph = addition.graph;
		currentLogicalParentByChild = createGraphLogicalParentByChild(
			currentGraph,
		);
		currentLayout = nextLayout;
		applyGraphLayout(
			renderer,
			navigator,
			nextLayout,
			nodePositions,
			animationSourceRootId
				? { enteringSourceRootId: animationSourceRootId }
				: undefined,
		);
		commitRuntimeGraphState({
			camera: snapshot.camera,
			nodePositions,
			fileGroupPages: visualState.fileGroupPages,
			openedFolders: visualState.openedFolders,
			detachedRootNodeIds,
			hiddenNodeIds: snapshot.hiddenNodeIds,
		}, { baseNodePositions: nodePositions });
		syncNavigatorRoots();
		return detachedRootNodeId;
	};
	const handleDetachDrop = (request: GraphDetachDropRequest): void => {
		const viewportBounds = viewport.getBoundingClientRect();
		const targetPosition = camera.viewportToWorld({
			x: request.clientX - viewportBounds.left,
			y: request.clientY - viewportBounds.top,
		});

		addDetachedRootInstance(request, targetPosition);
		interactions.onDetachDrop?.(request);
	};
	const handleBacklinkClick = (targetRootId: string): void => {
		focusGraphRoot(
			currentGraph,
			currentLayout,
			state,
			camera,
			targetRootId,
		);
	};
	const handleNavigatorRootSelect = (rootId: string): void => {
		focusGraphRoot(
			currentGraph,
			currentLayout,
			state,
			camera,
			rootId,
		);
	};
	const attemptAgentActivityNotificationFocus = (
		entry: AgentActivityNotificationEntry,
	): boolean => {
		if (disposed) {
			return false;
		}
		if (entry.target.nodeId.startsWith('task-node:')) {
			const taskNode = currentTaskLayout.nodes.find(
				(node) => node.id === entry.target.nodeId,
			);
			if (!taskNode) {
				return false;
			}
			camera.focusOn({
				x: taskNode.position.x + taskNode.width / 2,
				y: taskNode.position.y + taskNode.height / 2,
			});
			pendingAgentActivityNotificationFocus = undefined;
			return true;
		}
		const snapshot = state.getState();
		const reveal = createAgentActivityTargetRevealState(
			currentGraph,
			taskGraphTargetIndex,
			entry.target,
			snapshot,
		);

		if (!reveal) {
			return false;
		}
		state.setState(reveal.state);
		const currentSnapshot = state.getState();
		const focusPoint = resolveAgentActivityTargetFocusPoint(
			currentLayout,
			currentSnapshot.nodePositions,
			entry.target,
			reveal?.preferredRootId,
		);

		if (!focusPoint) {
			return false;
		}

		pendingAgentActivityNotificationFocus = undefined;
		camera.focusOn(focusPoint);
		return true;
	};
	const handleAgentActivityNotificationFocus = (
		entry: AgentActivityNotificationEntry,
	): void => {
		if (entry.availability === 'outside') {
			pendingAgentActivityNotificationFocus = undefined;
			return;
		}
		pendingAgentActivityNotificationFocus = entry;
		attemptAgentActivityNotificationFocus(entry);
	};
	const retryPendingAgentActivityNotificationFocus = (): void => {
		const pending = pendingAgentActivityNotificationFocus;

		if (!pending) {
			return;
		}
		const stillCurrent = runtimeOptions.agentActivityStore
			?.getActivities(pending.target)
			.some(({ sessionId }) => sessionId === pending.sessionId) === true;

		if (!stillCurrent) {
			pendingAgentActivityNotificationFocus = undefined;
			return;
		}
		attemptAgentActivityNotificationFocus(pending);
	};
	const performArrangeAll = (): void => {
		const snapshot = state.getState();
		const visualState = restoreAllDetachedInstanceVisualState(
			currentGraph,
			snapshot,
		);
		const nextSnapshot = { ...snapshot, ...visualState };

		currentGraph = workspaceGraph;
		currentLogicalParentByChild = createGraphLogicalParentByChild(currentGraph);
		currentManualUnarrangedNodeIds = new Set();
		// Detached 복구로 occurrence 주소가 바뀔 수 있으므로 canonical binding을
		// 새 Workspace Layout에서 먼저 reconcile한다. Scope boundary는 manual
		// Arrange All 대상이 아니어서 final effective Layout에 계속 남는다.
		currentLayout = createLayout(currentGraph, nextSnapshot);
		reconcileTaskGraphScopeOccurrences(collectTaskGraphScopeBindings());
		currentLayout = createLayout(currentGraph, nextSnapshot);
		const projection = applyTaskGraphScopeProjection(currentLayout, {});

		applyGraphLayout(
			renderer,
			navigator,
			currentLayout,
			projection.nodePositions,
		);
		skipGraphLayoutReflow = true;
		applyingTaskState = true;
		try {
			commitRuntimeGraphState({
				camera: snapshot.camera,
				nodePositions: projection.nodePositions,
				fileGroupPages: visualState.fileGroupPages,
				openedFolders: visualState.openedFolders,
				detachedRootNodeIds: {},
				hiddenNodeIds: snapshot.hiddenNodeIds,
			}, { baseNodePositions: {} });
		} finally {
			applyingTaskState = false;
			skipGraphLayoutReflow = false;
		}
		syncNavigatorRoots();
	};
	const handleArrangeAll = (): void => {
		void arrangeAllConfirmDialog.confirm().then((confirmed) => {
			if (confirmed && !disposed) {
				performArrangeAll();
			}
		});
	};
	const handleRootContextClick = (rootId: string): void => {
		focusGraphBacklink(renderer, viewport, camera, rootId);
	};
	const performRootReattach = ({
		rootId,
		nodeId,
	}: GraphRootReattachRequest): boolean => {
		const targetRoot = currentGraph.roots.find(
			(root) => root.id === rootId && root.nodeId === nodeId,
		);

		if (!targetRoot) {
			return false;
		}

		const nextGraph = removeGraphRoot(currentGraph, rootId);

		if (nextGraph === currentGraph) {
			return false;
		}

		const snapshot = state.getState();
		const rootNode = currentGraph.rootNodes[targetRoot.nodeId];

		if (!rootNode) {
			return false;
		}
		const originRootId = getDetachedRootOriginId(targetRoot.id);
		const restoreOccurrence = !nextGraph.roots.some((root) => (
			root.nodeId === targetRoot.nodeId
			&& getDetachedRootOriginId(root.id) === originRootId
		));
		const visualState = reattachInstanceVisualState(
			snapshot,
			rootNode,
			targetRoot,
			restoreOccurrence,
		);
		const nextSnapshot = { ...snapshot, ...visualState };
		const previousLayout = currentLayout;
		const detachedRootNodeId = getGraphRootLayoutNodeId(targetRoot);
		const destinationRootNodeId = toInstanceStateId(
			originRootId,
			targetRoot.nodeId,
		);
		const previousUnarrangedNodeIds = currentManualUnarrangedNodeIds;
		const unarrangedNodeIds = reattachDetachedSubtreeArrangement(
			previousUnarrangedNodeIds,
			detachedRootNodeId,
			destinationRootNodeId,
			currentLogicalParentByChild,
			restoreOccurrence,
		);
		const nextLogicalParentByChild = createGraphLogicalParentByChild(nextGraph);

		const nextLayout = createLayout(
			nextGraph,
			nextSnapshot,
			unarrangedNodeIds,
		);
		const transferredNodePositions = transferReattachedSubtreePositions(
			persistentNodePositions,
			snapshot.nodePositions,
			previousLayout,
			nextLayout,
			detachedRootNodeId,
			destinationRootNodeId,
			currentLogicalParentByChild,
			restoreOccurrence,
		);
		const nodePositions = normalizeGraphNodePositions(
			nextLayout,
			rebaseNodePositions(
				previousLayout,
				nextLayout,
				transferredNodePositions,
				{
					logicalParentByChild: nextLogicalParentByChild,
					unarrangedNodeIds: nextLayout.unarrangedNodeIds,
				},
			),
		);
		if (
			rootNode.kind === 'file'
			&& !nextLayout.nodes.some((node) => node.id === destinationRootNodeId)
		) {
			// grouped File Row는 Layout Node가 아니므로 독립 좌표를 소유하지 않는다.
			delete nodePositions[destinationRootNodeId];
		}
		const detachedRootNodeIds = { ...snapshot.detachedRootNodeIds };

		delete detachedRootNodeIds[rootId];
		if (!removeTaskGraphScopeBindingsForOccurrence(detachedRootNodeId)) {
			return false;
		}
		currentManualUnarrangedNodeIds = unarrangedNodeIds;
		currentGraph = nextGraph;
		currentLogicalParentByChild = nextLogicalParentByChild;
		currentLayout = nextLayout;
		applyGraphLayout(renderer, navigator, nextLayout, nodePositions);
		commitRuntimeGraphState({
			camera: snapshot.camera,
			nodePositions,
			fileGroupPages: visualState.fileGroupPages,
			openedFolders: visualState.openedFolders,
			detachedRootNodeIds,
			hiddenNodeIds: snapshot.hiddenNodeIds,
		}, { baseNodePositions: nodePositions });
		syncNavigatorRoots();
		return true;
	};
	const handleRootReattach = ({
		rootId,
		nodeId,
	}: GraphRootReattachRequest): GraphRootReattachResult => {
		const targetRoot = currentGraph.roots.find(
			(root) => root.id === rootId && root.nodeId === nodeId,
		);

		if (!targetRoot) {
			return false;
		}
		const descendants = collectDescendantDetachedRoots(
			currentGraph,
			targetRoot.id,
		);

		if (descendants.length === 0) {
			return performRootReattach({ rootId, nodeId });
		}
		const targetRootNode = currentGraph.rootNodes[targetRoot.nodeId];

		if (!targetRootNode) {
			return false;
		}

		void reattachConfirmDialog.confirm({
			targetName: targetRootNode.name,
			detachedNodes: descendants.map(({ root }) => ({
				rootId: root.id,
				name: currentGraph.rootNodes[root.nodeId]?.name ?? root.nodeId,
				...(root.context?.relativePath
					? { relativePath: root.context.relativePath }
					: {}),
			})),
		}).then((confirmed) => {
			if (!confirmed || disposed) {
				return;
			}
			const currentTargetRoot = currentGraph.roots.find(
				(root) => root.id === rootId && root.nodeId === nodeId,
			);

			if (!currentTargetRoot) {
				return;
			}
			const currentDescendants = collectDescendantDetachedRoots(
				currentGraph,
				currentTargetRoot.id,
			).slice().sort((left, right) => right.depth - left.depth);

			for (const { root } of currentDescendants) {
				performRootReattach({ rootId: root.id, nodeId: root.nodeId });
			}
			performRootReattach({
				rootId: currentTargetRoot.id,
				nodeId: currentTargetRoot.nodeId,
			});
		});

		return 'deferred';
	};
	const handleDetachedRootDuplicate = (rootId: string): void => {
		const targetRoot = currentGraph.roots.find((root) => (
			root.id === rootId && isDetachedRootId(root.id)
		));

		if (!targetRoot) {
			return;
		}

		const targetPosition = calculateDetachedRootDuplicatePosition(
			currentLayout,
			state.getState().nodePositions,
			getGraphRootLayoutNodeId(targetRoot),
		);

		if (!targetPosition) {
			return;
		}

		const originRootId = getDetachedRootOriginId(targetRoot.id);

		addDetachedRootInstance(
			{
				nodeId: targetRoot.nodeId,
				...(originRootId ? { instanceRootId: originRootId } : {}),
			},
			targetPosition,
			targetRoot.id,
			targetRoot.id,
		);
	};
	const handleDetachedRootDelete = (rootId: string): void => {
		const targetRoot = currentGraph.roots.find((root) => (
			root.id === rootId && isDetachedRootId(root.id)
		));

		if (targetRoot) {
			handleRootReattach({ rootId, nodeId: targetRoot.nodeId });
		}
	};
	const handleNodeArrangementChange = ({
		nodeId,
		arranged,
	}: GraphNodeArrangementRequest): boolean => {
		// Scope가 위치를 소유하는 동안 Renderer의 effective-unarranged 상태를
		// manual provenance로 되받아 쓰지 않는다. Region 밖 Drag는 Drop 경로가
		// 명시적으로 manual ownership으로 전환한다.
		if (currentTaskScopeBoundaryNodeIds.has(nodeId)) {
			return false;
		}
		const nextUnarrangedNodeIds = new Set(currentManualUnarrangedNodeIds);
		const wasUnarranged = nextUnarrangedNodeIds.has(nodeId);

		if (arranged) {
			nextUnarrangedNodeIds.delete(nodeId);
		} else {
			nextUnarrangedNodeIds.add(nodeId);
		}

		if (!arranged && wasUnarranged) {
			return false;
		}

		const snapshot = state.getState();
		const previousLayout = currentLayout;
		const nextLayout = createLayout(
			currentGraph,
			snapshot,
			nextUnarrangedNodeIds,
		);
		const baseNodePositions = rebaseNodePositions(
			previousLayout,
			nextLayout,
			persistentNodePositions,
			{
				logicalParentByChild: currentLogicalParentByChild,
			},
		);
		if (
			arranged
			&& !nextLayout.nodes.some((node) => node.id === nodeId)
		) {
			// standalone File Card가 grouped Row로 돌아가면 Layout 좌표 소유권도 제거한다.
			delete baseNodePositions[nodeId];
		}
		let nodePositions = baseNodePositions;
		if (currentTaskScopeBoundaryNodeIds.size > 0) {
			// Arrangement rebase는 일반 descendant를 Parent local 좌표로 옮긴다.
			// Task Scope boundary는 Task Region이 절대 World 위치를 소유하므로,
			// Renderer transition을 시작하기 전에 같은 최종 projection을 합성한다.
			// 이 순서를 지켜야 Parent만 보간되고 bound actual Node는 빨려들지 않는다.
			const wasApplyingTaskState = applyingTaskState;

			applyingTaskState = true;
			try {
				nodePositions = applyTaskGraphScopeProjection(
					nextLayout,
					nodePositions,
				).nodePositions;
			} finally {
				applyingTaskState = wasApplyingTaskState;
			}
		}

		currentManualUnarrangedNodeIds = nextUnarrangedNodeIds;
		currentLayout = nextLayout;
		applyGraphLayout(renderer, navigator, nextLayout, nodePositions);
		commitRuntimeGraphState({
			camera: snapshot.camera,
			nodePositions,
			fileGroupPages: snapshot.fileGroupPages,
			openedFolders: snapshot.openedFolders,
			detachedRootNodeIds: snapshot.detachedRootNodeIds,
			hiddenNodeIds: snapshot.hiddenNodeIds,
		}, { baseNodePositions });
		return true;
	};
	/**
	 * Task Scope boundary의 엄격한 논리 descendant인지 판별한다.
	 * Scope가 subtree 배치를 소유하는 동안 descendant Node body는 위치/정렬
	 * ownership을 별도로 가져갈 수 없다. Root 자신의 Drag와 Detach/Backlink는
	 * 이 판별 경계 밖에 둔다.
	 */
	const isTaskScopeOwnedDescendantOccurrence = (nodeId: string): boolean => {
		const visited = new Set<string>();
		let parentId = currentLogicalParentByChild.get(nodeId);

		while (parentId && !visited.has(parentId)) {
			if (currentTaskScopeBoundaryNodeIds.has(parentId)) {
				return true;
			}
			visited.add(parentId);
			parentId = currentLogicalParentByChild.get(parentId);
		}
		return false;
	};
	/**
	 * Graph parent drag는 기존 visible/logical subtree를 유지하되, 다른 Task
	 * Scope가 위치를 소유한 descendant occurrence부터는 이동 경계를 끊는다.
	 * 잡은 Root 자체가 Scope-bound인 경우에는 Root와 자신의 일반 subtree를
	 * 계속 이동하고, 그 아래 별도 Scope boundary만 고정한다.
	 */
	const resolveGraphDragSubtreeNodeIds = (
		rootNodeId: string,
		visibleSubtreeNodeIds: ReadonlySet<string>,
	): ReadonlySet<string> => {
		const nodeIds = new Set([
			...visibleSubtreeNodeIds,
			...collectGraphLogicalSubtreeNodeIds(
				rootNodeId,
				currentLogicalParentByChild,
			),
		]);

		for (const boundaryNodeId of currentTaskScopeBoundaryNodeIds) {
			if (boundaryNodeId === rootNodeId || !nodeIds.has(boundaryNodeId)) {
				continue;
			}
			for (const nodeId of collectGraphLayoutSubtreeNodeIds(
				currentLayout,
				boundaryNodeId,
			)) {
				nodeIds.delete(nodeId);
			}
			for (const nodeId of collectGraphLogicalSubtreeNodeIds(
				boundaryNodeId,
				currentLogicalParentByChild,
			)) {
				nodeIds.delete(nodeId);
			}
		}

		nodeIds.add(rootNodeId);
		return nodeIds;
	};
	const initialLayout = currentLayout;

	renderer = initializeGraphRenderer(
		edgeLayer,
		nodeLayer,
		initialLayout,
		state,
		{
			onFolderClick: (folderId) => {
				state.toggleFolder(folderId);
			},
			onFileOpenRequest: (fileId) => {
				interactions.onFileOpenRequest?.(fileId);
			},
			onDetachDrop: handleDetachDrop,
			onBacklinkClick: handleBacklinkClick,
			onRootContextClick: handleRootContextClick,
			onDetachedRootDuplicate: handleDetachedRootDuplicate,
			onDetachedRootDelete: handleDetachedRootDelete,
			onRootReattach: handleRootReattach,
			onNodeArrangementChange: handleNodeArrangementChange,
			canStartNodeBodyDrag: (nodeId) => (
				!isTaskScopeOwnedDescendantOccurrence(nodeId)
			),
			resolveNodeSubtreeIds: resolveGraphDragSubtreeNodeIds,
			resolveRootId: (rootNodeId) => currentGraph.roots.find(
				(root) => getGraphRootLayoutNodeId(root) === rootNodeId,
			)?.id,
			onSourceDragMove: (request) => handleGraphSourceDragMove(request),
			onSourceDrop: (request) => handleGraphSourceDrop(request),
			onSourceDragCancel: () => handleGraphSourceDragCancel(),
		},
		{
			nodeEffects,
			agentActivityBindings,
			gitDecorations: runtimeOptions.gitDecorations,
		},
	);
	const resolveTaskGraphTargetAreaCollapsed = (
		taskId: string,
		nodeId: string,
		area: TaskGraphTargetAreaKind,
	): boolean => !expandedTaskGraphScopeAreaKeys.has(
		createTaskGraphScopeAreaKey(taskId, nodeId, area),
	);
	let currentTaskLayout = createTaskGraphLayout(
		taskState.getSnapshot().tasks,
		{ resolveGraphTargetAreaCollapsed: resolveTaskGraphTargetAreaCollapsed },
	);
	const taskExecutionByTaskId = new Map<string, TaskExecutionSnapshot>();
	const isTaskExecutionRunning = (taskId: string): boolean => {
		const snapshot = taskExecutionByTaskId.get(taskId);
		return snapshot !== undefined && isTaskExecutionActive(snapshot);
	};
	const clearTaskExecutionActivities = (snapshot: TaskExecutionSnapshot): void => {
		const taskSessionId = createTaskExecutionActivitySessionId(
			snapshot.executionId,
			snapshot.startNodeId,
		);

		runtimeOptions.agentActivityStore?.clearAgentActivitiesBySession(
			taskSessionId,
		);
		runtimeOptions.agentSessionPresentationStore?.endSession(taskSessionId);
		taskActivityKindsBySessionId.delete(taskSessionId);
		for (const { nodeId } of snapshot.works) {
			const assignmentKey = createTaskWorkAgentSessionKey(
				snapshot.executionId,
				nodeId,
			);
			const assignedSession = taskWorkAgentSessions.get(assignmentKey);

			if (assignedSession) {
				runtimeOptions.agentActivityStore?.clearAgentActivitiesBySession(
					assignedSession.actualSessionId,
				);
				runtimeOptions.agentSessionPresentationStore?.endSession(
					assignedSession.actualSessionId,
				);
				taskActivityKindsBySessionId.delete(assignedSession.actualSessionId);
			}
			taskWorkAgentSessions.delete(assignmentKey);
		}
	};
	const createTaskAgentSessionCleanupTarget = (
		snapshot: TaskExecutionSnapshot,
		workNodeId: string,
		actualSessionId: string,
	): TaskAgentSessionCleanupTarget | undefined => {
		const presentation = runtimeOptions.agentSessionPresentationStore?.getSession(
			actualSessionId,
		);

		return presentation === undefined
			? undefined
			: Object.freeze({
				executionId: snapshot.executionId,
				workNodeId,
				sessionId: actualSessionId,
				tabId: presentation.tabId,
			});
	};
	const requestTaskAgentSessionCleanup = (
		targets: readonly TaskAgentSessionCleanupTarget[],
	): void => {
		if (targets.length === 0) {
			return;
		}
		try {
			interactions.onTaskAgentSessionCleanupRequest?.(
				Object.freeze([...targets]),
			);
		} catch {
			/** 탭 UI 정리 실패가 Task-owned runtime 표시의 로컬 삭제를 막지 않는다. */
		}
	};
	const collectTaskWorkAgentSessionAssignments = (
		snapshot: TaskExecutionSnapshot,
	) => snapshot.works.flatMap(({ nodeId }) => {
		const assignmentKey = createTaskWorkAgentSessionKey(
			snapshot.executionId,
			nodeId,
		);
		const assignment = taskWorkAgentSessions.get(assignmentKey);

		return assignment === undefined
			? []
			: [{ assignmentKey, nodeId, assignment }];
	});
	/**
	 * Task 전체 완료 알림 삭제와 실행 중 Stop이 공유하는 exact session 정리다.
	 * 상위 callback을 먼저 호출해 실제 탭/프로세스 정리를 시작한 뒤 로컬 표시를 해제한다.
	 */
	const cleanupTaskExecutionAgentSessions = (
		snapshot: TaskExecutionSnapshot,
	): void => {
		const assignedSessions = collectTaskWorkAgentSessionAssignments(snapshot);

		requestTaskAgentSessionCleanup(assignedSessions.flatMap(({
			nodeId,
			assignment,
		}) => {
			const target = createTaskAgentSessionCleanupTarget(
				snapshot,
				nodeId,
				assignment.actualSessionId,
			);

			return target === undefined ? [] : [target];
		}));

		const taskSessionId = createTaskExecutionActivitySessionId(
			snapshot.executionId,
			snapshot.startNodeId,
		);

		runtimeOptions.agentActivityStore?.clearAgentActivitiesBySession(taskSessionId);
		runtimeOptions.agentSessionPresentationStore?.endSession(taskSessionId);
		for (const { assignmentKey, assignment } of assignedSessions) {
			runtimeOptions.agentActivityStore?.clearAgentActivitiesBySession(
				assignment.actualSessionId,
			);
			runtimeOptions.agentSessionPresentationStore?.endSession(
				assignment.actualSessionId,
			);
			taskActivityKindsBySessionId.delete(assignment.actualSessionId);
			taskWorkAgentSessions.delete(assignmentKey);
		}
	};
	const dismissTaskCompletionActivity = (
		entry: AgentActivityNotificationEntry,
	): boolean => {
		if (entry.activity !== 'completed') {
			return false;
		}

		if (entry.dismissalScope === 'session') {
			const snapshot = [...taskExecutionByTaskId.values()].find((candidate) => (
				candidate.state === 'completed'
				&& entry.sessionId === createTaskExecutionActivitySessionId(
					candidate.executionId,
					candidate.startNodeId,
				)
			));
			if (!snapshot) {
				return false;
			}

			cleanupTaskExecutionAgentSessions(snapshot);
			return true;
		}

		if (entry.target.rootId !== undefined) {
			return false;
		}
		for (const snapshot of taskExecutionByTaskId.values()) {
			const work = snapshot.works.find(({ nodeId, state }) => (
				nodeId === entry.target.nodeId && state === 'completed'
			));
			if (!work) {
				continue;
			}
			const assignmentKey = createTaskWorkAgentSessionKey(
				snapshot.executionId,
				work.nodeId,
			);
			const assignment = taskWorkAgentSessions.get(assignmentKey);
			if (assignment?.actualSessionId !== entry.sessionId) {
				continue;
			}
			const target = createTaskAgentSessionCleanupTarget(
				snapshot,
				work.nodeId,
				assignment.actualSessionId,
			);

			requestTaskAgentSessionCleanup(target === undefined ? [] : [target]);
			runtimeOptions.agentActivityStore?.clearAgentActivitiesBySession(
				assignment.actualSessionId,
			);
			runtimeOptions.agentSessionPresentationStore?.endSession(
				assignment.actualSessionId,
			);
			taskActivityKindsBySessionId.delete(assignment.actualSessionId);
			taskWorkAgentSessions.delete(assignmentKey);
			return true;
		}

		return false;
	};
	const publishTaskExecutionActivity = (
		executionId: string,
		sessionNodeId: string,
		targetNodeId: string,
		title: string,
		activity: 'planned' | 'active' | 'editing' | 'completed' | 'rejected',
		message: string,
	): void => {
		const store = runtimeOptions.agentActivityStore;
		const presentations = runtimeOptions.agentSessionPresentationStore;
		if (!store || !presentations) {
			return;
		}
		const sessionId = createTaskExecutionActivitySessionId(
			executionId,
			sessionNodeId,
		);
		const tabId = createTaskExecutionActivityTabId(
			executionId,
			sessionNodeId,
		);
		if (!presentations.isKnownSession(sessionId)) {
			presentations.activateSession(
				tabId,
				sessionId,
				title,
			);
		}
		presentations.updateCurrentMessage(tabId, sessionId, message);
		const activityKindsByTarget = taskActivityKindsBySessionId.get(sessionId)
			?? new Map();

		if (activityKindsByTarget.get(targetNodeId) === activity) {
			return;
		}
		activityKindsByTarget.set(targetNodeId, activity);
		taskActivityKindsBySessionId.set(sessionId, activityKindsByTarget);
		store.setAgentActivity(sessionId, { nodeId: targetNodeId }, activity);
	};
	const publishTaskWorkAgentActivity = (
		sessionId: string,
		targetNodeId: string,
		activity: 'planned' | 'active' | 'completed' | 'rejected',
	): void => {
		const store = runtimeOptions.agentActivityStore;
		const presentations = runtimeOptions.agentSessionPresentationStore;

		if (!store || !presentations?.isRunningSession(sessionId)) {
			return;
		}
		if (activity === 'completed' || activity === 'rejected') {
			for (const targetSnapshot of store.getSnapshot()) {
				if (
					targetSnapshot.target.nodeId === targetNodeId
					&& targetSnapshot.target.rootId === undefined
				) {
					continue;
				}
				if (targetSnapshot.activities.some((entry) => (
					entry.sessionId === sessionId
				))) {
					store.clearAgentActivity(sessionId, targetSnapshot.target);
				}
			}
		}
		const activityKindsByTarget = taskActivityKindsBySessionId.get(sessionId)
			?? new Map();

		if (activityKindsByTarget.get(targetNodeId) === activity) {
			return;
		}
		activityKindsByTarget.set(targetNodeId, activity);
		taskActivityKindsBySessionId.set(sessionId, activityKindsByTarget);
		store.setAgentActivity(sessionId, { nodeId: targetNodeId }, activity);
	};
	const syncTaskExecutionActivities = (snapshot: TaskExecutionSnapshot): void => {
		const record = taskState.getWorkspaceTask(snapshot.taskId);
		const taskTitle = record?.task.title ?? 'Task';
		for (const work of snapshot.works) {
			const assignedSession = taskWorkAgentSessions.get(
				createTaskWorkAgentSessionKey(
					snapshot.executionId,
					work.nodeId,
				),
			);
			if (!assignedSession) {
				continue;
			}
			const activity = work.state === 'starting'
				? 'planned'
				: work.state === 'running' || work.state === 'waiting-approval'
					? 'active'
					: work.state === 'completed'
						? 'completed'
						: work.state === 'rejected'
							|| work.state === 'failed'
							|| work.state === 'blocked'
							? 'rejected'
							: undefined;
			if (!activity) {
				continue;
			}
			publishTaskWorkAgentActivity(
				assignedSession.actualSessionId,
				work.nodeId,
				activity,
			);
		}

		if (snapshot.state === 'completed') {
			for (const targetNodeId of [
				snapshot.startNodeId,
				...snapshot.works.map(({ nodeId }) => nodeId),
				snapshot.endNodeId,
			]) {
				publishTaskExecutionActivity(
					snapshot.executionId,
					snapshot.startNodeId,
					targetNodeId,
					taskTitle,
					'completed',
					'Task의 모든 Work가 완료되었습니다.',
				);
			}
			return;
		}

		publishTaskExecutionActivity(
			snapshot.executionId,
			snapshot.startNodeId,
			snapshot.startNodeId,
			taskTitle,
			snapshot.state === 'running' ? 'editing' : 'rejected',
			snapshot.state === 'running'
				? 'Task 실행을 시작했습니다.'
				: 'Task 실행이 중단되었습니다.',
		);
	};
	let focusedTaskNode: FocusedTaskNode | undefined;
	let taskInspector: ReturnType<typeof initializeTaskInspector> | undefined;
	const findFocusedTaskLayoutNode = (): TaskLayoutNode | undefined => (
		focusedTaskNode
			? currentTaskLayout.nodes.find((node) => (
				node.taskId === focusedTaskNode?.taskId
				&& node.id === focusedTaskNode.nodeId
				&& (node.kind === 'start' || node.kind === 'work')
			))
			: undefined
	);
	const syncTaskInspector = (): void => {
		const focusedTaskId = focusedTaskNode?.taskId;

		taskInspector?.apply(
			focusedTaskNode,
			currentTaskLayout,
			focusedTaskId
				? {
					options: createTaskWorkspaceRootOptions(workspaceGraph),
					ownerRootId: taskState.getWorkspaceTask(
						focusedTaskId,
					)?.ownerRootId,
				}
				: undefined,
		);
	};
	const clearTaskFocus = (): void => {
		if (!focusedTaskNode) {
			return;
		}

		focusedTaskNode = undefined;
		syncTaskInspector();
	};
	const collectTaskGraphScopeBindings = (): TaskGraphScopeBinding[] => {
		const bindings: TaskGraphScopeBinding[] = [];

		for (const task of taskState.getSnapshot().tasks) {
			for (const node of task.nodes) {
				if (node.kind === 'end') {
					continue;
				}
				const graphTargets = node.kind === 'start'
					? task.defaultGraphTargets
					: node.graphTargets;

				for (const area of ['reference', 'work'] as const) {
					for (const sourceId of graphTargets[area]) {
						bindings.push({
							taskId: task.id,
							nodeId: node.id,
							area,
							sourceId,
						});
					}
				}
			}
		}
		return bindings;
	};
	const collectTaskGraphScopeOccurrenceIds = (): Set<string> => new Set(
		[...taskScopeOccurrencesByBinding.values()].flatMap(
			(occurrenceIds) => [...occurrenceIds],
		),
	);
	const findTaskGraphScopeBindingForOccurrence = (
		occurrenceNodeId: string,
		bindings: readonly TaskGraphScopeBinding[] = collectTaskGraphScopeBindings(),
	): TaskGraphScopeBinding | undefined => {
		const bindingsByKey = new Map(bindings.map((binding) => [
			createTaskGraphScopeBindingKey(binding),
			binding,
		]));

		for (const [bindingKey, occurrenceIds] of taskScopeOccurrencesByBinding) {
			if (occurrenceIds.has(occurrenceNodeId)) {
				const binding = bindingsByKey.get(bindingKey);

				if (binding) {
					return binding;
				}
			}
		}
		return undefined;
	};
	const addTaskGraphScopeOccurrence = (
		binding: TaskGraphScopeBinding,
		occurrenceNodeId: string,
	): void => {
		const key = createTaskGraphScopeBindingKey(binding);
		const occurrenceIds = new Set(taskScopeOccurrencesByBinding.get(key));

		occurrenceIds.add(occurrenceNodeId);
		taskScopeOccurrencesByBinding.set(key, occurrenceIds);
	};
	const removeTaskGraphScopeOccurrence = (
		binding: TaskGraphScopeBinding,
		occurrenceNodeId: string,
	): void => {
		const key = createTaskGraphScopeBindingKey(binding);
		const occurrenceIds = new Set(taskScopeOccurrencesByBinding.get(key));

		occurrenceIds.delete(occurrenceNodeId);
		if (occurrenceIds.size === 0) {
			taskScopeOccurrencesByBinding.delete(key);
		} else {
			taskScopeOccurrencesByBinding.set(key, occurrenceIds);
		}
	};
	/** 현재 Layout에 실제 Card로 존재하는 Folder/standalone File occurrence만 해석한다. */
	const resolveVisibleTaskGraphScopeOccurrenceSourceId = (
		occurrenceNodeId: string,
	): string | undefined => {
		const node = currentLayout.nodes.find(
			(candidate) => candidate.id === occurrenceNodeId,
		);

		if (node?.kind === 'folder') {
			return getGraphLayoutSourceId(node.id);
		}
		if (
			node?.kind === 'file-group'
			&& node.presentation === 'standalone'
			&& node.children[0]?.presentation === 'normal'
		) {
			return getGraphLayoutSourceId(node.children[0].id);
		}
		return undefined;
	};
	/** 현재 Graph Root topology에서 Source를 실제로 소유하는 occurrence 주소다. */
	const resolveTaskGraphScopeTopologyOccurrenceId = (
		sourceId: string,
	): string | undefined => {
		const location = findGraphNode(currentGraph, sourceId);

		return location && location.node.kind !== 'project'
			? createGraphLayoutNodeId(location.root.id, sourceId)
			: undefined;
	};
	/** Collapse로 DOM이 잠시 사라져도 같은 visual occurrence 주소인지 보존한다. */
	const isKnownTaskGraphScopeOccurrence = (
		occurrenceNodeId: string,
		sourceId: string,
	): boolean => {
		if (getGraphLayoutSourceId(occurrenceNodeId) !== sourceId) {
			return false;
		}
		const occurrenceRootId = getGraphLayoutRootId(occurrenceNodeId);

		return occurrenceRootId
			? taskGraphTargetIndex.has(sourceId)
				&& currentGraph.roots.some((root) => root.id === occurrenceRootId)
			: resolveTaskGraphScopeTopologyOccurrenceId(sourceId)
				=== occurrenceNodeId;
	};
	const findAvailableScopeOccurrence = (
		sourceId: string,
		claimedOccurrenceIds: ReadonlySet<string>,
	): string | undefined => {
		for (const node of currentLayout.nodes) {
			const occurrenceNodeId = node.id;

			if (
				!claimedOccurrenceIds.has(occurrenceNodeId)
				&& resolveVisibleTaskGraphScopeOccurrenceSourceId(occurrenceNodeId)
					=== sourceId
			) {
				return occurrenceNodeId;
			}
		}
		return undefined;
	};
	const reconcileTaskGraphScopeOccurrences = (
		bindings: readonly TaskGraphScopeBinding[],
	): boolean => {
		const activeKeys = new Set(bindings.map((binding) => (
			createTaskGraphScopeBindingKey(binding)
		)));

		for (const key of [...taskScopeOccurrencesByBinding.keys()]) {
			if (!activeKeys.has(key)) {
				taskScopeOccurrencesByBinding.delete(key);
			}
		}
		const claimedOccurrenceIds = new Set<string>();

		// 명시적으로 Drop된 occurrence 집합을 먼저 보존한다. 그래야 앞선
		// unresolved binding이 뒤 binding의 실제 occurrence를 빼앗지 않는다.
		for (const binding of bindings) {
			const key = createTaskGraphScopeBindingKey(binding);
			const validOccurrenceIds = new Set<string>();

			for (const occurrenceNodeId of taskScopeOccurrencesByBinding.get(key) ?? []) {
				if (
					!claimedOccurrenceIds.has(occurrenceNodeId)
					&& isKnownTaskGraphScopeOccurrence(
						occurrenceNodeId,
						binding.sourceId,
					)
				) {
					validOccurrenceIds.add(occurrenceNodeId);
					claimedOccurrenceIds.add(occurrenceNodeId);
				}
			}
			if (validOccurrenceIds.size > 0) {
				taskScopeOccurrencesByBinding.set(key, validOccurrenceIds);
			} else {
				taskScopeOccurrencesByBinding.delete(key);
			}
		}

		// 저장된 semantic binding에는 occurrence 주소가 없으므로, 소유 occurrence가
		// 하나도 없는 binding에만 현재 Graph의 가용 occurrence 하나를 배정한다.
		for (const binding of bindings) {
			const key = createTaskGraphScopeBindingKey(binding);

			if ((taskScopeOccurrencesByBinding.get(key)?.size ?? 0) > 0) {
				continue;
			}
			let occurrenceNodeId: string | undefined;

			if (!occurrenceNodeId && taskGraphTargetIndex.has(binding.sourceId)) {
				occurrenceNodeId = findAvailableScopeOccurrence(
					binding.sourceId,
					claimedOccurrenceIds,
				);
			}
			if (!occurrenceNodeId && taskGraphTargetIndex.has(binding.sourceId)) {
				// 닫힌 ancestor 아래 Target과 grouped File Row도 현재 owning Root의
				// occurrence 주소를 pin해 Layout 재생성에서 실제 Card로 복구한다.
				const topologyOccurrenceNodeId =
					resolveTaskGraphScopeTopologyOccurrenceId(binding.sourceId);

				if (
					topologyOccurrenceNodeId
					&& !claimedOccurrenceIds.has(topologyOccurrenceNodeId)
				) {
					occurrenceNodeId = topologyOccurrenceNodeId;
				}
			}
			if (occurrenceNodeId) {
				taskScopeOccurrencesByBinding.set(
					key,
					new Set([occurrenceNodeId]),
				);
				claimedOccurrenceIds.add(occurrenceNodeId);
			}
		}
		const nextBoundaryNodeIds = collectTaskGraphScopeOccurrenceIds();
		const scopeBoundariesChanged = (
			nextBoundaryNodeIds.size !== currentTaskScopeBoundaryNodeIds.size
			|| [...nextBoundaryNodeIds].some(
				(nodeId) => !currentTaskScopeBoundaryNodeIds.has(nodeId),
			)
		);

		currentTaskScopeBoundaryNodeIds = nextBoundaryNodeIds;
		// Persisted Scope 좌표는 초기 arrangement 분류에서 manual로 보일 수 있다.
		// 활성 Scope boundary가 provenance를 인수하되, 실제 Detached Root는
		// binding이 사라져도 독립 occurrence여야 하므로 manual 상태를 보존한다.
		for (const occurrenceNodeId of nextBoundaryNodeIds) {
			const occurrenceRootId = getGraphLayoutRootId(occurrenceNodeId);

			if (!occurrenceRootId || !isDetachedRootId(occurrenceRootId)) {
				currentManualUnarrangedNodeIds.delete(occurrenceNodeId);
			}
		}
		return scopeBoundariesChanged;
	};
	const createCurrentTaskGraphScopeLayouts = (
		layout: TaskGraphLayout,
		graphLayout: GraphLayout,
		graphNodePositions: GraphStateSnapshot['nodePositions'],
	): Map<string, TaskGraphScopeLayout> => {
		const scopeLayouts = new Map<string, TaskGraphScopeLayout>();
		const scopeBoundaryNodeIds = collectTaskGraphScopeOccurrenceIds();
		const boundsGraphLayout = createTaskScopeBoundsGraphLayout(graphLayout);

		for (const node of layout.nodes) {
			if (!isTaskGraphScopeLayoutNode(node)) {
				continue;
			}
			for (const area of ['reference', 'work'] as const) {
				const sourceIds = sortTaskGraphTargetIds(
					taskGraphTargetIndex,
					node.scopeAreas[area].sourceIds,
				);
				const inputs = sourceIds.flatMap((sourceId) => {
					const binding: TaskGraphScopeBinding = {
						taskId: node.taskId,
						nodeId: node.id,
						area,
						sourceId,
					};

					return [...(
						taskScopeOccurrencesByBinding.get(
							createTaskGraphScopeBindingKey(binding),
						) ?? []
					)].map((occurrenceNodeId) => ({ sourceId, occurrenceNodeId }));
				});

				scopeLayouts.set(
					createTaskGraphScopeAreaKey(node.taskId, node.id, area),
					createTaskGraphScopeLayout(
						boundsGraphLayout,
						graphNodePositions,
						inputs,
						scopeBoundaryNodeIds,
					),
				);
			}
		}
		return scopeLayouts;
	};
	const projectTaskGraphScopeNodePositions = (
		graphLayout: GraphLayout,
		graphNodePositions: GraphStateSnapshot['nodePositions'],
		layout: TaskGraphLayout,
		scopeLayouts: ReadonlyMap<string, TaskGraphScopeLayout>,
	): {
		readonly nodePositions: GraphStateSnapshot['nodePositions'];
		readonly changed: boolean;
	} => {
		const nodePositions = { ...graphNodePositions };
		const scopeBoundaryNodeIds = collectTaskGraphScopeOccurrenceIds();
		let changed = false;

		for (const node of layout.nodes) {
			if (!isTaskGraphScopeLayoutNode(node)) {
				continue;
			}
			for (const area of ['reference', 'work'] as const) {
				const scopeLayout = scopeLayouts.get(
					createTaskGraphScopeAreaKey(node.taskId, node.id, area),
				);

				if (!scopeLayout) {
					continue;
				}
				const targetPositions = new Map(createTaskGraphScopeNodePositions(
					node.scopeAreas[area],
					scopeLayout,
				));

				for (const occurrence of scopeLayout.occurrences) {
					const targetRootPosition = targetPositions.get(
						occurrence.occurrenceNodeId,
					);

					if (!targetRootPosition) {
						continue;
					}
					translateScopeLogicalSubtreePositions(
						graphLayout,
						graphNodePositions,
						targetPositions,
						occurrence.occurrenceNodeId,
						targetRootPosition,
						scopeBoundaryNodeIds,
					);
				}

				for (const [nodeId, position] of targetPositions) {
					const previous = nodePositions[nodeId];

					if (previous?.x === position.x && previous.y === position.y) {
						continue;
					}
					nodePositions[nodeId] = position;
					changed = true;
				}
			}
		}
		return { nodePositions, changed };
	};
	/**
	 * Task Region geometry와 실제 Graph occurrence의 최종 World 좌표를 같은
	 * 입력 Layout에서 계산한다. Graph DOM/Edge 생성은 계속 GraphRenderer 소유다.
	 */
	const applyTaskGraphScopeProjection = (
		graphLayout: GraphLayout,
		graphNodePositions: GraphStateSnapshot['nodePositions'],
	): {
		readonly nodePositions: GraphStateSnapshot['nodePositions'];
		readonly changed: boolean;
	} => {
		const tasks = taskState.getSnapshot().tasks;
		const provisionalLayout = createTaskGraphLayout(tasks, {
			resolveGraphTargetAreaCollapsed: resolveTaskGraphTargetAreaCollapsed,
		});
		const scopeLayouts = createCurrentTaskGraphScopeLayouts(
			provisionalLayout,
			graphLayout,
			graphNodePositions,
		);
		const scopeSizeOptions = {
			resolveGraphTargetAreaCollapsed: resolveTaskGraphTargetAreaCollapsed,
			resolveGraphTargetAreaSize: (taskId, nodeId, area) => {
				const scopeLayout = scopeLayouts.get(
					createTaskGraphScopeAreaKey(taskId, nodeId, area),
				);

				return scopeLayout
					? { width: scopeLayout.width, height: scopeLayout.height }
					: undefined;
			},
		} satisfies Parameters<typeof createTaskGraphLayout>[1];
		const nextLayout = createTaskGraphLayout(tasks, scopeSizeOptions);

		const projection = projectTaskGraphScopeNodePositions(
			graphLayout,
			graphNodePositions,
			nextLayout,
			scopeLayouts,
		);

		currentTaskLayout = nextLayout;
		taskRenderer.applyLayout(currentTaskLayout);
		if (focusedTaskNode && !findFocusedTaskLayoutNode()) {
			focusedTaskNode = undefined;
		}
		syncTaskInspector();
		return projection;
	};
	const applyTaskState = (
		{ animateGraphScopeNodes = true }: {
			readonly animateGraphScopeNodes?: boolean;
		} = {},
	): void => {
		if (disposed || applyingTaskState) {
			return;
		}
		applyingTaskState = true;
		try {
			reconcileExpandedTaskGraphScopeAreas();
			const bindings = collectTaskGraphScopeBindings();
			const scopeBoundariesChanged = reconcileTaskGraphScopeOccurrences(bindings);
			const snapshot = state.getState();
			let graphNodePositions: Record<string, GraphLayoutPosition> = {
				...persistentNodePositions,
			};

			if (scopeBoundariesChanged) {
				const previousLayout = currentLayout;
				const nextLayout = createLayout(
					currentGraph,
					snapshot,
					currentManualUnarrangedNodeIds,
				);
				graphNodePositions = rebaseNodePositions(
					previousLayout,
					nextLayout,
					persistentNodePositions,
					{ logicalParentByChild: currentLogicalParentByChild },
				);
				const nextNodeIds = new Set(nextLayout.nodes.map((node) => node.id));

				for (const previousNode of previousLayout.nodes) {
					if (
						!nextNodeIds.has(previousNode.id)
						&& !currentManualUnarrangedNodeIds.has(previousNode.id)
						&& !currentTaskScopeBoundaryNodeIds.has(previousNode.id)
					) {
						// Scope를 떠난 standalone File은 원래 grouped Row로 돌아가며
						// 더 이상 독립 World 좌표를 소유하지 않는다.
						delete graphNodePositions[previousNode.id];
					}
				}
				currentLayout = nextLayout;
			}
			const projection = applyTaskGraphScopeProjection(
				currentLayout,
				graphNodePositions,
			);

			if (scopeBoundariesChanged || projection.changed) {
				// Discrete Scope 변경은 기존 GraphRenderer의 220ms Layout
				// transition을 그대로 사용한다. State를 먼저 쓰면 Renderer의
				// stored-position 구독이 transition을 즉시 완료한다.
				if (scopeBoundariesChanged) {
					applyGraphLayout(
						renderer,
						navigator,
						currentLayout,
						projection.nodePositions,
						{ animate: animateGraphScopeNodes },
					);
				} else if (animateGraphScopeNodes) {
					renderer.applyLayout(currentLayout, projection.nodePositions);
				}
				commitRuntimeGraphState(
					{
						camera: snapshot.camera,
						nodePositions: projection.nodePositions,
					},
					{
						...(scopeBoundariesChanged
							? { baseNodePositions: graphNodePositions }
							: {}),
						projectionOnly: !scopeBoundariesChanged,
					},
				);
			}
		} finally {
			applyingTaskState = false;
		}
	};
	const updateTaskGraphTargetMemberships = (
		changes: readonly {
			readonly binding: TaskGraphScopeBinding;
			readonly included: boolean;
		}[],
	): boolean => {
		const effectiveChanges = [...new Map(changes.map((change) => [
			createTaskGraphScopeBindingKey(change.binding),
			change,
		])).values()];

		for (const { binding } of effectiveChanges) {
			const task = taskState.getTask(binding.taskId);
			const scopeOwner = task?.nodes.find((node) => node.id === binding.nodeId);

			if (!scopeOwner || scopeOwner.kind === 'end') {
				return false;
			}
		}
		const membershipChanges = effectiveChanges.map(({ binding, included }) => {
			const record = taskState.getWorkspaceTask(binding.taskId);
			const previousOrigin = record?.targetOrigins.find((origin) => (
				origin.nodeId === binding.nodeId
				&& origin.area === binding.area
				&& origin.sourceId === binding.sourceId
			));
			const sourceRootId = taskGraphTargetIndex.get(
				binding.sourceId,
			)?.sourceRootId
				?? previousOrigin?.sourceRootId
				?? record?.ownerRootId;

			return sourceRootId
				? [{
					taskId: binding.taskId,
					nodeId: binding.nodeId,
					area: binding.area,
					sourceId: binding.sourceId,
					sourceRootId,
					included,
				}]
				: [];
		}).flat();

		return membershipChanges.length === effectiveChanges.length
			&& taskState.updateGraphTargetMemberships(membershipChanges) !== undefined;
	};
	function removeTaskGraphScopeBindingsForOccurrence(
		occurrenceNodeId: string,
	): boolean {
		const bindings = collectTaskGraphScopeBindings().filter((binding) => (
			taskScopeOccurrencesByBinding.get(
				createTaskGraphScopeBindingKey(binding),
			)?.has(occurrenceNodeId) === true
		));
		const removedMemberships = bindings.filter((binding) => (
			taskScopeOccurrencesByBinding.get(
				createTaskGraphScopeBindingKey(binding),
			)?.size === 1
		));

		if (!updateTaskGraphTargetMemberships(removedMemberships.map((binding) => ({
			binding,
			included: false,
		})))) {
			return false;
		}
		for (const binding of bindings) {
			removeTaskGraphScopeOccurrence(binding, occurrenceNodeId);
		}
		return true;
	}
	const translateScopeLogicalSubtreePositions = (
		graphLayout: GraphLayout,
		snapshotPositions: Readonly<Record<string, GraphLayoutPosition | undefined>>,
		outputPositions: Map<string, GraphLayoutPosition>,
		occurrenceNodeId: string,
		targetRootPosition: GraphLayoutPosition,
		scopeBoundaryNodeIds: ReadonlySet<string> = new Set(),
	): void => {
		const rootNode = graphLayout.nodes.find(
			(node) => node.id === occurrenceNodeId,
		);

		if (!rootNode) {
			return;
		}
		const currentRootPosition = resolveGraphLayoutNodePosition(
			rootNode,
			snapshotPositions,
		);
		const delta = {
			x: targetRootPosition.x - currentRootPosition.x,
			y: targetRootPosition.y - currentRootPosition.y,
		};

		const subtreeNodeIds = collectGraphLogicalSubtreeNodeIds(
			occurrenceNodeId,
			currentLogicalParentByChild,
		);
		const excludedNodeIds = new Set<string>();

		for (const boundaryNodeId of scopeBoundaryNodeIds) {
			if (
				boundaryNodeId === occurrenceNodeId
				|| !subtreeNodeIds.has(boundaryNodeId)
			) {
				continue;
			}
			for (const nodeId of collectGraphLogicalSubtreeNodeIds(
				boundaryNodeId,
				currentLogicalParentByChild,
			)) {
				excludedNodeIds.add(nodeId);
			}
		}

		for (const nodeId of subtreeNodeIds) {
			if (excludedNodeIds.has(nodeId)) {
				continue;
			}
			if (outputPositions.has(nodeId)) {
				continue;
			}
			const node = graphLayout.nodes.find((candidate) => candidate.id === nodeId);
			const currentPosition = snapshotPositions[nodeId]
				?? (node
					? resolveGraphLayoutNodePosition(node, snapshotPositions)
					: undefined);

			if (currentPosition) {
				outputPositions.set(nodeId, {
					x: currentPosition.x + delta.x,
					y: currentPosition.y + delta.y,
				});
			}
		}
	};
	const translateScopeOccurrenceTo = (
		occurrenceNodeId: string,
		targetPosition: GraphLayoutPosition,
		scopeBoundaryNodeIds: ReadonlySet<string> = new Set(),
	): void => {
		const snapshot = state.getState();
		const nodePositions = { ...persistentNodePositions };
		const translatedPositions = new Map<string, GraphLayoutPosition>();

		translateScopeLogicalSubtreePositions(
			currentLayout,
			snapshot.nodePositions,
			translatedPositions,
			occurrenceNodeId,
			targetPosition,
			scopeBoundaryNodeIds,
		);
		for (const [nodeId, position] of translatedPositions) {
			nodePositions[nodeId] = position;
		}
		commitRuntimeGraphState(
			{ camera: snapshot.camera, nodePositions },
			{ baseNodePositions: nodePositions },
		);
	};
	handleGraphSourceDragMove = ({
		sourceNodeId,
		clientX,
		clientY,
	}): void => {
		if (disposed || !taskGraphTargetIndex.has(sourceNodeId)) {
			taskRenderer.clearGraphTargetDrag();
			return;
		}
		taskRenderer.updateGraphTargetDrag({ x: clientX, y: clientY });
	};
	handleGraphSourceDrop = (request): GraphSourceDropResult | false => {
		const {
			sourceNodeId,
			clientX,
			clientY,
		} = request;
		const source = taskGraphTargetIndex.get(sourceNodeId);
		const dropTarget = source
			? taskRenderer.updateGraphTargetDrag({ x: clientX, y: clientY })
			: undefined;
		const existingBinding = findTaskGraphScopeBindingForOccurrence(
			request.occurrenceNodeId,
		);

		taskRenderer.clearGraphTargetDrag();
		if (
			disposed
			|| (existingBinding && isTaskExecutionRunning(existingBinding.taskId))
			|| (dropTarget && isTaskExecutionRunning(dropTarget.taskId))
		) {
			return false;
		}
		if (!dropTarget) {
			const binding = existingBinding;

			if (binding) {
				if (
					request.reattachTargetRootId
					&& request.occurrenceRootId === request.reattachTargetRootId
				) {
					return false;
				}
				const occurrenceCount = taskScopeOccurrencesByBinding.get(
					createTaskGraphScopeBindingKey(binding),
				)?.size ?? 0;

				if (
					occurrenceCount <= 1
					&& !updateTaskGraphTargetMemberships([{
						binding,
						included: false,
					}])
				) {
					return false;
				}
				// Region 밖 실제 Drag는 이 occurrence만 영역에서 제거한다. 같은
				// Source occurrence가 남아 있으면 semantic membership은 유지한다.
				currentManualUnarrangedNodeIds = new Set(
					currentManualUnarrangedNodeIds,
				);
				currentManualUnarrangedNodeIds.add(request.occurrenceNodeId);
				removeTaskGraphScopeOccurrence(
					binding,
					request.occurrenceNodeId,
				);
				if (request.currentPosition) {
					translateScopeOccurrenceTo(
						request.occurrenceNodeId,
						request.currentPosition,
						collectTaskGraphScopeOccurrenceIds(),
					);
				}
				applyTaskState();
				// 원래 File Group 같은 기존 arrangement target은 Scope 해제만
				// 처리한 뒤 Renderer의 실제 standalone → grouped 전환을 계속한다.
				// 그 밖의 Region-out은 이 경로가 최종 World 위치를 소유한다.
				return request.isArrangementTarget
					? false
					: request.currentPosition
						? { targetPosition: request.currentPosition }
						: {};
			}
			return false;
		}
		if (!source) {
			return false;
		}

		const task = taskState.getTask(dropTarget.taskId);
		const scopeOwner = task?.nodes.find((node) => node.id === dropTarget.nodeId);

		if (!task || !scopeOwner || scopeOwner.kind === 'end') {
			return false;
		}

		const targetBinding: TaskGraphScopeBinding = {
			taskId: dropTarget.taskId,
			nodeId: dropTarget.nodeId,
			area: dropTarget.area,
			sourceId: sourceNodeId,
		};
		const originBinding = findTaskGraphScopeBindingForOccurrence(
			request.occurrenceNodeId,
		);
		const alreadyOwnedByDropArea = originBinding
			? isSameTaskGraphScopeAddress(originBinding, targetBinding)
			: false;

		if (alreadyOwnedByDropArea) {
			// 같은 actual occurrence를 같은 Region 안에서 다시 놓는 것은 semantic
			// 변경이 아니다. Drag 중 임시 DOM 위치만 GraphState의 Scope projection
			// 좌표로 되맞춰, binding Root가 수동 정렬처럼 어긋나지 않게 한다.
			return { syncStoredPositions: true };
		}

		const draggedOccurrenceIsActual = isKnownTaskGraphScopeOccurrence(
			request.occurrenceNodeId,
			sourceNodeId,
		);

		if (!draggedOccurrenceIsActual) {
			return false;
		}
		const originOccurrenceCount = originBinding
			? taskScopeOccurrencesByBinding.get(
				createTaskGraphScopeBindingKey(originBinding),
			)?.size ?? 0
			: 0;
		const membershipChanges = [
			...(originBinding && originOccurrenceCount <= 1
				? [{ binding: originBinding, included: false }]
				: []),
			{ binding: targetBinding, included: true },
		];

		if (!updateTaskGraphTargetMemberships(membershipChanges)) {
			return false;
		}
		if (originBinding) {
			removeTaskGraphScopeOccurrence(
				originBinding,
				request.occurrenceNodeId,
			);
		}
		addTaskGraphScopeOccurrence(
			targetBinding,
			request.occurrenceNodeId,
		);
		applyTaskState();
		const occurrenceIds = taskScopeOccurrencesByBinding.get(
			createTaskGraphScopeBindingKey(targetBinding),
		);

		if (!occurrenceIds?.has(request.occurrenceNodeId)) {
			return false;
		}
		// applyTaskState가 Scope boundary를 반영한 실제 occurrence 좌표와 Edge를
		// 기존 GraphRenderer transition에 전달했다. Renderer drag-end가 목표
		// 좌표를 즉시 덮어쓰지 않도록 consumed 신호만 반환한다.
		return {};
	};
	handleGraphSourceDragCancel = (): void => {
		taskRenderer.clearGraphTargetDrag();
	};
	const handleTaskInspectorFieldInput = (
		input: TaskInspectorFieldInput,
	): void => {
		if (
			disposed
			|| isTaskExecutionRunning(input.taskId)
			|| input.taskId !== focusedTaskNode?.taskId
			|| input.nodeId !== focusedTaskNode.nodeId
		) {
			return;
		}

		const task = taskState.getTask(input.taskId);
		const targetNode = task?.nodes.find((node) => node.id === input.nodeId);

		if (!task) {
			return;
		}
		if (input.kind === 'start' && input.field === 'ownerRootId') {
			if (!createTaskWorkspaceRootOptions(workspaceGraph).some(
				(option) => option.value === input.value,
			)) {
				return;
			}
			if (taskState.setOwnerRoot(input.taskId, input.value)) {
				syncTaskInspector();
			}
			return;
		}

		if (input.kind === 'start') {
			if (targetNode?.kind !== 'start') {
				return;
			}
			const currentValue = input.field === 'title'
				? task.title
				: task.description;

			if (currentValue === input.value) {
				return;
			}
		} else {
			if (targetNode?.kind !== 'work' || targetNode[input.field] === input.value) {
				return;
			}
		}

		const updated = taskState.updateTask(input.taskId, (current) => {
			if (input.kind === 'start') {
				return input.field === 'title'
					? { ...current, title: input.value }
					: { ...current, description: input.value };
			}

			return {
				...current,
				nodes: current.nodes.map((node) => (
					node.id === input.nodeId && node.kind === 'work'
						? { ...node, [input.field]: input.value }
						: node
				)),
			};
		});

		if (updated) {
			applyTaskState({ animateGraphScopeNodes: false });
		}
	};
	const handleTaskOriginChange = (taskId: string, origin: TaskOrigin): void => {
		if (isTaskExecutionRunning(taskId)) {
			return;
		}
		const updated = taskState.updateTask(taskId, (task) => ({
			...task,
			origin,
		}));

		if (updated) {
			applyTaskState({ animateGraphScopeNodes: false });
		}
	};
	const handleTaskNodePositionChange = (
		taskId: string,
		nodeId: string,
		position: TaskNodePosition,
	): void => {
		if (isTaskExecutionRunning(taskId)) {
			return;
		}
		if (taskState.setNodePosition(taskId, nodeId, position)) {
			applyTaskState({ animateGraphScopeNodes: false });
		}
	};
	const handleTaskNodeFocus = (node: TaskLayoutNode): void => {
		focusedTaskNode = {
			taskId: node.taskId,
			nodeId: node.id,
		};
		camera.focusOn({
			x: node.position.x + node.width / 2,
			y: node.position.y + node.height / 2,
		});
		syncTaskInspector();
	};
	const handleTaskNodeSelectionChange = (
		node: TaskLayoutNode | undefined,
	): void => {
		if (
			focusedTaskNode
			&& (
				!node
				|| node.taskId !== focusedTaskNode.taskId
				|| node.id !== focusedTaskNode.nodeId
			)
		) {
			clearTaskFocus();
		}
	};
	const handleTaskWorkAdd = (taskId: string): void => {
		if (isTaskExecutionRunning(taskId)) {
			return;
		}
		const previousNodeIds = new Set(
			taskState.getTask(taskId)?.nodes.map((node) => node.id),
		);
		const updatedTask = taskState.addWork(taskId);
		const addedWork = updatedTask?.nodes.find((node) => (
			node.kind === 'work' && !previousNodeIds.has(node.id)
		));

		if (!addedWork) {
			return;
		}

		applyTaskState();
		const addedLayoutNode = currentTaskLayout.nodes.find((node) => (
			node.taskId === taskId
			&& node.id === addedWork.id
			&& node.kind === 'work'
		));

		if (!addedLayoutNode || !taskRenderer.selectNode(taskId, addedWork.id)) {
			return;
		}
		handleTaskNodeFocus(addedLayoutNode);
	};
	const handleTaskExport = (taskId: string): void => {
		const task = taskState.getTask(taskId);

		if (!task) {
			return;
		}
		const result = trySerializeTaskTransfer(task);

		if (result.ok) {
			interactions.onTaskJsonCopyRequest?.(result.json);
		} else {
			interactions.onTaskJsonCopyFailure?.(result.reason);
		}
	};
	const clearTaskGraphScopeAreaExpansion = (taskId: string): void => {
		const prefix = `${taskId}\u0000`;

		for (const key of expandedTaskGraphScopeAreaKeys) {
			if (key.startsWith(prefix)) {
				expandedTaskGraphScopeAreaKeys.delete(key);
			}
		}
	};
	const handleTaskImport = (taskId: string): void => {
		if (isTaskExecutionRunning(taskId)) {
			return;
		}
		const task = taskState.getTask(taskId);
		const startNodeId = task?.nodes.find((node) => node.kind === 'start')?.id;

		if (!task || !startNodeId) {
			return;
		}

		taskImportDialog.open({
			taskTitle: task.title,
			restoreFocus: () => {
				taskRenderer.focusImportAction(taskId, startNodeId);
			},
			onSubmit: (source) => {
				const parsed = parseTaskTransferJson(source);

				if (!parsed.ok) {
					const issue = parsed.issues[0];

					return {
						ok: false,
						message: issue
							? `${issue.path}: ${issue.message}`
							: 'Task JSON을 확인할 수 없습니다.',
					};
				}

				const current = taskState.getTask(taskId);

				if (!current) {
					return {
						ok: false,
						message: '가져올 대상 Task가 더 이상 존재하지 않습니다.',
					};
				}

				try {
					const imported = materializeTaskTransfer(parsed.document, current);
					const updated = taskState.replaceTaskBlueprint(taskId, imported);

					if (!updated) {
						return {
							ok: false,
							message: 'Task를 가져오지 못했습니다.',
						};
					}

					clearTaskGraphScopeAreaExpansion(taskId);
					applyTaskState();
					return { ok: true };
				} catch {
					return {
						ok: false,
						message: 'Task 구조가 올바르지 않아 가져오지 못했습니다.',
					};
				}
			},
		});
	};
	const handleTaskRemove = (taskId: string): void => {
		if (isTaskExecutionRunning(taskId)) {
			return;
		}
		if (taskState.removeTask(taskId)) {
			applyTaskState();
		}
	};
	const handleTaskConnect = (
		sourceTaskId: string,
		sourceNodeId: string,
		targetTaskId: string,
		targetNodeId: string,
	): boolean => {
		if (
			isTaskExecutionRunning(sourceTaskId)
			|| isTaskExecutionRunning(targetTaskId)
		) {
			return false;
		}
		if (taskState.connect(
			sourceTaskId,
			sourceNodeId,
			targetTaskId,
			targetNodeId,
		)) {
			applyTaskState();
			return true;
		}
		return false;
	};
	const handleTaskEdgeDisconnect = (taskId: string, edgeId: string): void => {
		if (isTaskExecutionRunning(taskId)) {
			return;
		}
		if (taskState.disconnect(taskId, edgeId)) {
			applyTaskState();
		}
	};
	const handleTaskWorkRemove = (taskId: string, nodeId: string): void => {
		if (isTaskExecutionRunning(taskId)) {
			return;
		}
		if (taskState.removeWork(taskId, nodeId)) {
			applyTaskState();
		}
	};
	const handleTaskGraphTargetAreaToggle = (
		taskId: string,
		nodeId: string,
		area: TaskGraphTargetAreaKind,
	): void => {
		const task = taskState.getTask(taskId);
		const scopeOwner = task?.nodes.find((node) => node.id === nodeId);
		const graphTargets = scopeOwner?.kind === 'start'
			? task?.defaultGraphTargets
			: scopeOwner?.kind === 'work' ? scopeOwner.graphTargets : undefined;

		if (!graphTargets || graphTargets[area].length > 0) {
			return;
		}
		const key = createTaskGraphScopeAreaKey(taskId, nodeId, area);

		if (expandedTaskGraphScopeAreaKeys.has(key)) {
			expandedTaskGraphScopeAreaKeys.delete(key);
		} else {
			expandedTaskGraphScopeAreaKeys.add(key);
		}
		applyTaskState();
	};
	const handleTaskCreate = (): void => {
		const tasks = taskState.getSnapshot().tasks;
		const ownerRootId = createTaskWorkspaceRootOptions(workspaceGraph)[0]?.value;

		if (!ownerRootId) {
			return;
		}
		taskState.createOwnedTask(ownerRootId, {
			title: `Task ${tasks.length + 1}`,
			origin: createTaskOriginInVisibleArea(
				camera,
				getVisibleGraphArea(),
				tasks,
			),
		});
		applyTaskState();
	};
	const handleTaskExecutionStart = (taskId: string): void => {
		if (isTaskExecutionRunning(taskId)) {
			return;
		}
		const record = taskState.getWorkspaceTask(taskId);
		if (record !== undefined) {
			interactions.onTaskExecutionStart?.(taskId, record.storageRevision);
		}
	};
	const handleTaskExecutionStop = (taskId: string): void => {
		const snapshot = taskExecutionByTaskId.get(taskId);
		const task = taskState.getTask(taskId);
		const assignedSessions = snapshot
			? collectTaskWorkAgentSessionAssignments(snapshot)
			: [];

		if (
			!snapshot
			|| !task
			|| !isTaskExecutionActive(snapshot)
			|| assignedSessions.length === 0
		) {
			return;
		}
		const executionId = snapshot.executionId;

		void taskStopConfirmDialog.confirm({
			taskTitle: task.title,
			workCount: assignedSessions.length,
		}).then((confirmed) => {
			const current = taskExecutionByTaskId.get(taskId);

			if (
				!confirmed
				|| disposed
				|| !current
				|| current.executionId !== executionId
				|| !isTaskExecutionActive(current)
			) {
				return;
			}
			cleanupTaskExecutionAgentSessions(current);
		});
	};

	taskInspector = initializeTaskInspector(
		overlayLayer,
		viewport,
		camera,
		{ onFieldInput: handleTaskInspectorFieldInput },
	);
	taskRenderer = initializeTaskRenderer(
		edgeLayer,
		nodeLayer,
		viewport,
		currentTaskLayout,
		{
			getCameraScale: () => camera.getState().scale,
			registerNodeActivity: (nodeId, element) => {
				const unregisterEffects = nodeEffects.registerNode(
					{ nodeId },
					element,
				);
				const unregisterBindings = agentActivityBindings?.registerTarget(
					{ nodeId },
					element,
				);

				return () => {
					unregisterBindings?.();
					unregisterEffects();
				};
			},
			clientToWorld: ({ x, y }) => {
				const bounds = viewport.getBoundingClientRect();

				return camera.viewportToWorld({
					x: x - bounds.left,
					y: y - bounds.top,
				});
			},
			onTaskOriginChange: handleTaskOriginChange,
			onTaskNodePositionChange: handleTaskNodePositionChange,
			onNodeFocus: handleTaskNodeFocus,
			onNodeSelectionChange: handleTaskNodeSelectionChange,
			onWorkAdd: handleTaskWorkAdd,
			onTaskStart: handleTaskExecutionStart,
			onTaskStop: handleTaskExecutionStop,
			onTaskExport: handleTaskExport,
			onTaskImport: handleTaskImport,
			onTaskRemove: handleTaskRemove,
			onWorkRemove: handleTaskWorkRemove,
			onGraphTargetAreaToggle: handleTaskGraphTargetAreaToggle,
			resolveGraphTargetRegionStatus: (
				taskId,
				nodeId,
				area,
				sourceIds,
			) => ({
				unavailableCount: sourceIds.filter((sourceId) => {
					const binding: TaskGraphScopeBinding = {
						taskId,
						nodeId,
						area,
						sourceId,
					};
					const occurrenceIds = taskScopeOccurrencesByBinding.get(
						createTaskGraphScopeBindingKey(binding),
					);

					return !occurrenceIds || ![...occurrenceIds].some(
						(occurrenceNodeId) => (
							resolveVisibleTaskGraphScopeOccurrenceSourceId(occurrenceNodeId)
								=== sourceId
						),
					);
				}).length,
			}),
			canConnectNodes: (...connection) => taskState.canConnect(...connection),
			onNodesConnect: handleTaskConnect,
			onEdgeDisconnect: handleTaskEdgeDisconnect,
		},
	);
	const unsubscribeTaskInspectorCamera = state.subscribe(() => {
		taskInspector?.refreshPosition();
	});
	navigator = initializeGraphNavigator(
		overlayLayer,
		viewport,
		state,
		camera,
		initialLayout,
		{
			onRootSelect: handleNavigatorRootSelect,
			onArrangeAll: handleArrangeAll,
			onTaskCreate: handleTaskCreate,
		},
		getVisibleGraphArea,
		nodeEffects,
	);
	syncNavigatorRoots();
	navigator.setWorkspaceGraph(workspaceGraph);
	const taskAgentSessionEndNotices = initializeTaskAgentSessionEndNoticeStack(
		overlayLayer,
		viewport,
		getVisibleGraphArea,
		runtimeOptions.agentActivityNotificationScheduler,
	);
	if (
		runtimeOptions.agentActivityStore
		&& runtimeOptions.agentSessionPresentationStore
	) {
		agentActivityNotificationCenter = initializeAgentActivityNotificationCenter(
			overlayLayer,
			viewport,
			runtimeOptions.agentActivityStore,
			runtimeOptions.agentSessionPresentationStore,
			workspaceGraph,
			nodeEffects.createLocalEffectHost,
			{
				onFocus: handleAgentActivityNotificationFocus,
				shouldGroupBySession: (entry) => (
					entry.activity === 'completed'
					&& [...taskExecutionByTaskId.values()].some((snapshot) => (
						snapshot.state === 'completed'
						&& entry.sessionId === createTaskExecutionActivitySessionId(
							snapshot.executionId,
							snapshot.startNodeId,
						)
					))
				),
				onDismiss: (entry) => {
					if (
						pendingAgentActivityNotificationFocus?.key === entry.key
					) {
						pendingAgentActivityNotificationFocus = undefined;
					}
					if (dismissTaskCompletionActivity(entry)) {
						return;
					}
					if (entry.dismissalScope === 'session') {
						runtimeOptions.agentActivityStore?.clearAgentActivitiesBySession(
							entry.sessionId,
						);
					} else {
						runtimeOptions.agentActivityStore?.clearAgentActivity(
							entry.sessionId,
							entry.target,
						);
					}
				},
			},
			getVisibleGraphArea,
			runtimeOptions.agentActivityNotificationScheduler,
		);
	}
	let renderedTaskScopeFileGroupPages = state.getState().fileGroupPages;
	let renderedTaskScopeOpenedFolders = state.getState().openedFolders;
	let renderedTaskScopeHiddenNodeIds = state.getState().hiddenNodeIds;
	let renderedTaskScopeDetachedRootNodeIds = state.getState().detachedRootNodeIds;
	const unsubscribeLayout = initializeGraphLayoutReflow(
		state,
		renderer,
		navigator,
		() => currentLayout,
		createCurrentLayout,
		() => currentLogicalParentByChild,
		syncNavigatorRoots,
		() => skipGraphLayoutReflow,
		(nextLayout, rebasedNodePositions, snapshot) => {
			if (
				disposed
				|| applyingTaskState
				|| snapshot.detachedRootNodeIds
					!== renderedTaskScopeDetachedRootNodeIds
			) {
				// Detached topology가 바뀐 경우에는 먼저 canonical binding을 새
				// occurrence 주소로 reconcile해야 한다. 뒤 Scope subscriber가 그
				// 기존 전용 경로를 수행하도록 이 reflow에서는 Graph 좌표만 쓴다.
				return rebasedNodePositions;
			}

			applyingTaskState = true;
			try {
				const projection = applyTaskGraphScopeProjection(
					nextLayout,
					rebasedNodePositions,
				);

				// 이 structural snapshot은 이미 단일 Graph layout transition에
				// Scope 좌표까지 합성했다. 뒤 subscriber가 같은 Layout을 다시
				// apply해 enter/exit animation을 취소하지 않도록 표시한다.
				renderedTaskScopeFileGroupPages = snapshot.fileGroupPages;
				renderedTaskScopeOpenedFolders = snapshot.openedFolders;
				renderedTaskScopeHiddenNodeIds = snapshot.hiddenNodeIds;
				renderedTaskScopeDetachedRootNodeIds = snapshot.detachedRootNodeIds;
				return projection.nodePositions;
			} finally {
				applyingTaskState = false;
			}
		},
		(nextState, baseNodePositions) => commitRuntimeGraphState(
			nextState,
			{ baseNodePositions },
		),
		() => persistentNodePositions,
	);
	const unsubscribeAgentActivityLayout = agentActivityBindings
		?.subscribeBindingCountChanges(() => {
			if (disposed || applyingTaskState) {
				return;
			}

			const snapshot = state.getState();
			const previousLayout = currentLayout;
			const nextLayout = createLayout(
				currentGraph,
				snapshot,
				currentManualUnarrangedNodeIds,
			);
			const baseNodePositions = normalizeGraphNodePositions(
				nextLayout,
				rebaseNodePositions(
					previousLayout,
					nextLayout,
					persistentNodePositions,
					{ logicalParentByChild: currentLogicalParentByChild },
				),
			);

			applyingTaskState = true;
			try {
				currentLayout = nextLayout;
				const projection = applyTaskGraphScopeProjection(
					nextLayout,
					baseNodePositions,
				);

				applyGraphLayout(
					renderer,
					navigator,
					nextLayout,
					projection.nodePositions,
				);
				commitRuntimeGraphState({
					camera: snapshot.camera,
					nodePositions: projection.nodePositions,
					fileGroupPages: snapshot.fileGroupPages,
					openedFolders: snapshot.openedFolders,
					detachedRootNodeIds: snapshot.detachedRootNodeIds,
					hiddenNodeIds: snapshot.hiddenNodeIds,
				}, { projectionOnly: true });
			} finally {
				applyingTaskState = false;
			}
		}) ?? (() => {});
	const unsubscribeTaskGraphScope = state.subscribe((snapshot) => {
		const structureChanged = (
			snapshot.fileGroupPages !== renderedTaskScopeFileGroupPages
			|| snapshot.openedFolders !== renderedTaskScopeOpenedFolders
			|| snapshot.hiddenNodeIds !== renderedTaskScopeHiddenNodeIds
			|| snapshot.detachedRootNodeIds
				!== renderedTaskScopeDetachedRootNodeIds
		);
		renderedTaskScopeFileGroupPages = snapshot.fileGroupPages;
		renderedTaskScopeOpenedFolders = snapshot.openedFolders;
		renderedTaskScopeHiddenNodeIds = snapshot.hiddenNodeIds;
		renderedTaskScopeDetachedRootNodeIds = snapshot.detachedRootNodeIds;
		if (applyingTaskState || !structureChanged) {
			return;
		}
		applyTaskState();
	});

	applyTaskState({ animateGraphScopeNodes: false });

	const graphView: GraphView = {
		state,
		camera,
		taskState,
		getWorkspaceSnapshot,
		subscribeWorkspaceSnapshot(subscriber): () => void {
			workspaceSubscribers.add(subscriber);
			return () => {
				workspaceSubscribers.delete(subscriber);
			};
		},
		refreshVisibleGraphArea(): void {
			if (
				!disposed
				&& viewport.clientWidth > 0
				&& viewport.clientHeight > 0
			) {
				navigator.refreshVisibleGraphArea();
				agentActivityNotificationCenter?.refreshVisibleGraphArea();
				taskAgentSessionEndNotices.refreshVisibleGraphArea();
				taskInspector?.refreshPosition();
			}
		},
		updateGraph(graph): void {
			if (disposed) {
				return;
			}

			const currentSnapshot = state.getState();
			const restoredGraphState = pendingWorkspaceGraphState;

			pendingWorkspaceGraphState = undefined;
			if (restoredGraphState) {
				persistentNodePositions = Object.fromEntries(Object.entries(
					restoredGraphState.nodePositions,
				).map(([nodeId, position]) => [nodeId, { ...position }]));
			}
			const snapshot: GraphStateSnapshot = restoredGraphState
				? {
					camera: currentSnapshot.camera,
					nodePositions: persistentNodePositions,
					fileGroupPages: restoredGraphState.fileGroupPages,
					openedFolders: restoredGraphState.openedFolders,
					detachedRootNodeIds: restoredGraphState.detachedRootNodeIds,
					hiddenNodeIds: restoredGraphState.hiddenNodeIds,
				}
				: currentSnapshot;

			workspaceGraph = graph;
			taskGraphTargetIndex = createTaskGraphTargetIndex(workspaceGraph);
			const currentRecords = taskState.getWorkspaceSnapshot().records;
			const nextTaskRecords = pendingWorkspaceTaskRecords;

			pendingWorkspaceTaskRecords = undefined;
			if (
				nextTaskRecords
				&& (
					nextTaskRecords.length !== currentRecords.length
					|| nextTaskRecords.some(
						(record, index) => record !== currentRecords[index],
					)
				)
			) {
				taskState.replaceWorkspaceTasks(nextTaskRecords);
			}
			const nextGraph = applyDetachedGraphRoots(
				workspaceGraph,
				snapshot.detachedRootNodeIds,
			);
			const detachedRootNodeIds = normalizeDetachedRootNodeIds(
				nextGraph,
				snapshot.detachedRootNodeIds,
			);
			const visualState = normalizeDetachedInstanceVisualState(
				nextGraph,
				snapshot,
			);
			const nextSnapshot = { ...snapshot, ...visualState };
			const previousLayout = currentLayout;
			const nextLogicalParentByChild = createGraphLogicalParentByChild(
				nextGraph,
			);
			const nextUnarrangedNodeIds = new Set([
				...currentManualUnarrangedNodeIds,
				...nextGraph.roots
					.filter((root) => isDetachedRootId(root.id))
					.map(getGraphRootLayoutNodeId),
			]);
			let nextLayout = createLayout(
				nextGraph,
				nextSnapshot,
				nextUnarrangedNodeIds,
			);
			const scopedNodePositions = scopeDetachedNodePositions(
				nextGraph,
				nextLayout,
				persistentNodePositions,
			);
			const restoredArrangement = classifyGraphLayoutNodeArrangement(
				nextLayout,
				scopedNodePositions,
			);
			const previousNodeIds = new Set(
				previousLayout.nodes.map((node) => node.id),
			);
			let restoredNewNodeArrangement = false;

			for (const nodeId of restoredArrangement.unarrangedNodeIds) {
				if (
					!previousNodeIds.has(nodeId)
					&& scopedNodePositions[nodeId]
					&& !nextUnarrangedNodeIds.has(nodeId)
				) {
					nextUnarrangedNodeIds.add(nodeId);
					restoredNewNodeArrangement = true;
				}
			}
			if (restoredNewNodeArrangement) {
				nextLayout = createLayout(
					nextGraph,
					nextSnapshot,
					nextUnarrangedNodeIds,
				);
			}
			const nodePositions = normalizeGraphNodePositions(
				nextLayout,
				rebaseNodePositions(
					previousLayout,
					nextLayout,
					scopedNodePositions,
					{
						logicalParentByChild: nextLogicalParentByChild,
					},
				),
			);
			const nextNodeIds = new Set(nextLayout.nodes.map((node) => node.id));

			for (const previousNode of previousLayout.nodes) {
				const previousInstanceRootId = getGraphLayoutRootId(previousNode.id);

				if (
					!nextNodeIds.has(previousNode.id)
					&& !currentManualUnarrangedNodeIds.has(previousNode.id)
					&& (
						!previousInstanceRootId
						|| !detachedRootNodeIds[previousInstanceRootId]
					)
				) {
					// Workspace에서 사라진 arranged Node의 파생 좌표는 재생성할 수 있다.
					delete nodePositions[previousNode.id];
				}
			}

			currentGraph = nextGraph;
			currentManualUnarrangedNodeIds = nextUnarrangedNodeIds;
			currentLogicalParentByChild = nextLogicalParentByChild;
			currentLayout = nextLayout;
			applyGraphLayout(renderer, navigator, nextLayout, nodePositions);
			commitRuntimeGraphState({
				camera: snapshot.camera,
				nodePositions,
				fileGroupPages: visualState.fileGroupPages,
				openedFolders: visualState.openedFolders,
				detachedRootNodeIds,
				hiddenNodeIds: snapshot.hiddenNodeIds,
			}, { baseNodePositions: nodePositions });
			syncNavigatorRoots();
			navigator.setWorkspaceGraph(workspaceGraph);
			agentActivityNotificationCenter?.setGraph(workspaceGraph);
			applyTaskState();
			retryPendingAgentActivityNotificationFocus();
		},
		updateTasks(tasks): void {
			if (!disposed) {
				const previousRecords = new Map(
					taskState.getWorkspaceSnapshot().records.map((record) => [
						record.task.id,
						record,
					]),
				);
				const fallbackOwnerRootId = createTaskWorkspaceRootOptions(
					workspaceGraph,
				)[0]?.value ?? 'workspace-root:transient';
				const records = tasks.map((task) => {
					const previous = previousRecords.get(task.id);
					const ownerRootId = previous?.ownerRootId ?? fallbackOwnerRootId;
					const previousOrigins = new Map(previous?.targetOrigins.map((origin) => [
						createTaskTargetOriginKey(
							origin.nodeId,
							origin.area,
							origin.sourceId,
						),
						origin,
					]));
					const targetOrigins = collectTaskTargetOrigins(
						task,
						ownerRootId,
						taskGraphTargetIndex,
					).map((origin) => {
						if (taskGraphTargetIndex.has(origin.sourceId)) {
							return origin;
						}
						return previousOrigins.get(createTaskTargetOriginKey(
							origin.nodeId,
							origin.area,
							origin.sourceId,
						)) ?? origin;
					});

					return {
						ownerRootId,
						storageRevision: previous
							? Math.min(
								Number.MAX_SAFE_INTEGER,
								previous.storageRevision + 1,
							)
							: 1,
						task,
						targetOrigins,
					};
				});

				taskState.replaceWorkspaceTasks(records);
				applyTaskState();
			}
		},
		applyTaskExecutionSnapshot(snapshot): void {
			if (!disposed) {
				const previous = taskExecutionByTaskId.get(snapshot.taskId);
				if (
					previous !== undefined
					&& previous.executionId !== snapshot.executionId
				) {
					clearTaskExecutionActivities(previous);
				}
				taskExecutionByTaskId.set(snapshot.taskId, snapshot);
				if (
					snapshot.state === 'running'
					&& focusedTaskNode?.taskId === snapshot.taskId
				) {
					clearTaskFocus();
				}
				taskRenderer.applyExecutionSnapshot(snapshot);
				syncTaskExecutionActivities(snapshot);
			}
		},
		assignTaskWorkAgentSession(executionId, workNodeId, sessionId): void {
			if (disposed) {
				return;
			}
			const snapshot = [...taskExecutionByTaskId.values()].find(
				(candidate) => candidate.executionId === executionId,
			);
			const presentation = runtimeOptions.agentSessionPresentationStore
				?.getSession(sessionId);

			if (
				!snapshot
				|| !snapshot.works.some(({ nodeId }) => nodeId === workNodeId)
				|| !presentation
			) {
				return;
			}
			const assignmentKey = createTaskWorkAgentSessionKey(
				executionId,
				workNodeId,
			);
			const previousSession = taskWorkAgentSessions.get(assignmentKey);

			if (
				previousSession
				&& previousSession.actualSessionId !== sessionId
			) {
				taskActivityKindsBySessionId.delete(previousSession.actualSessionId);
			}
			taskWorkAgentSessions.set(
				assignmentKey,
				Object.freeze({
					actualSessionId: sessionId,
				}),
			);
			syncTaskExecutionActivities(snapshot);
		},
		showTaskAgentSessionEndedNotice(sessionId, sessionTitle): void {
			if (!disposed) {
				taskAgentSessionEndNotices.show(sessionId, sessionTitle);
			}
		},
		updateWorkspace(graph, snapshot, stateIdChanges): void {
			if (disposed) {
				return;
			}
			suppressWorkspaceNotifications += 1;
			try {
				if (stateIdChanges) {
					const rebaseIds = (ids: ReadonlySet<string>): Set<string> => new Set(
						[...ids].map((id) => stateIdChanges[id] ?? id),
					);

					currentManualUnarrangedNodeIds = rebaseIds(
						currentManualUnarrangedNodeIds,
					);
					currentTaskScopeBoundaryNodeIds = rebaseIds(
						currentTaskScopeBoundaryNodeIds,
					);
				}
				pendingWorkspaceTaskRecords = sanitizeWorkspaceTaskRecords(
					snapshot.tasks,
					graph,
				);
				pendingWorkspaceGraphState = snapshot.graph;
				graphView.updateGraph(graph);
			} finally {
				suppressWorkspaceNotifications -= 1;
			}
			notifyWorkspaceSubscribers();
		},
		setNodeEffect(target, effect): void {
			if (!disposed) {
				nodeEffects.setNodeEffect(target, effect);
			}
		},
		clearNodeEffect(target, kind): void {
			if (!disposed) {
				nodeEffects.clearNodeEffect(target, kind);
			}
		},
		createNodeEffectOwner(): GraphNodeEffectOwner {
			return nodeEffects.createOwner();
		},
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			pendingAgentActivityNotificationFocus = undefined;
			reattachConfirmDialog.dispose();
			arrangeAllConfirmDialog.dispose();
			taskStopConfirmDialog.dispose();
			taskImportDialog.dispose();
			unsubscribeTaskGraphScope();
			unsubscribeLayout();
			unsubscribeAgentActivityLayout();
			unsubscribeTaskInspectorCamera();
			unsubscribeWorkspaceGraphState();
			unsubscribeWorkspaceTasks();
			workspaceSubscribers.clear();
			navigator.dispose();
			taskAgentSessionEndNotices.dispose();
			agentActivityNotificationCenter?.dispose();
			agentActivityNotificationCenter = undefined;
			for (const snapshot of taskExecutionByTaskId.values()) {
				clearTaskExecutionActivities(snapshot);
			}
			taskExecutionByTaskId.clear();
			taskInspector?.dispose();
			taskInspector = undefined;
			focusedTaskNode = undefined;
			taskScopeOccurrencesByBinding.clear();
			expandedTaskGraphScopeAreaKeys.clear();
			taskWorkAgentSessions.clear();
			taskActivityKindsBySessionId.clear();
			taskRenderer.dispose();
			renderer.dispose();
			agentActivityBindings?.dispose();
			nodeEffects.dispose();
			camera.dispose();
			viewport.remove();
		},
	};
	return graphView;
}
