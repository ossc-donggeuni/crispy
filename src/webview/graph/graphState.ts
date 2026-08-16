/** Graph World를 Viewport에 투영하는 Camera 이동 및 배율 상태다. */
export interface GraphCameraState {
	x: number;
	y: number;
	scale: number;
}

/** 사용자가 이동한 Graph Node의 World 좌표 override다. */
export interface GraphNodePosition {
	x: number;
	y: number;
}

/** Camera와 사용자가 이동한 Node 위치만 포함하는 저장 가능한 Graph 상태다. */
export interface GraphState {
	camera: GraphCameraState;
	nodePositions: Record<string, GraphNodePosition>;
}

/** 외부 mutation을 막기 위해 읽기 전용으로 고정한 Graph 상태 snapshot이다. */
export interface GraphStateSnapshot {
	readonly camera: Readonly<GraphCameraState>;
	readonly nodePositions: Readonly<Record<string, Readonly<GraphNodePosition>>>;
}

/** Graph 상태가 실제로 변경된 뒤 호출되는 구독 callback이다. */
export type GraphStateSubscriber = (state: GraphStateSnapshot) => void;

/** Graph 상태의 조회, immutable 갱신 및 변경 구독을 제공한다. */
export interface GraphStateStore {
	getState(): GraphStateSnapshot;
	setState(state: GraphState): void;
	subscribe(subscriber: GraphStateSubscriber): () => void;
}

/** 허용하는 최소 Camera 배율이다. */
export const MIN_CAMERA_SCALE = 0.25;
/** 허용하는 최대 Camera 배율이다. */
export const MAX_CAMERA_SCALE = 4;

/** 새 Graph View에 적용하는 기본 Camera 상태다. */
export const INITIAL_GRAPH_CAMERA_STATE: Readonly<GraphCameraState> = Object.freeze({
	x: 0,
	y: 0,
	scale: 1,
});

/** 저장 상태가 없을 때 사용하는 기본 Graph 상태다. */
export const INITIAL_GRAPH_STATE: GraphStateSnapshot = Object.freeze({
	camera: INITIAL_GRAPH_CAMERA_STATE,
	nodePositions: Object.freeze({}),
});

/**
 * 복원 후보에서 유효한 Graph 상태 필드만 복사한다.
 *
 * @param value Graph 상태 후보
 * @returns 검증 및 복사된 Graph 상태이며, 값이 잘못되었으면 undefined
 */
export function parseGraphState(value: unknown): GraphState | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;

	if (!candidate.camera || typeof candidate.camera !== 'object') {
		return undefined;
	}

	const camera = candidate.camera as Record<string, unknown>;

	if (
		!isFiniteNumber(camera.x)
		|| !isFiniteNumber(camera.y)
		|| !isFiniteNumber(camera.scale)
		|| camera.scale < MIN_CAMERA_SCALE
		|| camera.scale > MAX_CAMERA_SCALE
	) {
		return undefined;
	}

	const nodePositions = parseNodePositions(candidate.nodePositions);

	if (!nodePositions) {
		return undefined;
	}

	return {
		camera: {
			x: camera.x,
			y: camera.y,
			scale: camera.scale,
		},
		nodePositions,
	};
}

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
			const nextSnapshot = createSnapshot(nextState, state);

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

/**
 * 외부 객체를 참조하지 않는 읽기 전용 Graph 상태 snapshot을 생성한다.
 * 동일한 Node 위치 객체는 O(1)로 재사용하고, 다른 객체도 좌표 값이 같으면
 * 이전 frozen 객체 참조를 재사용한다.
 *
 * @param state snapshot으로 만들 Graph 상태
 * @param previousState 참조를 재사용할 수 있는 이전 snapshot
 * @returns Camera scale이 보정되고 중첩 값까지 고정된 snapshot
 */
function createSnapshot(
	state: GraphStateSnapshot,
	previousState?: GraphStateSnapshot,
): GraphStateSnapshot {
	const nodePositions = previousState
		&& areSameNodePositions(previousState.nodePositions, state.nodePositions)
		? previousState.nodePositions
		: createNodePositionsSnapshot(state.nodePositions);

	return Object.freeze({
		camera: Object.freeze({
			x: state.camera.x,
			y: state.camera.y,
			scale: clampCameraScale(state.camera.scale),
		}),
		nodePositions,
	});
}

/** 모든 Node 위치 값을 외부 입력과 분리하고 중첩 객체까지 고정한다. */
function createNodePositionsSnapshot(
	nodePositions: GraphStateSnapshot['nodePositions'],
): GraphStateSnapshot['nodePositions'] {
	return Object.freeze(Object.fromEntries(
		Object.entries(nodePositions).map(([id, position]) => [
			id,
			Object.freeze({ x: position.x, y: position.y }),
		]),
	));
}

/** Camera 값과 Node 위치 값이 모두 같은지 판별한다. */
function isSameState(
	currentState: GraphStateSnapshot,
	nextState: GraphStateSnapshot,
): boolean {
	return currentState.camera.x === nextState.camera.x
		&& currentState.camera.y === nextState.camera.y
		&& currentState.camera.scale === nextState.camera.scale
		&& areSameNodePositions(
			currentState.nodePositions,
			nextState.nodePositions,
		);
}

/** Camera scale을 지원 범위로 제한한다. */
function clampCameraScale(scale: number): number {
	return Math.min(Math.max(scale, MIN_CAMERA_SCALE), MAX_CAMERA_SCALE);
}

/** 값이 유한한 number인지 판별한다. */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Node 위치 복원 후보를 검증하고 복사한다.
 * 이전 Camera 전용 snapshot에는 위치가 없으므로 빈 override로 호환 복원한다.
 */
function parseNodePositions(
	value: unknown,
): Record<string, GraphNodePosition> | undefined {
	if (value === undefined) {
		return {};
	}

	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const entries: Array<[string, GraphNodePosition]> = [];

	for (const [id, position] of Object.entries(value)) {
		if (
			!id
			|| !position
			|| typeof position !== 'object'
			|| Array.isArray(position)
		) {
			return undefined;
		}

		const candidate = position as Record<string, unknown>;

		if (!isFiniteNumber(candidate.x) || !isFiniteNumber(candidate.y)) {
			return undefined;
		}

		entries.push([id, { x: candidate.x, y: candidate.y }]);
	}

	return Object.fromEntries(entries);
}

/**
 * 두 Node 위치 Map의 ID와 World 좌표 값이 같은지 판별한다.
 * 같은 객체 참조는 Camera Pan/Zoom 경로에서 순회하지 않고 즉시 반환한다.
 */
function areSameNodePositions(
	currentPositions: GraphStateSnapshot['nodePositions'],
	nextPositions: GraphStateSnapshot['nodePositions'],
): boolean {
	if (currentPositions === nextPositions) {
		return true;
	}

	const currentIds = Object.keys(currentPositions);
	const nextIds = Object.keys(nextPositions);

	if (currentIds.length !== nextIds.length) {
		return false;
	}

	return currentIds.every((id) => {
		const current = currentPositions[id];
		const next = nextPositions[id];

		return current !== undefined
			&& next !== undefined
			&& current.x === next.x
			&& current.y === next.y;
	});
}
