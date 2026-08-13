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

export interface GraphPoint {
	x: number;
	y: number;
}

export interface GraphCamera {
	getState(): GraphCameraState;
	setState(state: GraphCameraState): void;
	viewportToWorld(point: GraphPoint): GraphPoint;
	worldToViewport(point: GraphPoint): GraphPoint;
	dispose(): void;
}

export const GRAPH_CAMERA_IGNORE_ATTRIBUTE = 'data-graph-camera-ignore';

const WHEEL_ZOOM_SENSITIVITY = 0.002;
const WHEEL_LINE_HEIGHT = 16;
const GRAPH_GRID_SIZE = 20;
const GRAPH_CAMERA_IGNORE_SELECTOR = `[${GRAPH_CAMERA_IGNORE_ATTRIBUTE}]`;

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
		: createGraphState({ camera: graphStateOrInitialState });
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

	const getState = (): GraphCameraState => ({ ...graphState.getState().camera });

	const setState = (nextState: GraphCameraState): void => {
		graphState.setState({
			...graphState.getState(),
			camera: nextState,
		});
	};

	const viewportToWorld = (point: GraphPoint): GraphPoint => {
		const state = graphState.getState().camera;

		return {
			x: (point.x - state.x) / state.scale,
			y: (point.y - state.y) / state.scale,
		};
	};

	const worldToViewport = (point: GraphPoint): GraphPoint => {
		const state = graphState.getState().camera;

		return {
			x: point.x * state.scale + state.x,
			y: point.y * state.scale + state.y,
		};
	};

	const shouldIgnoreCameraInput = (event: Event): boolean => {
		const target = event.target;

		return isElement(target)
			&& target.closest(GRAPH_CAMERA_IGNORE_SELECTOR) !== null;
	};

	/** 진행 중인 Pan을 종료하고 Pointer Capture와 표시 상태를 정리한다. */
	const stopPanning = (pointerId: number, releaseCapture: boolean) => {
		panSession = undefined;
		viewport.classList.remove('is-panning');

		if (releaseCapture && viewport.hasPointerCapture(pointerId)) {
			viewport.releasePointerCapture(pointerId);
		}
	};

	const handlePointerDown = (event: PointerEvent) => {
		if (
			disposed
			|| panSession
			|| !event.isPrimary
			|| event.button !== 0
			|| shouldIgnoreCameraInput(event)
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

	const handlePointerEnd = (event: PointerEvent) => {
		if (!panSession || event.pointerId !== panSession.pointerId) {
			return;
		}

		stopPanning(event.pointerId, true);
	};

	const handleLostPointerCapture = (event: PointerEvent) => {
		if (!panSession || event.pointerId !== panSession.pointerId) {
			return;
		}

		stopPanning(event.pointerId, false);
	};

	const handleWheel = (event: WheelEvent) => {
		if (shouldIgnoreCameraInput(event)) {
			return;
		}

		event.preventDefault();

		const bounds = viewport.getBoundingClientRect();
		const cursor = {
			x: event.clientX - bounds.left,
			y: event.clientY - bounds.top,
		};
		const worldAtCursor = viewportToWorld(cursor);
		const wheelDelta = normalizeWheelDelta(event, viewport.clientHeight);
		const currentCamera = graphState.getState().camera;
		const nextScale = clampScale(
			currentCamera.scale * Math.exp(-wheelDelta * WHEEL_ZOOM_SENSITIVITY),
		);

		setState({
			x: cursor.x - worldAtCursor.x * nextScale,
			y: cursor.y - worldAtCursor.y * nextScale,
			scale: nextScale,
		});
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

function isGraphStateStore(
	value: GraphStateStore | GraphCameraState,
): value is GraphStateStore {
	return 'getState' in value
		&& 'setState' in value
		&& 'subscribe' in value;
}

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

function isElement(target: EventTarget | null): target is Element {
	return target !== null
		&& typeof (target as Element).closest === 'function';
}