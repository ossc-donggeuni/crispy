import { GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE } from './graphCamera';
import type { GraphLayoutPosition } from './graphLayout';
import type { GraphStateStore } from './graphState';

/** Graph Node Drag가 등록한 입력 lifecycle을 관리한다. */
export interface GraphNodeDrag {
	/** Reflow 뒤 저장 위치가 없는 Drag가 사용할 최신 Layout 기준점을 갱신한다. */
	updateDefaultPosition(position: GraphLayoutPosition): void;
	/** Pointer와 Click Listener 및 진행 중인 Drag 표시 상태를 정리한다. */
	dispose(): void;
}

/** Graph Node Drag가 Renderer와 Click interaction에 전달하는 callback이다. */
export interface GraphNodeDragOptions {
	/** Drag로 소비되지 않은 Click이 완료됐을 때 호출된다. */
	onClick?: () => void;
	/** Drag 중 임시 World 위치가 바뀌거나 취소로 복원될 때 호출된다. */
	onPositionChange?: (position: GraphLayoutPosition) => void;
	/** Threshold 이후 Pointer의 최신 client 위치를 관찰한다. */
	onDragMove?: (point: GraphNodeDragClientPoint) => void;
	/** Pointer up을 별도 동작으로 소비하면 true를 반환해 위치 저장을 건너뛴다. */
	onDragEnd?: (point: GraphNodeDragClientPoint) => boolean;
	/** Cancel, capture 상실 또는 dispose 시 외부 Drag 상태를 정리한다. */
	onDragCancel?: () => void;
}

/** Node Drag 관찰 callback에 전달하는 client 좌표다. */
export interface GraphNodeDragClientPoint {
	readonly clientX: number;
	readonly clientY: number;
}

/** Pointer Capture 동안 유지하는 시작 좌표와 임시 World 위치다. */
interface NodeDragSession {
	readonly pointerId: number;
	readonly startClientX: number;
	readonly startClientY: number;
	readonly startPosition: GraphLayoutPosition;
	readonly cameraScale: number;
	currentPosition: GraphLayoutPosition;
	didDrag: boolean;
}

/** 해당 요소에서 시작한 입력이 상위 Graph Node Drag를 시작하지 않도록 하는 attribute다. */
export const GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE = 'data-graph-node-drag-ignore';

const GRAPH_NODE_DRAG_IGNORE_SELECTOR = `[${GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE}]`;
const GRAPH_NODE_DRAG_THRESHOLD = 4;

/**
 * Graph Node 자체를 Pointer Capture 대상으로 사용해 World 위치를 이동한다.
 * Pointer move 중에는 callback으로 DOM/Edge만 갱신하고 실제 Drag 종료 시에만
 * 최종 World 위치를 Graph State에 한 번 저장한다.
 *
 * @param node Pointer Capture와 transform을 적용할 Graph Node 요소
 * @param nodeId Graph State 위치 override의 안정적인 Node ID
 * @param defaultPosition 저장 위치가 없을 때 사용하는 Layout World 좌표
 * @param graphState Camera scale 조회와 최종 위치 저장에 사용하는 Store
 * @param options Click 및 임시 위치 변경 callback
 * @returns Listener와 활성 Drag session을 정리하는 lifecycle 핸들
 */
