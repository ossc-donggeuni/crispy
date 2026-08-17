import type {
	GraphFileNode,
	GraphFileGroupNode,
	GraphLayout,
	GraphLayoutEdge,
	GraphLayoutNode,
	GraphLayoutPosition,
} from './graphLayout';
import { resolveFileIcon } from './fileIconResolver';
import {
	GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE,
	initializeGraphNodeDrag,
	type GraphNodeDrag,
} from './graphNodeDrag';
import {
	FILE_GROUP_PAGE_SIZE,
	getRemainingFileCount,
	getVisibleFileCount,
	type GraphStateSnapshot,
	type GraphStateStore,
} from './graphState';

interface FileGroupContentRenderer {
	render(page: number): void;
	dispose(): void;
}

type FileRowRenderer = {
	readonly element: HTMLLIElement;
	readonly dispose: () => void;
};

interface FileGroupContentElements {
	readonly elements: HTMLElement[];
	readonly cleanups: Array<() => void>;
}

/** Graph Node/Edge DOM과 interaction lifecycle을 관리한다. */
export interface GraphRenderer {
	/** 기존 Node/Edge DOM을 새로운 Layout geometry와 동기화한다. */
	applyLayout(layout: GraphLayout): void;
	/** Node/Edge DOM, Drag controller, Listener 및 State 구독을 정리한다. */
	dispose(): void;
}

