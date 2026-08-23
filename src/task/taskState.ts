import {
	createDefaultTaskBlueprint,
	createTaskEdgeId,
	createTaskNodeId,
	type CreateTaskBlueprintInput,
	type CreateWorkNodeInput,
	type TaskBlueprint,
	type TaskEdge,
	type TaskIdSource,
	type TaskNode,
	type WorkNode,
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

	/** 선택 Edge를 새 Work 앞뒤의 두 Edge로 치환한다. */
	insertWorkBetween(
		taskId: string,
		edgeId: string,
		work?: CreateWorkNodeInput,
	): TaskBlueprint | undefined;

	/** 명확한 A → B → C 체인 구간의 B와 병렬인 Work를 추가한다. */
	addParallelWork(
		taskId: string,
		edgeId: string,
		work?: CreateWorkNodeInput,
	): TaskBlueprint | undefined;

	/** Work를 제거하고 predecessor와 successor 사이의 유효한 연결을 복구한다. */
	removeWork(taskId: string, nodeId: string): TaskBlueprint | undefined;

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
	const commitTask = (
		taskId: string,
		createUpdatedTask: (current: TaskBlueprint) => TaskBlueprint | undefined,
	): TaskBlueprint | undefined => {
		const taskIndex = snapshot.tasks.findIndex((task) => task.id === taskId);
		if (taskIndex < 0) {
			return undefined;
		}

		const currentTask = snapshot.tasks[taskIndex];
		const updatedTask = createUpdatedTask(currentTask);
		if (!updatedTask) {
			return undefined;
		}
		if (updatedTask.id !== taskId) {
			throw new Error('Task update must preserve its ID.');
		}

		const task = createTaskSnapshot(updatedTask);
		const tasks = [...snapshot.tasks];
		tasks[taskIndex] = task;
		snapshot = Object.freeze({ tasks: Object.freeze(tasks) });
		return task;
	};

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

		insertWorkBetween(taskId, edgeId, work): TaskBlueprint | undefined {
			return commitTask(taskId, (task) => insertWorkBetweenEdge(
				task,
				edgeId,
				work,
				createId,
			));
		},

		addParallelWork(taskId, edgeId, work): TaskBlueprint | undefined {
			return commitTask(taskId, (task) => addParallelWorkAtEdge(
				task,
				edgeId,
				work,
				createId,
			));
		},

		removeWork(taskId, nodeId): TaskBlueprint | undefined {
			return commitTask(taskId, (task) => removeWorkNode(
				task,
				nodeId,
				createId,
			));
		},

		updateTask(taskId, update): TaskBlueprint | undefined {
			return commitTask(taskId, update);
		},
	};
}

/** Work 입력을 동일한 기본 문구와 기존 Node ID 생성기로 구체화한다. */
function createWorkNode(
	work: CreateWorkNodeInput | undefined,
	createId: TaskIdSource | undefined,
): WorkNode {
	return {
		id: createTaskNodeId(createId),
		kind: 'work',
		title: work?.title ?? 'New Work',
		description: work?.description ?? '',
		prompt: work?.prompt ?? '',
	};
}

/** A → B를 A → N → B로 치환하는 최소 immutable 편집이다. */
function insertWorkBetweenEdge(
	task: TaskBlueprint,
	edgeId: string,
	work: CreateWorkNodeInput | undefined,
	createId: TaskIdSource | undefined,
): TaskBlueprint | undefined {
	const edge = task.edges.find((candidate) => candidate.id === edgeId);
	if (!edge) {
		return undefined;
	}

	const node = createWorkNode(work, createId);
	return {
		...task,
		nodes: [...task.nodes, node],
		edges: [
			...task.edges.filter((candidate) => candidate.id !== edgeId),
			createEdge(edge.source, node.id, createId),
			createEdge(node.id, edge.target, createId),
		],
	};
}

interface SimpleParallelWorkSegment {
	readonly incoming: TaskEdge;
	readonly outgoing: TaskEdge;
}

