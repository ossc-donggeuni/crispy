import * as assert from 'assert';
import { createDefaultTaskBlueprint, type TaskBlueprint } from '../../task';
import {
	createTaskGraphLayout,
	TASK_END_NODE_HEIGHT,
	TASK_END_NODE_WIDTH,
	TASK_NODE_VERTICAL_GAP,
	TASK_NODE_WIDTH,
	TASK_START_NODE_HEIGHT,
	TASK_WORK_NODE_HEIGHT,
} from '../../webview/task/taskLayout';

suite('Task Layout', () => {
	test('Blueprint 순서대로 Start → Work → End 세로 Layout과 Edge를 만든다', () => {
		const task = createTask({ x: 120, y: -40 });
		const layout = createTaskGraphLayout([task]);
		const [startNode, workNode, endNode] = layout.nodes;

		assert.ok(startNode);
		assert.ok(workNode);
		assert.ok(endNode);
		assert.strictEqual(startNode.kind, 'start');
		assert.strictEqual(workNode.kind, 'work');
		assert.strictEqual(endNode.kind, 'end');
		assert.deepStrictEqual(startNode.localPosition, { x: 0, y: 0 });
		assert.deepStrictEqual(workNode.localPosition, {
			x: 0,
			y: TASK_START_NODE_HEIGHT + TASK_NODE_VERTICAL_GAP,
		});
		assert.deepStrictEqual(endNode.localPosition, {
			x: (TASK_NODE_WIDTH - TASK_END_NODE_WIDTH) / 2,
			y: TASK_START_NODE_HEIGHT
				+ TASK_NODE_VERTICAL_GAP
				+ TASK_WORK_NODE_HEIGHT
				+ TASK_NODE_VERTICAL_GAP,
		});
		assert.strictEqual(startNode.height, TASK_START_NODE_HEIGHT);
		assert.strictEqual(workNode.height, TASK_WORK_NODE_HEIGHT);
		assert.strictEqual(endNode.width, TASK_END_NODE_WIDTH);
		assert.strictEqual(endNode.height, TASK_END_NODE_HEIGHT);
		assert.deepStrictEqual(layout.edges, task.edges.map((edge) => ({
			id: edge.id,
			taskId: task.id,
			sourceId: edge.source,
			targetId: edge.target,
		})));
	});

	test('최종 World 위치를 task.origin + taskLocalPosition으로 계산한다', () => {
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
			assert.strictEqual(
				movedNode.position.x - initialNode.position.x,
				300,
			);
			assert.strictEqual(
				movedNode.position.y - initialNode.position.y,
				200,
			);
		}
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
});

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