/** Graph Node 종류별 Click을 상위 View가 선택적으로 처리하는 callback이다. */
export interface GraphRendererInteractions {
	/** Project Root 또는 Folder가 Click됐을 때 안정적인 Container ID를 전달한다. */
	onFolderClick?: (folderId: string) => void;
	/** File Group이 Click됐을 때 소유 Project 또는 Folder ID를 전달한다. */
	onFileGroupClick?: (folderId: string) => void;
	/** Standalone File 또는 File Row가 Click됐을 때 안정적인 File ID를 전달한다. */
	onFileClick?: (fileId: string) => void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const FOLDER_OPEN_ICON = 'folder-open.svg';
const FOLDER_CLOSED_ICON = 'folder-closed.svg';
const COLLAPSE_CHEVRON_PATH = 'm4.5 10 3.5-3.5 3.5 3.5';
const FILE_CLICK_ANIMATION_CLASS = 'is-file-clicking';

/**
 * 기존 Edge/Node Layer에 프로젝트 Layout을 렌더링하고 저장 위치와 동기화한다.
 * Camera-only 상태 변경은 건너뛰며, Node 위치 변경 시 해당 Node와 연결 Edge만
 * 갱신한다. 파일 그룹 page 변경은 해당 그룹 contents에만 반영한다.
 * Drag 중 임시 위치도 같은 위치 갱신 함수를 사용한다.
 *
 * @param edgeLayer Edge path를 추가할 기존 SVG Layer
 * @param nodeLayer Project, Folder, Standalone File, File Group을 추가할 HTML Layer
 * @param layout 결정적인 기본 Node 위치와 Parent-Child Edge
 * @param graphState 저장 위치 조회 및 변경 구독에 사용하는 Store
 * @param interactions Node 종류별 선택적 Click callback
 * @returns 렌더링된 DOM과 구독을 정리하는 lifecycle 핸들
 */
export function initializeGraphRenderer(
	edgeLayer: SVGSVGElement,
	nodeLayer: HTMLElement,
	layout: GraphLayout,
	graphState: GraphStateStore,
	interactions: GraphRendererInteractions = {},
): GraphRenderer {
	const ownerDocument = nodeLayer.ownerDocument;
	let renderedLayout = layout;
	let nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
	const nodeElements = new Map<string, HTMLElement>();
	const edgeElements = new Map<string, SVGPathElement>();
	const edgesByNodeId = new Map<string, GraphLayoutEdge[]>();
	const initialState = graphState.getState();
	const renderedPositions = new Map<string, GraphLayoutPosition>(
		layout.nodes.map((node) => [
			node.id,
			initialState.nodePositions[node.id] ?? node.position,
		]),
	);
	const nodeDrags = new Map<string, GraphNodeDrag>();
	const fileGroupContents = new Map<string, FileGroupContentRenderer>();
	let disposed = false;

	/** 새 Edge path를 생성해 Layer와 ID Map에 등록한다. */
	const addEdge = (edge: GraphLayoutEdge): void => {
		const path = ownerDocument.createElementNS(SVG_NAMESPACE, 'path');

		path.classList.add('graph-edge');
		path.setAttribute('data-graph-edge-id', edge.id);
		edgeLayer.append(path);
		edgeElements.set(edge.id, path);
	};

	/** Edge를 양 끝 Node의 연결 목록에 등록한다. */
	const indexEdge = (edge: GraphLayoutEdge): void => {

		for (const nodeId of [edge.sourceId, edge.targetId]) {
			const connectedEdges = edgesByNodeId.get(nodeId) ?? [];

			connectedEdges.push(edge);
			edgesByNodeId.set(nodeId, connectedEdges);
		}
	};

	for (const edge of layout.edges) {
		addEdge(edge);
		indexEdge(edge);
	}

	/** 현재 Renderer 위치 Map으로 지정한 Edge의 Bezier path를 다시 계산한다. */
	const renderEdge = (edge: GraphLayoutEdge): void => {
		const path = edgeElements.get(edge.id);
		const source = nodesById.get(edge.sourceId);
		const target = nodesById.get(edge.targetId);

		if (!path || !source || !target) {
			return;
		}

		path.setAttribute('d', createEdgePath(
			source,
			target,
			renderedPositions,
		));
	};

	/** Node DOM 위치를 반영하고 해당 Node에 직접 연결된 Edge만 갱신한다. */
	const updateNodePosition = (
		nodeId: string,
		position: GraphLayoutPosition,
		pendingEdges?: Map<string, GraphLayoutEdge>,
	): void => {
		renderedPositions.set(nodeId, position);
		const element = nodeElements.get(nodeId);

		if (element) {
			element.style.transform = `translate(${position.x}px, ${position.y}px)`;
		}

		for (const edge of edgesByNodeId.get(nodeId) ?? []) {
			if (pendingEdges) {
				pendingEdges.set(edge.id, edge);
			} else {
				renderEdge(edge);
			}
		}
	};

	/** 초기 렌더링과 Reflow 추가 경로에서 공통으로 Node와 interaction을 생성한다. */
	const addNode = (layoutNode: GraphLayoutNode): void => {
		const element = createNodeElement(
			layoutNode,
			ownerDocument,
		);

		if (layoutNode.kind === 'project' || layoutNode.kind === 'folder') {
			updateContainerOpenedState(
				element,
				graphState.isFolderOpened(layoutNode.id),
			);
		}

		if (layoutNode.kind === 'file-group') {
			const content = initializeFileGroupContent(
				element,
				layoutNode,
				ownerDocument,
				graphState,
				interactions,
			);

			content.render(graphState.getFileGroupPage(layoutNode.id));
			fileGroupContents.set(layoutNode.id, content);
		}

		nodeLayer.append(element);
		nodeElements.set(layoutNode.id, element);
		const position = graphState.getState().nodePositions[layoutNode.id]
			?? layoutNode.position;

		renderedPositions.set(layoutNode.id, position);
		element.style.transform = `translate(${position.x}px, ${position.y}px)`;
		nodeDrags.set(layoutNode.id, initializeGraphNodeDrag(
			element,
			layoutNode.id,
			layoutNode.position,
			graphState,
			{
				onClick: createNodeClickHandler(layoutNode, interactions),
				onPositionChange: (position) => {
					updateNodePosition(layoutNode.id, position);
				},
			},
		));
	};

	/** 제거할 Node의 interaction과 content를 정리한 뒤 DOM과 Map에서 제외한다. */
	const removeNode = (nodeId: string): void => {
		nodeDrags.get(nodeId)?.dispose();
		nodeDrags.delete(nodeId);
		fileGroupContents.get(nodeId)?.dispose();
		fileGroupContents.delete(nodeId);
		nodeElements.get(nodeId)?.remove();
		nodeElements.delete(nodeId);
		renderedPositions.delete(nodeId);
	};

	/** 제거할 Edge path를 DOM과 ID Map에서 제외한다. */
	const removeEdge = (edgeId: string): void => {
		edgeElements.get(edgeId)?.remove();
		edgeElements.delete(edgeId);
	};

	for (const layoutNode of layout.nodes) {
		addNode(layoutNode);
	}

	for (const edge of layout.edges) {
		renderEdge(edge);
	}

	let renderedNodePositions = initialState.nodePositions;
	/**
	 * 저장된 Node 위치 객체가 바뀐 경우 실제 좌표가 달라진 Node만 반영한다.
	 * GraphState의 reference sharing으로 Camera 및 pagination-only 변경은 순회 전에 종료한다.
	 */
	const renderStoredPositions = (state: GraphStateSnapshot): void => {
		if (state.nodePositions === renderedNodePositions) {
			return;
		}

		const previousPositions = renderedNodePositions;
		renderedNodePositions = state.nodePositions;

		for (const layoutNode of renderedLayout.nodes) {
			const previous = previousPositions[layoutNode.id] ?? layoutNode.position;
			const next = state.nodePositions[layoutNode.id] ?? layoutNode.position;

			if (previous.x === next.x && previous.y === next.y) {
				continue;
			}

			updateNodePosition(layoutNode.id, next);
		}
	};

	let renderedFileGroupPages = initialState.fileGroupPages;
	/**
	 * 파일 그룹 page Map이 바뀐 경우 실제 page 값이 달라진 그룹 contents만 갱신한다.
	 * Camera와 Node 위치 변경은 snapshot reference fast-path에서 즉시 종료한다.
	 */
	const renderFileGroupPages = (state: GraphStateSnapshot): void => {
		if (state.fileGroupPages === renderedFileGroupPages) {
			return;
		}

		const previousPages = renderedFileGroupPages;
		renderedFileGroupPages = state.fileGroupPages;

		for (const [fileGroupId, content] of fileGroupContents) {
			const previousPage = previousPages[fileGroupId] ?? 1;
			const nextPage = state.fileGroupPages[fileGroupId] ?? 1;

			if (previousPage !== nextPage) {
				content.render(nextPage);
			}
		}
	};
	let renderedOpenedFolders = initialState.openedFolders;
	/** 열린 Container Map의 실제 값이 바뀐 기존 Project/Folder DOM만 갱신한다. */
	const renderContainerOpenedState = (state: GraphStateSnapshot): void => {
		if (state.openedFolders === renderedOpenedFolders) {
			return;
		}

		const previousFolders = renderedOpenedFolders;
		renderedOpenedFolders = state.openedFolders;

		for (const layoutNode of renderedLayout.nodes) {
			if (layoutNode.kind !== 'project' && layoutNode.kind !== 'folder') {
				continue;
			}

			const wasOpened = previousFolders[layoutNode.id] === true;
			const isOpened = state.openedFolders[layoutNode.id] === true;

			if (wasOpened !== isOpened) {
				const element = nodeElements.get(layoutNode.id);

				if (element) {
					updateContainerOpenedState(element, isOpened);
				}
			}
		}
	};
	const renderState = (state: GraphStateSnapshot): void => {
		renderStoredPositions(state);
		renderFileGroupPages(state);
		renderContainerOpenedState(state);
	};
	const unsubscribeState = graphState.subscribe(renderState);

	return {
		applyLayout(nextLayout): void {
			if (disposed) {
				return;
			}

			const previousNodesById = nodesById;
			const previousEdgesById = new Map(
				renderedLayout.edges.map((edge) => [edge.id, edge]),
			);
			const nextNodesById = new Map(
				nextLayout.nodes.map((node) => [node.id, node]),
			);
			const nextEdgesById = new Map(
				nextLayout.edges.map((edge) => [edge.id, edge]),
			);
			const pendingEdges = new Map<string, GraphLayoutEdge>();

			for (const nodeId of previousNodesById.keys()) {
				if (!nextNodesById.has(nodeId)) {
					removeNode(nodeId);
				}
			}

			for (const edgeId of previousEdgesById.keys()) {
				if (!nextEdgesById.has(edgeId)) {
					removeEdge(edgeId);
				}
			}

			renderedLayout = nextLayout;
			nodesById = nextNodesById;

			for (const nextNode of nextLayout.nodes) {
				if (!previousNodesById.has(nextNode.id)) {
					addNode(nextNode);
				}
			}

			for (const nextEdge of nextLayout.edges) {
				if (!previousEdgesById.has(nextEdge.id)) {
					addEdge(nextEdge);
				}
			}

			edgesByNodeId.clear();

			for (const edge of nextLayout.edges) {
				indexEdge(edge);

				const previousEdge = previousEdgesById.get(edge.id);

				if (
					!previousEdge
					|| previousEdge.sourceId !== edge.sourceId
					|| previousEdge.targetId !== edge.targetId
				) {
					pendingEdges.set(edge.id, edge);
				}
			}

			const storedPositions = graphState.getState().nodePositions;

			for (const nextNode of nextLayout.nodes) {
				const previousNode = previousNodesById.get(nextNode.id);
				const element = nodeElements.get(nextNode.id);
				const nodeDrag = nodeDrags.get(nextNode.id);

				nodeDrag?.updateDefaultPosition(nextNode.position);

				if (
					element
					&& (!previousNode || previousNode.width !== nextNode.width)
				) {
					element.style.width = `${nextNode.width}px`;
				}

				if (
					element
					&& (!previousNode || previousNode.height !== nextNode.height)
				) {
					element.style.height = `${nextNode.height}px`;
				}

				if (
					!previousNode
					|| previousNode.width !== nextNode.width
					|| previousNode.height !== nextNode.height
				) {
					for (const edge of edgesByNodeId.get(nextNode.id) ?? []) {
						pendingEdges.set(edge.id, edge);
					}
				}

				const targetPosition = storedPositions[nextNode.id] ?? nextNode.position;
				const currentPosition = renderedPositions.get(nextNode.id);

				if (
					!currentPosition
					|| currentPosition.x !== targetPosition.x
					|| currentPosition.y !== targetPosition.y
				) {
					updateNodePosition(nextNode.id, targetPosition, pendingEdges);
				}
			}

			for (const edge of pendingEdges.values()) {
				renderEdge(edge);
			}
		},
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			unsubscribeState();

			for (const nodeId of [...nodeElements.keys()]) {
				removeNode(nodeId);
			}

			for (const edgeId of [...edgeElements.keys()]) {
				removeEdge(edgeId);
			}

			edgesByNodeId.clear();
		},
	};
}

