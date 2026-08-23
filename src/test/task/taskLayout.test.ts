import * as assert from 'assert';
import {
	createDefaultTaskBlueprint,
	createTaskState,
	type TaskBlueprint,
} from '../../task';
import {
	createTaskGraphLayout,
	getCubicBezierPoint,
	TASK_END_NODE_HEIGHT,
	TASK_END_NODE_WIDTH,
	TASK_NODE_HORIZONTAL_GAP,
	TASK_NODE_VERTICAL_GAP,
	TASK_NODE_WIDTH,
	TASK_START_NODE_HEIGHT,
	TASK_WORK_NODE_HEIGHT,
} from '../../webview/task/taskLayout';

suite('Task Layout', () => {
	test('Start → Work → End를 Left → Right rank와 공통 중심선에 배치한다', () => {
		const task = createTask({ x: 120, y: -40 });
		const layout = createTaskGraphLayout([task]);
		const [startNode, workNode, endNode] = layout.nodes;

		assert.ok(startNode);
		assert.ok(workNode);
		assert.ok(endNode);
		assert.strictEqual(startNode.kind, 'start');
		assert.strictEqual(workNode.kind, 'work');
		assert.strictEqual(endNode.kind, 'end');
		assert.deepStrictEqual(
			layout.nodes.map((node) => node.rank),
			[0, 1, 2],
		);
		assert.deepStrictEqual(startNode.localPosition, { x: 0, y: 0 });
		assert.deepStrictEqual(workNode.localPosition, {
			x: TASK_NODE_WIDTH + TASK_NODE_HORIZONTAL_GAP,
			y: (TASK_START_NODE_HEIGHT - TASK_WORK_NODE_HEIGHT) / 2,
		});
		assert.deepStrictEqual(endNode.localPosition, {
			x: (TASK_NODE_WIDTH + TASK_NODE_HORIZONTAL_GAP) * 2,
			y: (TASK_START_NODE_HEIGHT - TASK_END_NODE_HEIGHT) / 2,
		});
		assert.ok(startNode.position.x < workNode.position.x);
		assert.ok(workNode.position.x < endNode.position.x);
		assert.deepStrictEqual([
			startNode.position.y + startNode.height / 2,
			workNode.position.y + workNode.height / 2,
			endNode.position.y + endNode.height / 2,
		], [12, 12, 12]);
		assert.strictEqual(startNode.height, TASK_START_NODE_HEIGHT);
		assert.strictEqual(workNode.height, TASK_WORK_NODE_HEIGHT);
		assert.strictEqual(endNode.width, TASK_END_NODE_WIDTH);
		assert.strictEqual(endNode.height, TASK_END_NODE_HEIGHT);
		assert.deepStrictEqual(layout.edges.map((edge) => ({
			id: edge.id,
			taskId: edge.taskId,
			sourceId: edge.sourceId,
			targetId: edge.targetId,
		})), task.edges.map((edge) => ({
			id: edge.id,
			taskId: task.id,
			sourceId: edge.source,
			targetId: edge.target,
		})));
		assert.deepStrictEqual(layout.edges.map((edge) => edge.geometry.midpoint), [
			{ x: 432, y: 12 },
			{ x: 776, y: 12 },
		]);
		assert.deepStrictEqual(layout.edges[0]?.geometry, {
			start: { x: 400, y: 12 },
			control1: { x: 432, y: 12 },
			control2: { x: 432, y: 12 },
			end: { x: 464, y: 12 },
			midpoint: { x: 432, y: 12 },
		});
		for (const edge of layout.edges) {
			assert.deepStrictEqual(
				edge.geometry.midpoint,
				getCubicBezierPoint(
					edge.geometry.start,
					edge.geometry.control1,
					edge.geometry.control2,
					edge.geometry.end,
					0.5,
				),
			);
		}
		assert.deepStrictEqual(
			layout.edges.map((edge) => edge.canAddParallelWork),
			[true, false],
		);
	});

	test('cubic Bézier helper는 control point를 포함한 실제 t=0.5 위치를 계산한다', () => {
		assert.deepStrictEqual(getCubicBezierPoint(
			{ x: 0, y: 0 },
			{ x: 100, y: 200 },
			{ x: 200, y: 200 },
			{ x: 300, y: 0 },
			0.5,
		), { x: 150, y: 150 });
	});

	test('origin 이동을 Node와 Edge/Action geometry에 같은 world delta로 적용한다', () => {
		const task = createTask({ x: 120, y: -40 });
		const movedTask: TaskBlueprint = {
			...task,
			origin: { x: 420, y: 160 },
		};
		const initialLayout = createTaskGraphLayout([task]);
		const movedLayout = createTaskGraphLayout([movedTask]);

		for (let index = 0; index < initialLayout.nodes.length; index += 1) {
			const initialNode = initialLayout.nodes[index];
			const movedNode = movedLayout.nodes[index];

			assert.ok(initialNode);
			assert.ok(movedNode);
			assert.deepStrictEqual(movedNode.localPosition, initialNode.localPosition);
			assert.deepStrictEqual(initialNode.position, {
				x: task.origin.x + initialNode.localPosition.x,
				y: task.origin.y + initialNode.localPosition.y,
			});
			assert.deepStrictEqual(movedNode.position, {
				x: movedTask.origin.x + movedNode.localPosition.x,
				y: movedTask.origin.y + movedNode.localPosition.y,
			});
			assert.deepStrictEqual({
				x: movedNode.position.x - initialNode.position.x,
				y: movedNode.position.y - initialNode.position.y,
			}, { x: 300, y: 200 });
		}
		assertGeometryDelta(initialLayout, movedLayout, { x: 300, y: 200 });
	});

	test('동일한 내부 Node와 Edge ID를 Task별 origin 및 endpoint로 격리한다', () => {
		const taskA: TaskBlueprint = {
			...createTask({ x: 100, y: 50 }),
			id: 'task:00000000-0000-4000-8000-000000000001',
		};
		const taskB: TaskBlueprint = {
			...createTask({ x: -300, y: 400 }),
			id: 'task:00000000-0000-4000-8000-000000000002',
		};
		const layout = createTaskGraphLayout([taskA, taskB]);
		const taskANodes = layout.nodes.filter((node) => node.taskId === taskA.id);
		const taskBNodes = layout.nodes.filter((node) => node.taskId === taskB.id);
		const taskAEdges = layout.edges.filter((edge) => edge.taskId === taskA.id);
		const taskBEdges = layout.edges.filter((edge) => edge.taskId === taskB.id);

		assert.deepStrictEqual(
			taskANodes.map((node) => node.id),
			taskBNodes.map((node) => node.id),
		);
		assert.deepStrictEqual(
			taskAEdges.map((edge) => edge.id),
			taskBEdges.map((edge) => edge.id),
		);
		assert.deepStrictEqual(taskANodes[0]?.position, taskA.origin);
		assert.deepStrictEqual(taskBNodes[0]?.position, taskB.origin);

		for (const [task, taskNodes, taskEdges] of [
			[taskA, taskANodes, taskAEdges],
			[taskB, taskBNodes, taskBEdges],
		] as const) {
			const nodeIds = new Set(taskNodes.map((node) => node.id));

			assert.ok(taskNodes.every((node) => node.taskId === task.id));
			assert.ok(taskEdges.every((edge) => (
				edge.taskId === task.id
					&& nodeIds.has(edge.sourceId)
					&& nodeIds.has(edge.targetId)
			)));
		}
	});

	test('병렬 Work를 같은 rank의 세로 stack에 배치하고 다음 rank에서 Join한다', () => {
		const task = createTask({ x: 120, y: -40 });
		let sequence = 0;
		const state = createTaskState([task], () => `parallel-${++sequence}`);
		const incoming = task.edges[0];

		assert.ok(incoming);
		const updated = state.addParallelWork(task.id, incoming.id);
		assert.ok(updated);
		const layout = createTaskGraphLayout([updated]);
		const works = layout.nodes.filter((node) => node.kind === 'work');
		const start = layout.nodes.find((node) => node.kind === 'start');
		const end = layout.nodes.find((node) => node.kind === 'end');

		assert.ok(start && end);
		assert.strictEqual(works.length, 2);
		assert.deepStrictEqual(works.map((node) => node.rank), [1, 1]);
		assert.strictEqual(works[0]?.position.x, works[1]?.position.x);
		assert.notStrictEqual(works[0]?.position.y, works[1]?.position.y);
		assert.ok((works[1]?.position.y ?? 0) >= (
			(works[0]?.position.y ?? 0) + TASK_WORK_NODE_HEIGHT + TASK_NODE_VERTICAL_GAP
		));
		assert.strictEqual(start.rank, 0);
		assert.strictEqual(end.rank, 2);
		assert.ok(end.position.x > (works[0]?.position.x ?? 0));
		assert.strictEqual(
			start.position.y + start.height / 2,
			end.position.y + end.height / 2,
		);
		assert.strictEqual(
			((works[0]?.position.y ?? 0) + TASK_WORK_NODE_HEIGHT / 2
				+ (works[1]?.position.y ?? 0) + TASK_WORK_NODE_HEIGHT / 2) / 2,
			start.position.y + start.height / 2,
		);
		assert.strictEqual(
			layout.edges.filter((edge) => edge.targetId === end.id).length,
			2,
		);
		assert.strictEqual(
			new Set(
				layout.edges
					.filter((edge) => edge.sourceId === start.id)
					.map((edge) => edge.geometry.start.y),
			).size,
			2,
		);
		assert.strictEqual(
			new Set(
				layout.edges
					.filter((edge) => edge.targetId === end.id)
					.map((edge) => edge.geometry.end.y),
			).size,
			2,
		);
	});

	test('병렬 Work 수가 늘어도 rank의 가로 폭 대신 세로 bounds만 확장한다', () => {
		const task = createTask({ x: 120, y: -40 });
		const [start, work, end] = task.nodes;

		assert.ok(start && work?.kind === 'work' && end);
		const workB = {
			...work,
			id: 'task-node:parallel-b',
			title: 'Parallel B',
		};
		const workC = {
			...work,
			id: 'task-node:parallel-c',
			title: 'Parallel C',
		};
		const workD = {
			...work,
			id: 'task-node:parallel-d',
			title: 'Parallel D',
		};
		const parallelTask: TaskBlueprint = {
			...task,
			nodes: [...task.nodes, workB, workC, workD],
			edges: [work, workB, workC, workD].flatMap((parallelWork, index) => ([{
				id: `task-edge:parallel-in-${index}`,
				source: start.id,
				target: parallelWork.id,
			}, {
				id: `task-edge:parallel-out-${index}`,
				source: parallelWork.id,
				target: end.id,
			}])),
		};
		const layout = createTaskGraphLayout([parallelTask]);
		const works = layout.nodes
			.filter((node) => node.kind === 'work')
			.sort((left, right) => left.position.y - right.position.y);
		const endLayout = layout.nodes.find((node) => node.kind === 'end');

		assert.strictEqual(new Set(works.map((node) => node.position.x)).size, 1);
		assert.deepStrictEqual(works.map((node) => node.rank), [1, 1, 1, 1]);
		for (let index = 1; index < works.length; index += 1) {
			const previous = works[index - 1];
			const current = works[index];

			assert.ok(previous && current);
			assert.ok(current.position.y >= (
				previous.position.y + previous.height + TASK_NODE_VERTICAL_GAP
			));
		}
		assert.strictEqual(
			endLayout?.position.x,
			task.origin.x + (TASK_NODE_WIDTH + TASK_NODE_HORIZONTAL_GAP) * 2,
		);
		assert.strictEqual(
			endLayout ? endLayout.position.y + endLayout.height / 2 : undefined,
			works.reduce((sum, node) => sum + node.position.y + node.height / 2, 0)
				/ works.length,
		);
		assert.strictEqual(
			layout.edges.filter((edge) => edge.canAddParallelWork).length,
			4,
		);
	});

	test('상단 Branch Edge에 삽입한 Work가 predecessor lane을 이어받는다', () => {
		const task = createBranchTask({ x: 40, y: 70 });
		let sequence = 0;
		const state = createTaskState([task], () => `upper-${++sequence}`);
		const before = createTaskGraphLayout([task]);
		const updated = state.insertWorkBetween(task.id, 'task-edge:a-c');
		const inserted = updated?.nodes.find((node) => (
			node.kind === 'work' && !task.nodes.some((current) => current.id === node.id)
		));

		assert.ok(updated && inserted);
		const after = createTaskGraphLayout([updated]);
		const beforeA = readNodeCenterY(before, 'task-node:a');
		const beforeB = readNodeCenterY(before, 'task-node:b');
		const afterA = readNodeCenterY(after, 'task-node:a');
		const afterB = readNodeCenterY(after, 'task-node:b');
		const insertedY = readNodeCenterY(after, inserted.id);
		const joinY = readNodeCenterY(after, 'task-node:c');

		assert.ok(beforeA < beforeB);
		assert.ok(afterA < afterB);
		assert.strictEqual(insertedY, afterA);
		assert.ok(insertedY < afterB);
		assert.strictEqual(joinY, (insertedY + afterB) / 2);
	});

	test('하단 Branch Edge에 삽입한 Work가 predecessor lane을 이어받는다', () => {
		const task = createBranchTask({ x: 40, y: 70 });
		let sequence = 0;
		const state = createTaskState([task], () => `lower-${++sequence}`);
		const updated = state.insertWorkBetween(task.id, 'task-edge:b-c');
		const inserted = updated?.nodes.find((node) => (
			node.kind === 'work' && !task.nodes.some((current) => current.id === node.id)
		));

		assert.ok(updated && inserted);
		const layout = createTaskGraphLayout([updated]);
		const aY = readNodeCenterY(layout, 'task-node:a');
		const bY = readNodeCenterY(layout, 'task-node:b');
		const insertedY = readNodeCenterY(layout, inserted.id);

		assert.ok(aY < bY);
		assert.strictEqual(insertedY, bY);
		assert.ok(insertedY > aY);
	});

	test('Branch 첫 Edge 분할도 기존 sibling 순서와 선택 Branch lane을 보존한다', () => {
		const task = createBranchTask({ x: 40, y: 70 });
		let sequence = 0;
		const state = createTaskState([task], () => `branch-entry-${++sequence}`);
		const updated = state.insertWorkBetween(task.id, 'task-edge:start-a');
		const inserted = updated?.nodes.find((node) => (
			node.kind === 'work' && !task.nodes.some((current) => current.id === node.id)
		));

		assert.ok(updated && inserted);
		const layout = createTaskGraphLayout([updated]);
		const insertedY = readNodeCenterY(layout, inserted.id);
		const aY = readNodeCenterY(layout, 'task-node:a');
		const bY = readNodeCenterY(layout, 'task-node:b');

		assert.strictEqual(aY, insertedY);
		assert.ok(insertedY < bY);
	});

	test('같은 Branch의 연속 삽입 Work가 동일한 lane을 유지한다', () => {
		const task = createBranchTask({ x: 40, y: 70 });
		let sequence = 0;
		const state = createTaskState([task], () => `serial-lane-${++sequence}`);
		const first = state.insertWorkBetween(task.id, 'task-edge:a-c');
		const firstInserted = first?.nodes.find((node) => (
			node.kind === 'work' && !task.nodes.some((current) => current.id === node.id)
		));

		assert.ok(first && firstInserted);
		const nextEdge = first.edges.find((edge) => (
			edge.source === firstInserted.id && edge.target === 'task-node:c'
		));

		assert.ok(nextEdge);
		const second = state.insertWorkBetween(task.id, nextEdge.id);
		const secondInserted = second?.nodes.find((node) => (
			node.kind === 'work'
				&& !first.nodes.some((current) => current.id === node.id)
		));

		assert.ok(second && secondInserted);
		const layout = createTaskGraphLayout([second]);
		assert.deepStrictEqual([
			readNodeCenterY(layout, 'task-node:a'),
			readNodeCenterY(layout, firstInserted.id),
			readNodeCenterY(layout, secondInserted.id),
		], [
			readNodeCenterY(layout, 'task-node:a'),
			readNodeCenterY(layout, 'task-node:a'),
			readNodeCenterY(layout, 'task-node:a'),
		]);
	});

	test('동일 topology의 task.nodes 순서가 달라도 Branch 위치가 뒤집히지 않는다', () => {
		const task = createBranchTask({ x: 40, y: 70 });
		const reordered: TaskBlueprint = {
			...task,
			nodes: [...task.nodes].reverse(),
		};
		const initial = createTaskGraphLayout([task]);
		const shuffled = createTaskGraphLayout([reordered]);

		for (const node of task.nodes) {
			const initialNode = initial.nodes.find((candidate) => candidate.id === node.id);
			const shuffledNode = shuffled.nodes.find((candidate) => candidate.id === node.id);

			assert.ok(initialNode && shuffledNode);
			assert.deepStrictEqual(shuffledNode.localPosition, initialNode.localPosition);
		}
	});

	test('직렬 삽입은 longest path rank를 늘리고 origin 이동은 DAG 전체에 적용된다', () => {
		const task = createTask({ x: 20, y: 30 });
		let sequence = 0;
		const state = createTaskState([task], () => `serial-${++sequence}`);
		const selectedEdge = task.edges[0];

		assert.ok(selectedEdge);
		const updated = state.insertWorkBetween(task.id, selectedEdge.id);
		assert.ok(updated);
		const initialLayout = createTaskGraphLayout([updated]);
		const movedLayout = createTaskGraphLayout([{
			...updated,
			origin: { x: 170, y: -50 },
		}]);

		assert.deepStrictEqual(
			[...initialLayout.nodes].sort((left, right) => left.rank - right.rank)
				.map((node) => node.rank),
			[0, 1, 2, 3],
		);
		for (let index = 0; index < initialLayout.nodes.length; index += 1) {
			const initial = initialLayout.nodes[index];
			const moved = movedLayout.nodes[index];

			assert.ok(initial && moved);
			assert.deepStrictEqual({
				x: moved.position.x - initial.position.x,
				y: moved.position.y - initial.position.y,
			}, { x: 150, y: -80 });
		}
		assertGeometryDelta(initialLayout, movedLayout, { x: 150, y: -80 });
	});
});

