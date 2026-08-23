import type {
	TaskGraphLayout,
	TaskLayoutEdge,
	TaskLayoutNode,
} from './taskLayout';
import type { TaskOrigin } from '../../task';
import { GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE } from '../graph/graphCamera';

/** T-03 interaction이 Task 소유권을 판별할 때 사용할 DOM attribute다. */
export const TASK_ID_ATTRIBUTE = 'data-task-id';
/** T-03 interaction이 안정적인 Task Node ID를 읽을 DOM attribute다. */
export const TASK_NODE_ID_ATTRIBUTE = 'data-task-node-id';
/** Task Node 역할을 DOM에서 판별하는 attribute다. */
export const TASK_NODE_KIND_ATTRIBUTE = 'data-task-node-kind';
/** Task Edge를 식별하는 DOM attribute다. */
export const TASK_EDGE_ID_ATTRIBUTE = 'data-task-edge-id';

/** Task Node/Edge DOM을 ID 기반으로 갱신하고 정리하는 lifecycle 경계다. */
export interface TaskRenderer {
	/** 기존 DOM을 재사용하며 최신 Task Layout을 적용한다. */
	applyLayout(layout: TaskGraphLayout): void;
	/** Task Renderer가 만든 Node와 Edge DOM을 모두 정리한다. */
	dispose(): void;
}

/** Task DOM interaction 결과를 GraphView의 기존 State와 Camera 경계로 전달한다. */
export interface TaskRendererInteractions {
	/** Pointer client 이동량을 World delta로 변환할 현재 Camera scale을 반환한다. */
	getCameraScale?: () => number;
	/** Start Drag으로 계산한 Task origin을 Domain State 갱신 경계에 전달한다. */
	onTaskOriginChange?: (taskId: string, origin: TaskOrigin) => void;
	/** Start/Work Double Click 대상을 Camera Focus 경계에 전달한다. */
	onNodeFocus?: (node: TaskLayoutNode) => void;
}

