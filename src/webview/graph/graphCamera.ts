export interface GraphCameraState {
	x: number;
	y: number;
	scale: number;
}

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

export const MIN_CAMERA_SCALE = 0.25;
export const MAX_CAMERA_SCALE = 4;

const INITIAL_CAMERA_STATE: GraphCameraState = {
	x: 0,
	y: 0,
	scale: 1,
};
const WHEEL_ZOOM_SENSITIVITY = 0.002;
const WHEEL_LINE_HEIGHT = 16;
const GRAPH_GRID_SIZE = 20;

interface PanSession {
	pointerId: number;
	startClientX: number;
	startClientY: number;
	startCameraX: number;
	startCameraY: number;
}

/**
 * Graph World의 화면 이동과 확대/축소를 관리한다.
 * 모든 Camera 변경은 이 핸들을 거쳐 graph-world의 transform에 반영된다.
 *
 * @param viewport Pointer와 Wheel 입력을 받는 Graph Viewport
 * @param world Camera transform을 적용할 Graph World
 * @param initialState 선택적인 초기 Camera 상태
 * @returns Camera 상태, 좌표 변환 및 lifecycle을 관리하는 핸들
 */
export function initializeGraphCamera(
	viewport: HTMLElement,
	world: HTMLElement,
	initialState: GraphCameraState = INITIAL_CAMERA_STATE,
): GraphCamera {
	let state: GraphCameraState = normalizeState(initialState);
	let panSession: PanSession | undefined;
	let disposed = false;

	/** Camera transform과 Viewport의 World Grid 표시를 함께 갱신한다. */
	const applyTransform = () => {
		const gridSize = GRAPH_GRID_SIZE * state.scale;

		world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
		viewport.style.backgroundPosition = `${state.x}px ${state.y}px`;
		viewport.style.backgroundSize = `${gridSize}px ${gridSize}px`;
	};

	const getState = (): GraphCameraState => ({ ...state });

	const setState = (nextState: GraphCameraState): void => {
		state = normalizeState(nextState);
		applyTransform();
	};

	const viewportToWorld = (point: GraphPoint): GraphPoint => {
		return {
			x: (point.x - state.x) / state.scale,
			y: (point.y - state.y) / state.scale,
		};
	};

	const worldToViewport = (point: GraphPoint): GraphPoint => {
		return {
			x: point.x * state.scale + state.x,
			y: point.y * state.scale + state.y,
		};
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
		) {
			return;
		}

		event.preventDefault();
		panSession = {
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startClientY: event.clientY,
			startCameraX: state.x,
			startCameraY: state.y,
		};
		viewport.classList.add('is-panning');
		viewport.setPointerCapture(event.pointerId);
	};

	const handlePointerMove = (event: PointerEvent) => {
		if (!panSession || event.pointerId !== panSession.pointerId) {
			return;
		}

		event.preventDefault();
		setState({
			x: panSession.startCameraX + event.clientX - panSession.startClientX,
			y: panSession.startCameraY + event.clientY - panSession.startClientY,
			scale: state.scale,
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
		event.preventDefault();

		const bounds = viewport.getBoundingClientRect();
		const cursor = {
			x: event.clientX - bounds.left,
			y: event.clientY - bounds.top,
		};
		const worldAtCursor = viewportToWorld(cursor);
		const wheelDelta = normalizeWheelDelta(event, viewport.clientHeight);
		const nextScale = clampScale(
			state.scale * Math.exp(-wheelDelta * WHEEL_ZOOM_SENSITIVITY),
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

/** Camera의 scale을 허용 범위로 제한하고 외부 객체와 분리된 상태를 만든다. */
function normalizeState(state: GraphCameraState): GraphCameraState {
	return {
		x: state.x,
		y: state.y,
		scale: clampScale(state.scale),
	};
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
