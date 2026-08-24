/** Detach Drag 완료 시 상위 Graph View에 전달하는 client 좌표 기반 요청이다. */
export interface GraphDetachDropRequest {
	readonly nodeId: string;
	/** Detached subtree 안에서 시작한 경우 그 Visual Instance를 소유한 Root ID다. */
	readonly instanceRootId?: string;
	readonly clientX: number;
	readonly clientY: number;
}

/** Detach Handle에 등록한 Pointer와 Click lifecycle을 관리한다. */
export interface GraphDetachDrag {
	/** Listener, Pointer Capture 및 진행 중 표시 상태를 정리한다. */
	dispose(): void;
}

/** Detach Drag가 완료됐을 때 요청을 전달하는 선택적 callback이다. */
export interface GraphDetachDragOptions {
	onDetachDrop?: (request: GraphDetachDropRequest) => void;
	/** Threshold 이후 최신 Pointer client 좌표를 관찰한다. */
	onDragMove?: (request: GraphDetachDropRequest) => void;
	/** Drop을 다른 의미로 소비하면 true를 반환해 기존 Detach를 건너뛴다. */
	onDrop?: (request: GraphDetachDropRequest) => boolean;
	/** 실제 Drag pointerup 뒤 후속 synthetic click을 억제할 기회를 제공한다. */
	onDragComplete?: () => void;
	/** Cancel, capture 상실 또는 dispose 시 외부 transient 상태를 정리한다. */
	onDragCancel?: () => void;
	/** Detach Handle 외의 host에 재사용할 때 일반 click을 보존한다. */
	consumeClick?: boolean;
}

/** Pointer Capture 동안 유지하는 armed/dragging session이다. */
interface DetachDragSession {
	readonly pointerId: number;
	readonly startClientX: number;
	readonly startClientY: number;
	didDrag: boolean;
}

const GRAPH_DETACH_DRAG_THRESHOLD = 4;

/**
 * Detach Handle에서 시작한 입력만 독립적으로 추적한다.
 * 작은 이동은 Click으로 끝내고 threshold를 넘은 Pointer up만 요청으로 전달한다.
 *
 * @param handle Pointer Capture를 소유할 Detach Handle
 * @param nodeId 향후 Graph Root 승격 대상으로 사용할 Folder 또는 File ID
 * @param options client 좌표 기반 Detach 완료 callback
 * @returns 등록한 입력과 진행 중 session을 정리하는 lifecycle 핸들
 */
export function initializeGraphDetachDrag(
	handle: HTMLElement,
	nodeId: string,
	options: GraphDetachDragOptions = {},
	instanceRootId?: string,
): GraphDetachDrag {
	let session: DetachDragSession | undefined;
	let disposed = false;

	/** 활성 session과 Pointer Capture 및 Handle 표시 상태를 정리한다. */
	const stopDragging = (pointerId: number, releaseCapture: boolean): void => {
		session = undefined;
		handle.classList.remove('is-detach-active', 'is-detach-dragging');

		if (releaseCapture && handle.hasPointerCapture(pointerId)) {
			handle.releasePointerCapture(pointerId);
		}
	};
	const createDropRequest = (
		clientX: number,
		clientY: number,
	): GraphDetachDropRequest => ({
		nodeId,
		...(instanceRootId ? { instanceRootId } : {}),
		clientX,
		clientY,
	});

	/** Primary left Pointer만 armed 상태로 만들고 Handle이 Capture를 소유한다. */
	const handlePointerDown = (event: PointerEvent): void => {
		if (
			disposed
			|| session
			|| !event.isPrimary
			|| event.button !== 0
		) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		session = {
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			didDrag: false,
		};
		handle.classList.add('is-detach-active');
		handle.setPointerCapture(event.pointerId);
	};

	/** threshold를 넘은 session만 dragging 상태로 전환한다. */
	const handlePointerMove = (event: PointerEvent): void => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();

		if (
			!session.didDrag
			&& Math.hypot(
				event.clientX - session.startClientX,
				event.clientY - session.startClientY,
			) < GRAPH_DETACH_DRAG_THRESHOLD
		) {
			return;
		}

		session.didDrag = true;
		handle.classList.add('is-detach-dragging');
		options.onDragMove?.(createDropRequest(event.clientX, event.clientY));
	};

	/** 실제 Drag만 client 좌표 요청으로 완료하며 Graph/Graph State는 변경하지 않는다. */
	const handlePointerUp = (event: PointerEvent): void => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		const didDrag = session.didDrag;

		stopDragging(event.pointerId, true);

		if (didDrag) {
			const request = createDropRequest(event.clientX, event.clientY);

			options.onDragComplete?.();
			if (options.onDrop?.(request) !== true) {
				options.onDetachDrop?.(request);
			}
			options.onDragCancel?.();
		}
	};

	/** 취소된 Pointer는 요청 없이 session과 Capture만 정리한다. */
	const handlePointerCancel = (event: PointerEvent): void => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		options.onDragCancel?.();
		stopDragging(event.pointerId, true);
	};

	/** Capture를 잃은 Pointer는 요청 없이 표시 상태와 session만 정리한다. */
	const handleLostPointerCapture = (event: PointerEvent): void => {
		if (!session || event.pointerId !== session.pointerId) {
			return;
		}

		event.stopPropagation();
		options.onDragCancel?.();
		stopDragging(event.pointerId, false);
	};

	/** Handle Click이 Folder/File 선택 interaction으로 전파되지 않게 소비한다. */
	const handleClick = (event: MouseEvent): void => {
		if (options.consumeClick === false) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	};

	handle.addEventListener('pointerdown', handlePointerDown);
	handle.addEventListener('pointermove', handlePointerMove);
	handle.addEventListener('pointerup', handlePointerUp);
	handle.addEventListener('pointercancel', handlePointerCancel);
	handle.addEventListener('lostpointercapture', handleLostPointerCapture);
	handle.addEventListener('click', handleClick);

	return {
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			handle.removeEventListener('pointerdown', handlePointerDown);
			handle.removeEventListener('pointermove', handlePointerMove);
			handle.removeEventListener('pointerup', handlePointerUp);
			handle.removeEventListener('pointercancel', handlePointerCancel);
			handle.removeEventListener('lostpointercapture', handleLostPointerCapture);
			handle.removeEventListener('click', handleClick);

			if (session) {
				options.onDragCancel?.();
				stopDragging(session.pointerId, true);
			}
		},
	};
}
