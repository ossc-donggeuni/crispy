import * as assert from 'assert';
import * as vscode from 'vscode';
import { createDefaultTaskBlueprint } from '../../task/taskModel';
import type { WorkspaceTaskRecord } from '../../task/workspaceTaskState';
import {
	createDefaultWorkspacePersistentState,
	parseWorkspacePersistentState,
	type WorkspacePersistentState,
	type WorkspaceTaskRelocation,
} from '../../workspace/workspaceMetadata';
import {
	mergeWorkspacePersistentStates,
	partitionWorkspacePersistentStateByRoot,
} from '../../workspace/workspacePersistence';
import {
	createWorkspacePersistenceCoordinator,
	persistWorkspaceStateTransition,
	type WorkspaceRootStateWriter,
} from '../../workspace/workspacePersistenceCoordinator';

suite('Workspace Persistence Coordinator', () => {
	test('owner 이동은 source journal 뒤 destination을 확정하고 마지막에 source를 정리한다', async () => {
		const rootA = vscode.Uri.file('/workspace/a');
		const rootB = vscode.Uri.file('/workspace/b');
		const roots = [rootA, rootB];
		const ownerA = createRootId(rootA);
		const ownerB = createRootId(rootB);
		const sourceRecord = createTaskRecord('move', ownerA, 1);
		const movedRecord = moveTaskRecord(sourceRecord, ownerB);
		const previous = createState([sourceRecord]);
		const next = createState([movedRecord]);
		const fake = createFakeRootWriter(previous, roots);

		await persistWorkspaceStateTransition(previous, next, roots, fake.writeState);

		assert.deepStrictEqual(
			fake.calls.map((call) => call.rootUri.toString()),
			[rootA, rootB, rootB, rootA].map((uri) => uri.toString()),
		);
		assertTaskRecords(fake.calls[0]?.state, []);
		assertTaskRelocations(fake.calls[0]?.state, [{
			sourceRootId: ownerA,
			record: movedRecord,
		}]);
		assertTaskRecords(fake.calls[1]?.state, [movedRecord]);
		assertTaskRelocations(fake.calls[1]?.state, []);
		assertTaskStorageReceipts(fake.calls[1]?.state, [movedRecord]);
		assertTaskRecords(fake.calls[2]?.state, [movedRecord]);
		assertTaskRelocations(fake.calls[2]?.state, []);
		assertTaskStorageReceipts(fake.calls[2]?.state, [movedRecord]);
		assertTaskRecords(fake.calls[3]?.state, []);
		assertTaskRelocations(fake.calls[3]?.state, []);
		assertTaskRecords(fake.getRootState(rootA), []);
		assertTaskRelocations(fake.getRootState(rootA), []);
		assertTaskRecords(fake.getRootState(rootB), [movedRecord]);
	});

	test('destination staging 실패는 source journal로 복구하고 flush가 같은 desired snapshot을 재시도한다', async () => {
		const rootA = vscode.Uri.file('/workspace/a');
		const rootB = vscode.Uri.file('/workspace/b');
		const roots = [rootA, rootB];
		const sourceRecord = createTaskRecord('retry', createRootId(rootA), 1);
		const movedRecord = moveTaskRecord(sourceRecord, createRootId(rootB));
		const previous = createState([sourceRecord]);
		const next = createState([movedRecord]);
		const fake = createFakeRootWriter(previous, roots, {
			failWriteIndexes: new Set([1]),
		});
		const warnings: unknown[][] = [];
		const coordinator = createWorkspacePersistenceCoordinator({
			writeState: fake.writeState,
			logger: { warn: (...values) => warnings.push(values) },
		});

		coordinator.setInitialState(previous, roots);
		await coordinator.acceptSnapshot(next, roots);

		assert.deepStrictEqual(
			fake.calls.map((call) => call.rootUri.toString()),
			[rootA, rootB].map((uri) => uri.toString()),
		);
		assertTaskRecords(fake.getRootState(rootA), []);
		assertTaskRelocations(fake.getRootState(rootA), [{
			sourceRootId: createRootId(rootA),
			record: movedRecord,
		}]);
		assertTaskRecords(fake.getRootState(rootB), []);
		assertTaskStorageReceipts(fake.getRootState(rootB), []);
		assertTaskRecords(mergeFakeRootStates(fake, roots), [movedRecord]);
		assert.strictEqual(warnings.length, 1);

		await coordinator.flush();

		assert.deepStrictEqual(
			fake.calls.map((call) => call.rootUri.toString()),
			[rootA, rootB, rootA, rootB, rootB, rootA].map(
				(uri) => uri.toString(),
			),
		);
		assertTaskRecords(fake.getRootState(rootA), []);
		assertTaskRelocations(fake.getRootState(rootA), []);
		assertTaskRecords(fake.getRootState(rootB), [movedRecord]);
		assertTaskStorageReceipts(fake.getRootState(rootB), [movedRecord]);
		assert.strictEqual(warnings.length, 1);
	});

	test('destination이 계속 실패해도 source journal은 Task를 복구 가능한 상태로 유지한다', async () => {
		const rootA = vscode.Uri.file('/workspace/a');
		const rootB = vscode.Uri.file('/workspace/b');
		const roots = [rootA, rootB];
		const ownerA = createRootId(rootA);
		const sourceRecord = createTaskRecord('permanent-failure', ownerA, 1);
		const movedRecord = moveTaskRecord(sourceRecord, createRootId(rootB));
		const previous = createState([sourceRecord]);
		const next = createState([movedRecord]);
		const fake = createFakeRootWriter(previous, roots, {
			failRootUris: new Set([rootB.toString()]),
		});
		const warnings: unknown[][] = [];
		const coordinator = createWorkspacePersistenceCoordinator({
			writeState: fake.writeState,
			logger: { warn: (...values) => warnings.push(values) },
		});

		coordinator.setInitialState(previous, roots);
		await coordinator.acceptSnapshot(next, roots);
		await assert.rejects(coordinator.flush());

		assert.deepStrictEqual(
			fake.calls.map((call) => call.rootUri.toString()),
			[rootA, rootB, rootA, rootB].map((uri) => uri.toString()),
		);
		assertTaskRecords(fake.getRootState(rootA), []);
		assertTaskRelocations(fake.getRootState(rootA), [{
			sourceRootId: ownerA,
			record: movedRecord,
		}]);
		assertTaskRecords(fake.getRootState(rootB), []);
		assertTaskRecords(mergeFakeRootStates(fake, roots), [movedRecord]);
		assert.strictEqual(warnings.length, 2);
	});

	test('복구한 journal은 destination final 뒤 source cleanup이 실패해도 다음 flush에서 정리한다', async () => {
		const rootA = vscode.Uri.file('/workspace/a');
		const rootB = vscode.Uri.file('/workspace/b');
		const roots = [rootA, rootB];
		const ownerA = createRootId(rootA);
		const movedRecord = createTaskRecord('journal-recovery', createRootId(rootB), 2);
		const relocation = { sourceRootId: ownerA, record: movedRecord } as const;
		const sourceJournalState = {
			...createState([]),
			taskRelocations: [relocation],
		};
		const emptyDestinationState = createState([]);
		const recovered = mergeWorkspacePersistentStates([{
			rootUri: rootA,
			state: sourceJournalState,
		}, {
			rootUri: rootB,
			state: emptyDestinationState,
		}]);
		const next = createState([movedRecord]);
		const fake = createFakeRootWriter(recovered, roots, {
			failWriteIndexes: new Set([3]),
			initialRootStates: new Map([
				[rootA.toString(), sourceJournalState],
				[rootB.toString(), emptyDestinationState],
			]),
		});
		const warnings: unknown[][] = [];
		const coordinator = createWorkspacePersistenceCoordinator({
			writeState: fake.writeState,
			logger: { warn: (...values) => warnings.push(values) },
		});

		coordinator.setInitialState(recovered, roots);
		assertTaskRecords(recovered, [movedRecord]);
		assertTaskRecords(fake.getRootState(rootB), []);
		await coordinator.acceptSnapshot(next, roots);

		assert.deepStrictEqual(
			fake.calls.map((call) => call.rootUri.toString()),
			[rootA, rootB, rootB, rootA].map((uri) => uri.toString()),
		);
		assertTaskRecords(fake.getRootState(rootB), [movedRecord]);
		assertTaskRelocations(fake.getRootState(rootA), [relocation]);
		assertTaskStorageReceipts(fake.getRootState(rootB), [movedRecord]);
		assertTaskRecords(mergeFakeRootStates(fake, roots), [movedRecord]);
		const deletedDestination = {
			...fake.getRootState(rootB),
			tasks: [],
		};
		const afterDestinationDeletion = mergeWorkspacePersistentStates([{
			rootUri: rootA,
			state: fake.getRootState(rootA),
		}, {
			rootUri: rootB,
			state: deletedDestination,
		}]);

		assertTaskRecords(afterDestinationDeletion, []);
		assert.strictEqual(warnings.length, 1);

		await coordinator.flush();

		assert.deepStrictEqual(
			fake.calls.map((call) => call.rootUri.toString()),
			[rootA, rootB, rootB, rootA, rootA, rootB, rootB, rootA].map(
				(uri) => uri.toString(),
			),
		);
		assertTaskRecords(fake.getRootState(rootB), [movedRecord]);
		assertTaskRelocations(fake.getRootState(rootA), []);
		assert.strictEqual(warnings.length, 1);
	});

	test('부분 실패한 owner 이동을 원래 Root로 되돌려도 실제 write progress에서 복구한다', async () => {
		const rootA = vscode.Uri.file('/workspace/a');
		const rootB = vscode.Uri.file('/workspace/b');
		const roots = [rootB, rootA];
		const ownerA = createRootId(rootA);
		const sourceRecord = createTaskRecord('owner-aba', ownerA, 1);
		const movedRecord = moveTaskRecord(sourceRecord, createRootId(rootB));
		const returnedRecord = moveTaskRecord(movedRecord, ownerA);
		const initial = createState([sourceRecord]);
		const fake = createFakeRootWriter(initial, roots, {
			// 첫 이동의 source cleanup과 되돌림의 destination staging을 실패시킨다.
			failWriteIndexes: new Set([3, 5]),
		});
		const warnings: unknown[][] = [];
		const coordinator = createWorkspacePersistenceCoordinator({
			writeState: fake.writeState,
			logger: { warn: (...values) => warnings.push(values) },
		});

		coordinator.setInitialState(initial, roots);
		await coordinator.acceptSnapshot(createState([movedRecord]), roots);
		await coordinator.acceptSnapshot(createState([returnedRecord]), roots);

		assert.deepStrictEqual(
			fake.calls.map((call) => call.rootUri.toString()),
			[rootA, rootB, rootB, rootA, rootB, rootA].map(
				(rootUri) => rootUri.toString(),
			),
		);
		assertTaskRecords(mergeFakeRootStates(fake, roots), [returnedRecord]);
		assert.strictEqual(warnings.length, 2);

		await coordinator.flush();

		assertTaskRecords(fake.getRootState(rootA), [returnedRecord]);
		assertTaskRecords(fake.getRootState(rootB), []);
		assertTaskRelocations(fake.getRootState(rootA), []);
		assertTaskRelocations(fake.getRootState(rootB), []);
	});

	test('cross-swap destination staging 단독 복구는 outgoing Task를 이전 owner로 부활시키지 않는다', async () => {
		const rootA = vscode.Uri.file('/workspace/a');
		const rootB = vscode.Uri.file('/workspace/b');
		const roots = [rootA, rootB];
		const ownerA = createRootId(rootA);
		const ownerB = createRootId(rootB);
		const taskA = createTaskRecord('cross-a', ownerA, 1);
		const taskB = createTaskRecord('cross-b', ownerB, 1);
		const movedA = moveTaskRecord(taskA, ownerB);
		const movedB = moveTaskRecord(taskB, ownerA);
		const previous = createState([taskA, taskB]);
		const next = createState([movedA, movedB]);
		const fake = createFakeRootWriter(previous, roots);

		await persistWorkspaceStateTransition(previous, next, roots, fake.writeState);

		assert.deepStrictEqual(
			fake.calls.map((call) => call.rootUri.toString()),
			[rootA, rootB, rootA, rootB, rootA, rootB].map(
				(uri) => uri.toString(),
			),
		);
		assertTaskRecords(fake.calls[0]?.state, [movedB]);
		assertTaskRelocations(fake.calls[0]?.state, [{
			sourceRootId: ownerA,
			record: movedA,
		}]);
		assertTaskRecords(fake.calls[1]?.state, [movedA]);
		assertTaskRelocations(fake.calls[1]?.state, [{
			sourceRootId: ownerB,
			record: movedB,
		}]);
		assertTaskRecords(fake.calls[2]?.state, [movedB]);
		assertTaskRelocations(fake.calls[2]?.state, [{
			sourceRootId: ownerA,
			record: movedA,
		}]);
		assertTaskRecords(fake.calls[3]?.state, [movedA]);
		assertTaskRelocations(fake.calls[3]?.state, [{
			sourceRootId: ownerB,
				record: movedB,
			}]);
		assertTaskStorageReceipts(fake.calls[2]?.state, [movedB]);
		assertTaskStorageReceipts(fake.calls[3]?.state, [movedA]);

		// A destination stage 직후: A는 destination stage, B는 source journal 상태다.
		assertTaskRecords(loadSingleRoot(rootA, fake.calls[2]?.state), [movedB]);
		assertTaskRecords(loadSingleRoot(rootB, fake.calls[1]?.state), [movedA]);
		// B destination stage 직후에도 물리 Root 각각을 단독 load하면
		// 자신이 현재 owner인 Task만 live record로 복구한다.
		assertTaskRecords(loadSingleRoot(rootA, fake.calls[2]?.state), [movedB]);
		assertTaskRecords(loadSingleRoot(rootB, fake.calls[3]?.state), [movedA]);
		assertTaskRecords(fake.calls[4]?.state, [movedB]);
		assertTaskRecords(fake.calls[5]?.state, [movedA]);
		assertTaskRecords(fake.getRootState(rootA), [movedB]);
		assertTaskRecords(fake.getRootState(rootB), [movedA]);
	});

	test('실행 중 연속 snapshot은 중간 generation을 쓰지 않고 최신 snapshot으로 coalesce한다', async () => {
		const rootA = vscode.Uri.file('/workspace/a');
		const rootB = vscode.Uri.file('/workspace/b');
		const roots = [rootA, rootB];
		const initial = createState([]);
		const firstRecord = createTaskRecord('first', createRootId(rootA), 1);
		const secondRecord = updateTaskRecord(firstRecord, 'second', 2);
		const latestRecord = updateTaskRecord(firstRecord, 'latest', 3);
		const firstWrite = createDeferred();
		const fake = createFakeRootWriter(initial, roots, {
			beforeWrite: async (_rootUri, _state, writeIndex) => {
				if (writeIndex === 0) {
					await firstWrite.promise;
				}
			},
		});
		const coordinator = createWorkspacePersistenceCoordinator({
			writeState: fake.writeState,
			logger: { warn: () => undefined },
		});

		coordinator.setInitialState(initial, roots);
		const first = coordinator.acceptSnapshot(createState([firstRecord]), roots);
		await waitFor(() => fake.calls.length === 1);
		const second = coordinator.acceptSnapshot(createState([secondRecord]), roots);
		const latest = coordinator.acceptSnapshot(createState([latestRecord]), roots);

		firstWrite.resolve();
		await Promise.all([first, second, latest]);

		assert.deepStrictEqual(
			fake.calls.map((call) => call.rootUri.toString()),
			[rootA, rootB, rootA, rootB].map((uri) => uri.toString()),
		);
		assert.deepStrictEqual(
			fake.calls
				.flatMap((call) => call.state.tasks)
				.map((record) => record.task.title),
			['first', 'latest'],
		);
		assertTaskRecords(fake.getRootState(rootA), [latestRecord]);
		assertTaskRecords(fake.getRootState(rootB), []);
	});
});

