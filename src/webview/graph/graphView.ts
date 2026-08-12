export interface GraphView {
	dispose(): void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Graph가 렌더링될 기본 DOM 계층을 생성한다.
 *
 * @param root Graph View를 마운트할 요소
 * @returns 생성한 Graph View를 정리할 수 있는 핸들
 */
export function initializeGraphView(root: HTMLElement): GraphView {
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

	let disposed = false;

	return {
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			viewport.remove();
		},
	};
}
