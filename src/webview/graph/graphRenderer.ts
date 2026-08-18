import type {
	GraphFileNode,
	GraphFileGroupNode,
	GraphLayout,
	GraphLayoutEdge,
	GraphLayoutNode,
	GraphLayoutPosition,
} from './graphLayout';
import { GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE } from './graphCamera';
import {
	initializeGraphDetachDrag,
	type GraphDetachDrag,
	type GraphDetachDropRequest,
} from './graphDetachDrag';
import { resolveFileIcon } from './fileIconResolver';
import type { GraphRootContext } from './graphModel';
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
import { fitRelativePath } from './graphRootContext';

interface FileGroupContentRenderer {
	render(page: number): void;
	dispose(): void;
}

type FileRowRenderer = {
	readonly element: HTMLLIElement;
	readonly dispose: () => void;
};

type BacklinkInitializer = (
	element: HTMLElement,
	targetRootId: string,
) => () => void;

interface FileGroupContentElements {
	readonly elements: HTMLElement[];
	readonly cleanups: Array<() => void>;
}

interface RootContextLabelRenderer {
	readonly element: HTMLElement;
	render(context: GraphRootContext, rootNodeWidth: number): void;
	dispose(): void;
}

/** Graph Node/Edge DOM과 interaction lifecycle을 관리한다. */
export interface GraphRenderer {
	/** 기존 Node/Edge DOM을 새로운 Layout geometry와 동기화한다. */
	applyLayout(layout: GraphLayout): void;
	/** 현재 렌더링된 Backlink DOM의 client rect를 반환한다. */
	getBacklinkClientRect(targetRootId: string): DOMRect | undefined;
	/** 현재 렌더링된 Backlink DOM의 client 좌표계 중심을 반환한다. */
	getBacklinkClientCenter(targetRootId: string): {
		readonly clientX: number;
		readonly clientY: number;
	} | undefined;
	/** Node/Edge DOM, Drag controller, Listener 및 State 구독을 정리한다. */
	dispose(): void;
}

/** Graph Node 종류별 Click을 상위 View가 선택적으로 처리하는 callback이다. */
export interface GraphRendererInteractions {
	/** Project Root 또는 Folder가 Click됐을 때 안정적인 Container ID를 전달한다. */
	onFolderClick?: (folderId: string) => void;
	/** Grouped File Group이 Click됐을 때 소유 Project 또는 Folder ID를 전달한다. */
	onFileGroupClick?: (folderId: string) => void;
	/** Standalone presentation 또는 File Row가 Click됐을 때 안정적인 File ID를 전달한다. */
	onFileClick?: (fileId: string) => void;
	/** Handle Drag가 완료됐을 때 대상 ID와 client 좌표를 상위로 전달한다. */
	onDetachDrop?: (request: GraphDetachDropRequest) => void;
	/** Folder/File Backlink Click 시 연결된 Graph Root ID를 전달한다. */
	onBacklinkClick?: (targetRootId: string) => void;
	/** Context Label Click 시 현재 Graph Root ID를 전달한다. */
	onRootContextClick?: (rootId: string) => void;
	/** Layout Root Node ID를 최신 Graph Root ID로 해석한다. */
	resolveRootId?: (rootNodeId: string) => string | undefined;
	/** 자신의 Backlink Target에 Drop된 Root의 제거를 상위 View에 요청한다. */
	onRootReattach?: (request: GraphRootReattachRequest) => boolean;
}