interface FakeRootWriterOptions {
	readonly failWriteIndexes?: ReadonlySet<number>;
	readonly failRootUris?: ReadonlySet<string>;
	readonly initialRootStates?: ReadonlyMap<string, WorkspacePersistentState>;
	readonly beforeWrite?: (
		rootUri: vscode.Uri,
		state: WorkspacePersistentState,
		writeIndex: number,
	) => Promise<void>;
}

function createFakeRootWriter(
	initialState: WorkspacePersistentState,
	rootUris: readonly vscode.Uri[],
	options: FakeRootWriterOptions = {},
): {
	readonly calls: Array<{
		readonly rootUri: vscode.Uri;
		readonly state: WorkspacePersistentState;
	}>;
	readonly writeState: WorkspaceRootStateWriter;
	getRootState(rootUri: vscode.Uri): WorkspacePersistentState;
} {
	const persistedStates = new Map(
		partitionWorkspacePersistentStateByRoot(initialState, rootUris).map(
			({ rootUri, state }) => [rootUri.toString(), cloneState(state)],
		),
	);
	for (const [rootKey, state] of options.initialRootStates ?? []) {
		persistedStates.set(rootKey, cloneState(state));
	}
	const calls: Array<{
		readonly rootUri: vscode.Uri;
		readonly state: WorkspacePersistentState;
	}> = [];
	let writeIndex = 0;
	const writeState: WorkspaceRootStateWriter = async (rootUri, state) => {
		const currentIndex = writeIndex++;
		const snapshot = cloneState(state);

		calls.push({ rootUri, state: snapshot });
		await options.beforeWrite?.(rootUri, snapshot, currentIndex);
		if (
			options.failWriteIndexes?.has(currentIndex)
			|| options.failRootUris?.has(rootUri.toString())
		) {
			throw new Error(`write ${currentIndex} failed`);
		}
		persistedStates.set(rootUri.toString(), snapshot);
	};

	return {
		calls,
		writeState,
		getRootState(rootUri): WorkspacePersistentState {
			return cloneState(
				persistedStates.get(rootUri.toString())
					?? createDefaultWorkspacePersistentState(),
			);
		},
	};
}

