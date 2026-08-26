import * as assert from 'assert';
import {
	createTaskState,
	createWorkspaceTaskRecordSnapshot,
	createWorkspaceTaskState,
	type TaskBlueprint,
	type TaskGraphTargetOrigin,
	type TaskIdSource,
	type WorkspaceTaskRecord,
} from '../../task';

suite('Workspace Task State', () => {
	test('record를 깊은 immutable snapshot으로 만들고 target provenance 1:1을 검증한다', () => {
		const fixture = createRecordFixture('snapshot', 7);
		const reversedOrigins = [...fixture.record.targetOrigins].reverse();
		const input: WorkspaceTaskRecord = {
			...fixture.record,
			targetOrigins: reversedOrigins,
		};
		const record = createWorkspaceTaskRecordSnapshot(input);

		assert.notStrictEqual(record, input);
		assert.notStrictEqual(record.task, input.task);
		assert.notStrictEqual(record.targetOrigins, reversedOrigins);
		assert.strictEqual(Object.isFrozen(record), true);
		assert.strictEqual(Object.isFrozen(record.task), true);
		assert.strictEqual(Object.isFrozen(record.targetOrigins), true);
		assert.strictEqual(Object.isFrozen(record.targetOrigins[0]), true);
		assert.deepStrictEqual(record.targetOrigins, fixture.record.targetOrigins);

		assert.throws(() => createWorkspaceTaskRecordSnapshot({
			...fixture.record,
			targetOrigins: fixture.record.targetOrigins.slice(1),
		}), /origin is missing/);
		assert.throws(() => createWorkspaceTaskRecordSnapshot({
			...fixture.record,
			targetOrigins: [
				...fixture.record.targetOrigins,
				fixture.record.targetOrigins[0] ?? assert.fail(),
			],
		}), /origin must be unique/);
		assert.throws(() => createWorkspaceTaskRecordSnapshot({
			...fixture.record,
			targetOrigins: [
				...fixture.record.targetOrigins,
				{
					nodeId: fixture.workId,
					area: 'reference',
					sourceId: 'source:orphan',
					sourceRootId: 'workspace-root:orphan',
				},
			],
		}), /must reference an existing graph target/);
		assert.throws(() => createWorkspaceTaskRecordSnapshot({
			...fixture.record,
			ownerRootId: '',
		}), /owner Root ID/);
		assert.throws(() => createWorkspaceTaskRecordSnapshot({
			...fixture.record,
			storageRevision: -1,
		}), /non-negative safe integer/);
	});

	test('명시 owner와 기본 owner로 Task를 만들고 완성된 snapshot만 알린다', () => {
		const store = createWorkspaceTaskState([], {
			createId: createSequentialIdSource('owned'),
			defaultOwnerRootId: 'workspace-root:default',
		});
		const notifications: ReturnType<typeof store.getWorkspaceSnapshot>[] = [];
		const unsubscribe = store.subscribeWorkspaceTasks((snapshot) => {
			notifications.push(snapshot);
		});
		const created = store.createOwnedTask('workspace-root:first', {
			title: 'Owned Task',
		});
		const firstRecord = store.getWorkspaceTask(created.id) ?? assert.fail();

		assert.strictEqual(firstRecord.ownerRootId, 'workspace-root:first');
		assert.strictEqual(firstRecord.storageRevision, 1);
		assert.strictEqual(firstRecord.task, store.getTask(created.id));
		assert.strictEqual(notifications.length, 1);
		assert.strictEqual(notifications[0], store.getWorkspaceSnapshot());
		assert.strictEqual(notifications[0]?.records[0]?.task, notifications[0]?.tasks[0]);

		assert.strictEqual(
			store.setOwnerRoot(created.id, 'workspace-root:first'),
			firstRecord,
		);
		assert.strictEqual(notifications.length, 1);
		const moved = store.setOwnerRoot(created.id, 'workspace-root:second');

		assert.strictEqual(moved?.ownerRootId, 'workspace-root:second');
		assert.strictEqual(moved?.storageRevision, 2);
		assert.strictEqual(notifications.length, 2);

		const defaultOwned = store.createTask({ title: 'Default Owned Task' });

		assert.strictEqual(
			store.getWorkspaceTask(defaultOwned.id)?.ownerRootId,
			'workspace-root:default',
		);
		unsubscribe();
		store.updateTask(defaultOwned.id, (task) => ({ ...task, title: 'Updated' }));
		assert.strictEqual(notifications.length, 3);

		const ownerRequired = createWorkspaceTaskState();

		assert.throws(
			() => ownerRequired.createTask({ title: 'No Owner' }),
			/use createOwnedTask/,
		);
		assert.throws(() => ownerRequired.createOwnedTask('workspace-root:first', {
			title: 'Untracked Target',
			defaultGraphTargets: { reference: ['source:one'], work: [] },
		}), /requires empty graph targets/);
		assert.deepStrictEqual(ownerRequired.getWorkspaceSnapshot().tasks, []);
	});

	test('여러 Task의 graph target과 provenance를 한 transaction으로 갱신한다', () => {
		const store = createWorkspaceTaskState([], {
			createId: createSequentialIdSource('memberships'),
		});
		const first = store.createOwnedTask('workspace-root:owner-a', {
			title: 'First',
		});
		const second = store.createOwnedTask('workspace-root:owner-b', {
			title: 'Second',
		});
		const firstWithWork = store.addWork(first.id) ?? assert.fail();
		const secondWithWork = store.addWork(second.id) ?? assert.fail();
		const firstStartId = findNodeId(firstWithWork, 'start');
		const firstWorkId = findNodeId(firstWithWork, 'work');
		const secondStartId = findNodeId(secondWithWork, 'start');
		let notificationCount = 0;

		store.subscribeWorkspaceTasks(() => {
			notificationCount += 1;
		});
		const updated = store.updateGraphTargetMemberships([
			{
				taskId: first.id,
				nodeId: firstStartId,
				area: 'reference',
				sourceId: 'source:shared',
				sourceRootId: 'workspace-root:source-a',
				included: true,
			},
			{
				taskId: first.id,
				nodeId: firstWorkId,
				area: 'work',
				sourceId: 'source:work',
				sourceRootId: 'workspace-root:source-b',
				included: true,
			},
			{
				taskId: second.id,
				nodeId: secondStartId,
				area: 'reference',
				sourceId: 'source:shared',
				sourceRootId: 'workspace-root:source-a',
				included: true,
			},
		]);

		assert.ok(updated);
		assert.strictEqual(notificationCount, 1);
		assert.deepStrictEqual(
			store.getTask(first.id)?.defaultGraphTargets.reference,
			['source:shared'],
		);
		assert.deepStrictEqual(
			readWork(store.getTask(first.id) ?? assert.fail(), firstWorkId).graphTargets.work,
			['source:work'],
		);
		assert.deepStrictEqual(
			store.getTask(second.id)?.defaultGraphTargets.reference,
			['source:shared'],
		);
		assert.deepStrictEqual(store.getWorkspaceTask(first.id)?.targetOrigins, [
			{
				nodeId: firstStartId,
				area: 'reference',
				sourceId: 'source:shared',
				sourceRootId: 'workspace-root:source-a',
			},
			{
				nodeId: firstWorkId,
				area: 'work',
				sourceId: 'source:work',
				sourceRootId: 'workspace-root:source-b',
			},
		]);

		const unchanged = store.getWorkspaceSnapshot();
		const noOp = store.updateGraphTargetMemberships([{
			taskId: first.id,
			nodeId: firstStartId,
			area: 'reference',
			sourceId: 'source:shared',
			sourceRootId: 'workspace-root:source-a',
			included: true,
		}]);

		assert.strictEqual(noOp, unchanged);
		assert.strictEqual(notificationCount, 1);

		const invalidTransaction = store.updateGraphTargetMemberships([
			{
				taskId: first.id,
				nodeId: firstStartId,
				area: 'work',
				sourceId: 'source:would-be-added',
				sourceRootId: 'workspace-root:source-a',
				included: true,
			},
			{
				taskId: 'task:missing',
				nodeId: firstStartId,
				area: 'work',
				sourceId: 'source:invalid',
				sourceRootId: 'workspace-root:source-a',
				included: true,
			},
		]);

		assert.strictEqual(invalidTransaction, undefined);
		assert.strictEqual(store.getWorkspaceSnapshot(), unchanged);
		assert.deepStrictEqual(store.getTask(first.id)?.defaultGraphTargets.work, []);
		assert.strictEqual(notificationCount, 1);

		const changedOrigin = store.updateGraphTargetMemberships([{
			taskId: first.id,
			nodeId: firstStartId,
			area: 'reference',
			sourceId: 'source:shared',
			sourceRootId: 'workspace-root:new-source',
			included: true,
		}]);

		assert.ok(changedOrigin);
		assert.strictEqual(notificationCount, 2);
		assert.strictEqual(
			store.getWorkspaceTask(first.id)?.targetOrigins[0]?.sourceRootId,
			'workspace-root:new-source',
		);
	});

	test('Work 삭제와 Blueprint import 교체가 사라진 target provenance를 정리한다', () => {
		const store = createWorkspaceTaskState([], {
			createId: createSequentialIdSource('cleanup'),
		});
		const task = store.createOwnedTask('workspace-root:owner', { title: 'Cleanup' });
		const withWork = store.addWork(task.id) ?? assert.fail();
		const startId = findNodeId(withWork, 'start');
		const workId = findNodeId(withWork, 'work');

		store.updateGraphTargetMemberships([
			{
				taskId: task.id,
				nodeId: startId,
				area: 'reference',
				sourceId: 'source:start',
				sourceRootId: 'workspace-root:start-source',
				included: true,
			},
			{
				taskId: task.id,
				nodeId: workId,
				area: 'work',
				sourceId: 'source:work',
				sourceRootId: 'workspace-root:work-source',
				included: true,
			},
		]);
		const afterRemoval = store.removeWork(task.id, workId) ?? assert.fail();

		assert.strictEqual(afterRemoval.nodes.some((node) => node.id === workId), false);
		assert.deepStrictEqual(store.getWorkspaceTask(task.id)?.targetOrigins, [{
			nodeId: startId,
			area: 'reference',
			sourceId: 'source:start',
			sourceRootId: 'workspace-root:start-source',
		}]);

		const imported: TaskBlueprint = {
			...afterRemoval,
			title: 'Imported',
			defaultGraphTargets: { reference: [], work: [] },
		};
		const replaced = store.replaceTaskBlueprint(task.id, imported);

		assert.strictEqual(replaced?.task.title, 'Imported');
		assert.deepStrictEqual(replaced?.targetOrigins, []);

		const beforeInvalidUpdate = store.getWorkspaceSnapshot();

		assert.throws(() => store.updateTask(task.id, (current) => ({
			...current,
			defaultGraphTargets: { reference: ['source:untracked'], work: [] },
		})), /origin is missing/);
		assert.strictEqual(store.getWorkspaceSnapshot(), beforeInvalidUpdate);
	});

	test('기존 TaskState 편집 API를 위임하며 Task와 revision을 함께 commit한다', () => {
		const store = createWorkspaceTaskState([], {
			createId: createSequentialIdSource('delegate'),
		});
		const task = store.createOwnedTask('workspace-root:owner', { title: 'Flow' });
		const withFirst = store.addWork(task.id) ?? assert.fail();
		const withSecond = store.addWork(task.id) ?? assert.fail();
		const startId = findNodeId(withSecond, 'start');
		const endId = findNodeId(withSecond, 'end');
		const workIds = withSecond.nodes
			.filter((node) => node.kind === 'work')
			.map((node) => node.id);
		const firstWorkId = workIds[0] ?? assert.fail();
		const secondWorkId = workIds[1] ?? assert.fail();

		assert.strictEqual(store.canConnect(task.id, startId, task.id, firstWorkId), true);
		store.connect(task.id, startId, task.id, firstWorkId);
		store.connect(task.id, firstWorkId, task.id, secondWorkId);
		const connected = store.connect(task.id, secondWorkId, task.id, endId)
			?? assert.fail();
		const moved = store.setNodePosition(task.id, firstWorkId, { x: 100, y: 200 })
			?? assert.fail();

		assert.deepStrictEqual(moved.nodePositions[firstWorkId], { x: 100, y: 200 });
		assert.strictEqual(store.getWorkspaceTask(task.id)?.storageRevision, 7);
		const edgeId = connected.edges[0]?.id ?? assert.fail();
		const disconnected = store.disconnect(task.id, edgeId) ?? assert.fail();

		assert.strictEqual(disconnected.edges.some((edge) => edge.id === edgeId), false);
		assert.strictEqual(store.getWorkspaceTask(task.id)?.storageRevision, 8);
	});

	test('전체 record 교체 실패는 기존 snapshot을 보존하고 성공 시 전달 revision을 유지한다', () => {
		const initial = createRecordFixture('replace-initial', 10).record;
		const store = createWorkspaceTaskState([initial], {
			createId: createSequentialIdSource('replace-store'),
			defaultOwnerRootId: 'workspace-root:default',
		});
		const before = store.getWorkspaceSnapshot();

		assert.throws(() => store.replaceWorkspaceTasks([{
			...initial,
			targetOrigins: [],
		}]), /origin is missing/);
		assert.strictEqual(store.getWorkspaceSnapshot(), before);

		const replacementFixture = createRecordFixture('replace-next', 25);
		const replaced = store.replaceWorkspaceTasks([replacementFixture.record]);

		assert.strictEqual(replaced.records[0]?.storageRevision, 25);
		assert.strictEqual(replaced.records[0]?.ownerRootId, 'workspace-root:replace-next-owner');
		assert.notStrictEqual(replaced.records[0], replacementFixture.record);

		const replacementTask = replaced.tasks[0] ?? assert.fail();
		const updated = store.replaceTasks([{
			...replacementTask,
			title: 'replaceTasks update',
		}]);

		assert.strictEqual(updated.records[0]?.storageRevision, 26);
		assert.strictEqual(updated.tasks[0]?.title, 'replaceTasks update');

		const overflowStore = createWorkspaceTaskState([{
			...replacementFixture.record,
			storageRevision: Number.MAX_SAFE_INTEGER,
		}]);
		const overflowSnapshot = overflowStore.getWorkspaceSnapshot();

		assert.throws(() => overflowStore.updateTask(
			replacementFixture.record.task.id,
			(task) => ({ ...task, title: 'Overflow' }),
		), /cannot be incremented safely/);
		assert.strictEqual(overflowStore.getWorkspaceSnapshot(), overflowSnapshot);
	});
});