/** Reattach가 확인된 Root와 실제 Node를 최신 Graph 변경 경로에 전달한다. */
export interface GraphRootReattachRequest {
	readonly rootId: string;
	readonly nodeId: string;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const FOLDER_OPEN_ICON = 'folder-open.svg';
const FOLDER_CLOSED_ICON = 'folder-closed.svg';
const COLLAPSE_CHEVRON_PATH = 'm4.5 10 3.5-3.5 3.5 3.5';
const DETACH_ARROW_PATH = 'M4 12 12 4 M7 4h5v5';
const FILE_CLICK_ANIMATION_CLASS = 'is-file-clicking';
const REATTACH_TARGET_CLASS = 'is-reattach-target';
const REATTACH_TARGET_MARGIN = 8;
const ROOT_CONTEXT_MAX_WIDTH_MULTIPLIER = 1.5;

/**
 * 기존 Edge/Node Layer에 프로젝트 Layout을 렌더링하고 저장 위치와 동기화한다.
 * Camera-only 상태 변경은 건너뛰며, Node 위치 변경 시 해당 Node와 연결 Edge만
 * 갱신한다. 파일 그룹 page 변경은 해당 그룹 contents에만 반영한다.
 * Drag 중 임시 위치도 같은 위치 갱신 함수를 사용한다.
 *
 * @param edgeLayer Edge path를 추가할 기존 SVG Layer
 * @param nodeLayer Project, Folder, File Group을 추가할 HTML Layer
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
	const nodeDetachDrags = new Map<string, GraphDetachDrag>();
	const backlinkClickCleanups = new Map<string, () => void>();
	const backlinkElements = new Map<string, HTMLElement>();
	const fileGroupContents = new Map<string, FileGroupContentRenderer>();
	const rootContextLabels = new Map<string, RootContextLabelRenderer>();
	let rootNodeIds = layout.rootNodeIds;
	let disposed = false;
	let activeReattachTarget: {
		readonly rootId: string;
		readonly element: HTMLElement;
	} | undefined;
	/** 현재 Backlink Target 표시를 즉시 제거한다. */
	const clearReattachTarget = (): void => {
		activeReattachTarget?.element.classList.remove(REATTACH_TARGET_CLASS);
		activeReattachTarget = undefined;
	};
	/** Root 자신의 Backlink rect와 Pointer client 좌표를 비교해 표시를 동기화한다. */
	const updateReattachTarget = (
		nodeId: string,
		clientX: number,
		clientY: number,
	): string | undefined => {
		const rootId = rootNodeIds.has(nodeId)
			? interactions.resolveRootId?.(nodeId)
			: undefined;
		const element = rootId ? backlinkElements.get(rootId) : undefined;
		const isTarget = element
			? isPointInsideExpandedRect(
				clientX,
				clientY,
				element.getBoundingClientRect(),
				REATTACH_TARGET_MARGIN,
			)
			: false;

		if (!rootId || !element || !isTarget) {
			clearReattachTarget();
			return undefined;
		}

		if (
			activeReattachTarget?.rootId !== rootId
			|| activeReattachTarget.element !== element
		) {
			clearReattachTarget();
			element.classList.add(REATTACH_TARGET_CLASS);
			activeReattachTarget = { rootId, element };
		}

		return rootId;
	};
	/** Backlink Click listener와 target Root별 최신 DOM registry를 함께 관리한다. */
	const initializeBacklink: BacklinkInitializer = (element, targetRootId) => {
		backlinkElements.set(targetRootId, element);
		const disposeClick = initializeBacklinkClick(
			element,
			targetRootId,
			interactions,
		);

		return () => {
			disposeClick();

			if (activeReattachTarget?.element === element) {
				clearReattachTarget();
			}

			if (backlinkElements.get(targetRootId) === element) {
				backlinkElements.delete(targetRootId);
			}
		};
	};

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

	/** 해당 Layout Root의 선택적 Context Label을 추가, 갱신 또는 제거한다. */
	const syncRootContextLabel = (
		layoutNode: GraphLayoutNode,
		element: HTMLElement,
		context: GraphRootContext | undefined,
	): void => {
		const current = rootContextLabels.get(layoutNode.id);

		if (!context) {
			current?.dispose();
			rootContextLabels.delete(layoutNode.id);
			return;
		}

		const label = current ?? initializeRootContextLabel(
			element,
			ownerDocument,
			() => {
				const rootId = interactions.resolveRootId?.(layoutNode.id);

				if (rootId) {
					interactions.onRootContextClick?.(rootId);
				}
			},
		);

		if (!current) {
			rootContextLabels.set(layoutNode.id, label);
		}

		label.render(context, getRenderedNodeWidth(element, layoutNode.width));
	};

