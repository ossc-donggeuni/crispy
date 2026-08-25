import {
	createTaskState,
	createTaskStateFromSnapshots,
	type TaskBlueprintUpdater,
	type TaskStateSnapshot,
	type TaskStateStore,
} from './taskState';
import type {
	CreateTaskBlueprintInput,
	CreateWorkNodeInput,
	TaskBlueprint,
	TaskGraphTargets,
	TaskIdSource,
	TaskNodePosition,
} from './taskModel';

/** Task의 Reference 또는 Work 영역 하나를 식별한다. */
export type TaskGraphTargetArea = 'reference' | 'work';

/** 영역의 Source membership이 처음 속한 Workspace Root를 함께 보존한다. */
export interface TaskGraphTargetOrigin {
	readonly nodeId: string;
	readonly area: TaskGraphTargetArea;
	readonly sourceId: string;
	readonly sourceRootId: string;
}

/** 하나의 Workspace Root가 소유하고 저장할 Task와 영역 provenance다. */
export interface WorkspaceTaskRecord {
	readonly ownerRootId: string;
	readonly storageRevision: number;
	readonly task: TaskBlueprint;
	readonly targetOrigins: readonly TaskGraphTargetOrigin[];
}

/** Task domain snapshot과 Workspace 저장 record를 같은 시점에 제공한다. */
export interface WorkspaceTaskStateSnapshot extends TaskStateSnapshot {
	readonly records: readonly WorkspaceTaskRecord[];
}

/** Workspace Task snapshot이 실제로 변경된 뒤 호출되는 callback이다. */
export type WorkspaceTaskStateSubscriber = (
	snapshot: WorkspaceTaskStateSnapshot,
) => void;

/** 영역 membership과 Source Root provenance를 함께 갱신하는 입력이다. */
export interface WorkspaceTaskGraphTargetMembershipChange {
	readonly taskId: string;
	readonly nodeId: string;
	readonly area: TaskGraphTargetArea;
	readonly sourceId: string;
	readonly sourceRootId: string;
	readonly included: boolean;
}

/** Workspace Task Store 생성 시 사용할 선택적 기본 owner와 ID source다. */
export interface CreateWorkspaceTaskStateOptions {
	readonly createId?: TaskIdSource;
	/** TaskStateStore.createTask 호환 API에서 사용할 owner다. */
	readonly defaultOwnerRootId?: string;
}

/** Task domain API와 Workspace owner/provenance transaction을 함께 제공한다. */
export interface WorkspaceTaskStateStore extends TaskStateStore {
	/** TaskStateStore 호환 조회도 Workspace metadata가 포함된 snapshot을 반환한다. */
	getSnapshot(): WorkspaceTaskStateSnapshot;
	/** Blueprint 목록 교체도 owner/provenance와 함께 원자적으로 commit한다. */
	replaceTasks(
		tasks: readonly TaskBlueprint[],
	): WorkspaceTaskStateSnapshot;
	/** 현재 Task와 Workspace record를 같은 immutable snapshot으로 반환한다. */
	getWorkspaceSnapshot(): WorkspaceTaskStateSnapshot;
	/** Task ID가 일치하는 Workspace record를 반환한다. */
	getWorkspaceTask(taskId: string): WorkspaceTaskRecord | undefined;
	/** 명시한 Workspace Root가 소유하는 기본 Task를 생성한다. */
	createOwnedTask(
		ownerRootId: string,
		input: CreateTaskBlueprintInput,
	): TaskBlueprint;
	/** 외부에서 복원한 전체 Workspace Task record를 원자적으로 교체한다. */
	replaceWorkspaceTasks(
		records: readonly WorkspaceTaskRecord[],
	): WorkspaceTaskStateSnapshot;
	/** Task 내용은 유지하고 저장 owner만 교체한다. */
	setOwnerRoot(
		taskId: string,
		ownerRootId: string,
	): WorkspaceTaskRecord | undefined;
	/** 영역 membership과 provenance를 여러 Task에 걸쳐 원자적으로 갱신한다. */
	updateGraphTargetMemberships(
		changes: readonly WorkspaceTaskGraphTargetMembershipChange[],
	): WorkspaceTaskStateSnapshot | undefined;
	/** Import처럼 완성된 Blueprint로 교체하며 사라진 provenance를 함께 정리한다. */
	replaceTaskBlueprint(
		taskId: string,
		replacement: TaskBlueprint,
	): WorkspaceTaskRecord | undefined;
	/** Workspace Task snapshot 변경을 구독한다. */
	subscribeWorkspaceTasks(
		subscriber: WorkspaceTaskStateSubscriber,
	): () => void;
}

