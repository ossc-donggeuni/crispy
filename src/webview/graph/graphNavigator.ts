import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	type GraphCamera,
} from './graphCamera';
import type {
	GraphStateSnapshot,
	GraphStateStore,
} from './graphState';

export interface GraphNavigator {
	dispose(): void;
}

const NAVIGATOR_ZOOM_STEP = 0.1;

/**
 * Overlay에 Camera 좌표와 Zoom Control을 생성하고 Graph State와 동기화한다.
 *
 * @param overlayLayer Navigator를 배치할 Graph Overlay Layer
 * @param viewport 중앙 Zoom 기준을 제공하는 Graph Viewport
 * @param graphState Camera 표시를 구독할 기존 Graph State Store
 * @param camera 중앙 기준 Zoom을 수행할 기존 Graph Camera
 * @returns Listener, State 구독 및 DOM을 정리할 lifecycle 핸들
 */
export function initializeGraphNavigator(
	overlayLayer: HTMLElement,
	viewport: HTMLElement,
	graphState: GraphStateStore,
	camera: GraphCamera,
): GraphNavigator {
	const ownerDocument = overlayLayer.ownerDocument;
	const navigator = ownerDocument.createElement('div');
	const coordinate = ownerDocument.createElement('div');
	const controls = ownerDocument.createElement('div');
	const zoomOutButton = ownerDocument.createElement('button');
	const scale = ownerDocument.createElement('span');
	const zoomInButton = ownerDocument.createElement('button');

	navigator.className = 'graph-navigator';
	coordinate.className = 'graph-navigator-coordinate';
	controls.className = 'graph-navigator-controls';
	controls.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE, '');
	zoomOutButton.className = 'graph-navigator-button';
	zoomOutButton.type = 'button';
	zoomOutButton.setAttribute('aria-label', 'Zoom out');
	zoomOutButton.textContent = '−';
	scale.className = 'graph-navigator-scale';
	zoomInButton.className = 'graph-navigator-button';
	zoomInButton.type = 'button';
	zoomInButton.setAttribute('aria-label', 'Zoom in');
	zoomInButton.textContent = '+';

	controls.append(zoomOutButton, scale, zoomInButton);
	navigator.append(coordinate, controls);
	overlayLayer.append(navigator);

	const render = (state: GraphStateSnapshot = graphState.getState()): void => {
		coordinate.textContent = `(${Math.round(state.camera.x)}, ${Math.round(state.camera.y)})`;
		scale.textContent = `${Math.round(state.camera.scale * 100)}%`;
	};

	const zoomBy = (scaleDelta: number): void => {
		const currentScale = graphState.getState().camera.scale;

		camera.setScaleAt(currentScale + scaleDelta, {
			x: viewport.clientWidth / 2,
			y: viewport.clientHeight / 2,
		});
	};

	const handleZoomOut = (): void => {
		zoomBy(-NAVIGATOR_ZOOM_STEP);
	};
	const handleZoomIn = (): void => {
		zoomBy(NAVIGATOR_ZOOM_STEP);
	};

	zoomOutButton.addEventListener('click', handleZoomOut);
	zoomInButton.addEventListener('click', handleZoomIn);
	const unsubscribeState = graphState.subscribe(render);
	render();

	let disposed = false;

	return {
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			unsubscribeState();
			zoomOutButton.removeEventListener('click', handleZoomOut);
			zoomInButton.removeEventListener('click', handleZoomIn);
			navigator.remove();
		},
	};
}