	/** 최신 Root 목록에 맞춰 Card 자체 Detach Handle을 추가하거나 제거한다. */
	const syncDetachDrag = (
		layoutNode: GraphLayoutNode,
		element: HTMLElement,
	): void => {
		const detachNodeId = getDetachNodeId(layoutNode, rootNodeIds);
		const current = nodeDetachDrags.get(layoutNode.id);

		if (!detachNodeId) {
			current?.dispose();
			nodeDetachDrags.delete(layoutNode.id);
			return;
		}

		if (!current) {
			nodeDetachDrags.set(
				layoutNode.id,
				appendDetachHandle(
					element,
					detachNodeId,
					ownerDocument,
					interactions,
				),
			);
		}
	};

	/** 초기 렌더링과 Reflow 추가 경로에서 공통으로 Node와 interaction을 생성한다. */
	const addNode = (layoutNode: GraphLayoutNode): void => {
		const element = createNodeElement(
			layoutNode,
			ownerDocument,
		);
		syncDetachDrag(layoutNode, element);
		const backlinkTargetRootId = getNodeBacklinkTargetRootId(layoutNode);

		if (backlinkTargetRootId) {
			backlinkClickCleanups.set(
				layoutNode.id,
				initializeBacklink(
					element,
					backlinkTargetRootId,
				),
			);
		}

		if (layoutNode.kind === 'project' || layoutNode.kind === 'folder') {
			updateContainerOpenedState(
				element,
				graphState.isFolderOpened(layoutNode.id),
			);
		}

		if (
			layoutNode.kind === 'file-group'
			&& layoutNode.presentation === 'grouped'
		) {
			const content = initializeFileGroupContent(
				element,
				layoutNode,
				ownerDocument,
				graphState,
				interactions,
				rootNodeIds,
				initializeBacklink,
			);

			content.render(graphState.getFileGroupPage(layoutNode.id));
			fileGroupContents.set(layoutNode.id, content);
		}

		nodeLayer.append(element);
		nodeElements.set(layoutNode.id, element);
		syncRootContextLabel(
			layoutNode,
			element,
			renderedLayout.rootContexts[layoutNode.id],
		);
		const position = graphState.getState().nodePositions[layoutNode.id]
			?? layoutNode.position;

		renderedPositions.set(layoutNode.id, position);
		element.style.transform = `translate(${position.x}px, ${position.y}px)`;

		if (isMovableLayoutNode(layoutNode)) {
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
					onDragMove: ({ clientX, clientY }) => {
						updateReattachTarget(layoutNode.id, clientX, clientY);
					},
					onDragEnd: ({ clientX, clientY }) => {
						const rootId = updateReattachTarget(
							layoutNode.id,
							clientX,
							clientY,
						);

						clearReattachTarget();
						return rootId !== undefined
							&& interactions.onRootReattach?.({
								rootId,
								nodeId: layoutNode.id,
							}) === true;
					},
					onDragCancel: clearReattachTarget,
				},
			));
		}
	};

	/** 제거할 Node의 interaction과 content를 정리한 뒤 DOM과 Map에서 제외한다. */
	const removeNode = (nodeId: string): void => {
		nodeDrags.get(nodeId)?.dispose();
		nodeDrags.delete(nodeId);
		nodeDetachDrags.get(nodeId)?.dispose();
		nodeDetachDrags.delete(nodeId);
		backlinkClickCleanups.get(nodeId)?.();
		backlinkClickCleanups.delete(nodeId);
		fileGroupContents.get(nodeId)?.dispose();
		fileGroupContents.delete(nodeId);
		rootContextLabels.get(nodeId)?.dispose();
		rootContextLabels.delete(nodeId);
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
			clearReattachTarget();

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

			rootNodeIds = nextLayout.rootNodeIds;

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
				const previousNode = previousNodesById.get(nextNode.id);

				if (!previousNode) {
					addNode(nextNode);
				} else if (!hasSameNodePresentation(previousNode, nextNode)) {
					removeNode(nextNode.id);
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

				if (element) {
					syncDetachDrag(nextNode, element);
					updateContainerStatusState(element, nextNode);
				}

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

				if (element) {
					syncRootContextLabel(
						nextNode,
						element,
						nextLayout.rootContexts[nextNode.id],
					);
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
		getBacklinkClientRect(targetRootId) {
			if (disposed) {
				return undefined;
			}

			return backlinkElements.get(targetRootId)?.getBoundingClientRect();
		},
		getBacklinkClientCenter(targetRootId) {
			const bounds = disposed
				? undefined
				: backlinkElements.get(targetRootId)?.getBoundingClientRect();

			if (!bounds) {
				return undefined;
			}

			return {
				clientX: bounds.left + bounds.width / 2,
				clientY: bounds.top + bounds.height / 2,
			};
		},
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			clearReattachTarget();
			unsubscribeState();

			for (const nodeId of [...nodeElements.keys()]) {
				removeNode(nodeId);
			}

			for (const edgeId of [...edgeElements.keys()]) {
				removeEdge(edgeId);
			}

			edgesByNodeId.clear();
			backlinkElements.clear();
		},
	};
}

