import * as assert from 'assert';
import {
	createDefaultTaskBlueprint,
	TASK_BLUEPRINT_VERSION,
	type TaskBlueprint,
} from '../../task';
import {
	createTaskEdgeGeometry,
	createTaskGraphLayout,
	getCubicBezierPoint,
	TASK_NODE_HEIGHT,
	TASK_NODE_WIDTH,
} from '../../webview/task/taskLayout';

suite('Task Layout', () => {
	test('Blueprint의 명시적 local position과 Task origin을 그대로 World 좌표로 투영한다', () => {
		const task = createReadyTask('task:ready', { x: 120, y: -40 });
		const layout = createTaskGraphLayout([task]);
		const [start, work, end] = task.nodes;

		assert.ok(start && work?.kind === 'work' && end);
		const startLayout = layout.nodes.find((node) => node.id === start.id);
		const workLayout = layout.nodes.find((node) => node.id === work.id);
		const endLayout = layout.nodes.find((node) => node.id === end.id);

		assert.ok(
			startLayout?.kind === 'start'
			&& workLayout?.kind === 'work'
			&& endLayout?.kind === 'end',
		);
		assert.deepStrictEqual(startLayout.localPosition, { x: 0, y: 0 });
		assert.deepStrictEqual(workLayout.localPosition, { x: 320, y: 0 });
		assert.deepStrictEqual(endLayout.localPosition, { x: 640, y: 0 });
		assert.deepStrictEqual(startLayout.position, { x: 120, y: -40 });
		assert.deepStrictEqual(workLayout.position, { x: 440, y: -40 });
		assert.deepStrictEqual(endLayout.position, { x: 760, y: -40 });
		assert.ok(layout.nodes.every((node) => node.flowState === 'ready'));
		assert.strictEqual(startLayout.width, TASK_NODE_WIDTH);
		assert.strictEqual(startLayout.height, TASK_NODE_HEIGHT);
		assert.strictEqual(workLayout.width, TASK_NODE_WIDTH);
		assert.strictEqual(workLayout.height, TASK_NODE_HEIGHT);
		assert.strictEqual(workLayout.canRemove, true);
		assert.strictEqual(endLayout.width, TASK_NODE_WIDTH);
		assert.strictEqual(endLayout.height, TASK_NODE_HEIGHT);
		assert.strictEqual(startLayout.width, endLayout.width);
		assert.strictEqual(startLayout.height, workLayout.height);
		assert.strictEqual(workLayout.height, endLayout.height);
		assert.strictEqual(startLayout.title, 'Ready Task');
		assert.strictEqual(endLayout.title, startLayout.title);
		assert.strictEqual(startLayout.description, 'Ready Task description');
		assert.strictEqual(endLayout.description, startLayout.description);
		assert.strictEqual(workLayout.title, 'Work');
		assert.strictEqual(workLayout.description, 'Work description');
		assert.strictEqual(workLayout.prompt, 'Run the work.\nKeep the result concise.');
		assert.strictEqual(startLayout.connectionState, 'connected');
		assert.strictEqual(workLayout.connectionState, 'connected');
		assert.strictEqual(endLayout.connectionState, 'connected');
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
		assertLayoutEdgesUsePortCenters(layout);
		assert.deepStrictEqual(layout.edges.map((edge) => ({
			start: edge.geometry.start,
			end: edge.geometry.end,
		})), [{
			start: { x: 400, y: -12 },
			end: { x: 440, y: -12 },
		}, {
			start: { x: 720, y: -12 },
			end: { x: 760, y: -12 },
		}]);
	});

	test('연결되지 않은 기본 Start/End를 incomplete flow로 표시한다', () => {
		let sequence = 0;
		const task = createDefaultTaskBlueprint({
			title: 'Incomplete Task',
			origin: { x: 30, y: 40 },
		}, () => `incomplete-${++sequence}`);
		const layout = createTaskGraphLayout([task]);
		const start = layout.nodes.find((node) => node.kind === 'start');
		const end = layout.nodes.find((node) => node.kind === 'end');

		assert.ok(start && end);
		assert.strictEqual(layout.edges.length, 0);
		assert.ok(layout.nodes.every((node) => node.flowState === 'incomplete'));
		assert.deepStrictEqual(start.localPosition, { x: 0, y: 0 });
		assert.deepStrictEqual(end.localPosition, { x: 640, y: 0 });
		assert.deepStrictEqual(start.position, { x: 30, y: 40 });
		assert.deepStrictEqual(end.position, { x: 670, y: 40 });
		assert.strictEqual(start.title, 'Incomplete Task');
		assert.strictEqual(end.title, start.title);
		assert.strictEqual(start.description, task.description);
		assert.strictEqual(end.description, start.description);
		assert.strictEqual(start.connectionState, 'disconnected');
		assert.strictEqual(end.connectionState, 'disconnected');
	});

	test('두 Anchor의 horizontal cubic geometry와 실제 t=0.5 midpoint를 계산한다', () => {
		const start = { x: 10, y: 20 };
		const end = { x: 210, y: 120 };
		const geometry = createTaskEdgeGeometry(start, end);

		assert.deepStrictEqual(geometry, {
			start,
			control1: { x: 110, y: 20 },
			control2: { x: 110, y: 120 },
			end,
			midpoint: { x: 110, y: 70 },
		});
		assert.deepStrictEqual(geometry.midpoint, getCubicBezierPoint(
			geometry.start,
			geometry.control1,
			geometry.control2,
			geometry.end,
			0.5,
		));
	});

	test('origin 이동을 explicit local position은 유지한 채 Node와 Edge에 동일 적용한다', () => {
		const task = createReadyTask('task:origin', { x: 120, y: -40 });
		const movedTask: TaskBlueprint = {
			...task,
			origin: { x: 420, y: 160 },
		};
		const initialLayout = createTaskGraphLayout([task]);
		const movedLayout = createTaskGraphLayout([movedTask]);

		for (let index = 0; index < initialLayout.nodes.length; index += 1) {
			const initial = initialLayout.nodes[index];
			const moved = movedLayout.nodes[index];

			assert.ok(initial && moved);
			assert.deepStrictEqual(moved.localPosition, initial.localPosition);
			assert.deepStrictEqual({
				x: moved.position.x - initial.position.x,
				y: moved.position.y - initial.position.y,
			}, { x: 300, y: 200 });
		}
		assertLayoutEdgesUsePortCenters(initialLayout);
		assertLayoutEdgesUsePortCenters(movedLayout);
		assertGeometryDelta(initialLayout, movedLayout, { x: 300, y: 200 });
	});

	test('Edge 추가와 제거는 저장된 Node position을 재배치하지 않는다', () => {
		const connected = createReadyTask('task:stable', { x: 20, y: 30 });
		const disconnected: TaskBlueprint = { ...connected, edges: [] };
		const partiallyConnected: TaskBlueprint = {
			...connected,
			edges: connected.edges.slice(0, 1),
		};
		const endOnlyConnected: TaskBlueprint = {
			...connected,
			edges: connected.edges.slice(1),
		};
		const disconnectedLayout = createTaskGraphLayout([disconnected]);
		const connectedLayout = createTaskGraphLayout([connected]);
		const partialLayout = createTaskGraphLayout([partiallyConnected]);
		const endOnlyLayout = createTaskGraphLayout([endOnlyConnected]);

		for (const node of connected.nodes) {
			const disconnectedNode = disconnectedLayout.nodes.find(
				(candidate) => candidate.id === node.id,
			);
			const connectedNode = connectedLayout.nodes.find(
				(candidate) => candidate.id === node.id,
			);
			const partialNode = partialLayout.nodes.find(
				(candidate) => candidate.id === node.id,
			);

			assert.ok(disconnectedNode && connectedNode && partialNode);
			assert.deepStrictEqual(disconnectedNode.localPosition, connectedNode.localPosition);
			assert.deepStrictEqual(partialNode.localPosition, connectedNode.localPosition);
			assert.deepStrictEqual(disconnectedNode.position, connectedNode.position);
			assert.deepStrictEqual(partialNode.position, connectedNode.position);
		}
		assert.ok(disconnectedLayout.nodes.every((node) => (
			node.flowState === 'incomplete'
		)));
		assert.ok(connectedLayout.nodes.every((node) => node.flowState === 'ready'));
		assert.ok(partialLayout.nodes.every((node) => (
			node.flowState === 'incomplete'
		)));
		assert.deepStrictEqual(getBoundaryConnectionStates(disconnectedLayout), [
			['start', 'disconnected'],
			['end', 'disconnected'],
		]);
		assert.deepStrictEqual(getBoundaryConnectionStates(partialLayout), [
			['start', 'disconnected'],
			['end', 'disconnected'],
		]);
		assert.deepStrictEqual(getBoundaryConnectionStates(endOnlyLayout), [
			['start', 'disconnected'],
			['end', 'disconnected'],
		]);
		assert.deepStrictEqual(getBoundaryConnectionStates(connectedLayout), [
			['start', 'connected'],
			['end', 'connected'],
		]);
		assert.deepStrictEqual(getWorkConnectionStates(disconnectedLayout), [
			['Work', 'disconnected'],
		]);
		assert.deepStrictEqual(getWorkConnectionStates(partialLayout), [
			['Work', 'disconnected'],
		]);
		assert.deepStrictEqual(getWorkConnectionStates(endOnlyLayout), [
			['Work', 'disconnected'],
		]);
		assert.deepStrictEqual(getWorkConnectionStates(connectedLayout), [
			['Work', 'connected'],
		]);
	});

	test('완성 경로 Work만 connected로 표시하고 한쪽 연결 Work는 Boundary를 disconnected로 만든다', () => {
		const serial = createSerialTask({ x: 0, y: 0 });
		const branch = createBranchTask({ x: 0, y: 0 });
		const partiallyUnusedBranch = {
			...branch,
			edges: branch.edges.filter(
				(edge) => edge.id !== 'task-edge:e-end',
			),
		};
		const readyWithOrphan = createReadyTask('task:orphan', { x: 0, y: 0 });
		const orphanWork = createWorkNode('task-node:orphan', 'Orphan');
		const isolatedWork: TaskBlueprint = {
			...readyWithOrphan,
			nodes: [...readyWithOrphan.nodes, orphanWork],
			nodePositions: {
				...readyWithOrphan.nodePositions,
				[orphanWork.id]: { x: 320, y: 104 },
			},
		};

		assert.deepStrictEqual(
			getBoundaryConnectionStates(createTaskGraphLayout([serial])),
			[['start', 'connected'], ['end', 'connected']],
		);
		assert.deepStrictEqual(
			getWorkConnectionStates(createTaskGraphLayout([serial])),
			[
				['Serial A', 'connected'],
				['Serial B', 'connected'],
				['Serial C', 'connected'],
			],
		);
		assert.deepStrictEqual(
			getBoundaryConnectionStates(createTaskGraphLayout([partiallyUnusedBranch])),
			[['start', 'disconnected'], ['end', 'disconnected']],
		);
		assert.deepStrictEqual(
			getWorkConnectionStates(createTaskGraphLayout([partiallyUnusedBranch])),
			[
				['Work A', 'connected'],
				['Work B', 'connected'],
				['Work C', 'connected'],
				['Join', 'connected'],
				['Work D', 'connected'],
				['Work E', 'disconnected'],
			],
		);
		assert.deepStrictEqual(
			getBoundaryConnectionStates(createTaskGraphLayout([isolatedWork])),
			[['start', 'connected'], ['end', 'connected']],
		);
		assert.deepStrictEqual(
			getWorkConnectionStates(createTaskGraphLayout([isolatedWork])),
			[['Work', 'connected'], ['Orphan', 'disconnected']],
		);
	});

	test('Single Port를 공유하는 Branch/Join Edge endpoint를 분산하지 않는다', () => {
		const task = createBranchTask({ x: 100, y: 200 });
		const layout = createTaskGraphLayout([task]);
		const startBranchEdges = [
			layout.edges.find((edge) => edge.id === 'task-edge:start-a'),
			layout.edges.find((edge) => edge.id === 'task-edge:start-b'),
			layout.edges.find((edge) => edge.id === 'task-edge:start-c'),
		];
		const workJoinEdges = [
			layout.edges.find((edge) => edge.id === 'task-edge:a-join'),
			layout.edges.find((edge) => edge.id === 'task-edge:b-join'),
			layout.edges.find((edge) => edge.id === 'task-edge:c-join'),
		];
		const workBranchEdges = [
			layout.edges.find((edge) => edge.id === 'task-edge:join-d'),
			layout.edges.find((edge) => edge.id === 'task-edge:join-e'),
		];
		const endJoinEdges = [
			layout.edges.find((edge) => edge.id === 'task-edge:d-end'),
			layout.edges.find((edge) => edge.id === 'task-edge:e-end'),
		];

		assert.ok(startBranchEdges.every(Boolean));
		assert.ok(workJoinEdges.every(Boolean));
		assert.ok(workBranchEdges.every(Boolean));
		assert.ok(endJoinEdges.every(Boolean));
		assert.deepStrictEqual(
			startBranchEdges.map((edge) => edge?.geometry.start),
			Array.from({ length: 3 }, () => ({ x: 380, y: 228 })),
		);
		assert.deepStrictEqual(
			workJoinEdges.map((edge) => edge?.geometry.end),
			Array.from({ length: 3 }, () => ({ x: 740, y: 228 })),
		);
		assert.deepStrictEqual(
			workBranchEdges.map((edge) => edge?.geometry.start),
			Array.from({ length: 2 }, () => ({ x: 1020, y: 228 })),
		);
		assert.deepStrictEqual(
			endJoinEdges.map((edge) => edge?.geometry.end),
			Array.from({ length: 2 }, () => ({ x: 1380, y: 228 })),
		);
		assertLayoutEdgesUsePortCenters(layout);
		for (const edge of layout.edges) {
			assert.deepStrictEqual(edge.geometry.midpoint, getCubicBezierPoint(
				edge.geometry.start,
				edge.geometry.control1,
				edge.geometry.control2,
				edge.geometry.end,
				0.5,
			));
		}
		assert.ok(layout.nodes.every((node) => node.flowState === 'ready'));
		assert.deepStrictEqual(getBoundaryConnectionStates(layout), [
			['start', 'connected'],
			['end', 'connected'],
		]);
		assert.ok(getWorkConnectionStates(layout).every(([, state]) => (
			state === 'connected'
		)));
	});

	test('Work/End 위치 변경 뒤 모든 incident Edge가 최신 단일 Port 중심을 공유한다', () => {
		const task = createBranchTask({ x: 100, y: 200 });
		const join = task.nodes.find((node) => node.id === 'task-node:join');
		const end = task.nodes.find((node) => node.kind === 'end');

		assert.ok(join?.kind === 'work' && end);
		const movedTask: TaskBlueprint = {
			...task,
			nodePositions: {
				...task.nodePositions,
				[join.id]: { x: 700, y: 31 },
				[end.id]: { x: 1340, y: 88 },
			},
		};
		const layout = createTaskGraphLayout([movedTask]);
		const joinIncoming = layout.edges.filter((edge) => edge.targetId === join.id);
		const joinOutgoing = layout.edges.filter((edge) => edge.sourceId === join.id);
		const endIncoming = layout.edges.filter((edge) => edge.targetId === end.id);

		assert.strictEqual(joinIncoming.length, 3);
		assert.strictEqual(joinOutgoing.length, 2);
		assert.strictEqual(endIncoming.length, 2);
		assert.deepStrictEqual(
			joinIncoming.map((edge) => edge.geometry.end),
			Array.from({ length: 3 }, () => ({ x: 800, y: 259 })),
		);
		assert.deepStrictEqual(
			joinOutgoing.map((edge) => edge.geometry.start),
			Array.from({ length: 2 }, () => ({ x: 1080, y: 259 })),
		);
		assert.deepStrictEqual(
			endIncoming.map((edge) => edge.geometry.end),
			Array.from({ length: 2 }, () => ({ x: 1440, y: 316 })),
		);
		assertLayoutEdgesUsePortCenters(layout);
	});

	test('동일한 내부 Node/Edge ID를 Task ID와 origin별로 격리한다', () => {
		const taskA = createReadyTask(
			'task:00000000-0000-4000-8000-000000000001',
			{ x: 100, y: 50 },
		);
		const taskB = createReadyTask(
			'task:00000000-0000-4000-8000-000000000002',
			{ x: -300, y: 400 },
		);
		const layout = createTaskGraphLayout([taskA, taskB]);

		assertLayoutEdgesUsePortCenters(layout);
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
		for (const nodeA of taskANodes) {
			const nodeB = taskBNodes.find((candidate) => candidate.id === nodeA.id);

			assert.ok(nodeB);
			assert.deepStrictEqual(nodeB.localPosition, nodeA.localPosition);
			assert.deepStrictEqual({
				x: nodeB.position.x - nodeA.position.x,
				y: nodeB.position.y - nodeA.position.y,
			}, { x: -400, y: 350 });
		}
		assertGeometryDelta(
			{ nodes: taskANodes, edges: taskAEdges },
			{ nodes: taskBNodes, edges: taskBEdges },
			{ x: -400, y: 350 },
		);
	});
});

