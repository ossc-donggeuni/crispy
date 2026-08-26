import {
	createDefaultTaskBlueprint,
	createTaskEdgeId,
	createTaskNodeId,
	DEFAULT_WORK_AGENT_PROVIDER_ID,
	resolveWorkAgentProviderId,
	TASK_DEFAULT_WORK_VERTICAL_STRIDE,
	type CreateTaskBlueprintInput,
	type CreateWorkNodeInput,
	type TaskBlueprint,
	type TaskEdge,
	type TaskGraphTargets,
	type TaskIdSource,
	type TaskNode,
	type TaskNodePosition,
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

	/** Start와 End만 가진 기본 Task를 생성해 상태에 추가한다. */
	createTask(input: CreateTaskBlueprintInput): TaskBlueprint;

	/** ID가 일치하는 Task 전체를 상태에서 제거한다. */
	removeTask(taskId: string): TaskBlueprint | undefined;

	/** 연결하지 않은 Work를 다음 기본 위치에 추가한다. */
	addWork(
		taskId: string,
		work?: CreateWorkNodeInput,
	): TaskBlueprint | undefined;

	/** Work와 incident Edge, local position을 제거하며 연결을 자동 복구하지 않는다. */
	removeWork(taskId: string, nodeId: string): TaskBlueprint | undefined;

	/** 두 Task Node Port를 구조적으로 연결할 수 있는지 판별한다. */
	canConnect(
		sourceTaskId: string,
		sourceNodeId: string,
		targetTaskId: string,
		targetNodeId: string,
	): boolean;

	/** 허용된 두 Port 사이에 Edge 하나를 추가한다. */
	connect(
		sourceTaskId: string,
		sourceNodeId: string,
		targetTaskId: string,
		targetNodeId: string,
	): TaskBlueprint | undefined;

	/** 정확한 Edge 하나를 제거해 incomplete 편집 상태를 허용한다. */
	disconnect(taskId: string, edgeId: string): TaskBlueprint | undefined;

	/** Work/End의 명시적 task-local 위치를 갱신한다. */
	setNodePosition(
		taskId: string,
		nodeId: string,
		position: TaskNodePosition,
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
	return createTaskStateStore(initialTasks, createId, false);
}

/** Workspace transaction이 이미 검증된 내부 snapshot의 구조 공유를 유지한다. */
export function createTaskStateFromSnapshots(
	initialTasks: readonly TaskBlueprint[],
	createId?: TaskIdSource,
): TaskStateStore {
	return createTaskStateStore(initialTasks, createId, true);
}

function createTaskStateStore(
	initialTasks: readonly TaskBlueprint[],
	createId: TaskIdSource | undefined,
	reuseInitialSnapshots: boolean,
): TaskStateStore {
	assertUniqueTaskIds(initialTasks);
	let snapshot = createStateSnapshot(initialTasks, reuseInitialSnapshots);
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

		removeTask(taskId): TaskBlueprint | undefined {
			const taskIndex = snapshot.tasks.findIndex((task) => task.id === taskId);

			if (taskIndex < 0) {
				return undefined;
			}
			const task = snapshot.tasks[taskIndex];

			snapshot = Object.freeze({
				tasks: Object.freeze(snapshot.tasks.filter((_, index) => (
					index !== taskIndex
				))),
			});
			return task;
		},

		addWork(taskId, work): TaskBlueprint | undefined {
			return commitTask(taskId, (task) => addWorkNode(
				task,
				work,
				createId,
			));
		},

		removeWork(taskId, nodeId): TaskBlueprint | undefined {
			return commitTask(taskId, (task) => removeWorkNode(
				task,
				nodeId,
			));
		},

		canConnect(sourceTaskId, sourceNodeId, targetTaskId, targetNodeId): boolean {
			if (sourceTaskId !== targetTaskId) {
				return false;
			}
			const task = snapshot.tasks.find((candidate) => candidate.id === sourceTaskId);

			return task !== undefined && canConnectTaskNodes(
				task,
				sourceNodeId,
				targetNodeId,
			);
		},

		connect(sourceTaskId, sourceNodeId, targetTaskId, targetNodeId): TaskBlueprint | undefined {
			if (sourceTaskId !== targetTaskId) {
				return undefined;
			}
			return commitTask(sourceTaskId, (task) => connectTaskNodes(
				task,
				sourceNodeId,
				targetNodeId,
				createId,
			));
		},

		disconnect(taskId, edgeId): TaskBlueprint | undefined {
			return commitTask(taskId, (task) => disconnectTaskEdge(task, edgeId));
		},

		setNodePosition(taskId, nodeId, position): TaskBlueprint | undefined {
			return commitTask(taskId, (task) => setTaskNodePosition(
				task,
				nodeId,
				position,
			));
		},

		updateTask(taskId, update): TaskBlueprint | undefined {
			return commitTask(taskId, update);
		},
	};
}