/** 고정 margin을 포함한 DOM rect 안에 client pointer가 있는지 판별한다. */
function isPointInsideExpandedRect(
	clientX: number,
	clientY: number,
	rect: DOMRect,
	margin: number,
): boolean {
	return clientX >= rect.left - margin
		&& clientX <= rect.right + margin
		&& clientY >= rect.top - margin
		&& clientY <= rect.bottom + margin;
}

/** Root 카드에 Layout 비참여 absolute Context Label과 입력 차단 정책을 추가한다. */
function initializeRootContextLabel(
	rootNode: HTMLElement,
	ownerDocument: Document,
	onClick: () => void,
): RootContextLabelRenderer {
	const label = ownerDocument.createElement('span');
	const handlePointerDown = (event: Event): void => {
		event.preventDefault();
		event.stopPropagation();
	};
	const handleClick = (event: Event): void => {
		event.preventDefault();
		event.stopPropagation();
		onClick();
	};

	label.className = 'graph-root-context-label';
	label.setAttribute('data-graph-root-context-label', '');
	label.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	label.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	label.style.left = '0px';
	label.addEventListener('pointerdown', handlePointerDown);
	label.addEventListener('click', handleClick);
	rootNode.append(label);

	return {
		element: label,
		render(context, rootNodeWidth): void {
			const maxWidth = Math.max(
				0,
				rootNodeWidth * ROOT_CONTEXT_MAX_WIDTH_MULTIPLIER,
			);

			label.style.maxWidth = 'none';
			const measureText = createContextLabelTextMeasurer(label, ownerDocument);
			label.textContent = fitRelativePath(
				context.relativePath,
				maxWidth,
				measureText,
			);
			label.style.maxWidth = `${maxWidth}px`;
		},
		dispose(): void {
			label.removeEventListener('pointerdown', handlePointerDown);
			label.removeEventListener('click', handleClick);
			label.remove();
		},
	};
}

/** Transform과 무관한 실제 CSS box 폭을 우선하고 Layout 폭을 안전한 fallback으로 쓴다. */
function getRenderedNodeWidth(element: HTMLElement, fallbackWidth: number): number {
	return element.offsetWidth > 0 ? element.offsetWidth : fallbackWidth;
}