function assertLayoutEdgesUsePortCenters(
	layout: ReturnType<typeof createTaskGraphLayout>,
): void {
	for (const edge of layout.edges) {
		const source = layout.nodes.find((node) => (
			node.taskId === edge.taskId && node.id === edge.sourceId
		));
		const target = layout.nodes.find((node) => (
			node.taskId === edge.taskId && node.id === edge.targetId
		));

		assert.ok(source && target);
		assert.deepStrictEqual(edge.geometry.start, {
			x: source.position.x + source.width,
			y: source.position.y + source.height / 2,
		});
		assert.deepStrictEqual(edge.geometry.end, {
			x: target.position.x,
			y: target.position.y + target.height / 2,
		});
	}
}

function getBoundaryConnectionStates(
	layout: ReturnType<typeof createTaskGraphLayout>,
): Array<readonly ['start' | 'end', 'connected' | 'disconnected']> {
	return layout.nodes.flatMap((node) => node.kind === 'work'
		? []
		: [[node.kind, node.connectionState] as const]);
}

function getWorkConnectionStates(
	layout: ReturnType<typeof createTaskGraphLayout>,
): Array<readonly [string, 'connected' | 'disconnected']> {
	return layout.nodes.flatMap((node) => node.kind === 'work'
		? [[node.title, node.connectionState] as const]
		: []);
}

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

