import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	type GraphCamera,
} from './graphCamera';
import { resolveFileIcon } from './fileIconResolver';
import type { GraphLayout } from './graphLayout';
import type { GraphNavigatorRoot } from './graphNavigatorRoots';
import type {
	GraphStateSnapshot,
	GraphStateStore,
} from './graphState';

export interface GraphNavigator {
	/** Minimap이 사용할 최신 Renderer Layout reference를 교체한다. */
	setLayout(layout: GraphLayout): void;
	/** 전달받은 표시 데이터 순서대로 Root List Panel 내용을 교체한다. */
	setRoots(roots: readonly GraphNavigatorRoot[]): void;
	dispose(): void;
}

/** Navigator의 사용자 선택을 Graph 해석 없이 상위 계층에 전달한다. */
export interface GraphNavigatorInteractions {
	onRootSelect?: (rootId: string) => void;
}

const NAVIGATOR_ZOOM_STEP = 0.1;
const ROOT_LIST_LABEL = '활성화된 루트 목록';
const ROOT_LIST_PANEL_ID = 'graph-navigator-root-list-panel';
const ROOT_LIST_PANEL_TITLE_ID = 'graph-navigator-root-list-title';
const ROOT_LIST_ICON_ASSET = 'navigator-root.svg';
const ROOT_LIST_EMPTY_LABEL = '활성화된 루트가 없습니다.';
const PROJECT_ROOT_ICON_ASSET = 'folder-open.svg';
const FOLDER_ROOT_ICON_ASSET = 'folder-closed.svg';

/** Action Rail에 추가할 Navigator Action의 공통 DOM 계약이다. */
interface NavigatorActionDefinition {
	readonly label: string;
	readonly controlsId: string;
	readonly iconAsset: string;
	readonly onActivate: () => void;
}

