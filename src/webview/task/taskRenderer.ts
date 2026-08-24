import {
	createTaskEdgeGeometry,
	getTaskPortCenter,
	type TaskGraphLayout,
	type TaskLayoutEdge,
	type TaskLayoutNode,
	type TaskLayoutPosition,
} from './taskLayout';
import type { TaskNodePosition, TaskOrigin } from '../../task';
import { GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE } from '../graph/graphCamera';
import { GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE } from '../graph/graphNodeDrag';

/** Task interaction이 Task 소유권을 판별할 때 사용할 DOM attribute다. */
export const TASK_ID_ATTRIBUTE = 'data-task-id';
/** Task interaction이 안정적인 Task Node ID를 읽을 DOM attribute다. */
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
/** Task Node Action을 식별하는 attribute다. */
export const TASK_NODE_ACTION_ATTRIBUTE = 'data-task-node-action';
/** Task 연결 Port의 input/output 방향을 식별하는 attribute다. */
export const TASK_PORT_DIRECTION_ATTRIBUTE = 'data-task-port-direction';
/** Task의 ready/incomplete 표시 상태를 Node DOM에 전달하는 attribute다. */
export const TASK_FLOW_STATE_ATTRIBUTE = 'data-task-flow-state';
/** START/END의 Work Edge 연결 파생 상태를 DOM에 전달하는 attribute다. */
export const TASK_CONNECTION_STATE_ATTRIBUTE = 'data-task-connection-state';

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
	/** Work/End Drag으로 계산한 task-local position을 Domain State에 전달한다. */
	onTaskNodePositionChange?: (
		taskId: string,
		nodeId: string,
		position: TaskNodePosition,
	) => void;
	/** Start/Work Double Click 대상을 Camera Focus 경계에 전달한다. */
	onNodeFocus?: (node: TaskLayoutNode) => void;
	/** Start Action으로 연결 전 Work 하나를 추가한다. */
	onWorkAdd?: (taskId: string) => void;
	/** Work Node와 incident Edge를 제거한다. */
	onWorkRemove?: (taskId: string, nodeId: string) => void;
	/** 두 Task Port의 연결 가능성을 Domain DAG 기준으로 판정한다. */
	canConnectNodes?: (
		sourceTaskId: string,
		sourceNodeId: string,
		targetTaskId: string,
		targetNodeId: string,
	) => boolean;
	/** 유효한 두 Task Port를 연결하고 성공 여부를 반환한다. */
	onNodesConnect?: (
		sourceTaskId: string,
		sourceNodeId: string,
		targetTaskId: string,
		targetNodeId: string,
	) => boolean;
	/** 정확한 Task Edge 하나를 연결 해제한다. */
	onEdgeDisconnect?: (taskId: string, edgeId: string) => void;
	/** Pointer client 좌표를 Graph World 좌표로 변환한다. */
	clientToWorld?: (point: TaskLayoutPosition) => TaskLayoutPosition;
}

interface TaskDragSessionBase {
	readonly pointerId: number;
	readonly renderKey: string;
	readonly taskId: string;
	readonly startClientX: number;
	readonly startClientY: number;
	readonly cameraScale: number;
	didDrag: boolean;
}

interface TaskOriginDragSession extends TaskDragSessionBase {
	readonly target: 'origin';
	readonly startOrigin: TaskOrigin;
}

interface TaskNodePositionDragSession extends TaskDragSessionBase {
	readonly target: 'node-position';
	readonly nodeId: string;
	readonly startPosition: TaskNodePosition;
}

type TaskDragSession = TaskOriginDragSession | TaskNodePositionDragSession;
type TaskPortDirection = 'input' | 'output';

interface TaskPortTarget {
	readonly node: TaskLayoutNode;
	readonly renderKey: string;
	readonly direction: TaskPortDirection;
}