/** A → B → C가 다른 Branch/Join과 겹치지 않는 단일 체인 구간인지 판별한다. */
export function canAddParallelWorkAtEdge(
	task: TaskBlueprint,
	edgeId: string,
): boolean {
	return resolveSimpleParallelWorkSegment(task, edgeId) !== undefined;
}

/** 선택 Edge target Work가 속한 예측 가능한 A → B → C 구간을 반환한다. */
function resolveSimpleParallelWorkSegment(
	task: TaskBlueprint,
	edgeId: string,
): SimpleParallelWorkSegment | undefined {
	const incoming = task.edges.find((candidate) => candidate.id === edgeId);
	if (!incoming) {
		return undefined;
	}

	const target = task.nodes.find((node) => node.id === incoming.target);
	const targetIncoming = task.edges.filter((edge) => edge.target === incoming.target);
	const targetOutgoing = task.edges.filter((edge) => edge.source === incoming.target);
	if (
		target?.kind !== 'work'
		|| targetIncoming.length !== 1
		|| targetOutgoing.length !== 1
	) {
		return undefined;
	}

	const outgoing = targetOutgoing[0];
	if (!outgoing) {
		return undefined;
	}

	const predecessorOutgoing = task.edges.filter(
		(edge) => edge.source === incoming.source,
	);
	const successorIncoming = task.edges.filter(
		(edge) => edge.target === outgoing.target,
	);

	return predecessorOutgoing.length === 1 && successorIncoming.length === 1
		? { incoming, outgoing }
		: undefined;
}

/** 명확한 A → B → C 구간에 A → N → C sibling Branch를 추가한다. */
function addParallelWorkAtEdge(
	task: TaskBlueprint,
	edgeId: string,
	work: CreateWorkNodeInput | undefined,
	createId: TaskIdSource | undefined,
): TaskBlueprint | undefined {
	const segment = resolveSimpleParallelWorkSegment(task, edgeId);
	if (!segment) {
		return undefined;
	}

	const node = createWorkNode(work, createId);
	return {
		...task,
		nodes: [...task.nodes, node],
		edges: [
			...task.edges,
			createEdge(segment.incoming.source, node.id, createId),
			createEdge(node.id, segment.outgoing.target, createId),
		],
	};
}

/** Work 제거 뒤 predecessor×successor bridge를 중복 없이 추가한다. */
function removeWorkNode(
	task: TaskBlueprint,
	nodeId: string,
	createId: TaskIdSource | undefined,
): TaskBlueprint | undefined {
	const node = task.nodes.find((candidate) => candidate.id === nodeId);
	if (node?.kind !== 'work') {
		return undefined;
	}

	const predecessors = new Set(task.edges
		.filter((edge) => edge.target === nodeId)
		.map((edge) => edge.source));
	const successors = new Set(task.edges
		.filter((edge) => edge.source === nodeId)
		.map((edge) => edge.target));
	const edges = task.edges.filter((edge) => (
		edge.source !== nodeId && edge.target !== nodeId
	));
	const connections = new Set(edges.map((edge) => (
		createEdgeConnectionKey(edge.source, edge.target)
	)));

	for (const predecessorId of predecessors) {
		for (const successorId of successors) {
			const connectionKey = createEdgeConnectionKey(
				predecessorId,
				successorId,
			);

			if (!connections.has(connectionKey)) {
				edges.push(createEdge(predecessorId, successorId, createId));
				connections.add(connectionKey);
			}
		}
	}

	return {
		...task,
		nodes: task.nodes.filter((candidate) => candidate.id !== nodeId),
		edges,
	};
}

function createEdge(
	sourceId: string,
	targetId: string,
	createId: TaskIdSource | undefined,
): TaskEdge {
	return {
		id: createTaskEdgeId(createId),
		source: sourceId,
		target: targetId,
	};
}

function createEdgeConnectionKey(sourceId: string, targetId: string): string {
	return JSON.stringify([sourceId, targetId]);
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