/** Layout Node 종류에 맞는 고정 크기 Card DOM을 생성한다. */
function createNodeElement(
	node: GraphLayoutNode,
	ownerDocument: Document,
): HTMLElement {
	const element = ownerDocument.createElement('div');

	element.className = `graph-node graph-${node.kind}-node`;
	element.setAttribute('data-graph-node-id', node.id);
	element.style.width = `${node.width}px`;
	element.style.height = `${node.height}px`;

	if (node.kind === 'file') {
		element.setAttribute('data-file-id', node.id);
		appendFileContent(element, node, ownerDocument);
	} else if (node.kind !== 'file-group') {
		const icon = createFolderIcon(ownerDocument);
		const name = ownerDocument.createElement('span');

		element.setAttribute('data-folder-icon', FOLDER_OPEN_ICON);
		name.className = 'graph-folder-name';
		name.textContent = `${node.name}/`;
		element.append(icon, name);
	}

	return element;
}

/** Standalone File과 File Group Row가 공유하는 icon/name content를 추가한다. */
function appendFileContent(
	element: HTMLElement,
	file: GraphFileNode,
	ownerDocument: Document,
): void {
	const icon = ownerDocument.createElement('span');
	const name = ownerDocument.createElement('span');

	icon.className = 'graph-node-icon graph-file-icon';
	icon.setAttribute('data-file-icon', resolveFileIcon(file.name));
	icon.setAttribute('aria-hidden', 'true');
	name.className = 'graph-file-name';
	name.textContent = file.name;
	element.append(icon, name);
}

