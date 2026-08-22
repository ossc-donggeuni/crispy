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
	collectGraphLayoutSubtreeNodeIds,
	classifyGraphLayoutNodeArrangement,
	rebaseArrangedSubtree,
	rebaseNodePositions,
	rebaseReattachedSubtree,
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
import {
	initializeGraphRenderer,
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

/** Graph DOM 계층과 State, Camera lifecycle을 하나로 제공한다. */
export interface GraphView {
	/** Camera, Node 위치, File Group page, Open, Detached Root 및 Filter를 관리하는 Store다. */
	readonly state: GraphStateStore;
	/** Pan/Zoom과 Viewport/World 좌표 변환을 제공하는 Camera다. */
	readonly camera: GraphCamera;
	/** Panel/Dock/Webview 변화 뒤 Visible Graph 기반 Overlay를 즉시 다시 배치한다. */
	refreshVisibleGraphArea(): void;
	/** 기존 View와 State를 유지하며 새로운 Workspace Graph를 적용한다. */
	updateGraph(graph: Graph): void;
	/** Navigator, Renderer, Camera와 생성한 Viewport DOM을 정리한다. */
	dispose(): void;
}

/** Graph View가 Renderer의 향후 Root Promotion 요청을 전달할 상위 계약이다. */
export interface GraphViewInteractions {
	/** 내부 Promotion 처리 뒤 Detach 완료 요청을 관찰하는 선택적 callback이다. */
	onDetachDrop?: (request: GraphDetachDropRequest) => void;
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

		const hasNewlyOpenedFolder = Object.entries(nextState.openedFolders).some(
			([nodeId, isOpened]) => isOpened && !renderedOpenedFolders[nodeId],
		);
		renderedFileGroupPages = nextState.fileGroupPages;
		renderedOpenedFolders = nextState.openedFolders;
		renderedHiddenNodeIds = nextState.hiddenNodeIds;
		const previousLayout = getCurrentLayout();
		const nextLayout = createLayout(nextState);
		const rebasedNodePositions = rebaseBacklinkNodePositions(
			nextLayout,
			rebaseNodePositions(
				previousLayout,
				nextLayout,
					nextState.nodePositions,
					{
						inheritAncestorOffsets: hasNewlyOpenedFolder,
					stationaryRootNodeIds: nextLayout.unarrangedNodeIds,
				},
			),
		);

		applyGraphLayout(
			renderer,
			navigator,
			nextLayout,
			rebasedNodePositions,
		);
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
): void {
	renderer.applyLayout(layout, nodePositions);
	navigator.setLayout(layout);
}

/** 정적 Backlink Card는 저장된 독립 위치를 버리고 Parent의 정렬 offset만 상속한다. */
function rebaseBacklinkNodePositions(
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

	if (backlinkNodeIds.size === 0) {
		return Object.fromEntries(Object.entries(nodePositions).map(
			([nodeId, position]) => [nodeId, { ...position }],
		));
	}

	const positionsWithoutBacklinks = Object.fromEntries(
		Object.entries(nodePositions).filter(
			([nodeId]) => !backlinkNodeIds.has(nodeId),
		),
	);

	return rebaseNodePositions(
		layout,
		layout,
		positionsWithoutBacklinks,
		{ inheritAncestorOffsets: true },
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
	layout: GraphLayout,
	nodePositions: GraphStateSnapshot['nodePositions'],
): Record<string, { x: number; y: number }> {
	const scoped = Object.fromEntries(Object.entries(nodePositions).map(
		([nodeId, position]) => [nodeId, { ...position }],
	));
	const visibleNodeIds = new Set(layout.nodes.map((node) => node.id));

	for (const node of layout.nodes) {
		if (!getGraphLayoutRootId(node.id) || scoped[node.id]) {
			continue;
		}

		const sourceNodeId = getGraphLayoutSourceId(node.id);
		const sourcePosition = nodePositions[sourceNodeId];

		if (!sourcePosition) {
			continue;
		}

		scoped[node.id] = { ...sourcePosition };

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
 * @returns State와 Camera 및 전체 lifecycle을 제공하는 Graph View
 */
export function initializeGraphView(
	root: HTMLElement,
	initialState: GraphState,
	graph: Graph,
	interactions: GraphViewInteractions = {},
): GraphView {
	const ownerDocument = root.ownerDocument;
	const viewport = ownerDocument.createElement('div');
	const world = ownerDocument.createElement('div');
	const edgeLayer = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
	const nodeLayer = ownerDocument.createElement('div');
	const overlayLayer = ownerDocument.createElement('div');

	viewport.className = 'graph-viewport';
	world.className = 'graph-world';
	edgeLayer.classList.add('graph-edge-layer');
	edgeLayer.setAttribute('aria-hidden', 'true');
	nodeLayer.className = 'graph-node-layer';
	overlayLayer.className = 'graph-overlay-layer';

	world.append(edgeLayer, nodeLayer);
	viewport.append(world, overlayLayer);
	root.append(viewport);
	const reattachConfirmDialog = createGraphReattachConfirmDialog(overlayLayer);
	const state = createGraphState(initialState);
	let disposed = false;
	let initialGraphState = state.getState();
	let workspaceGraph = graph;
	let currentGraph = applyDetachedGraphRoots(
		workspaceGraph,
		initialGraphState.detachedRootNodeIds,
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
	const initialBaselineLayout = createLayout(currentGraph, {
		...initialGraphState,
		...normalizedInitialVisualState,
	});
	const scopedInitialNodePositions = scopeDetachedNodePositions(
		initialBaselineLayout,
		initialGraphState.nodePositions,
	);
	state.setState({
		camera: initialGraphState.camera,
		nodePositions: rebaseBacklinkNodePositions(
			initialBaselineLayout,
			scopedInitialNodePositions,
		),
		fileGroupPages: normalizedInitialVisualState.fileGroupPages,
		openedFolders: normalizedInitialVisualState.openedFolders,
		detachedRootNodeIds: normalizedInitialDetachedRootNodeIds,
		hiddenNodeIds: initialGraphState.hiddenNodeIds,
	});
	initialGraphState = state.getState();
	const initialArrangement = classifyGraphLayoutNodeArrangement(
		initialBaselineLayout,
		initialGraphState.nodePositions,
	);
	let currentUnarrangedNodeIds = new Set(initialArrangement.unarrangedNodeIds);
	let currentLayout = currentUnarrangedNodeIds.size === 0
		? initialBaselineLayout
		: createLayout(
			currentGraph,
			initialGraphState,
			currentUnarrangedNodeIds,
		);
	let renderer: GraphRenderer;
	let navigator: GraphNavigator;
	const syncNavigatorRoots = (): void => {
		navigator.setRoots(createGraphNavigatorRoots(currentGraph));
	};
	const createCurrentLayout = (snapshot: GraphStateSnapshot): GraphLayout => {
		const arrangement = classifyGraphLayoutNodeArrangement(
			currentLayout,
			snapshot.nodePositions,
		);

		currentUnarrangedNodeIds = new Set(arrangement.unarrangedNodeIds);

		currentLayout = createLayout(
			currentGraph,
			snapshot,
			currentUnarrangedNodeIds,
		);

		return currentLayout;
	};
	const handleDetachDrop = (request: GraphDetachDropRequest): void => {
		const occurrenceRoots = currentGraph.roots.filter((root) => (
			root.nodeId === request.nodeId
			&& getDetachedRootOriginId(root.id) === request.instanceRootId
		));
		const templateRootId = occurrenceRoots.at(-1)?.id
			?? request.instanceRootId;
		const addition = addGraphRoot(
			currentGraph,
			request.nodeId,
			request.instanceRootId,
		);

		if (addition) {
			const snapshot = state.getState();
			const detachedRootNode = addition.graph.rootNodes[addition.root.nodeId];

			if (!detachedRootNode) {
				interactions.onDetachDrop?.(request);
				return;
			}
			const visualState = cloneDetachedInstanceVisualState(
				snapshot,
				detachedRootNode,
				templateRootId,
				addition.root.id,
				request.instanceRootId,
				occurrenceRoots.length === 0,
			);
			const nextSnapshot = { ...snapshot, ...visualState };
			const viewportBounds = viewport.getBoundingClientRect();
			const targetPosition = camera.viewportToWorld({
				x: request.clientX - viewportBounds.left,
				y: request.clientY - viewportBounds.top,
			});
			const previousLayout = currentLayout;
			const unarrangedNodeIds = new Set(
				classifyGraphLayoutNodeArrangement(
					previousLayout,
					snapshot.nodePositions,
				).unarrangedNodeIds,
			);

			const detachedRootNodeId = getGraphRootLayoutNodeId(addition.root);

			unarrangedNodeIds.add(detachedRootNodeId);
			currentUnarrangedNodeIds = unarrangedNodeIds;
			const nextLayout = createLayout(
				addition.graph,
				nextSnapshot,
				unarrangedNodeIds,
			);
			const rebasedNodePositions = rebaseBacklinkNodePositions(
				nextLayout,
				rebaseNodePositions(
					previousLayout,
					nextLayout,
					snapshot.nodePositions,
					{
						inheritAncestorOffsets: true,
						stationaryRootNodeIds: unarrangedNodeIds,
					},
				),
			);
			const nodePositions = translateDetachedSubtree(
				previousLayout,
				nextLayout,
				snapshot.nodePositions,
				detachedRootNodeId,
				targetPosition,
				{ baseNodePositions: rebasedNodePositions },
			);
			const detachedRootNodeIds = {
				...snapshot.detachedRootNodeIds,
				[addition.root.id]: true as const,
			};

			currentGraph = addition.graph;
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
		}

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
		const unarrangedNodeIds = new Set(
			classifyGraphLayoutNodeArrangement(
				previousLayout,
				snapshot.nodePositions,
			).unarrangedNodeIds,
		);

		const detachedRootNodeId = getGraphRootLayoutNodeId(targetRoot);

		unarrangedNodeIds.delete(detachedRootNodeId);
		currentUnarrangedNodeIds = unarrangedNodeIds;
		const nextLayout = createLayout(
			nextGraph,
			nextSnapshot,
			unarrangedNodeIds,
		);
		const nodePositions = rebaseReattachedSubtree(
			previousLayout,
			nextLayout,
			snapshot.nodePositions,
			detachedRootNodeId,
		);
		const detachedRootNodeIds = { ...snapshot.detachedRootNodeIds };

		delete detachedRootNodeIds[rootId];
		currentGraph = nextGraph;
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
			{ stationaryRootNodeIds: nextUnarrangedNodeIds },
		);

		if (arranged) {
			const arrangedPositions = rebaseArrangedSubtree(
				previousLayout,
				nextLayout,
				snapshot.nodePositions,
				nodePositions,
				nodeId,
			);
			const subtreeNodeIds = new Set([
				...collectGraphLayoutSubtreeNodeIds(previousLayout, nodeId),
				...collectGraphLayoutSubtreeNodeIds(nextLayout, nodeId),
			]);

			for (const subtreeNodeId of subtreeNodeIds) {
				const arrangedPosition = arrangedPositions[subtreeNodeId];

				if (arrangedPosition) {
					nodePositions[subtreeNodeId] = arrangedPosition;
				} else {
					delete nodePositions[subtreeNodeId];
				}
			}
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
			onDetachDrop: handleDetachDrop,
			onBacklinkClick: handleBacklinkClick,
			onRootContextClick: handleRootContextClick,
				onRootReattach: handleRootReattach,
				onNodeArrangementChange: handleNodeArrangementChange,
			resolveRootId: (rootNodeId) => currentGraph.roots.find(
				(root) => getGraphRootLayoutNodeId(root) === rootNodeId,
			)?.id,
		},
	);
	navigator = initializeGraphNavigator(
		overlayLayer,
		viewport,
		state,
		camera,
		initialLayout,
		{ onRootSelect: handleNavigatorRootSelect },
		getVisibleGraphArea,
	);
	syncNavigatorRoots();
	navigator.setWorkspaceGraph(workspaceGraph);
	const unsubscribeLayout = initializeGraphLayoutReflow(
		state,
		renderer,
		navigator,
		() => currentLayout,
		createCurrentLayout,
	);

	return {
		state,
		camera,
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
			const arrangement = classifyGraphLayoutNodeArrangement(
				previousLayout,
				snapshot.nodePositions,
			);
			currentUnarrangedNodeIds = new Set(arrangement.unarrangedNodeIds);
			const nextLayout = createLayout(
				nextGraph,
				nextSnapshot,
				currentUnarrangedNodeIds,
			);
			const scopedNodePositions = scopeDetachedNodePositions(
				nextLayout,
				snapshot.nodePositions,
			);
			const nodePositions = rebaseBacklinkNodePositions(
				nextLayout,
				rebaseNodePositions(
					previousLayout,
					nextLayout,
					scopedNodePositions,
					{ stationaryRootNodeIds: currentUnarrangedNodeIds },
				),
			);

			currentGraph = nextGraph;
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
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			reattachConfirmDialog.dispose();
			unsubscribeLayout();
			navigator.dispose();
			renderer.dispose();
			camera.dispose();
			viewport.remove();
		},
	};
}
