export interface GraphCameraState {
	x: number;
	y: number;
	scale: number;
}

export interface GraphState {
	camera: GraphCameraState;
}

export interface GraphStateSnapshot {
	readonly camera: Readonly<GraphCameraState>;
}

export type GraphStateSubscriber = (state: GraphStateSnapshot) => void;

export interface GraphStateStore {
	getState(): GraphStateSnapshot;
	setState(state: GraphState): void;
	subscribe(subscriber: GraphStateSubscriber): () => void;
}

export const MIN_CAMERA_SCALE = 0.25;
export const MAX_CAMERA_SCALE = 4;

export const INITIAL_GRAPH_CAMERA_STATE: Readonly<GraphCameraState> = Object.freeze({
	x: 0,
	y: 0,
	scale: 1,
});

export const INITIAL_GRAPH_STATE: GraphStateSnapshot = Object.freeze({
	camera: INITIAL_GRAPH_CAMERA_STATE,
});

/**
 * Graph 전체 상태의 immutable snapshot을 관리한다.
 * Store에 전달된 객체와 외부에 반환하는 상태를 분리해 직접 mutation을 방지한다.
 *
 * @param initialState 선택적인 초기 Graph 상태
 * @returns Graph 상태 조회, 변경 및 구독을 제공하는 Store
 */
export function createGraphState(
	initialState: GraphStateSnapshot = INITIAL_GRAPH_STATE,
): GraphStateStore {
	let state = createSnapshot(initialState);
	const subscribers = new Set<GraphStateSubscriber>();

	return {
		getState: () => state,
		setState(nextState): void {
			const nextSnapshot = createSnapshot(nextState);

			if (isSameState(state, nextSnapshot)) {
				return;
			}

			state = nextSnapshot;

			for (const subscriber of [...subscribers]) {
				subscriber(state);
			}
		},
		subscribe(subscriber): () => void {
			subscribers.add(subscriber);

			return () => {
				subscribers.delete(subscriber);
			};
		},
	};
}

/** 외부 객체를 참조하지 않는 읽기 전용 Graph 상태 snapshot을 생성한다. */
function createSnapshot(state: GraphStateSnapshot): GraphStateSnapshot {
	return Object.freeze({
		camera: Object.freeze({
			x: state.camera.x,
			y: state.camera.y,
			scale: clampCameraScale(state.camera.scale),
		}),
	});
}

function isSameState(
	currentState: GraphStateSnapshot,
	nextState: GraphStateSnapshot,
): boolean {
	return currentState.camera.x === nextState.camera.x
		&& currentState.camera.y === nextState.camera.y
		&& currentState.camera.scale === nextState.camera.scale;
}

function clampCameraScale(scale: number): number {
	return Math.min(Math.max(scale, MIN_CAMERA_SCALE), MAX_CAMERA_SCALE);
}
