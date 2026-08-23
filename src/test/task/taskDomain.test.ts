import * as assert from 'assert';
import {
	assertValidTaskBlueprint,
	createDefaultTaskBlueprint,
	createTaskState,
	TASK_BLUEPRINT_VERSION,
	validateTaskBlueprint,
	type TaskBlueprint,
	type TaskIdSource,
	type TaskValidationIssueCode,
} from '../../task';

suite('Task Domain', () => {
	test('기본 Task를 Start → Work → End 구조와 정상 Edge로 생성한다', () => {
		const task = createDefaultTaskBlueprint({
			title: 'Implement Task Graph',
			description: 'Build the minimum Task domain.',
			origin: { x: 120, y: -40 },
			work: {
				title: 'Implement domain',
				description: 'Add the Task model and validation.',
				prompt: 'Implement T-01.',
			},
		}, createSequentialIdSource());

		assert.strictEqual(task.version, TASK_BLUEPRINT_VERSION);
		assert.strictEqual(task.id, 'task:id-1');
		assert.strictEqual(task.title, 'Implement Task Graph');
		assert.strictEqual(task.description, 'Build the minimum Task domain.');
		assert.deepStrictEqual(task.origin, { x: 120, y: -40 });
		assert.deepStrictEqual(task.nodes, [
			{ id: 'task-node:id-2', kind: 'start' },
			{
				id: 'task-node:id-3',
				kind: 'work',
				title: 'Implement domain',
				description: 'Add the Task model and validation.',
				prompt: 'Implement T-01.',
			},
			{ id: 'task-node:id-4', kind: 'end' },
		]);
		assert.strictEqual(Object.hasOwn(task.nodes[0], 'title'), false);
		assert.strictEqual(Object.hasOwn(task.nodes[0], 'description'), false);
		assert.strictEqual(Object.hasOwn(task.nodes[2], 'title'), false);
		assert.deepStrictEqual(task.edges, [
			{
				id: 'task-edge:id-5',
				source: 'task-node:id-2',
				target: 'task-node:id-3',
			},
			{
				id: 'task-edge:id-6',
				source: 'task-node:id-3',
				target: 'task-node:id-4',
			},
		]);
		assert.deepStrictEqual(validateTaskBlueprint(task), []);
	});

	test('Task 상태에서 기본 Task를 생성하고 ID로 조회 및 갱신한다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const created = state.createTask({ title: 'Initial Task' });

		assert.strictEqual(state.getTask(created.id), created);
		assert.deepStrictEqual(state.getSnapshot().tasks, [created]);
		assert.strictEqual(Object.isFrozen(created), true);
		assert.strictEqual(Object.isFrozen(created.nodes), true);

		const updated = state.updateTask(created.id, (task) => ({
			...task,
			title: 'Updated Task',
			origin: { x: 20, y: 30 },
		}));

		assert.strictEqual(updated?.title, 'Updated Task');
		assert.deepStrictEqual(updated?.origin, { x: 20, y: 30 });
		assert.strictEqual(state.getTask(created.id), updated);
		assert.strictEqual(
			state.updateTask('task:missing', (task) => task),
			undefined,
		);

		let replacementSequence = 0;
		const replacement = createDefaultTaskBlueprint(
			{ title: 'Replacement Task' },
			() => `replacement-${++replacementSequence}`,
		);
		const replacementSnapshot = state.replaceTasks([replacement]);

		assert.deepStrictEqual(replacementSnapshot.tasks, [replacement]);
		assert.strictEqual(state.getTask(created.id), undefined);
		assert.strictEqual(state.getTask(replacement.id), replacementSnapshot.tasks[0]);
	});

	test('Start Node 누락과 중복을 거부한다', () => {
		const task = createTask();
		const startNode = task.nodes.find((node) => node.kind === 'start');
		assert.ok(startNode);

		assertIssueCodes({
			...task,
			nodes: task.nodes.filter((node) => node.kind !== 'start'),
		}, ['start_node_count']);
		assertIssueCodes({
			...task,
			nodes: [...task.nodes, { ...startNode, id: 'task-node:start-copy' }],
		}, ['start_node_count']);
	});

	test('End Node 누락과 중복을 거부한다', () => {
		const task = createTask();
		const endNode = task.nodes.find((node) => node.kind === 'end');
		assert.ok(endNode);

		assertIssueCodes({
			...task,
			nodes: task.nodes.filter((node) => node.kind !== 'end'),
		}, ['end_node_count']);
		assertIssueCodes({
			...task,
			nodes: [...task.nodes, { ...endNode, id: 'task-node:end-copy' }],
		}, ['end_node_count']);
	});

	test('존재하지 않는 source 또는 target Node를 가리키는 Edge를 거부한다', () => {
		const task = createTask();
		const workNode = task.nodes.find((node) => node.kind === 'work');
		assert.ok(workNode);

		assertIssueCodes({
			...task,
			edges: [
				{
					id: 'task-edge:missing-source',
					source: 'task-node:missing-source',
					target: workNode.id,
				},
				{
					id: 'task-edge:missing-target',
					source: workNode.id,
					target: 'task-node:missing-target',
				},
			],
		}, ['edge_source_missing', 'edge_target_missing']);
	});

	test('자기 자신을 연결하는 Edge를 거부한다', () => {
		const task = createTask();
		const workNode = task.nodes.find((node) => node.kind === 'work');
		assert.ok(workNode);

		assertIssueCodes({
			...task,
			edges: [{
				id: 'task-edge:self',
				source: workNode.id,
				target: workNode.id,
			}],
		}, ['self_edge']);
	});

	test('두 개 이상의 Node로 돌아오는 directed cycle을 거부한다', () => {
		const task = createTask();
		const startNode = task.nodes.find((node) => node.kind === 'start');
		const endNode = task.nodes.find((node) => node.kind === 'end');
		assert.ok(startNode);
		assert.ok(endNode);

		assertIssueCodes({
			...task,
			edges: [
				...task.edges,
				{
					id: 'task-edge:cycle',
					source: endNode.id,
					target: startNode.id,
				},
			],
		}, ['cycle']);
	});

	test('중복 Node/Edge ID와 유효하지 않은 상태 갱신을 거부한다', () => {
		const task = createTask();
		assertIssueCodes({
			...task,
			nodes: [...task.nodes, task.nodes[1]],
			edges: [...task.edges, task.edges[0]],
		}, ['duplicate_node_id', 'duplicate_edge_id']);
		assert.throws(
			() => createTaskState([task, task]),
			/Task ID must be unique/,
		);

		const state = createTaskState([task]);
		assert.throws(() => state.updateTask(task.id, (current) => ({
			...current,
			nodes: [...current.nodes, {
				id: 'task-node:extra-start',
				kind: 'start',
			}],
		})), /exactly one start node/);
		assert.strictEqual(state.getTask(task.id)?.nodes.length, 3);
	});
});

/** 결정적인 ID를 사용하는 정상 기본 Task를 만든다. */
function createTask(): TaskBlueprint {
	return createDefaultTaskBlueprint(
		{ title: 'Task' },
		createSequentialIdSource(),
	);
}

/** validation 결과가 지정한 issue code를 모두 포함하는지 확인한다. */
function assertIssueCodes(
	task: TaskBlueprint,
	expectedCodes: readonly TaskValidationIssueCode[],
): void {
	const actualCodes = validateTaskBlueprint(task).map((issue) => issue.code);
	for (const expectedCode of expectedCodes) {
		assert.ok(
			actualCodes.includes(expectedCode),
			`Expected ${expectedCode}; received ${actualCodes.join(', ')}`,
		);
	}
	assert.throws(
		() => assertValidTaskBlueprint(task),
		/Invalid TaskBlueprint/,
	);
}

/** 호출 순서를 ID suffix로 노출하는 테스트용 생성 함수를 만든다. */
function createSequentialIdSource(): TaskIdSource {
	let sequence = 0;
	return () => `id-${++sequence}`;
}
