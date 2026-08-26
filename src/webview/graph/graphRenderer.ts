import {
	GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE,
	type GraphAnimationFrameScheduler,
} from './graphCamera';
import {
	createFileGroupId,
	createGraphLayoutNodeId,
	GRAPH_FILE_GROUP_NODE_WIDTH,
	GRAPH_FILE_GROUP_ROW_HEIGHT,
	GRAPH_FILE_GROUP_STANDALONE_HEIGHT,
	getGraphLayoutRootId,
	getGraphLayoutSourceId,
	resolveGraphLayoutNodePosition,
} from './graphLayout';
import type {
	GraphFileNode,
	GraphFileGroupNode,
	GraphLayout,
	GraphLayoutEdge,
	GraphLayoutNode,
	GraphLayoutPosition,
} from './graphLayout';
import { collectGraphLayoutSubtreeNodeIds } from './graphLayoutTransition';
import {
	getDetachedRootOrdinal,
	getDetachedRootOriginId,
} from './graphRootPromotion';
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
import {
	fitRelativePath,
	GRAPH_ROOT_CONTEXT_MAX_WIDTH_MULTIPLIER,
} from './graphRootContext';
import type { GraphNodeEffects } from './graphNodeEffects';
import {
	AGENT_ACTIVITY_BINDING_TOP_GAP,
	getAgentActivityBindingBlockHeight,
	type AgentActivityBindings,
} from './agentActivityBindings';
import type { GitDecorationBindings } from './gitDecorationStore';

interface FileGroupContentRenderer {
	render(page: number): void;
	applyLayout(
		node: GraphFileGroupNode,
		rootNodeIds: ReadonlySet<string>,
	): void;
	dispose(): void;
}

type FileRowRenderer = {
	readonly element: HTMLLIElement;
	readonly dispose: () => void;
};

type FileArrangementDragInitializer = (
	element: HTMLElement,
	file: GraphFileNode,
	fileGroupId: string,
	onDragComplete: () => void,
) => GraphDetachDrag;