function assertGeometryDelta(
	initialLayout: ReturnType<typeof createTaskGraphLayout>,
	movedLayout: ReturnType<typeof createTaskGraphLayout>,
	delta: { readonly x: number; readonly y: number },
): void {
	for (let index = 0; index < initialLayout.edges.length; index += 1) {
		const initial = initialLayout.edges[index];
		const moved = movedLayout.edges[index];

		assert.ok(initial && moved);
		for (const point of ['start', 'control1', 'control2', 'end', 'midpoint'] as const) {
			assert.deepStrictEqual({
				x: moved.geometry[point].x - initial.geometry[point].x,
				y: moved.geometry[point].y - initial.geometry[point].y,
			}, delta);
		}
	}
}

function readNodeCenterY(
	layout: ReturnType<typeof createTaskGraphLayout>,
	nodeId: string,
): number {
	const node = layout.nodes.find((candidate) => candidate.id === nodeId);

	assert.ok(node, `Layout Node ${nodeId}가 있어야 한다.`);
	return node.position.y + node.height / 2;
}

function createBranchTask(
	origin: { readonly x: number; readonly y: number },
): TaskBlueprint {
	const task = createTask(origin);
	const [start, work, end] = task.nodes;

	assert.ok(start && work?.kind === 'work' && end);
	const workA = { ...work, id: 'task-node:a', title: 'Work A' };
	const workB = { ...work, id: 'task-node:b', title: 'Work B' };
	const workC = { ...work, id: 'task-node:c', title: 'Work C' };

	return {
		...task,
		nodes: [start, workA, workB, workC, end],
		edges: [{
			id: 'task-edge:start-a',
			source: start.id,
			target: workA.id,
		}, {
			id: 'task-edge:start-b',
			source: start.id,
			target: workB.id,
		}, {
			id: 'task-edge:a-c',
			source: workA.id,
			target: workC.id,
		}, {
			id: 'task-edge:b-c',
			source: workB.id,
			target: workC.id,
		}, {
			id: 'task-edge:c-end',
			source: workC.id,
			target: end.id,
		}],
	};
}

/** 고정 ID와 표시 내용을 가진 기본 Task를 만든다. */
function createTask(origin: { readonly x: number; readonly y: number }) {
	let sequence = 0;

	return createDefaultTaskBlueprint({
		title: 'Render Task Graph',
		description: 'Show the task on the shared canvas.',
		origin,
		work: {
			title: 'Render nodes',
			description: 'Render Start, Work, and End.',
			prompt: 'Use the existing graph world.',
		},
	}, () => `layout-${++sequence}`);
}
