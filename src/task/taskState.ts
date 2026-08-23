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
	type TaskNodeOffset,
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

	/** 선택한 A → B → C Work lane과 같은 sibling Work를 추가한다. */
	addParallelWork(
		taskId: string,
		edgeId: string,
		work?: CreateWorkNodeInput,
	): TaskBlueprint | undefined;

	/** 단일 predecessor/successor Work를 제거하고 필요한 직렬 연결만 복구한다. */
	removeWork(taskId: string, nodeId: string): TaskBlueprint | undefined;

	/** Work/End의 task-local 수동 offset을 설정하거나 제거한다. */
	setNodeOffset(
		taskId: string,
		nodeId: string,
		offset: TaskNodeOffset | undefined,
	): TaskBlueprint | undefined;

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

		setNodeOffset(taskId, nodeId, offset): TaskBlueprint | undefined {
			return commitTask(taskId, (task) => setTaskNodeOffset(
				task,
				nodeId,
				offset,
			));
		},

		updateTask(taskId, update): TaskBlueprint | undefined {
			return commitTask(taskId, update);
		},
	};
}

/** Work/End의 absolute manual offset을 저장하며 undefined는 제거한다. */
function setTaskNodeOffset(
	task: TaskBlueprint,
	nodeId: string,
	offset: TaskNodeOffset | undefined,
): TaskBlueprint | undefined {
	const node = task.nodes.find((candidate) => candidate.id === nodeId);
	if (
		!node
		|| node.kind === 'start'
		|| (offset !== undefined && (
			!Number.isFinite(offset.x) || !Number.isFinite(offset.y)
		))
	) {
		return undefined;
	}

	const nodeOffsets = { ...task.nodeOffsets };
	if (!offset) {
		delete nodeOffsets[nodeId];
	} else {
		nodeOffsets[nodeId] = { x: offset.x, y: offset.y };
	}

	return {
		...task,
		nodeOffsets: Object.keys(nodeOffsets).length > 0 ? nodeOffsets : undefined,
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
		edges: task.edges.flatMap((candidate) => candidate.id === edgeId
			? [
				createEdge(edge.source, node.id, createId),
				createEdge(node.id, edge.target, createId),
			]
			: [candidate]),
	};
}

interface WorkLaneSegment {
	readonly incoming: TaskEdge;
	readonly outgoing: TaskEdge;
}

/** 선택 Edge target이 정확히 하나의 predecessor/successor를 가진 Work인지 판별한다. */
export function canAddParallelWorkAtEdge(
	task: TaskBlueprint,
	edgeId: string,
): boolean {
	return resolveParallelWorkLane(task, edgeId) !== undefined;
}

/** 삭제 의미가 명확한 단일 predecessor/successor Work인지 판별한다. */
export function canRemoveWorkNode(task: TaskBlueprint, nodeId: string): boolean {
	return resolveWorkLane(task, nodeId) !== undefined;
}

/** 선택 Edge가 target Work의 유일한 incoming인 A → B → C lane을 반환한다. */
function resolveParallelWorkLane(
	task: TaskBlueprint,
	edgeId: string,
): WorkLaneSegment | undefined {
	const incoming = task.edges.find((candidate) => candidate.id === edgeId);
	if (!incoming) {
		return undefined;
	}
	const lane = resolveWorkLane(task, incoming.target);

	return lane?.incoming.id === edgeId ? lane : undefined;
}

/** Work가 속한 정확한 A → B → C 단일 lane을 반환한다. */
function resolveWorkLane(
	task: TaskBlueprint,
	nodeId: string,
): WorkLaneSegment | undefined {
	const node = task.nodes.find((candidate) => candidate.id === nodeId);
	const incoming = task.edges.filter((edge) => edge.target === nodeId);
	const outgoing = task.edges.filter((edge) => edge.source === nodeId);
	if (
		node?.kind !== 'work'
		|| incoming.length !== 1
		|| outgoing.length !== 1
	) {
		return undefined;
	}

	const incomingEdge = incoming[0];
	const outgoingEdge = outgoing[0];
	if (
		!incomingEdge
		|| !outgoingEdge
		|| !task.nodes.some((candidate) => candidate.id === incomingEdge.source)
		|| !task.nodes.some((candidate) => candidate.id === outgoingEdge.target)
	) {
		return undefined;
	}

	return { incoming: incomingEdge, outgoing: outgoingEdge };
}

/** A → B → C lane에 기존 sibling 수와 무관하게 A → N → C를 추가한다. */
function addParallelWorkAtEdge(
	task: TaskBlueprint,
	edgeId: string,
	work: CreateWorkNodeInput | undefined,
	createId: TaskIdSource | undefined,
): TaskBlueprint | undefined {
	const segment = resolveParallelWorkLane(task, edgeId);
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

/** 단일 Work lane을 제거하고 sibling이 없을 때만 직렬 연결을 복구한다. */
function removeWorkNode(
	task: TaskBlueprint,
	nodeId: string,
	createId: TaskIdSource | undefined,
): TaskBlueprint | undefined {
	const lane = resolveWorkLane(task, nodeId);
	if (!lane) {
		return undefined;
	}

	const edges = task.edges.filter((edge) => (
		edge.source !== nodeId && edge.target !== nodeId
	));
	const hasSiblingLane = task.nodes.some((candidate) => {
		if (candidate.id === nodeId || candidate.kind !== 'work') {
			return false;
		}
		const sibling = resolveWorkLane(task, candidate.id);

		return sibling?.incoming.source === lane.incoming.source
			&& sibling.outgoing.target === lane.outgoing.target;
	});
	const hasDirectEdge = edges.some((edge) => (
		edge.source === lane.incoming.source
		&& edge.target === lane.outgoing.target
	));

	if (!hasSiblingLane && !hasDirectEdge) {
		edges.push(createEdge(
			lane.incoming.source,
			lane.outgoing.target,
			createId,
		));
	}
	const nodeOffsets = { ...task.nodeOffsets };

	delete nodeOffsets[nodeId];

	return {
		...task,
		nodeOffsets: Object.keys(nodeOffsets).length > 0 ? nodeOffsets : undefined,
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
	const nodeOffsets = Object.fromEntries(Object.entries(task.nodeOffsets ?? {}).map(
		([nodeId, offset]) => [
			nodeId,
			Object.freeze({ x: offset.x, y: offset.y }),
		],
	));

	return Object.freeze({
		version: task.version,
		id: task.id,
		title: task.title,
		description: task.description,
		origin: Object.freeze({ x: task.origin.x, y: task.origin.y }),
		...(Object.keys(nodeOffsets).length > 0
			? { nodeOffsets: Object.freeze(nodeOffsets) }
			: {}),
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
