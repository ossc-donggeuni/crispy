import {
	initializeGraphCamera,
	type GraphCamera,
} from './graphCamera';
import { createGraphLayout } from './graphLayout';
import { GRAPH_MOCK_PROJECT } from './graphMockData';
import { initializeGraphNavigator } from './graphNavigator';
import { initializeGraphRenderer } from './graphRenderer';
import {
	createGraphState,
	INITIAL_GRAPH_STATE,
	type GraphState,
	type GraphStateStore,
} from './graphState';

/** Graph DOM 계층과 State, Camera lifecycle을 하나로 제공한다. */
export interface GraphView {
	/** Camera와 사용자 Node 위치를 관리하는 단일 Graph State Store다. */
	readonly state: GraphStateStore;
	/** Pan/Zoom과 Viewport/World 좌표 변환을 제공하는 Camera다. */
	readonly camera: GraphCamera;
	/** Navigator, Renderer, Camera와 생성한 Viewport DOM을 정리한다. */
	dispose(): void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Graph가 렌더링될 Viewport, World, Edge/Node/Overlay Layer를 생성하고
 * Mock Project 기반 Layout, Renderer, Camera, Navigator를 초기화한다.
 *
 * @param root Graph View를 마운트할 요소
 * @param initialState 복원할 초기 Graph 상태
 * @returns State와 Camera 및 전체 lifecycle을 제공하는 Graph View
 */
export function initializeGraphView(
	root: HTMLElement,
	initialState: GraphState = INITIAL_GRAPH_STATE,
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
	const camera = initializeGraphCamera(viewport, world, state);
	const renderer = initializeGraphRenderer(
		edgeLayer,
		nodeLayer,
		createGraphLayout(GRAPH_MOCK_PROJECT),
		state,
	);
	const navigator = initializeGraphNavigator(overlayLayer, viewport, state, camera);

	let disposed = false;

	return {
		state,
		camera,
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			navigator.dispose();
			renderer.dispose();
			camera.dispose();
			viewport.remove();
		},
	};
}