/**
 * CSS에서 open/closed SVG asset을 적용할 Folder icon 요소를 만든다.
 *
 * @param ownerDocument Graph View가 속한 Document
 * @returns Root와 Folder Card에서 공통으로 사용하는 icon 요소
 */
function createFolderIcon(ownerDocument: Document): HTMLElement {
	const icon = ownerDocument.createElement('span');

	icon.className = 'graph-node-icon graph-folder-icon';
	icon.setAttribute('aria-hidden', 'true');

	return icon;
}

/** 기존 Project/Folder DOM에서 icon asset 선택과 접근성 상태만 갱신한다. */
function updateContainerOpenedState(
	element: HTMLElement,
	isOpened: boolean,
): void {
	element.setAttribute(
		'data-folder-icon',
		isOpened ? FOLDER_OPEN_ICON : FOLDER_CLOSED_ICON,
	);
	element.setAttribute('aria-expanded', String(isOpened));
}

/** Graph State page를 기준으로 한 File Group 내부 DOM과 Listener만 교체한다. */
function initializeFileGroupContent(
	element: HTMLElement,
	node: GraphFileGroupNode,
	ownerDocument: Document,
	graphState: GraphStateStore,
	interactions: GraphRendererInteractions,
): FileGroupContentRenderer {
	let content: FileGroupContentElements = { elements: [], cleanups: [] };
	let disposed = false;
	const clearContent = (): void => {
		for (const cleanup of content.cleanups) {
			cleanup();
		}

		for (const child of content.elements) {
			child.remove();
		}

		content = { elements: [], cleanups: [] };
	};

	return {
		render(page): void {
			if (disposed) {
				return;
			}

			clearContent();
			const visibleCount = getVisibleFileCount(node.children.length, page);
			const remainingCount = getRemainingFileCount(node.children.length, page);
			const showCollapse = node.children.length > FILE_GROUP_PAGE_SIZE && page > 1;
			const list = ownerDocument.createElement('ul');
			const elements: HTMLElement[] = [list];
			const cleanups: Array<() => void> = [];

			list.className = 'graph-file-list';

			for (const file of node.children.slice(0, visibleCount)) {
				const row = createFileRow(file, ownerDocument, interactions);

				list.append(row.element);
				cleanups.push(row.dispose);
			}

			element.append(list);

			if (remainingCount > 0 || showCollapse) {
				const controls = ownerDocument.createElement('div');

				controls.className = 'graph-file-controls';
				elements.push(controls);

				if (remainingCount > 0) {
					const more = ownerDocument.createElement('button');
					const handleMoreClick = (event: MouseEvent): void => {
						event.stopPropagation();
						graphState.showMoreFiles(node.id);
					};

					more.className = 'graph-file-control graph-file-more';
					more.type = 'button';
					more.textContent = `+ ${remainingCount}개 더보기`;
					more.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
					more.addEventListener('click', handleMoreClick);
					cleanups.push(() => {
						more.removeEventListener('click', handleMoreClick);
					});
					controls.append(more);
				}

				if (showCollapse) {
					const collapse = ownerDocument.createElement('button');
					const handleCollapseClick = (event: MouseEvent): void => {
						event.stopPropagation();
						graphState.collapseFileGroup(node.id);
					};

					collapse.className = 'graph-file-control graph-file-collapse';
					collapse.type = 'button';
					collapse.setAttribute('aria-label', '파일 목록 접기');
					collapse.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
					collapse.append(createCollapseIcon(ownerDocument));
					collapse.addEventListener('click', handleCollapseClick);
					cleanups.push(() => {
						collapse.removeEventListener('click', handleCollapseClick);
					});
					controls.append(collapse);
				}

				element.append(controls);
			}

			content = { elements, cleanups };
		},
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			clearContent();
		},
	};
}

