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

/** Camera, Node 위치, 파일 그룹 page와 열린 Folder 상태를 포함하는 저장 가능한 Graph 상태다. */
export interface GraphState {
	camera: GraphCameraState;
	nodePositions: Record<string, GraphNodePosition>;
	fileGroupPages?: Record<string, number>;
	openedFolders?: Record<string, true>;
}

/** 외부 mutation을 막기 위해 읽기 전용으로 고정한 Graph 상태 snapshot이다. */
export interface GraphStateSnapshot {
	readonly camera: Readonly<GraphCameraState>;
	readonly nodePositions: Readonly<Record<string, Readonly<GraphNodePosition>>>;
	readonly fileGroupPages: Readonly<Record<string, number>>;
	readonly openedFolders: Readonly<Record<string, true>>;
}

/** Graph 상태가 실제로 변경된 뒤 호출되는 구독 callback이다. */
export type GraphStateSubscriber = (state: GraphStateSnapshot) => void;

/** Graph 상태의 조회, immutable 갱신 및 변경 구독을 제공한다. */
export interface GraphStateStore {
	getState(): GraphStateSnapshot;
	setState(state: GraphState): void;
	isFolderOpened(folderId: string): boolean;
	toggleFolder(folderId: string): void;
	getFileGroupPage(fileGroupId: string): number;
	showMoreFiles(fileGroupId: string): void;
	collapseFileGroup(fileGroupId: string): void;
	subscribe(subscriber: GraphStateSubscriber): () => void;
}

/** 허용하는 최소 Camera 배율이다. */
export const MIN_CAMERA_SCALE = 0.25;
/** 허용하는 최대 Camera 배율이다. */
export const MAX_CAMERA_SCALE = 4;
/** 파일 그룹에서 한 page마다 표시하는 파일 수다. */
export const FILE_GROUP_PAGE_SIZE = 5;

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
	fileGroupPages: Object.freeze({}),
	openedFolders: Object.freeze({}),
});

/** 파일 총 개수와 page로 실제 표시할 파일 개수를 계산한다. */
export function getVisibleFileCount(totalFileCount: number, page: number): number {
	return Math.min(totalFileCount, page * FILE_GROUP_PAGE_SIZE);
}

