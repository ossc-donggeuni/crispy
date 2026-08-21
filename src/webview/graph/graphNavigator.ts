import {
	createCenteredGraphCameraState,
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	type GraphCamera,
	type GraphCameraState,
	type GraphViewportSize,
} from './graphCamera';
import { resolveFileIcon } from './fileIconResolver';
import type { GraphLayout } from './graphLayout';
import {
	calculateCameraWorldBounds,
	calculateMinimapWorldDelta,
	clientToMinimapPoint,
	createMinimapGraphGeometry,
	createMinimapViewportGeometry,
	type MinimapPoint,
	type MinimapProjection,
	type MinimapSize,
	type MinimapViewportGeometry,
} from './graphNavigatorMinimap';
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
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MINIMAP_NODE_MIN_SIZE = 2;

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

/** Indicator Pointer Drag 시작 시점의 Camera와 Projection을 고정한 session이다. */
interface MinimapViewportDragSession {
	readonly pointerId: number;
	readonly projection: MinimapProjection;
	readonly minimapSize: MinimapSize;
	readonly startMinimapPoint: MinimapPoint;
	readonly startWorldCenter: MinimapPoint;
	readonly startCamera: GraphCameraState;
	readonly viewportSize: GraphViewportSize;
	didDrag: boolean;
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
	const minimapSvg = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
	const minimapEdgeLayer = ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
	const minimapNodeLayer = ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
	const minimapViewportLayer = ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
	const minimapViewportIndicator = ownerDocument.createElementNS(
		SVG_NAMESPACE,
		'rect',
	);
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
	minimap.setAttribute('role', 'region');
	minimap.setAttribute('aria-label', 'Graph minimap navigation');
	minimapSvg.classList.add('graph-navigator-minimap-svg');
	minimapSvg.setAttribute('focusable', 'false');
	minimapSvg.setAttribute('pointer-events', 'all');
	minimapEdgeLayer.classList.add('graph-navigator-minimap-edge-layer');
	minimapEdgeLayer.setAttribute('aria-hidden', 'true');
	minimapNodeLayer.classList.add('graph-navigator-minimap-node-layer');
	minimapNodeLayer.setAttribute('aria-hidden', 'true');
	minimapViewportLayer.classList.add('graph-navigator-minimap-viewport-layer');
	minimapViewportIndicator.classList.add(
		'graph-navigator-minimap-viewport-indicator',
	);
	minimapViewportIndicator.setAttribute('pointer-events', 'all');
	minimapViewportIndicator.setAttribute(
		'aria-label',
		'Current graph viewport; drag to pan',
	);
	minimapViewportIndicator.setAttribute('visibility', 'hidden');
	minimapViewportIndicator.setAttribute('rx', '2');
	minimapViewportLayer.append(minimapViewportIndicator);
	minimapSvg.append(minimapEdgeLayer, minimapNodeLayer, minimapViewportLayer);
	minimap.append(minimapSvg);
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
	let currentLayout: GraphLayout | undefined = initialLayout;
	const initialGraphState = graphState.getState();
	let renderedNodePositions = initialGraphState.nodePositions;
	let renderedCamera = initialGraphState.camera;
	let currentMinimapProjection: MinimapProjection | undefined;
	let currentMinimapSize: MinimapSize | undefined;
	let currentMinimapViewportGeometry: MinimapViewportGeometry | undefined;
	let viewportDrag: MinimapViewportDragSession | undefined;
	let suppressNextMinimapClick = false;
	let disposed = false;

	/** 캐시된 Graph Projection만 사용해 현재 Camera Viewport Rect attribute를 갱신한다. */
	const renderMinimapViewportIndicator = (): void => {
		if (disposed || !currentMinimapProjection || !currentMinimapSize) {
			currentMinimapViewportGeometry = undefined;
			minimapViewportIndicator.setAttribute('visibility', 'hidden');
			return;
		}

		const worldBounds = calculateCameraWorldBounds(camera, {
			width: viewport.clientWidth,
			height: viewport.clientHeight,
		});
		const geometry = worldBounds
			? createMinimapViewportGeometry(
				worldBounds,
				currentMinimapProjection,
				currentMinimapSize,
			)
			: undefined;

		if (!geometry) {
			currentMinimapViewportGeometry = undefined;
			minimapViewportIndicator.setAttribute('visibility', 'hidden');
			return;
		}

		currentMinimapViewportGeometry = geometry;
		minimapViewportIndicator.setAttribute('x', String(geometry.x));
		minimapViewportIndicator.setAttribute('y', String(geometry.y));
		minimapViewportIndicator.setAttribute('width', String(geometry.width));
		minimapViewportIndicator.setAttribute('height', String(geometry.height));
		minimapViewportIndicator.removeAttribute('visibility');
	};

