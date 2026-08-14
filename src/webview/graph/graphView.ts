import {
	initializeGraphCamera,
	type GraphCamera,
} from './graphCamera';
import {
	createGraphState,
	INITIAL_GRAPH_STATE,
	type GraphState,
	type GraphStateStore,
} from './graphState';

export interface GraphView {
	readonly state: GraphStateStore;
	readonly camera: GraphCamera;
	dispose(): void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Graph가 렌더링될 기본 DOM 계층을 생성한다.
 *
 * @param root Graph View를 마운트할 요소
 * @param initialState 복원할 초기 Graph 상태
 * @returns 생성한 Graph View를 정리할 수 있는 핸들
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

	let disposed = false;

	return {
		state,
		camera,
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			camera.dispose();
			viewport.remove();
		},
	};
}