/** 현재 Label의 computed font를 쓰는 Canvas 실측 함수를 만든다. */
function createContextLabelTextMeasurer(
	label: HTMLElement,
	ownerDocument: Document,
): (text: string) => number {
	const canvas = ownerDocument.createElement('canvas') as HTMLCanvasElement;
	const getContext = canvas.getContext;

	if (typeof getContext === 'function') {
		const context = getContext.call(canvas, '2d') as CanvasRenderingContext2D | null;

		if (context) {
			const computedStyle = ownerDocument.defaultView?.getComputedStyle(label);

			if (computedStyle) {
				context.font = [
					computedStyle.fontStyle,
					computedStyle.fontWeight,
					computedStyle.fontSize,
					computedStyle.fontFamily,
				].join(' ');
			}

			return (text) => context.measureText(text).width;
		}
	}

	/** DOM test doubles나 Canvas 미지원 환경에서는 같은 Label의 실제 box를 잰다. */
	return (text) => {
		label.textContent = text;
		return label.getBoundingClientRect().width;
	};
}

/** Layout Node 종류에 맞는 고정 크기 Card DOM을 생성한다. */
function createNodeElement(
	node: GraphLayoutNode,
	ownerDocument: Document,
): HTMLElement {
	const element = ownerDocument.createElement('div');

	element.className = node.kind === 'folder-backlink'
		? 'graph-node graph-folder-node graph-folder-backlink-node'
		: `graph-node graph-${node.kind}-node`;

	updateContainerStatusState(element, node);
	element.setAttribute('data-graph-node-id', node.id);
	element.style.width = `${node.width}px`;
	element.style.height = `${node.height}px`;

	if (node.kind === 'file-group') {
		element.setAttribute('data-file-group-presentation', node.presentation);

		if (node.presentation === 'standalone') {
			const file = node.children[0];

			if (file) {
				element.setAttribute('data-file-id', file.id);
				applyFileBacklinkAttributes(element, file);
				appendFileContent(element, file, ownerDocument);
			}
		}
	} else {
		const icon = createFolderIcon(ownerDocument);
		const name = ownerDocument.createElement('span');

		element.setAttribute(
			'data-folder-icon',
			node.kind === 'folder-backlink'
				? FOLDER_CLOSED_ICON
				: FOLDER_OPEN_ICON,
		);
		name.className = 'graph-folder-name';
		name.textContent = `${node.name}/`;
		element.append(icon, name);

		if (node.kind === 'folder-backlink') {
			element.setAttribute('data-graph-backlink', 'folder');
			element.setAttribute('data-target-root-id', node.targetRootId);
			element.setAttribute('data-target-node-id', node.targetNodeId);
			element.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
			element.append(createBacklinkIndicator(ownerDocument));
		}
	}

	return element;
}

/** Standalone presentation과 grouped File Row가 공유하는 icon/name content를 추가한다. */
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

	if (file.presentation === 'backlink') {
		element.append(createBacklinkIndicator(ownerDocument));
	}
}

/** Backlink 대상 Root를 DOM 식별값과 최소 시각 상태로 반영한다. */
function applyFileBacklinkAttributes(
	element: HTMLElement,
	file: GraphFileNode,
): void {
	if (file.presentation !== 'backlink' || !file.targetRootId) {
		return;
	}

	element.classList.add('is-backlink');
	element.setAttribute('data-graph-backlink', 'file');
	element.setAttribute('data-target-root-id', file.targetRootId);
	element.setAttribute('data-target-node-id', file.id);
	element.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
}

