import type {
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
import type {
	GraphStateSnapshot,
	GraphStateStore,
} from './graphState';

/** Graph Node/Edge DOM과 interaction lifecycle을 관리한다. */
export interface GraphRenderer {
	/** Node/Edge DOM, Drag controller, Listener 및 State 구독을 정리한다. */
	dispose(): void;
}

/** Graph Node 종류별 Click을 상위 View가 선택적으로 처리하는 callback이다. */
export interface GraphRendererInteractions {
	/** Project Root 또는 Folder가 Click됐을 때 안정적인 Container ID를 전달한다. */
	onFolderClick?: (folderId: string) => void;
	/** File Group이 Click됐을 때 소유 Project 또는 Folder ID를 전달한다. */
	onFileGroupClick?: (folderId: string) => void;
	/** File Row가 Click됐을 때 안정적인 File ID를 전달한다. */
	onFileClick?: (fileId: string) => void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const FOLDER_ICON_PATH = 'M2.5 5.25A1.25 1.25 0 0 1 3.75 4h3.4l1.7 2h7.4a1.25 1.25 0 0 1 1.25 1.25v7.5A1.25 1.25 0 0 1 16.25 16H3.75a1.25 1.25 0 0 1-1.25-1.25v-9.5Z';
const FILE_CLICK_ANIMATION_CLASS = 'is-file-clicking';

/**
 * 기존 Edge/Node Layer에 프로젝트 Layout을 렌더링하고 저장 위치와 동기화한다.
 * Camera-only 상태 변경은 건너뛰며, Node 위치 변경 시 해당 Node와 연결 Edge만
 * 갱신한다. Drag 중 임시 위치도 같은 갱신 함수를 사용한다.
 *
 * @param edgeLayer Edge path를 추가할 기존 SVG Layer
 * @param nodeLayer Project Root, Folder, File Group을 추가할 기존 HTML Layer
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
	const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
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
	const nodeDrags: GraphNodeDrag[] = [];
	const interactionCleanups: Array<() => void> = [];

	for (const edge of layout.edges) {
		const path = ownerDocument.createElementNS(SVG_NAMESPACE, 'path');

		path.classList.add('graph-edge');
		path.setAttribute('data-graph-edge-id', edge.id);
		edgeLayer.append(path);
		edgeElements.set(edge.id, path);

		for (const nodeId of [edge.sourceId, edge.targetId]) {
			const connectedEdges = edgesByNodeId.get(nodeId) ?? [];

			connectedEdges.push(edge);
			edgesByNodeId.set(nodeId, connectedEdges);
		}
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
	): void => {
		renderedPositions.set(nodeId, position);
		const element = nodeElements.get(nodeId);

		if (element) {
			element.style.transform = `translate(${position.x}px, ${position.y}px)`;
		}

		for (const edge of edgesByNodeId.get(nodeId) ?? []) {
			renderEdge(edge);
		}
	};

	for (const layoutNode of layout.nodes) {
		const element = createNodeElement(
			layoutNode,
			ownerDocument,
			interactions,
			interactionCleanups,
		);

		nodeLayer.append(element);
		nodeElements.set(layoutNode.id, element);
		nodeDrags.push(initializeGraphNodeDrag(
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
	}

	for (const layoutNode of layout.nodes) {
		const position = renderedPositions.get(layoutNode.id) ?? layoutNode.position;
		const element = nodeElements.get(layoutNode.id);

		if (element) {
			element.style.transform = `translate(${position.x}px, ${position.y}px)`;
		}
	}

	for (const edge of layout.edges) {
		renderEdge(edge);
	}

	let renderedNodePositions = initialState.nodePositions;
	/**
	 * 저장된 Node 위치 객체가 바뀐 경우 실제 좌표가 달라진 Node만 반영한다.
	 * GraphState의 reference sharing으로 Camera-only 변경은 순회 전에 종료한다.
	 */
	const renderStoredPositions = (state: GraphStateSnapshot): void => {
		if (state.nodePositions === renderedNodePositions) {
			return;
		}

		const previousPositions = renderedNodePositions;
		renderedNodePositions = state.nodePositions;

		for (const layoutNode of layout.nodes) {
			const previous = previousPositions[layoutNode.id] ?? layoutNode.position;
			const next = state.nodePositions[layoutNode.id] ?? layoutNode.position;

			if (previous.x === next.x && previous.y === next.y) {
				continue;
			}

			updateNodePosition(layoutNode.id, next);
		}
	};

	const unsubscribeState = graphState.subscribe(renderStoredPositions);
	let disposed = false;

	return {
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			unsubscribeState();

			for (const drag of nodeDrags) {
				drag.dispose();
			}

			for (const cleanup of interactionCleanups) {
				cleanup();
			}

			for (const path of edgeElements.values()) {
				path.remove();
			}

			for (const element of nodeElements.values()) {
				element.remove();
			}
		},
	};
}