/** Root Item DOM과 해당 Item에만 연결된 Listener lifecycle이다. */
interface NavigatorRootListItem {
	readonly element: HTMLLIElement;
	dispose(): void;
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

/** Navigator 표시 데이터 하나를 선택 가능한 Root Button으로 만든다. */
function createRootListItem(
	ownerDocument: Document,
	root: GraphNavigatorRoot,
	onRootSelect: GraphNavigatorInteractions['onRootSelect'],
): NavigatorRootListItem {
	const item = ownerDocument.createElement('li');
	const button = ownerDocument.createElement('button');
	const icon = ownerDocument.createElement('span');
	const content = ownerDocument.createElement('div');
	const name = ownerDocument.createElement('span');
	const displayName = root.kind === 'folder' ? `${root.name}/` : root.name;
	const rootId = root.rootId;
	const handleSelect = (): void => {
		onRootSelect?.(rootId);
	};

	item.className = 'graph-navigator-root-item';
	button.className = 'graph-navigator-root-button';
	button.type = 'button';
	button.setAttribute('aria-label', displayName);
	icon.className = 'graph-navigator-root-icon';
	icon.setAttribute('aria-hidden', 'true');
	if (root.kind === 'file') {
		icon.classList.add('graph-file-icon');
		icon.setAttribute('data-file-icon', resolveFileIcon(root.name));
	} else {
		icon.setAttribute(
			'data-folder-icon',
			root.kind === 'project'
				? PROJECT_ROOT_ICON_ASSET
				: FOLDER_ROOT_ICON_ASSET,
		);
	}
	content.className = 'graph-navigator-root-content';
	name.className = 'graph-navigator-root-name';
	name.textContent = displayName;
	name.title = displayName;
	content.append(name);

	if (root.relativePath) {
		const path = ownerDocument.createElement('span');

		path.className = 'graph-navigator-root-path';
		path.textContent = root.relativePath;
		path.title = root.relativePath;
		content.append(path);
	}

	button.append(icon, content);
	item.append(button);
	button.addEventListener('click', handleSelect);

	return {
		element: item,
		dispose: () => {
			button.removeEventListener('click', handleSelect);
		},
	};
}

/**
 * Overlay에 Minimap 영역, Camera 좌표와 Zoom Control을 생성하고 Graph State와 동기화한다.
 *
 * @param overlayLayer Navigator를 배치할 Graph Overlay Layer
 * @param viewport 중앙 Zoom 기준을 제공하는 Graph Viewport
 * @param graphState Camera 표시를 구독할 기존 Graph State Store
 * @param camera 중앙 기준 Zoom을 수행할 기존 Graph Camera
 * @param initialLayout Minimap에 전달할 Renderer와 동일한 초기 Layout
 * @param interactions Root 선택을 상위 계층에 전달할 callback
 * @returns Listener, State 구독 및 DOM을 정리할 lifecycle 핸들
 */
export function initializeGraphNavigator(
	overlayLayer: HTMLElement,
	viewport: HTMLElement,
	graphState: GraphStateStore,
	camera: GraphCamera,
	initialLayout: GraphLayout,
	interactions: GraphNavigatorInteractions = {},
): GraphNavigator {
	const ownerDocument = overlayLayer.ownerDocument;
	const navigator = ownerDocument.createElement('div');
	const featureRow = ownerDocument.createElement('div');
	const rootListPanel = ownerDocument.createElement('section');
	const rootListTitle = ownerDocument.createElement('h2');
	const rootList = ownerDocument.createElement('ul');
	const rootListEmpty = ownerDocument.createElement('p');
	const actionRail = ownerDocument.createElement('div');
	const bottomRow = ownerDocument.createElement('div');
	const minimap = ownerDocument.createElement('div');
	const zoom = ownerDocument.createElement('div');
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
	rootList.className = 'graph-navigator-root-list';
	rootList.hidden = true;
	rootListEmpty.className = 'graph-navigator-root-empty';
	rootListEmpty.textContent = ROOT_LIST_EMPTY_LABEL;
	rootListPanel.append(rootListTitle, rootList, rootListEmpty);
	actionRail.className = 'graph-navigator-action-rail';
	actionRail.setAttribute('role', 'toolbar');
	actionRail.setAttribute('aria-label', 'Navigator actions');
	actionRail.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE, '');
	bottomRow.className = 'graph-navigator-bottom-row';
	minimap.className = 'graph-navigator-minimap';
	minimap.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE, '');
	minimap.setAttribute('aria-hidden', 'true');
	zoom.className = 'graph-navigator-zoom';
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
	let renderedRootItems: NavigatorRootListItem[] = [];
	const disposeRootItems = (): void => {
		for (const item of renderedRootItems) {
			item.dispose();
			item.element.remove();
		}
		renderedRootItems = [];
	};

	rootListButton = rootListAction.button;
	actionRail.append(...navigatorActions.map((action) => action.button));
	featureRow.append(rootListPanel, actionRail);
	controls.append(zoomOutButton, scale, zoomInButton);
	zoom.append(coordinate, controls);
	bottomRow.append(minimap, zoom);
	navigator.append(bottomRow, featureRow);
	overlayLayer.append(navigator);
	const minimapState: { layout?: GraphLayout } = { layout: initialLayout };

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
		setLayout(layout): void {
			if (disposed) {
				return;
			}

			minimapState.layout = layout;
		},
		setRoots(roots): void {
			if (disposed) {
				return;
			}

			disposeRootItems();
			renderedRootItems = roots.map((root) => (
				createRootListItem(ownerDocument, root, interactions.onRootSelect)
			));
			rootList.append(...renderedRootItems.map((item) => item.element));
			rootList.hidden = renderedRootItems.length === 0;
			rootListEmpty.hidden = renderedRootItems.length > 0;
		},
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			minimapState.layout = undefined;
			unsubscribeState();
			disposeRootItems();
			for (const action of navigatorActions) {
				action.dispose();
			}
			zoomOutButton.removeEventListener('click', handleZoomOut);
			zoomInButton.removeEventListener('click', handleZoomIn);
			navigator.remove();
		},
	};
}