/** 기존 Node content 끝에 공통 북동쪽 화살표 상태만 추가한다. */
function createBacklinkIndicator(ownerDocument: Document): HTMLElement {
	const indicator = ownerDocument.createElement('span');

	indicator.className = 'graph-backlink-indicator';
	indicator.setAttribute('aria-hidden', 'true');
	indicator.textContent = '↗';

	return indicator;
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

/**
 * 기존 Project/Folder DOM의 Directory 상태 Class를 최신 Layout 상태와 맞춘다.
 * Project/Folder가 아닌 Node에는 Directory 상태를 적용하지 않는다.
 */
function updateContainerStatusState(
	element: HTMLElement,
	node: GraphLayoutNode,
): void {
	if (node.kind !== 'project' && node.kind !== 'folder') {
		return;
	}

	if (node.status === 'unreadable') {
		element.classList.add('is-unreadable');
	} else {
		element.classList.remove('is-unreadable');
	}
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

/** Graph State page를 기준으로 grouped File Group 내부 DOM과 Listener만 교체한다. */
function initializeFileGroupContent(
	element: HTMLElement,
	node: GraphFileGroupNode,
	ownerDocument: Document,
	graphState: GraphStateStore,
	interactions: GraphRendererInteractions,
	rootNodeIds: ReadonlySet<string>,
	initializeBacklink: BacklinkInitializer,
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
				const row = createFileRow(
					file,
					ownerDocument,
					interactions,
					rootNodeIds,
					initializeBacklink,
				);

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
	rootNodeIds: ReadonlySet<string>,
	initializeBacklink: BacklinkInitializer,
): FileRowRenderer {
	const item = ownerDocument.createElement('li');

	item.className = 'graph-file-item';
	item.setAttribute('data-file-id', file.id);
	item.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	applyFileBacklinkAttributes(item, file);
	appendFileContent(item, file, ownerDocument);
	const disposeBacklinkClick = file.presentation === 'backlink' && file.targetRootId
		? initializeBacklink(item, file.targetRootId)
		: undefined;
	const detachDrag = file.presentation === 'backlink' || rootNodeIds.has(file.id)
		? undefined
		: appendDetachHandle(item, file.id, ownerDocument, interactions);
	/** File Group이 아닌 현재 Row에만 Click feedback을 다시 시작한다. */
	const animateFileClick = (): void => {
		item.classList.remove(FILE_CLICK_ANIMATION_CLASS);
		void item.offsetWidth;
		item.classList.add(FILE_CLICK_ANIMATION_CLASS);
	};
	const handleFileClick = (event: MouseEvent): void => {
		event.stopPropagation();

		if (file.presentation === 'backlink') {
			return;
		}

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
			disposeBacklinkClick?.();
			detachDrag?.dispose();
			item.removeEventListener('click', handleFileClick);
			item.removeEventListener('animationend', handleFileClickAnimationEnd);
			item.classList.remove(FILE_CLICK_ANIMATION_CLASS);
		},
	};
}

/** Folder/standalone File Card에서 사용할 Backlink 대상 Root ID를 찾는다. */
function getNodeBacklinkTargetRootId(
	node: GraphLayoutNode,
): string | undefined {
	if (node.kind === 'folder-backlink') {
		return node.targetRootId;
	}

	if (node.kind !== 'file-group' || node.presentation !== 'standalone') {
		return undefined;
	}

	const file = node.children[0];

	return file?.presentation === 'backlink' ? file.targetRootId : undefined;
}

/** Backlink Click만 소비하고 Camera Pan 및 일반 Node/File interaction을 차단한다. */
function initializeBacklinkClick(
	element: HTMLElement,
	targetRootId: string,
	interactions: GraphRendererInteractions,
): () => void {
	const handleClick = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		interactions.onBacklinkClick?.(targetRootId);
	};

	element.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	element.addEventListener('click', handleClick);

	return () => {
		element.removeEventListener('click', handleClick);
	};
}

/** Project와 Root Node를 제외하고 Card 자체에서 분리할 Folder/File ID를 찾는다. */
function getDetachNodeId(
	node: GraphLayoutNode,
	rootNodeIds: ReadonlySet<string>,
): string | undefined {
	if (node.kind === 'folder') {
		return rootNodeIds.has(node.id) ? undefined : node.id;
	}

	if (node.kind !== 'file-group' || node.presentation !== 'standalone') {
		return undefined;
	}

	const file = node.children[0];

	return file
		&& file.presentation !== 'backlink'
		&& !rootNodeIds.has(file.id)
		? file.id
		: undefined;
}