export function initializeGraphNodeDrag(
	node: HTMLElement,
	nodeId: string,
	defaultPosition: GraphLayoutPosition,
	graphState: GraphStateStore,
	options: GraphNodeDragOptions = {},
): GraphNodeDrag {
	let session: NodeDragSession | undefined;
	let currentDefaultPosition = defaultPosition;
	let suppressNextClick = false;
	let disposed = false;

	node.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');

	/** 활성 Drag session과 Pointer Capture 및 CSS 표시 상태를 정리한다. */
	const stopDragging = (pointerId: number, releaseCapture: boolean): void => {
		session = undefined;
		node.classList.remove('is-dragging');

		if (releaseCapture && node.hasPointerCapture(pointerId)) {
			node.releasePointerCapture(pointerId);
		}
	};

	/** 유효한 기본 Pointer 입력을 시작 위치와 Camera scale에 고정한다. */
	const handlePointerDown = (event: PointerEvent): void => {
		if (
			disposed
			|| session
			|| !event.isPrimary
			|| event.button !== 0
			|| shouldIgnoreNodeDrag(event)
		) {
			return;
		}

		event.preventDefault();
		suppressNextClick = false;
		const state = graphState.getState();
		const savedPosition = state.nodePositions[nodeId];

		session = {
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startPosition: savedPosition ?? currentDefaultPosition,
			cameraScale: state.camera.scale,
			currentPosition: savedPosition ?? currentDefaultPosition,
			didDrag: false,
		};
		node.classList.add('is-dragging');
		node.setPointerCapture(event.pointerId);
	};

	/** Screen 이동량을 시작 시점 Camera scale로 나눠 임시 World 위치를 전달한다. */
	const handlePointerMove = (event: PointerEvent): void => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		event.preventDefault();
		const screenDeltaX = event.clientX - session.startClientX;
		const screenDeltaY = event.clientY - session.startClientY;

		if (
			!session.didDrag
			&& Math.hypot(screenDeltaX, screenDeltaY) < GRAPH_NODE_DRAG_THRESHOLD
		) {
			return;
		}

		session.didDrag = true;
		const deltaX = screenDeltaX / session.cameraScale;
		const deltaY = screenDeltaY / session.cameraScale;
		session.currentPosition = {
			x: session.startPosition.x + deltaX,
			y: session.startPosition.y + deltaY,
		};
		options.onPositionChange?.(session.currentPosition);
		options.onDragMove?.({
			clientX: event.clientX,
			clientY: event.clientY,
		});
	};

	/** 실제 Drag가 발생했다면 최종 World 위치를 Graph State에 한 번 저장한다. */
	const handlePointerEnd = (event: PointerEvent): void => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		const completedSession = session;

		suppressNextClick = completedSession.didDrag;
		const dragConsumed = completedSession.didDrag
			? options.onDragEnd?.({
				clientX: event.clientX,
				clientY: event.clientY,
			}) === true
			: false;

		if (completedSession.didDrag && !dragConsumed) {
			const state = graphState.getState();

			graphState.setState({
				camera: { ...state.camera },
				nodePositions: {
					...state.nodePositions,
					[nodeId]: { ...completedSession.currentPosition },
				},
			});
		}

		stopDragging(event.pointerId, true);
	};

	/** Pointer 취소 시 임시 위치를 시작 위치로 복원하고 저장하지 않는다. */
	const handlePointerCancel = (event: PointerEvent): void => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		suppressNextClick = false;

		if (session.didDrag) {
			options.onPositionChange?.(session.startPosition);
		}
		options.onDragCancel?.();

		stopDragging(event.pointerId, true);
	};

	/** Pointer Capture를 잃으면 임시 위치를 복원하고 session을 정리한다. */
	const handleLostPointerCapture = (event: PointerEvent): void => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		if (session.didDrag) {
			options.onPositionChange?.(session.startPosition);
		}
		options.onDragCancel?.();

		stopDragging(event.pointerId, false);
	};

	/** Drag 종료 직후 Click은 소비하고 일반 Click만 interaction callback에 전달한다. */
	const handleClick = (event: MouseEvent): void => {
		if (suppressNextClick) {
			suppressNextClick = false;
			event.preventDefault();
			event.stopPropagation();
			return;
		}

		options.onClick?.();
	};

	node.addEventListener('pointerdown', handlePointerDown);
	node.addEventListener('pointermove', handlePointerMove);
	node.addEventListener('pointerup', handlePointerEnd);
	node.addEventListener('pointercancel', handlePointerCancel);
	node.addEventListener('lostpointercapture', handleLostPointerCapture);
	node.addEventListener('click', handleClick);

	return {
		updateDefaultPosition(position): void {
			if (!disposed) {
				currentDefaultPosition = position;
			}
		},
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			node.removeEventListener('pointerdown', handlePointerDown);
			node.removeEventListener('pointermove', handlePointerMove);
			node.removeEventListener('pointerup', handlePointerEnd);
			node.removeEventListener('pointercancel', handlePointerCancel);
			node.removeEventListener('lostpointercapture', handleLostPointerCapture);
			node.removeEventListener('click', handleClick);

			if (session) {
				if (session.didDrag) {
					options.onPositionChange?.(session.startPosition);
				}
				options.onDragCancel?.();

				stopDragging(session.pointerId, true);
			}
		},
	};
}

/** Event target 또는 조상이 Node Drag 차단 attribute를 가지는지 판별한다. */
function shouldIgnoreNodeDrag(event: Event): boolean {
	const target = event.target;

	return target !== null
		&& typeof (target as Element).closest === 'function'
		&& (target as Element).closest(GRAPH_NODE_DRAG_IGNORE_SELECTOR) !== null;
}