/** 한 번에 하나만 유지하는 click-click 연결의 source와 현재 pointer 상태다. */
interface TaskConnectionSession {
	readonly taskId: string;
	readonly nodeId: string;
	readonly renderKey: string;
	pointerWorld: TaskLayoutPosition;
	hoveredTargetKey?: string;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const TASK_DRAG_THRESHOLD = 4;
const TASK_CONNECTION_SOURCE_CLASS = 'is-connection-source';
const TASK_CONNECTION_VALID_CLASS = 'is-valid-target';
const TASK_CONNECTION_INVALID_CLASS = 'is-invalid-target';
const TASK_CONNECTION_HOVER_CLASS = 'is-connection-target';

/** 기존 Graph World의 Edge/Node Layer에 Task 전용 DOM을 렌더링한다. */
export function initializeTaskRenderer(
	edgeLayer: SVGSVGElement,
	nodeLayer: HTMLElement,
	viewport: HTMLElement,
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
	let connectionSession: TaskConnectionSession | undefined;
	let previewEdgeElement: SVGPathElement | undefined;
	let suppressClickKey: string | undefined;
	let suppressDoubleClickKey: string | undefined;
	let disposed = false;

	const resolveTaskNodeElement = (
		target: EventTarget | null,
	): HTMLElement | undefined => {
		if (target === null || typeof (target as Element).closest !== 'function') {
			return undefined;
		}

		return (target as Element).closest<HTMLElement>(
			`[${TASK_NODE_ID_ATTRIBUTE}]`,
		) ?? undefined;
	};

	const resolveTaskAttributeElement = (
		target: EventTarget | null,
		attribute: string,
	): HTMLElement | undefined => {
		if (target === null || typeof (target as Element).closest !== 'function') {
			return undefined;
		}

		return (target as Element).closest<HTMLElement>(`[${attribute}]`) ?? undefined;
	};

	const isTaskActionTarget = (target: EventTarget | null): boolean => (
		resolveTaskAttributeElement(target, TASK_NODE_ACTION_ATTRIBUTE) !== undefined
		|| resolveTaskAttributeElement(
			target,
			TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE,
		) !== undefined
	);

	const isTaskDragIgnoredTarget = (target: EventTarget | null): boolean => (
		target !== null
		&& typeof (target as Element).closest === 'function'
		&& (target as Element).closest(
			[
				`[${GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE}]`,
				'button',
				'input',
				'textarea',
				'select',
				'a[href]',
				'[contenteditable]:not([contenteditable="false"])',
			].join(', '),
		) !== null
	);

	const getTaskNodeRenderKey = (element: HTMLElement): string | undefined => {
		const taskId = element.getAttribute(TASK_ID_ATTRIBUTE);
		const nodeId = element.getAttribute(TASK_NODE_ID_ATTRIBUTE);

		return taskId && nodeId
			? createTaskNodeRenderKey(taskId, nodeId)
			: undefined;
	};

	const resolveTaskPort = (target: EventTarget | null): TaskPortTarget | undefined => {
		const portElement = resolveTaskAttributeElement(
			target,
			TASK_PORT_DIRECTION_ATTRIBUTE,
		);
		const nodeElement = portElement
			? resolveTaskNodeElement(portElement)
			: undefined;
		const renderKey = nodeElement
			? getTaskNodeRenderKey(nodeElement)
			: undefined;
		const node = renderKey ? nodesByRenderKey.get(renderKey) : undefined;
		const direction = portElement?.getAttribute(TASK_PORT_DIRECTION_ATTRIBUTE);

		if (
			!portElement
			|| !renderKey
			|| !node
			|| (direction !== 'input' && direction !== 'output')
		) {
			return undefined;
		}

		return { node, renderKey, direction };
	};

	const getTaskNodePort = (
		renderKey: string,
		direction: TaskPortDirection,
	): HTMLElement | undefined => Array.from(
		nodeElements.get(renderKey)?.children ?? [],
	).find((child) => (
		(child as HTMLElement).getAttribute(TASK_PORT_DIRECTION_ATTRIBUTE) === direction
	)) as HTMLElement | undefined;

	const clearTaskNodeSelection = (): void => {
		if (!selectedNodeKey) {
			return;
		}

		nodeElements.get(selectedNodeKey)?.classList.remove('is-selected');
		selectedNodeKey = undefined;
	};

	const selectTaskNode = (renderKey: string): void => {
		if (selectedNodeKey === renderKey) {
			return;
		}

		clearTaskNodeSelection();
		selectedNodeKey = renderKey;
		nodeElements.get(renderKey)?.classList.add('is-selected');
	};

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

	const clearTaskConnectionFeedback = (): void => {
		nodeLayer.classList.remove('is-task-connecting');
		for (const element of nodeElements.values()) {
			for (const child of Array.from(element.children)) {
				const port = child as HTMLElement;

				if (!port.hasAttribute(TASK_PORT_DIRECTION_ATTRIBUTE)) {
					continue;
				}
				port.classList.remove(
					TASK_CONNECTION_SOURCE_CLASS,
					TASK_CONNECTION_VALID_CLASS,
					TASK_CONNECTION_INVALID_CLASS,
					TASK_CONNECTION_HOVER_CLASS,
				);
				port.removeAttribute('aria-pressed');
				port.removeAttribute('aria-disabled');
			}
		}
	};

	const cancelTaskConnection = (): void => {
		connectionSession = undefined;
		clearTaskConnectionFeedback();
		previewEdgeElement?.remove();
		previewEdgeElement = undefined;
	};

	const canConnectToNode = (
		session: TaskConnectionSession,
		target: TaskLayoutNode,
	): boolean => interactions.canConnectNodes?.(
		session.taskId,
		session.nodeId,
		target.taskId,
		target.id,
	) ?? false;

	const syncTaskConnection = (): void => {
		const session = connectionSession;

		if (!session) {
			return;
		}

		const source = nodesByRenderKey.get(session.renderKey);
		const sourcePort = getTaskNodePort(session.renderKey, 'output');

		if (!source || !sourcePort || source.kind === 'end') {
			cancelTaskConnection();
			return;
		}

		clearTaskConnectionFeedback();
		nodeLayer.classList.add('is-task-connecting');
		sourcePort.classList.add(TASK_CONNECTION_SOURCE_CLASS);
		sourcePort.setAttribute('aria-pressed', 'true');

		let hoveredTarget: TaskLayoutNode | undefined;
		let hoveredTargetPort: HTMLElement | undefined;
		let hoveredIsValid = false;
		for (const [renderKey, node] of nodesByRenderKey) {
			const inputPort = getTaskNodePort(renderKey, 'input');

			if (!inputPort) {
				continue;
			}
			const isValid = canConnectToNode(session, node);

			inputPort.classList.add(
				isValid
					? TASK_CONNECTION_VALID_CLASS
					: TASK_CONNECTION_INVALID_CLASS,
			);
			if (!isValid) {
				inputPort.setAttribute('aria-disabled', 'true');
			}
			if (session.hoveredTargetKey === renderKey) {
				hoveredTarget = node;
				hoveredTargetPort = inputPort;
				hoveredIsValid = isValid;
				inputPort.classList.add(TASK_CONNECTION_HOVER_CLASS);
			}
		}

		if (session.hoveredTargetKey && !hoveredTargetPort) {
			session.hoveredTargetKey = undefined;
		}

		if (!previewEdgeElement) {
			previewEdgeElement = ownerDocument.createElementNS(
				SVG_NAMESPACE,
				'path',
			);
			previewEdgeElement.setAttribute('aria-hidden', 'true');
			edgeLayer.append(previewEdgeElement);
		}

		const start = getTaskPortCenter(source, 'output');
		const end = hoveredTarget
			? getTaskPortCenter(hoveredTarget, 'input')
			: session.pointerWorld;
		const geometry = createTaskEdgeGeometry(start, end);
		const connectionClass = hoveredTarget
			? hoveredIsValid ? ' is-valid' : ' is-invalid'
			: '';

		previewEdgeElement.setAttribute(
			'class',
			`graph-edge task-edge task-connection-preview${connectionClass}`,
		);
		previewEdgeElement.setAttribute('d', createTaskEdgePath(geometry));
	};

	const startTaskConnection = (source: TaskPortTarget): void => {
		cancelTaskConnection();
		connectionSession = {
			taskId: source.node.taskId,
			nodeId: source.node.id,
			renderKey: source.renderKey,
			pointerWorld: getTaskPortCenter(source.node, 'output'),
		};
		syncTaskConnection();
	};

	const handlePointerDown = (event: PointerEvent): void => {
		if (isTaskActionTarget(event.target)) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		if (isTaskDragIgnoredTarget(event.target)) {
			return;
		}

		const element = resolveTaskNodeElement(event.target);
		const renderKey = element ? getTaskNodeRenderKey(element) : undefined;
		const node = renderKey ? nodesByRenderKey.get(renderKey) : undefined;

		if (!element || !renderKey || !node) {
			return;
		}

		cancelTaskConnection();
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
		const sessionBase = {
			pointerId: event.pointerId,
			renderKey,
			taskId: node.taskId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			cameraScale,
			didDrag: false,
		};
		dragSession = node.kind === 'start'
			? {
				...sessionBase,
				target: 'origin',
				startOrigin: {
					x: node.position.x - node.localPosition.x,
					y: node.position.y - node.localPosition.y,
				},
			}
			: {
				...sessionBase,
				target: 'node-position',
				nodeId: node.id,
				startPosition: {
					x: node.localPosition.x,
					y: node.localPosition.y,
				},
			};
		element.setPointerCapture(event.pointerId);
	};

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
		const worldDelta = {
			x: screenDeltaX / session.cameraScale,
			y: screenDeltaY / session.cameraScale,
		};

		if (session.target === 'origin') {
			interactions.onTaskOriginChange?.(session.taskId, {
				x: session.startOrigin.x + worldDelta.x,
				y: session.startOrigin.y + worldDelta.y,
			});
		} else {
			interactions.onTaskNodePositionChange?.(
				session.taskId,
				session.nodeId,
				{
					x: session.startPosition.x + worldDelta.x,
					y: session.startPosition.y + worldDelta.y,
				},
			);
		}
		nodeElements.get(session.renderKey)?.classList.add('is-dragging');
	};

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