interface WorkspaceTaskMetadata {
	readonly ownerRootId: string;
	readonly storageRevision: number;
	readonly targetOrigins: readonly TaskGraphTargetOrigin[];
}

/** 검증된 typed record를 외부 참조와 분리한 immutable snapshot으로 만든다. */
export function createWorkspaceTaskRecordSnapshot(
	record: WorkspaceTaskRecord,
): WorkspaceTaskRecord {
	const snapshot = prepareWorkspaceTaskState([record]).snapshot.records[0];

	if (!snapshot) {
		throw new Error('Workspace Task record snapshot is missing.');
	}
	return snapshot;
}

/** typed record의 Task 구조와 owner/revision/provenance 불변 조건을 검사한다. */
export function assertValidWorkspaceTaskRecord(
	record: WorkspaceTaskRecord,
): void {
	void createWorkspaceTaskRecordSnapshot(record);
}

/**
 * 기존 TaskState API를 보존하며 Workspace owner와 target provenance를 같은
 * transaction으로 관리하는 Store를 생성한다.
 */
export function createWorkspaceTaskState(
	initialRecords: readonly WorkspaceTaskRecord[] = [],
	options: CreateWorkspaceTaskStateOptions = {},
): WorkspaceTaskStateStore {
	const subscribers = new Set<WorkspaceTaskStateSubscriber>();
	const createId = options.createId;
	const defaultOwnerRootId = options.defaultOwnerRootId;

	if (defaultOwnerRootId !== undefined) {
		assertNonEmptyString(defaultOwnerRootId, 'Default Task owner Root ID');
	}

	const initialState = prepareWorkspaceTaskState(initialRecords, createId);
	let taskState = initialState.taskState;
	let snapshot = initialState.snapshot;

	const commit = (
		nextTaskState: TaskStateStore,
		metadataByTaskId: ReadonlyMap<string, WorkspaceTaskMetadata>,
	): WorkspaceTaskStateSnapshot => {
		const nextSnapshot = createWorkspaceSnapshot(
			nextTaskState,
			metadataByTaskId,
		);

		taskState = nextTaskState;
		snapshot = nextSnapshot;
		for (const subscriber of [...subscribers]) {
			subscriber(nextSnapshot);
		}
		return nextSnapshot;
	};

	const currentMetadata = (): Map<string, WorkspaceTaskMetadata> => new Map(
		snapshot.records.map((record) => [record.task.id, {
			ownerRootId: record.ownerRootId,
			storageRevision: record.storageRevision,
			targetOrigins: record.targetOrigins,
		}]),
	);

	const createStagingTaskState = (): TaskStateStore => createTaskStateFromSnapshots(
		snapshot.tasks,
		createId,
	);

	const commitUpdatedTask = (
		staging: TaskStateStore,
		taskId: string,
		previousRecord: WorkspaceTaskRecord,
		allowRemovedTargetOrigins: boolean,
	): TaskBlueprint => {
		const updated = staging.getTask(taskId);

		if (!updated) {
			throw new Error(`Updated Workspace Task is missing: ${taskId}.`);
		}
		const metadata = currentMetadata();

		metadata.set(taskId, {
			ownerRootId: previousRecord.ownerRootId,
			storageRevision: nextStorageRevision(previousRecord.storageRevision),
			targetOrigins: normalizeTargetOrigins(
				updated,
				previousRecord.targetOrigins,
				allowRemovedTargetOrigins,
			),
		});
		const committed = commit(staging, metadata);
		const committedTask = committed.tasks.find((task) => task.id === taskId);

		if (!committedTask) {
			throw new Error(`Committed Workspace Task is missing: ${taskId}.`);
		}
		return committedTask;
	};

	const createOwnedTask = (
		ownerRootId: string,
		input: CreateTaskBlueprintInput,
	): TaskBlueprint => {
		assertNonEmptyString(ownerRootId, 'Task owner Root ID');
		if (
			(input.defaultGraphTargets?.reference.length ?? 0) > 0
			|| (input.defaultGraphTargets?.work.length ?? 0) > 0
		) {
			throw new Error(
				'Owned Task creation requires empty graph targets because target origins '
				+ 'are not part of CreateTaskBlueprintInput.',
			);
		}
		const staging = createStagingTaskState();
		const created = staging.createTask(input);
		const metadata = currentMetadata();

		metadata.set(created.id, {
			ownerRootId,
			storageRevision: 1,
			targetOrigins: [],
		});
		const committed = commit(staging, metadata);
		const committedTask = committed.tasks.find((task) => task.id === created.id);

		if (!committedTask) {
			throw new Error(`Created Workspace Task is missing: ${created.id}.`);
		}
		return committedTask;
	};

	const updateTask = (
		taskId: string,
		update: TaskBlueprintUpdater,
	): TaskBlueprint | undefined => {
		const previousRecord = getRecord(snapshot, taskId);

		if (!previousRecord) {
			return undefined;
		}
		const staging = createStagingTaskState();
		const updated = staging.updateTask(taskId, update);

		return updated
			? commitUpdatedTask(staging, taskId, previousRecord, true)
			: undefined;
	};

	return {
		getSnapshot: () => snapshot,
		getWorkspaceSnapshot: () => snapshot,
		getTask: (taskId) => snapshot.tasks.find((task) => task.id === taskId),
		getWorkspaceTask: (taskId) => getRecord(snapshot, taskId),

		replaceTasks(tasks): WorkspaceTaskStateSnapshot {
			const staging = createTaskState(tasks, createId);
			const previousById = new Map(snapshot.records.map((record) => [
				record.task.id,
				record,
			]));
			const metadata = new Map<string, WorkspaceTaskMetadata>();

			for (const task of staging.getSnapshot().tasks) {
				const previousRecord = previousById.get(task.id);

				if (previousRecord) {
					metadata.set(task.id, {
						ownerRootId: previousRecord.ownerRootId,
						storageRevision: nextStorageRevision(
							previousRecord.storageRevision,
						),
						targetOrigins: normalizeTargetOrigins(
							task,
							previousRecord.targetOrigins,
							true,
						),
					});
					continue;
				}
				if (!defaultOwnerRootId) {
					throw new Error(
						`New Task requires an owner Root: ${task.id}.`,
					);
				}
				metadata.set(task.id, {
					ownerRootId: defaultOwnerRootId,
					storageRevision: 1,
					targetOrigins: normalizeTargetOrigins(task, [], false),
				});
			}
			return commit(staging, metadata);
		},

		replaceWorkspaceTasks(records): WorkspaceTaskStateSnapshot {
			const prepared = prepareWorkspaceTaskState(records, createId);

			return commit(
				prepared.taskState,
				new Map(prepared.snapshot.records.map((record) => [
					record.task.id,
					{
						ownerRootId: record.ownerRootId,
						storageRevision: record.storageRevision,
						targetOrigins: record.targetOrigins,
					},
				])),
			);
		},

		createTask(input): TaskBlueprint {
			if (!defaultOwnerRootId) {
				throw new Error(
					'TaskStateStore.createTask requires a default owner Root; '
					+ 'use createOwnedTask instead.',
				);
			}
			return createOwnedTask(defaultOwnerRootId, input);
		},
		createOwnedTask,

		removeTask(taskId): TaskBlueprint | undefined {
			const previousRecord = getRecord(snapshot, taskId);

			if (!previousRecord) {
				return undefined;
			}
			const staging = createStagingTaskState();

			if (!staging.removeTask(taskId)) {
				return undefined;
			}
			const metadata = currentMetadata();

			metadata.delete(taskId);
			commit(staging, metadata);
			return previousRecord.task;
		},

		addWork(taskId, work?: CreateWorkNodeInput): TaskBlueprint | undefined {
			const previousRecord = getRecord(snapshot, taskId);

			if (!previousRecord) {
				return undefined;
			}
			const staging = createStagingTaskState();

			return staging.addWork(taskId, work)
				? commitUpdatedTask(staging, taskId, previousRecord, true)
				: undefined;
		},

		removeWork(taskId, nodeId): TaskBlueprint | undefined {
			const previousRecord = getRecord(snapshot, taskId);

			if (!previousRecord) {
				return undefined;
			}
			const staging = createStagingTaskState();

			return staging.removeWork(taskId, nodeId)
				? commitUpdatedTask(staging, taskId, previousRecord, true)
				: undefined;
		},

		canConnect: (...connection) => taskState.canConnect(...connection),

		connect(
			sourceTaskId,
			sourceNodeId,
			targetTaskId,
			targetNodeId,
		): TaskBlueprint | undefined {
			const previousRecord = getRecord(snapshot, sourceTaskId);

			if (!previousRecord) {
				return undefined;
			}
			const staging = createStagingTaskState();

			return staging.connect(
				sourceTaskId,
				sourceNodeId,
				targetTaskId,
				targetNodeId,
			)
				? commitUpdatedTask(staging, sourceTaskId, previousRecord, true)
				: undefined;
		},

		disconnect(taskId, edgeId): TaskBlueprint | undefined {
			const previousRecord = getRecord(snapshot, taskId);

			if (!previousRecord) {
				return undefined;
			}
			const staging = createStagingTaskState();

			return staging.disconnect(taskId, edgeId)
				? commitUpdatedTask(staging, taskId, previousRecord, true)
				: undefined;
		},

		setNodePosition(
			taskId: string,
			nodeId: string,
			position: TaskNodePosition,
		): TaskBlueprint | undefined {
			const previousRecord = getRecord(snapshot, taskId);

			if (!previousRecord) {
				return undefined;
			}
			const staging = createStagingTaskState();

			return staging.setNodePosition(taskId, nodeId, position)
				? commitUpdatedTask(staging, taskId, previousRecord, true)
				: undefined;
		},

		updateTask,

		replaceTaskBlueprint(
			taskId,
			replacement,
		): WorkspaceTaskRecord | undefined {
			if (replacement.id !== taskId) {
				throw new Error('Replacement Task must preserve its ID.');
			}
			return updateTask(taskId, () => replacement)
				? getRecord(snapshot, taskId)
				: undefined;
		},

		setOwnerRoot(taskId, ownerRootId): WorkspaceTaskRecord | undefined {
			assertNonEmptyString(ownerRootId, 'Task owner Root ID');
			const record = getRecord(snapshot, taskId);

			if (!record) {
				return undefined;
			}
			if (record.ownerRootId === ownerRootId) {
				return record;
			}
			const metadata = currentMetadata();

			metadata.set(taskId, {
				ownerRootId,
				storageRevision: nextStorageRevision(record.storageRevision),
				targetOrigins: record.targetOrigins,
			});
			return getRecord(commit(taskState, metadata), taskId);
		},

		updateGraphTargetMemberships(changes): WorkspaceTaskStateSnapshot | undefined {
			return updateGraphTargetMemberships(
				changes,
				snapshot,
				createId,
				commit,
				currentMetadata,
			);
		},

		subscribeWorkspaceTasks(subscriber): () => void {
			subscribers.add(subscriber);
			return () => {
				subscribers.delete(subscriber);
			};
		},
	};
}