type BacklinkInitializer = (
	element: HTMLElement,
	targetRootIds: readonly string[],
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

interface DetachedRootActionRenderer {
	readonly rootId: string;
	dispose(): void;
}

/** 같은 Parent 아래 정렬된 Card/Placeholder들이 만드는 하나의 복구 영역이다. */
interface GraphArrangementDropZone {
	readonly hitBounds: readonly DOMRect[];
	readonly highlightElements: readonly HTMLElement[];
}

/** Graph Node/Edge DOM과 interaction lifecycle을 관리한다. */
export interface GraphRenderer {
	/** 기존 Node/Edge DOM을 새로운 Layout geometry와 동기화한다. */
	applyLayout(
		layout: GraphLayout,
		nodePositions?: Readonly<Record<string, GraphLayoutPosition>>,
		options?: GraphLayoutApplyOptions,
	): void;
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
	/** Standalone presentation 또는 일반 File Row가 Double Click됐을 때 안정적인 File ID를 전달한다. */
	onFileOpenRequest?: (fileId: string) => void;
	/** Handle Drag가 완료됐을 때 대상 ID와 client 좌표를 상위로 전달한다. */
	onDetachDrop?: (request: GraphDetachDropRequest) => void;
	/** Folder/File Backlink Click 시 연결된 Graph Root ID를 전달한다. */
	onBacklinkClick?: (targetRootId: string) => void;
	/** Context Label Click 시 현재 Graph Root ID를 전달한다. */
	onRootContextClick?: (rootId: string) => void;
	/** Detached Root Hover Action의 Duplicate 요청을 Instance ID로 전달한다. */
	onDetachedRootDuplicate?: (rootId: string) => void;
	/** Detached Root Hover Action의 Delete 요청을 Instance ID로 전달한다. */
	onDetachedRootDelete?: (rootId: string) => void;
	/** Layout Root Node ID를 최신 Graph Root ID로 해석한다. */
	resolveRootId?: (rootNodeId: string) => string | undefined;
	/** 자신의 Backlink Target에 Drop된 Root의 제거 또는 확인 대기를 상위 View에 요청한다. */
	onRootReattach?: (
		request: GraphRootReattachRequest,
	) => GraphRootReattachResult;
	/** 일반 Node Drag 결과를 정렬 flow 포함 여부로 반영하도록 상위 View에 요청한다. */
	onNodeArrangementChange?: (request: GraphNodeArrangementRequest) => boolean;
	/**
	 * Node body에서 위치/Scope source Drag를 시작할 수 있는지 판별한다.
	 * Detach Handle과 Backlink interaction에는 적용하지 않는다.
	 */
	canStartNodeBodyDrag?: (nodeId: string) => boolean;
	/**
	 * 보이는 Layout subtree를 기준으로 접힌 Node와 외부 고정 경계를 반영한
	 * 최종 Drag 이동 대상 Visual ID를 해석한다.
	 */
	resolveNodeSubtreeIds?: (
		nodeId: string,
		visibleSubtreeNodeIds: ReadonlySet<string>,
	) => ReadonlySet<string>;
	/** 실제 Folder/File Pointer drag의 Canonical Source와 최신 client 좌표를 전달한다. */
	onSourceDragMove?: (request: GraphSourceDragRequest) => void;
	/** Task Scope 등 우선 Drop 의미가 처리되면 실제 occurrence의 최종 좌표를 반환한다. */
	onSourceDrop?: (
		request: GraphSourceDragRequest,
	) => GraphSourceDropResult | boolean;
	/** Pointer cancel/capture 상실/dispose 시 외부 Drop feedback을 정리한다. */
	onSourceDragCancel?: () => void;
}

/** 우선 Drop이 실제 이동 중인 occurrence를 유지할 때 사용할 완료 결과다. */
export interface GraphSourceDropResult {
	/** 없으면 promotion 등으로 새 occurrence가 Graph Layout에 들어온 경우다. */
	readonly targetPosition?: GraphLayoutPosition;
	/** 기존 occurrence가 남아 있으면 transient subtree를 저장 없이 시작점으로 되돌린다. */
	readonly restoreStartPosition?: boolean;
	/** 상위 View가 boundary-aware GraphState를 확정했으므로 transient DOM을 그 좌표로 맞춘다. */
	readonly syncStoredPositions?: boolean;
}

/** Canonical Source와 실제 Graph visual occurrence를 함께 전달하는 drag 관찰 값이다. */
export interface GraphSourceDragRequest {
	readonly sourceNodeId: string;
	/** GraphState/nodePositions 또는 grouped row를 식별하는 기존 visual ID다. */
	readonly occurrenceNodeId: string;
	/** Detached subtree 안의 occurrence면 기존 Graph Root Instance ID다. */
	readonly occurrenceRootId?: string;
	/** 현재 visual이 독립 Root여서 promotion 없이 그대로 Scope에 남을 수 있는지다. */
	readonly isIndependentOccurrence: boolean;
	/** Pointer가 현재 actual Root의 기존 Backlink reattach zone에 있으면 Root ID다. */
	readonly reattachTargetRootId?: string;
	/** Pointer가 occurrence의 기존 정렬 복귀 zone에 있으면 true다. */
	readonly isArrangementTarget?: boolean;
	/** 실제 Graph Node drag일 때 다른 bound occurrence를 꺼낼 수 있는 시작 World 위치다. */
	readonly startPosition?: GraphLayoutPosition;
	/** Pointer 종료 시 Renderer가 가진 transient actual occurrence World 위치다. */
	readonly currentPosition?: GraphLayoutPosition;
	readonly clientX: number;
	readonly clientY: number;
}

/** Reattach가 확인된 Root와 실제 Node를 최신 Graph 변경 경로에 전달한다. */
export interface GraphRootReattachRequest {
	readonly rootId: string;
	readonly nodeId: string;
}

/** 즉시 복구 여부 또는 Drag만 먼저 취소하고 사용자 확인을 기다리는 결과다. */
export type GraphRootReattachResult = boolean | 'deferred';

/** Node Drag가 정렬 영역 안/밖에서 끝났을 때 전달하는 상태 전환 요청이다. */
export interface GraphNodeArrangementRequest {
	readonly nodeId: string;
	readonly arranged: boolean;
}

/** Renderer 위치 Animation의 platform dependency와 동작을 선택적으로 제어한다. */
export interface GraphRendererOptions {
	animationFrameScheduler?: GraphAnimationFrameScheduler;
	transitionDuration?: number;
	prefersReducedMotion?: boolean;
	/** Renderer DOM의 생성/제거를 transient Node Effect registration과 연결한다. */
	nodeEffects?: Pick<GraphNodeEffects, 'registerNode'>
		& Partial<Pick<GraphNodeEffects, 'syncLayout'>>;
	/** Renderer DOM의 생성/제거 및 Layout을 Agent Binding과 연결한다. */
	agentActivityBindings?: Pick<AgentActivityBindings, 'registerTarget'>
		& Partial<Pick<AgentActivityBindings, 'syncLayout'>>;
	/** Git runtime snapshot을 실제 Source file/folder DOM occurrence에만 연결한다. */
	gitDecorations?: GitDecorationBindings;
}

/** 특정 Layout 전환에서 새 Detached subtree가 출발할 기존 Instance를 지정한다. */
export interface GraphLayoutApplyOptions {
	readonly enteringSourceRootId?: string;
	/** 이 전환만 즉시 적용한다. Renderer 전역 reduced-motion 설정은 그대로 우선한다. */
	readonly animate?: boolean;
}

/** 단일 Layout transition에서 보간할 Node의 시작/목표 위치다. */
interface GraphNodePositionTransition {
	readonly from: GraphLayoutPosition;
	readonly to: GraphLayoutPosition;
}

/** 진행 중인 Layout 위치 Animation과 예약 Frame이다. */
interface GraphLayoutAnimationSession {
	readonly transitions: ReadonlyMap<string, GraphNodePositionTransition>;
	readonly enteringNodes: readonly HTMLElement[];
	readonly exitingNodes: readonly GraphExitingNodeTransition[];
	readonly enteringEdges: readonly SVGPathElement[];
	readonly exitingEdges: readonly SVGPathElement[];
	readonly duration: number;
	startTime?: number;
	frameRequestId?: number;
}

/** Layout에서 사라지는 Node DOM과 현재 위치 및 수렴할 Ancestor 위치다. */
interface GraphExitingNodeTransition {
	readonly element: HTMLElement;
	readonly from: GraphLayoutPosition;
	readonly to: GraphLayoutPosition;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const FOLDER_OPEN_ICON = 'folder-open.svg';
const FOLDER_CLOSED_ICON = 'folder-closed.svg';
const COLLAPSE_CHEVRON_PATH = 'm4.5 10 3.5-3.5 3.5 3.5';
const DETACH_ARROW_PATH = 'M4 12 12 4 M7 4h5v5';
const FILE_CLICK_ANIMATION_CLASS = 'is-file-clicking';
const REATTACH_TARGET_CLASS = 'is-reattach-target';
const REATTACH_TARGET_MARGIN = 8;
const ARRANGEMENT_TARGET_CLASS = 'is-arrangement-target';
const ARRANGEMENT_TARGET_MARGIN = 10;
const DEFAULT_LAYOUT_TRANSITION_DURATION = 220;
const LAYOUT_NODE_MIN_SCALE = 0.96;
const LAYOUT_TRANSITION_CLASS = 'is-layout-transitioning';
const LAYOUT_EXIT_CLASS = 'is-layout-exiting';
const DUPLICATE_ICON_ASSET = 'duplicate.svg';
const DELETE_ICON_ASSET = 'delete.svg';

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
	options: GraphRendererOptions = {},
): GraphRenderer {
	const ownerDocument = nodeLayer.ownerDocument;
	const animationFrameScheduler = options.animationFrameScheduler
		?? resolveRendererAnimationFrameScheduler(ownerDocument);
	const transitionDuration = Math.max(
		0,
		options.transitionDuration ?? DEFAULT_LAYOUT_TRANSITION_DURATION,
	);
	let renderedLayout = layout;
	let nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
	const nodeElements = new Map<string, HTMLElement>();
	const edgeElements = new Map<string, SVGPathElement>();
	const edgesByNodeId = new Map<string, GraphLayoutEdge[]>();
	const initialState = graphState.getState();
	const renderedPositions = new Map<string, GraphLayoutPosition>(
		layout.nodes.map((node) => [
			node.id,
			resolveGraphLayoutNodePosition(node, initialState.nodePositions),
		]),
	);
	const nodeDrags = new Map<string, GraphNodeDrag>();
	const nodeDetachDrags = new Map<string, GraphDetachDrag>();
	const nodeFileOpenRequestCleanups = new Map<string, () => void>();
	const nodeEffectCleanups = new Map<string, () => void>();
	const nodeActivityBindingCleanups = new Map<string, () => void>();
	const nodeGitDecorationCleanups = new Map<string, () => void>();
	const backlinkClickCleanups = new Map<string, () => void>();
	const backlinkElements = new Map<string, HTMLElement>();
	const fileGroupContents = new Map<string, FileGroupContentRenderer>();
	const rootContextLabels = new Map<string, RootContextLabelRenderer>();
	const detachedRootBadges = new Map<string, HTMLElement>();
	const detachedRootActions = new Map<string, DetachedRootActionRenderer>();
	let rootNodeIds = layout.rootNodeIds;
	let disposed = false;
	let layoutAnimation: GraphLayoutAnimationSession | undefined;
	let activeReattachTarget: {
		readonly rootId: string;
		readonly element: HTMLElement;
	} | undefined;
	let activeArrangementDrag: {
		readonly nodeId: string;
		readonly wasUnarranged: boolean;
		readonly dropZone?: GraphArrangementDropZone;
		readonly placeholder?: HTMLElement;
		readonly sourceElement?: HTMLElement;
		readonly preview?: HTMLElement;
		isDropZoneActive?: boolean;
	} | undefined;
	/** 정렬 Drag placeholder와 hover target 표시를 모두 제거한다. */
	const clearArrangementDrag = (): void => {
		if (!activeArrangementDrag) {
			return;
		}

		for (const element of activeArrangementDrag.dropZone?.highlightElements ?? []) {
			element.classList.remove(ARRANGEMENT_TARGET_CLASS);
		}

		activeArrangementDrag.placeholder?.remove();
		activeArrangementDrag.sourceElement?.classList.remove(
			'is-arrangement-drag-source',
		);
		activeArrangementDrag.preview?.remove();
		activeArrangementDrag = undefined;
	};
	/** 최신 World 위치와 Camera scale로 Node의 client rect를 계산한다. */
	const getNodeClientRect = (nodeId: string): DOMRect | undefined => {
		const node = nodesById.get(nodeId);
		const position = renderedPositions.get(nodeId);

		if (!node || !position) {
			return undefined;
		}

		const layerBounds = nodeLayer.getBoundingClientRect();
		const scale = graphState.getState().camera.scale;
		const left = layerBounds.left + position.x * scale;
		const top = layerBounds.top + position.y * scale;

		return createClientRect(
			left,
			top,
			node.width * scale,
			node.height * scale,
		);
	};
	/** 직접 Parent의 정렬 child 영역을 찾아 placeholder와 hover 대상을 준비한다. */
	const beginArrangementDrag = (
		nodeId: string,
		sourcePosition: GraphLayoutPosition,
	): void => {
		clearArrangementDrag();
		const wasUnarranged = renderedLayout.unarrangedNodeIds.has(nodeId);
		const parentId = renderedLayout.edges.find(
			(edge) => edge.targetId === nodeId,
		)?.sourceId;

		// Graph Root는 sibling 목록의 구성원이 아니므로 정렬 Drag 대상으로 보지 않는다.
		// Detached Root의 복귀는 기존 Backlink reattach interaction이 전담한다.
		if (!parentId) {
			return;
		}

		const sourceNode = nodesById.get(nodeId);
		const floatingFileNode = sourceNode?.kind === 'file-group'
			&& sourceNode.presentation === 'standalone'
			&& sourceNode.id === sourceNode.children[0]?.id
			&& sourceNode.children[0].presentation !== 'backlink'
			? sourceNode
			: undefined;

		if (wasUnarranged && floatingFileNode?.parentId) {
			const sourceFileGroupId = createFileGroupId(
				getGraphLayoutSourceId(floatingFileNode.parentId),
			);
			const layoutRootId = getGraphLayoutRootId(floatingFileNode.parentId);
			const fileGroupId = layoutRootId
				? createGraphLayoutNodeId(layoutRootId, sourceFileGroupId)
				: sourceFileGroupId;
			const fileGroup = nodesById.get(fileGroupId);
			const targetElement = nodeElements.get(fileGroupId);
			const isGroupedTarget = fileGroup?.kind === 'file-group'
				&& fileGroup.presentation === 'grouped';

			if (isGroupedTarget && targetElement) {
				const targetBounds = getNodeClientRect(fileGroupId);

				activeArrangementDrag = {
					nodeId,
					wasUnarranged,
					dropZone: targetBounds
						? {
							hitBounds: [targetBounds],
							highlightElements: [targetElement],
						}
						: undefined,
				};
				return;
			}
		}

		const siblingIds = parentId
			? renderedLayout.edges
				.filter((edge) => (
					edge.sourceId === parentId
						&& edge.targetId !== nodeId
						&& renderedLayout.arrangedNodeIds.has(edge.targetId)
				))
				.map((edge) => edge.targetId)
				.filter((siblingId) => (
					nodeElements.get(siblingId)?.hidden === false
				))
			: [];
		let placeholder: HTMLElement | undefined;
		const targetEntries = siblingIds.flatMap((siblingId) => {
			const element = nodeElements.get(siblingId);
			const bounds = getNodeClientRect(siblingId);

			return element && bounds ? [{ element, bounds }] : [];
		});

		if (!wasUnarranged) {
			if (sourceNode) {
				placeholder = ownerDocument.createElement('div');
				placeholder.className = 'graph-arrangement-placeholder';
				placeholder.setAttribute('data-graph-arrangement-placeholder-id', nodeId);
				placeholder.style.width = `${sourceNode.width}px`;
				placeholder.style.height = `${getRenderedNodeHeight(sourceNode)}px`;
				placeholder.style.transform = `translate(${sourcePosition.x}px, ${sourcePosition.y}px)`;
				nodeLayer.append(placeholder);
				const sourceBounds = getNodeClientRect(nodeId);

				if (sourceBounds) {
					targetEntries.push({ element: placeholder, bounds: sourceBounds });
				}
			}
		}

		if (targetEntries.length === 0 && parentId) {
			const parentElement = nodeElements.get(parentId);

			if (parentElement && !parentElement.hidden) {
				const parentBounds = getNodeClientRect(parentId);

				if (parentBounds) {
					targetEntries.push({
						element: parentElement,
						bounds: parentBounds,
					});
				}
			}
		}

		activeArrangementDrag = {
			nodeId,
			wasUnarranged,
			dropZone: targetEntries.length > 0
				? {
					hitBounds: targetEntries.map(({ bounds }) => bounds),
					highlightElements: targetEntries.map(({ element }) => element),
				}
				: undefined,
			placeholder,
		};
	};
	/** Grouped File Row의 원래 목록 target과 standalone 전환 preview를 준비한다. */
	const beginFileArrangementDrag = (
		file: GraphFileNode,
		fileGroupId: string,
		sourceElement: HTMLElement,
	): HTMLElement | undefined => {
		clearArrangementDrag();
		const targetElement = nodeElements.get(fileGroupId);

		if (!targetElement) {
			return undefined;
		}
		const targetBounds = getNodeClientRect(fileGroupId);
		const preview = ownerDocument.createElement('div');
		const name = ownerDocument.createElement('span');

		preview.className = 'graph-node graph-file-group-node graph-arrangement-drag-preview';
		preview.setAttribute('data-graph-arrangement-preview-id', file.id);
		preview.style.width = `${GRAPH_FILE_GROUP_NODE_WIDTH}px`;
		preview.style.height = `${GRAPH_FILE_GROUP_STANDALONE_HEIGHT}px`;
		name.className = 'graph-file-name';
		name.textContent = file.name;
		preview.append(name);
		nodeLayer.append(preview);
		sourceElement.classList.add('is-arrangement-drag-source');
		activeArrangementDrag = {
			nodeId: file.id,
			wasUnarranged: false,
			dropZone: targetBounds
				? {
					hitBounds: [targetBounds],
					highlightElements: [targetElement],
				}
				: undefined,
			sourceElement,
			preview,
		};
		return preview;
	};
	/** Pointer 중심에 grouped File preview를 두고 standalone World 좌표를 반환한다. */
	const moveFileArrangementPreview = (
		preview: HTMLElement,
		clientX: number,
		clientY: number,
	): GraphLayoutPosition => {
		const layerBounds = nodeLayer.getBoundingClientRect();
		const scale = graphState.getState().camera.scale;
		const position = {
			x: (clientX - layerBounds.left) / scale
				- GRAPH_FILE_GROUP_NODE_WIDTH / 2,
			y: (clientY - layerBounds.top) / scale
				- GRAPH_FILE_GROUP_STANDALONE_HEIGHT / 2,
		};

		preview.style.transform = `translate(${position.x}px, ${position.y}px)`;
		return position;
	};
	/** Pointer/Card가 정렬 목록에 들어왔는지 판별하고 목록의 모든 슬롯을 강조한다. */
	const updateArrangementTarget = (
		clientX: number,
		clientY: number,
	): boolean => {
		const session = activeArrangementDrag;
		const draggedBounds = session && !session.preview
			? getNodeClientRect(session.nodeId)
			: undefined;
		const isTarget = session?.dropZone
			? isArrangementDropZoneHit(
				session.dropZone,
				clientX,
				clientY,
				ARRANGEMENT_TARGET_MARGIN,
				draggedBounds,
			)
			: false;

		if (!session || session.isDropZoneActive === isTarget) {
			return isTarget;
		}

		for (const element of session.dropZone?.highlightElements ?? []) {
			if (isTarget) {
				element.classList.add(ARRANGEMENT_TARGET_CLASS);
			} else {
				element.classList.remove(ARRANGEMENT_TARGET_CLASS);
			}
		}
		session.isDropZoneActive = isTarget;

		return isTarget;
	};
	/** 숨겨지지 않은 최신 Backlink DOM만 interaction 대상으로 반환한다. */
	const getVisibleBacklinkElement = (
		targetRootId: string,
	): HTMLElement | undefined => {
		const element = backlinkElements.get(targetRootId);

		return element?.hidden === false ? element : undefined;
	};
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
		const element = rootId ? getVisibleBacklinkElement(rootId) : undefined;
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
	const initializeBacklink: BacklinkInitializer = (element, targetRootIds) => {
		const targetRootId = targetRootIds[0];

		if (!targetRootId) {
			return () => undefined;
		}

		for (const rootId of targetRootIds) {
			backlinkElements.set(rootId, element);
		}

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

			for (const rootId of targetRootIds) {
				if (backlinkElements.get(rootId) === element) {
					backlinkElements.delete(rootId);
				}
			}
		};
	};

	/** 새 Edge path를 생성해 Layer와 ID Map에 등록한다. */
	const addEdge = (edge: GraphLayoutEdge): void => {
		const path = ownerDocument.createElementNS(SVG_NAMESPACE, 'path');

		path.classList.add('graph-edge');
		path.setAttribute('data-graph-edge-id', edge.id);
		syncEdgeVisibility(path, edge);
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

	/** G-11 Effect Region과 G-12 Binding horizontal bounds를 같은 Layout으로 맞춘다. */
	const syncPresentationLayout = (
		currentLayout: GraphLayout,
		currentPositions: ReadonlyMap<string, GraphLayoutPosition>,
		transitionDuration = 0,
	): void => {
		options.nodeEffects?.syncLayout?.(
			currentLayout,
			currentPositions,
			transitionDuration,
		);
		options.agentActivityBindings?.syncLayout?.(
			currentLayout,
			currentPositions,
			transitionDuration,
		);
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
		if (!pendingEdges) {
			syncPresentationLayout(renderedLayout, renderedPositions);
		}
	};

	/** Layout 출입 효과를 완료하고 임시 DOM/inline style을 정리한다. */
	const finishLayoutVisualTransition = (
		session: GraphLayoutAnimationSession,
	): void => {
		for (const element of session.enteringNodes) {
			element.classList.remove(LAYOUT_TRANSITION_CLASS);
			element.style.opacity = '';
			element.style.scale = '';
		}

		for (const element of session.enteringEdges) {
			element.classList.remove(LAYOUT_TRANSITION_CLASS);
			element.style.opacity = '';
		}

		for (const transition of session.exitingNodes) {
			transition.element.remove();
		}

		for (const element of session.exitingEdges) {
			element.remove();
		}
	};

	/** 예약 Frame을 취소하되 유지 Node의 현재 보간 위치는 다음 시작점으로 남긴다. */
	const cancelLayoutAnimation = (): void => {
		const session = layoutAnimation;

		layoutAnimation = undefined;

		if (session?.frameRequestId !== undefined) {
			animationFrameScheduler?.cancel(session.frameRequestId);
		}

		if (session) {
			finishLayoutVisualTransition(session);
		}
	};

	/** 진행 중 Transition의 모든 Node와 연결 Edge를 목표 위치로 즉시 완료한다. */
	const finishLayoutAnimation = (): void => {
		const session = layoutAnimation;

		if (!session) {
			return;
		}

		cancelLayoutAnimation();
		const pendingEdges = new Map<string, GraphLayoutEdge>();

		for (const [nodeId, transition] of session.transitions) {
			updateNodePosition(nodeId, transition.to, pendingEdges);
		}

		for (const edge of pendingEdges.values()) {
			renderEdge(edge);
		}
	};

	/** Node와 연결 Edge를 같은 RAF에서 ease-out 보간하는 단일 Layout transition을 시작한다. */
	const startLayoutAnimation = (
		transitions: ReadonlyMap<string, GraphNodePositionTransition>,
		visualTransition: Pick<
			GraphLayoutAnimationSession,
			'enteringNodes' | 'exitingNodes' | 'enteringEdges' | 'exitingEdges'
		>,
		targetPositions: ReadonlyMap<string, GraphLayoutPosition>,
		allowAnimation = true,
	): void => {
		const prefersReducedMotion = options.prefersReducedMotion
			?? ownerDocument.defaultView?.matchMedia?.(
				'(prefers-reduced-motion: reduce)',
			).matches
				?? false;
		const canAnimate = animationFrameScheduler !== undefined
			&& transitionDuration > 0
			&& !prefersReducedMotion
			&& allowAnimation;

		syncPresentationLayout(
			renderedLayout,
			targetPositions,
			canAnimate ? transitionDuration : 0,
		);

		if (
			(
				transitions.size === 0
				&& visualTransition.enteringNodes.length === 0
				&& visualTransition.exitingNodes.length === 0
				&& visualTransition.enteringEdges.length === 0
				&& visualTransition.exitingEdges.length === 0
			)
			|| !canAnimate
		) {
			const pendingEdges = new Map<string, GraphLayoutEdge>();

			for (const [nodeId, transition] of transitions) {
				updateNodePosition(nodeId, transition.to, pendingEdges);
			}

			for (const edge of pendingEdges.values()) {
				renderEdge(edge);
			}

			finishLayoutVisualTransition({
				...visualTransition,
				transitions,
				duration: transitionDuration,
			});
			return;
		}

		const session: GraphLayoutAnimationSession = {
			transitions,
			...visualTransition,
			duration: transitionDuration,
		};

		for (const element of session.enteringNodes) {
			element.classList.add(LAYOUT_TRANSITION_CLASS);
			element.style.opacity = '0';
			element.style.scale = String(LAYOUT_NODE_MIN_SCALE);
		}

		for (const element of session.enteringEdges) {
			element.classList.add(LAYOUT_TRANSITION_CLASS);
			element.style.opacity = '0';
		}

		for (const transition of session.exitingNodes) {
			transition.element.classList.add(
				LAYOUT_TRANSITION_CLASS,
				LAYOUT_EXIT_CLASS,
			);
			transition.element.style.opacity = '1';
			transition.element.style.scale = '1';
		}

		for (const element of session.exitingEdges) {
			element.classList.add(
				LAYOUT_TRANSITION_CLASS,
				LAYOUT_EXIT_CLASS,
			);
			element.style.opacity = '1';
		}
		const renderFrame = (timestamp: number): void => {
			if (disposed || layoutAnimation !== session) {
				return;
			}

			session.frameRequestId = undefined;
			session.startTime ??= timestamp;
			const progress = Math.min(
				1,
				Math.max(0, (timestamp - session.startTime) / session.duration),
			);
			const easedProgress = easeOutCubic(progress);
			const pendingEdges = new Map<string, GraphLayoutEdge>();

			for (const [nodeId, transition] of session.transitions) {
				updateNodePosition(nodeId, {
					x: interpolate(
						transition.from.x,
						transition.to.x,
						easedProgress,
					),
					y: interpolate(
						transition.from.y,
						transition.to.y,
						easedProgress,
					),
				}, pendingEdges);
			}

			for (const element of session.enteringNodes) {
				element.style.opacity = String(easedProgress);
				element.style.scale = String(interpolate(
					LAYOUT_NODE_MIN_SCALE,
					1,
					easedProgress,
				));
			}

			for (const element of session.enteringEdges) {
				element.style.opacity = String(easedProgress);
			}

			for (const transition of session.exitingNodes) {
				transition.element.style.opacity = String(1 - easedProgress);
				transition.element.style.scale = String(interpolate(
					1,
					LAYOUT_NODE_MIN_SCALE,
					easedProgress,
				));
				transition.element.style.transform = `translate(${interpolate(
					transition.from.x,
					transition.to.x,
					easedProgress,
				)}px, ${interpolate(
					transition.from.y,
					transition.to.y,
					easedProgress,
				)}px)`;
			}

			for (const element of session.exitingEdges) {
				element.style.opacity = String(1 - easedProgress);
			}

			for (const edge of pendingEdges.values()) {
				renderEdge(edge);
			}

			if (progress === 1) {
				layoutAnimation = undefined;
				finishLayoutVisualTransition(session);
				return;
			}

			session.frameRequestId = animationFrameScheduler.request(renderFrame);
		};

		layoutAnimation = session;
		session.frameRequestId = animationFrameScheduler.request(renderFrame);
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
	/** Detached Root Card에만 Layout 비참여 Hover Action을 추가하고 나머지에서는 정리한다. */
	const syncDetachedRootActions = (
		layoutNode: GraphLayoutNode,
		element: HTMLElement,
	): void => {
		const rootId = rootNodeIds.has(layoutNode.id)
			? getGraphLayoutRootId(layoutNode.id)
			: undefined;
		const current = detachedRootActions.get(layoutNode.id);

		if (!rootId) {
			current?.dispose();
			detachedRootActions.delete(layoutNode.id);
			return;
		}
		if (current?.rootId === rootId) {
			return;
		}

		current?.dispose();
		detachedRootActions.set(
			layoutNode.id,
			initializeDetachedRootActions(
				element,
				rootId,
				ownerDocument,
				interactions,
			),
		);
	};
	/** 같은 Source의 Detached Root가 둘 이상일 때만 Instance 순번 Badge를 붙인다. */
	const syncDetachedRootBadge = (
		layoutNode: GraphLayoutNode,
		element: HTMLElement,
		layout: GraphLayout,
	): void => {
		const ordinal = getDetachedRootBadgeOrdinal(layoutNode, layout);
		const current = detachedRootBadges.get(layoutNode.id);

		if (ordinal === undefined) {
			current?.remove();
			detachedRootBadges.delete(layoutNode.id);
			return;
		}

		const badge = current ?? ownerDocument.createElement('span');

		if (!current) {
			badge.className = 'graph-detached-root-badge';
			badge.setAttribute('aria-hidden', 'true');
			badge.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
			element.append(badge);
			detachedRootBadges.set(layoutNode.id, badge);
		}

		badge.textContent = String(ordinal);
		badge.setAttribute('data-detached-ordinal', String(ordinal));
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
			const bindingSourceId = getGraphBindingSourceId(layoutNode);

			nodeDetachDrags.set(
				layoutNode.id,
				appendDetachHandle(
					element,
					detachNodeId,
					layoutNode.id,
					getGraphLayoutRootId(layoutNode.id),
					ownerDocument,
					interactions,
					bindingSourceId,
				),
			);
		}
	};
	/** Grouped File Row를 기존 standalone arrangement와 Task Scope Drop에 함께 연결한다. */
	const initializeFileArrangementDrag: FileArrangementDragInitializer = (
		element,
		file,
		fileGroupId,
		onDragComplete,
	) => {
		const sourceNodeId = getGraphLayoutSourceId(file.id);
		const rootId = getGraphLayoutRootId(file.id);
		let preview: HTMLElement | undefined;
		let position: GraphLayoutPosition | undefined;

		return initializeGraphDetachDrag(element, sourceNodeId, {
			canStart: () => interactions.canStartNodeBodyDrag?.(file.id) !== false,
			onDragMove: ({ clientX, clientY }) => {
				preview ??= beginFileArrangementDrag(file, fileGroupId, element);
				if (preview) {
					position = moveFileArrangementPreview(preview, clientX, clientY);
				}
				interactions.onSourceDragMove?.({
					sourceNodeId,
					occurrenceNodeId: file.id,
					...(rootId ? { occurrenceRootId: rootId } : {}),
					isIndependentOccurrence: false,
					clientX,
					clientY,
				});
				updateArrangementTarget(clientX, clientY);
			},
			onDrop: ({ clientX, clientY }) => {
				const isArrangementTarget = updateArrangementTarget(clientX, clientY);
				const result = interactions.onSourceDrop?.({
					sourceNodeId,
					occurrenceNodeId: file.id,
					...(rootId ? { occurrenceRootId: rootId } : {}),
					isIndependentOccurrence: false,
					...(isArrangementTarget ? { isArrangementTarget: true } : {}),
					clientX,
					clientY,
				});

				return result === true || (
					typeof result === 'object' && result !== null
				);
			},
			onDetachDrop: ({ clientX, clientY }) => {
				const shouldArrange = updateArrangementTarget(clientX, clientY);

				if (!shouldArrange && position) {
					const snapshot = graphState.getState();

					graphState.setState({
						camera: snapshot.camera,
						nodePositions: {
							...snapshot.nodePositions,
							[file.id]: position,
						},
					});
					interactions.onNodeArrangementChange?.({
						nodeId: file.id,
						arranged: false,
					});
				}
			},
			onDragComplete,
			onDragCancel: () => {
				interactions.onSourceDragCancel?.();
				clearArrangementDrag();
			},
			consumeClick: false,
		}, rootId);
	};
	/** 초기 렌더링과 Reflow 추가 경로에서 공통으로 Node와 interaction을 생성한다. */
	const addNode = (layoutNode: GraphLayoutNode): void => {
		const element = createNodeElement(
			layoutNode,
			ownerDocument,
		);
		const bindingSourceId = getGraphBindingSourceId(layoutNode);
		const presentationTarget = getLayoutNodePresentationTarget(layoutNode);
		const subtreePresentationOptions = layoutNode.kind === 'project'
			|| layoutNode.kind === 'folder'
			? { layoutNodeId: layoutNode.id }
			: undefined;

		syncAgentActivityBindingLayout(element, layoutNode);

		if (presentationTarget && options.nodeEffects) {
			nodeEffectCleanups.set(
				layoutNode.id,
				options.nodeEffects.registerNode(
					presentationTarget,
					element,
					subtreePresentationOptions,
				),
			);
		}
		if (presentationTarget && options.agentActivityBindings) {
			nodeActivityBindingCleanups.set(
				layoutNode.id,
				options.agentActivityBindings.registerTarget(
					presentationTarget,
					element,
					subtreePresentationOptions,
				),
			);
		}
		if (presentationTarget && options.gitDecorations) {
			nodeGitDecorationCleanups.set(
				layoutNode.id,
				layoutNode.kind === 'project' || layoutNode.kind === 'folder'
					? options.gitDecorations.registerContainer(
						presentationTarget.nodeId,
						element,
					)
					: options.gitDecorations.registerFile(
						presentationTarget.nodeId,
						element,
					),
			);
		}
		element.hidden = layoutNode.hidden === true;
		syncDetachDrag(layoutNode, element);
		if (
			layoutNode.kind === 'file-group'
			&& layoutNode.presentation === 'standalone'
			&& layoutNode.children[0]
		) {
			nodeFileOpenRequestCleanups.set(
				layoutNode.id,
				initializeFileOpenRequest(
					element,
					layoutNode.children[0],
					interactions,
				),
			);
		}
		const backlinkTargetRootIds = getNodeBacklinkTargetRootIds(layoutNode);

		if (backlinkTargetRootIds.length > 0) {
			backlinkClickCleanups.set(
				layoutNode.id,
				initializeBacklink(
					element,
					backlinkTargetRootIds,
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
				initializeFileArrangementDrag,
				options.nodeEffects,
				options.agentActivityBindings,
				options.gitDecorations,
			);

			content.render(graphState.getFileGroupPage(
				layoutNode.id,
			));
			fileGroupContents.set(layoutNode.id, content);
		}

		nodeLayer.append(element);
		nodeElements.set(layoutNode.id, element);
		syncDetachedRootActions(layoutNode, element);
		syncRootContextLabel(
			layoutNode,
			element,
			renderedLayout.rootContexts[layoutNode.id],
		);
		syncDetachedRootBadge(layoutNode, element, renderedLayout);
		const position = resolveGraphLayoutNodePosition(
			layoutNode,
			graphState.getState().nodePositions,
		);

		renderedPositions.set(layoutNode.id, position);
		element.style.transform = `translate(${position.x}px, ${position.y}px)`;

		if (isMovableLayoutNode(layoutNode)) {
			let subtreeDragStartPositions:
				| ReadonlyMap<string, GraphLayoutPosition>
				| undefined;
			const captureSubtreeDragStartPositions = (): ReadonlyMap<
				string,
				GraphLayoutPosition
			> => {
				const positions = new Map<string, GraphLayoutPosition>();
				const visibleSubtreeNodeIds = collectGraphLayoutSubtreeNodeIds(
					renderedLayout,
					layoutNode.id,
				);
				const subtreeNodeIds = new Set(
					interactions.resolveNodeSubtreeIds?.(
						layoutNode.id,
						visibleSubtreeNodeIds,
					) ?? visibleSubtreeNodeIds,
				);

				// Resolver가 잘못된 경계를 반환해도 직접 잡은 Node의 이동은 보장한다.
				subtreeNodeIds.add(layoutNode.id);
				const storedPositions = graphState.getState().nodePositions;

				for (const nodeId of subtreeNodeIds) {
					const position = renderedPositions.get(nodeId)
						?? storedPositions[nodeId];

					if (position) {
						positions.set(nodeId, { ...position });
					}
				}

				subtreeDragStartPositions = positions;
				return positions;
			};
			const updateSubtreeDragPosition = (
				position: GraphLayoutPosition,
			): void => {
				const startPositions = subtreeDragStartPositions
					?? captureSubtreeDragStartPositions();
				const rootStartPosition = startPositions.get(layoutNode.id);

				if (!rootStartPosition) {
					updateNodePosition(layoutNode.id, position);
					return;
				}

				const delta = {
					x: position.x - rootStartPosition.x,
					y: position.y - rootStartPosition.y,
				};
				const pendingEdges = new Map<string, GraphLayoutEdge>();

				for (const [nodeId, startPosition] of startPositions) {
					updateNodePosition(nodeId, {
						x: startPosition.x + delta.x,
						y: startPosition.y + delta.y,
					}, pendingEdges);
				}

				for (const edge of pendingEdges.values()) {
					renderEdge(edge);
				}
				syncPresentationLayout(renderedLayout, renderedPositions);
			};
			const commitSubtreeDragPositions = (): boolean => {
				const startPositions = subtreeDragStartPositions;

				subtreeDragStartPositions = undefined;

				if (!startPositions || startPositions.size === 0) {
					return false;
				}

				const state = graphState.getState();
				const nodePositions = { ...state.nodePositions };

				for (const nodeId of startPositions.keys()) {
					const position = renderedPositions.get(nodeId);

					if (position) {
						nodePositions[nodeId] = { ...position };
					}
				}

				graphState.setState({
					camera: { ...state.camera },
					nodePositions,
				});
				return true;
			};
			const syncSubtreeDragToStoredPositions = (): boolean => {
				const startPositions = subtreeDragStartPositions;

				subtreeDragStartPositions = undefined;
				if (!startPositions || startPositions.size === 0) {
					return false;
				}
				const storedPositions = graphState.getState().nodePositions;
				const pendingEdges = new Map<string, GraphLayoutEdge>();

				for (const nodeId of startPositions.keys()) {
					const node = nodesById.get(nodeId);

					if (!node) {
						continue;
					}
					updateNodePosition(
						nodeId,
						resolveGraphLayoutNodePosition(node, storedPositions),
						pendingEdges,
					);
				}
				for (const edge of pendingEdges.values()) {
					renderEdge(edge);
				}
				syncPresentationLayout(renderedLayout, renderedPositions);
				return true;
			};
			const nodeClickHandler = createNodeClickHandler(
				layoutNode,
				interactions,
			);

			nodeDrags.set(layoutNode.id, initializeGraphNodeDrag(
				element,
				layoutNode.id,
				layoutNode.position,
				graphState,
				{
					canStart: () => interactions.canStartNodeBodyDrag?.(
						layoutNode.id,
					) !== false,
					onDragStart: () => {
						finishLayoutAnimation();
						subtreeDragStartPositions = undefined;
						if (bindingSourceId) {
							interactions.onSourceDragCancel?.();
						}
					},
					onDragActivate: () => {
						const startPositions = captureSubtreeDragStartPositions();
						const sourcePosition = startPositions.get(layoutNode.id);

						if (sourcePosition) {
							beginArrangementDrag(
								layoutNode.id,
								sourcePosition,
							);
						}
					},
					getCurrentPosition: () => renderedPositions.get(layoutNode.id),
					onClick: nodeClickHandler,
					onPositionChange: updateSubtreeDragPosition,
					onDragMove: ({ clientX, clientY }) => {
						if (bindingSourceId) {
							const startPosition = subtreeDragStartPositions?.get(
								layoutNode.id,
							);
							interactions.onSourceDragMove?.({
								sourceNodeId: bindingSourceId,
								occurrenceNodeId: layoutNode.id,
								...(getGraphLayoutRootId(layoutNode.id)
									? { occurrenceRootId: getGraphLayoutRootId(layoutNode.id) }
									: {}),
								isIndependentOccurrence: rootNodeIds.has(layoutNode.id),
								...(startPosition ? { startPosition } : {}),
								clientX,
								clientY,
							});
						}
						updateReattachTarget(layoutNode.id, clientX, clientY);
						updateArrangementTarget(clientX, clientY);
					},
					onDragEnd: ({ clientX, clientY }) => {
						const startPosition = subtreeDragStartPositions?.get(
							layoutNode.id,
						);
						const currentPosition = renderedPositions.get(layoutNode.id);
						const reattachTargetRootId = updateReattachTarget(
							layoutNode.id,
							clientX,
							clientY,
						);
						const isArrangementTarget = updateArrangementTarget(
							clientX,
							clientY,
						);
						const bindingDropResult = bindingSourceId
							? interactions.onSourceDrop?.({
								sourceNodeId: bindingSourceId,
								occurrenceNodeId: layoutNode.id,
								...(getGraphLayoutRootId(layoutNode.id)
									? { occurrenceRootId: getGraphLayoutRootId(layoutNode.id) }
									: {}),
								isIndependentOccurrence: rootNodeIds.has(layoutNode.id),
								...(isArrangementTarget
									? { isArrangementTarget: true }
									: {}),
								...(reattachTargetRootId
									? { reattachTargetRootId }
									: {}),
								...(startPosition ? { startPosition } : {}),
								...(currentPosition ? { currentPosition } : {}),
								clientX,
								clientY,
							})
							: undefined;
						const bindingConsumed = bindingDropResult === true
							|| (
								typeof bindingDropResult === 'object'
								&& bindingDropResult !== null
							);

						if (bindingConsumed) {
							const targetPosition = typeof bindingDropResult === 'object'
								? bindingDropResult.targetPosition
								: undefined;
						const restoreStartPosition = typeof bindingDropResult === 'object'
							&& bindingDropResult.restoreStartPosition === true;
						const syncStoredPositions = typeof bindingDropResult === 'object'
							&& bindingDropResult.syncStoredPositions === true;

						if (syncStoredPositions) {
							syncSubtreeDragToStoredPositions();
						} else if (targetPosition) {
								updateSubtreeDragPosition(targetPosition);
								commitSubtreeDragPositions();
							} else if (restoreStartPosition) {
								const rootStartPosition = subtreeDragStartPositions?.get(
									layoutNode.id,
								);

								if (rootStartPosition) {
									updateSubtreeDragPosition(rootStartPosition);
								}
								subtreeDragStartPositions = undefined;
							} else {
								subtreeDragStartPositions = undefined;
							}
							clearReattachTarget();
							clearArrangementDrag();
							return true;
						}

						const rootId = reattachTargetRootId;

						clearReattachTarget();
						const reattachResult = rootId === undefined
							? false
							: interactions.onRootReattach?.({
								rootId,
								nodeId: getGraphLayoutSourceId(layoutNode.id),
							}) ?? false;

						if (reattachResult === 'deferred') {
							const rootStartPosition = subtreeDragStartPositions?.get(
								layoutNode.id,
							);

							if (rootStartPosition) {
								updateSubtreeDragPosition(rootStartPosition);
							}
							clearArrangementDrag();
							subtreeDragStartPositions = undefined;
							return true;
						}

						if (reattachResult === true) {
							clearArrangementDrag();
							subtreeDragStartPositions = undefined;
							return true;
						}

						const arrangement = activeArrangementDrag;
						const shouldArrange = isArrangementTarget;
						const wasUnarranged = arrangement?.wasUnarranged ?? false;

						clearArrangementDrag();
						const committed = commitSubtreeDragPositions();
						const arrangementChanged = shouldArrange || !wasUnarranged
							? interactions.onNodeArrangementChange?.({
								nodeId: layoutNode.id,
								arranged: shouldArrange,
							}) === true
							: false;

						return committed || arrangementChanged;
					},
					onDragCancel: () => {
						if (bindingSourceId) {
							interactions.onSourceDragCancel?.();
						}
						clearReattachTarget();
						clearArrangementDrag();
						subtreeDragStartPositions = undefined;
					},
				},
			));
		}
	};

	/** 제거할 Node의 interaction과 content를 정리한 뒤 DOM과 Map에서 제외한다. */
	const removeNode = (
		nodeId: string,
		preserveElement = false,
	): HTMLElement | undefined => {
		const element = nodeElements.get(nodeId);

		nodeDrags.get(nodeId)?.dispose();
		nodeDrags.delete(nodeId);
		nodeDetachDrags.get(nodeId)?.dispose();
		nodeDetachDrags.delete(nodeId);
		nodeFileOpenRequestCleanups.get(nodeId)?.();
		nodeFileOpenRequestCleanups.delete(nodeId);
		nodeEffectCleanups.get(nodeId)?.();
		nodeEffectCleanups.delete(nodeId);
		nodeActivityBindingCleanups.get(nodeId)?.();
		nodeActivityBindingCleanups.delete(nodeId);
		nodeGitDecorationCleanups.get(nodeId)?.();
		nodeGitDecorationCleanups.delete(nodeId);
		backlinkClickCleanups.get(nodeId)?.();
		backlinkClickCleanups.delete(nodeId);
		fileGroupContents.get(nodeId)?.dispose();
		fileGroupContents.delete(nodeId);
		rootContextLabels.get(nodeId)?.dispose();
		rootContextLabels.delete(nodeId);
		detachedRootBadges.delete(nodeId);
		detachedRootActions.get(nodeId)?.dispose();
		detachedRootActions.delete(nodeId);
		if (!preserveElement) {
			element?.remove();
		}
		nodeElements.delete(nodeId);
		renderedPositions.delete(nodeId);
		return element;
	};

	/** 제거할 Edge path를 DOM과 ID Map에서 제외한다. */
	const removeEdge = (
		edgeId: string,
		preserveElement = false,
	): SVGPathElement | undefined => {
		const element = edgeElements.get(edgeId);

		if (!preserveElement) {
			element?.remove();
		}
		edgeElements.delete(edgeId);
		return element;
	};

	for (const layoutNode of layout.nodes) {
		addNode(layoutNode);
	}
	syncPresentationLayout(layout, renderedPositions);

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
		const changedPositions: Array<readonly [string, GraphLayoutPosition]> = [];

		for (const layoutNode of renderedLayout.nodes) {
			const previous = resolveGraphLayoutNodePosition(
				layoutNode,
				previousPositions,
			);
			const next = resolveGraphLayoutNodePosition(
				layoutNode,
				state.nodePositions,
			);

			if (previous.x === next.x && previous.y === next.y) {
				continue;
			}

			changedPositions.push([layoutNode.id, next]);
		}

		if (changedPositions.length === 0) {
			return;
		}

		finishLayoutAnimation();

		for (const [nodeId, position] of changedPositions) {
			updateNodePosition(nodeId, position);
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
		applyLayout(
			nextLayout,
			nodePositions = graphState.getState().nodePositions,
			applyOptions = {},
		): void {
			if (disposed) {
				return;
			}
			cancelLayoutAnimation();
			clearReattachTarget();
			clearArrangementDrag();

			const previousLayout = renderedLayout;
			const previousNodesById = nodesById;
			const previousRenderedPositions = new Map(renderedPositions);
			const previousEdgesById = new Map(
				renderedLayout.edges.map((edge) => [edge.id, edge]),
			);
			const nextNodesById = new Map(
				nextLayout.nodes.map((node) => [node.id, node]),
			);
			const nextEdgesById = new Map(
				nextLayout.edges.map((edge) => [edge.id, edge]),
			);
			const previousParentByChild = new Map(
				renderedLayout.edges.map((edge) => [edge.targetId, edge.sourceId]),
			);
			const nextParentByChild = new Map(
				nextLayout.edges.map((edge) => [edge.targetId, edge.sourceId]),
			);
			const pendingEdges = new Map<string, GraphLayoutEdge>();
			const positionTransitions = new Map<
				string,
				GraphNodePositionTransition
			>();
			const enteringNodes: HTMLElement[] = [];
			const exitingNodes: GraphExitingNodeTransition[] = [];
			const enteringEdges: SVGPathElement[] = [];
			const exitingEdges: SVGPathElement[] = [];
			const enteringNodeIds = new Set<string>();
			const storedPositions = nodePositions;
			const targetRegionPositions = new Map(
				nextLayout.nodes.map((node) => [
					node.id,
					resolveGraphLayoutNodePosition(node, storedPositions),
				]),
			);

			rootNodeIds = nextLayout.rootNodeIds;

			for (const nodeId of previousNodesById.keys()) {
				if (!nextNodesById.has(nodeId)) {
					const from = previousRenderedPositions.get(nodeId);
					const detachedBacklinkPosition = findDetachedBacklinkPosition(
						nodeId,
						previousLayout,
						previousParentByChild,
						nextLayout,
						storedPositions,
					);
					const retainedAncestorId = findNearestAncestorInMap(
						nodeId,
						previousParentByChild,
						nextNodesById,
					);
					const retainedAncestor = retainedAncestorId
						? nextNodesById.get(retainedAncestorId)
						: undefined;
					const element = removeNode(nodeId, true);

					const exitTarget = detachedBacklinkPosition
						?? (retainedAncestor
							? resolveGraphLayoutNodePosition(
								retainedAncestor,
								storedPositions,
							)
							: undefined);

					if (element && from && exitTarget && !element.hidden) {
						exitingNodes.push({
							element,
							from,
							to: exitTarget,
						});
					} else {
						element?.remove();
					}
				}
			}

			for (const edgeId of previousEdgesById.keys()) {
				if (!nextEdgesById.has(edgeId)) {
					const element = removeEdge(edgeId, true);

					if (element) {
						exitingEdges.push(element);
					}
				}
			}

			renderedLayout = nextLayout;
			nodesById = nextNodesById;

			for (const nextNode of nextLayout.nodes) {
				const previousNode = previousNodesById.get(nextNode.id);

				if (!previousNode) {
					addNode(nextNode);
					const element = nodeElements.get(nextNode.id);

					if (element && !element.hidden) {
						enteringNodes.push(element);
						enteringNodeIds.add(nextNode.id);
					}
				} else if (!hasSameNodePresentation(previousNode, nextNode)) {
					removeNode(nextNode.id);
					addNode(nextNode);
				}
			}

			for (const nextEdge of nextLayout.edges) {
				if (!previousEdgesById.has(nextEdge.id)) {
					addEdge(nextEdge);
					const element = edgeElements.get(nextEdge.id);

					if (element) {
						enteringEdges.push(element);
					}
				} else {
					const edgeElement = edgeElements.get(nextEdge.id);

					if (edgeElement) {
						syncEdgeVisibility(edgeElement, nextEdge);
					}
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

			renderedNodePositions = storedPositions;

			for (const nextNode of nextLayout.nodes) {
				const previousNode = previousNodesById.get(nextNode.id);
				const element = nodeElements.get(nextNode.id);
				const nodeDrag = nodeDrags.get(nextNode.id);

				nodeDrag?.updateDefaultPosition(nextNode.position);

				if (element) {
					element.hidden = nextNode.hidden === true;
					syncDetachDrag(nextNode, element);
					updateContainerStatusState(element, nextNode);
				}

				if (
					nextNode.kind === 'file-group'
					&& nextNode.presentation === 'grouped'
				) {
					fileGroupContents.get(nextNode.id)?.applyLayout(
						nextNode,
						rootNodeIds,
					);
				}

				if (
					element
					&& (!previousNode || previousNode.width !== nextNode.width)
				) {
					element.style.width = `${nextNode.width}px`;
				}

				if (
					element
					&& (
						!previousNode
						|| getRenderedNodeHeight(previousNode)
							!== getRenderedNodeHeight(nextNode)
					)
				) {
					element.style.height = `${getRenderedNodeHeight(nextNode)}px`;
				}

				if (element) {
					syncAgentActivityBindingLayout(element, nextNode);
					syncDetachedRootActions(nextNode, element);
					syncRootContextLabel(
						nextNode,
						element,
						nextLayout.rootContexts[nextNode.id],
					);
					syncDetachedRootBadge(nextNode, element, nextLayout);
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

				const targetPosition = resolveGraphLayoutNodePosition(
					nextNode,
					storedPositions,
				);
				const enteringAncestorId = !previousNode
					? findNearestAncestorInMap(
						nextNode.id,
						nextParentByChild,
						previousNodesById,
					)
					: undefined;
				const enteringAncestorPosition = enteringAncestorId
					? previousRenderedPositions.get(enteringAncestorId)
					: undefined;
				const detachedBacklinkPosition = !previousNode
					? findDetachedBacklinkPosition(
						nextNode.id,
						nextLayout,
						nextParentByChild,
						previousLayout,
						Object.fromEntries(previousRenderedPositions),
					)
					: undefined;
				const enteringSourcePosition = !previousNode
					&& applyOptions.enteringSourceRootId
					? previousRenderedPositions.get(createGraphLayoutNodeId(
						applyOptions.enteringSourceRootId,
						getGraphLayoutSourceId(nextNode.id),
					))
					: undefined;
				const currentPosition = previousNode
					? previousRenderedPositions.get(nextNode.id)
					: enteringSourcePosition
						?? detachedBacklinkPosition
						?? enteringAncestorPosition
						?? renderedPositions.get(nextNode.id);
				const reconciledPosition = renderedPositions.get(nextNode.id);

				if (
					currentPosition
					&& (
						!reconciledPosition
						|| reconciledPosition.x !== currentPosition.x
						|| reconciledPosition.y !== currentPosition.y
					)
				) {
					updateNodePosition(nextNode.id, currentPosition, pendingEdges);
				}

				if (
					!currentPosition
					|| currentPosition.x !== targetPosition.x
					|| currentPosition.y !== targetPosition.y
				) {
					if (
						currentPosition
						&& (previousNode || enteringNodeIds.has(nextNode.id))
					) {
						positionTransitions.set(nextNode.id, {
							from: { ...currentPosition },
							to: { ...targetPosition },
						});

						for (const edge of edgesByNodeId.get(nextNode.id) ?? []) {
							pendingEdges.set(edge.id, edge);
						}
					} else {
						updateNodePosition(nextNode.id, targetPosition, pendingEdges);
					}
				}
			}

			for (const edge of pendingEdges.values()) {
				renderEdge(edge);
			}

			startLayoutAnimation(positionTransitions, {
				enteringNodes,
				exitingNodes,
				enteringEdges,
				exitingEdges,
			}, targetRegionPositions, applyOptions.animate !== false);
		},
		getBacklinkClientRect(targetRootId) {
			if (disposed) {
				return undefined;
			}

			const element = getVisibleBacklinkElement(targetRootId);

			return element?.getBoundingClientRect();
		},
		getBacklinkClientCenter(targetRootId) {
			const bounds = disposed ? undefined : getVisibleBacklinkElement(
				targetRootId,
			)?.getBoundingClientRect();

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
			cancelLayoutAnimation();
			clearReattachTarget();
			clearArrangementDrag();
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

/** 실제 Webview Window의 RAF API만 Renderer Scheduler로 감싼다. */
function resolveRendererAnimationFrameScheduler(
	ownerDocument: Document,
): GraphAnimationFrameScheduler | undefined {
	const ownerWindow = ownerDocument.defaultView;

	if (
		!ownerWindow
		|| typeof ownerWindow.requestAnimationFrame !== 'function'
		|| typeof ownerWindow.cancelAnimationFrame !== 'function'
	) {
		return undefined;
	}

	return {
		request: (callback) => ownerWindow.requestAnimationFrame(callback),
		cancel: (requestId) => ownerWindow.cancelAnimationFrame(requestId),
	};
}

function easeOutCubic(progress: number): number {
	return 1 - (1 - progress) ** 3;
}

function interpolate(start: number, end: number, progress: number): number {
	return start + (end - start) * progress;
}

/** Parent chain에서 지정 Map에 남아 있는 가장 가까운 Ancestor를 찾는다. */
function findNearestAncestorInMap<T>(
	nodeId: string,
	parentByChild: ReadonlyMap<string, string>,
	targets: ReadonlyMap<string, T>,
): string | undefined {
	let parentId = parentByChild.get(nodeId);

	while (parentId) {
		if (targets.has(parentId)) {
			return parentId;
		}

		parentId = parentByChild.get(parentId);
	}

	return undefined;
}

/** Detached subtree가 출발하거나 복귀할 같은 Source의 Tree/Backlink 위치를 찾는다. */
function findDetachedBacklinkPosition(
	nodeId: string,
	sourceLayout: GraphLayout,
	parentByChild: ReadonlyMap<string, string>,
	targetLayout: GraphLayout,
	targetPositions: Readonly<Record<string, GraphLayoutPosition>>,
): GraphLayoutPosition | undefined {
	const detachedRootNodeId = findNearestAncestorInSet(
		nodeId,
		parentByChild,
		sourceLayout.rootNodeIds,
	);
	const detachedRootId = detachedRootNodeId
		? getGraphLayoutRootId(detachedRootNodeId)
		: undefined;

	if (!detachedRootNodeId || !detachedRootId) {
		return undefined;
	}

	const sourceNodeId = getGraphLayoutSourceId(detachedRootNodeId);
	const originRootId = getDetachedRootOriginId(detachedRootId);
	const anchor = findSourceAnchorNode(targetLayout, sourceNodeId, originRootId)
		?? findSourceAnchorNode(sourceLayout, sourceNodeId, originRootId);

	return anchor
		? resolveGraphLayoutNodePosition(anchor, targetPositions)
		: undefined;
}

/** 자신을 포함한 Parent chain에서 지정 Set에 속하는 가장 가까운 Node를 찾는다. */
function findNearestAncestorInSet(
	nodeId: string,
	parentByChild: ReadonlyMap<string, string>,
	targets: ReadonlySet<string>,
): string | undefined {
	let candidateId: string | undefined = nodeId;

	while (candidateId) {
		if (targets.has(candidateId)) {
			return candidateId;
		}

		candidateId = parentByChild.get(candidateId);
	}

	return undefined;
}

/** 같은 Source를 나타내는 Backlink Card를 우선하고 원래 Tree Card/Group을 대체로 쓴다. */
function findSourceAnchorNode(
	layout: GraphLayout,
	sourceNodeId: string,
	originRootId: string | undefined,
): GraphLayoutNode | undefined {
	const belongsToOrigin = (node: GraphLayoutNode): boolean => (
		getGraphLayoutRootId(node.id) === originRootId
	);

	return layout.nodes.find((node) => (
		belongsToOrigin(node)
		&& getBacklinkSourceNodeId(node) === sourceNodeId
	))
		?? layout.nodes.find((node) => (
			belongsToOrigin(node)
			&& !layout.rootNodeIds.has(node.id)
			&& (
				getGraphLayoutSourceId(node.id) === sourceNodeId
				|| (
					node.kind === 'file-group'
					&& node.children.some(
						(file) => getGraphLayoutSourceId(file.id) === sourceNodeId,
					)
				)
			)
		));
}

/** Backlink Layout presentation이 가리키는 Source Node ID를 반환한다. */
function getBacklinkSourceNodeId(node: GraphLayoutNode): string | undefined {
	if (node.kind === 'folder-backlink') {
		return node.targetNodeId;
	}

	if (node.kind !== 'file-group') {
		return undefined;
	}

	const backlinkFile = node.children.find(
		(file) => file.presentation === 'backlink',
	);

	return backlinkFile
		? getGraphLayoutSourceId(backlinkFile.id)
		: undefined;
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

/** 개별 Card 사이의 빈 공간은 제외한 채 정렬 목록 drop zone 진입을 판별한다. */
function isArrangementDropZoneHit(
	dropZone: GraphArrangementDropZone,
	clientX: number,
	clientY: number,
	margin: number,
	draggedBounds?: DOMRect,
): boolean {
	return dropZone.hitBounds.some((bounds) => (
		isPointInsideExpandedRect(
			clientX,
			clientY,
			bounds,
			margin,
		)
		|| (
			draggedBounds !== undefined
			&& getRectIntersectionArea(draggedBounds, bounds) > 0
		)
	));
}

/** 두 client rect가 실제로 겹친 면적을 반환한다. */
function getRectIntersectionArea(left: DOMRect, right: DOMRect): number {
	const width = Math.max(
		0,
		Math.min(left.right, right.right) - Math.max(left.left, right.left),
	);
	const height = Math.max(
		0,
		Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top),
	);

	return width * height;
}

function createClientRect(
	left: number,
	top: number,
	width: number,
	height: number,
): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		right: left + width,
		bottom: top + height,
		width,
		height,
		toJSON: () => ({}),
	};
}

/** Detached Root와 함께 hover되는 absolute Action 영역을 붙이고 그래프 입력을 차단한다. */
function initializeDetachedRootActions(
	rootNode: HTMLElement,
	rootId: string,
	ownerDocument: Document,
	interactions: GraphRendererInteractions,
): DetachedRootActionRenderer {
	const actions = ownerDocument.createElement('div');
	const duplicate = createDetachedRootActionButton(
		ownerDocument,
		'복사',
		DUPLICATE_ICON_ASSET,
		'duplicate',
	);
	const remove = createDetachedRootActionButton(
		ownerDocument,
		'삭제',
		DELETE_ICON_ASSET,
		'delete',
	);
	const handlePointerDown = (event: Event): void => {
		event.preventDefault();
		event.stopPropagation();
	};
	const handleActionsClick = (event: Event): void => {
		event.stopPropagation();
	};
	const handleDuplicateClick = (event: Event): void => {
		event.preventDefault();
		event.stopPropagation();
		interactions.onDetachedRootDuplicate?.(rootId);
	};
	const handleDeleteClick = (event: Event): void => {
		event.preventDefault();
		event.stopPropagation();
		interactions.onDetachedRootDelete?.(rootId);
	};

	actions.className = 'graph-detached-root-actions';
	actions.setAttribute('data-detached-root-actions', rootId);
	actions.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	actions.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	actions.addEventListener('pointerdown', handlePointerDown);
	actions.addEventListener('click', handleActionsClick);
	duplicate.addEventListener('click', handleDuplicateClick);
	remove.addEventListener('click', handleDeleteClick);
	actions.append(duplicate, remove);
	rootNode.append(actions);

	return {
		rootId,
		dispose(): void {
			actions.removeEventListener('pointerdown', handlePointerDown);
			actions.removeEventListener('click', handleActionsClick);
			duplicate.removeEventListener('click', handleDuplicateClick);
			remove.removeEventListener('click', handleDeleteClick);
			actions.remove();
		},
	};
}

/** 기존 SVG asset을 CSS mask로 표시하는 Detached Root Action Button을 만든다. */
function createDetachedRootActionButton(
	ownerDocument: Document,
	label: string,
	iconAsset: string,
	action: 'duplicate' | 'delete',
): HTMLButtonElement {
	const button = ownerDocument.createElement('button');
	const icon = ownerDocument.createElement('span');

	button.className = 'graph-detached-root-action';
	button.type = 'button';
	button.title = label;
	button.setAttribute('aria-label', label);
	button.setAttribute('data-detached-root-action', action);
	button.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	button.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	icon.className = 'graph-detached-root-action-icon';
	icon.setAttribute('data-ui-icon', iconAsset);
	icon.setAttribute('aria-hidden', 'true');
	button.append(icon);

	return button;
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
				rootNodeWidth * GRAPH_ROOT_CONTEXT_MAX_WIDTH_MULTIPLIER,
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
	element.style.height = `${getRenderedNodeHeight(node)}px`;

	if (node.kind === 'file-group') {
		element.setAttribute('data-file-group-presentation', node.presentation);

		if (node.presentation === 'standalone') {
			const file = node.children[0];

			if (file) {
				element.setAttribute(
					'data-file-id',
					getGraphLayoutSourceId(file.id),
				);
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
			element.setAttribute(
				'data-target-root-ids',
				node.targetRootIds.join(','),
			);
			element.setAttribute('data-target-node-id', node.targetNodeId);
			element.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
		}
	}

	return element;
}

/** Edge/Direct Effect용 visual height와 별개인 실제 Renderer DOM 높이를 반환한다. */
function getRenderedNodeHeight(node: GraphLayoutNode): number {
	return node.renderedHeight ?? node.height;
}

/** Layout이 결정한 Target/subtree 아래 Binding Container 위치만 DOM에 전달한다. */
function syncAgentActivityBindingLayout(
	element: HTMLElement,
	node: GraphLayoutNode,
): void {
	if (node.agentActivityBindingTop === undefined) {
		element.style.removeProperty('--graph-agent-activity-binding-top');
		return;
	}

	element.style.setProperty(
		'--graph-agent-activity-binding-top',
		`${node.agentActivityBindingTop}px`,
	);
}

/** Backlink과 grouped File Group Card를 제외한 실제 Source 표현의 exact Target이다. */
function getLayoutNodePresentationTarget(
	node: GraphLayoutNode,
): { readonly nodeId: string; readonly rootId?: string } | undefined {
	if (node.kind === 'folder-backlink') {
		return undefined;
	}

	if (node.kind === 'file-group') {
		const file = node.presentation === 'standalone' ? node.children[0] : undefined;

		if (!file || file.presentation === 'backlink') {
			return undefined;
		}

		const rootId = getGraphLayoutRootId(file.id)
			?? getGraphLayoutRootId(node.id);

		return {
			nodeId: getGraphLayoutSourceId(file.id),
			...(rootId ? { rootId } : {}),
		};
	}

	const rootId = getGraphLayoutRootId(node.id);

	return {
		nodeId: getGraphLayoutSourceId(node.id),
		...(rootId ? { rootId } : {}),
	};
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
	element.setAttribute(
		'data-target-root-ids',
		(file.targetRootIds ?? [file.targetRootId]).join(','),
	);
	element.setAttribute('data-target-node-id', getGraphLayoutSourceId(file.id));
	element.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
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
	initializeFileArrangementDrag: FileArrangementDragInitializer,
	nodeEffects?: Pick<GraphNodeEffects, 'registerNode'>,
	agentActivityBindings?: Pick<AgentActivityBindings, 'registerTarget'>,
	gitDecorations?: GitDecorationBindings,
): FileGroupContentRenderer {
	let renderedNode = node;
	let renderedRootNodeIds = rootNodeIds;
	let content: FileGroupContentElements = { elements: [], cleanups: [] };
	let fileRows = new Map<string, HTMLLIElement>();
	let disposed = false;
	const clearContent = (): void => {
		for (const cleanup of content.cleanups) {
			cleanup();
		}

		for (const child of content.elements) {
			child.remove();
		}

		content = { elements: [], cleanups: [] };
		fileRows = new Map();
	};

	return {
		render(page): void {
			if (disposed) {
				return;
			}

			clearContent();
			const visibleCount = getVisibleFileCount(renderedNode.children.length, page);
			const remainingCount = getRemainingFileCount(renderedNode.children.length, page);
			const showCollapse = renderedNode.children.length > FILE_GROUP_PAGE_SIZE
				&& page > 1;
			const list = ownerDocument.createElement('ul');
			const elements: HTMLElement[] = [list];
			const cleanups: Array<() => void> = [];

			list.className = 'graph-file-list';

			for (const file of renderedNode.children.slice(0, visibleCount)) {
				const row = createFileRow(
					file,
					ownerDocument,
					interactions,
					renderedRootNodeIds,
					initializeBacklink,
					initializeFileArrangementDrag,
					renderedNode.id,
					nodeEffects,
					agentActivityBindings,
					gitDecorations,
					);

				list.append(row.element);
				fileRows.set(file.id, row.element);
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
						graphState.showMoreFiles(
							renderedNode.id,
						);
					};

					more.className = 'graph-file-control graph-file-more';
					more.type = 'button';
					more.textContent = `+ ${remainingCount}개 더보기`;
					more.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
					more.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
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
						graphState.collapseFileGroup(
							renderedNode.id,
						);
					};

					collapse.className = 'graph-file-control graph-file-collapse';
					collapse.type = 'button';
					collapse.setAttribute('aria-label', '파일 목록 접기');
					collapse.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
					collapse.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
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
		applyLayout(nextNode, nextRootNodeIds): void {
			if (disposed) {
				return;
			}

			const childrenChanged = renderedNode.children.length
				!== nextNode.children.length
				|| renderedNode.children.some((file, index) => {
					const nextFile = nextNode.children[index];

					return nextFile?.id !== file.id
						|| nextFile.name !== file.name
						|| nextFile.presentation !== file.presentation
						|| nextFile.agentActivityBindingCount
							!== file.agentActivityBindingCount
						|| nextFile.targetRootId !== file.targetRootId
						|| !hasSameStringList(
							nextFile.targetRootIds,
							file.targetRootIds,
						);
				});
			const rootMembershipChanged = nextNode.children.some((file) => (
				renderedRootNodeIds.has(file.id) !== nextRootNodeIds.has(file.id)
			));
			renderedNode = nextNode;
			renderedRootNodeIds = nextRootNodeIds;

			if (childrenChanged || rootMembershipChanged) {
				this.render(graphState.getFileGroupPage(nextNode.id));
				return;
			}

			const filesById = new Map(
				nextNode.children.map((file) => [file.id, file]),
			);

			for (const [fileId, row] of fileRows) {
				row.hidden = filesById.get(fileId)?.hidden === true;
			}
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

/** File Row DOM과 Click/Open feedback listener lifecycle을 만든다. */
function createFileRow(
	file: GraphFileNode,
	ownerDocument: Document,
	interactions: GraphRendererInteractions,
	rootNodeIds: ReadonlySet<string>,
	initializeBacklink: BacklinkInitializer,
	initializeFileArrangementDrag: FileArrangementDragInitializer,
	fileGroupId: string,
	nodeEffects?: Pick<GraphNodeEffects, 'registerNode'>,
	agentActivityBindings?: Pick<AgentActivityBindings, 'registerTarget'>,
	gitDecorations?: GitDecorationBindings,
): FileRowRenderer {
	const item = ownerDocument.createElement('li');

	item.className = 'graph-file-item';
	const bindingBlockHeight = getAgentActivityBindingBlockHeight(
		file.agentActivityBindingCount ?? 0,
	);

	if (bindingBlockHeight > 0) {
		item.style.marginBottom = `${bindingBlockHeight}px`;
		item.style.setProperty(
			'--graph-agent-activity-binding-top',
			`${GRAPH_FILE_GROUP_ROW_HEIGHT + AGENT_ACTIVITY_BINDING_TOP_GAP}px`,
		);
	}
	item.hidden = file.hidden === true;
	item.setAttribute('data-file-id', getGraphLayoutSourceId(file.id));
	item.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	applyFileBacklinkAttributes(item, file);
	appendFileContent(item, file, ownerDocument);
	const sourceNodeId = getGraphLayoutSourceId(file.id);
	const rootId = getGraphLayoutRootId(file.id);
	const presentationTarget = file.presentation === 'normal'
		? {
			nodeId: sourceNodeId,
			...(rootId ? { rootId } : {}),
		}
		: undefined;
	const disposeNodeEffect = presentationTarget
		? nodeEffects?.registerNode(presentationTarget, item)
		: undefined;
	const disposeAgentActivityBinding = presentationTarget
		? agentActivityBindings?.registerTarget(presentationTarget, item)
		: undefined;
	const disposeGitDecoration = presentationTarget
		? gitDecorations?.registerFile(presentationTarget.nodeId, item)
		: undefined;
	const backlinkTargetRootIds = file.targetRootIds
		?? (file.targetRootId ? [file.targetRootId] : []);
	const disposeBacklinkClick = file.presentation === 'backlink'
		&& backlinkTargetRootIds.length > 0
		? initializeBacklink(item, backlinkTargetRootIds)
		: undefined;
	const detachDrag = rootNodeIds.has(file.id)
		? undefined
		: appendDetachHandle(
			item,
			getGraphLayoutSourceId(file.id),
			file.id,
			getGraphLayoutRootId(file.id),
			ownerDocument,
			interactions,
			file.presentation === 'normal' ? sourceNodeId : undefined,
		);
	let suppressNextFileClick = false;
	const sourceRowDrag = file.presentation === 'normal'
		&& !rootNodeIds.has(file.id)
		&& Boolean(
			interactions.onNodeArrangementChange
			|| interactions.onSourceDragMove
			|| interactions.onSourceDrop
			|| interactions.onSourceDragCancel,
		)
		? initializeFileArrangementDrag(
			item,
			file,
			fileGroupId,
			() => {
				suppressNextFileClick = true;
			},
		)
		: undefined;
	/** File Group이 아닌 현재 Row에만 Click feedback을 다시 시작한다. */
	const animateFileClick = (): void => {
		item.classList.remove(FILE_CLICK_ANIMATION_CLASS);
		void item.offsetWidth;
		item.classList.add(FILE_CLICK_ANIMATION_CLASS);
	};
	const handleFileClick = (event: MouseEvent): void => {
		event.stopPropagation();
		if (suppressNextFileClick) {
			suppressNextFileClick = false;
			event.preventDefault();
			return;
		}

		if (file.presentation === 'backlink') {
			return;
		}

		animateFileClick();
		interactions.onFileClick?.(getGraphLayoutSourceId(file.id));
	};
	const disposeFileOpenRequest = initializeFileOpenRequest(
		item,
		file,
		interactions,
	);
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
			disposeNodeEffect?.();
			disposeAgentActivityBinding?.();
			disposeGitDecoration?.();
			disposeBacklinkClick?.();
			detachDrag?.dispose();
			sourceRowDrag?.dispose();
			disposeFileOpenRequest();
			item.removeEventListener('click', handleFileClick);
			item.removeEventListener('animationend', handleFileClickAnimationEnd);
			item.classList.remove(FILE_CLICK_ANIMATION_CLASS);
		},
	};
}

/** Standalone Card와 grouped Row가 공유하는 File Open 요청 listener를 등록한다. */
function initializeFileOpenRequest(
	element: HTMLElement,
	file: GraphFileNode,
	interactions: GraphRendererInteractions,
): () => void {
	const handleDoubleClick = (event: MouseEvent): void => {
		event.stopPropagation();
		event.preventDefault();

		if (file.presentation === 'backlink') {
			return;
		}

		interactions.onFileOpenRequest?.(getGraphLayoutSourceId(file.id));
	};

	element.addEventListener('dblclick', handleDoubleClick);

	return () => {
		element.removeEventListener('dblclick', handleDoubleClick);
	};
}

/** Layout Edge의 계산된 표시 여부를 기존 SVG path에 반영한다. */
function syncEdgeVisibility(
	element: SVGPathElement,
	edge: GraphLayoutEdge,
): void {
	if (edge.hidden === true) {
		element.setAttribute('visibility', 'hidden');
	} else {
		element.removeAttribute('visibility');
	}
}

/** Folder/standalone File Card에서 사용할 모든 Backlink 대상 Root ID를 찾는다. */
function getNodeBacklinkTargetRootIds(
	node: GraphLayoutNode,
): readonly string[] {
	if (node.kind === 'folder-backlink') {
		return node.targetRootIds;
	}

	if (node.kind !== 'file-group' || node.presentation !== 'standalone') {
		return [];
	}

	const file = node.children[0];

	return file?.presentation === 'backlink'
		? file.targetRootIds ?? (file.targetRootId ? [file.targetRootId] : [])
		: [];
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
		return rootNodeIds.has(node.id)
			? undefined
			: getGraphLayoutSourceId(node.id);
	}

	if (node.kind === 'folder-backlink') {
		return node.targetNodeId;
	}

	if (node.kind !== 'file-group' || node.presentation !== 'standalone') {
		return undefined;
	}

	const file = node.children[0];

	return file && !rootNodeIds.has(file.id)
		? getGraphLayoutSourceId(file.id)
		: undefined;
}

/** 실제 Folder 또는 normal standalone File visual만 Work Scope binding 대상으로 해석한다. */
function getGraphBindingSourceId(node: GraphLayoutNode): string | undefined {
	if (node.kind === 'folder') {
		return getGraphLayoutSourceId(node.id);
	}
	if (node.kind !== 'file-group' || node.presentation !== 'standalone') {
		return undefined;
	}

	const file = node.children[0];

	return file?.presentation === 'normal'
		? getGraphLayoutSourceId(file.id)
		: undefined;
}

/** 대상 끝에 고정 공간의 Handle을 추가하고 독립 Detach Drag를 초기화한다. */
function appendDetachHandle(
	target: HTMLElement,
	nodeId: string,
	occurrenceNodeId: string,
	instanceRootId: string | undefined,
	ownerDocument: Document,
	interactions: GraphRendererInteractions,
	bindingSourceId?: string,
): GraphDetachDrag {
	const handle = createDetachHandle(ownerDocument);

	target.append(handle);
	const detachDrag = initializeSourceDetachDrag(
		handle,
		nodeId,
		occurrenceNodeId,
		instanceRootId,
		interactions,
		bindingSourceId,
		{},
	);

	return {
		dispose(): void {
			detachDrag.dispose();
			handle.remove();
		},
	};
}

/** Handle과 grouped File Row가 같은 지연 Detach/Scope Drop lifecycle을 공유한다. */
function initializeSourceDetachDrag(
	target: HTMLElement,
	nodeId: string,
	occurrenceNodeId: string,
	instanceRootId: string | undefined,
	interactions: GraphRendererInteractions,
	bindingSourceId: string | undefined,
	options: {
		readonly canStart?: () => boolean;
		readonly consumeClick?: boolean;
		readonly detachOnUnhandledDrop?: boolean;
		readonly onDragComplete?: () => void;
	},
): GraphDetachDrag {
	return initializeGraphDetachDrag(target, nodeId, {
		canStart: options.canStart,
		onDetachDrop: options.detachOnUnhandledDrop === false
			? undefined
			: interactions.onDetachDrop,
		onDragMove: bindingSourceId
			? ({ clientX, clientY }) => interactions.onSourceDragMove?.({
				sourceNodeId: bindingSourceId,
				occurrenceNodeId,
				...(instanceRootId ? { occurrenceRootId: instanceRootId } : {}),
				isIndependentOccurrence: false,
				clientX,
				clientY,
			})
			: undefined,
		onDrop: bindingSourceId
			? ({ clientX, clientY }) => {
				const result = interactions.onSourceDrop?.({
					sourceNodeId: bindingSourceId,
					occurrenceNodeId,
					...(instanceRootId ? { occurrenceRootId: instanceRootId } : {}),
					isIndependentOccurrence: false,
					clientX,
					clientY,
				});

				return result === true || (
					typeof result === 'object' && result !== null
				);
			}
			: undefined,
		onDragCancel: bindingSourceId
			? interactions.onSourceDragCancel
			: undefined,
		onDragComplete: options.onDragComplete,
		consumeClick: options.consumeClick,
	}, instanceRootId);
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
	handle.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
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
				? () => interactions.onFileClick?.(
					getGraphLayoutSourceId(file.id),
				)
				: undefined;
		}

		const parentId = node.parentId;

		return parentId && interactions.onFileGroupClick
			? () => interactions.onFileGroupClick?.(
				getGraphLayoutSourceId(parentId),
			)
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
			&& hasSameStringList(previous.targetRootIds, next.targetRootIds)
			&& previous.targetNodeId === next.targetNodeId;
	}

	if (previous.kind !== 'file-group' || next.kind !== 'file-group') {
		return true;
	}

	if (
		previous.presentation !== next.presentation
		|| previous.parentId !== next.parentId
	) {
		return false;
	}

	if (previous.presentation === 'grouped') {
		return true;
	}

	return previous.children.length === next.children.length
		&& previous.children.every((file, index) => {
			const nextFile = next.children[index];

			return nextFile?.id === file.id
				&& nextFile.name === file.name
				&& nextFile.presentation === file.presentation
				&& nextFile.targetRootId === file.targetRootId
				&& hasSameStringList(
					nextFile.targetRootIds,
					file.targetRootIds,
				);
		});
}

/** 선택적 문자열 목록의 순서와 값을 비교한다. */
function hasSameStringList(
	left: readonly string[] | undefined,
	right: readonly string[] | undefined,
): boolean {
	const leftValues = left ?? [];
	const rightValues = right ?? [];

	return leftValues.length === rightValues.length
		&& leftValues.every((value, index) => rightValues[index] === value);
}

/** Derived Layout만으로 Badge 표시 여부와 보존된 ordinal을 계산한다. */
function getDetachedRootBadgeOrdinal(
	node: GraphLayoutNode,
	layout: GraphLayout,
): number | undefined {
	if (!layout.rootNodeIds.has(node.id)) {
		return undefined;
	}

	const rootId = getGraphLayoutRootId(node.id);
	const ordinal = rootId ? getDetachedRootOrdinal(rootId) : undefined;

	if (ordinal === undefined) {
		return undefined;
	}

	const sourceId = getGraphLayoutSourceId(node.id);
	let instanceCount = 0;

	for (const rootNodeId of layout.rootNodeIds) {
		const candidateRootId = getGraphLayoutRootId(rootNodeId);

		if (
			candidateRootId
			&& getDetachedRootOrdinal(candidateRootId) !== undefined
			&& getGraphLayoutSourceId(rootNodeId) === sourceId
		) {
			instanceCount += 1;
		}
	}

	return instanceCount >= 2 ? ordinal : undefined;
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