/** Start Node Pointer Capture 동안 고정하는 Task 이동 기준이다. */
interface TaskDragSession {
	readonly pointerId: number;
	readonly renderKey: string;
	readonly taskId: string;
	readonly startClientX: number;
	readonly startClientY: number;
	readonly startOrigin: TaskOrigin;
	readonly cameraScale: number;
	didDrag: boolean;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const TASK_DRAG_THRESHOLD = 4;

/**
 * 기존 Graph World의 Edge/Node Layer에 Task 전용 DOM을 렌더링한다.
 * Workspace GraphRenderer와 Map이나 모델을 공유하지 않고 DOM Layer만 공유한다.
 *
 * @param edgeLayer Workspace Edge와 함께 표시할 기존 SVG Layer
 * @param nodeLayer Workspace Node와 함께 표시할 기존 HTML Layer
 * @param initialLayout 최초 Task Layout
 * @returns Layout 갱신과 정리를 제공하는 Task Renderer
 */
export function initializeTaskRenderer(
	edgeLayer: SVGSVGElement,
	nodeLayer: HTMLElement,
	initialLayout: TaskGraphLayout,
	interactions: TaskRendererInteractions = {},
): TaskRenderer {
	const ownerDocument = nodeLayer.ownerDocument;
	const nodeElements = new Map<string, HTMLElement>();
	const edgeElements = new Map<string, SVGPathElement>();
	let nodesByRenderKey = new Map<string, TaskLayoutNode>();
	let selectedNodeKey: string | undefined;
	let dragSession: TaskDragSession | undefined;
	let suppressClickKey: string | undefined;
	let suppressDoubleClickKey: string | undefined;
	let disposed = false;

	/** Event target에서 Task dataset을 가진 실제 Node Card를 찾는다. */
	const resolveTaskNodeElement = (target: EventTarget | null): HTMLElement | undefined => {
		if (target === null || typeof (target as Element).closest !== 'function') {
			return undefined;
		}

		return (target as Element).closest<HTMLElement>(
			`[${TASK_NODE_ID_ATTRIBUTE}]`,
		) ?? undefined;
	};

	/** Task dataset을 Renderer 내부 복합 identity로 변환한다. */
	const getTaskNodeRenderKey = (element: HTMLElement): string | undefined => {
		const taskId = element.getAttribute(TASK_ID_ATTRIBUTE);
		const nodeId = element.getAttribute(TASK_NODE_ID_ATTRIBUTE);

		return taskId && nodeId
			? createTaskNodeRenderKey(taskId, nodeId)
			: undefined;
	};

	/** 선택된 Node 하나만 시각 상태를 유지한다. */
	const selectTaskNode = (renderKey: string): void => {
		if (selectedNodeKey === renderKey) {
			return;
		}

		if (selectedNodeKey) {
			nodeElements.get(selectedNodeKey)?.classList.remove('is-selected');
		}
		selectedNodeKey = renderKey;
		nodeElements.get(renderKey)?.classList.add('is-selected');
	};

	/** 활성 Start Drag과 Pointer Capture 및 시각 상태를 정리한다. */
	const stopTaskDrag = (releaseCapture: boolean): TaskDragSession | undefined => {
		const session = dragSession;

		if (!session) {
			return undefined;
		}

		dragSession = undefined;
		const element = nodeElements.get(session.renderKey);

		element?.classList.remove('is-dragging');
		if (releaseCapture && element?.hasPointerCapture(session.pointerId)) {
			element.releasePointerCapture(session.pointerId);
		}
		return session;
	};

	/** Task Node Pointer 입력을 선택 후보로 만들고 Start에서만 Drag를 시작한다. */
	const handlePointerDown = (event: PointerEvent): void => {
		const element = resolveTaskNodeElement(event.target);
		const renderKey = element ? getTaskNodeRenderKey(element) : undefined;
		const node = renderKey ? nodesByRenderKey.get(renderKey) : undefined;

		if (!element || !renderKey || !node) {
			return;
		}

		event.stopPropagation();
		if (suppressClickKey === renderKey) {
			suppressClickKey = undefined;
		}
		if (suppressDoubleClickKey === renderKey) {
			suppressDoubleClickKey = undefined;
		}

		if (
			disposed
			|| dragSession
			|| node.kind !== 'start'
			|| !event.isPrimary
			|| event.button !== 0
		) {
			return;
		}

		const cameraScale = interactions.getCameraScale?.() ?? 1;

		if (!Number.isFinite(cameraScale) || cameraScale <= 0) {
			return;
		}

		event.preventDefault();
		dragSession = {
			pointerId: event.pointerId,
			renderKey,
			taskId: node.taskId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startOrigin: {
				x: node.position.x - node.localPosition.x,
				y: node.position.y - node.localPosition.y,
			},
			cameraScale,
			didDrag: false,
		};
		element.setPointerCapture(event.pointerId);
	};

	/** Threshold를 넘은 Start Pointer 이동을 Task origin의 World delta로 반영한다. */
	const handlePointerMove = (event: PointerEvent): void => {
		const session = dragSession;

		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		const screenDeltaX = event.clientX - session.startClientX;
		const screenDeltaY = event.clientY - session.startClientY;

		if (
			!session.didDrag
			&& Math.hypot(screenDeltaX, screenDeltaY) < TASK_DRAG_THRESHOLD
		) {
			return;
		}

		session.didDrag = true;
		interactions.onTaskOriginChange?.(session.taskId, {
			x: session.startOrigin.x + screenDeltaX / session.cameraScale,
			y: session.startOrigin.y + screenDeltaY / session.cameraScale,
		});
		nodeElements.get(session.renderKey)?.classList.add('is-dragging');
	};

	/** Pointer Up은 최신 Domain origin을 유지하고 합성 Click/Double Click을 억제한다. */
	const handlePointerUp = (event: PointerEvent): void => {
		if (!dragSession || event.pointerId !== dragSession.pointerId) {
			return;
		}

		event.stopPropagation();
		const completed = stopTaskDrag(true);

		if (completed?.didDrag) {
			event.preventDefault();
			suppressClickKey = completed.renderKey;
			suppressDoubleClickKey = completed.renderKey;
		}
	};

	/** Cancel 또는 Capture 상실은 시작 origin으로 복원하고 session을 종료한다. */
	const cancelTaskDrag = (event: PointerEvent, releaseCapture: boolean): void => {
		if (!dragSession || event.pointerId !== dragSession.pointerId) {
			return;
		}

		event.stopPropagation();
		const cancelled = stopTaskDrag(releaseCapture);

		suppressClickKey = undefined;
		suppressDoubleClickKey = undefined;
		if (cancelled?.didDrag) {
			event.preventDefault();
			interactions.onTaskOriginChange?.(
				cancelled.taskId,
				cancelled.startOrigin,
			);
		}
	};
	const handlePointerCancel = (event: PointerEvent): void => {
		cancelTaskDrag(event, true);
	};
	const handleLostPointerCapture = (event: PointerEvent): void => {
		cancelTaskDrag(event, false);
	};

	/** Drag로 소비되지 않은 Task Node Click만 복합 identity 기준으로 선택한다. */
	const handleClick = (event: MouseEvent): void => {
		const element = resolveTaskNodeElement(event.target);
		const renderKey = element ? getTaskNodeRenderKey(element) : undefined;

		if (!renderKey || !nodesByRenderKey.has(renderKey)) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		if (suppressClickKey === renderKey) {
			suppressClickKey = undefined;
			return;
		}

		selectTaskNode(renderKey);
	};

	/** Start/Work Double Click을 최신 Layout Node 식별 및 Focus 경계로 전달한다. */
	const handleDoubleClick = (event: MouseEvent): void => {
		const element = resolveTaskNodeElement(event.target);
		const renderKey = element ? getTaskNodeRenderKey(element) : undefined;
		const node = renderKey ? nodesByRenderKey.get(renderKey) : undefined;

		if (!renderKey || !node) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		if (suppressDoubleClickKey === renderKey) {
			suppressDoubleClickKey = undefined;
			return;
		}
		if (dragSession || (node.kind !== 'start' && node.kind !== 'work')) {
			return;
		}

		interactions.onNodeFocus?.(node);
	};

	const applyLayout = (layout: TaskGraphLayout): void => {
		if (disposed) {
			return;
		}

		const nextNodeKeys = new Set(layout.nodes.map((node) => (
			createTaskNodeRenderKey(node.taskId, node.id)
		)));
		const nextEdgeKeys = new Set(layout.edges.map((edge) => (
			createTaskEdgeRenderKey(edge.taskId, edge.id)
		)));

		if (dragSession && !nextNodeKeys.has(dragSession.renderKey)) {
			stopTaskDrag(true);
		}
		if (selectedNodeKey && !nextNodeKeys.has(selectedNodeKey)) {
			selectedNodeKey = undefined;
		}

		for (const [renderKey, element] of nodeElements) {
			if (!nextNodeKeys.has(renderKey)) {
				element.remove();
				nodeElements.delete(renderKey);
			}
		}

		for (const [renderKey, element] of edgeElements) {
			if (!nextEdgeKeys.has(renderKey)) {
				element.remove();
				edgeElements.delete(renderKey);
			}
		}

		nodesByRenderKey = new Map(layout.nodes.map((node) => [
			createTaskNodeRenderKey(node.taskId, node.id),
			node,
		]));

		for (const node of layout.nodes) {
			const renderKey = createTaskNodeRenderKey(node.taskId, node.id);
			let element = nodeElements.get(renderKey);

			if (!element) {
				element = ownerDocument.createElement('div');
				nodeLayer.append(element);
				nodeElements.set(renderKey, element);
			}

			syncTaskNodeElement(element, node, ownerDocument);
			if (selectedNodeKey === renderKey) {
				element.classList.add('is-selected');
			} else {
				element.classList.remove('is-selected');
			}
			if (dragSession?.renderKey === renderKey && dragSession.didDrag) {
				element.classList.add('is-dragging');
			} else {
				element.classList.remove('is-dragging');
			}
		}

		for (const edge of layout.edges) {
			const source = nodesByRenderKey.get(createTaskNodeRenderKey(
				edge.taskId,
				edge.sourceId,
			));
			const target = nodesByRenderKey.get(createTaskNodeRenderKey(
				edge.taskId,
				edge.targetId,
			));

			if (!source || !target) {
				continue;
			}

			const renderKey = createTaskEdgeRenderKey(edge.taskId, edge.id);
			let element = edgeElements.get(renderKey);

			if (!element) {
				element = ownerDocument.createElementNS(SVG_NAMESPACE, 'path');
				edgeLayer.append(element);
				edgeElements.set(renderKey, element);
			}

			syncTaskEdgeElement(element, edge, source, target);
		}
	};

	applyLayout(initialLayout);
	nodeLayer.addEventListener('pointerdown', handlePointerDown);
	nodeLayer.addEventListener('pointermove', handlePointerMove);
	nodeLayer.addEventListener('pointerup', handlePointerUp);
	nodeLayer.addEventListener('pointercancel', handlePointerCancel);
	nodeLayer.addEventListener('lostpointercapture', handleLostPointerCapture);
	nodeLayer.addEventListener('click', handleClick);
	nodeLayer.addEventListener('dblclick', handleDoubleClick);

	return {
		applyLayout,
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			nodeLayer.removeEventListener('pointerdown', handlePointerDown);
			nodeLayer.removeEventListener('pointermove', handlePointerMove);
			nodeLayer.removeEventListener('pointerup', handlePointerUp);
			nodeLayer.removeEventListener('pointercancel', handlePointerCancel);
			nodeLayer.removeEventListener(
				'lostpointercapture',
				handleLostPointerCapture,
			);
			nodeLayer.removeEventListener('click', handleClick);
			nodeLayer.removeEventListener('dblclick', handleDoubleClick);
			stopTaskDrag(true);
			selectedNodeKey = undefined;
			nodesByRenderKey.clear();
			for (const element of nodeElements.values()) {
				element.remove();
			}
			for (const element of edgeElements.values()) {
				element.remove();
			}
			nodeElements.clear();
			edgeElements.clear();
		},
	};
}

