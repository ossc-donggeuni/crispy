import * as assert from 'assert';
import type { WorkspaceTaskRecord } from '../../task/workspaceTaskState';
import {
	createDefaultWorkspacePersistentState,
	parseWorkspacePersistentState,
	WORKSPACE_PERSISTENT_STATE_VERSION,
} from '../../workspace/workspaceMetadata';

suite('Workspace Persistent State', () => {
	test('version 1 Graph 상태를 version 2와 빈 Task 목록으로 승격한다', () => {
		assert.deepStrictEqual(parseWorkspacePersistentState({
			version: 1,
			nodePositions: { 'folder:src': { x: 120, y: -40 } },
			fileGroupPages: { 'folder:src:files': 2 },
			openedFolders: { 'folder:src': true },
			detachedRootNodeIds: { 'file:src/index.ts': true },
			hiddenNodeIds: { 'folder:src/private': true },
		}), {
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			nodePositions: { 'folder:src': { x: 120, y: -40 } },
			fileGroupPages: { 'folder:src:files': 2 },
			openedFolders: { 'folder:src': true },
			detachedRootNodeIds: { 'file:src/index.ts': true },
			hiddenNodeIds: { 'folder:src/private': true },
				tasks: [],
				taskRelocations: [],
				taskStorageReceipts: [],
		});
	});

	test('새 기본 상태를 생성한다', () => {
		const first = createDefaultWorkspacePersistentState();
		const second = createDefaultWorkspacePersistentState();

		assert.deepStrictEqual(first, {
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
				tasks: [],
				taskRelocations: [],
				taskStorageReceipts: [],
		});
		assert.notStrictEqual(first, second);
		assert.notStrictEqual(first.nodePositions, second.nodePositions);
		assert.notStrictEqual(first.fileGroupPages, second.fileGroupPages);
		assert.notStrictEqual(first.openedFolders, second.openedFolders);
		assert.notStrictEqual(
			first.detachedRootNodeIds,
			second.detachedRootNodeIds,
		);
		assert.notStrictEqual(first.hiddenNodeIds, second.hiddenNodeIds);
		assert.notStrictEqual(first.tasks, second.tasks);
		assert.notStrictEqual(first.taskRelocations, second.taskRelocations);
		assert.notStrictEqual(first.taskStorageReceipts, second.taskStorageReceipts);
	});

	test('현재 버전이 아닌 상태를 거부한다', () => {
		for (const version of [undefined, 0, 3, '2']) {
			assert.strictEqual(parseWorkspacePersistentState({ version }), undefined);
		}
	});

	test('유효한 File Group page 상태를 파싱한다', () => {
		assert.deepStrictEqual(parseWorkspacePersistentState({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			fileGroupPages: {
				'folder:src:files': 2,
				'folder:test:files': 4,
			},
		}), {
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			nodePositions: {},
			fileGroupPages: {
				'folder:src:files': 2,
				'folder:test:files': 4,
			},
			openedFolders: {},
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
				tasks: [],
				taskRelocations: [],
				taskStorageReceipts: [],
		});
	});

	test('잘못된 File Group page 상태를 거부한다', () => {
		const invalidFileGroupPages: unknown[] = [
			[],
			{ 'folder:src:files': 0 },
			{ 'folder:src:files': -1 },
			{ 'folder:src:files': 1.5 },
			{ 'folder:src:files': Number.NaN },
		];

		for (const fileGroupPages of invalidFileGroupPages) {
			assert.strictEqual(parseWorkspacePersistentState({
				version: WORKSPACE_PERSISTENT_STATE_VERSION,
				fileGroupPages,
			}), undefined);
		}
	});

	test('잘못된 Node Position을 거부한다', () => {
		assert.strictEqual(parseWorkspacePersistentState({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			nodePositions: { 'folder:src': { x: Number.NaN, y: 20 } },
		}), undefined);
	});

	test('잘못된 Opened Folder 값을 거부한다', () => {
		assert.strictEqual(parseWorkspacePersistentState({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			openedFolders: { 'folder:src': false },
		}), undefined);
	});

	test('잘못된 Detached Root 값을 거부한다', () => {
		assert.strictEqual(parseWorkspacePersistentState({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			detachedRootNodeIds: { 'folder:src': false },
		}), undefined);
	});

	test('잘못된 숨김 Node 값을 거부한다', () => {
		for (const hiddenNodeIds of [false, [], { 'folder:src': false }, { '': true }]) {
			assert.strictEqual(parseWorkspacePersistentState({
				version: WORKSPACE_PERSISTENT_STATE_VERSION,
				hiddenNodeIds,
			}), undefined);
		}
	});

	test('Filter를 포함한 누락된 Workspace 상태 Map을 빈 상태로 복원한다', () => {
		assert.deepStrictEqual(parseWorkspacePersistentState({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
		}), {
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
				tasks: [],
				taskRelocations: [],
				taskStorageReceipts: [],
		});
	});

	test('version 2 Task record를 검증하고 중첩 값까지 복사한다', () => {
		const record = createTaskRecord(
			'workspace-root:file:///workspace/app',
			'valid',
			4,
		);
		const state = parseWorkspacePersistentState({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			tasks: [record],
		});

		assert.ok(state);
		assert.deepStrictEqual(state.tasks, [record]);
		assert.deepStrictEqual(state.taskStorageReceipts, [{
			ownerRootId: record.ownerRootId,
			taskId: record.task.id,
			storageRevision: record.storageRevision,
		}]);
		assert.notStrictEqual(state.tasks[0], record);
		assert.notStrictEqual(state.tasks[0]?.task, record.task);
		assert.notStrictEqual(state.tasks[0]?.task.origin, record.task.origin);
		assert.notStrictEqual(
			state.tasks[0]?.task.defaultGraphTargets,
			record.task.defaultGraphTargets,
		);
		assert.notStrictEqual(
			state.tasks[0]?.task.nodes[1],
			record.task.nodes[1],
		);
		assert.notStrictEqual(
			state.tasks[0]?.targetOrigins[0],
			record.targetOrigins[0],
		);
	});

	test('Task storage receipt는 owner별 최대 revision을 유지하고 오래된 live record를 숨긴다', () => {
		const ownerRootId = 'workspace-root:file:///workspace/app';
		const staleRecord = createTaskRecord(ownerRootId, 'receipt', 4);
		const state = parseWorkspacePersistentState({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			tasks: [staleRecord],
			taskStorageReceipts: [{
				ownerRootId,
				taskId: staleRecord.task.id,
				storageRevision: 3,
			}, {
				ownerRootId,
				taskId: staleRecord.task.id,
				storageRevision: 5,
			}, {
				ownerRootId: 'invalid-root',
				taskId: staleRecord.task.id,
				storageRevision: 9,
			}],
		});

		assert.ok(state);
		assert.deepStrictEqual(state.tasks, []);
		assert.deepStrictEqual(state.taskStorageReceipts, [{
			ownerRootId,
			taskId: staleRecord.task.id,
			storageRevision: 5,
		}]);
	});

	test('Task relocation journal은 source와 destination owner를 검증해 복사한다', () => {
		const record = createTaskRecord(
			'workspace-root:file:///workspace/api',
			'relocated',
			7,
		);
		const state = parseWorkspacePersistentState({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			taskRelocations: [{
				sourceRootId: 'workspace-root:file:///workspace/app',
				record,
			}, {
				sourceRootId: record.ownerRootId,
				record,
			}],
		});

		assert.ok(state);
		assert.deepStrictEqual(state.taskRelocations, [{
			sourceRootId: 'workspace-root:file:///workspace/app',
			record,
		}]);
		assert.notStrictEqual(state.taskRelocations[0]?.record, record);
	});

	test('잘못된 개별 Task record만 격리하고 나머지는 복원한다', () => {
		const valid = createTaskRecord(
			'workspace-root:file:///workspace/app',
			'valid',
		);
		const invalidRevision = { ...valid, storageRevision: -1 };
		const invalidDag = {
			...valid,
			task: {
				...valid.task,
				nodes: valid.task.nodes.filter((node) => node.kind !== 'start'),
			},
		};
		const missingOrigin = {
			...valid,
			targetOrigins: valid.targetOrigins.slice(1),
		};
		const unknownTaskProperty = {
			...valid,
			task: { ...valid.task, unexpected: true },
		};

		assert.deepStrictEqual(parseWorkspacePersistentState({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			tasks: [
				invalidRevision,
				invalidDag,
				valid,
				missingOrigin,
				unknownTaskProperty,
			],
		})?.tasks, [valid]);
	});

	test('Task 목록 자체가 배열이 아니면 Workspace 상태를 거부한다', () => {
		assert.strictEqual(parseWorkspacePersistentState({
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			tasks: {},
		}), undefined);
	});

	test('입력 객체와 mutation을 공유하지 않는다', () => {
		const taskRecord = createTaskRecord(
			'workspace-root:file:///workspace/app',
			'mutable',
		);
		const input = {
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			nodePositions: { 'folder:src': { x: 100, y: 200 } },
			fileGroupPages: { 'folder:src:files': 2 },
			openedFolders: { 'folder:src': true } as Record<string, true>,
			detachedRootNodeIds: { 'folder:src': true } as Record<string, true>,
			hiddenNodeIds: { 'folder:src/private': true } as Record<string, true>,
			tasks: [taskRecord],
		};
		const state = parseWorkspacePersistentState(input);

		assert.ok(state);
		input.nodePositions['folder:src'].x = 999;
		input.fileGroupPages['folder:src:files'] = 999;
		input.openedFolders['folder:test'] = true;
		input.detachedRootNodeIds['file:src/index.ts'] = true;
		input.hiddenNodeIds['file:src/private/secret.ts'] = true;
		(taskRecord.task.origin as { x: number; y: number }).x = 999;
		(taskRecord.targetOrigins[0] as { sourceRootId: string }).sourceRootId = (
			'workspace-root:file:///workspace/other'
		);

		assert.deepStrictEqual(state.nodePositions, {
			'folder:src': { x: 100, y: 200 },
		});
		assert.deepStrictEqual(state.fileGroupPages, {
			'folder:src:files': 2,
		});
		assert.deepStrictEqual(state.openedFolders, { 'folder:src': true });
		assert.deepStrictEqual(state.detachedRootNodeIds, { 'folder:src': true });
		assert.deepStrictEqual(state.hiddenNodeIds, {
			'folder:src/private': true,
		});
		assert.strictEqual(state.tasks[0]?.task.origin.x, 10);
		assert.strictEqual(
			state.tasks[0]?.targetOrigins[0]?.sourceRootId,
			'workspace-root:file:///workspace/app',
		);
		assert.notStrictEqual(state.nodePositions, input.nodePositions);
		assert.notStrictEqual(
			state.nodePositions['folder:src'],
			input.nodePositions['folder:src'],
		);
		assert.notStrictEqual(state.fileGroupPages, input.fileGroupPages);
		assert.notStrictEqual(state.openedFolders, input.openedFolders);
		assert.notStrictEqual(
			state.detachedRootNodeIds,
			input.detachedRootNodeIds,
		);
		assert.notStrictEqual(state.hiddenNodeIds, input.hiddenNodeIds);
		assert.notStrictEqual(state.tasks, input.tasks);
	});
});