function updateGraphTargetMemberships(
	changes: readonly WorkspaceTaskGraphTargetMembershipChange[],
	current: WorkspaceTaskStateSnapshot,
	createId: TaskIdSource | undefined,
	commit: (
		nextTaskState: TaskStateStore,
		metadataByTaskId: ReadonlyMap<string, WorkspaceTaskMetadata>,
	) => WorkspaceTaskStateSnapshot,
	currentMetadata: () => Map<string, WorkspaceTaskMetadata>,
): WorkspaceTaskStateSnapshot | undefined {
	const effectiveChanges = [...new Map(changes.map((change) => {
		assertMembershipChange(change);
		return [createMembershipChangeKey(change), change] as const;
	})).values()];
	const tasksById = new Map(current.tasks.map((task) => [task.id, task]));

	for (const change of effectiveChanges) {
		const task = tasksById.get(change.taskId);
		const node = task?.nodes.find((candidate) => candidate.id === change.nodeId);

		if (!task || !node || node.kind === 'end') {
			return undefined;
		}
	}
	if (effectiveChanges.length === 0) {
		return current;
	}

	const metadata = currentMetadata();
	const nextTasks = [...current.tasks];
	let anyChanged = false;

	for (const taskId of new Set(effectiveChanges.map((change) => change.taskId))) {
		const taskIndex = nextTasks.findIndex((task) => task.id === taskId);
		const task = nextTasks[taskIndex];
		const record = current.records.find((candidate) => candidate.task.id === taskId);

		if (!task || !record) {
			return undefined;
		}
		const taskChanges = effectiveChanges.filter((change) => change.taskId === taskId);
		const originsByKey = new Map(record.targetOrigins.map((origin) => [
			createTargetOriginKey(origin),
			origin,
		]));
		let taskChanged = false;

		const applyChanges = (
			targets: TaskGraphTargets,
			nodeId: string,
		): TaskGraphTargets => {
			let nextTargets = targets;

			for (const change of taskChanges) {
				if (change.nodeId !== nodeId) {
					continue;
				}
				const previousAreaTargets = nextTargets[change.area];
				const nextAreaTargets = change.included
					? previousAreaTargets.includes(change.sourceId)
						? previousAreaTargets
						: [...previousAreaTargets, change.sourceId]
					: previousAreaTargets.includes(change.sourceId)
						? previousAreaTargets.filter((sourceId) => (
							sourceId !== change.sourceId
						))
						: previousAreaTargets;
				const key = createTargetOriginKey(change);
				const previousOrigin = originsByKey.get(key);

				if (change.included) {
					if (
						!previousOrigin
						|| previousOrigin.sourceRootId !== change.sourceRootId
					) {
						originsByKey.set(key, {
							nodeId: change.nodeId,
							area: change.area,
							sourceId: change.sourceId,
							sourceRootId: change.sourceRootId,
						});
						taskChanged = true;
					}
				} else if (originsByKey.delete(key)) {
					taskChanged = true;
				}
				if (nextAreaTargets !== previousAreaTargets) {
					nextTargets = { ...nextTargets, [change.area]: nextAreaTargets };
					taskChanged = true;
				}
			}
			return nextTargets;
		};

		const start = task.nodes.find((node) => node.kind === 'start');
		const nextTask: TaskBlueprint = {
			...task,
			defaultGraphTargets: start
				? applyChanges(task.defaultGraphTargets, start.id)
				: task.defaultGraphTargets,
			nodes: task.nodes.map((node) => node.kind === 'work'
				? {
					...node,
					graphTargets: applyChanges(node.graphTargets, node.id),
				}
				: node),
		};

		if (!taskChanged) {
			continue;
		}
		const nextOrigins = normalizeTargetOrigins(
			nextTask,
			[...originsByKey.values()],
			false,
		);

		nextTasks[taskIndex] = nextTask;
		metadata.set(taskId, {
			ownerRootId: record.ownerRootId,
			storageRevision: nextStorageRevision(record.storageRevision),
			targetOrigins: nextOrigins,
		});
		anyChanged = true;
	}

	if (!anyChanged) {
		return current;
	}
	return commit(createTaskState(nextTasks, createId), metadata);
}

