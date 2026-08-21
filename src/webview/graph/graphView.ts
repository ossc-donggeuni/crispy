import {
	initializeGraphCamera,
	type GraphCamera,
} from './graphCamera';
import { createGraphLayout, type GraphLayout } from './graphLayout';
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
	type GraphRootReattachRequest,
} from './graphRenderer';
import type { GraphDetachDropRequest } from './graphDetachDrag';
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
	/** 기존 View와 State를 유지하며 새로운 Workspace Graph를 적용한다. */
	updateGraph(graph: Graph): void;
	/** Navigator, Renderer, Camera와 생성한 Viewport DOM을 정리한다. */
	dispose(): void;
}

/** Graph View가 Renderer의 향후 Root Promotion 요청을 전달할 상위 계약이다. */
export interface GraphViewInteractions {
	/** 내부 Promotion 처리 뒤 Detach 완료 요청을 관찰하는 선택적 callback이다. */
	onDetachDrop?: (request: GraphDetachDropRequest) => void;
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

		renderedFileGroupPages = nextState.fileGroupPages;
		renderedOpenedFolders = nextState.openedFolders;
		renderedHiddenNodeIds = nextState.hiddenNodeIds;
		applyGraphLayout(renderer, navigator, createLayout(nextState));
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
): void {
	renderer.applyLayout(layout);
	navigator.setLayout(layout);
}

/**
 * Folder/File Detach 요청을 공통 Root 추가와 위치 저장으로 처리한다.
 * client 좌표는 Viewport local 좌표를 거쳐 기존 Camera 역변환을 사용한다.
 */
export function promoteToGraphRoot(
	graph: Graph,
	request: GraphDetachDropRequest,
	viewport: HTMLElement,
	camera: GraphCamera,
	state: GraphStateStore,
): Graph | undefined {
	const addition = addGraphRoot(graph, request.nodeId);

	if (!addition) {
		return undefined;
	}

	const bounds = viewport.getBoundingClientRect();
	const worldPosition = camera.viewportToWorld({
		x: request.clientX - bounds.left,
		y: request.clientY - bounds.top,
	});
	const snapshot = state.getState();

	state.setState({
		camera: snapshot.camera,
		nodePositions: {
			...snapshot.nodePositions,
			[request.nodeId]: worldPosition,
		},
		fileGroupPages: snapshot.fileGroupPages,
		openedFolders: snapshot.openedFolders,
		detachedRootNodeIds: {
			...snapshot.detachedRootNodeIds,
			[request.nodeId]: true,
		},
	});

	return addition.graph;
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
	const initialGraphState = state.getState();
	let workspaceGraph = graph;
	let currentGraph = applyDetachedGraphRoots(
		workspaceGraph,
		initialGraphState.detachedRootNodeIds,
	);
	const camera = initializeGraphCamera(viewport, world, state);
	let renderer: GraphRenderer;
	let navigator: GraphNavigator;
	let currentLayout: GraphLayout;
	const syncNavigatorRoots = (): void => {
		navigator.setRoots(createGraphNavigatorRoots(currentGraph));
	};
	const createCurrentLayout = (snapshot: GraphStateSnapshot): GraphLayout => {
		currentLayout = createGraphLayout(currentGraph, {
			fileGroupPages: snapshot.fileGroupPages,
			openedFolders: snapshot.openedFolders,
			hiddenNodeIds: snapshot.hiddenNodeIds,
		});

		return currentLayout;
	};
	const applyCurrentLayout = (snapshot: GraphStateSnapshot): void => {
		applyGraphLayout(renderer, navigator, createCurrentLayout(snapshot));
	};
	const handleDetachDrop = (request: GraphDetachDropRequest): void => {
		const nextGraph = promoteToGraphRoot(
			currentGraph,
			request,
			viewport,
			camera,
			state,
		);

		if (nextGraph) {
			currentGraph = nextGraph;
			applyCurrentLayout(state.getState());
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

		currentGraph = nextGraph;
		const snapshot = state.getState();
		const nodePositions = { ...snapshot.nodePositions };
		const detachedRootNodeIds = { ...snapshot.detachedRootNodeIds };

		delete nodePositions[nodeId];
		delete detachedRootNodeIds[nodeId];
		state.setState({
			camera: snapshot.camera,
			nodePositions,
			fileGroupPages: snapshot.fileGroupPages,
			openedFolders: snapshot.openedFolders,
			detachedRootNodeIds,
		});
		applyCurrentLayout(state.getState());
		syncNavigatorRoots();
		return true;
	};
	const initialLayout = createCurrentLayout(initialGraphState);

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
	);
	syncNavigatorRoots();
	navigator.setWorkspaceGraph(workspaceGraph);
	let disposed = false;
	const unsubscribeLayout = initializeGraphLayoutReflow(
		state,
		renderer,
		navigator,
		createCurrentLayout,
	);

	return {
		state,
		camera,
		updateGraph(graph): void {
			if (disposed) {
				return;
			}

			const snapshot = state.getState();

			workspaceGraph = graph;
			currentGraph = applyDetachedGraphRoots(
				workspaceGraph,
				snapshot.detachedRootNodeIds,
			);
			applyCurrentLayout(snapshot);
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