/** 같은 내부 Node ID를 가진 Task DOM을 분리하는 Renderer 전용 identity다. */
function createTaskNodeRenderKey(taskId: string, nodeId: string): string {
	return `${taskId}:${nodeId}`;
}

/** 같은 내부 Edge ID를 가진 Task SVG를 분리하는 Renderer 전용 identity다. */
function createTaskEdgeRenderKey(taskId: string, edgeId: string): string {
	return `${taskId}:${edgeId}`;
}

/** Task Node Card의 내용, 식별 정보와 World geometry를 최신 Layout과 맞춘다. */
function syncTaskNodeElement(
	element: HTMLElement,
	node: TaskLayoutNode,
	ownerDocument: Document,
): void {
	element.className = `graph-node task-node task-${node.kind}-node`;
	element.setAttribute(TASK_ID_ATTRIBUTE, node.taskId);
	element.setAttribute(TASK_NODE_ID_ATTRIBUTE, node.id);
	element.setAttribute(TASK_NODE_KIND_ATTRIBUTE, node.kind);
	element.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	element.setAttribute('role', 'group');
	element.setAttribute('aria-label', createTaskNodeAriaLabel(node));
	element.style.width = `${node.width}px`;
	element.style.height = `${node.height}px`;
	element.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
	element.replaceChildren(...createTaskNodeContents(node, ownerDocument));
}