function createState(
	tasks: readonly WorkspaceTaskRecord[],
): WorkspacePersistentState {
	return {
		...createDefaultWorkspacePersistentState(),
		tasks,
	};
}

function createTaskRecord(
	name: string,
	ownerRootId: string,
	storageRevision: number,
): WorkspaceTaskRecord {
	let sequence = 0;
	const task = createDefaultTaskBlueprint({ title: name }, () => (
		`${name}-${++sequence}`
	));

	return { ownerRootId, storageRevision, task, targetOrigins: [] };
}

function moveTaskRecord(
	record: WorkspaceTaskRecord,
	ownerRootId: string,
): WorkspaceTaskRecord {
	return {
		...record,
		ownerRootId,
		storageRevision: record.storageRevision + 1,
	};
}

function updateTaskRecord(
	record: WorkspaceTaskRecord,
	title: string,
	storageRevision: number,
): WorkspaceTaskRecord {
	return {
		...record,
		storageRevision,
		task: { ...record.task, title },
	};
}

function createRootId(rootUri: vscode.Uri): string {
	return `workspace-root:${rootUri.toString()}`;
}

function cloneState(state: WorkspacePersistentState): WorkspacePersistentState {
	const snapshot = parseWorkspacePersistentState(state);

	assert.ok(snapshot);
	return snapshot;
}