function createReadyTask(
	taskId: string,
	origin: { readonly x: number; readonly y: number },
): TaskBlueprint {
	const start = { id: 'task-node:same-start', kind: 'start' as const };
	const work = {
		id: 'task-node:same-work',
		kind: 'work' as const,
		title: 'Work',
		description: 'Work description',
		prompt: 'Run the work.\nKeep the result concise.',
	};
	const end = { id: 'task-node:same-end', kind: 'end' as const };

	return {
		version: TASK_BLUEPRINT_VERSION,
		id: taskId,
		title: 'Ready Task',
		description: 'Ready Task description',
		origin,
		nodePositions: {
			[work.id]: { x: 320, y: 0 },
			[end.id]: { x: 640, y: 0 },
		},
		nodes: [start, work, end],
		edges: [{
			id: 'task-edge:same-start-work',
			source: start.id,
			target: work.id,
		}, {
			id: 'task-edge:same-work-end',
			source: work.id,
			target: end.id,
		}],
	};
}

function createBranchTask(
	origin: { readonly x: number; readonly y: number },
): TaskBlueprint {
	const start = { id: 'task-node:start', kind: 'start' as const };
	const workA = createWorkNode('task-node:a', 'Work A');
	const workB = createWorkNode('task-node:b', 'Work B');
	const workC = createWorkNode('task-node:c', 'Work C');
	const join = createWorkNode('task-node:join', 'Join');
	const workD = createWorkNode('task-node:d', 'Work D');
	const workE = createWorkNode('task-node:e', 'Work E');
	const end = { id: 'task-node:end', kind: 'end' as const };

	return {
		version: TASK_BLUEPRINT_VERSION,
		id: 'task:branch',
		title: 'Branch Task',
		description: '',
		origin,
		nodePositions: {
			[workA.id]: { x: 320, y: -104 },
			[workB.id]: { x: 320, y: 0 },
			[workC.id]: { x: 320, y: 104 },
			[join.id]: { x: 640, y: 0 },
			[workD.id]: { x: 960, y: -52 },
			[workE.id]: { x: 960, y: 52 },
			[end.id]: { x: 1280, y: 0 },
		},
		nodes: [start, workA, workB, workC, join, workD, workE, end],
		edges: [{
			id: 'task-edge:start-a',
			source: start.id,
			target: workA.id,
		}, {
			id: 'task-edge:start-b',
			source: start.id,
			target: workB.id,
		}, {
			id: 'task-edge:start-c',
			source: start.id,
			target: workC.id,
		}, {
			id: 'task-edge:a-join',
			source: workA.id,
			target: join.id,
		}, {
			id: 'task-edge:b-join',
			source: workB.id,
			target: join.id,
		}, {
			id: 'task-edge:c-join',
			source: workC.id,
			target: join.id,
		}, {
			id: 'task-edge:join-d',
			source: join.id,
			target: workD.id,
		}, {
			id: 'task-edge:join-e',
			source: join.id,
			target: workE.id,
		}, {
			id: 'task-edge:d-end',
			source: workD.id,
			target: end.id,
		}, {
			id: 'task-edge:e-end',
			source: workE.id,
			target: end.id,
		}],
	};
}

