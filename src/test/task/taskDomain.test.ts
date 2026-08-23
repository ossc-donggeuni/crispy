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

	test('직렬 Work 추가는 선택 Edge를 A → N → B로 치환한다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({ title: 'Serial Task' });
		const [start, work, end] = task.nodes;
		const selectedEdge = task.edges[0];

		assert.ok(start && work && end && selectedEdge);
		const updated = state.insertWorkBetween(task.id, selectedEdge.id);
		const inserted = updated?.nodes.find((node) => (
			node.kind === 'work' && node.id !== work.id
		));

		assert.ok(updated && inserted?.kind === 'work');
		assert.strictEqual(inserted.title, 'New Work');
		assert.strictEqual(updated.nodes.length, task.nodes.length + 1);
		assert.strictEqual(updated.edges.length, task.edges.length + 1);
		assert.strictEqual(
			updated.edges.some((edge) => edge.id === selectedEdge.id),
			false,
		);
		assert.deepStrictEqual(readConnections(updated), [
			`${work.id}->${end.id}`,
			`${start.id}->${inserted.id}`,
			`${inserted.id}->${work.id}`,
		].sort());
		assert.deepStrictEqual(validateTaskBlueprint(updated), []);
		assert.strictEqual(state.insertWorkBetween(task.id, 'task-edge:missing'), undefined);
	});

	test('병렬 Work 추가는 단순 A → B → C에서 A → N → C sibling을 만든다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({ title: 'Parallel Task' });
		const [start, work, end] = task.nodes;
		const incoming = task.edges[0];

		assert.ok(start && work && end && incoming);
		const updated = state.addParallelWork(task.id, incoming.id, {
			title: 'Parallel Work',
		});
		const parallel = updated?.nodes.find((node) => (
			node.kind === 'work' && node.id !== work.id
		));

		assert.ok(updated && parallel?.kind === 'work');
		assert.strictEqual(parallel.title, 'Parallel Work');
		assert.deepStrictEqual(readConnections(updated), [
			`${start.id}->${work.id}`,
			`${start.id}->${parallel.id}`,
			`${work.id}->${end.id}`,
			`${parallel.id}->${end.id}`,
		].sort());
		assert.deepStrictEqual(validateTaskBlueprint(updated), []);
		assert.strictEqual(
			state.addParallelWork(task.id, incoming.id),
			undefined,
		);
		assert.strictEqual(
			state.addParallelWork(task.id, task.edges[1]?.id ?? ''),
			undefined,
		);
	});

	test('복수 successor가 있는 Work의 모호한 병렬 추가를 거부한다', () => {
		const task = createTask();
		const [start, work, end] = task.nodes;

		assert.ok(start && work && end);
		const successorWork = {
			id: 'task-node:successor',
			kind: 'work' as const,
			title: 'Successor',
			description: '',
			prompt: '',
		};
		const branchedTask: TaskBlueprint = {
			...task,
			nodes: [...task.nodes, successorWork],
			edges: [...task.edges, {
				id: 'task-edge:work-successor',
				source: work.id,
				target: successorWork.id,
			}, {
				id: 'task-edge:successor-end',
				source: successorWork.id,
				target: end.id,
			}],
		};
		const state = createTaskState([branchedTask], createSequentialIdSource());
		const updated = state.addParallelWork(task.id, task.edges[0]?.id ?? '');

		assert.strictEqual(updated, undefined);
		assert.deepStrictEqual(state.getTask(task.id), branchedTask);
		assert.deepStrictEqual(validateTaskBlueprint(branchedTask), []);
	});

	test('Work 삭제는 predecessor×successor 연결을 중복 없이 복구한다', () => {
		const task = createTask();
		const [start, work, end] = task.nodes;
		const state = createTaskState([task], createSequentialIdSource());

		assert.ok(start && work && end);
		const updated = state.removeWork(task.id, work.id);

		assert.ok(updated);
		assert.deepStrictEqual(updated.nodes, [start, end]);
		assert.deepStrictEqual(readConnections(updated), [`${start.id}->${end.id}`]);
		assert.deepStrictEqual(validateTaskBlueprint(updated), []);
		assert.strictEqual(state.removeWork(task.id, start.id), undefined);
		assert.strictEqual(state.removeWork(task.id, end.id), undefined);
	});

	test('기존 direct Edge가 있는 Work 삭제는 같은 연결을 중복하지 않는다', () => {
		const task = createTask();
		const [start, work, end] = task.nodes;

		assert.ok(start && work && end);
		const taskWithDirectEdge: TaskBlueprint = {
			...task,
			edges: [...task.edges, {
				id: 'task-edge:direct',
				source: start.id,
				target: end.id,
			}],
		};
		const state = createTaskState([taskWithDirectEdge], createSequentialIdSource());
		const updated = state.removeWork(task.id, work.id);

		assert.ok(updated);
		assert.deepStrictEqual(readConnections(updated), [`${start.id}->${end.id}`]);
		assert.strictEqual(updated.edges[0]?.id, 'task-edge:direct');
		assert.deepStrictEqual(validateTaskBlueprint(updated), []);
	});

	test('병렬 Branch Work 삭제는 sibling을 보존하고 유효한 Join 연결을 복구한다', () => {
		const task = createTask();
		const [start, work, end] = task.nodes;
		const state = createTaskState([task], createSequentialIdSource());

		assert.ok(start && work && end);
		const branched = state.addParallelWork(task.id, task.edges[0]?.id ?? '');
		const parallel = branched?.nodes.find((node) => (
			node.kind === 'work' && node.id !== work.id
		));

		assert.ok(branched && parallel);
		const updated = state.removeWork(task.id, work.id);

		assert.ok(updated);
		assert.deepStrictEqual(readConnections(updated), [
			`${start.id}->${end.id}`,
			`${start.id}->${parallel.id}`,
			`${parallel.id}->${end.id}`,
		].sort());
		assert.deepStrictEqual(validateTaskBlueprint(updated), []);
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

	test('서로 다른 ID로 같은 source와 target을 잇는 중복 Edge를 거부한다', () => {
		const task = createTask();
		const edge = task.edges[0];

		assert.ok(edge);
		assertIssueCodes({
			...task,
			edges: [...task.edges, {
				...edge,
				id: 'task-edge:duplicate-connection',
			}],
		}, ['duplicate_edge']);
	});
});

function readConnections(task: TaskBlueprint): string[] {
	return task.edges.map((edge) => `${edge.source}->${edge.target}`).sort();
}

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
