/** 현재 해석할 수 있는 Task Blueprint 형식 버전이다. */
export const TASK_BLUEPRINT_VERSION = 1;

/** Task 전체를 Graph World에 배치하는 기준 좌표다. */
export interface TaskOrigin {
	readonly x: number;
	readonly y: number;
}

/** Start origin을 기준으로 한 Work/End의 task-local 좌표다. */
export interface TaskNodePosition {
	readonly x: number;
	readonly y: number;
}

/** Start와 수평으로 떨어지고 수직 정렬된 기본 End의 task-local 위치다. */
export const TASK_DEFAULT_END_POSITION: TaskNodePosition = Object.freeze({
	x: 640,
	y: 0,
});

/** 빈 Scope Area를 포함한 Work visual group 사이의 기본 lane 간격이다. */
export const TASK_DEFAULT_WORK_VERTICAL_STRIDE = 376;

/** 모든 Task Node가 공통으로 가지는 식별 정보다. */
interface TaskNodeBase {
	readonly id: string;
}

/** TaskBlueprint의 제목과 설명을 대표하는 유일한 시작점이다. */
export interface StartNode extends TaskNodeBase {
	readonly kind: 'start';
}

/** 실제 작업 지시와 표시 정보를 가지는 Task 단계다. */
export interface WorkGraphTargets {
	/** Work가 의미상 읽기 대상으로 참고하는 Workspace Graph Source ID다. */
	readonly reference: readonly string[];
	/** Work가 의미상 수정 대상으로 사용하는 Workspace Graph Source ID다. */
	readonly work: readonly string[];
}

/** 실제 작업 지시와 표시 정보 및 Workspace Graph 범위를 가지는 Task 단계다. */
export interface WorkNode extends TaskNodeBase {
	readonly kind: 'work';
	readonly title: string;
	readonly description: string;
	readonly prompt: string;
	readonly graphTargets: WorkGraphTargets;
}

/** Task의 유일한 종료점이다. */
export interface EndNode extends TaskNodeBase {
	readonly kind: 'end';
}

/** kind로 시작, 작업, 종료 역할을 구분하는 Task Node다. */
export type TaskNode = StartNode | WorkNode | EndNode;

/** Task Node 사이의 단방향 연결이다. */
export interface TaskEdge {
	readonly id: string;
	readonly source: string;
	readonly target: string;
}

/** 하나의 Task와 그 내부 DAG를 표현하는 최소 도메인 모델이다. */
export interface TaskBlueprint {
	readonly version: typeof TASK_BLUEPRINT_VERSION;
	readonly id: string;
	readonly title: string;
	readonly description: string;
	readonly origin: TaskOrigin;
	/** Work와 End의 명시적 task-local 위치다. Start는 origin을 사용한다. */
	readonly nodePositions: Readonly<Record<string, TaskNodePosition>>;
	readonly nodes: readonly TaskNode[];
	readonly edges: readonly TaskEdge[];
}

/** 기본 Blueprint의 Work Node에 넣을 선택적 초기 값이다. */
export interface CreateWorkNodeInput {
	readonly title?: string;
	readonly description?: string;
	readonly prompt?: string;
}

/** Start와 End만 가진 기본 Blueprint 생성 입력이다. */
export interface CreateTaskBlueprintInput {
	readonly title: string;
	readonly description?: string;
	readonly origin?: TaskOrigin;
}

/** 테스트에서 결정적인 ID를 주입할 수 있는 ID suffix 생성 함수다. */
export type TaskIdSource = () => string;

/** Task ID를 `task:<unique-id>` 형식으로 생성한다. */
export function createTaskId(
	createId: TaskIdSource = createUniqueId,
): string {
	return `task:${createId()}`;
}

/** Task Node ID를 `task-node:<unique-id>` 형식으로 생성한다. */
export function createTaskNodeId(
	createId: TaskIdSource = createUniqueId,
): string {
	return `task-node:${createId()}`;
}

/** Task Edge ID를 `task-edge:<unique-id>` 형식으로 생성한다. */
export function createTaskEdgeId(
	createId: TaskIdSource = createUniqueId,
): string {
	return `task-edge:${createId()}`;
}

/**
 * Work 연결을 시작할 Start와 End만 가진 Task Blueprint를 생성한다.
 * Start는 Task 제목과 설명을 중복하지 않고 Blueprint 자체를 대표한다.
 *
 * @param input Task 표시 정보와 Start world origin
 * @param createId ID suffix 생성 함수
 * @returns 서로 다른 ID의 Start/End를 가진 incomplete Task Blueprint
 */
export function createDefaultTaskBlueprint(
	input: CreateTaskBlueprintInput,
	createId: TaskIdSource = createUniqueId,
): TaskBlueprint {
	const taskId = createTaskId(createId);
	const startNode: StartNode = {
		id: createTaskNodeId(createId),
		kind: 'start',
	};
	const endNode: EndNode = {
		id: createTaskNodeId(createId),
		kind: 'end',
	};

	return {
		version: TASK_BLUEPRINT_VERSION,
		id: taskId,
		title: input.title,
		description: input.description ?? '',
		origin: {
			x: input.origin?.x ?? 0,
			y: input.origin?.y ?? 0,
		},
		nodePositions: {
			[endNode.id]: TASK_DEFAULT_END_POSITION,
		},
		nodes: [startNode, endNode],
		edges: [],
	};
}

/** Browser와 Extension Host에서 공통으로 사용할 UUID를 생성한다. */
function createUniqueId(): string {
	return globalThis.crypto.randomUUID();
}