/** Work/End의 explicit task-local position을 갱신한다. */
function setTaskNodePosition(
	task: TaskBlueprint,
	nodeId: string,
	position: TaskNodePosition,
): TaskBlueprint | undefined {
	const node = task.nodes.find((candidate) => candidate.id === nodeId);
	if (
		!node
		|| node.kind === 'start'
		|| !Number.isFinite(position.x)
		|| !Number.isFinite(position.y)
	) {
		return undefined;
	}

	return {
		...task,
		nodePositions: {
			...task.nodePositions,
			[nodeId]: { x: position.x, y: position.y },
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
		agentProviderId: work?.agentProviderId ?? DEFAULT_WORK_AGENT_PROVIDER_ID,
		graphTargets: {
			reference: [],
			work: [],
		},
	};
}

/** 새 Work를 연결 없이 추가하고 사용 중이 아닌 첫 기본 위치를 배정한다. */
function addWorkNode(
	task: TaskBlueprint,
	work: CreateWorkNodeInput | undefined,
	createId: TaskIdSource | undefined,
): TaskBlueprint {
	const position = findNextWorkPosition(task.nodePositions);
	const node = createWorkNode(work, createId);

	return {
		...task,
		nodePositions: {
			...task.nodePositions,
			[node.id]: position,
		},
		nodes: [...task.nodes, node],
	};
}

/** x=320 lane에서 기본 Work visual group 간격의 첫 빈 위치를 찾는다. */
function findNextWorkPosition(
	nodePositions: Readonly<Record<string, TaskNodePosition>>,
): TaskNodePosition {
	let y = 0;

	while (Object.values(nodePositions).some((position) => (
		position.x === 320
		&& Math.abs(position.y - y) < TASK_DEFAULT_WORK_VERTICAL_STRIDE
	))) {
		y += TASK_DEFAULT_WORK_VERTICAL_STRIDE;
	}

	return { x: 320, y };
}

/** Work와 incident Edge, explicit position만 제거하고 우회 Edge를 만들지 않는다. */
function removeWorkNode(
	task: TaskBlueprint,
	nodeId: string,
): TaskBlueprint | undefined {
	const node = task.nodes.find((candidate) => candidate.id === nodeId);
	if (node?.kind !== 'work') {
		return undefined;
	}

	const nodePositions = { ...task.nodePositions };

	delete nodePositions[nodeId];

	return {
		...task,
		nodePositions,
		nodes: task.nodes.filter((candidate) => candidate.id !== nodeId),
		edges: task.edges.filter((edge) => (
			edge.source !== nodeId && edge.target !== nodeId
		)),
	};
}

/** Node kind Port 방향과 DAG 불변 조건을 모두 만족하는 연결인지 판별한다. */
function canConnectTaskNodes(
	task: TaskBlueprint,
	sourceNodeId: string,
	targetNodeId: string,
): boolean {
	const source = task.nodes.find((node) => node.id === sourceNodeId);
	const target = task.nodes.find((node) => node.id === targetNodeId);

	return source !== undefined
		&& target !== undefined
		&& source.id !== target.id
		&& source.kind !== 'end'
		&& target.kind !== 'start'
		&& !(source.kind === 'start' && target.kind === 'end')
		&& !task.edges.some((edge) => (
			edge.source === source.id && edge.target === target.id
		))
		&& !hasNodePath(task, target.id, source.id);
}

/** canConnect가 허용한 source→target Edge만 새 ID로 추가한다. */
function connectTaskNodes(
	task: TaskBlueprint,
	sourceNodeId: string,
	targetNodeId: string,
	createId: TaskIdSource | undefined,
): TaskBlueprint | undefined {
	if (!canConnectTaskNodes(task, sourceNodeId, targetNodeId)) {
		return undefined;
	}

	return {
		...task,
		edges: [
			...task.edges,
			createEdge(sourceNodeId, targetNodeId, createId),
		],
	};
}

/** 정확한 Edge를 찾아 제거하고 없으면 상태를 바꾸지 않는다. */
function disconnectTaskEdge(
	task: TaskBlueprint,
	edgeId: string,
): TaskBlueprint | undefined {
	if (!task.edges.some((edge) => edge.id === edgeId)) {
		return undefined;
	}

	return {
		...task,
		edges: task.edges.filter((edge) => edge.id !== edgeId),
	};
}

/** source에서 target으로 이미 도달할 수 있는지 DFS로 확인한다. */
function hasNodePath(
	task: TaskBlueprint,
	sourceNodeId: string,
	targetNodeId: string,
): boolean {
	const targetsBySource = new Map<string, string[]>();

	for (const edge of task.edges) {
		const targets = targetsBySource.get(edge.source) ?? [];

		targets.push(edge.target);
		targetsBySource.set(edge.source, targets);
	}

	const pending = [sourceNodeId];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const nodeId = pending.pop();

		if (!nodeId || visited.has(nodeId)) {
			continue;
		}
		if (nodeId === targetNodeId) {
			return true;
		}
		visited.add(nodeId);
		pending.push(...(targetsBySource.get(nodeId) ?? []));
	}

	return false;
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
	reuseSnapshots = false,
): TaskStateSnapshot {
	return Object.freeze({
		tasks: Object.freeze(tasks.map((task) => {
			if (!reuseSnapshots) {
				return createTaskSnapshot(task);
			}
			assertValidTaskBlueprint(task);
			return task;
		})),
	});
}