/** File Row DOM과 Click feedback listener lifecycle을 만든다. */
function createFileRow(
	file: GraphFileNode,
	ownerDocument: Document,
	interactions: GraphRendererInteractions,
): FileRowRenderer {
	const item = ownerDocument.createElement('li');

	item.className = 'graph-file-item';
	item.setAttribute('data-file-id', file.id);
	item.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	appendFileContent(item, file, ownerDocument);
	/** File Group이 아닌 현재 Row에만 Click feedback을 다시 시작한다. */
	const animateFileClick = (): void => {
		item.classList.remove(FILE_CLICK_ANIMATION_CLASS);
		void item.offsetWidth;
		item.classList.add(FILE_CLICK_ANIMATION_CLASS);
	};
	const handleFileClick = (event: MouseEvent): void => {
		event.stopPropagation();
		animateFileClick();
		interactions.onFileClick?.(file.id);
	};
	const handleFileClickAnimationEnd = (event: AnimationEvent): void => {
		if (event.target === item) {
			item.classList.remove(FILE_CLICK_ANIMATION_CLASS);
		}
	};

	item.addEventListener('click', handleFileClick);
	item.addEventListener('animationend', handleFileClickAnimationEnd);

	return {
		element: item,
		dispose: () => {
			item.removeEventListener('click', handleFileClick);
			item.removeEventListener('animationend', handleFileClickAnimationEnd);
			item.classList.remove(FILE_CLICK_ANIMATION_CLASS);
		},
	};
}

