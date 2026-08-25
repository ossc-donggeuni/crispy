import * as assert from 'assert';
import {
	createDefaultTaskBlueprint,
	type TaskBlueprint,
	type WorkspaceTaskRecord,
} from '../task';
import {
	WORKSPACE_PERSISTENT_STATE_VERSION,
	type WorkspacePersistentState,
	type WorkspaceTaskRelocation,
} from '../workspace/workspaceMetadata';
import {
	mergeContinuouslyRetainedWorkspaceGraphState,
	mergeContinuouslyRetainedWorkspaceTaskState,
	mergeWorkspaceStateForRootTransition,
} from '../webview/workspaceRootTransition';

const ROOT_A = 'workspace-root:file:///workspace/a';
const ROOT_A_NESTED = 'workspace-root:file:///workspace/a/nested';
const ROOT_B = 'workspace-root:file:///workspace/b';
const ROOT_C = 'workspace-root:file:///workspace/c';
const ROOT_A_NODE = 'folder:file:///workspace/a/src';
const ROOT_A_NESTED_NODE = 'folder:file:///workspace/a/nested/src';
const ROOT_A_NESTED_FILE_GROUP = 'folder:file:///workspace/a/nested:files';
const ROOT_B_NODE = 'folder:file:///workspace/b/src';
const ROOT_C_NODE = 'folder:file:///workspace/c/src';