function createRecordFixture(
	prefix: string,
	storageRevision: number,
): {
	readonly record: WorkspaceTaskRecord;
	readonly startId: string;
	readonly workId: string;
} {
	const taskState = createTaskState([], createSequentialIdSource(prefix));
	const created = taskState.createTask({ title: `${prefix} Task` });
	const withWork = taskState.addWork(created.id) ?? assert.fail();
	const startId = findNodeId(withWork, 'start');
	const workId = findNodeId(withWork, 'work');
	const task = taskState.updateTask(created.id, (current) => ({
		...current,
		defaultGraphTargets: {
			reference: [`source:${prefix}:start-reference`],
			work: [`source:${prefix}:start-work`],
		},
		nodes: current.nodes.map((node) => node.id === workId && node.kind === 'work'
			? {
				...node,
				graphTargets: {
					reference: [`source:${prefix}:work-reference`],
					work: [],
				},
			}
			: node),
	})) ?? assert.fail();
	const targetOrigins: TaskGraphTargetOrigin[] = [
		{
			nodeId: startId,
			area: 'reference',
			sourceId: `source:${prefix}:start-reference`,
			sourceRootId: `workspace-root:${prefix}-start-reference`,
		},
		{
			nodeId: startId,
			area: 'work',
			sourceId: `source:${prefix}:start-work`,
			sourceRootId: `workspace-root:${prefix}-start-work`,
		},
		{
			nodeId: workId,
			area: 'reference',
			sourceId: `source:${prefix}:work-reference`,
			sourceRootId: `workspace-root:${prefix}-work-reference`,
		},
	];

	return {
		record: {
			ownerRootId: `workspace-root:${prefix}-owner`,
			storageRevision,
			task,
			targetOrigins,
		},
		startId,
		workId,
	};
}

function findNodeId(
	task: TaskBlueprint,
	kind: TaskBlueprint['nodes'][number]['kind'],
): string {
	return task.nodes.find((node) => node.kind === kind)?.id ?? assert.fail();
}

function readWork(task: TaskBlueprint, nodeId: string) {
	const node = task.nodes.find((candidate) => candidate.id === nodeId);

	return node?.kind === 'work' ? node : assert.fail();
}

function createSequentialIdSource(prefix: string): TaskIdSource {
	let sequence = 0;

	return () => `${prefix}-${++sequence}`;
}