	/** 최신 Layout/저장 위치로 Graph Projection과 Graphic을 교체한 뒤 Indicator도 맞춘다. */
	const renderMinimapGraph = (
		state: GraphStateSnapshot = graphState.getState(),
	): void => {
		minimapEdgeLayer.replaceChildren();
		minimapNodeLayer.replaceChildren();
		currentMinimapProjection = undefined;
		currentMinimapSize = undefined;
		currentMinimapViewportGeometry = undefined;

		if (!currentLayout || minimap.clientWidth <= 0 || minimap.clientHeight <= 0) {
			renderMinimapViewportIndicator();
			return;
		}

		const minimapSize = {
			width: minimap.clientWidth,
			height: minimap.clientHeight,
		};
		minimapSvg.setAttribute(
			'viewBox',
			`0 0 ${minimapSize.width} ${minimapSize.height}`,
		);
		const geometry = createMinimapGraphGeometry(
			currentLayout,
			state.nodePositions,
			minimapSize,
		);

		if (!geometry) {
			renderMinimapViewportIndicator();
			return;
		}

		currentMinimapProjection = geometry.projection;
		currentMinimapSize = minimapSize;

		for (const edge of geometry.edges) {
			const line = ownerDocument.createElementNS(SVG_NAMESPACE, 'line');

			line.classList.add('graph-navigator-minimap-edge');
			line.setAttribute('data-graph-edge-id', edge.id);
			line.setAttribute('x1', String(edge.source.x));
			line.setAttribute('y1', String(edge.source.y));
			line.setAttribute('x2', String(edge.target.x));
			line.setAttribute('y2', String(edge.target.y));
			minimapEdgeLayer.append(line);
		}

		for (const node of geometry.nodes) {
			const rect = ownerDocument.createElementNS(SVG_NAMESPACE, 'rect');
			const width = Math.max(MINIMAP_NODE_MIN_SIZE, node.width);
			const height = Math.max(MINIMAP_NODE_MIN_SIZE, node.height);

			rect.classList.add('graph-navigator-minimap-node');
			rect.setAttribute('data-graph-node-id', node.id);
			rect.setAttribute('x', String(node.x - (width - node.width) / 2));
			rect.setAttribute('y', String(node.y - (height - node.height) / 2));
			rect.setAttribute('width', String(width));
			rect.setAttribute('height', String(height));
			rect.setAttribute('rx', String(Math.min(1.5, width / 2, height / 2)));
			minimapNodeLayer.append(rect);
		}

		renderMinimapViewportIndicator();
	};

	/** Pointer client 좌표를 현재 SVG viewBox 기준 Minimap 좌표로 변환한다. */
	const resolveMinimapPoint = (
		clientX: number,
		clientY: number,
		minimapSize: MinimapSize,
	): MinimapPoint | undefined => {
		const bounds = minimapSvg.getBoundingClientRect();

		return clientToMinimapPoint(
			{ x: clientX, y: clientY },
			{
				left: bounds.left,
				top: bounds.top,
				width: bounds.width,
				height: bounds.height,
			},
			minimapSize,
		);
	};

	/** Minimap 내부 좌표인지 확인해 Background Click의 외부 입력을 거부한다. */
	const isInsideMinimap = (point: MinimapPoint, size: MinimapSize): boolean => (
		point.x >= 0
		&& point.y >= 0
		&& point.x <= size.width
		&& point.y <= size.height
	);

	/** 활성 Indicator Drag와 Pointer Capture 및 표시 상태를 정리한다. */
	const stopViewportDrag = (pointerId: number, releaseCapture: boolean): void => {
		viewportDrag = undefined;
		minimapViewportIndicator.classList.remove('is-dragging');

		if (
			releaseCapture
			&& minimapViewportIndicator.hasPointerCapture(pointerId)
		) {
			minimapViewportIndicator.releasePointerCapture(pointerId);
		}
	};

