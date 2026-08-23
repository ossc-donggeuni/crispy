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
/** Edge Action Button의 편집 종류를 식별하는 attribute다. */
export const TASK_EDGE_ACTION_ATTRIBUTE = 'data-task-edge-action';
/** Edge Action Overlay가 소유한 Task를 식별하는 Renderer 전용 attribute다. */
export const TASK_EDGE_ACTION_TASK_ID_ATTRIBUTE = 'data-task-edge-action-task-id';
/** Edge Action Overlay가 가리키는 Edge를 식별하는 Renderer 전용 attribute다. */
export const TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE = 'data-task-edge-action-edge-id';
/** Work Node의 최소 삭제 Action을 식별하는 attribute다. */
export const TASK_NODE_ACTION_ATTRIBUTE = 'data-task-node-action';

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
	/** 선택 Edge 사이에 직렬 Work를 삽입한다. */
	onInsertWorkAtEdge?: (taskId: string, edgeId: string) => void;
	/** 선택 Edge target Work와 같은 실행 단계에 병렬 Work를 추가한다. */
	onAddParallelWorkAtEdge?: (taskId: string, edgeId: string) => void;
	/** Work Node를 제거하고 Domain에서 연결을 복구한다. */
	onWorkRemove?: (taskId: string, nodeId: string) => void;
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
	const edgeActionElements = new Map<string, HTMLElement>();
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

	/** Event target 또는 조상에서 지정한 Task Action attribute 요소를 찾는다. */
	const resolveTaskActionElement = (
		target: EventTarget | null,
		attribute: string,
	): HTMLElement | undefined => {
		if (target === null || typeof (target as Element).closest !== 'function') {
			return undefined;
		}

		return (target as Element).closest<HTMLElement>(`[${attribute}]`) ?? undefined;
	};

	const isTaskActionTarget = (target: EventTarget | null): boolean => (
		resolveTaskActionElement(target, TASK_NODE_ACTION_ATTRIBUTE) !== undefined
		|| resolveTaskActionElement(
			target,
			TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE,
		) !== undefined
	);

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
		if (isTaskActionTarget(event.target)) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}

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
		const edgeAction = resolveTaskActionElement(
			event.target,
			TASK_EDGE_ACTION_ATTRIBUTE,
		);
		if (edgeAction) {
			const action = edgeAction.getAttribute(TASK_EDGE_ACTION_ATTRIBUTE);
			const taskId = resolveTaskActionElement(
				edgeAction,
				TASK_EDGE_ACTION_TASK_ID_ATTRIBUTE,
			)?.getAttribute(TASK_EDGE_ACTION_TASK_ID_ATTRIBUTE);
			const edgeId = resolveTaskActionElement(
				edgeAction,
				TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE,
			)?.getAttribute(TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE);

			event.preventDefault();
			event.stopPropagation();
			if (taskId && edgeId && action === 'insert-work') {
				interactions.onInsertWorkAtEdge?.(taskId, edgeId);
			} else if (taskId && edgeId && action === 'add-parallel-work') {
				interactions.onAddParallelWorkAtEdge?.(taskId, edgeId);
			}
			return;
		}

		const nodeAction = resolveTaskActionElement(
			event.target,
			TASK_NODE_ACTION_ATTRIBUTE,
		);
		if (nodeAction) {
			const nodeElement = resolveTaskNodeElement(nodeAction);
			const taskId = nodeElement?.getAttribute(TASK_ID_ATTRIBUTE);
			const nodeId = nodeElement?.getAttribute(TASK_NODE_ID_ATTRIBUTE);

			event.preventDefault();
			event.stopPropagation();
			if (
				taskId
				&& nodeId
				&& nodeAction.getAttribute(TASK_NODE_ACTION_ATTRIBUTE) === 'remove-work'
			) {
				interactions.onWorkRemove?.(taskId, nodeId);
			}
			return;
		}

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
		if (isTaskActionTarget(event.target)) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}

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
		for (const [renderKey, element] of edgeActionElements) {
			if (!nextEdgeKeys.has(renderKey)) {
				element.remove();
				edgeActionElements.delete(renderKey);
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

			syncTaskEdgeElement(element, edge);
			let actionElement = edgeActionElements.get(renderKey);

			if (!actionElement) {
				actionElement = ownerDocument.createElement('div');
				nodeLayer.append(actionElement);
				edgeActionElements.set(renderKey, actionElement);
			}
			syncTaskEdgeActionElement(actionElement, edge, ownerDocument);
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
			for (const element of edgeActionElements.values()) {
				element.remove();
			}
			nodeElements.clear();
			edgeElements.clear();
			edgeActionElements.clear();
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

	if (node.kind === 'start') {
		return [kind, title, description];
	}

	const contents = [kind, title, description];

	if (node.prompt.length > 0) {
		const prompt = ownerDocument.createElement('span');

		prompt.className = 'task-node-prompt';
		prompt.textContent = node.prompt;
		contents.push(prompt);
	}
	contents.push(createTaskWorkActions(ownerDocument));
	return contents;
}

/** Work 카드에 Inspector와 무관한 최소 삭제 Action을 추가한다. */
function createTaskWorkActions(ownerDocument: Document): HTMLElement {
	const actions = ownerDocument.createElement('div');
	const remove = ownerDocument.createElement('button');
	const icon = ownerDocument.createElement('span');

	actions.className = 'task-work-actions';
	actions.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	remove.className = 'graph-detached-root-action task-work-action';
	remove.type = 'button';
	remove.title = 'Work 삭제';
	remove.setAttribute('aria-label', 'Work 삭제');
	remove.setAttribute(TASK_NODE_ACTION_ATTRIBUTE, 'remove-work');
	remove.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	icon.className = 'graph-detached-root-action-icon';
	icon.setAttribute('data-ui-icon', 'delete.svg');
	icon.setAttribute('aria-hidden', 'true');
	remove.append(icon);
	actions.append(remove);
	return actions;
}

/** 접근성 이름은 화면에 표시하는 kind와 주요 제목만 포함한다. */
function createTaskNodeAriaLabel(node: TaskLayoutNode): string {
	if (node.kind === 'end') {
		return 'Task End';
	}

	return `Task ${node.kind === 'start' ? 'Start' : 'Work'}: ${node.title}`;
}

/** Task Edge의 소유권과 Layout이 계산한 Bézier geometry를 SVG path에 적용한다. */
function syncTaskEdgeElement(
	element: SVGPathElement,
	edge: TaskLayoutEdge,
): void {
	element.setAttribute('class', 'graph-edge task-edge');
	element.setAttribute(TASK_ID_ATTRIBUTE, edge.taskId);
	element.setAttribute(TASK_EDGE_ID_ATTRIBUTE, edge.id);
	element.setAttribute('data-task-edge-source', edge.sourceId);
	element.setAttribute('data-task-edge-target', edge.targetId);
	element.setAttribute('d', createTaskEdgePath(edge.geometry));
}

/** Edge 중앙 Hover Target에 직렬/병렬 Action Button을 배치한다. */
function syncTaskEdgeActionElement(
	element: HTMLElement,
	edge: TaskLayoutEdge,
	ownerDocument: Document,
): void {
	const actionList = ownerDocument.createElement('div');
	const hoverTarget = ownerDocument.createElement('span');

	element.className = 'task-edge-actions';
	element.setAttribute(TASK_EDGE_ACTION_TASK_ID_ATTRIBUTE, edge.taskId);
	element.setAttribute(TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE, edge.id);
	element.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	element.style.left = `${edge.geometry.midpoint.x}px`;
	element.style.top = `${edge.geometry.midpoint.y}px`;
	hoverTarget.className = 'task-edge-hover-target';
	hoverTarget.setAttribute('aria-hidden', 'true');
	actionList.className = 'task-edge-action-list';
	actionList.append(createTaskEdgeActionButton(
		ownerDocument,
		'사이에 작업 추가',
		'+',
		'insert-work',
	));
	if (edge.canAddParallelWork) {
		actionList.append(createTaskEdgeActionButton(
			ownerDocument,
			'병렬 작업 추가',
			'⇉',
			'add-parallel-work',
		));
	}
	element.replaceChildren(hoverTarget, actionList);
}

function createTaskEdgeActionButton(
	ownerDocument: Document,
	label: string,
	symbol: string,
	action: 'insert-work' | 'add-parallel-work',
): HTMLButtonElement {
	const button = ownerDocument.createElement('button');
	const icon = ownerDocument.createElement('span');

	button.className = 'graph-detached-root-action task-edge-action';
	button.type = 'button';
	button.title = label;
	button.setAttribute('aria-label', label);
	button.setAttribute(TASK_EDGE_ACTION_ATTRIBUTE, action);
	button.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	icon.className = 'task-edge-action-symbol';
	icon.textContent = symbol;
	icon.setAttribute('aria-hidden', 'true');
	button.append(icon);
	return button;
}

/** Layout과 Action이 공유한 Right Center → Left Center geometry를 직렬화한다. */
function createTaskEdgePath(
	geometry: TaskLayoutEdge['geometry'],
): string {
	return [
		`M ${geometry.start.x} ${geometry.start.y}`,
		`C ${geometry.control1.x} ${geometry.control1.y}`,
		`${geometry.control2.x} ${geometry.control2.y}`,
		`${geometry.end.x} ${geometry.end.y}`,
	].join(' ');
}
