import {
	createDefaultTaskBlueprint,
	type CreateTaskBlueprintInput,
	type TaskBlueprint,
	type TaskEdge,
	type TaskIdSource,
	type TaskNode,
} from './taskModel';
import { assertValidTaskBlueprint } from './taskValidation';

/** Task 도메인 상태가 외부에 제공하는 immutable snapshot이다. */
export interface TaskStateSnapshot {
	readonly tasks: readonly TaskBlueprint[];
}

/** 기존 Task를 기반으로 다음 immutable Blueprint를 만드는 갱신 함수다. */
export type TaskBlueprintUpdater = (
	current: TaskBlueprint,
) => TaskBlueprint;

/** Task 생성, 조회, 갱신에 필요한 최소 상태 경계다. */
export interface TaskStateStore {
	/** 현재 Task 목록의 immutable snapshot을 반환한다. */
	getSnapshot(): TaskStateSnapshot;
	/** 외부에서 전달된 검증된 Task 목록으로 현재 snapshot을 교체한다. */
	replaceTasks(tasks: readonly TaskBlueprint[]): TaskStateSnapshot;

	/** ID가 일치하는 Task를 반환하며 없으면 undefined를 반환한다. */
	getTask(taskId: string): TaskBlueprint | undefined;

	/** 기본 Start → Work → End Task를 생성해 상태에 추가한다. */
	createTask(input: CreateTaskBlueprintInput): TaskBlueprint;

	/**
	 * 기존 Task를 갱신하고 검증된 snapshot을 반환한다.
	 * 없는 Task ID이면 undefined를 반환한다.
	 */
	updateTask(
		taskId: string,
		update: TaskBlueprintUpdater,
	): TaskBlueprint | undefined;
}

/**
 * GraphState와 분리된 Task 상태를 생성한다.
 * 초기 Task와 모든 갱신은 validation을 통과한 독립 snapshot으로 보관한다.
 *
 * @param initialTasks 선택적인 초기 Task 목록
 * @param createId 테스트에서 주입할 수 있는 ID suffix 생성 함수
 * @returns Task 생성, 조회, 갱신 API
 */
export function createTaskState(
	initialTasks: readonly TaskBlueprint[] = [],
	createId?: TaskIdSource,
): TaskStateStore {
	assertUniqueTaskIds(initialTasks);
	let snapshot = createStateSnapshot(initialTasks);

	return {
		getSnapshot: () => snapshot,

		replaceTasks(tasks): TaskStateSnapshot {
			assertUniqueTaskIds(tasks);
			snapshot = createStateSnapshot(tasks);
			return snapshot;
		},

		getTask(taskId): TaskBlueprint | undefined {
			return snapshot.tasks.find((task) => task.id === taskId);
		},

		createTask(input): TaskBlueprint {
			const task = createTaskSnapshot(
				createDefaultTaskBlueprint(input, createId),
			);

			if (snapshot.tasks.some((current) => current.id === task.id)) {
				throw new Error(`Task ID must be unique: ${task.id}.`);
			}

			snapshot = Object.freeze({
				tasks: Object.freeze([...snapshot.tasks, task]),
			});
			return task;
		},

		updateTask(taskId, update): TaskBlueprint | undefined {
			const taskIndex = snapshot.tasks.findIndex((task) => task.id === taskId);
			if (taskIndex < 0) {
				return undefined;
			}

			const currentTask = snapshot.tasks[taskIndex];
			const updatedTask = update(currentTask);
			if (updatedTask.id !== taskId) {
				throw new Error('Task update must preserve its ID.');
			}

			const task = createTaskSnapshot(updatedTask);
			const tasks = [...snapshot.tasks];
			tasks[taskIndex] = task;
			snapshot = Object.freeze({ tasks: Object.freeze(tasks) });
			return task;
		},
	};
}

/** 초기 상태의 Task ID 충돌을 거부한다. */
function assertUniqueTaskIds(tasks: readonly TaskBlueprint[]): void {
	const taskIds = new Set<string>();

	for (const task of tasks) {
		if (taskIds.has(task.id)) {
			throw new Error(`Task ID must be unique: ${task.id}.`);
		}
		taskIds.add(task.id);
	}
}

/** 입력 목록과 참조를 공유하지 않는 Task 상태 snapshot을 생성한다. */
function createStateSnapshot(
	tasks: readonly TaskBlueprint[],
): TaskStateSnapshot {
	return Object.freeze({
		tasks: Object.freeze(tasks.map(createTaskSnapshot)),
	});
}

/** Task 전체를 검증하고 중첩 값까지 복사해 고정한다. */
function createTaskSnapshot(task: TaskBlueprint): TaskBlueprint {
	assertValidTaskBlueprint(task);

	return Object.freeze({
		version: task.version,
		id: task.id,
		title: task.title,
		description: task.description,
		origin: Object.freeze({ x: task.origin.x, y: task.origin.y }),
		nodes: Object.freeze(task.nodes.map(createNodeSnapshot)),
		edges: Object.freeze(task.edges.map(createEdgeSnapshot)),
	});
}

/** kind별 필드만 복사해 Task Node snapshot을 생성한다. */
function createNodeSnapshot(node: TaskNode): TaskNode {
	if (node.kind === 'work') {
		return Object.freeze({
			id: node.id,
			kind: node.kind,
			title: node.title,
			description: node.description,
			prompt: node.prompt,
		});
	}

	return Object.freeze({ id: node.id, kind: node.kind });
}

/** Task Edge를 입력 객체와 분리된 snapshot으로 복사한다. */
function createEdgeSnapshot(edge: TaskEdge): TaskEdge {
	return Object.freeze({
		id: edge.id,
		source: edge.source,
		target: edge.target,
	});
}