/** 파일 총 개수와 page로 아직 표시하지 않은 파일 개수를 계산한다. */
export function getRemainingFileCount(totalFileCount: number, page: number): number {
	return Math.max(0, totalFileCount - getVisibleFileCount(totalFileCount, page));
}

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
	const fileGroupPages = parseFileGroupPages(candidate.fileGroupPages);
	const openedFolders = parseOpenedFolders(candidate.openedFolders);

	if (!nodePositions || !fileGroupPages || !openedFolders) {
		return undefined;
	}

	return {
		camera: {
			x: camera.x,
			y: camera.y,
			scale: camera.scale,
		},
		nodePositions,
		fileGroupPages,
		openedFolders,
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
	initialState: GraphState = INITIAL_GRAPH_STATE,
): GraphStateStore {
	let state = createSnapshot(initialState);
	const subscribers = new Set<GraphStateSubscriber>();
	const setState = (nextState: GraphState): void => {
		const nextSnapshot = createSnapshot(nextState, state);

		if (isSameState(state, nextSnapshot)) {
			return;
		}

		state = nextSnapshot;

		for (const subscriber of [...subscribers]) {
			subscriber(state);
		}
	};

	return {
		getState: () => state,
		setState,
		isFolderOpened(folderId): boolean {
			return Object.hasOwn(state.openedFolders, folderId)
				&& state.openedFolders[folderId] === true;
		},
		toggleFolder(folderId): void {
			const openedFolders = { ...state.openedFolders };

			if (Object.hasOwn(openedFolders, folderId)) {
				delete openedFolders[folderId];
			} else {
				openedFolders[folderId] = true;
			}

			setState({
				camera: state.camera,
				nodePositions: state.nodePositions,
				fileGroupPages: state.fileGroupPages,
				openedFolders,
			});
		},
		getFileGroupPage(fileGroupId): number {
			return readFileGroupPage(state.fileGroupPages, fileGroupId);
		},
		showMoreFiles(fileGroupId): void {
			setState({
				camera: state.camera,
				nodePositions: state.nodePositions,
				openedFolders: state.openedFolders,
				fileGroupPages: {
					...state.fileGroupPages,
					[fileGroupId]: readFileGroupPage(
						state.fileGroupPages,
						fileGroupId,
					) + 1,
				},
			});
		},
		collapseFileGroup(fileGroupId): void {
			setState({
				camera: state.camera,
				nodePositions: state.nodePositions,
				openedFolders: state.openedFolders,
				fileGroupPages: {
					...state.fileGroupPages,
					[fileGroupId]: 1,
				},
			});
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
	state: GraphState,
	previousState?: GraphStateSnapshot,
): GraphStateSnapshot {
	const nodePositions = previousState
		&& areSameNodePositions(previousState.nodePositions, state.nodePositions)
		? previousState.nodePositions
		: createNodePositionsSnapshot(state.nodePositions);
	const sourceFileGroupPages = state.fileGroupPages
		?? previousState?.fileGroupPages
		?? INITIAL_GRAPH_STATE.fileGroupPages;
	const fileGroupPages = previousState
		&& areSameFileGroupPages(previousState.fileGroupPages, sourceFileGroupPages)
		? previousState.fileGroupPages
		: Object.freeze({ ...sourceFileGroupPages });
	const sourceOpenedFolders = state.openedFolders
		?? previousState?.openedFolders
		?? INITIAL_GRAPH_STATE.openedFolders;
	const openedFolders = previousState
		&& areSameOpenedFolders(
			previousState.openedFolders,
			sourceOpenedFolders,
		)
		? previousState.openedFolders
		: Object.freeze({ ...sourceOpenedFolders });

	return Object.freeze({
		camera: Object.freeze({
			x: state.camera.x,
			y: state.camera.y,
			scale: clampCameraScale(state.camera.scale),
		}),
		nodePositions,
		fileGroupPages,
		openedFolders,
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
		)
		&& areSameFileGroupPages(
			currentState.fileGroupPages,
			nextState.fileGroupPages,
		)
		&& areSameOpenedFolders(
			currentState.openedFolders,
			nextState.openedFolders,
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
 * 파일 그룹 page 복원 후보를 검증하고 복사한다.
 * 이전 저장 상태에는 이 필드가 없으므로 빈 Map으로 호환 복원한다.
 */
function parseFileGroupPages(value: unknown): Record<string, number> | undefined {
	if (value === undefined) {
		return {};
	}

	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const entries: Array<[string, number]> = [];

	for (const [id, page] of Object.entries(value)) {
		if (!id || !isFileGroupPage(page)) {
			return undefined;
		}

		entries.push([id, page]);
	}

	return Object.fromEntries(entries);
}

/**
 * 열린 Folder 상태 복원 후보를 sparse Map으로 검증하고 복사한다.
 * 필드가 없으면 모든 Folder가 닫힌 빈 Map으로 복원한다.
 */
function parseOpenedFolders(value: unknown): Record<string, true> | undefined {
	if (value === undefined) {
		return {};
	}

	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const entries: Array<[string, true]> = [];

	for (const [id, opened] of Object.entries(value)) {
		if (!id || opened !== true) {
			return undefined;
		}

		entries.push([id, true]);
	}

	return Object.fromEntries(entries);
}

/** 파일 그룹 page Map에서 유효한 자체 속성만 읽고 나머지는 기본 page로 처리한다. */
function readFileGroupPage(
	fileGroupPages: GraphStateSnapshot['fileGroupPages'],
	fileGroupId: string,
): number {
	const page = fileGroupPages[fileGroupId] as unknown;

	return Object.hasOwn(fileGroupPages, fileGroupId) && isFileGroupPage(page)
		? page
		: 1;
}

/** 값이 1 이상의 정수 page인지 판별한다. */
function isFileGroupPage(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1;
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

/** 두 파일 그룹 page Map의 ID와 page 값이 같은지 판별한다. */
function areSameFileGroupPages(
	currentPages: GraphStateSnapshot['fileGroupPages'],
	nextPages: GraphStateSnapshot['fileGroupPages'],
): boolean {
	if (currentPages === nextPages) {
		return true;
	}

	const currentIds = Object.keys(currentPages);
	const nextIds = Object.keys(nextPages);

	return currentIds.length === nextIds.length
		&& currentIds.every((id) => currentPages[id] === nextPages[id]);
}

/** 두 열린 Folder Map에 같은 ID가 저장되어 있는지 판별한다. */
function areSameOpenedFolders(
	currentFolders: GraphStateSnapshot['openedFolders'],
	nextFolders: GraphStateSnapshot['openedFolders'],
): boolean {
	if (currentFolders === nextFolders) {
		return true;
	}

	const currentIds = Object.keys(currentFolders);
	const nextIds = Object.keys(nextFolders);

	return currentIds.length === nextIds.length
		&& currentIds.every((id) => nextFolders[id] === true);
}