function prepareWorkspaceTaskState(
	records: readonly WorkspaceTaskRecord[],
	createId?: TaskIdSource,
): {
	readonly taskState: TaskStateStore;
	readonly snapshot: WorkspaceTaskStateSnapshot;
} {
	for (const record of records) {
		assertRecordMetadata(record);
	}
	const taskState = createTaskState(records.map((record) => record.task), createId);
	const metadata = new Map(records.map((record) => [record.task.id, {
		ownerRootId: record.ownerRootId,
		storageRevision: record.storageRevision,
		targetOrigins: record.targetOrigins,
	}]));

	return {
		taskState,
		snapshot: createWorkspaceSnapshot(taskState, metadata),
	};
}

function createWorkspaceSnapshot(
	taskState: TaskStateStore,
	metadataByTaskId: ReadonlyMap<string, WorkspaceTaskMetadata>,
): WorkspaceTaskStateSnapshot {
	const tasks = taskState.getSnapshot().tasks;
	const records = tasks.map((task) => {
		const metadata = metadataByTaskId.get(task.id);

		if (!metadata) {
			throw new Error(`Workspace Task metadata is missing: ${task.id}.`);
		}
		assertNonEmptyString(metadata.ownerRootId, 'Task owner Root ID');
		assertStorageRevision(metadata.storageRevision);
		const targetOrigins = normalizeTargetOrigins(
			task,
			metadata.targetOrigins,
			false,
		);

		return Object.freeze({
			ownerRootId: metadata.ownerRootId,
			storageRevision: metadata.storageRevision,
			task,
			targetOrigins: Object.freeze(targetOrigins.map((origin) => Object.freeze({
				nodeId: origin.nodeId,
				area: origin.area,
				sourceId: origin.sourceId,
				sourceRootId: origin.sourceRootId,
			}))),
		});
	});

	if (metadataByTaskId.size !== records.length) {
		throw new Error('Workspace Task metadata must reference an existing Task.');
	}
	return Object.freeze({
		tasks,
		records: Object.freeze(records),
	});
}

