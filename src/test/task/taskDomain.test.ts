import * as assert from 'assert';
import {
	assertValidTaskBlueprint,
	createDefaultTaskBlueprint,
	createTaskState,
	DEFAULT_WORK_AGENT_PROVIDER_ID,
	getTaskFlowAnalysis,
	getTaskFlowStatus,
	resolveEffectiveWorkGraphTargets,
	TASK_BLUEPRINT_VERSION,
	TASK_DEFAULT_END_POSITION,
	TASK_DEFAULT_WORK_VERTICAL_STRIDE,
	validateTaskBlueprint,
	type TaskBlueprint,
	type TaskIdSource,
	type TaskValidationIssueCode,
} from '../../task';

suite('Task Domain', () => {
	test('기본 Task는 연결되지 않은 Start/End와 End explicit position을 생성한다', () => {
		const task = createDefaultTaskBlueprint({
			title: 'Direct Task Graph',
			description: 'Connect ports directly.',
			origin: { x: 120, y: -40 },
		}, createSequentialIdSource());

		assert.strictEqual(task.version, TASK_BLUEPRINT_VERSION);
		assert.strictEqual(task.id, 'task:id-1');
		assert.strictEqual(task.title, 'Direct Task Graph');
		assert.strictEqual(task.description, 'Connect ports directly.');
		assert.deepStrictEqual(task.defaultGraphTargets, { reference: [], work: [] });
		assert.deepStrictEqual(task.origin, { x: 120, y: -40 });
		assert.deepStrictEqual(task.nodes, [
			{ id: 'task-node:id-2', kind: 'start' },
			{ id: 'task-node:id-3', kind: 'end' },
		]);
		assert.deepStrictEqual(task.nodePositions, {
			'task-node:id-3': TASK_DEFAULT_END_POSITION,
		});
		assert.deepStrictEqual(task.edges, []);
		assert.strictEqual(Object.hasOwn(task.nodePositions, 'task-node:id-2'), false);
		assert.deepStrictEqual(validateTaskBlueprint(task), []);
		assert.strictEqual(getTaskFlowStatus(task), 'incomplete');
	});

	test('Task 상태는 structural snapshot을 생성하고 ID로 조회·갱신·교체한다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const created = state.createTask({ title: 'Initial Task' });

		assert.strictEqual(state.getTask(created.id), created);
		assert.deepStrictEqual(state.getSnapshot().tasks, [created]);
		assert.strictEqual(Object.isFrozen(created), true);
		assert.strictEqual(Object.isFrozen(created.nodes), true);
		assert.strictEqual(Object.isFrozen(created.nodePositions), true);
		assert.strictEqual(Object.isFrozen(created.defaultGraphTargets), true);
		assert.strictEqual(Object.isFrozen(created.defaultGraphTargets.reference), true);
		assert.strictEqual(Object.isFrozen(created.defaultGraphTargets.work), true);

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

	test('removeTask는 대상 Task 전체만 제거하고 다른 Task를 보존한다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const first = state.createTask({ title: 'First Task' });
		const second = state.createTask({ title: 'Second Task' });
		const removed = state.removeTask(first.id);

		assert.strictEqual(removed, first);
		assert.strictEqual(state.getTask(first.id), undefined);
		assert.strictEqual(state.getTask(second.id), second);
		assert.deepStrictEqual(state.getSnapshot().tasks, [second]);
		const snapshot = state.getSnapshot();

		assert.strictEqual(state.removeTask('task:missing'), undefined);
		assert.strictEqual(state.getSnapshot(), snapshot);
	});

	test('Work를 Edge 없이 deterministic vertical lane에 추가한다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({ title: 'Placement Task' });
		const first = state.addWork(task.id, {
			title: 'First',
			agentProviderId: 'claude',
		});
		const second = state.addWork(task.id);
		const third = state.addWork(task.id);
		const fourth = state.addWork(task.id);

		assert.ok(first && second && third && fourth);
		const works = fourth.nodes.filter((node) => node.kind === 'work');

		assert.deepStrictEqual(works.map((node) => node.id), [
			'task-node:id-4',
			'task-node:id-5',
			'task-node:id-6',
			'task-node:id-7',
		]);
		assert.strictEqual(works[0]?.title, 'First');
		assert.strictEqual(works[1]?.title, 'New Work');
		assert.deepStrictEqual(works.map((node) => node.agentProviderId), [
			'claude',
			DEFAULT_WORK_AGENT_PROVIDER_ID,
			DEFAULT_WORK_AGENT_PROVIDER_ID,
			DEFAULT_WORK_AGENT_PROVIDER_ID,
		]);
		assert.deepStrictEqual(works.map((node) => fourth.nodePositions[node.id]), [
			{ x: 320, y: 0 },
			{ x: 320, y: TASK_DEFAULT_WORK_VERTICAL_STRIDE },
			{ x: 320, y: TASK_DEFAULT_WORK_VERTICAL_STRIDE * 2 },
			{ x: 320, y: TASK_DEFAULT_WORK_VERTICAL_STRIDE * 3 },
		]);
		assert.deepStrictEqual(works.map((node) => node.graphTargets), [
			{ reference: [], work: [] },
			{ reference: [], work: [] },
			{ reference: [], work: [] },
			{ reference: [], work: [] },
		]);
		assert.deepStrictEqual(fourth.edges, []);
		assert.deepStrictEqual(validateTaskBlueprint(fourth), []);
		assert.strictEqual(getTaskFlowStatus(fourth), 'incomplete');
		assert.strictEqual(state.addWork('task:missing'), undefined);
	});

	test('Task 기본/Work Graph Target은 immutable snapshot으로 교체하고 legacy 누락을 정규화한다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({ title: 'Target Snapshot' });
		const withWork = state.addWork(task.id);
		const work = withWork?.nodes.find((node) => node.kind === 'work');
		const defaultReference = ['folder:file:///workspace/docs'];
		const localReference = ['folder:file:///workspace/src'];
		const localWorkTargets = ['file:file:///workspace/src/main.ts'];

		assert.ok(withWork && work);
		const updated = state.updateTask(task.id, (current) => ({
			...current,
			defaultGraphTargets: {
				reference: defaultReference,
				work: [],
			},
			nodes: current.nodes.map((node) => node.id === work.id && node.kind === 'work'
				? {
					...node,
					graphTargets: { reference: localReference, work: localWorkTargets },
				}
				: node),
		}));
		const updatedWork = updated?.nodes.find((node) => node.id === work.id);

		assert.ok(updatedWork?.kind === 'work');
		assert.deepStrictEqual(updated?.defaultGraphTargets, {
			reference: ['folder:file:///workspace/docs'],
			work: [],
		});
		assert.strictEqual(Object.isFrozen(updated?.defaultGraphTargets), true);
		assert.strictEqual(Object.isFrozen(updated?.defaultGraphTargets.reference), true);
		assert.deepStrictEqual(updatedWork.graphTargets, {
			reference: ['folder:file:///workspace/src'],
			work: ['file:file:///workspace/src/main.ts'],
		});
		assert.strictEqual(Object.isFrozen(updatedWork.graphTargets), true);
		assert.strictEqual(Object.isFrozen(updatedWork.graphTargets.reference), true);
		assert.strictEqual(Object.isFrozen(updatedWork.graphTargets.work), true);
		defaultReference.length = 0;
		localReference.push('folder:file:///workspace/docs');
		localWorkTargets.length = 0;
		assert.deepStrictEqual(updated?.defaultGraphTargets, {
			reference: ['folder:file:///workspace/docs'],
			work: [],
		});
		assert.deepStrictEqual(updatedWork.graphTargets, {
			reference: ['folder:file:///workspace/src'],
			work: ['file:file:///workspace/src/main.ts'],
		});

		const legacyWork = {
			...work,
			agentProviderId: undefined,
			graphTargets: undefined,
		};
		const legacyTask = {
			...withWork,
			defaultGraphTargets: undefined,
			nodes: withWork.nodes.map((node) => node.id === work.id ? legacyWork : node),
		} as unknown as TaskBlueprint;
		const legacyState = createTaskState([legacyTask]);
		const normalized = legacyState.getTask(legacyTask.id)?.nodes.find(
			(node) => node.id === work.id,
		);

		assert.ok(normalized?.kind === 'work');
		assert.deepStrictEqual(
			legacyState.getTask(legacyTask.id)?.defaultGraphTargets,
			{ reference: [], work: [] },
		);
		assert.deepStrictEqual(normalized.graphTargets, { reference: [], work: [] });
		assert.strictEqual(
			normalized.agentProviderId,
			DEFAULT_WORK_AGENT_PROVIDER_ID,
		);
	});

	test('Work Agent provider는 Codex/Claude만 허용하고 잘못된 갱신을 commit하지 않는다', () => {
		const task = addWorks(createTask(), ['Agent Work']);
		const work = task.nodes.find((node) => node.kind === 'work');

		assert.ok(work?.kind === 'work');
		const invalidTask = {
			...task,
			nodes: task.nodes.map((node) => node.id === work.id
				? { ...node, agentProviderId: 'gemini' }
				: node),
		} as unknown as TaskBlueprint;

		assertIssueCodes(invalidTask, ['invalid_work_agent_provider']);
		const state = createTaskState([task]);
		const snapshot = state.getSnapshot();

		assert.throws(
			() => state.updateTask(task.id, () => invalidTask),
			/Work agent provider is invalid/,
		);
		assert.strictEqual(state.getSnapshot(), snapshot);
		const preservedWork = state.getTask(task.id)?.nodes.find(
			(node) => node.id === work.id,
		);

		assert.ok(preservedWork?.kind === 'work');
		assert.strictEqual(
			preservedWork.agentProviderId,
			DEFAULT_WORK_AGENT_PROVIDER_ID,
		);
	});

	test('Work 유효 범위는 Task 기본값과 Work 고유값을 Area별 stable union으로 파생한다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({
			title: 'Inherited Targets',
			defaultGraphTargets: {
				reference: ['folder:shared', 'file:default'],
				work: ['folder:shared'],
			},
		});
		const withWork = state.addWork(task.id);
		const work = withWork?.nodes.find((node) => node.kind === 'work');

		assert.ok(withWork && work?.kind === 'work');
		const updated = state.updateTask(task.id, (current) => ({
			...current,
			nodes: current.nodes.map((node) => node.id === work.id && node.kind === 'work'
				? {
					...node,
					graphTargets: {
						reference: ['folder:shared', 'file:local'],
						work: ['file:local', 'folder:shared'],
					},
				}
				: node),
		}));
		const updatedWork = updated?.nodes.find((node) => node.id === work.id);

		assert.ok(updated && updatedWork?.kind === 'work');
		assert.deepStrictEqual(resolveEffectiveWorkGraphTargets(updated, work.id), {
			reference: ['folder:shared', 'file:default', 'file:local'],
			work: ['folder:shared', 'file:local'],
		});
		assert.deepStrictEqual(updatedWork.graphTargets, {
			reference: ['folder:shared', 'file:local'],
			work: ['file:local', 'folder:shared'],
		});
		assert.strictEqual(resolveEffectiveWorkGraphTargets(updated, 'task-node:missing'), undefined);
	});

	test('Task 기본/Work Graph Target은 Area 내부 중복을 거부하고 양쪽 Area membership은 허용한다', () => {
		const base = addWorks(createTask(), ['Target Work']);
		const work = base.nodes.find((node) => node.kind === 'work');

		assert.ok(work);
		const replaceTargets = (graphTargets: unknown): TaskBlueprint => ({
			...base,
			nodes: base.nodes.map((node) => node.id === work.id
				? { ...node, graphTargets }
				: node),
		} as TaskBlueprint);

		assertIssueCodes(replaceTargets({ reference: 'src', work: [] }), [
			'invalid_graph_targets',
		]);
		assertIssueCodes(replaceTargets({
			reference: ['folder:src', 'folder:src'],
			work: [],
		}), ['duplicate_graph_target']);
		assert.deepStrictEqual(validateTaskBlueprint(replaceTargets({
			reference: ['folder:src'],
			work: ['folder:src'],
		})), []);
		assertIssueCodes({
			...base,
			defaultGraphTargets: { reference: ['folder:src', 'folder:src'], work: [] },
		}, ['duplicate_graph_target']);
		assert.deepStrictEqual(validateTaskBlueprint({
			...base,
			defaultGraphTargets: {
				reference: ['folder:src'],
				work: ['folder:src'],
			},
		}), []);
	});

	test('삭제로 빈 Work 기본 위치를 다음 추가에서 재사용한다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({ title: 'Reuse Position' });
		const first = state.addWork(task.id);
		const second = state.addWork(task.id);
		const firstWork = first?.nodes.find((node) => node.kind === 'work');

		assert.ok(second && firstWork);
		assert.ok(state.removeWork(task.id, firstWork.id));
		const added = state.addWork(task.id);
		const newest = added?.nodes.at(-1);

		assert.ok(added && newest?.kind === 'work');
		assert.deepStrictEqual(added.nodePositions[newest.id], { x: 320, y: 0 });
	});

	test('Work/End explicit position을 Task별 immutable snapshot으로 갱신한다', () => {
		const task = createTask();
		const state = createTaskState([task], createSequentialIdSource());
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');
		const added = state.addWork(task.id);
		const work = added?.nodes.find((node) => node.kind === 'work');
		const inputPosition = { x: 450, y: -70 };

		assert.ok(work);
		const workUpdated = state.setNodePosition(task.id, work.id, inputPosition);

		assert.deepStrictEqual(workUpdated?.nodePositions[work.id], { x: 450, y: -70 });
		assert.deepStrictEqual(workUpdated?.origin, task.origin);
		assert.strictEqual(Object.isFrozen(workUpdated?.nodePositions), true);
		assert.strictEqual(Object.isFrozen(workUpdated?.nodePositions[work.id]), true);
		inputPosition.x = 999;
		assert.deepStrictEqual(workUpdated?.nodePositions[work.id], { x: 450, y: -70 });

		const endUpdated = state.setNodePosition(task.id, end.id, { x: 700, y: 55 });
		assert.deepStrictEqual(endUpdated?.nodePositions[end.id], { x: 700, y: 55 });
		const snapshotBeforeInvalid = state.getSnapshot();

		assert.strictEqual(
			state.setNodePosition(task.id, start.id, { x: 1, y: 1 }),
			undefined,
		);
		assert.strictEqual(
			state.setNodePosition(task.id, 'task-node:missing', { x: 1, y: 1 }),
			undefined,
		);
		assert.strictEqual(
			state.setNodePosition(task.id, work.id, { x: Number.NaN, y: 0 }),
			undefined,
		);
		assert.strictEqual(
			state.setNodePosition(task.id, end.id, { x: 0, y: Infinity }),
			undefined,
		);
		assert.strictEqual(state.getSnapshot(), snapshotBeforeInvalid);
	});

	test('초기 nodePositions snapshot은 외부 record와 각 값을 복사해 동결한다', () => {
		const task = createTask();
		const end = getNode(task, 'end');
		const mutablePosition = { x: 640, y: 0 };
		const mutablePositions = { [end.id]: mutablePosition };
		const state = createTaskState([{
			...task,
			nodePositions: mutablePositions,
		}]);
		const snapshotPositions = state.getTask(task.id)?.nodePositions;

		mutablePosition.x = 999;
		delete mutablePositions[end.id];
		assert.deepStrictEqual(snapshotPositions, {
			[end.id]: { x: 640, y: 0 },
		});
		assert.strictEqual(Object.isFrozen(snapshotPositions), true);
		assert.strictEqual(Object.isFrozen(snapshotPositions?.[end.id]), true);
	});

	test('Start→End direct Edge를 연결·상태 주입·갱신할 수 없다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({ title: 'No Direct Edge Task' });
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');
		const snapshotBeforeConnect = state.getSnapshot();

		assert.strictEqual(state.canConnect(task.id, start.id, task.id, end.id), false);
		assert.strictEqual(state.connect(task.id, start.id, task.id, end.id), undefined);
		assert.strictEqual(state.getSnapshot(), snapshotBeforeConnect);
		const directEdgeTask: TaskBlueprint = {
			...task,
			edges: [{
				id: 'task-edge:direct',
				source: start.id,
				target: end.id,
			}],
		};

		assertIssueCodes(directEdgeTask, ['start_end_direct_edge']);
		assert.strictEqual(getTaskFlowStatus(directEdgeTask), 'incomplete');
		assert.throws(() => createTaskState([directEdgeTask]), /cannot connect directly/);
		assert.throws(() => state.replaceTasks([directEdgeTask]), /cannot connect directly/);
		assert.throws(() => state.updateTask(task.id, () => directEdgeTask), (
			error: unknown,
		) => error instanceof Error && /cannot connect directly/.test(error.message));
		assert.strictEqual(state.getSnapshot(), snapshotBeforeConnect);
	});

	test('disconnect는 정확한 Edge만 제거하고 structurally valid incomplete Task를 유지한다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({ title: 'Disconnect Task' });
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');
		const withWork = state.addWork(task.id);
		const work = withWork?.nodes.find((node) => node.kind === 'work');

		assert.ok(work);
		assert.ok(state.connect(task.id, start.id, task.id, work.id));
		const connected = state.connect(task.id, work.id, task.id, end.id);
		const edge = connected?.edges[0];

		assert.ok(edge);
		const disconnected = state.disconnect(task.id, edge.id);

		assert.ok(disconnected);
		assert.deepStrictEqual(disconnected.edges, connected.edges.slice(1));
		assert.deepStrictEqual(validateTaskBlueprint(disconnected), []);
		assert.strictEqual(getTaskFlowStatus(disconnected), 'incomplete');
		const snapshotBeforeMissing = state.getSnapshot();

		assert.strictEqual(state.disconnect(task.id, edge.id), undefined);
		assert.strictEqual(state.disconnect('task:missing', edge.id), undefined);
		assert.strictEqual(state.getSnapshot(), snapshotBeforeMissing);
	});

	test('canConnect/connect는 cross-task·missing·self·Port 방향 오류를 거부한다', () => {
		const taskA = createTask('Task A', 'a');
		const taskB: TaskBlueprint = {
			...taskA,
			id: 'task:b',
			title: 'Task B',
		};
		const state = createTaskState([taskA, taskB], createSequentialIdSource());
		const start = getNode(taskA, 'start');
		const end = getNode(taskA, 'end');

		for (const [sourceTaskId, sourceId, targetTaskId, targetId] of [
			[taskA.id, start.id, taskB.id, end.id],
			[taskA.id, 'task-node:missing', taskA.id, end.id],
			[taskA.id, start.id, taskA.id, 'task-node:missing'],
			[taskA.id, start.id, taskA.id, start.id],
			[taskA.id, end.id, taskA.id, start.id],
		] as const) {
			assert.strictEqual(
				state.canConnect(sourceTaskId, sourceId, targetTaskId, targetId),
				false,
			);
			assert.strictEqual(
				state.connect(sourceTaskId, sourceId, targetTaskId, targetId),
				undefined,
			);
		}
		assert.deepStrictEqual(state.getTask(taskA.id)?.edges, []);
		assert.deepStrictEqual(state.getTask(taskB.id)?.edges, []);
	});

	test('connect는 일반 Work DAG의 Branch/Join을 허용하고 cycle을 사전에 거부한다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({ title: 'Branch Task' });
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');
		state.addWork(task.id, { title: 'A' });
		const second = state.addWork(task.id, { title: 'B' });
		const works = second?.nodes.filter((node) => node.kind === 'work');

		assert.ok(second && works?.length === 2);
		const [workA, workB] = works;

		assert.ok(workA && workB);
		assert.ok(state.connect(task.id, start.id, task.id, workA.id));
		assert.ok(state.connect(task.id, start.id, task.id, workB.id));
		assert.ok(state.connect(task.id, workA.id, task.id, end.id));
		const ready = state.connect(task.id, workB.id, task.id, end.id);

		assert.ok(ready);
		assert.strictEqual(getTaskFlowStatus(ready), 'ready');
		assert.strictEqual(state.canConnect(task.id, workA.id, task.id, workB.id), true);
		assert.ok(state.connect(task.id, workA.id, task.id, workB.id));
		assert.strictEqual(state.canConnect(task.id, workB.id, task.id, workA.id), false);
		assert.strictEqual(
			state.connect(task.id, workB.id, task.id, workA.id),
			undefined,
		);
	});

	test('removeWork는 복수 predecessor/successor에서도 incident 자료만 제거하고 rewrite하지 않는다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({ title: 'Remove Work' });
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');
		state.addWork(task.id, { title: 'A' });
		state.addWork(task.id, { title: 'B' });
		const withWorks = state.addWork(task.id, { title: 'C' });
		const works = withWorks?.nodes.filter((node) => node.kind === 'work');

		assert.ok(works?.length === 3);
		const [workA, workB, workC] = works;

		assert.ok(workA && workB && workC);
		assert.ok(state.connect(task.id, start.id, task.id, workA.id));
		assert.ok(state.connect(task.id, start.id, task.id, workB.id));
		assert.ok(state.connect(task.id, workA.id, task.id, workB.id));
		assert.ok(state.connect(task.id, workB.id, task.id, workC.id));
		assert.ok(state.connect(task.id, workB.id, task.id, end.id));
		assert.ok(state.connect(task.id, workC.id, task.id, end.id));
		const before = state.getTask(task.id);
		const untouchedEdgeIds = before?.edges.filter((edge) => (
			edge.source !== workB.id && edge.target !== workB.id
		)).map((edge) => edge.id);
		const updated = state.removeWork(task.id, workB.id);

		assert.ok(updated);
		assert.strictEqual(updated.nodes.some((node) => node.id === workB.id), false);
		assert.strictEqual(Object.hasOwn(updated.nodePositions, workB.id), false);
		assert.strictEqual(updated.edges.some((edge) => (
			edge.source === workB.id || edge.target === workB.id
		)), false);
		assert.deepStrictEqual(updated.edges.map((edge) => edge.id), untouchedEdgeIds);
		assert.strictEqual(updated.edges.some((edge) => (
			edge.source === workA.id && edge.target === workC.id
		)), false);
		assert.deepStrictEqual(validateTaskBlueprint(updated), []);
		assert.strictEqual(state.removeWork(task.id, start.id), undefined);
		assert.strictEqual(state.removeWork(task.id, end.id), undefined);
		assert.strictEqual(state.removeWork(task.id, 'task-node:missing'), undefined);
	});

	test('마지막 Work 삭제는 Start→End 우회 Edge를 복구하지 않는다', () => {
		const state = createTaskState([], createSequentialIdSource());
		const task = state.createTask({ title: 'Remove Last Work' });
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');
		const withWork = state.addWork(task.id);
		const work = withWork?.nodes.find((node) => node.kind === 'work');

		assert.ok(work);
		assert.ok(state.connect(task.id, start.id, task.id, work.id));
		assert.ok(state.connect(task.id, work.id, task.id, end.id));
		const removed = state.removeWork(task.id, work.id);

		assert.ok(removed);
		assert.deepStrictEqual(removed.nodes.map((node) => node.kind), ['start', 'end']);
		assert.deepStrictEqual(removed.edges, []);
		assert.deepStrictEqual(validateTaskBlueprint(removed), []);
		assert.strictEqual(getTaskFlowStatus(removed), 'incomplete');
	});

	test('Structural validation은 disconnected Task를 허용하고 Start/End 개수를 강제한다', () => {
		const task = createTask();
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');

		assert.deepStrictEqual(validateTaskBlueprint(task), []);
		assertIssueCodes({
			...task,
			nodes: task.nodes.filter((node) => node.kind !== 'start'),
		}, ['start_node_count']);
		assertIssueCodes({
			...task,
			nodes: [...task.nodes, { ...start, id: 'task-node:start-copy' }],
		}, ['start_node_count']);
		assertIssueCodes({
			...task,
			nodes: task.nodes.filter((node) => node.kind !== 'end'),
			nodePositions: {},
		}, ['end_node_count']);
		assertIssueCodes({
			...task,
			nodes: [...task.nodes, { ...end, id: 'task-node:end-copy' }],
			nodePositions: {
				...task.nodePositions,
				'task-node:end-copy': { x: 800, y: 28 },
			},
		}, ['end_node_count']);
	});

	test('Structural validation은 Work/End position missing·extra·Start·non-finite를 거부한다', () => {
		const task = createTask();
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');

		assertIssueCodes({ ...task, nodePositions: {} }, ['node_position_missing']);
		assertIssueCodes({
			...task,
			nodePositions: {
				...task.nodePositions,
				'task-node:missing': { x: 10, y: 20 },
			},
		}, ['node_position_extra']);
		assertIssueCodes({
			...task,
			nodePositions: {
				...task.nodePositions,
				[start.id]: { x: 0, y: 0 },
			},
		}, ['start_node_position']);
		assertIssueCodes({
			...task,
			nodePositions: {
				[end.id]: { x: Number.NaN, y: Number.NEGATIVE_INFINITY },
			},
		}, ['invalid_node_position']);

		const state = createTaskState([task]);
		const snapshotBeforeInvalid = state.getSnapshot();

		assert.throws(() => state.updateTask(task.id, (current) => ({
			...current,
			nodePositions: {},
		})), /node position is required/);
		assert.strictEqual(state.getSnapshot(), snapshotBeforeInvalid);
	});

	test('Structural validation은 dangling·self·duplicate Edge와 cycle을 거부한다', () => {
		const task = createTask();
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');

		assertIssueCodes({
			...task,
			edges: [{
				id: 'task-edge:missing-source',
				source: 'task-node:missing',
				target: end.id,
			}, {
				id: 'task-edge:missing-target',
				source: start.id,
				target: 'task-node:missing',
			}],
		}, ['edge_source_missing', 'edge_target_missing']);

		const withWorks = addWorks(task, ['A', 'B']);
		const [workA, workB] = withWorks.nodes.filter((node) => node.kind === 'work');

		assert.ok(workA && workB);
		assertIssueCodes({
			...withWorks,
			edges: [{ id: 'task-edge:self', source: workA.id, target: workA.id }],
		}, ['self_edge']);
		assertIssueCodes({
			...task,
			edges: [{ id: 'task-edge:one', source: start.id, target: end.id }, {
				id: 'task-edge:two',
				source: start.id,
				target: end.id,
			}],
		}, ['duplicate_edge']);
		const cyclicTask: TaskBlueprint = {
			...withWorks,
			edges: [{ id: 'task-edge:cycle-a', source: workA.id, target: workB.id }, {
				id: 'task-edge:cycle-b',
				source: workB.id,
				target: workA.id,
			}],
		};

		assertIssueCodes(cyclicTask, ['cycle']);
		assert.strictEqual(getTaskFlowStatus(cyclicTask), 'incomplete');
	});

	test('Structural validation은 Start incoming과 End outgoing Port 방향을 거부한다', () => {
		const task = createTask();
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');
		const withWork = addWorks(task, ['A']);
		const work = withWork.nodes.find((node) => node.kind === 'work');

		assert.ok(work);
		assertIssueCodes({
			...withWork,
			edges: [{ id: 'task-edge:into-start', source: work.id, target: start.id }, {
				id: 'task-edge:out-of-end',
				source: end.id,
				target: work.id,
			}],
		}, ['start_node_incoming', 'end_node_outgoing']);
	});

	test('Flow status는 orphan/source/leaf Work를 incomplete로 유지한다', () => {
		const orphan = addWorks(createTask(), ['Orphan']);
		const start = getNode(orphan, 'start');
		const end = getNode(orphan, 'end');
		const work = orphan.nodes.find((node) => node.kind === 'work');

		assert.ok(work);
		assert.strictEqual(getTaskFlowStatus(orphan), 'incomplete');
		assert.strictEqual(getTaskFlowStatus({
			...orphan,
			edges: [...orphan.edges, {
				id: 'task-edge:work-end',
				source: work.id,
				target: end.id,
			}],
		}), 'incomplete');
		assert.strictEqual(getTaskFlowStatus({
			...orphan,
			edges: [...orphan.edges, {
				id: 'task-edge:start-work',
				source: start.id,
				target: work.id,
			}],
		}), 'incomplete');
	});

	test('Flow status는 모든 Work가 Start에서 End로 이어진 Branch/Join을 ready로 판별한다', () => {
		const task = addWorks(createTask(), ['A', 'B']);
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');
		const works = task.nodes.filter((node) => node.kind === 'work');
		const edges = works.flatMap((work, index) => [{
			id: `task-edge:start-${index}`,
			source: start.id,
			target: work.id,
		}, {
			id: `task-edge:end-${index}`,
			source: work.id,
			target: end.id,
		}]);
		const ready = { ...task, edges };

		assert.deepStrictEqual(validateTaskBlueprint(ready), []);
		assert.strictEqual(getTaskFlowStatus(ready), 'ready');
		assert.strictEqual(getTaskFlowStatus({
			...ready,
			nodePositions: {},
		}), 'incomplete');
	});

	test('Flow status는 고립 Work는 무시하고 Boundary 한쪽에만 연결된 Work는 incomplete로 판별한다', () => {
		const task = addWorks(createTask(), [
			'Connected',
			'Start Only',
			'End Only',
			'Unused',
		]);
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');
		const [connectedWork, startOnlyWork, endOnlyWork, unusedWork] = task.nodes.filter(
			(node) => node.kind === 'work',
		);

		assert.ok(connectedWork && startOnlyWork && endOnlyWork && unusedWork);
		const withUnusedWork: TaskBlueprint = {
			...task,
			edges: [{
				id: 'task-edge:start-connected',
				source: start.id,
				target: connectedWork.id,
			}, {
				id: 'task-edge:connected-end',
				source: connectedWork.id,
				target: end.id,
			}],
		};
		const analysis = getTaskFlowAnalysis(withUnusedWork);

		assert.strictEqual(analysis.status, 'ready');
		assert.strictEqual(analysis.connectedNodeIds.size, 3);
		assert.strictEqual(analysis.connectedNodeIds.has(start.id), true);
		assert.strictEqual(analysis.connectedNodeIds.has(connectedWork.id), true);
		assert.strictEqual(analysis.connectedNodeIds.has(end.id), true);
		assert.strictEqual(analysis.connectedNodeIds.has(unusedWork.id), false);

		const withIncompleteBoundaryConnections: TaskBlueprint = {
			...withUnusedWork,
			edges: [...withUnusedWork.edges, {
				id: 'task-edge:start-only',
				source: start.id,
				target: startOnlyWork.id,
			}, {
				id: 'task-edge:end-only',
				source: endOnlyWork.id,
				target: end.id,
			}],
		};
		const incompleteAnalysis = getTaskFlowAnalysis(
			withIncompleteBoundaryConnections,
		);

		assert.strictEqual(incompleteAnalysis.status, 'incomplete');
		assert.strictEqual(
			incompleteAnalysis.connectedNodeIds.has(connectedWork.id),
			true,
		);
		assert.strictEqual(
			incompleteAnalysis.connectedNodeIds.has(startOnlyWork.id),
			false,
		);
		assert.strictEqual(
			incompleteAnalysis.connectedNodeIds.has(endOnlyWork.id),
			false,
		);
	});

	test('중복 Task ID와 중복 Node/Edge ID를 거부하고 Task 내부 ID는 다른 Task와 격리한다', () => {
		const task = createTask();
		const start = getNode(task, 'start');
		const end = getNode(task, 'end');

		assert.throws(() => createTaskState([task, task]), /Task ID must be unique/);
		assertIssueCodes({
			...task,
			nodes: [...task.nodes, task.nodes[0]],
		}, ['duplicate_node_id']);
		assertIssueCodes({
			...task,
			edges: [{ id: 'task-edge:same', source: start.id, target: end.id }, {
				id: 'task-edge:same',
				source: start.id,
				target: end.id,
			}],
		}, ['duplicate_edge_id']);

		const taskB = { ...task, id: 'task:other' };
		const state = createTaskState([task, taskB]);

		assert.strictEqual(
			state.canConnect(task.id, start.id, taskB.id, end.id),
			false,
		);
		assert.strictEqual(
			state.connect(task.id, start.id, taskB.id, end.id),
			undefined,
		);
		assert.deepStrictEqual(state.getTask(task.id)?.edges, []);
		assert.deepStrictEqual(state.getTask(taskB.id)?.edges, []);
	});
});

function getNode(
	task: TaskBlueprint,
	kind: 'start' | 'end',
): TaskBlueprint['nodes'][number] {
	const node = task.nodes.find((candidate) => candidate.kind === kind);

	assert.ok(node);
	return node;
}

/** 정상 기본 Task에 disconnected Work를 지정한 순서로 추가한다. */
function addWorks(task: TaskBlueprint, titles: readonly string[]): TaskBlueprint {
	let sequence = 0;
	const state = createTaskState([task], () => `fixture-${++sequence}`);

	for (const title of titles) {
		assert.ok(state.addWork(task.id, { title }));
	}

	const updated = state.getTask(task.id);

	assert.ok(updated);
	return updated;
}

/** 결정적인 ID를 사용하는 정상 기본 Task를 만든다. */
function createTask(title = 'Task', prefix = 'id'): TaskBlueprint {
	return createDefaultTaskBlueprint(
		{ title },
		createSequentialIdSource(prefix),
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
function createSequentialIdSource(prefix = 'id'): TaskIdSource {
	let sequence = 0;
	return () => `${prefix}-${++sequence}`;
}
