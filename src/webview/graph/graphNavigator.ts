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
const ROOT_LIST_LABEL = '활성화된 루트 목록';
const ROOT_LIST_PANEL_ID = 'graph-navigator-root-list-panel';
const ROOT_LIST_PANEL_TITLE_ID = 'graph-navigator-root-list-title';
const ROOT_LIST_ICON_ASSET = 'navigator-root.svg';

/** Action Rail에 추가할 Navigator Action의 공통 DOM 계약이다. */
interface NavigatorActionDefinition {
	readonly label: string;
	readonly controlsId: string;
	readonly iconAsset: string;
	readonly onActivate: () => void;
}

/** 접근성, Tooltip과 Icon 식별자를 공통으로 적용한 Action Button을 생성한다. */
function createNavigatorActionButton(
	ownerDocument: Document,
	definition: NavigatorActionDefinition,
): {
	button: HTMLButtonElement;
	icon: HTMLSpanElement;
	dispose(): void;
} {
	const button = ownerDocument.createElement('button');
	const icon = ownerDocument.createElement('span');

	button.className = 'graph-navigator-action-button';
	button.type = 'button';
	button.title = definition.label;
	button.setAttribute('aria-label', definition.label);
	button.setAttribute('aria-controls', definition.controlsId);
	button.setAttribute('aria-expanded', 'false');
	icon.className = 'graph-navigator-action-icon';
	icon.setAttribute('data-navigator-icon', definition.iconAsset);
	icon.setAttribute('aria-hidden', 'true');
	button.append(icon);
	button.addEventListener('click', definition.onActivate);

	return {
		button,
		icon,
		dispose: () => {
			button.removeEventListener('click', definition.onActivate);
		},
	};
}

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
	const featureRow = ownerDocument.createElement('div');
	const rootListPanel = ownerDocument.createElement('section');
	const rootListTitle = ownerDocument.createElement('h2');
	const actionRail = ownerDocument.createElement('div');
	const coordinate = ownerDocument.createElement('div');
	const controls = ownerDocument.createElement('div');
	const zoomOutButton = ownerDocument.createElement('button');
	const scale = ownerDocument.createElement('span');
	const zoomInButton = ownerDocument.createElement('button');

	navigator.className = 'graph-navigator';
	featureRow.className = 'graph-navigator-feature-row';
	rootListPanel.className = 'graph-navigator-root-list-panel';
	rootListPanel.id = ROOT_LIST_PANEL_ID;
	rootListPanel.hidden = true;
	rootListPanel.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE, '');
	rootListPanel.setAttribute('aria-labelledby', ROOT_LIST_PANEL_TITLE_ID);
	rootListTitle.className = 'graph-navigator-root-list-title';
	rootListTitle.id = ROOT_LIST_PANEL_TITLE_ID;
	rootListTitle.textContent = ROOT_LIST_LABEL;
	rootListPanel.append(rootListTitle);
	actionRail.className = 'graph-navigator-action-rail';
	actionRail.setAttribute('role', 'toolbar');
	actionRail.setAttribute('aria-label', 'Navigator actions');
	actionRail.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE, '');
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

	let rootListOpen = false;
	let rootListButton: HTMLButtonElement;
	const renderRootListState = (): void => {
		rootListPanel.hidden = !rootListOpen;
		rootListButton.setAttribute('aria-expanded', String(rootListOpen));
		if (rootListOpen) {
			rootListButton.classList.add('is-active');
		} else {
			rootListButton.classList.remove('is-active');
		}
	};
	const handleRootListToggle = (): void => {
		rootListOpen = !rootListOpen;
		renderRootListState();
	};
	const rootListAction = createNavigatorActionButton(ownerDocument, {
		label: ROOT_LIST_LABEL,
		controlsId: ROOT_LIST_PANEL_ID,
		iconAsset: ROOT_LIST_ICON_ASSET,
		onActivate: handleRootListToggle,
	});
	const navigatorActions = [rootListAction];

	rootListButton = rootListAction.button;
	actionRail.append(...navigatorActions.map((action) => action.button));
	featureRow.append(rootListPanel, actionRail);
	controls.append(zoomOutButton, scale, zoomInButton);
	navigator.append(coordinate, controls, featureRow);
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
	renderRootListState();
	render();

	let disposed = false;

	return {
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			unsubscribeState();
			for (const action of navigatorActions) {
				action.dispose();
			}
			zoomOutButton.removeEventListener('click', handleZoomOut);
			zoomInButton.removeEventListener('click', handleZoomIn);
			navigator.remove();
		},
	};
}