/** Task 전체를 검증하고 중첩 값까지 복사해 고정한다. */
function createTaskSnapshot(task: TaskBlueprint): TaskBlueprint {
	assertValidTaskBlueprint(task);
	const nodePositions = Object.fromEntries(Object.entries(task.nodePositions).map(
		([nodeId, position]) => [
			nodeId,
			Object.freeze({ x: position.x, y: position.y }),
		],
	));

	return Object.freeze({
		version: task.version,
		id: task.id,
		title: task.title,
		description: task.description,
		defaultGraphTargets: createGraphTargetsSnapshot((
			task as TaskBlueprint & {
				readonly defaultGraphTargets?: TaskGraphTargets;
			}
		).defaultGraphTargets),
		origin: Object.freeze({ x: task.origin.x, y: task.origin.y }),
		nodePositions: Object.freeze(nodePositions),
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
			agentProviderId: resolveWorkAgentProviderId(node),
			graphTargets: createGraphTargetsSnapshot(node.graphTargets),
		});
	}

	return Object.freeze({ id: node.id, kind: node.kind });
}

/** Graph Target 배열을 입력과 분리해 중첩 값까지 고정한다. */
function createGraphTargetsSnapshot(
	graphTargets: TaskGraphTargets | undefined,
): TaskGraphTargets {
	return Object.freeze({
		reference: Object.freeze([...(graphTargets?.reference ?? [])]),
		work: Object.freeze([...(graphTargets?.work ?? [])]),
	});
}

/** Task Edge를 입력 객체와 분리된 snapshot으로 복사한다. */
function createEdgeSnapshot(edge: TaskEdge): TaskEdge {
	return Object.freeze({
		id: edge.id,
		source: edge.source,
		target: edge.target,
	});
}