function normalizeTargetOrigins(
	task: TaskBlueprint,
	targetOrigins: readonly TaskGraphTargetOrigin[],
	allowRemovedOrigins: boolean,
): TaskGraphTargetOrigin[] {
	if (!Array.isArray(targetOrigins)) {
		throw new Error(`Task targetOrigins must be an array: ${task.id}.`);
	}
	const originsByKey = new Map<string, TaskGraphTargetOrigin>();

	for (const origin of targetOrigins) {
		assertTargetOrigin(origin);
		const key = createTargetOriginKey(origin);

		if (originsByKey.has(key)) {
			throw new Error(`Task target origin must be unique: ${key}.`);
		}
		originsByKey.set(key, origin);
	}

	const normalized: TaskGraphTargetOrigin[] = [];
	const appendArea = (
		nodeId: string,
		area: TaskGraphTargetArea,
		sourceIds: readonly string[],
	): void => {
		for (const sourceId of sourceIds) {
			const key = createTargetOriginKey({ nodeId, area, sourceId });
			const origin = originsByKey.get(key);

			if (!origin) {
				throw new Error(
					`Task graph target origin is missing: ${key}.`,
				);
			}
			normalized.push(origin);
			originsByKey.delete(key);
		}
	};
	const start = task.nodes.find((node) => node.kind === 'start');

	if (start) {
		appendArea(start.id, 'reference', task.defaultGraphTargets.reference);
		appendArea(start.id, 'work', task.defaultGraphTargets.work);
	}
	for (const node of task.nodes) {
		if (node.kind !== 'work') {
			continue;
		}
		appendArea(node.id, 'reference', node.graphTargets.reference);
		appendArea(node.id, 'work', node.graphTargets.work);
	}

	if (!allowRemovedOrigins && originsByKey.size > 0) {
		throw new Error(
			`Task target origin must reference an existing graph target: ${
				originsByKey.keys().next().value as string
			}.`,
		);
	}
	return normalized;
}