/** 외부 asset 없이 접기 Button에 표시하는 inline 위쪽 Chevron SVG를 만든다. */
function createCollapseIcon(ownerDocument: Document): SVGSVGElement {
	const icon = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
	const path = ownerDocument.createElementNS(SVG_NAMESPACE, 'path');

	icon.classList.add('graph-file-collapse-icon');
	icon.setAttribute('viewBox', '0 0 16 16');
	icon.setAttribute('fill', 'none');
	icon.setAttribute('aria-hidden', 'true');
	icon.setAttribute('focusable', 'false');
	path.setAttribute('d', COLLAPSE_CHEVRON_PATH);
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.5');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	icon.append(path);

	return icon;
}

/** Layout Node 종류에 대응하는 Click callback을 만든다. */
function createNodeClickHandler(
	node: GraphLayoutNode,
	interactions: GraphRendererInteractions,
): (() => void) | undefined {
	if (node.kind === 'file-group') {
		return interactions.onFileGroupClick
			? () => interactions.onFileGroupClick?.(node.parentId)
			: undefined;
	}
	if (node.kind === 'file') {
		return interactions.onFileClick
			? () => interactions.onFileClick?.(node.id)
			: undefined;
	}

	return interactions.onFolderClick
		? () => interactions.onFolderClick?.(node.id)
		: undefined;
}

/** Renderer의 임시/저장 위치가 없을 때 Layout 기본 위치로 해석한다. */
function resolveNodePosition(
	node: GraphLayoutNode,
	positions: ReadonlyMap<string, GraphLayoutPosition>,
): GraphLayoutPosition {
	return positions.get(node.id) ?? node.position;
}

/** Parent 오른쪽 중앙에서 Child 왼쪽 중앙으로 이어지는 Cubic Bezier path를 만든다. */
function createEdgePath(
	source: GraphLayoutNode,
	target: GraphLayoutNode,
	positions: ReadonlyMap<string, GraphLayoutPosition>,
): string {
	const sourcePosition = resolveNodePosition(source, positions);
	const targetPosition = resolveNodePosition(target, positions);
	const sourceX = sourcePosition.x + source.width;
	const sourceY = sourcePosition.y + source.height / 2;
	const targetX = targetPosition.x;
	const targetY = targetPosition.y + target.height / 2;
	const controlOffset = Math.max(48, Math.abs(targetX - sourceX) / 2);

	return [
		`M ${sourceX} ${sourceY}`,
		`C ${sourceX + controlOffset} ${sourceY}`,
		`${targetX - controlOffset} ${targetY}`,
		`${targetX} ${targetY}`,
	].join(' ');
}