function createTaskRecord(
	ownerRootId: string,
	suffix: string,
	storageRevision = 1,
): WorkspaceTaskRecord {
	const startId = `task-node:${suffix}:start`;
	const workId = `task-node:${suffix}:work`;
	const endId = `task-node:${suffix}:end`;
	const referenceSourceId = `file:${suffix}:reference`;
	const workSourceId = `folder:${suffix}:work`;

	return {
		ownerRootId,
		storageRevision,
		task: {
			version: 1,
			id: `task:${suffix}`,
			title: `Task ${suffix}`,
			description: `Description ${suffix}`,
			defaultGraphTargets: {
				reference: [referenceSourceId],
				work: [],
			},
			origin: { x: 10, y: 20 },
			nodePositions: {
				[workId]: { x: 320, y: 0 },
				[endId]: { x: 640, y: 0 },
			},
			nodes: [
				{ id: startId, kind: 'start' },
				{
					id: workId,
					kind: 'work',
					title: 'Work',
					description: '',
					prompt: 'Do work',
					agentProviderId: 'codex',
					graphTargets: { reference: [], work: [workSourceId] },
				},
				{ id: endId, kind: 'end' },
			],
			edges: [
				{
					id: `task-edge:${suffix}:start-work`,
					source: startId,
					target: workId,
				},
				{
					id: `task-edge:${suffix}:work-end`,
					source: workId,
					target: endId,
				},
			],
		},
		targetOrigins: [
			{
				nodeId: startId,
				area: 'reference',
				sourceId: referenceSourceId,
				sourceRootId: ownerRootId,
			},
			{
				nodeId: workId,
				area: 'work',
				sourceId: workSourceId,
				sourceRootId: ownerRootId,
			},
		],
	};
}