function assertTaskRecords(
	state: WorkspacePersistentState | undefined,
	expected: readonly WorkspaceTaskRecord[],
): void {
	assert.ok(state);
	assert.deepStrictEqual(
		state.tasks.map(summarizeTaskRecord).sort(compareTaskSummary),
		expected.map(summarizeTaskRecord).sort(compareTaskSummary),
	);
}

function assertTaskRelocations(
	state: WorkspacePersistentState | undefined,
	expected: readonly WorkspaceTaskRelocation[],
): void {
	assert.ok(state);
	assert.deepStrictEqual(
		state.taskRelocations.map(summarizeTaskRelocation).sort(compareTaskRelocation),
		expected.map(summarizeTaskRelocation).sort(compareTaskRelocation),
	);
}

function assertTaskStorageReceipts(
	state: WorkspacePersistentState | undefined,
	expected: readonly WorkspaceTaskRecord[],
): void {
	assert.ok(state);
	const compareReceipt = (left: { readonly id: string }, right: {
		readonly id: string;
	}): number => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

	assert.deepStrictEqual(
		state.taskStorageReceipts.map((receipt) => ({
			id: receipt.taskId,
			ownerRootId: receipt.ownerRootId,
			storageRevision: receipt.storageRevision,
		})).sort(compareReceipt),
		expected.map((record) => ({
			id: record.task.id,
			ownerRootId: record.ownerRootId,
			storageRevision: record.storageRevision,
		})).sort(compareReceipt),
	);
}