	/** Minimap Background Click을 World 좌표로 역투영해 기존 Camera Focus에 전달한다. */
	const handleMinimapClick = (event: MouseEvent): void => {
		if (suppressNextMinimapClick) {
			suppressNextMinimapClick = false;
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		if (
			disposed
			|| viewportDrag
			|| event.target === minimapViewportIndicator
			|| !currentMinimapProjection
			|| !currentMinimapSize
		) {
			return;
		}

		const point = resolveMinimapPoint(
			event.clientX,
			event.clientY,
			currentMinimapSize,
		);

		if (!point || !isInsideMinimap(point, currentMinimapSize)) {
			return;
		}

		let worldPoint: MinimapPoint;

		try {
			worldPoint = currentMinimapProjection.minimapToWorld(point);
		} catch {
			return;
		}

		if (!Number.isFinite(worldPoint.x) || !Number.isFinite(worldPoint.y)) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		camera.focusOn(worldPoint);
	};

	/** 새 Background Pointer 입력은 이전 Drag의 Click 억제 표시를 버린다. */
	const handleMinimapPointerDown = (event: PointerEvent): void => {
		if (event.target !== minimapViewportIndicator) {
			suppressNextMinimapClick = false;
		}
	};

	/** 유효한 기본 Pointer로 현재 Indicator와 Camera 중심을 고정해 Drag를 시작한다. */
	const handleViewportPointerDown = (event: PointerEvent): void => {
		if (
			disposed
			|| viewportDrag
			|| !event.isPrimary
			|| event.button !== 0
			|| !currentMinimapProjection
			|| !currentMinimapSize
			|| !currentMinimapViewportGeometry
			|| currentMinimapViewportGeometry.width <= 0
			|| currentMinimapViewportGeometry.height <= 0
			|| viewport.clientWidth <= 0
			|| viewport.clientHeight <= 0
		) {
			return;
		}

		const startMinimapPoint = resolveMinimapPoint(
			event.clientX,
			event.clientY,
			currentMinimapSize,
		);

		if (!startMinimapPoint) {
			return;
		}

		const startWorldCenter = camera.viewportToWorld({
			x: viewport.clientWidth / 2,
			y: viewport.clientHeight / 2,
		});

		if (
			!Number.isFinite(startWorldCenter.x)
			|| !Number.isFinite(startWorldCenter.y)
		) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		const startCamera = camera.getState();

		viewportDrag = {
			pointerId: event.pointerId,
			projection: currentMinimapProjection,
			minimapSize: currentMinimapSize,
			startMinimapPoint,
			startWorldCenter,
			startCamera,
			viewportSize: {
				width: viewport.clientWidth,
				height: viewport.clientHeight,
			},
			didDrag: false,
		};
		suppressNextMinimapClick = false;
		minimapViewportIndicator.classList.add('is-dragging');
		minimapViewportIndicator.setPointerCapture(event.pointerId);
		camera.setState(startCamera);
	};

	/** Pointer의 Minimap World 이동량만큼 Camera 중심을 옮기고 즉시 State에 반영한다. */
	const handleViewportPointerMove = (event: PointerEvent): void => {
		const drag = viewportDrag;

		if (!drag || event.pointerId !== drag.pointerId) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		const point = resolveMinimapPoint(
			event.clientX,
			event.clientY,
			drag.minimapSize,
		);
		const delta = point
			? calculateMinimapWorldDelta(
				drag.projection,
				drag.startMinimapPoint,
				point,
			)
			: undefined;

		if (!delta) {
			return;
		}

		const nextState = createCenteredGraphCameraState(
			{
				x: drag.startWorldCenter.x + delta.x,
				y: drag.startWorldCenter.y + delta.y,
			},
			drag.viewportSize,
			drag.startCamera.scale,
		);

		if (!nextState) {
			return;
		}

		drag.didDrag = true;
		camera.setState(nextState);
	};

	/** Pointer Up은 마지막 Camera 위치를 유지하고 Background Click을 억제한다. */
	const handleViewportPointerUp = (event: PointerEvent): void => {
		if (!viewportDrag || event.pointerId !== viewportDrag.pointerId) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		suppressNextMinimapClick = viewportDrag.didDrag;
		stopViewportDrag(event.pointerId, true);
	};

	/** Cancel은 마지막 Camera 위치를 유지한 채 Drag와 Capture만 정리한다. */
	const handleViewportPointerCancel = (event: PointerEvent): void => {
		if (!viewportDrag || event.pointerId !== viewportDrag.pointerId) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		suppressNextMinimapClick = false;
		stopViewportDrag(event.pointerId, true);
	};

	/** Capture 상실 시 추가 Camera 갱신 없이 session만 정리한다. */
	const handleViewportLostPointerCapture = (event: PointerEvent): void => {
		if (!viewportDrag || event.pointerId !== viewportDrag.pointerId) {
			return;
		}

		event.stopPropagation();
		suppressNextMinimapClick = false;
		stopViewportDrag(event.pointerId, false);
	};

	/** Indicator에서 합성된 Click은 Background Navigation으로 전파하지 않는다. */
	const handleViewportClick = (event: MouseEvent): void => {
		suppressNextMinimapClick = false;
		event.preventDefault();
		event.stopPropagation();
	};

	const render = (state: GraphStateSnapshot = graphState.getState()): void => {
		coordinate.textContent = `(${Math.round(state.camera.x)}, ${Math.round(state.camera.y)})`;
		scale.textContent = `${Math.round(state.camera.scale * 100)}%`;
		const cameraChanged = state.camera.x !== renderedCamera.x
			|| state.camera.y !== renderedCamera.y
			|| state.camera.scale !== renderedCamera.scale;
		const nodePositionsChanged = state.nodePositions !== renderedNodePositions;

		renderedCamera = state.camera;
		if (nodePositionsChanged) {
			renderedNodePositions = state.nodePositions;
			renderMinimapGraph(state);
		} else if (cameraChanged) {
			renderMinimapViewportIndicator();
		}
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
	minimapSvg.addEventListener('pointerdown', handleMinimapPointerDown);
	minimapSvg.addEventListener('click', handleMinimapClick);
	minimapViewportIndicator.addEventListener(
		'pointerdown',
		handleViewportPointerDown,
	);
	minimapViewportIndicator.addEventListener(
		'pointermove',
		handleViewportPointerMove,
	);
	minimapViewportIndicator.addEventListener(
		'pointerup',
		handleViewportPointerUp,
	);
	minimapViewportIndicator.addEventListener(
		'pointercancel',
		handleViewportPointerCancel,
	);
	minimapViewportIndicator.addEventListener(
		'lostpointercapture',
		handleViewportLostPointerCapture,
	);
	minimapViewportIndicator.addEventListener('click', handleViewportClick);
	const unsubscribeState = graphState.subscribe(render);
	const resizeObserver = typeof ResizeObserver === 'function'
		? new ResizeObserver(() => {
			if (!disposed) {
				renderMinimapViewportIndicator();
			}
		})
		: undefined;

	resizeObserver?.observe(viewport);
	renderRootListState();
	render();
	renderMinimapGraph(initialGraphState);

	return {
		setLayout(layout): void {
			if (disposed) {
				return;
			}

			currentLayout = layout;
			renderMinimapGraph();
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
			currentLayout = undefined;
			currentMinimapProjection = undefined;
			currentMinimapSize = undefined;
			currentMinimapViewportGeometry = undefined;
			suppressNextMinimapClick = false;
			resizeObserver?.disconnect();
			unsubscribeState();
			disposeRootItems();
			for (const action of navigatorActions) {
				action.dispose();
			}
			zoomOutButton.removeEventListener('click', handleZoomOut);
			zoomInButton.removeEventListener('click', handleZoomIn);
			minimapSvg.removeEventListener('pointerdown', handleMinimapPointerDown);
			minimapSvg.removeEventListener('click', handleMinimapClick);
			minimapViewportIndicator.removeEventListener(
				'pointerdown',
				handleViewportPointerDown,
			);
			minimapViewportIndicator.removeEventListener(
				'pointermove',
				handleViewportPointerMove,
			);
			minimapViewportIndicator.removeEventListener(
				'pointerup',
				handleViewportPointerUp,
			);
			minimapViewportIndicator.removeEventListener(
				'pointercancel',
				handleViewportPointerCancel,
			);
			minimapViewportIndicator.removeEventListener(
				'lostpointercapture',
				handleViewportLostPointerCapture,
			);
			minimapViewportIndicator.removeEventListener(
				'click',
				handleViewportClick,
			);

			if (viewportDrag) {
				stopViewportDrag(viewportDrag.pointerId, true);
			}
			navigator.remove();
		},
	};
}
