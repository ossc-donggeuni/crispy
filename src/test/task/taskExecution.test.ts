import * as assert from 'assert';
import {
	createDefaultTaskBlueprint,
	createTaskExecutionScheduler,
	createTaskWorkExecutionPlan,
	isTaskExecutionActive,
	type TaskBlueprint,
	type WorkspaceTaskRecord,
} from '../../task';

suite('Task Execution Scheduler', () => {
	test('직렬 Flow를 dependency 순서대로 실행하고 End 도달 뒤 완료한다', () => {
		const task = createExecutionTask(['A', 'B'], [
			['start', 'A'],
			['A', 'B'],
			['B', 'end'],
		]);
		const scheduler = createTaskExecutionScheduler(task, 'execution-1', 3);

		assert.deepStrictEqual(scheduler.getReadyWorkNodeIds(), ['A']);
		assert.strictEqual(scheduler.markWorkStarting('B'), false);
		assert.strictEqual(scheduler.markWorkStarting('A'), true);
		assert.strictEqual(scheduler.markWorkRunning('A'), true);
		assert.strictEqual(scheduler.completeWork('A', 'A complete'), true);
		assert.deepStrictEqual(scheduler.getReadyWorkNodeIds(), ['B']);
		assert.strictEqual(scheduler.markWorkStarting('B'), true);
		assert.strictEqual(scheduler.markWorkRunning('B'), true);
		assert.strictEqual(scheduler.completeWork('B'), true);
		assert.strictEqual(scheduler.getSnapshot().state, 'completed');
	});

	test('Branch를 동시에 ready로 만들고 Join은 모든 predecessor 완료를 기다린다', () => {
		const task = createExecutionTask(['A', 'B', 'Join'], [
			['start', 'A'],
			['start', 'B'],
			['A', 'Join'],
			['B', 'Join'],
			['Join', 'end'],
		]);
		const scheduler = createTaskExecutionScheduler(task, 'execution-branch', 1);

		assert.deepStrictEqual(scheduler.getReadyWorkNodeIds(), ['A', 'B']);
		for (const nodeId of ['A', 'B']) {
			assert.strictEqual(scheduler.markWorkStarting(nodeId), true);
			assert.strictEqual(scheduler.markWorkRunning(nodeId), true);
		}
		assert.strictEqual(scheduler.completeWork('A'), true);
		assert.deepStrictEqual(scheduler.getReadyWorkNodeIds(), []);
		assert.strictEqual(scheduler.completeWork('B'), true);
		assert.deepStrictEqual(scheduler.getReadyWorkNodeIds(), ['Join']);
	});

	test('고립 Work는 실행 snapshot과 ready queue에서 제외한다', () => {
		const task = createExecutionTask(['Connected', 'Isolated'], [
			['start', 'Connected'],
			['Connected', 'end'],
		]);
		const scheduler = createTaskExecutionScheduler(task, 'execution-isolated', 0);

		assert.deepStrictEqual(
			scheduler.getSnapshot().works.map(({ nodeId }) => nodeId),
			['Connected'],
		);
		assert.deepStrictEqual(scheduler.getReadyWorkNodeIds(), ['Connected']);
	});

	test('첫 rejection은 admission을 닫고 pending을 막되 running 병렬 Work 완료를 허용한다', () => {
		const task = createExecutionTask(['A', 'B', 'AfterA', 'AfterB'], [
			['start', 'A'],
			['start', 'B'],
			['A', 'AfterA'],
			['B', 'AfterB'],
			['AfterA', 'end'],
			['AfterB', 'end'],
		]);
		const scheduler = createTaskExecutionScheduler(task, 'execution-rejected', 2);

		for (const nodeId of ['A', 'B']) {
			assert.strictEqual(scheduler.markWorkStarting(nodeId), true);
			assert.strictEqual(scheduler.markWorkRunning(nodeId), true);
		}
		assert.strictEqual(scheduler.rejectWork('A', 'scope denied'), true);
		assert.strictEqual(scheduler.getSnapshot().state, 'rejected');
		assert.strictEqual(isTaskExecutionActive(scheduler.getSnapshot()), true);
		assert.deepStrictEqual(scheduler.getReadyWorkNodeIds(), []);
		assert.strictEqual(
			scheduler.getSnapshot().works.find(({ nodeId }) => nodeId === 'AfterA')?.state,
			'blocked',
		);
		assert.strictEqual(scheduler.completeWork('B', 'parallel completed'), true);
		assert.strictEqual(
			scheduler.getSnapshot().works.find(({ nodeId }) => nodeId === 'B')?.state,
			'completed',
		);
		assert.strictEqual(scheduler.getSnapshot().state, 'rejected');
		assert.strictEqual(isTaskExecutionActive(scheduler.getSnapshot()), false);
		assert.deepStrictEqual(scheduler.getReadyWorkNodeIds(), []);
	});

	test('승인 대기와 resume 전이는 running Work에서만 허용한다', () => {
		const task = createExecutionTask(['A'], [
			['start', 'A'],
			['A', 'end'],
		]);
		const scheduler = createTaskExecutionScheduler(task, 'execution-approval', 1);

		assert.strictEqual(scheduler.markWorkWaitingForApproval('A'), false);
		assert.strictEqual(scheduler.markWorkStarting('A'), true);
		assert.strictEqual(scheduler.markWorkRunning('A'), true);
		assert.strictEqual(scheduler.markWorkWaitingForApproval('A'), true);
		assert.strictEqual(scheduler.markWorkWaitingForApproval('A'), false);
		assert.strictEqual(scheduler.completeWork('A'), false);
		assert.strictEqual(scheduler.resumeWork('A'), true);
		assert.strictEqual(scheduler.resumeWork('A'), false);
	});

	test('ready가 아닌 Task와 잘못된 실행 identity를 거부한다', () => {
		const incomplete = createDefaultTaskBlueprint({ title: 'Incomplete' }, () => 'x');

		assert.throws(
			() => createTaskExecutionScheduler(incomplete, 'execution', 0),
			/flow is not ready/,
		);
		const ready = createExecutionTask(['A'], [['start', 'A'], ['A', 'end']]);
		assert.throws(
			() => createTaskExecutionScheduler(ready, '', 0),
			/identity is invalid/,
		);
		assert.throws(
			() => createTaskExecutionScheduler(ready, 'execution', -1),
			/identity is invalid/,
		);
	});

	test('기본 범위와 Work 범위를 합치고 같은 Source에서는 쓰기 권한을 우선한다', () => {
		const task = createExecutionTask(['A'], [['start', 'A'], ['A', 'end']]);
		const work = task.nodes.find((node) => node.id === 'A');
		assert.ok(work?.kind === 'work');
		const scopedTask: TaskBlueprint = {
			...task,
			defaultGraphTargets: {
				reference: ['folder:file:///workspace/docs', 'file:file:///workspace/shared.ts'],
				work: ['folder:file:///workspace/generated'],
			},
			nodes: task.nodes.map((node) => node.id === 'A' ? {
				...work,
				agentProviderId: 'claude',
				prompt: 'Implement the scoped change.',
				graphTargets: {
					reference: ['folder:file:///workspace/src'],
					work: ['file:file:///workspace/shared.ts'],
				},
			} : node),
		};
		const record: WorkspaceTaskRecord = {
			ownerRootId: 'workspace-root:file:///workspace',
			storageRevision: 4,
			task: scopedTask,
			targetOrigins: [
				origin('start', 'reference', 'folder:file:///workspace/docs'),
				origin('start', 'reference', 'file:file:///workspace/shared.ts'),
				origin('start', 'work', 'folder:file:///workspace/generated'),
				origin('A', 'reference', 'folder:file:///workspace/src'),
				origin('A', 'work', 'file:file:///workspace/shared.ts'),
			],
		};

		assert.deepStrictEqual(createTaskWorkExecutionPlan(record, 'A'), {
			taskId: scopedTask.id,
			workNodeId: 'A',
			title: 'A',
			prompt: 'Implement the scoped change.',
			providerId: 'claude',
			workspaceRootId: record.ownerRootId,
			scope: [
				{
					sourceId: 'folder:file:///workspace/docs',
					sourceRootId: record.ownerRootId,
					access: 'read',
					originNodeId: 'start',
				},
				{
					sourceId: 'folder:file:///workspace/src',
					sourceRootId: record.ownerRootId,
					access: 'read',
					originNodeId: 'A',
				},
				{
					sourceId: 'folder:file:///workspace/generated',
					sourceRootId: record.ownerRootId,
					access: 'read-write',
					originNodeId: 'start',
				},
				{
					sourceId: 'file:file:///workspace/shared.ts',
					sourceRootId: record.ownerRootId,
					access: 'read-write',
					originNodeId: 'A',
				},
			],
		});
	});

	test('범위 provenance가 빠진 실행 계획은 fail-closed한다', () => {
		const task = createExecutionTask(['A'], [['start', 'A'], ['A', 'end']]);
		const work = task.nodes.find((node) => node.id === 'A');
		assert.ok(work?.kind === 'work');
		const scopedTask: TaskBlueprint = {
			...task,
			nodes: task.nodes.map((node) => node.id === 'A' ? {
				...work,
				graphTargets: { reference: ['file:file:///workspace/missing.ts'], work: [] },
			} : node),
		};

		assert.throws(() => createTaskWorkExecutionPlan({
			ownerRootId: 'workspace-root:file:///workspace',
			storageRevision: 1,
			task: scopedTask,
			targetOrigins: [],
		}, 'A'), /provenance is missing/);
	});
});

function origin(
	nodeId: string,
	area: 'reference' | 'work',
	sourceId: string,
) {
	return {
		nodeId,
		area,
		sourceId,
		sourceRootId: 'workspace-root:file:///workspace',
	} as const;
}

function createExecutionTask(
	workIds: readonly string[],
	edges: readonly (readonly [string, string])[],
): TaskBlueprint {
	const startId = 'start';
	const endId = 'end';
	return {
		version: 1,
		id: 'task:execution',
		title: 'Execution Task',
		description: '',
		defaultGraphTargets: { reference: [], work: [] },
		origin: { x: 0, y: 0 },
		nodePositions: Object.fromEntries([
			[endId, { x: 640, y: 0 }],
			...workIds.map((id, index) => [id, { x: 240, y: index * 120 }]),
		]),
		nodes: [
			{ id: startId, kind: 'start' },
			...workIds.map((id) => ({
				id,
				kind: 'work' as const,
				title: id,
				description: '',
				prompt: id,
				agentProviderId: 'codex' as const,
				graphTargets: { reference: [], work: [] },
			})),
			{ id: endId, kind: 'end' },
		],
		edges: edges.map(([source, target], index) => ({
			id: `edge-${index}`,
			source,
			target,
		})),
	};
}