/** 대상 끝에 고정 공간의 Handle을 추가하고 독립 Detach Drag를 초기화한다. */
function appendDetachHandle(
	target: HTMLElement,
	nodeId: string,
	ownerDocument: Document,
	interactions: GraphRendererInteractions,
): GraphDetachDrag {
	const handle = createDetachHandle(ownerDocument);

	target.append(handle);
	const detachDrag = initializeGraphDetachDrag(handle, nodeId, {
		onDetachDrop: interactions.onDetachDrop,
	});

	return {
		dispose(): void {
			detachDrag.dispose();
			handle.remove();
		},
	};
}

/** 현재 Node 스타일에 맞는 북동쪽 화살표 inline SVG Handle을 만든다. */
function createDetachHandle(ownerDocument: Document): HTMLButtonElement {
	const handle = ownerDocument.createElement('button');
	const icon = ownerDocument.createElementNS(SVG_NAMESPACE, 'svg');
	const path = ownerDocument.createElementNS(SVG_NAMESPACE, 'path');

	handle.className = 'graph-detach-handle';
	handle.type = 'button';
	handle.setAttribute('aria-label', 'Graph Root로 분리');
	handle.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	icon.classList.add('graph-detach-icon');
	icon.setAttribute('viewBox', '0 0 16 16');
	icon.setAttribute('fill', 'none');
	icon.setAttribute('aria-hidden', 'true');
	icon.setAttribute('focusable', 'false');
	path.setAttribute('d', DETACH_ARROW_PATH);
	path.setAttribute('stroke', 'currentColor');
	path.setAttribute('stroke-width', '1.5');
	path.setAttribute('stroke-linecap', 'round');
	path.setAttribute('stroke-linejoin', 'round');
	icon.append(path);
	handle.append(icon);

	return handle;
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
		if (node.presentation === 'standalone') {
			const file = node.children[0];

			return file
				&& file.presentation !== 'backlink'
				&& interactions.onFileClick
				? () => interactions.onFileClick?.(file.id)
				: undefined;
		}

		const parentId = node.parentId;

		return parentId && interactions.onFileGroupClick
			? () => interactions.onFileGroupClick?.(parentId)
			: undefined;
	}

	if (node.kind === 'folder-backlink') {
		return undefined;
	}

	return interactions.onFolderClick
		? () => interactions.onFolderClick?.(node.id)
		: undefined;
}

/** Backlink는 원래 위치를 나타내는 정적 presentation이므로 Node Move 대상에서 뺀다. */
function isMovableLayoutNode(node: GraphLayoutNode): boolean {
	if (node.kind === 'folder-backlink') {
		return false;
	}

	return node.kind !== 'file-group'
		|| node.presentation !== 'standalone'
		|| node.children[0]?.presentation !== 'backlink';
}

/** DOM/Row interaction을 재생성해야 하는 Layout presentation 변경을 판별한다. */
function hasSameNodePresentation(
	previous: GraphLayoutNode,
	next: GraphLayoutNode,
): boolean {
	if (previous.kind !== next.kind || previous.name !== next.name) {
		return false;
	}

	if (previous.kind === 'folder-backlink' && next.kind === 'folder-backlink') {
		return previous.targetRootId === next.targetRootId
			&& previous.targetNodeId === next.targetNodeId;
	}

	if (previous.kind !== 'file-group' || next.kind !== 'file-group') {
		return true;
	}

	return previous.presentation === next.presentation
		&& previous.parentId === next.parentId
		&& previous.children.length === next.children.length
		&& previous.children.every((file, index) => {
			const nextFile = next.children[index];

			return nextFile?.id === file.id
				&& nextFile.name === file.name
				&& nextFile.presentation === file.presentation
				&& nextFile.targetRootId === file.targetRootId;
		});
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