function createSerialTask(
	origin: { readonly x: number; readonly y: number },
): TaskBlueprint {
	const start = { id: 'task-node:serial-start', kind: 'start' as const };
	const workA = createWorkNode('task-node:serial-a', 'Serial A');
	const workB = createWorkNode('task-node:serial-b', 'Serial B');
	const workC = createWorkNode('task-node:serial-c', 'Serial C');
	const end = { id: 'task-node:serial-end', kind: 'end' as const };

	return {
		version: TASK_BLUEPRINT_VERSION,
		id: 'task:serial',
		title: 'Serial Task',
		description: '',
		origin,
		nodePositions: {
			[workA.id]: { x: 320, y: 0 },
			[workB.id]: { x: 640, y: 0 },
			[workC.id]: { x: 960, y: 0 },
			[end.id]: { x: 1280, y: 0 },
		},
		nodes: [start, workA, workB, workC, end],
		edges: [{
			id: 'task-edge:serial-start-a',
			source: start.id,
			target: workA.id,
		}, {
			id: 'task-edge:serial-a-b',
			source: workA.id,
			target: workB.id,
		}, {
			id: 'task-edge:serial-b-c',
			source: workB.id,
			target: workC.id,
		}, {
			id: 'task-edge:serial-c-end',
			source: workC.id,
			target: end.id,
		}],
	};
}

function createWorkNode(id: string, title: string) {
	return {
		id,
		kind: 'work' as const,
		title,
		description: '',
		prompt: '',
	};
}