	const cancelTaskDrag = (event: PointerEvent): void => {
		if (!dragSession || event.pointerId !== dragSession.pointerId) {
			return;
		}

		event.stopPropagation();
		const cancelled = stopTaskDrag(event.type !== 'lostpointercapture');

		suppressClickKey = undefined;
		suppressDoubleClickKey = undefined;
		if (cancelled?.didDrag) {
			event.preventDefault();
			if (cancelled.target === 'origin') {
				interactions.onTaskOriginChange?.(
					cancelled.taskId,
					cancelled.startOrigin,
				);
			} else {
				interactions.onTaskNodePositionChange?.(
					cancelled.taskId,
					cancelled.nodeId,
					cancelled.startPosition,
				);
			}
		}
	};

	const handleTaskPortClick = (
		event: MouseEvent,
		port: TaskPortTarget,
	): void => {
		event.preventDefault();
		event.stopPropagation();
		clearTaskNodeSelection();
		if (port.direction === 'output') {
			if (connectionSession?.renderKey === port.renderKey) {
				cancelTaskConnection();
			} else {
				startTaskConnection(port);
			}
			return;
		}
		if (!connectionSession) {
			return;
		}

		connectionSession.hoveredTargetKey = port.renderKey;
		if (!canConnectToNode(connectionSession, port.node)) {
			syncTaskConnection();
			return;
		}

		const connected = interactions.onNodesConnect?.(
			connectionSession.taskId,
			connectionSession.nodeId,
			port.node.taskId,
			port.node.id,
		) ?? false;

		if (connected) {
			cancelTaskConnection();
		} else {
			syncTaskConnection();
		}
	};