suite('Workspace Root Transition', () => {
	test('nested Root 추가와 연속 전환에서 계속 소유된 값만 Webview 값을 유지한다', () => {
		const current = createState({
			[ROOT_A_NODE]: { x: 100, y: 100 },
			[ROOT_A_NESTED_NODE]: { x: 200, y: 200 },
		});
		const withNested = mergeWorkspaceStateForRootTransition(
			current,
			createState({
				[ROOT_A_NODE]: { x: 900, y: 900 },
				[ROOT_A_NESTED_NODE]: { x: 300, y: 300 },
			}),
			[ROOT_A],
			[ROOT_A, ROOT_A_NESTED],
		);

		assert.deepStrictEqual(withNested.nodePositions, {
			[ROOT_A_NODE]: { x: 100, y: 100 },
			[ROOT_A_NESTED_NODE]: { x: 300, y: 300 },
		});

		const withAnotherRoot = mergeWorkspaceStateForRootTransition(
			withNested,
			createState({
				[ROOT_A_NODE]: { x: 901, y: 901 },
				[ROOT_A_NESTED_NODE]: { x: 902, y: 902 },
				[ROOT_C_NODE]: { x: 400, y: 400 },
			}),
			[ROOT_A, ROOT_A_NESTED],
			[ROOT_A, ROOT_A_NESTED, ROOT_C],
		);

		assert.deepStrictEqual(withAnotherRoot.nodePositions, {
			[ROOT_A_NODE]: { x: 100, y: 100 },
			[ROOT_A_NESTED_NODE]: { x: 300, y: 300 },
			[ROOT_C_NODE]: { x: 400, y: 400 },
		});
	});

	test('nested Root 경계의 File Group 합성 ID도 disk partition과 같은 owner를 사용한다', () => {
		const current = createGraphState({
			fileGroupPages: { [ROOT_A_NESTED_FILE_GROUP]: 1 },
		});
		const incoming = createGraphState({
			fileGroupPages: { [ROOT_A_NESTED_FILE_GROUP]: 7 },
		});

		const transitioned = mergeWorkspaceStateForRootTransition(
			current,
			incoming,
			[ROOT_A],
			[ROOT_A, ROOT_A_NESTED],
		);

		assert.deepStrictEqual(transitioned.fileGroupPages, {
			[ROOT_A_NESTED_FILE_GROUP]: 7,
		});

		const delayed = mergeContinuouslyRetainedWorkspaceGraphState(
			incoming,
			current,
			[ROOT_A],
			[ROOT_A, ROOT_A_NESTED],
			new Set([ROOT_A]),
		);

		assert.deepStrictEqual(delayed.fileGroupPages, {
			[ROOT_A_NESTED_FILE_GROUP]: 7,
		});
	});

	test('Root 제거 뒤 재추가하면 제거 전 값 대신 새 Host 상태와 Task를 사용한다', () => {
		const taskA = createTask('Task A', 'task-a');
		const taskB = createTask('Task B', 'task-b');
		const recordA = createRecord(ROOT_A, 3, taskA);
		const staleRecordB = createRecord(ROOT_B, 2, taskB);
		const latestRecordB = createRecord(ROOT_B, 7, taskB);
		const current = createState({
			[ROOT_A_NODE]: { x: 100, y: 100 },
			[ROOT_B_NODE]: { x: 200, y: 200 },
		}, [recordA, staleRecordB]);
		const removed = mergeWorkspaceStateForRootTransition(
			current,
			createState({
				[ROOT_A_NODE]: { x: 900, y: 900 },
			}, [recordA]),
			[ROOT_A, ROOT_B],
			[ROOT_A],
		);

		assert.deepStrictEqual(removed.nodePositions, {
			[ROOT_A_NODE]: { x: 100, y: 100 },
		});
		assert.deepStrictEqual(removed.tasks, [recordA]);

		const readded = mergeWorkspaceStateForRootTransition(
			removed,
			createState({
				[ROOT_A_NODE]: { x: 901, y: 901 },
				[ROOT_B_NODE]: { x: 500, y: 500 },
			}, [recordA, latestRecordB]),
			[ROOT_A],
			[ROOT_A, ROOT_B],
		);

		assert.deepStrictEqual(readded.nodePositions, {
			[ROOT_A_NODE]: { x: 100, y: 100 },
			[ROOT_B_NODE]: { x: 500, y: 500 },
		});
		assert.deepStrictEqual(readded.tasks, [latestRecordB, recordA]);
	});

	test('Root가 완전히 교체되면 inactive Task의 높은 revision이 active Task를 막지 않는다', () => {
		const collisionTask = createTask('Owner collision', 'collision');
		const inactiveRecord = createRecord(ROOT_A, 99, collisionTask);
		const activeRecord = createRecord(ROOT_B, 1, collisionTask);

		const result = mergeWorkspaceStateForRootTransition(
			createState({ [ROOT_A_NODE]: { x: 100, y: 100 } }, [inactiveRecord]),
			createState({ [ROOT_B_NODE]: { x: 600, y: 600 } }, [activeRecord]),
			[ROOT_A],
			[ROOT_B],
		);

		assert.deepStrictEqual(result.nodePositions, {
			[ROOT_B_NODE]: { x: 600, y: 600 },
		});
		assert.deepStrictEqual(result.tasks, [activeRecord]);
	});

	test('동일 Root 집합의 relocation journal이 destination Task를 복구한다', () => {
		const relocatedTask = createTask('Relocated Task', 'relocated');
		const sourceRecord = createRecord(ROOT_A, 4, relocatedTask);
		const destinationRecord = createRecord(ROOT_B, 5, relocatedTask);
		const relocation: WorkspaceTaskRelocation = {
			sourceRootId: ROOT_A,
			record: destinationRecord,
		};

		const result = mergeWorkspaceStateForRootTransition(
			createState({}, [sourceRecord]),
			createState({}, [destinationRecord], [relocation]),
			[ROOT_A, ROOT_B],
			[ROOT_A, ROOT_B],
		);

		assert.deepStrictEqual(result.tasks, [destinationRecord]);
		assert.deepStrictEqual(result.taskRelocations, []);
	});

	test('Root 전환은 비활성 destination의 최신 연쇄 journal 뒤 retained Task를 부활시키지 않는다', () => {
		const task = createTask('Transition chain', 'transition-chain');
		const activeRecord = createRecord(ROOT_B, 2, task);
		const inactiveRecord = createRecord(ROOT_C, 3, task);

		const result = mergeWorkspaceStateForRootTransition(
			createState({}, [activeRecord]),
			createState({}, [], [{
				sourceRootId: ROOT_A,
				record: activeRecord,
			}, {
				sourceRootId: ROOT_B,
				record: inactiveRecord,
			}]),
			[ROOT_A, ROOT_B],
			[ROOT_A, ROOT_A_NESTED, ROOT_B],
		);

		assert.deepStrictEqual(result.tasks, []);
		assert.deepStrictEqual(result.taskRelocations, []);
	});

	test('Root 전환은 retained recovery Task의 로컬 삭제를 존중하고 새 Root recovery만 복구한다', () => {
		const retainedTask = createTask('Locally deleted', 'locally-deleted');
		const retainedRecord = createRecord(ROOT_B, 4, retainedTask);
		const retainedRelocation: WorkspaceTaskRelocation = {
			sourceRootId: ROOT_A,
			record: retainedRecord,
		};
		const deleted = mergeWorkspaceStateForRootTransition(
			createState({}, []),
			createState({}, [retainedRecord], [retainedRelocation]),
			[ROOT_A, ROOT_B],
			[ROOT_A, ROOT_B],
		);

		assert.deepStrictEqual(deleted.tasks, []);

		const addedSourceTask = createTask('New source recovery', 'new-recovery');
		const addedSourceRecord = createRecord(ROOT_B, 5, addedSourceTask);
		const recovered = mergeWorkspaceStateForRootTransition(
			createState({}, []),
			createState({}, [addedSourceRecord], [{
				sourceRootId: ROOT_C,
				record: addedSourceRecord,
			}]),
			[ROOT_A, ROOT_B],
			[ROOT_A, ROOT_B, ROOT_C],
		);

		assert.deepStrictEqual(recovered.tasks, [addedSourceRecord]);
	});

	test('delayed snapshot은 nested Root 제거 시 ownership이 이동한 모든 Graph 상태를 현재 값으로 유지한다', () => {
		const previous = createGraphState({
			nodePositions: {
				[ROOT_A_NODE]: { x: 900, y: 900 },
				[ROOT_A_NESTED_NODE]: { x: 901, y: 901 },
			},
			fileGroupPages: { [ROOT_A_NODE]: 9, [ROOT_A_NESTED_NODE]: 10 },
			openedFolders: {
				[ROOT_A_NODE]: true,
				[ROOT_A_NESTED_NODE]: true,
			},
			detachedRootNodeIds: {
				[ROOT_A_NODE]: true,
				[ROOT_A_NESTED_NODE]: true,
			},
			hiddenNodeIds: { [ROOT_A_NODE]: true },
		});
		const current = createGraphState({
			nodePositions: {
				[ROOT_A_NODE]: { x: 100, y: 100 },
				[ROOT_A_NESTED_NODE]: { x: 200, y: 200 },
			},
			fileGroupPages: { [ROOT_A_NODE]: 1, [ROOT_A_NESTED_NODE]: 2 },
			openedFolders: {
				[ROOT_A_NODE]: true,
				[ROOT_A_NESTED_NODE]: true,
			},
			detachedRootNodeIds: { [ROOT_A_NESTED_NODE]: true },
			hiddenNodeIds: { [ROOT_A_NESTED_NODE]: true },
		});

		const result = mergeContinuouslyRetainedWorkspaceGraphState(
			current,
			previous,
			[ROOT_A, ROOT_A_NESTED],
			[ROOT_A],
			new Set([ROOT_A]),
		);

		assert.deepStrictEqual(result, {
			nodePositions: {
				[ROOT_A_NODE]: { x: 900, y: 900 },
				[ROOT_A_NESTED_NODE]: { x: 200, y: 200 },
			},
			fileGroupPages: { [ROOT_A_NODE]: 9, [ROOT_A_NESTED_NODE]: 2 },
			openedFolders: {
				[ROOT_A_NODE]: true,
				[ROOT_A_NESTED_NODE]: true,
			},
			detachedRootNodeIds: {
				[ROOT_A_NODE]: true,
				[ROOT_A_NESTED_NODE]: true,
			},
			hiddenNodeIds: {
				[ROOT_A_NODE]: true,
				[ROOT_A_NESTED_NODE]: true,
			},
		});
	});

	test('delayed snapshot은 nested Root 추가 시 새 owner 상태를 현재 값으로 유지한다', () => {
		const previous = createGraphState({
			nodePositions: {
				[ROOT_A_NODE]: { x: 900, y: 900 },
				[ROOT_A_NESTED_NODE]: { x: 901, y: 901 },
			},
			fileGroupPages: { [ROOT_A_NODE]: 9, [ROOT_A_NESTED_NODE]: 10 },
			openedFolders: { [ROOT_A_NODE]: true, [ROOT_A_NESTED_NODE]: true },
			detachedRootNodeIds: { [ROOT_A_NESTED_NODE]: true },
			hiddenNodeIds: { [ROOT_A_NODE]: true },
		});
		const current = createGraphState({
			nodePositions: {
				[ROOT_A_NODE]: { x: 100, y: 100 },
				[ROOT_A_NESTED_NODE]: { x: 200, y: 200 },
			},
			fileGroupPages: { [ROOT_A_NODE]: 1, [ROOT_A_NESTED_NODE]: 2 },
			openedFolders: { [ROOT_A_NESTED_NODE]: true },
			detachedRootNodeIds: {
				[ROOT_A_NODE]: true,
				[ROOT_A_NESTED_NODE]: true,
			},
			hiddenNodeIds: { [ROOT_A_NESTED_NODE]: true },
		});

		const result = mergeContinuouslyRetainedWorkspaceGraphState(
			current,
			previous,
			[ROOT_A],
			[ROOT_A, ROOT_A_NESTED],
			new Set([ROOT_A]),
		);

		assert.deepStrictEqual(result, {
			nodePositions: {
				[ROOT_A_NODE]: { x: 900, y: 900 },
				[ROOT_A_NESTED_NODE]: { x: 200, y: 200 },
			},
			fileGroupPages: { [ROOT_A_NODE]: 9, [ROOT_A_NESTED_NODE]: 2 },
			openedFolders: {
				[ROOT_A_NODE]: true,
				[ROOT_A_NESTED_NODE]: true,
			},
			detachedRootNodeIds: { [ROOT_A_NESTED_NODE]: true },
			hiddenNodeIds: {
				[ROOT_A_NODE]: true,
				[ROOT_A_NESTED_NODE]: true,
			},
		});
	});

	test('delayed Task snapshot은 revision과 canonical tie-break로 Host 복구 상태와 병합한다', () => {
		const retainedTask = createTask('Retained current', 'retained');
		const recoveredTask = createTask('Recovered destination', 'recovered');
		const currentHigher = createRecord(ROOT_A, 8, retainedTask);
		const previousLower = createRecord(
			ROOT_A,
			7,
			{ ...retainedTask, title: 'Stale edit' },
		);
		const recoveredDestination = createRecord(ROOT_B, 6, recoveredTask);
		const recoveryJournal: WorkspaceTaskRelocation = {
			sourceRootId: ROOT_C,
			record: recoveredDestination,
		};
		const canonicalCurrent = createRecord(
			ROOT_A,
			4,
			createTask('Z canonical', 'canonical'),
		);
		const canonicalPrevious = createRecord(
			ROOT_A,
			4,
			{ ...canonicalCurrent.task, title: 'A canonical' },
		);

		const result = mergeContinuouslyRetainedWorkspaceTaskState(
			{
				tasks: [currentHigher, canonicalCurrent],
				taskRelocations: [recoveryJournal],
			},
			{
				tasks: [previousLower, canonicalPrevious],
				taskRelocations: [],
			},
			[ROOT_A, ROOT_B],
			[ROOT_A, ROOT_B, ROOT_C],
			new Set([ROOT_A, ROOT_B]),
		);

		assert.deepStrictEqual(result.tasks, [
			currentHigher,
			canonicalPrevious,
			recoveredDestination,
		]);
		assert.deepStrictEqual(result.taskRelocations, [recoveryJournal]);
	});

	test('delayed Task snapshot은 끊겼거나 제거된 owner의 record를 재도입하지 않는다', () => {
		const removedRecord = createRecord(
			ROOT_B,
			99,
			createTask('Removed root', 'removed'),
		);
		const readdedRecord = createRecord(
			ROOT_C,
			99,
			createTask('Re-added root', 'readded'),
		);
		const currentRecord = createRecord(
			ROOT_A,
			2,
			createTask('Current root', 'current'),
		);

		const result = mergeContinuouslyRetainedWorkspaceTaskState(
			{ tasks: [currentRecord], taskRelocations: [] },
			{
				tasks: [currentRecord, removedRecord, readdedRecord],
				taskRelocations: [],
			},
			[ROOT_A, ROOT_B, ROOT_C],
			[ROOT_A, ROOT_C],
			new Set([ROOT_A]),
		);

		assert.deepStrictEqual(result.tasks, [currentRecord]);
		assert.deepStrictEqual(result.taskRelocations, []);
	});

	test('delayed Task snapshot의 retained-owner absence는 삭제로 적용하되 새 Root relocation 복구는 보존한다', () => {
		const deletedRecord = createRecord(
			ROOT_A,
			5,
			createTask('Deleted before transition', 'deleted'),
		);
		const recoveredRecord = createRecord(
			ROOT_B,
			6,
			createTask('Recovered during transition', 'recovery'),
		);
		const recoveryJournal: WorkspaceTaskRelocation = {
			sourceRootId: ROOT_C,
			record: recoveredRecord,
		};

		const result = mergeContinuouslyRetainedWorkspaceTaskState(
			{
				tasks: [deletedRecord, recoveredRecord],
				taskRelocations: [recoveryJournal],
			},
			{ tasks: [], taskRelocations: [] },
			[ROOT_A, ROOT_B],
			[ROOT_A, ROOT_B, ROOT_C],
			new Set([ROOT_A, ROOT_B]),
		);

		assert.deepStrictEqual(result.tasks, [recoveredRecord]);
		assert.deepStrictEqual(result.taskRelocations, [recoveryJournal]);
	});

	test('delayed Task snapshot의 삭제는 continuous Root 사이 recovery journal보다 우선한다', () => {
		const recoveredRecord = createRecord(
			ROOT_B,
			6,
			createTask('Deleted recovery', 'deleted-recovery'),
		);
		const recoveryJournal: WorkspaceTaskRelocation = {
			sourceRootId: ROOT_A,
			record: recoveredRecord,
		};

		const result = mergeContinuouslyRetainedWorkspaceTaskState(
			{
				tasks: [recoveredRecord],
				taskRelocations: [recoveryJournal],
			},
			{ tasks: [], taskRelocations: [] },
			[ROOT_A, ROOT_B],
			[ROOT_A, ROOT_B],
			new Set([ROOT_A, ROOT_B]),
		);

		assert.deepStrictEqual(result.tasks, []);
		assert.deepStrictEqual(result.taskRelocations, []);
	});

	test('delayed Task snapshot은 비활성 destination의 최신 연쇄 journal 뒤 active Task를 부활시키지 않는다', () => {
		const task = createTask('Chained relocation', 'chained');
		const activeRecord = createRecord(ROOT_B, 2, task);
		const inactiveRecord = createRecord(ROOT_C, 3, task);
		const toActive: WorkspaceTaskRelocation = {
			sourceRootId: ROOT_A,
			record: activeRecord,
		};
		const toInactive: WorkspaceTaskRelocation = {
			sourceRootId: ROOT_B,
			record: inactiveRecord,
		};

		const result = mergeContinuouslyRetainedWorkspaceTaskState(
			{
				tasks: [],
				taskRelocations: [toActive, toInactive],
			},
			{ tasks: [activeRecord], taskRelocations: [] },
			[ROOT_A, ROOT_B],
			[ROOT_A, ROOT_B],
			new Set([ROOT_A, ROOT_B]),
		);

		assert.deepStrictEqual(result.tasks, []);
		assert.deepStrictEqual(result.taskRelocations, [toActive, toInactive]);
	});
});

function createState(
	nodePositions: WorkspacePersistentState['nodePositions'],
	tasks: readonly WorkspaceTaskRecord[] = [],
	taskRelocations: readonly WorkspaceTaskRelocation[] = [],
): WorkspacePersistentState {
	return {
		version: WORKSPACE_PERSISTENT_STATE_VERSION,
		nodePositions,
		fileGroupPages: {},
		openedFolders: {},
		detachedRootNodeIds: {},
		hiddenNodeIds: {},
		tasks,
		taskRelocations,
	};
}

function createGraphState(
	overrides: Partial<WorkspacePersistentState>,
): WorkspacePersistentState {
	return {
		...createState({}),
		...overrides,
	};
}

function createTask(title: string, idPrefix: string): TaskBlueprint {
	let sequence = 0;

	return createDefaultTaskBlueprint(
		{ title },
		() => `${idPrefix}-${++sequence}`,
	);
}

function createRecord(
	ownerRootId: string,
	storageRevision: number,
	task: TaskBlueprint,
): WorkspaceTaskRecord {
	return {
		ownerRootId,
		storageRevision,
		task,
		targetOrigins: [],
	};
}