/** Layout Node 종류에 맞는 고정 크기 Card DOM을 생성한다. */
function createNodeElement(
	node: GraphLayoutNode,
	ownerDocument: Document,
	interactions: GraphRendererInteractions,
	interactionCleanups: Array<() => void>,
): HTMLElement {
	const element = ownerDocument.createElement('div');

	element.className = `graph-node graph-${node.kind}-node`;
	element.setAttribute('data-graph-node-id', node.id);
	element.style.width = `${node.width}px`;
	element.style.height = `${node.height}px`;

	if (node.kind === 'file-group') {
		appendFileGroupContent(
			element,
			node,
			ownerDocument,
			interactions,
			interactionCleanups,
		);
	} else {
		const icon = createFolderIcon(ownerDocument);
		const name = ownerDocument.createElement('span');

		name.className = 'graph-folder-name';
		name.textContent = `${node.name}/`;
		element.append(icon, name);
	}

	return element;
}

/**
 * Webview CSP의 image source 허용 여부와 무관하게 표시되는 inline Folder SVG를 만든다.
 *
 * @param ownerDocument Graph View가 속한 Document
 * @returns Root와 Folder Card에서 공통으로 사용하는 SVG 요소
 */
function createFolderIcon(ownerDocument: Document): SVGSVGElement {
	const icon = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
	const path = ownerDocument.createElementNS(SVG_NAMESPACE, 'path');

	icon.classList.add('graph-node-icon', 'graph-folder-icon');
	icon.setAttribute('viewBox', '0 0 20 20');
	icon.setAttribute('fill', 'none');
	icon.setAttribute('aria-hidden', 'true');
	icon.setAttribute('focusable', 'false');
	path.setAttribute('d', FOLDER_ICON_PATH);
	path.setAttribute('stroke', '#A3A3A3');
	path.setAttribute('stroke-width', '1.5');
	path.setAttribute('stroke-linejoin', 'round');
	icon.append(path);

	return icon;
}

/** 표시 대상 File Row와 선택적 More Bar를 File Group Card에 추가한다. */
function appendFileGroupContent(
	element: HTMLElement,
	node: GraphFileGroupNode,
	ownerDocument: Document,
	interactions: GraphRendererInteractions,
	interactionCleanups: Array<() => void>,
): void {
	const list = ownerDocument.createElement('ul');

	list.className = 'graph-file-list';

	for (const file of node.visibleFiles) {
		const item = ownerDocument.createElement('li');
		const icon = ownerDocument.createElement('span');
		const name = ownerDocument.createElement('span');

		item.className = 'graph-file-item';
		item.setAttribute('data-file-id', file.id);
		item.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
		icon.className = 'graph-node-icon graph-file-icon';
		icon.setAttribute('data-file-icon', resolveFileIcon(file.name));
		icon.setAttribute('aria-hidden', 'true');
		name.className = 'graph-file-name';
		name.textContent = file.name;
		item.append(icon, name);
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
		interactionCleanups.push(() => {
			item.removeEventListener('click', handleFileClick);
			item.removeEventListener('animationend', handleFileClickAnimationEnd);
			item.classList.remove(FILE_CLICK_ANIMATION_CLASS);
		});
		list.append(item);
	}

	element.append(list);

	if (node.hiddenFileCount > 0) {
		const more = ownerDocument.createElement('div');

		more.className = 'graph-file-more';
		more.textContent = `+ ${node.hiddenFileCount}개 더보기`;
		element.append(more);
	}
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
