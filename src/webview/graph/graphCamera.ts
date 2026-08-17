import {
	createGraphState,
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
	type GraphCameraState,
	type GraphStateSnapshot,
	type GraphStateStore,
} from './graphState';

export {
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
	type GraphCameraState,
};

/** Viewport 또는 Graph World의 2차원 좌표다. */
export interface GraphPoint {
	x: number;
	y: number;
}

/** Camera 상태, 좌표 변환, 기준점 Zoom 및 lifecycle을 제공한다. */
export interface GraphCamera {
	/** 현재 Camera 상태의 독립적인 복사본을 반환한다. */
	getState(): GraphCameraState;
	/** Camera 이동과 배율을 Graph State에 반영한다. */
	setState(state: GraphCameraState): void;
	/** 지정한 Viewport 지점 아래의 World 좌표를 유지하며 배율을 변경한다. */
	setScaleAt(scale: number, viewportPoint: GraphPoint): void;
	/** Viewport 좌표를 현재 Camera 기준 World 좌표로 변환한다. */
	viewportToWorld(point: GraphPoint): GraphPoint;
	/** World 좌표를 현재 Camera 기준 Viewport 좌표로 변환한다. */
	worldToViewport(point: GraphPoint): GraphPoint;
	/** 등록한 입력 Listener와 State 구독을 정리한다. */
	dispose(): void;
}

/** 하위 요소에서 시작한 Camera Pan과 Wheel Zoom을 모두 차단하는 attribute다. */
export const GRAPH_CAMERA_IGNORE_ATTRIBUTE = 'data-graph-camera-ignore';
/** 하위 요소에서 시작한 Camera Pan만 차단하고 Wheel Zoom은 허용하는 attribute다. */
export const GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE = 'data-graph-camera-pan-ignore';

const WHEEL_ZOOM_SENSITIVITY = 0.002;
const WHEEL_LINE_HEIGHT = 16;
const GRAPH_GRID_SIZE = 20;
const GRAPH_CAMERA_IGNORE_SELECTOR = `[${GRAPH_CAMERA_IGNORE_ATTRIBUTE}]`;
const GRAPH_CAMERA_PAN_IGNORE_SELECTOR = `[${GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE}]`;

/** 활성 Camera Pan을 시작 좌표와 시작 Camera 위치에 고정하는 session이다. */
interface PanSession {
	pointerId: number;
	startClientX: number;
	startClientY: number;
	startCameraX: number;
	startCameraY: number;
}

/**
 * Graph World의 화면 이동과 확대/축소를 관리한다.
 * Camera 입력과 좌표 계산은 Graph State의 현재 Camera 값을 기준으로 처리한다.
 *
 * @param viewport Pointer와 Wheel 입력을 받는 Graph Viewport
 * @param world Camera transform을 적용할 Graph World
 * @param graphStateOrInitialState Graph State Store 또는 호환용 초기 Camera 상태
 * @returns Camera 상태, 좌표 변환 및 lifecycle을 관리하는 핸들
 */
