import {
	initializeGraphCamera,
	type GraphCamera,
} from './graphCamera';
import { createGraphLayout, type GraphLayout } from './graphLayout';
import {
	collectGraphLayoutSubtreeNodeIds,
	classifyGraphLayoutNodeArrangement,
	rebaseArrangedSubtree,
	rebaseNodePositions,
	rebaseReattachedSubtree,
	translateDetachedSubtree,
} from './graphLayoutTransition';
import type { Graph } from './graphModel';
import {
	addGraphRoot,
	applyDetachedGraphRoots,
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
} from './graphRenderer';
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

	const rootNode = layout.nodes.find((node) => node.id === targetRoot.nodeId);

	if (!rootNode) {
		return false;
	}

	const rootPosition = state.getState().nodePositions[targetRoot.nodeId]
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
	const state = createGraphState(initialState);
	let initialGraphState = state.getState();
	let workspaceGraph = graph;
	let currentGraph = applyDetachedGraphRoots(
		workspaceGraph,
		initialGraphState.detachedRootNodeIds,
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
	const initialBaselineLayout = createLayout(currentGraph, initialGraphState);
	state.setState({
		camera: initialGraphState.camera,
		nodePositions: rebaseBacklinkNodePositions(
			initialBaselineLayout,
			initialGraphState.nodePositions,
		),
		fileGroupPages: initialGraphState.fileGroupPages,
		openedFolders: initialGraphState.openedFolders,
		detachedRootNodeIds: initialGraphState.detachedRootNodeIds,
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
		const addition = addGraphRoot(currentGraph, request.nodeId);

		if (addition) {
			const snapshot = state.getState();
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

			unarrangedNodeIds.add(request.nodeId);
			currentUnarrangedNodeIds = unarrangedNodeIds;
			const nextLayout = createLayout(
				addition.graph,
				snapshot,
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
				request.nodeId,
				targetPosition,
				{ baseNodePositions: rebasedNodePositions },
			);
			const detachedRootNodeIds = {
				...snapshot.detachedRootNodeIds,
				[request.nodeId]: true as const,
			};

			currentGraph = addition.graph;
			currentLayout = nextLayout;
			applyGraphLayout(renderer, navigator, nextLayout, nodePositions);
			state.setState({
				camera: snapshot.camera,
				nodePositions,
				fileGroupPages: snapshot.fileGroupPages,
				openedFolders: snapshot.openedFolders,
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
	const handleRootReattach = ({
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
		const previousLayout = currentLayout;
		const unarrangedNodeIds = new Set(
			classifyGraphLayoutNodeArrangement(
				previousLayout,
				snapshot.nodePositions,
			).unarrangedNodeIds,
		);

		unarrangedNodeIds.delete(nodeId);
		currentUnarrangedNodeIds = unarrangedNodeIds;
		const nextLayout = createLayout(
			nextGraph,
			snapshot,
			unarrangedNodeIds,
		);
		const nodePositions = rebaseReattachedSubtree(
			previousLayout,
			nextLayout,
			snapshot.nodePositions,
			nodeId,
		);
		const detachedRootNodeIds = { ...snapshot.detachedRootNodeIds };

		delete detachedRootNodeIds[nodeId];
		currentGraph = nextGraph;
		currentLayout = nextLayout;
		applyGraphLayout(renderer, navigator, nextLayout, nodePositions);
		state.setState({
			camera: snapshot.camera,
			nodePositions,
			fileGroupPages: snapshot.fileGroupPages,
			openedFolders: snapshot.openedFolders,
			detachedRootNodeIds,
			hiddenNodeIds: snapshot.hiddenNodeIds,
		});
		syncNavigatorRoots();
		return true;
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
				(root) => root.nodeId === rootNodeId,
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
	let disposed = false;
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
			const previousLayout = currentLayout;
			const arrangement = classifyGraphLayoutNodeArrangement(
				previousLayout,
				snapshot.nodePositions,
			);
			currentUnarrangedNodeIds = new Set(arrangement.unarrangedNodeIds);
			const nextLayout = createLayout(
				nextGraph,
				snapshot,
				currentUnarrangedNodeIds,
			);
			const nodePositions = rebaseBacklinkNodePositions(
				nextLayout,
				rebaseNodePositions(
					previousLayout,
					nextLayout,
					snapshot.nodePositions,
					{ stationaryRootNodeIds: currentUnarrangedNodeIds },
				),
			);

			currentGraph = nextGraph;
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
			syncNavigatorRoots();
			navigator.setWorkspaceGraph(workspaceGraph);
		},
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			unsubscribeLayout();
			navigator.dispose();
			renderer.dispose();
			camera.dispose();
			viewport.remove();
		},
	};
}
