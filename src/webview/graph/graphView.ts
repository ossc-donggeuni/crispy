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
} from '../../messages';
import { createGraphNodeEffects } from './graphNodeEffects';
import {
	createTaskState,
	TASK_DEFAULT_END_POSITION,
	type TaskBlueprint,
	type TaskNodePosition,
	type TaskOrigin,
	type TaskStateStore,
} from '../../task';
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
} from '../task/taskInspector';

/** Graph DOM 계층과 State, Camera lifecycle을 하나로 제공한다. */
export interface GraphView {
	/** Camera, Node 위치, File Group page, Open, Detached Root 및 Filter를 관리하는 Store다. */
	readonly state: GraphStateStore;
	/** Pan/Zoom과 Viewport/World 좌표 변환을 제공하는 Camera다. */
	readonly camera: GraphCamera;
	/** Task 생성, 연결과 explicit Node 위치의 source of truth인 Domain Store다. */
	readonly taskState: TaskStateStore;
	/** Panel/Dock/Webview 변화 뒤 Visible Graph 기반 Overlay를 즉시 다시 배치한다. */
	refreshVisibleGraphArea(): void;
	/** 기존 View와 State를 유지하며 새로운 Workspace Graph를 적용한다. */
	updateGraph(graph: Graph): void;
	/** 기존 View와 Workspace Graph를 유지하며 Task Blueprint 목록을 적용한다. */
	updateTasks(tasks: readonly TaskBlueprint[]): void;
	/** Host가 지정한 transient 시각 효과를 같은 kind 기준으로 적용 또는 교체한다. */
	setNodeEffect(target: GraphNodeEffectTarget, effect: GraphNodeEffect): void;
	/** 특정 target의 한 kind 또는 모든 transient 시각 효과를 제거한다. */
	clearNodeEffect(target: GraphNodeEffectTarget, kind?: GraphNodeEffectKind): void;
	/** Navigator, Renderer, Camera와 생성한 Viewport DOM을 정리한다. */
	dispose(): void;
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

/** Graph View가 Renderer의 향후 Root Promotion 요청을 전달할 상위 계약이다. */
export interface GraphViewInteractions {
	/** 내부 Promotion 처리 뒤 Detach 완료 요청을 관찰하는 선택적 callback이다. */
	onDetachDrop?: (request: GraphDetachDropRequest) => void;
	/** 일반 File Row의 Editor 열기 요청을 안정적인 File ID로 전달한다. */
	onFileOpenRequest?: (fileId: string) => void;
	/** Floating Overlay를 제외한 현재 Graph 표시 영역을 Viewport local 좌표로 계산한다. */
	resolveVisibleGraphArea?: (viewport: HTMLElement) => GraphVisibleArea;
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
		const rebasedNodePositions = normalizeGraphNodePositions(
			nextLayout,
			rebaseNodePositions(
				previousLayout,
				nextLayout,
				nextState.nodePositions,
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
		state.setState({
			camera: nextState.camera,
			nodePositions: projectedNodePositions,
			fileGroupPages: nextState.fileGroupPages,
			openedFolders: nextState.openedFolders,
			detachedRootNodeIds: nextState.detachedRootNodeIds,
			hiddenNodeIds: nextState.hiddenNodeIds,
		});
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
 * @returns State와 Camera 및 전체 lifecycle을 제공하는 Graph View
 */
export function initializeGraphView(
	root: HTMLElement,
	initialState: GraphState,
	graph: Graph,
	interactions: GraphViewInteractions = {},
	initialTasks: readonly TaskBlueprint[] = [],
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
	const nodeEffects = createGraphNodeEffects(
		ownerDocument,
		undefined,
		effectRegionLayer,
	);
	const state = createGraphState(initialState);
	const taskState = createTaskState(initialTasks);
	let disposed = false;
	/** 활성 Task Scope가 World 위치를 소유하는 actual Graph occurrence Root다. */
	let currentTaskScopeBoundaryNodeIds = new Set<string>();
	let initialGraphState = state.getState();
	let workspaceGraph = graph;
	let taskGraphTargetIndex = createTaskGraphTargetIndex(workspaceGraph);
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
				snapshot.nodePositions,
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
			snapshot.nodePositions,
			detachedRootNodeId,
			targetPosition,
			{ baseNodePositions: rebasedNodePositions },
		);
		const nodePositions = cloneDetachedSubtreePositions(
			translatedNodePositions,
			snapshot.nodePositions,
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
		state.setState({
			camera: snapshot.camera,
			nodePositions,
			fileGroupPages: visualState.fileGroupPages,
			openedFolders: visualState.openedFolders,
			detachedRootNodeIds,
			hiddenNodeIds: snapshot.hiddenNodeIds,
		});
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
			state.setState({
				camera: snapshot.camera,
				nodePositions: projection.nodePositions,
				fileGroupPages: visualState.fileGroupPages,
				openedFolders: visualState.openedFolders,
				detachedRootNodeIds: {},
				hiddenNodeIds: snapshot.hiddenNodeIds,
			});
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
			snapshot.nodePositions,
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
		state.setState({
			camera: snapshot.camera,
			nodePositions,
			fileGroupPages: visualState.fileGroupPages,
			openedFolders: visualState.openedFolders,
			detachedRootNodeIds,
			hiddenNodeIds: snapshot.hiddenNodeIds,
		});
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
		let nodePositions = rebaseNodePositions(
			previousLayout,
			nextLayout,
			snapshot.nodePositions,
			{
				logicalParentByChild: currentLogicalParentByChild,
			},
		);
		if (
			arranged
			&& !nextLayout.nodes.some((node) => node.id === nodeId)
		) {
			// standalone File Card가 grouped Row로 돌아가면 Layout 좌표 소유권도 제거한다.
			delete nodePositions[nodeId];
		}
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
		state.setState({
			camera: snapshot.camera,
			nodePositions,
			fileGroupPages: snapshot.fileGroupPages,
			openedFolders: snapshot.openedFolders,
			detachedRootNodeIds: snapshot.detachedRootNodeIds,
			hiddenNodeIds: snapshot.hiddenNodeIds,
		});
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
		{ nodeEffects },
	);
	let currentTaskLayout = createTaskGraphLayout(
		taskState.getSnapshot().tasks,
	);
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
		taskInspector?.apply(focusedTaskNode, currentTaskLayout);
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
						graphLayout,
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
		const provisionalLayout = createTaskGraphLayout(tasks);
		const scopeLayouts = createCurrentTaskGraphScopeLayouts(
			provisionalLayout,
			graphLayout,
			graphNodePositions,
		);
		const scopeSizeOptions = {
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
			const bindings = collectTaskGraphScopeBindings();
			const scopeBoundariesChanged = reconcileTaskGraphScopeOccurrences(bindings);
			const snapshot = state.getState();
			let graphNodePositions: Record<string, GraphLayoutPosition> = {
				...snapshot.nodePositions,
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
					snapshot.nodePositions,
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
				state.setState({
					camera: snapshot.camera,
					nodePositions: projection.nodePositions,
				});
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
		const applyChanges = (
			graphTargets: TaskBlueprint['defaultGraphTargets'],
			nodeId: string,
			changesForTask: typeof effectiveChanges,
		): TaskBlueprint['defaultGraphTargets'] => {
			let nextGraphTargets = graphTargets;

			for (const { binding, included } of changesForTask) {
				if (binding.nodeId !== nodeId) {
					continue;
				}
				const areaTargets = nextGraphTargets[binding.area];
				const nextAreaTargets = included
					? areaTargets.includes(binding.sourceId)
						? areaTargets
						: sortTaskGraphTargetIds(taskGraphTargetIndex, [
							...areaTargets,
							binding.sourceId,
						])
					: areaTargets.includes(binding.sourceId)
						? areaTargets.filter((sourceId) => sourceId !== binding.sourceId)
						: areaTargets;

				if (nextAreaTargets === areaTargets) {
					continue;
				}

				nextGraphTargets = {
					...nextGraphTargets,
					[binding.area]: nextAreaTargets,
				};
			}
			return nextGraphTargets;
		};

		for (const taskId of new Set(effectiveChanges.map(
			(change) => change.binding.taskId,
		))) {
			const taskChanges = effectiveChanges.filter(
				(change) => change.binding.taskId === taskId,
			);
			const updated = taskState.updateTask(taskId, (current) => {
				const start = current.nodes.find((node) => node.kind === 'start');

				return {
					...current,
					defaultGraphTargets: start
						? applyChanges(current.defaultGraphTargets, start.id, taskChanges)
						: current.defaultGraphTargets,
					nodes: current.nodes.map((node) => {
						if (node.kind !== 'work') {
							return node;
						}
						const graphTargets = applyChanges(
							node.graphTargets,
							node.id,
							taskChanges,
						);

						return graphTargets === node.graphTargets
							? node
							: { ...node, graphTargets };
					}),
				};
			});

			if (!updated) {
				return false;
			}
		}
		return true;
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
		const nodePositions = { ...snapshot.nodePositions };
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
		state.setState({ camera: snapshot.camera, nodePositions });
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

		taskRenderer.clearGraphTargetDrag();
		if (disposed) {
			return false;
		}
		if (!dropTarget) {
			const binding = findTaskGraphScopeBindingForOccurrence(
				request.occurrenceNodeId,
			);

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
	const handleTaskRemove = (taskId: string): void => {
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
		if (taskState.disconnect(taskId, edgeId)) {
			applyTaskState();
		}
	};
	const handleTaskWorkRemove = (taskId: string, nodeId: string): void => {
		if (taskState.removeWork(taskId, nodeId)) {
			applyTaskState();
		}
	};
	const handleTaskCreate = (): void => {
		const tasks = taskState.getSnapshot().tasks;

		taskState.createTask({
			title: `Task ${tasks.length + 1}`,
			origin: createTaskOriginInVisibleArea(
				camera,
				getVisibleGraphArea(),
				tasks,
			),
		});
		applyTaskState();
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
			onTaskRemove: handleTaskRemove,
			onWorkRemove: handleTaskWorkRemove,
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
	);
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

	return {
		state,
		camera,
		taskState,
		refreshVisibleGraphArea(): void {
			if (!disposed) {
				navigator.refreshVisibleGraphArea();
				taskInspector?.refreshPosition();
			}
		},
		updateGraph(graph): void {
			if (disposed) {
				return;
			}

			const snapshot = state.getState();

			workspaceGraph = graph;
			taskGraphTargetIndex = createTaskGraphTargetIndex(workspaceGraph);
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
				snapshot.nodePositions,
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
			state.setState({
				camera: snapshot.camera,
				nodePositions,
				fileGroupPages: visualState.fileGroupPages,
				openedFolders: visualState.openedFolders,
				detachedRootNodeIds,
				hiddenNodeIds: snapshot.hiddenNodeIds,
			});
			syncNavigatorRoots();
			navigator.setWorkspaceGraph(workspaceGraph);
			applyTaskState();
		},
		updateTasks(tasks): void {
			if (!disposed) {
				taskState.replaceTasks(tasks);
				applyTaskState();
			}
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
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			reattachConfirmDialog.dispose();
			arrangeAllConfirmDialog.dispose();
			unsubscribeTaskGraphScope();
			unsubscribeLayout();
			unsubscribeTaskInspectorCamera();
			navigator.dispose();
			taskInspector?.dispose();
			taskInspector = undefined;
			focusedTaskNode = undefined;
			taskScopeOccurrencesByBinding.clear();
			taskRenderer.dispose();
			renderer.dispose();
			nodeEffects.dispose();
			camera.dispose();
			viewport.remove();
		},
	};
}
