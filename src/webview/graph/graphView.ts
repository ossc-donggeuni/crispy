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
	type GraphLayout,
} from './graphLayout';
import {
	calculateDetachedRootDuplicatePosition,
	classifyGraphLayoutNodeArrangement,
	rebaseNodePositions,
	translateDetachedSubtree,
} from './graphLayoutTransition';
import type { Graph, GraphRoot, GraphRootNode } from './graphModel';
import {
	addGraphRoot,
	applyDetachedGraphRoots,
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
	TASK_BOUNDARY_NODE_HEIGHT,
	TASK_NODE_WIDTH,
	type TaskLayoutNode,
} from '../task/taskLayout';
import { initializeTaskRenderer } from '../task/taskRenderer';

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

/** 현재 Visible Graph 중심을 기본 Task 전체 중심으로 사용하고 겹친 origin은 비켜 놓는다. */
function createTaskOriginInVisibleArea(
	camera: GraphCamera,
	visibleArea: GraphVisibleArea,
	tasks: readonly TaskBlueprint[],
): TaskOrigin {
	const center = camera.viewportToWorld(visibleArea.center);
	const baseOrigin = {
		x: center.x - DEFAULT_TASK_LAYOUT_WIDTH / 2,
		y: center.y - TASK_BOUNDARY_NODE_HEIGHT / 2,
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

		applyGraphLayout(
			renderer,
			navigator,
			nextLayout,
			rebasedNodePositions,
		);
		if (hiddenNodeIdsChanged) {
			onHiddenNodeIdsChange(nextState);
		}
		state.setState({
			camera: nextState.camera,
			nodePositions: rebasedNodePositions,
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
	let initialGraphState = state.getState();
	let workspaceGraph = graph;
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
		unarrangedNodeIds: ReadonlySet<string> = new Set(),
	): GraphLayout => createGraphLayout(targetGraph, {
		fileGroupPages: snapshot.fileGroupPages,
		openedFolders: snapshot.openedFolders,
		hiddenNodeIds: snapshot.hiddenNodeIds,
		unarrangedNodeIds,
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
	let currentUnarrangedNodeIds = new Set([
		...initialArrangement.unarrangedNodeIds,
		...currentGraph.roots
			.filter((root) => isDetachedRootId(root.id))
			.map(getGraphRootLayoutNodeId),
	]);
	let currentLayout = currentUnarrangedNodeIds.size === 0
		? initialBaselineLayout
		: createLayout(
			currentGraph,
			initialGraphState,
			currentUnarrangedNodeIds,
		);
	let renderer: GraphRenderer;
	let navigator: GraphNavigator;
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
			currentUnarrangedNodeIds,
		);

		return currentLayout;
	};
	/** Drag Detach와 Hover Duplicate가 공유하는 Multiple Detach Instance 추가 경로다. */
	const addDetachedRootInstance = (
		request: Pick<GraphDetachDropRequest, 'nodeId' | 'instanceRootId'>,
		targetPosition: { readonly x: number; readonly y: number },
		templateRootIdOverride?: string,
		animationSourceRootId?: string,
	): boolean => {
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
			return false;
		}

		const snapshot = state.getState();
		const detachedRootNode = addition.graph.rootNodes[addition.root.nodeId];

		if (!detachedRootNode) {
			return false;
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
			currentUnarrangedNodeIds,
			sourceRootNodeId,
			addition.root.id,
			currentLogicalParentByChild,
			removeReplacedOccurrence,
		);

		const detachedRootNodeId = getGraphRootLayoutNodeId(addition.root);

		unarrangedNodeIds.add(detachedRootNodeId);
		currentUnarrangedNodeIds = unarrangedNodeIds;
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
		return true;
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
		currentUnarrangedNodeIds = new Set();
		currentLayout = createLayout(currentGraph, nextSnapshot);
		applyGraphLayout(renderer, navigator, currentLayout, {});
		skipGraphLayoutReflow = true;
		try {
			state.setState({
				camera: snapshot.camera,
				nodePositions: {},
				fileGroupPages: visualState.fileGroupPages,
				openedFolders: visualState.openedFolders,
				detachedRootNodeIds: {},
				hiddenNodeIds: snapshot.hiddenNodeIds,
			});
		} finally {
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
		const previousUnarrangedNodeIds = currentUnarrangedNodeIds;
		const unarrangedNodeIds = reattachDetachedSubtreeArrangement(
			previousUnarrangedNodeIds,
			detachedRootNodeId,
			destinationRootNodeId,
			currentLogicalParentByChild,
			restoreOccurrence,
		);
		const nextLogicalParentByChild = createGraphLogicalParentByChild(nextGraph);

		currentUnarrangedNodeIds = unarrangedNodeIds;
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
					unarrangedNodeIds,
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
		const nextUnarrangedNodeIds = new Set(currentUnarrangedNodeIds);
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
		const nodePositions = rebaseNodePositions(
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

		currentUnarrangedNodeIds = nextUnarrangedNodeIds;
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
			resolveNodeSubtreeIds: (nodeId) => collectGraphLogicalSubtreeNodeIds(
				nodeId,
				currentLogicalParentByChild,
			),
			resolveRootId: (rootNodeId) => currentGraph.roots.find(
				(root) => getGraphRootLayoutNodeId(root) === rootNodeId,
			)?.id,
		},
		{ nodeEffects },
	);
	let taskRenderer: ReturnType<typeof initializeTaskRenderer>;
	const applyTaskState = (): void => {
		taskRenderer.applyLayout(createTaskGraphLayout(
			taskState.getSnapshot().tasks,
		));
	};
	const handleTaskOriginChange = (taskId: string, origin: TaskOrigin): void => {
		const updated = taskState.updateTask(taskId, (task) => ({
			...task,
			origin,
		}));

		if (updated) {
			applyTaskState();
		}
	};
	const handleTaskNodePositionChange = (
		taskId: string,
		nodeId: string,
		position: TaskNodePosition,
	): void => {
		if (taskState.setNodePosition(taskId, nodeId, position)) {
			applyTaskState();
		}
	};
	const handleTaskNodeFocus = (node: TaskLayoutNode): void => {
		camera.focusOn({
			x: node.position.x + node.width / 2,
			y: node.position.y + node.height / 2,
		});
	};
	const handleTaskWorkAdd = (taskId: string): void => {
		if (taskState.addWork(taskId)) {
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

	taskRenderer = initializeTaskRenderer(
		edgeLayer,
		nodeLayer,
		viewport,
		createTaskGraphLayout(taskState.getSnapshot().tasks),
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
			onWorkAdd: handleTaskWorkAdd,
			onWorkRemove: handleTaskWorkRemove,
			canConnectNodes: (...connection) => taskState.canConnect(...connection),
			onNodesConnect: handleTaskConnect,
			onEdgeDisconnect: handleTaskEdgeDisconnect,
		},
	);
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
	const unsubscribeLayout = initializeGraphLayoutReflow(
		state,
		renderer,
		navigator,
		() => currentLayout,
		createCurrentLayout,
		() => currentLogicalParentByChild,
		syncNavigatorRoots,
		() => skipGraphLayoutReflow,
	);

	return {
		state,
		camera,
		taskState,
		refreshVisibleGraphArea(): void {
			if (!disposed) {
				navigator.refreshVisibleGraphArea();
			}
		},
		updateGraph(graph): void {
			if (disposed) {
				return;
			}

			const snapshot = state.getState();

			workspaceGraph = graph;
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
				...currentUnarrangedNodeIds,
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
					&& !currentUnarrangedNodeIds.has(previousNode.id)
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
			currentUnarrangedNodeIds = nextUnarrangedNodeIds;
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
			unsubscribeLayout();
			navigator.dispose();
			taskRenderer.dispose();
			renderer.dispose();
			nodeEffects.dispose();
			camera.dispose();
			viewport.remove();
		},
	};
}