	const handleClick = (event: MouseEvent): void => {
		const port = resolveTaskPort(event.target);

		if (port) {
			handleTaskPortClick(event, port);
			return;
		}

		const edgeAction = resolveTaskAttributeElement(
			event.target,
			TASK_EDGE_ACTION_ATTRIBUTE,
		);
		if (edgeAction) {
			const taskId = resolveTaskAttributeElement(
				edgeAction,
				TASK_EDGE_ACTION_TASK_ID_ATTRIBUTE,
			)?.getAttribute(TASK_EDGE_ACTION_TASK_ID_ATTRIBUTE);
			const edgeId = resolveTaskAttributeElement(
				edgeAction,
				TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE,
			)?.getAttribute(TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE);

			event.preventDefault();
			event.stopPropagation();
			clearTaskNodeSelection();
			cancelTaskConnection();
			if (
				taskId
				&& edgeId
				&& edgeAction.getAttribute(TASK_EDGE_ACTION_ATTRIBUTE) === 'disconnect-edge'
			) {
				interactions.onEdgeDisconnect?.(taskId, edgeId);
			}
			return;
		}

		const nodeAction = resolveTaskAttributeElement(
			event.target,
			TASK_NODE_ACTION_ATTRIBUTE,
		);
		if (nodeAction) {
			const nodeElement = resolveTaskNodeElement(nodeAction);
			const renderKey = nodeElement
				? getTaskNodeRenderKey(nodeElement)
				: undefined;
			const node = renderKey ? nodesByRenderKey.get(renderKey) : undefined;
			const action = nodeAction.getAttribute(TASK_NODE_ACTION_ATTRIBUTE);

			event.preventDefault();
			event.stopPropagation();
			cancelTaskConnection();
			if (node?.kind === 'start' && action === 'add-work') {
				interactions.onWorkAdd?.(node.taskId);
			} else if (node?.kind === 'work' && action === 'remove-work') {
				interactions.onWorkRemove?.(node.taskId, node.id);
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

	const handleDoubleClick = (event: MouseEvent): void => {
		if (
			resolveTaskPort(event.target)
			|| isTaskActionTarget(event.target)
			|| isTaskDragIgnoredTarget(event.target)
		) {
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

	const handleViewportPointerMove = (event: PointerEvent): void => {
		if (!connectionSession) {
			return;
		}

		connectionSession.pointerWorld = interactions.clientToWorld?.({
			x: event.clientX,
			y: event.clientY,
		}) ?? { x: event.clientX, y: event.clientY };
		const port = resolveTaskPort(event.target);

		connectionSession.hoveredTargetKey = port?.direction === 'input'
			? port.renderKey
			: undefined;
		syncTaskConnection();
	};

	const handleViewportBlankInteraction = (
		event: MouseEvent | PointerEvent,
	): void => {
		if (
			resolveTaskPort(event.target)
			|| resolveTaskNodeElement(event.target)
			|| isTaskActionTarget(event.target)
		) {
			return;
		}

		clearTaskNodeSelection();
		if (connectionSession) {
			cancelTaskConnection();
		}
	};

	const handleDocumentKeyDown = (event: KeyboardEvent): void => {
		if (!connectionSession || event.key !== 'Escape') {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		cancelTaskConnection();
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
		if (connectionSession && !nextNodeKeys.has(connectionSession.renderKey)) {
			cancelTaskConnection();
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

		syncTaskConnection();
	};

	applyLayout(initialLayout);
	nodeLayer.addEventListener('pointerdown', handlePointerDown);
	nodeLayer.addEventListener('pointermove', handlePointerMove);
	nodeLayer.addEventListener('pointerup', handlePointerUp);
	nodeLayer.addEventListener('pointercancel', cancelTaskDrag);
	nodeLayer.addEventListener('lostpointercapture', cancelTaskDrag);
	nodeLayer.addEventListener('click', handleClick);
	nodeLayer.addEventListener('dblclick', handleDoubleClick);
	viewport.addEventListener('pointerdown', handleViewportBlankInteraction);
	viewport.addEventListener('pointermove', handleViewportPointerMove);
	viewport.addEventListener('click', handleViewportBlankInteraction);
	ownerDocument.addEventListener?.('keydown', handleDocumentKeyDown);

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
			nodeLayer.removeEventListener('pointercancel', cancelTaskDrag);
			nodeLayer.removeEventListener(
				'lostpointercapture',
				cancelTaskDrag,
			);
			nodeLayer.removeEventListener('click', handleClick);
			nodeLayer.removeEventListener('dblclick', handleDoubleClick);
			viewport.removeEventListener('pointerdown', handleViewportBlankInteraction);
			viewport.removeEventListener('pointermove', handleViewportPointerMove);
			viewport.removeEventListener('click', handleViewportBlankInteraction);
			ownerDocument.removeEventListener?.('keydown', handleDocumentKeyDown);
			stopTaskDrag(true);
			cancelTaskConnection();
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

function createTaskNodeRenderKey(taskId: string, nodeId: string): string {
	return `${taskId}:${nodeId}`;
}

function createTaskEdgeRenderKey(taskId: string, edgeId: string): string {
	return `${taskId}:${edgeId}`;
}

function syncTaskNodeElement(
	element: HTMLElement,
	node: TaskLayoutNode,
	ownerDocument: Document,
): void {
	element.className = `graph-node task-node task-${node.kind}-node`;
	element.setAttribute(TASK_ID_ATTRIBUTE, node.taskId);
	element.setAttribute(TASK_NODE_ID_ATTRIBUTE, node.id);
	element.setAttribute(TASK_NODE_KIND_ATTRIBUTE, node.kind);
	element.setAttribute(TASK_FLOW_STATE_ATTRIBUTE, node.flowState);
	element.setAttribute(TASK_CONNECTION_STATE_ATTRIBUTE, node.connectionState);
	element.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	element.setAttribute('role', 'group');
	element.setAttribute('aria-label', createTaskNodeAriaLabel(node));
	element.style.width = `${node.width}px`;
	element.style.height = `${node.height}px`;
	element.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
	element.replaceChildren(...createTaskNodeContents(node, ownerDocument));
}

function createTaskNodeContents(
	node: TaskLayoutNode,
	ownerDocument: Document,
): HTMLElement[] {
	const kind = ownerDocument.createElement('span');

	kind.className = 'task-node-kind';
	kind.textContent = node.kind === 'start'
		? 'Start'
		: node.kind === 'work' ? 'Work' : 'End';

	const title = ownerDocument.createElement('strong');

	title.className = 'task-node-title';
	title.textContent = node.title;

	if (node.kind === 'start') {
		return [
			kind,
			title,
			createTaskNodeAction(ownerDocument, 'add-work'),
			createTaskPort(ownerDocument, node, 'output'),
		];
	}
	if (node.kind === 'end') {
		return [kind, title, createTaskPort(ownerDocument, node, 'input')];
	}

	const description = ownerDocument.createElement('span');

	description.className = 'task-node-description';
	description.textContent = node.description;

	const contents = [
		kind,
		title,
		description,
		createTaskPort(ownerDocument, node, 'input'),
		createTaskPort(ownerDocument, node, 'output'),
	];

	if (node.prompt.length > 0) {
		const prompt = ownerDocument.createElement('span');

		prompt.className = 'task-node-prompt';
		prompt.textContent = node.prompt;
		contents.splice(3, 0, prompt);
	}
	if (node.canRemove) {
		contents.push(createTaskNodeAction(ownerDocument, 'remove-work'));
	}
	return contents;
}

function createTaskPort(
	ownerDocument: Document,
	node: TaskLayoutNode,
	direction: TaskPortDirection,
): HTMLButtonElement {
	const port = ownerDocument.createElement('button');
	const directionLabel = direction === 'input' ? '입력 연결' : '출력 연결';

	port.className = `task-node-port task-${direction}-port`;
	port.type = 'button';
	port.title = directionLabel;
	port.setAttribute('aria-label', `${createTaskNodeAriaLabel(node)} ${directionLabel}`);
	port.setAttribute(TASK_PORT_DIRECTION_ATTRIBUTE, direction);
	port.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	port.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	return port;
}

function createTaskNodeAction(
	ownerDocument: Document,
	action: 'add-work' | 'remove-work',
): HTMLElement {
	const actions = ownerDocument.createElement('div');
	const button = ownerDocument.createElement('button');
	const icon = ownerDocument.createElement('span');
	const isAdd = action === 'add-work';
	const label = isAdd ? 'Work 추가' : 'Work 삭제';

	actions.className = `task-node-actions task-${isAdd ? 'start' : 'work'}-actions`;
	actions.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	actions.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	button.className = `graph-detached-root-action task-node-action task-${
		isAdd ? 'start' : 'work'
	}-action`;
	button.type = 'button';
	button.title = label;
	button.setAttribute('aria-label', label);
	button.setAttribute(TASK_NODE_ACTION_ATTRIBUTE, action);
	button.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	button.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	icon.setAttribute('aria-hidden', 'true');
	if (isAdd) {
		icon.className = 'task-node-action-symbol';
		icon.textContent = '+';
	} else {
		icon.className = 'graph-detached-root-action-icon';
		icon.setAttribute('data-ui-icon', 'delete.svg');
	}
	button.append(icon);
	actions.append(button);
	return actions;
}

function createTaskNodeAriaLabel(node: TaskLayoutNode): string {
	const kind = node.kind === 'start'
		? 'Start'
		: node.kind === 'work' ? 'Work' : 'End';

	return `Task ${kind}: ${node.title}`;
}

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

function syncTaskEdgeActionElement(
	element: HTMLElement,
	edge: TaskLayoutEdge,
	ownerDocument: Document,
): void {
	const actionList = ownerDocument.createElement('div');
	const hoverTarget = ownerDocument.createElement('span');
	const button = ownerDocument.createElement('button');
	const icon = ownerDocument.createElement('span');

	element.className = 'task-edge-actions';
	element.setAttribute(TASK_EDGE_ACTION_TASK_ID_ATTRIBUTE, edge.taskId);
	element.setAttribute(TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE, edge.id);
	element.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	element.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	element.style.left = `${edge.geometry.midpoint.x}px`;
	element.style.top = `${edge.geometry.midpoint.y}px`;
	hoverTarget.className = 'task-edge-hover-target';
	hoverTarget.setAttribute('aria-hidden', 'true');
	actionList.className = 'task-edge-action-list';
	button.className = 'graph-detached-root-action task-edge-action';
	button.type = 'button';
	button.title = '연결 해제';
	button.setAttribute('aria-label', '연결 해제');
	button.setAttribute(TASK_EDGE_ACTION_ATTRIBUTE, 'disconnect-edge');
	button.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	button.setAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE, '');
	icon.className = 'task-edge-action-symbol';
	icon.textContent = '×';
	icon.setAttribute('aria-hidden', 'true');
	button.append(icon);
	actionList.append(button);
	element.replaceChildren(hoverTarget, actionList);
}

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