function getRecord(
	snapshot: WorkspaceTaskStateSnapshot,
	taskId: string,
): WorkspaceTaskRecord | undefined {
	return snapshot.records.find((record) => record.task.id === taskId);
}

function assertRecordMetadata(record: WorkspaceTaskRecord): void {
	if (!record || typeof record !== 'object') {
		throw new Error('Workspace Task record must be an object.');
	}
	assertNonEmptyString(record.ownerRootId, 'Task owner Root ID');
	assertStorageRevision(record.storageRevision);
}

function assertStorageRevision(storageRevision: number): void {
	if (!Number.isSafeInteger(storageRevision) || storageRevision < 0) {
		throw new Error('Task storageRevision must be a non-negative safe integer.');
	}
}

function nextStorageRevision(storageRevision: number): number {
	assertStorageRevision(storageRevision);
	if (storageRevision === Number.MAX_SAFE_INTEGER) {
		throw new Error('Task storageRevision cannot be incremented safely.');
	}
	return storageRevision + 1;
}

function assertTargetOrigin(origin: TaskGraphTargetOrigin): void {
	if (!origin || typeof origin !== 'object') {
		throw new Error('Task target origin must be an object.');
	}
	assertNonEmptyString(origin.nodeId, 'Task target origin node ID');
	if (origin.area !== 'reference' && origin.area !== 'work') {
		throw new Error('Task target origin area must be reference or work.');
	}
	assertNonEmptyString(origin.sourceId, 'Task target origin Source ID');
	assertNonEmptyString(origin.sourceRootId, 'Task target origin Root ID');
}

function assertMembershipChange(
	change: WorkspaceTaskGraphTargetMembershipChange,
): void {
	if (!change || typeof change !== 'object') {
		throw new Error('Task graph target membership change must be an object.');
	}
	assertNonEmptyString(change.taskId, 'Task graph target Task ID');
	assertNonEmptyString(change.nodeId, 'Task graph target node ID');
	if (change.area !== 'reference' && change.area !== 'work') {
		throw new Error('Task graph target area must be reference or work.');
	}
	assertNonEmptyString(change.sourceId, 'Task graph target Source ID');
	assertNonEmptyString(change.sourceRootId, 'Task graph target Root ID');
	if (typeof change.included !== 'boolean') {
		throw new Error('Task graph target included flag must be boolean.');
	}
}

function assertNonEmptyString(value: string, label: string): void {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${label} must be a non-empty string.`);
	}
}

function createTargetOriginKey(origin: {
	readonly nodeId: string;
	readonly area: TaskGraphTargetArea;
	readonly sourceId: string;
}): string {
	return JSON.stringify([origin.nodeId, origin.area, origin.sourceId]);
}

function createMembershipChangeKey(
	change: WorkspaceTaskGraphTargetMembershipChange,
): string {
	return JSON.stringify([
		change.taskId,
		change.nodeId,
		change.area,
		change.sourceId,
	]);
}