/** Task Node kind에 맞는 label과 Blueprint 텍스트 DOM을 생성한다. */
function createTaskNodeContents(
	node: TaskLayoutNode,
	ownerDocument: Document,
): HTMLElement[] {
	const kind = ownerDocument.createElement('span');

	kind.className = 'task-node-kind';
	kind.textContent = node.kind === 'start'
		? 'Start'
		: node.kind === 'work' ? 'Work' : 'End';

	if (node.kind === 'end') {
		return [kind];
	}

	const title = ownerDocument.createElement('strong');
	const description = ownerDocument.createElement('span');

	title.className = 'task-node-title';
	title.textContent = node.title;
	description.className = 'task-node-description';
	description.textContent = node.description;

	if (node.kind === 'start' || node.prompt.length === 0) {
		return [kind, title, description];
	}

	const prompt = ownerDocument.createElement('span');

	prompt.className = 'task-node-prompt';
	prompt.textContent = node.prompt;
	return [kind, title, description, prompt];
}

/** 접근성 이름은 화면에 표시하는 kind와 주요 제목만 포함한다. */
function createTaskNodeAriaLabel(node: TaskLayoutNode): string {
	if (node.kind === 'end') {
		return 'Task End';
	}

	return `Task ${node.kind === 'start' ? 'Start' : 'Work'}: ${node.title}`;
}

/** Task Edge의 소유권과 세로 Bezier geometry를 SVG path에 적용한다. */
function syncTaskEdgeElement(
	element: SVGPathElement,
	edge: TaskLayoutEdge,
	source: TaskLayoutNode,
	target: TaskLayoutNode,
): void {
	element.setAttribute('class', 'graph-edge task-edge');
	element.setAttribute(TASK_ID_ATTRIBUTE, edge.taskId);
	element.setAttribute(TASK_EDGE_ID_ATTRIBUTE, edge.id);
	element.setAttribute('data-task-edge-source', edge.sourceId);
	element.setAttribute('data-task-edge-target', edge.targetId);
	element.setAttribute('d', createTaskEdgePath(source, target));
}

/** Source 하단 중앙에서 Target 상단 중앙을 잇는 세로 Cubic Bezier path를 만든다. */
function createTaskEdgePath(
	source: TaskLayoutNode,
	target: TaskLayoutNode,
): string {
	const sourceX = source.position.x + source.width / 2;
	const sourceY = source.position.y + source.height;
	const targetX = target.position.x + target.width / 2;
	const targetY = target.position.y;
	const direction = targetY >= sourceY ? 1 : -1;
	const controlOffset = Math.max(24, Math.abs(targetY - sourceY) / 2);

	return [
		`M ${sourceX} ${sourceY}`,
		`C ${sourceX} ${sourceY + controlOffset * direction}`,
		`${targetX} ${targetY - controlOffset * direction}`,
		`${targetX} ${targetY}`,
	].join(' ');
}