export function initializeGraphCamera(
	viewport: HTMLElement,
	world: HTMLElement,
	graphStateOrInitialState: GraphStateStore | GraphCameraState = createGraphState(),
): GraphCamera {
	const graphState = isGraphStateStore(graphStateOrInitialState)
		? graphStateOrInitialState
		: createGraphState({
			camera: graphStateOrInitialState,
			nodePositions: {},
		});
	let panSession: PanSession | undefined;
	let disposed = false;

	/** Camera transform과 Viewport의 World Grid 표시를 함께 갱신한다. */
	const applyTransform = (state: GraphStateSnapshot = graphState.getState()) => {
		const { camera } = state;
		const gridSize = GRAPH_GRID_SIZE * camera.scale;

		world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
		viewport.style.backgroundPosition = `${camera.x}px ${camera.y}px`;
		viewport.style.backgroundSize = `${gridSize}px ${gridSize}px`;
	};

	/** 현재 Camera 상태를 Store snapshot과 분리된 객체로 반환한다. */
	const getState = (): GraphCameraState => ({ ...graphState.getState().camera });

	/** Node 위치를 유지하면서 Camera 값만 Store에 반영한다. */
	const setState = (nextState: GraphCameraState): void => {
		graphState.setState({
			...graphState.getState(),
			camera: nextState,
		});
	};

	/** 현재 Camera transform을 역산해 Viewport 좌표를 World 좌표로 변환한다. */
	const viewportToWorld = (point: GraphPoint): GraphPoint => {
		const state = graphState.getState().camera;

		return {
			x: (point.x - state.x) / state.scale,
			y: (point.y - state.y) / state.scale,
		};
	};

	/** 현재 Camera transform을 적용해 World 좌표를 Viewport 좌표로 변환한다. */
	const worldToViewport = (point: GraphPoint): GraphPoint => {
		const state = graphState.getState().camera;

		return {
			x: point.x * state.scale + state.x,
			y: point.y * state.scale + state.y,
		};
	};

	/** 지정한 Viewport 지점 아래의 World 좌표를 유지하며 Camera scale을 변경한다. */
	const setScaleAt = (scale: number, viewportPoint: GraphPoint): void => {
		const currentCamera = graphState.getState().camera;
		const nextScale = clampScale(scale);

		if (nextScale === currentCamera.scale) {
			return;
		}

		const worldAtPoint = viewportToWorld(viewportPoint);

		setState({
			x: viewportPoint.x - worldAtPoint.x * nextScale,
			y: viewportPoint.y - worldAtPoint.y * nextScale,
			scale: nextScale,
		});
	};

	/** 이벤트 target 또는 조상에 입력 정책 attribute가 있는지 판별한다. */
	const matchesCameraInputPolicy = (event: Event, selector: string): boolean => {
		const target = event.target;

		return isElement(target)
			&& target.closest(selector) !== null;
	};

	/** 완전 차단 또는 Pan-only 차단 영역에서 시작한 Camera Pan을 거부한다. */
	const shouldIgnoreCameraPan = (event: Event): boolean => {
		return matchesCameraInputPolicy(event, GRAPH_CAMERA_IGNORE_SELECTOR)
			|| matchesCameraInputPolicy(event, GRAPH_CAMERA_PAN_IGNORE_SELECTOR);
	};

	/** 완전 차단 영역에서 시작한 Wheel Zoom만 거부한다. */
	const shouldIgnoreCameraZoom = (event: Event): boolean => {
		return matchesCameraInputPolicy(event, GRAPH_CAMERA_IGNORE_SELECTOR);
	};

	/** 진행 중인 Pan을 종료하고 Pointer Capture와 표시 상태를 정리한다. */
	const stopPanning = (pointerId: number, releaseCapture: boolean) => {
		panSession = undefined;
		viewport.classList.remove('is-panning');

		if (releaseCapture && viewport.hasPointerCapture(pointerId)) {
			viewport.releasePointerCapture(pointerId);
		}
	};

	/** 기본 버튼 Pointer 입력으로 Viewport Pan session을 시작한다. */
	const handlePointerDown = (event: PointerEvent) => {
		if (
			disposed
			|| panSession
			|| !event.isPrimary
			|| event.button !== 0
			|| shouldIgnoreCameraPan(event)
		) {
			return;
		}

		event.preventDefault();
		panSession = {
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startCameraX: graphState.getState().camera.x,
			startCameraY: graphState.getState().camera.y,
		};
		viewport.classList.add('is-panning');
		viewport.setPointerCapture(event.pointerId);
	};

	/** 활성 Pointer의 Screen 이동량을 Camera 이동량으로 반영한다. */
	const handlePointerMove = (event: PointerEvent) => {
		if (!panSession || event.pointerId !== panSession.pointerId) {
			return;
		}

		event.preventDefault();
		const currentCamera = graphState.getState().camera;
		setState({
			x: panSession.startCameraX + event.clientX - panSession.startClientX,
			y: panSession.startCameraY + event.clientY - panSession.startClientY,
			scale: currentCamera.scale,
		});
	};

	/** Pointer 종료 또는 취소 시 Camera Pan session을 종료한다. */
	const handlePointerEnd = (event: PointerEvent) => {
		if (!panSession || event.pointerId !== panSession.pointerId) {
			return;
		}

		stopPanning(event.pointerId, true);
	};

	/** 브라우저가 Pointer Capture를 잃었을 때 Pan 표시 상태를 정리한다. */
	const handleLostPointerCapture = (event: PointerEvent) => {
		if (!panSession || event.pointerId !== panSession.pointerId) {
			return;
		}

		stopPanning(event.pointerId, false);
	};

	/** Wheel delta를 정규화해 Cursor 위치 기준 Camera Zoom을 수행한다. */
	const handleWheel = (event: WheelEvent) => {
		if (shouldIgnoreCameraZoom(event)) {
			return;
		}

		event.preventDefault();

		const bounds = viewport.getBoundingClientRect();
		const cursor = {
			x: event.clientX - bounds.left,
			y: event.clientY - bounds.top,
		};
		const wheelDelta = normalizeWheelDelta(event, viewport.clientHeight);
		const currentCamera = graphState.getState().camera;

		setScaleAt(
			currentCamera.scale * Math.exp(-wheelDelta * WHEEL_ZOOM_SENSITIVITY),
			cursor,
		);
	};

	viewport.addEventListener('pointerdown', handlePointerDown);
	viewport.addEventListener('pointermove', handlePointerMove);
	viewport.addEventListener('pointerup', handlePointerEnd);
	viewport.addEventListener('pointercancel', handlePointerEnd);
	viewport.addEventListener('lostpointercapture', handleLostPointerCapture);
	viewport.addEventListener('wheel', handleWheel, { passive: false });
	const unsubscribeState = graphState.subscribe(applyTransform);
	applyTransform();

	return {
		getState,
		setState,
		setScaleAt,
		viewportToWorld,
		worldToViewport,
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			unsubscribeState();
			viewport.removeEventListener('pointerdown', handlePointerDown);
			viewport.removeEventListener('pointermove', handlePointerMove);
			viewport.removeEventListener('pointerup', handlePointerEnd);
			viewport.removeEventListener('pointercancel', handlePointerEnd);
			viewport.removeEventListener('lostpointercapture', handleLostPointerCapture);
			viewport.removeEventListener('wheel', handleWheel);

			if (panSession) {
				stopPanning(panSession.pointerId, true);
			}
		},
	};
}

/** Store 또는 호환용 Camera 초기값인지 판별한다. */
function isGraphStateStore(
	value: GraphStateStore | GraphCameraState,
): value is GraphStateStore {
	return 'getState' in value
		&& 'setState' in value
		&& 'subscribe' in value;
}

/** Camera scale을 Graph State가 지원하는 범위로 제한한다. */
function clampScale(scale: number): number {
	return Math.min(Math.max(scale, MIN_CAMERA_SCALE), MAX_CAMERA_SCALE);
}

/** Wheel deltaMode을 pixel 단위로 정규화한다. */
function normalizeWheelDelta(event: WheelEvent, viewportHeight: number): number {
	switch (event.deltaMode) {
		case 1:
			return event.deltaY * WHEEL_LINE_HEIGHT;
		case 2:
			return event.deltaY * viewportHeight;
		default:
			return event.deltaY;
	}
}

/** EventTarget이 Element의 closest API를 제공하는지 판별한다. */
function isElement(target: EventTarget | null): target is Element {
	return target !== null
		&& typeof (target as Element).closest === 'function';
}