function mergeFakeRootStates(
	fake: Pick<ReturnType<typeof createFakeRootWriter>, 'getRootState'>,
	rootUris: readonly vscode.Uri[],
): WorkspacePersistentState {
	return mergeWorkspacePersistentStates(rootUris.map((rootUri) => ({
		rootUri,
		state: fake.getRootState(rootUri),
	})));
}

function loadSingleRoot(
	rootUri: vscode.Uri,
	state: WorkspacePersistentState | undefined,
): WorkspacePersistentState {
	assert.ok(state);
	return mergeWorkspacePersistentStates([{ rootUri, state }]);
}

interface TaskRecordSummary {
	readonly id: string;
	readonly ownerRootId: string;
	readonly storageRevision: number;
	readonly title: string;
}

interface TaskRelocationSummary extends TaskRecordSummary {
	readonly sourceRootId: string;
}

function summarizeTaskRecord(record: WorkspaceTaskRecord): TaskRecordSummary {
	return {
		id: record.task.id,
		ownerRootId: record.ownerRootId,
		storageRevision: record.storageRevision,
		title: record.task.title,
	};
}

function summarizeTaskRelocation(
	relocation: WorkspaceTaskRelocation,
): TaskRelocationSummary {
	return {
		...summarizeTaskRecord(relocation.record),
		sourceRootId: relocation.sourceRootId,
	};
}

function compareTaskSummary(left: TaskRecordSummary, right: TaskRecordSummary): number {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function compareTaskRelocation(
	left: TaskRelocationSummary,
	right: TaskRelocationSummary,
): number {
	return left.sourceRootId < right.sourceRootId
		? -1
		: left.sourceRootId > right.sourceRootId
			? 1
			: compareTaskSummary(left, right);
}

function createDeferred(): {
	readonly promise: Promise<void>;
	resolve(): void;
} {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});

	return {
		promise,
		resolve(): void {
			resolvePromise?.();
		},
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) {
			return;
		}
		await Promise.resolve();
	}

	assert.fail('Expected asynchronous condition was not met.');
}
