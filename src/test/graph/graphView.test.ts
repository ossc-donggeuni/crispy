import * as assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
	createDefaultTaskBlueprint,
	createTaskState,
	getTaskFlowStatus,
	type TaskBlueprint,
} from '../../task';
import {
	GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE,
	type GraphCameraState,
} from '../../webview/graph/graphCamera';
import {
	createFileGroupId,
	createGraphLayoutNodeId,
	createGraphLayout,
	getGraphRootLayoutNodeId,
	getFileGroupHeight,
	GRAPH_FOLDER_NODE_HEIGHT,
	GRAPH_FOLDER_NODE_WIDTH,
	GRAPH_LAYOUT_ROOT_GAP,
} from '../../webview/graph/graphLayout';
import {
	GRAPH_MOCK,
	GRAPH_MOCK_FILE_ROOT,
	GRAPH_MOCK_FOLDER_ROOT,
	GRAPH_MOCK_PROJECT,
} from '../../webview/graph/graphMockData';
import {
	createSingleRootGraph,
	type Graph,
	type Project,
} from '../../webview/graph/graphModel';
import {
	createGraphState,
	INITIAL_GRAPH_STATE,
	type GraphStateSnapshot,
} from '../../webview/graph/graphState';
import {
	addGraphRoot,
	applyDetachedGraphRoots,
	createDetachedRootId,
	createFileBacklinkGroupId,
	createFolderBacklinkId,
	createPromotedGraphRootId,
	getDetachedRootOriginId,
} from '../../webview/graph/graphRootPromotion';
import {
	classifyGraphLayoutNodeArrangement,
	rebaseNodePositions,
} from '../../webview/graph/graphLayoutTransition';
import {
	applyGraphLayout,
	focusGraphRoot,
	initializeGraphLayoutReflow,
	initializeGraphView,
} from '../../webview/graph/graphView';
import { createGraphNodeEffects } from '../../webview/graph/graphNodeEffects';
import { GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE } from '../../webview/graph/graphNodeDrag';
import {
	calculateGraphVisibleArea,
	createFullGraphVisibleArea,
} from '../../webview/graph/graphVisibleArea';
import {
	TASK_EDGE_ACTION_ATTRIBUTE,
	TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE,
	TASK_EDGE_ACTION_TASK_ID_ATTRIBUTE,
	TASK_FLOW_STATE_ATTRIBUTE,
	TASK_NODE_ACTION_ATTRIBUTE,
	TASK_PORT_DIRECTION_ATTRIBUTE,
} from '../../webview/task/taskRenderer';
import { createTaskGraphLayout } from '../../webview/task/taskLayout';

suite('Graph View', () => {
	test('Navigator Task 추가는 viewport 중심에 incomplete Start/End를 생성한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		const addTaskButton = getDescendantByAttribute(
			root,
			'aria-label',
			'Task 추가',
		);

		assert.strictEqual(addTaskButton.title, 'Task 추가');
		addTaskButton.dispatch('click', createClickEvent(addTaskButton));
		const firstTask = graphView.taskState.getSnapshot().tasks[0];

		assert.ok(firstTask);
		assert.deepStrictEqual(firstTask.nodes.map((node) => node.kind), ['start', 'end']);
		assert.strictEqual(firstTask.edges.length, 0);
		assert.strictEqual(getTaskFlowStatus(firstTask), 'incomplete');
		const firstStart = firstTask.nodes.find((node) => node.kind === 'start');
		const firstEnd = firstTask.nodes.find((node) => node.kind === 'end');

		assert.ok(firstStart && firstEnd);
		const startElement = getTaskElement(
			root,
			'data-task-node-id',
			firstStart.id,
			firstTask.id,
		);
		const endElement = getTaskElement(
			root,
			'data-task-node-id',
			firstEnd.id,
			firstTask.id,
		);
		const workspaceRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);
		const nodeLayer = getDescendantByClass(root, 'graph-node-layer');

		assert.strictEqual(startElement.getAttribute(TASK_FLOW_STATE_ATTRIBUTE), 'incomplete');
		assert.strictEqual(endElement.getAttribute(TASK_FLOW_STATE_ATTRIBUTE), 'incomplete');
		assert.ok(nodeLayer.children.includes(workspaceRoot));
		assert.ok(nodeLayer.children.includes(startElement));
		assert.deepStrictEqual(
			readTranslate(endElement.style.transform),
			{
				x: firstTask.origin.x + firstTask.nodePositions[firstEnd.id].x,
				y: firstTask.origin.y + firstTask.nodePositions[firstEnd.id].y,
			},
		);

		addTaskButton.dispatch('click', createClickEvent(addTaskButton));
		const tasks = graphView.taskState.getSnapshot().tasks;

		assert.strictEqual(tasks.length, 2);
		assert.notStrictEqual(tasks[0]?.id, tasks[1]?.id);
		assert.notDeepStrictEqual(tasks[0]?.origin, tasks[1]?.origin);
		assert.strictEqual(getDescendantsByClass(root, 'task-start-node').length, 2);
		assert.strictEqual(getDescendantsByClass(root, 'task-end-node').length, 2);

		graphView.dispose();
	});

	test('Start Action은 겹치지 않는 Work를 추가하고 Node kind별 Port를 노출한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		let sequence = 0;
		const task = createDefaultTaskBlueprint({
			title: 'Editable Task',
			origin: { x: 100, y: 80 },
		}, () => 'ports-' + ++sequence);
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
			{},
			[task],
		);
		const start = task.nodes.find((node) => node.kind === 'start');
		const end = task.nodes.find((node) => node.kind === 'end');

		assert.ok(start && end);
		for (let index = 0; index < 3; index += 1) {
			const addWork = getDescendantByAttribute(
				getTaskElement(
					root,
					'data-task-node-id',
					start.id,
					task.id,
				),
				TASK_NODE_ACTION_ATTRIBUTE,
				'add-work',
			);

			addWork.dispatch('click', createClickEvent(addWork));
		}
		const updated = graphView.taskState.getTask(task.id);

		assert.ok(updated);
		const works = updated.nodes.filter((node) => node.kind === 'work');

		assert.strictEqual(works.length, 3);
		assert.strictEqual(updated.edges.length, 0);
		assert.strictEqual(getTaskFlowStatus(updated), 'incomplete');
		const workPositions = works.map((work) => updated.nodePositions[work.id]);

		assert.ok(workPositions.every((position) => position?.x === 320));
		for (let index = 1; index < workPositions.length; index += 1) {
			assert.ok(
				(workPositions[index]?.y ?? 0) - (workPositions[index - 1]?.y ?? 0) >= 132,
			);
		}

		assert.ok(getTaskPort(root, task.id, start.id, 'output'));
		assert.strictEqual(
			findTaskPort(root, task.id, start.id, 'input'),
			undefined,
		);
		assert.ok(getTaskPort(root, task.id, end.id, 'input'));
		assert.strictEqual(
			findTaskPort(root, task.id, end.id, 'output'),
			undefined,
		);
		for (const work of works) {
			const input = getTaskPort(root, task.id, work.id, 'input');
			const output = getTaskPort(root, task.id, work.id, 'output');

			assert.strictEqual(
				input.hasAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE),
				true,
			);
			assert.strictEqual(
				output.hasAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE),
				true,
			);
			assert.ok(getTaskElement(
				root,
				'data-task-node-id',
				work.id,
				task.id,
			));
		}
		const interactiveWork = works[0];

		assert.ok(interactiveWork);
		const workElement = getTaskElement(
			root,
			'data-task-node-id',
			interactiveWork.id,
			task.id,
		);
		const output = getTaskPort(root, task.id, interactiveWork.id, 'output');
		const initialPosition = updated.nodePositions[interactiveWork.id];
		const focusPoints: Array<{ readonly x: number; readonly y: number }> = [];

		graphView.camera.focusOn = (point) => focusPoints.push(point);
		output.dispatch('pointerdown', createPointerEvent(output, 10, 10));
		output.dispatch('pointermove', createPointerEvent(output, 70, 50));
		output.dispatch('pointerup', createPointerEvent(output, 70, 50));
		output.dispatch('click', createClickEvent(output));
		output.dispatch('dblclick', createClickEvent(output));
		assert.deepStrictEqual(
			graphView.taskState.getTask(task.id)?.nodePositions[interactiveWork.id],
			initialPosition,
		);
		assert.strictEqual(workElement.hasPointerCapture(1), false);
		assert.strictEqual(workElement.hasClass('is-dragging'), false);
		assert.strictEqual(workElement.hasClass('is-selected'), false);
		assert.strictEqual(focusPoints.length, 0);
		ownerDocument.dispatch('keydown', createKeyboardEvent('Escape'));

		graphView.dispose();
	});

	test('Port Click으로 직렬과 병렬 DAG를 연결하며 explicit Node 위치를 유지한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		let sequence = 0;
		const task = createDefaultTaskBlueprint({
			title: 'Port DAG',
			origin: { x: 40, y: 60 },
		}, () => 'connect-' + ++sequence);
		const state = createTaskState([task], () => 'connect-edit-' + ++sequence);

		state.addWork(task.id, { title: 'A' });
		state.addWork(task.id, { title: 'B' });
		state.addWork(task.id, { title: 'C' });
		state.addWork(task.id, { title: 'D' });
		const prepared = state.getTask(task.id);

		assert.ok(prepared);
		const start = prepared.nodes.find((node) => node.kind === 'start');
		const [workA, workB, workC, workD] = prepared.nodes.filter(
			(node) => node.kind === 'work',
		);
		const end = prepared.nodes.find((node) => node.kind === 'end');

		assert.ok(start && workA && workB && workC && workD && end);
		const initialPositions = prepared.nodePositions;
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
			{},
			[prepared],
		);

		connectTaskPorts(root, task.id, start.id, workA.id);
		connectTaskPorts(root, task.id, start.id, workB.id);
		const previewSource = getTaskPort(root, task.id, start.id, 'output');

		previewSource.dispatch('click', createClickEvent(previewSource));
		const previewTarget = getTaskPort(root, task.id, workD.id, 'input');

		previewTarget.dispatch(
			'pointermove',
			createPointerEvent(previewTarget, 640, 240),
		);
		assert.strictEqual(previewTarget.hasClass('is-valid-target'), true);
		const previewPath = getDescendantByClass(
			root,
			'task-connection-preview',
		).getAttribute('d');

		previewTarget.dispatch('click', createClickEvent(previewTarget));
		const previewCommittedTask = graphView.taskState.getTask(task.id);
		const previewCommittedEdge = previewCommittedTask?.edges.find((edge) => (
			edge.source === start.id && edge.target === workD.id
		));

		assert.ok(previewCommittedEdge);
		assert.strictEqual(
			getTaskElement(
				root,
				'data-task-edge-id',
				previewCommittedEdge.id,
				task.id,
			).getAttribute('d'),
			previewPath,
		);
		connectTaskPorts(root, task.id, workA.id, workC.id);
		connectTaskPorts(root, task.id, workB.id, workC.id);
		connectTaskPorts(root, task.id, workD.id, workC.id);
		connectTaskPorts(root, task.id, workC.id, end.id);
		const connected = graphView.taskState.getTask(task.id);

		assert.ok(connected);
		assert.deepStrictEqual(connected.nodePositions, initialPositions);
		assert.strictEqual(connected.edges.length, 7);
		assert.deepStrictEqual(
			connected.edges.map((edge) => [edge.source, edge.target]),
			[
				[start.id, workA.id],
				[start.id, workB.id],
				[start.id, workD.id],
				[workA.id, workC.id],
				[workB.id, workC.id],
				[workD.id, workC.id],
				[workC.id, end.id],
			],
		);
		assert.strictEqual(getTaskFlowStatus(connected), 'ready');
		for (const node of connected.nodes) {
			assert.strictEqual(
				getTaskElement(
					root,
					'data-task-node-id',
					node.id,
					task.id,
				).getAttribute(TASK_FLOW_STATE_ATTRIBUTE),
				'ready',
			);
		}
		assert.strictEqual(
			getTaskElements(root, 'data-task-edge-id', connected.edges[0]?.id ?? '').length,
			1,
		);
		const duplicateSource = getTaskPort(root, task.id, start.id, 'output');
		const duplicateTarget = getTaskPort(root, task.id, workA.id, 'input');

		duplicateSource.dispatch('click', createClickEvent(duplicateSource));
		assert.strictEqual(duplicateTarget.hasClass('is-invalid-target'), true);
		duplicateTarget.dispatch('click', createClickEvent(duplicateTarget));
		assert.strictEqual(graphView.taskState.getTask(task.id)?.edges.length, 7);
		ownerDocument.dispatch('keydown', createKeyboardEvent('Escape'));

		graphView.dispose();
	});

	test('Port 연결 후보는 cross-task와 cycle을 invalid로 표시하고 요청을 거부한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const taskA = createSerialRenderingTask(
			'task:cycle-a',
			{ x: 100, y: 80 },
			2,
		);
		const taskB = createSerialRenderingTask(
			'task:cycle-b',
			{ x: 900, y: 80 },
			1,
		);
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
			{},
			[taskA, taskB],
		);
		const [workA, workB] = taskA.nodes.filter((node) => node.kind === 'work');
		const taskBWork = taskB.nodes.find((node) => node.kind === 'work');

		assert.ok(workA && workB && taskBWork);
		const cycleSource = getTaskPort(root, taskA.id, workB.id, 'output');
		const cycleTarget = getTaskPort(root, taskA.id, workA.id, 'input');

		cycleSource.dispatch('click', createClickEvent(cycleSource));
		assert.strictEqual(cycleSource.hasClass('is-connection-source'), true);
		assert.strictEqual(cycleTarget.hasClass('is-invalid-target'), true);
		cycleTarget.dispatch('click', createClickEvent(cycleTarget));
		assert.strictEqual(
			graphView.taskState.getTask(taskA.id)?.edges.length,
			taskA.edges.length,
		);
		assert.strictEqual(cycleSource.hasClass('is-connection-source'), true);
		ownerDocument.dispatch('keydown', createKeyboardEvent('Escape'));

		const crossSource = getTaskPort(root, taskA.id, workA.id, 'output');
		const crossTarget = getTaskPort(root, taskB.id, taskBWork.id, 'input');

		crossSource.dispatch('click', createClickEvent(crossSource));
		assert.strictEqual(crossTarget.hasClass('is-invalid-target'), true);
		crossTarget.dispatch('click', createClickEvent(crossTarget));
		assert.strictEqual(
			graphView.taskState.getTask(taskA.id)?.edges.length,
			taskA.edges.length,
		);
		assert.strictEqual(
			graphView.taskState.getTask(taskB.id)?.edges.length,
			taskB.edges.length,
		);
		ownerDocument.dispatch('keydown', createKeyboardEvent('Escape'));

		graphView.dispose();
	});

	test('Escape, blank viewport와 source 재클릭은 연결 Preview와 후보 상태를 정리한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const task = createRenderingTask({ x: 100, y: 80 });
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
			{},
			[task],
		);
		const start = task.nodes.find((node) => node.kind === 'start');

		assert.ok(start);
		const source = getTaskPort(root, task.id, start.id, 'output');
		const viewport = getDescendantByClass(root, 'graph-viewport');
		const assertActive = () => {
			assert.strictEqual(source.hasClass('is-connection-source'), true);
			assert.strictEqual(getDescendantsByClass(
				root,
				'task-connection-preview',
			).length, 1);
		};
		const assertInactive = () => {
			assert.strictEqual(source.hasClass('is-connection-source'), false);
			assert.strictEqual(getDescendantsByClass(
				root,
				'task-connection-preview',
			).length, 0);
			assert.strictEqual(getDescendantsByClass(root, 'is-valid-target').length, 0);
			assert.strictEqual(getDescendantsByClass(root, 'is-invalid-target').length, 0);
		};

		source.dispatch('click', createClickEvent(source));
		viewport.dispatch('pointermove', createPointerEvent(viewport, 500, 300));
		assertActive();
		ownerDocument.dispatch('keydown', createKeyboardEvent('Escape'));
		assertInactive();

		source.dispatch('click', createClickEvent(source));
		assertActive();
		source.dispatch('click', createClickEvent(source));
		assertInactive();

		source.dispatch('click', createClickEvent(source));
		assertActive();
		viewport.dispatch('pointerdown', createPointerEvent(viewport, 600, 400));
		assertInactive();

		graphView.dispose();
		ownerDocument.dispatch('keydown', createKeyboardEvent('Escape'));
		assertInactive();
	});

	test('Edge disconnect Action은 정확한 Edge만 제거하고 Node 위치를 보존한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const task = createRenderingTask({ x: 100, y: 80 });
		const secondTask: TaskBlueprint = {
			...task,
			id: 'task:disconnect-second',
			title: 'Second Task',
			origin: { x: 900, y: 80 },
		};
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
			{},
			[task, secondTask],
		);
		const edge = task.edges[0];

		assert.ok(edge);
		const edgeAction = getTaskEdgeAction(root, task.id, edge.id);
		const disconnect = getDescendantByAttribute(
			edgeAction,
			TASK_EDGE_ACTION_ATTRIBUTE,
			'disconnect-edge',
		);
		const initialPositions = task.nodePositions;

		disconnect.dispatch('click', createClickEvent(disconnect));
		const updated = graphView.taskState.getTask(task.id);

		assert.ok(updated);
		assert.strictEqual(updated.edges.length, task.edges.length - 1);
		assert.strictEqual(updated.edges.some((candidate) => candidate.id === edge.id), false);
		assert.deepStrictEqual(updated.nodePositions, initialPositions);
		assert.strictEqual(getTaskFlowStatus(updated), 'incomplete');
		assert.deepStrictEqual(graphView.taskState.getTask(secondTask.id), secondTask);
		assert.strictEqual(
			findTaskEdgeAction(root, task.id, edge.id),
			undefined,
		);
		assert.ok(findTaskEdgeAction(root, secondTask.id, edge.id));
		assert.strictEqual(
			getTaskElements(root, 'data-task-edge-id', edge.id).length,
			1,
		);
		assert.strictEqual(
			getTaskElement(root, 'data-task-edge-id', edge.id, secondTask.id)
				.getAttribute('data-task-id'),
			secondTask.id,
		);

		graphView.dispose();
	});

	test('Work 삭제는 incident Edge만 제거하고 직렬 dependency bypass를 만들지 않는다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const task = createSerialRenderingTask('task:delete', { x: 100, y: 80 }, 2);
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
			{},
			[task],
		);
		const start = task.nodes.find((node) => node.kind === 'start');
		const [workA, workB] = task.nodes.filter((node) => node.kind === 'work');
		const end = task.nodes.find((node) => node.kind === 'end');

		assert.ok(start && workA && workB && end);
		const workElement = getTaskElement(
			root,
			'data-task-node-id',
			workB.id,
			task.id,
		);
		const remove = getDescendantByAttribute(
			workElement,
			TASK_NODE_ACTION_ATTRIBUTE,
			'remove-work',
		);

		assert.strictEqual(remove.hasAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE), true);
		remove.dispatch('click', createClickEvent(remove));
		const updated = graphView.taskState.getTask(task.id);

		assert.ok(updated);
		assert.deepStrictEqual(
			updated.nodes.filter((node) => node.kind === 'work').map((node) => node.id),
			[workA.id],
		);
		assert.strictEqual(updated.nodePositions[workB.id], undefined);
		assert.deepStrictEqual(updated.nodePositions[workA.id], task.nodePositions[workA.id]);
		assert.deepStrictEqual(updated.nodePositions[end.id], task.nodePositions[end.id]);
		assert.deepStrictEqual(
			updated.edges.map((edge) => [edge.source, edge.target]),
			[[start.id, workA.id]],
		);
		assert.strictEqual(
			updated.edges.some((edge) => edge.source === workA.id && edge.target === end.id),
			false,
		);
		assert.strictEqual(getTaskFlowStatus(updated), 'incomplete');
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-task-node-id', workB.id),
			undefined,
		);

		graphView.dispose();
	});

	test('Start Drag은 origin만, Work/End Grab은 explicit position과 Edge geometry만 갱신한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const task = createRenderingTask({ x: 100, y: 50 });
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
			{},
			[task],
		);
		const startNode = task.nodes.find((node) => node.kind === 'start');
		const workNode = task.nodes.find((node) => node.kind === 'work');
		const endNode = task.nodes.find((node) => node.kind === 'end');

		assert.ok(startNode && workNode && endNode);
		const start = getTaskElement(root, 'data-task-node-id', startNode.id, task.id);
		const work = getTaskElement(root, 'data-task-node-id', workNode.id, task.id);
		const end = getTaskElement(root, 'data-task-node-id', endNode.id, task.id);
		assertRenderedTaskGeometry(root, task);

		performTaskDrag(work, { x: 10, y: 10 }, { x: 50, y: 30 });
		let updated = graphView.taskState.getTask(task.id);

		assert.ok(updated);
		assert.deepStrictEqual(updated.origin, task.origin);
		assert.deepStrictEqual(updated.nodePositions[workNode.id], { x: 360, y: 6 });
		assert.deepStrictEqual(updated.nodePositions[endNode.id], task.nodePositions[endNode.id]);
		assertRenderedTaskGeometry(root, updated);

		performTaskDrag(end, { x: 20, y: 20 }, { x: -10, y: 60 });
		updated = graphView.taskState.getTask(task.id);

		assert.ok(updated);
		assert.deepStrictEqual(updated.origin, task.origin);
		assert.deepStrictEqual(updated.nodePositions[endNode.id], { x: 610, y: 68 });
		assertRenderedTaskGeometry(root, updated);

		performTaskDrag(start, { x: 10, y: 10 }, { x: 30, y: 40 });
		updated = graphView.taskState.getTask(task.id);

		assert.ok(updated);
		assert.deepStrictEqual(updated.origin, { x: 120, y: 80 });
		assert.deepStrictEqual(updated.nodePositions[workNode.id], { x: 360, y: 6 });
		assert.deepStrictEqual(updated.nodePositions[endNode.id], { x: 610, y: 68 });
		assertRenderedTaskGeometry(root, updated);

		graphView.dispose();
	});

	test('Task Grab cancel/capture 상실과 동일 내부 ID Task 격리를 유지한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const taskA = createCollidingRenderingTask(
			'task:00000000-0000-4000-8000-000000000001',
			'Task A',
			{ x: 100, y: 50 },
		);
		const taskB = createCollidingRenderingTask(
			'task:00000000-0000-4000-8000-000000000002',
			'Task B',
			{ x: 900, y: 400 },
		);
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
			{},
			[taskA, taskB],
		);
		const workId = taskA.nodes.find((node) => node.kind === 'work')?.id;
		const endId = taskA.nodes.find((node) => node.kind === 'end')?.id;
		const startId = taskA.nodes.find((node) => node.kind === 'start')?.id;

		assert.ok(workId && endId && startId);
		const workA = getTaskElement(root, 'data-task-node-id', workId, taskA.id);
		const endA = getTaskElement(root, 'data-task-node-id', endId, taskA.id);
		const startA = getTaskElement(root, 'data-task-node-id', startId, taskA.id);
		const workB = getTaskElement(root, 'data-task-node-id', workId, taskB.id);
		const taskBWorkTransform = workB.style.transform;
		const taskBEdgePaths = taskB.edges.map((edge) => getTaskElement(
			root,
			'data-task-edge-id',
			edge.id,
			taskB.id,
		).getAttribute('d'));

		beginTaskDrag(workA, { x: 10, y: 10 }, { x: 50, y: 30 });
		workA.dispatch('pointercancel', createPointerEvent(workA, 50, 30));
		assert.deepStrictEqual(
			graphView.taskState.getTask(taskA.id)?.nodePositions[workId],
			taskA.nodePositions[workId],
		);
		assert.strictEqual(workA.hasClass('is-dragging'), false);

		beginTaskDrag(endA, { x: 10, y: 10 }, { x: 40, y: 50 });
		endA.losePointerCapture(1);
		assert.deepStrictEqual(
			graphView.taskState.getTask(taskA.id)?.nodePositions[endId],
			taskA.nodePositions[endId],
		);

		beginTaskDrag(startA, { x: 10, y: 10 }, { x: 40, y: 50 });
		startA.dispatch('pointercancel', createPointerEvent(startA, 40, 50));
		assert.deepStrictEqual(graphView.taskState.getTask(taskA.id)?.origin, taskA.origin);

		performTaskDrag(workA, { x: 10, y: 10 }, { x: 40, y: 25 });
		assert.deepStrictEqual(
			graphView.taskState.getTask(taskA.id)?.nodePositions[workId],
			{ x: 350, y: 1 },
		);
		assert.deepStrictEqual(
			graphView.taskState.getTask(taskB.id)?.nodePositions[workId],
			taskB.nodePositions[workId],
		);
		assert.strictEqual(workB.style.transform, taskBWorkTransform);
		assert.deepStrictEqual(taskB.edges.map((edge) => getTaskElement(
			root,
			'data-task-edge-id',
			edge.id,
			taskB.id,
		).getAttribute('d')), taskBEdgePaths);
		beginTaskDrag(workA, { x: 10, y: 10 }, { x: 70, y: 60 });
		const positionAtDispose = graphView.taskState.getTask(taskA.id)
			?.nodePositions[workId];

		graphView.dispose();
		workA.dispatch('pointermove', createPointerEvent(workA, 120, 90));
		assert.deepStrictEqual(
			graphView.taskState.getTask(taskA.id)?.nodePositions[workId],
			positionAtDispose,
		);
		assert.strictEqual(workA.hasPointerCapture(1), false);
	});

	test('Task 선택과 Focus는 (taskId,nodeId) 기준이며 Drag 직후 Focus를 억제한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const taskA = createCollidingRenderingTask(
			'task:00000000-0000-4000-8000-000000000001',
			'Task A',
			{ x: 100, y: 50 },
		);
		const taskB = createCollidingRenderingTask(
			'task:00000000-0000-4000-8000-000000000002',
			'Task B',
			{ x: -300, y: 400 },
		);
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
			{},
			[taskA, taskB],
		);
		const startId = taskA.nodes.find((node) => node.kind === 'start')?.id;
		const workId = taskA.nodes.find((node) => node.kind === 'work')?.id;
		const endId = taskA.nodes.find((node) => node.kind === 'end')?.id;

		assert.ok(startId && workId && endId);
		const taskAWork = getTaskElement(root, 'data-task-node-id', workId, taskA.id);
		const taskBWork = getTaskElement(root, 'data-task-node-id', workId, taskB.id);
		const taskAStart = getTaskElement(root, 'data-task-node-id', startId, taskA.id);
		const taskAEnd = getTaskElement(root, 'data-task-node-id', endId, taskA.id);
		const focusPoints: Array<{ readonly x: number; readonly y: number }> = [];

		graphView.camera.focusOn = (point) => focusPoints.push(point);
		taskAWork.dispatch('click', createClickEvent(taskAWork));
		assert.strictEqual(taskAWork.hasClass('is-selected'), true);
		taskBWork.dispatch('click', createClickEvent(taskBWork));
		assert.strictEqual(taskAWork.hasClass('is-selected'), false);
		assert.strictEqual(taskBWork.hasClass('is-selected'), true);

		taskAStart.dispatch('dblclick', createClickEvent(taskAStart));
		taskAWork.dispatch('dblclick', createClickEvent(taskAWork));
		taskAEnd.dispatch('dblclick', createClickEvent(taskAEnd));
		assert.deepStrictEqual(focusPoints, [
			{ x: 240, y: 102 },
			{ x: 560, y: 102 },
		]);

		performTaskDrag(taskAWork, { x: 10, y: 10 }, { x: 40, y: 30 });
		taskAWork.dispatch('dblclick', createClickEvent(taskAWork));
		assert.strictEqual(focusPoints.length, 2);

		graphView.dispose();
	});

	test('Task Port/Action/Grab CSS는 연결 상태와 pointer 충돌 규약을 표현한다', () => {
		const taskViewCss = readFileSync(resolve(
			__dirname,
			'../../../src/webview/task/taskView.css',
		), 'utf8');

		assert.match(taskViewCss, /\.task-node\s*\{[^}]*cursor:\s*grab;/s);
		assert.match(
			taskViewCss,
			/\.task-node\.is-dragging\s*\{[^}]*cursor:\s*grabbing;/s,
		);
		assert.match(taskViewCss, /\.task-node-port\s*\{/s);
		assert.match(taskViewCss, /\.task-node-port\s*\{[^}]*opacity:\s*0\.78;/s);
		assert.match(taskViewCss, /\.task-node-port\s*\{[^}]*top:\s*50%;/s);
		assert.match(
			taskViewCss,
			/\.task-input-port\s*\{[^}]*left:\s*0;[^}]*translate\(-50%,\s*-50%\)/s,
		);
		assert.match(
			taskViewCss,
			/\.task-output-port\s*\{[^}]*right:\s*0;[^}]*translate\(50%,\s*-50%\)/s,
		);
		assert.match(taskViewCss, /\.task-node-port\.is-connection-source/s);
		assert.match(taskViewCss, /\.task-node-port\.is-valid-target/s);
		assert.match(taskViewCss, /\.task-node-port\.is-invalid-target/s);
		assert.match(taskViewCss, /\.task-connection-preview\s*\{[^}]*pointer-events:\s*none;/s);
		assert.match(
			taskViewCss,
			/\.task-start-node\[data-task-flow-state=['"]incomplete['"]\],[^{]*\{[^}]*--graph-node-background:[^}]*62%/s,
		);
		assert.match(taskViewCss, /\.task-work-node:hover\s*>\s*\.task-work-actions/s);
		assert.match(taskViewCss, /\.task-edge-actions:hover\s*>\s*\.task-edge-action-list/s);
	});
	test('Detached Hover Action은 absolute bridge로 hover를 유지하고 기존 SVG asset을 사용한다', () => {
		const graphViewCss = readFileSync(resolve(
			__dirname,
			'../../../src/webview/graph/graphView.css',
		), 'utf8');
		const hiddenRule = graphViewCss.match(
			/\.graph-detached-root-actions\s*\{[^}]*\}/,
		);
		const hoverRule = graphViewCss.match(
			/\.graph-node:hover\s*>\s*\.graph-detached-root-actions,[^{]*\{[^}]*\}/,
		);

		assert.ok(hiddenRule);
		assert.match(hiddenRule[0], /position:\s*absolute;/);
		assert.match(hiddenRule[0], /top:\s*100%;/);
		assert.match(hiddenRule[0], /padding-top:\s*12px;/);
		assert.match(hiddenRule[0], /pointer-events:\s*none;/);
		assert.ok(hoverRule);
		assert.match(hoverRule[0], /pointer-events:\s*auto;/);
		assert.ok(graphViewCss.includes(
			"url('./assets/ui-icons/duplicate.svg')",
		));
		assert.ok(graphViewCss.includes(
			"url('./assets/ui-icons/delete.svg')",
		));
	});

	test('Graph Node와 File Row의 hidden 속성은 flex layout보다 우선한다', () => {
		const graphViewCss = readFileSync(resolve(
			__dirname,
			'../../../src/webview/graph/graphView.css',
		), 'utf8');
		const hiddenRule = graphViewCss.match(
			/\.graph-node\[hidden\],\s*\.graph-file-item\[hidden\]\s*\{[^}]*\}/,
		);

		assert.ok(hiddenRule);
		assert.match(hiddenRule[0], /display:\s*none;/);
	});

	test('Effect Region은 World layer에서 interaction 없이 기존 reflow easing을 사용한다', () => {
		const graphViewCss = readFileSync(resolve(
			__dirname,
			'../../../src/webview/graph/graphView.css',
		), 'utf8');
		const layerRule = graphViewCss.match(
			/\.graph-node-effect-region-layer\s*\{\s*z-index:[^}]*\}/,
		);
		const transitionRule = graphViewCss.match(
			/\.graph-node-effect-region\.is-layout-transitioning\s*\{[\s\S]*?\n\}/,
		);

		assert.ok(layerRule);
		assert.match(layerRule[0], /pointer-events:\s*none;/);
		assert.ok(transitionRule);
		assert.match(
			transitionRule[0],
			/--graph-node-effect-region-transition-duration/,
		);
		assert.match(
			transitionRule[0],
			/cubic-bezier\(0\.333333, 1, 0\.666667, 1\)/,
		);
	});

	test('Shimmer는 전달된 색과 현재 Node surface에서 ambient color를 파생한다', () => {
		const graphViewCss = readFileSync(resolve(
			__dirname,
			'../../../src/webview/graph/graphView.css',
		), 'utf8');
		const shimmerRule = graphViewCss.match(
			/\.graph-node-effect-shimmer\s*\{[\s\S]*?\n\}/,
		);
		const regionShimmerRule = graphViewCss.match(
			/\.graph-node-effect-region \.graph-node-effect-shimmer\s*\{[\s\S]*?\n\}/,
		);

		assert.ok(shimmerRule);
		assert.match(shimmerRule[0], /background:\s*color-mix\(/);
		assert.match(
			shimmerRule[0],
			/var\(--graph-node-effect-ambient-background\)/,
		);
		assert.ok(regionShimmerRule);
		assert.match(regionShimmerRule[0], /transparent/);
	});

	test('Node Effect를 kind별로 조합·교체하고 color/icon을 중복 DOM 없이 갱신한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[GRAPH_MOCK_PROJECT.id]: true,
				'folder:app': true,
				'folder:app/src': true,
			},
		}, GRAPH_MOCK);
		const target = { nodeId: 'folder:app/src' };
		const folder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			target.nodeId,
		);

		graphView.setNodeEffect(target, { kind: 'shimmer', color: '#ff0088' });
		graphView.setNodeEffect(target, { kind: 'outline', color: '#22cc88' });
		graphView.setNodeEffect(target, {
			kind: 'icon',
			color: '#40a9ff',
			icon: 'check',
		});
		const region = getEffectRegion(root, target.nodeId);

		const shimmer = getNodeEffect(region, 'shimmer');
		const outline = getNodeEffect(region, 'outline');
		const icon = getNodeEffect(folder, 'icon');

		assert.strictEqual(
			shimmer.style.getPropertyValue('--graph-node-effect-color'),
			'#ff0088',
		);
		assert.strictEqual(getNodeEffects(region, 'shimmer').length, 1);
		assert.strictEqual(getNodeEffects(region, 'outline').length, 1);
		assert.strictEqual(getNodeEffects(folder, 'icon').length, 1);
		assert.strictEqual(icon.getAttribute('data-graph-node-effect-icon'), 'check');

		graphView.setNodeEffect(target, { kind: 'outline', color: '#ffaa00' });
		graphView.setNodeEffect(target, {
			kind: 'icon',
			color: '#ff3355',
			icon: 'cancel',
		});

		assert.strictEqual(getNodeEffect(region, 'outline'), outline);
		assert.strictEqual(getNodeEffect(folder, 'icon'), icon);
		assert.strictEqual(getNodeEffects(region, 'outline').length, 1);
		assert.strictEqual(getNodeEffects(folder, 'icon').length, 1);
		assert.strictEqual(
			outline.style.getPropertyValue('--graph-node-effect-color'),
			'#ffaa00',
		);
		assert.strictEqual(
			icon.style.getPropertyValue('--graph-node-effect-color'),
			'#ff3355',
		);
		assert.strictEqual(icon.getAttribute('data-graph-node-effect-icon'), 'cancel');

		graphView.clearNodeEffect(target, 'outline');
		assert.strictEqual(findNodeEffect(region, 'outline'), undefined);
		assert.strictEqual(getNodeEffect(region, 'shimmer'), shimmer);
		assert.strictEqual(getNodeEffect(folder, 'icon'), icon);

		graphView.clearNodeEffect(target);
		assert.strictEqual(findEffectRegion(root, target.nodeId), undefined);
		assert.deepStrictEqual(getNodeEffects(folder), []);
		assert.strictEqual(folder.hasClass('graph-node-effect-host'), false);
		graphView.dispose();
	});

	test('Parent Effect는 열린 visible subtree를 하나의 Region으로 재귀 확장·수축한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: { [GRAPH_MOCK_PROJECT.id]: true },
		}, GRAPH_MOCK);
		const target = { nodeId: 'folder:app' };
		const folder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			target.nodeId,
		);

		graphView.setNodeEffect(target, { kind: 'shimmer', color: '#ff66bb' });
		graphView.setNodeEffect(target, {
			kind: 'icon',
			color: '#44cc88',
			icon: 'check',
		});
		const region = getEffectRegion(root, target.nodeId);
		const closedBounds = readEffectRegionBounds(region);

		assert.strictEqual(closedBounds.width, 252);
		assert.strictEqual(closedBounds.height, 54);
		assert.strictEqual(getNodeEffects(region, 'shimmer').length, 1);
		assert.strictEqual(getNodeEffects(folder, 'shimmer').length, 0);
		assert.strictEqual(getNodeEffects(folder, 'icon').length, 1);
		assert.strictEqual(getDescendantsByClass(
			root,
			'graph-node-effect-region',
		).filter((candidate) => (
			candidate.getAttribute('data-graph-node-effect-region') === target.nodeId
		)).length, 1);

		graphView.state.toggleFolder(target.nodeId);
		const openedBounds = readEffectRegionBounds(region);
		const childFolder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			'folder:app/src',
		);

		assert.strictEqual(getEffectRegion(root, target.nodeId), region);
		assert.ok(openedBounds.width > closedBounds.width);
		assert.ok(openedBounds.height > closedBounds.height);
		assert.deepStrictEqual(getNodeEffects(childFolder), []);

		graphView.state.toggleFolder('folder:app/src');
		const nestedOpenedBounds = readEffectRegionBounds(region);

		assert.ok(nestedOpenedBounds.width > openedBounds.width);
		assert.ok(nestedOpenedBounds.height > openedBounds.height);
		assert.strictEqual(getEffectRegion(root, target.nodeId), region);

		graphView.state.toggleFolder('folder:app/src');
		assert.deepStrictEqual(readEffectRegionBounds(region), openedBounds);
		graphView.state.toggleFolder(target.nodeId);
		assert.deepStrictEqual(readEffectRegionBounds(region), closedBounds);

		const snapshot = graphView.state.getState();

		graphView.state.setState({
			...snapshot,
			nodePositions: {
				...snapshot.nodePositions,
				[target.nodeId]: {
					x: closedBounds.x + 106,
					y: closedBounds.y + 56,
				},
			},
		});
		const movedBounds = readEffectRegionBounds(region);

		assert.deepStrictEqual(movedBounds, {
			x: closedBounds.x + 100,
			y: closedBounds.y + 50,
			width: closedBounds.width,
			height: closedBounds.height,
		});

		graphView.clearNodeEffect(target, 'shimmer');
		assert.strictEqual(findEffectRegion(root, target.nodeId), undefined);
		assert.ok(getNodeEffect(folder, 'icon'));
		graphView.dispose();
	});

	test('Nested Parent Effect Region은 서로의 state와 DOM을 공유하지 않는다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[GRAPH_MOCK_PROJECT.id]: true,
				'folder:app': true,
				'folder:app/src': true,
			},
		}, GRAPH_MOCK);
		const outerTarget = { nodeId: 'folder:app' };
		const innerTarget = { nodeId: 'folder:app/src' };

		graphView.setNodeEffect(outerTarget, {
			kind: 'shimmer',
			color: '#ff66bb',
		});
		graphView.setNodeEffect(innerTarget, {
			kind: 'outline',
			color: '#66aaff',
		});
		const outerRegion = getEffectRegion(root, outerTarget.nodeId);
		const innerRegion = getEffectRegion(root, innerTarget.nodeId);

		assert.notStrictEqual(outerRegion, innerRegion);
		assert.ok(readEffectRegionBounds(outerRegion).width >= (
			readEffectRegionBounds(innerRegion).width
		));
		assert.strictEqual(getDescendantsByClass(
			root,
			'graph-node-effect-region',
		).length, 2);

		graphView.clearNodeEffect(outerTarget);
		assert.strictEqual(findEffectRegion(root, outerTarget.nodeId), undefined);
		assert.strictEqual(getEffectRegion(root, innerTarget.nodeId), innerRegion);
		assert.ok(getNodeEffect(innerRegion, 'outline'));
		graphView.dispose();
	});

	test('File Group pagination은 같은 Parent Region DOM의 실제 height만 갱신한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const folderId = 'folder:pagination-samples/seventeen-files';
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[GRAPH_MOCK_PROJECT.id]: true,
				'folder:pagination-samples': true,
				[folderId]: true,
			},
		}, GRAPH_MOCK);

		graphView.setNodeEffect(
			{ nodeId: folderId },
			{ kind: 'outline-strong', color: '#55aaff' },
		);
		const region = getEffectRegion(root, folderId);
		const firstPageBounds = readEffectRegionBounds(region);

		graphView.state.showMoreFiles(createFileGroupId(folderId));
		const secondPageBounds = readEffectRegionBounds(region);

		assert.strictEqual(getEffectRegion(root, folderId), region);
		assert.ok(secondPageBounds.height > firstPageBounds.height);
		assert.strictEqual(secondPageBounds.width, firstPageBounds.width);

		graphView.state.collapseFileGroup(createFileGroupId(folderId));
		assert.deepStrictEqual(readEffectRegionBounds(region), firstPageBounds);
		assert.strictEqual(getNodeEffects(region, 'outline-strong').length, 1);
		graphView.dispose();
	});

	test('Region resize는 Effect DOM을 유지하고 전달된 Layout duration으로 전환한다', () => {
		const ownerDocument = new FakeDocument();
		const regionLayer = ownerDocument.createElement('div');
		const nodeEffects = createGraphNodeEffects(
			ownerDocument as unknown as Document,
			() => 0,
			regionLayer.asHtmlElement(),
		);
		const target = { nodeId: 'folder:app' };
		const card = ownerDocument.createElement('article');

		nodeEffects.registerNode(target, card.asHtmlElement(), {
			layoutNodeId: target.nodeId,
		});
		nodeEffects.setNodeEffect(target, {
			kind: 'marching-dash',
			color: '#55ccff',
		});
		const collapsedLayout = createGraphLayout(
			createSingleRootGraph(GRAPH_MOCK_PROJECT),
			{ openedFolders: { [GRAPH_MOCK_PROJECT.id]: true } },
		);

		nodeEffects.syncLayout(
			collapsedLayout,
			createLayoutPositionMap(collapsedLayout),
		);
		const region = getEffectRegion(regionLayer, target.nodeId);
		const dash = getNodeEffect(region, 'marching-dash');
		const expandedLayout = createGraphLayout(
			createSingleRootGraph(GRAPH_MOCK_PROJECT),
			{
				openedFolders: {
					[GRAPH_MOCK_PROJECT.id]: true,
					[target.nodeId]: true,
				},
			},
		);

		assert.strictEqual(nodeEffects.syncLayout(
			expandedLayout,
			createLayoutPositionMap(expandedLayout),
			220,
		), true);
		assert.strictEqual(getEffectRegion(regionLayer, target.nodeId), region);
		assert.strictEqual(getNodeEffect(region, 'marching-dash'), dash);
		assert.strictEqual(region.hasClass('is-layout-transitioning'), true);
		assert.strictEqual(region.style.getPropertyValue(
			'--graph-node-effect-region-transition-duration',
		), '220ms');

		nodeEffects.clearNodeEffect(target);
		assert.strictEqual(findEffectRegion(regionLayer, target.nodeId), undefined);
		nodeEffects.dispose();
	});

	test('나중에 생성된 같은 Node occurrence를 기존 Effect animation 위상에 동기화한다', () => {
		const ownerDocument = new FakeDocument();
		let animationTime = 100;
		const nodeEffects = createGraphNodeEffects(
			ownerDocument as unknown as Document,
			() => animationTime,
		);
		const target = { nodeId: 'folder:synchronized-effect' };
		const firstOccurrence = ownerDocument.createElement('article');

		nodeEffects.registerNode(target, firstOccurrence.asHtmlElement());
		animationTime = 350;
		nodeEffects.setNodeEffect(target, {
			kind: 'marching-dash',
			color: '#55ccff',
		});
		const firstDash = getNodeEffect(firstOccurrence, 'marching-dash');

		assert.strictEqual(
			firstDash.style.getPropertyValue('--graph-node-effect-animation-delay'),
			'-250ms',
		);

		animationTime = 850;
		const secondOccurrence = ownerDocument.createElement('article');

		nodeEffects.registerNode(target, secondOccurrence.asHtmlElement());
		const secondDash = getNodeEffect(secondOccurrence, 'marching-dash');

		assert.strictEqual(
			secondDash.style.getPropertyValue('--graph-node-effect-animation-delay'),
			'-750ms',
		);

		animationTime = 900;
		nodeEffects.setNodeEffect(target, {
			kind: 'marching-dash',
			color: '#ff66aa',
		});
		assert.strictEqual(getNodeEffect(firstOccurrence, 'marching-dash'), firstDash);
		assert.strictEqual(getNodeEffect(secondOccurrence, 'marching-dash'), secondDash);
		assert.strictEqual(
			firstDash.style.getPropertyValue('--graph-node-effect-animation-delay'),
			'-250ms',
		);
		assert.strictEqual(
			secondDash.style.getPropertyValue('--graph-node-effect-animation-delay'),
			'-750ms',
		);

		animationTime = 950;
		nodeEffects.setNodeEffect(target, { kind: 'pulse', color: '#44dd88' });
		assert.strictEqual(
			firstOccurrence.style.getPropertyValue(
				'--graph-node-effect-animation-delay',
			),
			'-850ms',
		);
		assert.strictEqual(
			secondOccurrence.style.getPropertyValue(
				'--graph-node-effect-animation-delay',
			),
			'-850ms',
		);

		animationTime = 1_300;
		const thirdOccurrence = ownerDocument.createElement('article');

		nodeEffects.registerNode(target, thirdOccurrence.asHtmlElement());
		assert.strictEqual(
			getNodeEffect(thirdOccurrence, 'marching-dash').style.getPropertyValue(
				'--graph-node-effect-animation-delay',
			),
			'-1200ms',
		);
		assert.strictEqual(
			thirdOccurrence.style.getPropertyValue(
				'--graph-node-effect-animation-delay',
			),
			'-1200ms',
		);

		nodeEffects.clearNodeEffect(target, 'pulse');
		assert.strictEqual(firstOccurrence.style.getPropertyValue(
			'--graph-node-effect-animation-delay',
		), '');
		assert.strictEqual(secondOccurrence.style.getPropertyValue(
			'--graph-node-effect-animation-delay',
		), '');
		assert.strictEqual(thirdOccurrence.style.getPropertyValue(
			'--graph-node-effect-animation-delay',
		), '');

		const graphViewCss = readFileSync(resolve(
			__dirname,
			'../../../src/webview/graph/graphView.css',
		), 'utf8');
		const synchronizedAnimationRules = graphViewCss.match(
			/animation-delay:\s*var\(--graph-node-effect-animation-delay,\s*0ms\);/g,
		);

		assert.ok((synchronizedAnimationRules?.length ?? 0) >= 4);

		const marchingDashPattern = graphViewCss.match(
			/stroke-dasharray:\s*(\d+)\s+(\d+);/,
		);
		const marchingDashOffset = graphViewCss.match(
			/@keyframes graph-node-effect-marching-dash\s*\{[\s\S]*?stroke-dashoffset:\s*(-?\d+);/,
		);
		assert.ok(marchingDashPattern);
		assert.ok(marchingDashOffset);
		const dashPeriod = Number(marchingDashPattern[1]) + Number(marchingDashPattern[2]);
		assert.strictEqual(Math.abs(Number(marchingDashOffset[1])) % dashPeriod, 0);
		nodeEffects.dispose();
	});

	test('Folder collapse/open과 Graph refresh 뒤 새 DOM에 활성 Effect를 복원한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const initialState = {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[GRAPH_MOCK_PROJECT.id]: true as const,
				'folder:app': true as const,
			},
		};
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			initialState,
			GRAPH_MOCK,
		);
		const target = { nodeId: 'folder:app/src' };
		const firstFolder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			target.nodeId,
		);

		graphView.setNodeEffect(target, { kind: 'pulse', color: '#55ddff' });
		const firstRegion = getEffectRegion(root, target.nodeId);
		const firstBounds = readEffectRegionBounds(firstRegion);

		assert.ok(getNodeEffect(firstRegion, 'pulse'));

		graphView.state.toggleFolder('folder:app');
		assert.strictEqual(findEffectRegion(root, target.nodeId), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			target.nodeId,
		), undefined);

		graphView.state.toggleFolder('folder:app');
		const reopenedFolder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			target.nodeId,
		);
		const reopenedRegion = getEffectRegion(root, target.nodeId);

		assert.notStrictEqual(reopenedFolder, firstFolder);
		assert.notStrictEqual(reopenedRegion, firstRegion);
		assert.deepStrictEqual(readEffectRegionBounds(reopenedRegion), firstBounds);
		assert.strictEqual(
			getNodeEffect(reopenedRegion, 'pulse').style.getPropertyValue(
				'--graph-node-effect-color',
			),
			'#55ddff',
		);

		graphView.updateGraph({ roots: [], rootNodes: {} });
		assert.strictEqual(findEffectRegion(root, target.nodeId), undefined);
		graphView.updateGraph(GRAPH_MOCK);
		const refreshedFolder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			target.nodeId,
		);
		const refreshedRegion = getEffectRegion(root, target.nodeId);

		assert.notStrictEqual(refreshedFolder, reopenedFolder);
		assert.ok(getNodeEffect(refreshedRegion, 'pulse'));
		assert.deepStrictEqual(readEffectRegionBounds(refreshedRegion), firstBounds);
		graphView.dispose();
		assert.strictEqual(findEffectRegion(root, target.nodeId), undefined);
	});

	test('Grouped File Row pagination 재생성과 standalone File에 Effect를 적용한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[GRAPH_MOCK_PROJECT.id]: true,
				'folder:app': true,
				'folder:app/src': true,
			},
		}, GRAPH_MOCK);
		const pagedFileId = 'file:app/src/index.ts';
		const fileGroupId = createFileGroupId('folder:app/src');

		graphView.setNodeEffect(
			{ nodeId: pagedFileId },
			{ kind: 'marching-dash', color: '#cc66ff' },
		);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-file-id',
			pagedFileId,
		), undefined);

		graphView.state.showMoreFiles(fileGroupId);
		const firstRow = getDescendantByAttribute(
			root,
			'data-file-id',
			pagedFileId,
		);

		assert.ok(getNodeEffect(firstRow, 'marching-dash'));
		graphView.state.collapseFileGroup(fileGroupId);
		assert.strictEqual(findNodeEffect(firstRow, 'marching-dash'), undefined);
		graphView.state.showMoreFiles(fileGroupId);
		const restoredRow = getDescendantByAttribute(
			root,
			'data-file-id',
			pagedFileId,
		);

		assert.notStrictEqual(restoredRow, firstRow);
		assert.ok(getNodeEffect(restoredRow, 'marching-dash'));

		graphView.setNodeEffect(
			{ nodeId: GRAPH_MOCK_FILE_ROOT.id },
			{ kind: 'outline-strong', color: '#ff9944' },
		);
		const standaloneFile = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_FILE_ROOT.id,
		);

		assert.ok(getNodeEffect(standaloneFile, 'outline-strong'));
		graphView.dispose();
	});

	test('rootId는 Detached actual occurrence만 지정하고 Backlink에는 복제하지 않는다', () => {
		const folder = {
			kind: 'folder' as const,
			id: 'folder:effect-detached',
			name: 'effect-detached',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:effect-detached/index.ts',
				name: 'index.ts',
			}],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:effect-detached',
			name: 'effect-detached',
			status: 'loaded',
			children: [folder],
		};
		const detachedRootId = createPromotedGraphRootId(folder.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[project.id]: true,
				[createGraphLayoutNodeId(detachedRootId, folder.id)]: true,
			},
			detachedRootNodeIds: { [folder.id]: true },
		}, createSingleRootGraph(project, 'root:effect-detached'));
		const detachedCard = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createGraphLayoutNodeId(detachedRootId, folder.id),
		);
		const backlink = getDescendantByAttribute(
			root,
			'data-target-node-id',
			folder.id,
		);

		graphView.setNodeEffect(
			{ nodeId: folder.id, rootId: detachedRootId },
			{ kind: 'outline', color: '#44dd88' },
		);
		const detachedRegion = getEffectRegion(
			root,
			createGraphLayoutNodeId(detachedRootId, folder.id),
		);
		const detachedRootButton = getNavigatorRootButtons(root)[1];

		assert.ok(getNodeEffect(detachedRegion, 'outline'));
		assert.ok(readEffectRegionBounds(detachedRegion).width > 252);
		assert.strictEqual(readEffectRegionBounds(detachedRegion).height, 54);
		assert.strictEqual(findNodeEffect(detachedCard, 'outline'), undefined);
		assert.ok(detachedRootButton);
		assert.ok(getNodeEffect(detachedRootButton, 'outline'));
		assert.strictEqual(findNodeEffect(backlink, 'outline'), undefined);
		graphView.clearNodeEffect({ nodeId: folder.id, rootId: detachedRootId });
		assert.strictEqual(findEffectRegion(
			root,
			createGraphLayoutNodeId(detachedRootId, folder.id),
		), undefined);
		assert.strictEqual(findNodeEffect(detachedRootButton, 'outline'), undefined);
		graphView.dispose();
	});

	test('활성화된 Root 목록에 occurrence Effect를 동일하게 적용하고 목록 재생성 뒤 복원한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		const folderRoot = GRAPH_MOCK.roots.find(
			(candidate) => candidate.nodeId === GRAPH_MOCK_FOLDER_ROOT.id,
		);

		assert.ok(folderRoot);
		const target = { nodeId: GRAPH_MOCK_FOLDER_ROOT.id };

		graphView.setNodeEffect(target, { kind: 'pulse', color: '#36d9c4' });
		const firstRootButton = getNavigatorRootButtons(root)[1];
		const firstRootCard = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			getGraphRootLayoutNodeId(folderRoot),
		);
		const firstRootRegion = getEffectRegion(
			root,
			getGraphRootLayoutNodeId(folderRoot),
		);

		assert.ok(firstRootButton);
		assert.strictEqual(
			getNodeEffect(firstRootButton, 'pulse').style.getPropertyValue(
				'--graph-node-effect-color',
			),
			'#36d9c4',
		);
		assert.strictEqual(
			getNodeEffect(firstRootRegion, 'pulse').style.getPropertyValue(
				'--graph-node-effect-color',
			),
			'#36d9c4',
		);
		assert.strictEqual(findNodeEffect(firstRootCard, 'pulse'), undefined);

		graphView.updateGraph({ roots: [], rootNodes: {} });
		assert.strictEqual(findNodeEffect(firstRootButton, 'pulse'), undefined);
		assert.deepStrictEqual(getNavigatorRootButtons(root), []);

		graphView.updateGraph(GRAPH_MOCK);
		const restoredRootButton = getNavigatorRootButtons(root)[1];

		assert.ok(restoredRootButton);
		assert.notStrictEqual(restoredRootButton, firstRootButton);
		assert.ok(getNodeEffect(restoredRootButton, 'pulse'));

		graphView.clearNodeEffect(target);
		assert.strictEqual(findNodeEffect(restoredRootButton, 'pulse'), undefined);
		graphView.dispose();
	});

	test('정렬 대상 강조는 Drag Card보다 위에 표시된다', () => {
		const graphViewCss = readFileSync(resolve(
			__dirname,
			'../../../src/webview/graph/graphView.css',
		), 'utf8');
		const draggingRule = graphViewCss.match(
			/\.graph-node\.is-dragging\s*\{[^}]*z-index:\s*(\d+);[^}]*\}/,
		);
		const targetRule = graphViewCss.match(
			/\.graph-node\.is-arrangement-target,\s*\.graph-arrangement-placeholder\.is-arrangement-target\s*\{[^}]*z-index:\s*(\d+);[^}]*\}/,
		);

		assert.ok(draggingRule?.[1]);
		assert.ok(targetRule?.[1]);
		assert.ok(Number(targetRule[1]) > Number(draggingRule[1]));
	});

	test('한 번 생성한 Layout reference를 Renderer와 Navigator에 함께 적용한다', () => {
		const layout = createGraphLayout(GRAPH_MOCK);
		let rendererLayout: typeof layout | undefined;
		let navigatorLayout: typeof layout | undefined;

		applyGraphLayout(
			{ applyLayout: (nextLayout) => { rendererLayout = nextLayout; } },
			{ setLayout: (nextLayout) => { navigatorLayout = nextLayout; } },
			layout,
		);

		assert.strictEqual(rendererLayout, layout);
		assert.strictEqual(navigatorLayout, layout);
		assert.strictEqual(rendererLayout, navigatorLayout);
	});

	test('초기 Graph Root를 Navigator 표시 데이터와 같은 순서로 Panel에 연결한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		graphView.camera.setState({ x: 0, y: 0, scale: 4 });
		const rootList = getDescendantByClass(
			root,
			'graph-navigator-root-list',
		);
		const minimap = getDescendantByClass(root, 'graph-navigator-minimap');
		const minimapNodeLayer = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-node-layer',
		);
		const initialMinimapNodeCount = minimapNodeLayer.children.length;
		const minimapViewportIndicator = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-viewport-indicator',
		);
		const initialIndicator = readMinimapViewportAttributes(
			minimapViewportIndicator,
		);

		assert.deepStrictEqual(
			rootList.children.map((item) => (
				getDescendantByClass(item, 'graph-navigator-root-name').textContent
			)),
			['crispy', 'multi-root-demo/', 'standalone-root.ts'],
		);
		assert.deepStrictEqual(
			getDescendantsByClass(rootList, 'graph-navigator-root-path')
				.map((path) => path.textContent),
			[
				'crispy/packages/demo/src/',
				'crispy/src/webview/graph/examples/promoted/standalone/file/',
			],
		);
		graphView.state.toggleFolder(GRAPH_MOCK_PROJECT.id);
		assert.strictEqual(
			getDescendantByClass(root, 'graph-navigator-minimap'),
			minimap,
		);
		assert.ok(minimapNodeLayer.children.length > initialMinimapNodeCount);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);
		graphView.state.toggleFolder(GRAPH_MOCK_PROJECT.id);
		assert.strictEqual(minimapNodeLayer.children.length, initialMinimapNodeCount);
		assert.deepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);
		graphView.dispose();
	});

	test('persisted Detached Root와 위치를 초기 Workspace Graph에 복원하고 누락 Node는 무시한다', () => {
		const detachedFolder = {
			kind: 'folder' as const,
			id: 'folder:persisted-src',
			name: 'src',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:persisted-src/index.ts',
				name: 'index.ts',
			}],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:persisted-root',
			name: 'workspace',
			status: 'loaded',
			children: [detachedFolder],
		};
		const graph = createSingleRootGraph(project, 'root:workspace');
		const detachedRootId = createPromotedGraphRootId(detachedFolder.id);
		const detachedRootNodeId = createGraphLayoutNodeId(
			detachedRootId,
			detachedFolder.id,
		);
		const savedPosition = { x: 840, y: 360 };
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 25, y: -15, scale: 1.25 },
			nodePositions: { [detachedFolder.id]: savedPosition },
			openedFolders: {
				[project.id]: true,
				[detachedFolder.id]: true,
			},
			detachedRootNodeIds: {
				[detachedFolder.id]: true,
				'folder:temporarily-missing': true,
			},
		}, graph);

		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace', 'src/']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedRootId]: true,
			'folder:temporarily-missing': true,
		});
		const restoredRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedRootNodeId,
		);

		assert.strictEqual(restoredRoot.style.transform, 'translate(840px, 360px)');
		assert.ok(findDescendantByClass(restoredRoot, 'graph-root-context-label'));
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			createGraphLayoutNodeId(
				detachedRootId,
				detachedFolder.children[0].id,
			),
		));
		const backlink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(createPromotedGraphRootId(detachedFolder.id)),
		);

		assert.strictEqual(backlink.hasClass('graph-folder-backlink-node'), true);
		assert.strictEqual(
			backlink.getAttribute('data-target-node-id'),
			detachedFolder.id,
		);
		assert.strictEqual(graph.roots.length, 1);
		assert.strictEqual(graph.rootNodes[detachedFolder.id], undefined);
		graphView.dispose();
	});

	test('새 Workspace Graph를 기존 View와 State에 적용하고 Renderer와 Navigator를 동기화한다', () => {
		const existingFolder = {
			kind: 'folder' as const,
			id: 'folder:refresh-existing',
			name: 'existing',
			status: 'loaded' as const,
			children: Array.from({ length: 7 }, (_, index) => ({
				kind: 'file' as const,
				id: `file:refresh-existing/${index}.ts`,
				name: `${index}.ts`,
			})),
		};
		const removedFolder = {
			kind: 'folder' as const,
			id: 'folder:refresh-removed',
			name: 'removed',
			status: 'loaded' as const,
			children: [],
		};
		const addedFolder = {
			kind: 'folder' as const,
			id: 'folder:refresh-added',
			name: 'added',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:refresh-added/index.ts',
				name: 'index.ts',
			}],
		};
		const initialProject: Project = {
			kind: 'project',
			id: 'project:refresh-primary',
			name: 'primary',
			status: 'loaded',
			children: [existingFolder, removedFolder],
		};
		const updatedProject: Project = {
			...initialProject,
			children: [existingFolder, addedFolder],
		};
		const secondaryProject: Project = {
			kind: 'project',
			id: 'project:refresh-secondary',
			name: 'secondary',
			status: 'loaded',
			children: [],
		};
		const initialGraph = createSingleRootGraph(
			initialProject,
			'root:refresh-primary',
		);
		const updatedGraph: Graph = {
			roots: [
				{ id: 'root:refresh-primary', nodeId: updatedProject.id },
				{ id: 'root:refresh-secondary', nodeId: secondaryProject.id },
			],
			rootNodes: {
				[updatedProject.id]: updatedProject,
				[secondaryProject.id]: secondaryProject,
			},
		};
		const secondaryOnlyGraph = createSingleRootGraph(
			secondaryProject,
			'root:refresh-secondary',
		);
		const fileGroupId = createFileGroupId(existingFolder.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 125, y: -75, scale: 1.5 },
			nodePositions: {
				[existingFolder.id]: { x: 320, y: 180 },
				[addedFolder.id]: { x: 760, y: 420 },
				'folder:stale': { x: -500, y: -300 },
			},
			fileGroupPages: { [fileGroupId]: 2 },
			openedFolders: {
				[initialProject.id]: true,
				[existingFolder.id]: true,
				[addedFolder.id]: true,
				'folder:stale': true,
			},
			detachedRootNodeIds: {},
		}, initialGraph);
		const viewport = root.children[0];
		const existingNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			existingFolder.id,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const stateStore = graphView.state;
		const initialState = stateStore.getState();
		const initialCamera = graphView.camera.getState();

		graphView.updateGraph(updatedGraph);

		assert.strictEqual(root.children[0], viewport);
		assert.strictEqual(graphView.state, stateStore);
		assert.notStrictEqual(graphView.state.getState(), initialState);
		assert.deepStrictEqual(graphView.camera.getState(), initialCamera);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			existingFolder.id,
		), existingNode);
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-node-id',
				removedFolder.id,
			),
			undefined,
		);
		const addedNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			addedFolder.id,
		);

		assert.strictEqual(addedNode.style.transform, 'translate(760px, 420px)');
		const addedChildNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			addedFolder.children[0].id,
		);

		assert.deepStrictEqual(subtractPositions(
			readTranslate(addedChildNode.style.transform),
			readTranslate(addedNode.style.transform),
		), { x: 302, y: 0 });
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${updatedProject.id}->${addedFolder.id}`,
		));
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			addedFolder.id,
		));
		assert.ok(findDescendantByAttribute(
			root,
			'data-filter-node-id',
			addedFolder.id,
		));
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-edge-id',
				`${updatedProject.id}->${removedFolder.id}`,
			),
			undefined,
		);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			removedFolder.id,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-filter-node-id',
			removedFolder.id,
		), undefined);
		assert.strictEqual(
			getDescendantsByClass(
				getDescendantByAttribute(root, 'data-graph-node-id', fileGroupId),
				'graph-file-item',
			).length,
			7,
		);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['primary', 'secondary']);

		graphView.updateGraph(secondaryOnlyGraph);

		assert.strictEqual(root.children[0], viewport);
		const secondaryState = graphView.state.getState();

		assert.deepStrictEqual(secondaryState.nodePositions, {
			[existingFolder.id]: { x: 320, y: 180 },
			[addedFolder.id]: { x: 760, y: 420 },
			'folder:stale': { x: -500, y: -300 },
		});
		assert.strictEqual(secondaryState.openedFolders, initialState.openedFolders);
		assert.strictEqual(secondaryState.fileGroupPages, initialState.fileGroupPages);
		assert.deepStrictEqual(graphView.camera.getState(), initialCamera);
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-node-id',
				updatedProject.id,
			),
			undefined,
		);
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			secondaryProject.id,
		));
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			secondaryProject.id,
		));
		assert.ok(findDescendantByAttribute(
			root,
			'data-filter-node-id',
			secondaryProject.id,
		));
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			addedFolder.id,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-filter-node-id',
			addedFolder.id,
		), undefined);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['secondary']);
		assert.deepStrictEqual(initialState.nodePositions, {
			[existingFolder.id]: { x: 320, y: 180 },
			[fileGroupId]: { x: 622, y: 72 },
			[addedFolder.id]: { x: 760, y: 420 },
			'folder:stale': { x: -500, y: -300 },
		});
		assert.deepStrictEqual(initialState.openedFolders, {
			[initialProject.id]: true,
			[existingFolder.id]: true,
			[addedFolder.id]: true,
			'folder:stale': true,
		});
		assert.deepStrictEqual(initialState.fileGroupPages, { [fileGroupId]: 2 });
		graphView.dispose();
	});

	test('Workspace Refresh는 File Group 경계와 stale page를 최신 DOM/Layout/Minimap에 적용한다', () => {
		const projectId = 'project:refresh-pagination';
		const fileGroupId = createFileGroupId(projectId);
		const files = Array.from({ length: 6 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:refresh-pagination/${index + 1}.ts`,
			name: `${index + 1}.ts`,
		}));
		const createGraph = (nextFiles: typeof files): Graph => createSingleRootGraph({
			kind: 'project',
			id: projectId,
			name: 'refresh-pagination',
			status: 'loaded',
			children: nextFiles,
		});
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 35, y: -20, scale: 1.25 },
			nodePositions: { [fileGroupId]: { x: 520, y: 240 } },
			fileGroupPages: { [fileGroupId]: 1 },
			openedFolders: { [projectId]: true },
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
		}, createGraph(files.slice(0, 4)));
		const initialState = graphView.state.getState();
		const initialCamera = graphView.camera.getState();
		const fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const groupEdge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${projectId}->${fileGroupId}`,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const initialMinimapGroupHeight = Number(getDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		).getAttribute('height'));
		const getRenderedIds = (): Array<string | null> => getDescendantsByClass(
			getDescendantByAttribute(root, 'data-graph-node-id', fileGroupId),
			'graph-file-item',
		).map((row) => row.getAttribute('data-file-id'));
		const assertGroupedFiles = (
			expectedFiles: typeof files,
			hasMore: boolean,
		): void => {
			const currentGroup = getDescendantByAttribute(
				root,
				'data-graph-node-id',
				fileGroupId,
			);

			assert.strictEqual(currentGroup, fileGroup);
			assert.strictEqual(getDescendantByAttribute(
				root,
				'data-graph-edge-id',
				`${projectId}->${fileGroupId}`,
			), groupEdge);
			assert.deepStrictEqual(
				getRenderedIds(),
				expectedFiles.slice(0, 5).map((file) => file.id),
			);
			assert.strictEqual(
				findDescendantByClass(currentGroup, 'graph-file-more') !== undefined,
				hasMore,
			);
			assert.strictEqual(
				currentGroup.style.height,
				`${getFileGroupHeight(
					Math.min(expectedFiles.length, 5),
					hasMore,
				)}px`,
			);
			assert.ok(findDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				fileGroupId,
			));
		};

		assertGroupedFiles(files.slice(0, 4), false);
		graphView.updateGraph(createGraph(files.slice(0, 5)));
		assertGroupedFiles(files.slice(0, 5), false);
		assert.ok(Number(getDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		).getAttribute('height')) > initialMinimapGroupHeight);

		graphView.updateGraph(createGraph(files));
		assertGroupedFiles(files, true);
		assert.strictEqual(
			getDescendantByClass(fileGroup, 'graph-file-more').textContent,
			'+ 1개 더보기',
		);

		const fiveAfterVisibleDelete = files.filter((_, index) => index !== 2);

		graphView.updateGraph(createGraph(fiveAfterVisibleDelete));
		assertGroupedFiles(fiveAfterVisibleDelete, false);
		assert.deepStrictEqual(getRenderedIds(), [
			files[0]?.id,
			files[1]?.id,
			files[3]?.id,
			files[4]?.id,
			files[5]?.id,
		]);

		const fourAfterDelete = fiveAfterVisibleDelete.slice(0, 4);

		graphView.updateGraph(createGraph(fourAfterDelete));
		assertGroupedFiles(fourAfterDelete, false);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(4, false)}px`);
		assert.deepStrictEqual(graphView.state.getState(), initialState);

		graphView.updateGraph(createGraph(files));
		graphView.state.showMoreFiles(fileGroupId);
		assert.strictEqual(graphView.state.getFileGroupPage(fileGroupId), 2);
		const expandedState = graphView.state.getState();

		graphView.updateGraph(createGraph(fourAfterDelete));
		assert.deepStrictEqual(getRenderedIds(), fourAfterDelete.map((file) => file.id));
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-controls'), undefined);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(4, false)}px`);
		assert.strictEqual(graphView.state.getFileGroupPage(fileGroupId), 2);

		graphView.updateGraph(createGraph(files.slice(0, 1)));
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		), undefined);
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			files[0]?.id as string,
		));
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		), undefined);

		graphView.updateGraph(createGraph([]));
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			files[0]?.id as string,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${projectId}->${files[0]?.id}`,
		), undefined);

		graphView.updateGraph(createGraph(files.slice(5)));
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			files[5]?.id as string,
		));
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			files[5]?.id as string,
		));
		assert.deepStrictEqual(graphView.state.getState(), {
			...expandedState,
			nodePositions: initialState.nodePositions,
		});
		assert.deepStrictEqual(graphView.camera.getState(), initialCamera);
		graphView.dispose();
	});

	test('Workspace Filter로 Graph에서 사라진 Node의 모든 Persistent State를 보존한다', () => {
		const filteredFolder = {
			kind: 'folder' as const,
			id: 'folder:filter-state/generated',
			name: 'generated',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:filter-state/generated/output.js',
				name: 'output.js',
			}],
		};
		const createFilteredGraph = (includeFilteredFolder: boolean): Graph => {
			const project: Project = {
				kind: 'project',
				id: 'project:filter-state',
				name: 'workspace',
				status: 'loaded',
				children: includeFilteredFolder ? [filteredFolder] : [],
			};

			return createSingleRootGraph(project, 'root:filter-state');
		};
		const fileGroupId = createFileGroupId(filteredFolder.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 10, y: 20, scale: 1 },
			nodePositions: {
				[filteredFolder.id]: { x: 320, y: 180 },
			},
			openedFolders: { [filteredFolder.id]: true },
			fileGroupPages: { [fileGroupId]: 2 },
			detachedRootNodeIds: { [filteredFolder.id]: true },
			hiddenNodeIds: { [filteredFolder.id]: true },
			}, createFilteredGraph(true));
		const initialState = graphView.state.getState();
		const detachedRootId = createPromotedGraphRootId(filteredFolder.id);
		const detachedRootNodeId = createGraphLayoutNodeId(
			detachedRootId,
			filteredFolder.id,
		);
		const detachedFileGroupId = createGraphLayoutNodeId(
			detachedRootId,
			fileGroupId,
		);
		const detachedFileNodeId = createGraphLayoutNodeId(
			detachedRootId,
			filteredFolder.children[0].id,
		);

		graphView.updateGraph(createFilteredGraph(false));

		assert.strictEqual(graphView.state.getState(), initialState);
		assert.deepStrictEqual(initialState.nodePositions, {
			[detachedRootNodeId]: { x: 320, y: 180 },
			[detachedFileNodeId]: { x: 622, y: 180 },
		});
		assert.deepStrictEqual(initialState.openedFolders, {
			[detachedRootNodeId]: true,
		});
		assert.deepStrictEqual(initialState.fileGroupPages, {
			[detachedFileGroupId]: 2,
		});
		assert.deepStrictEqual(initialState.detachedRootNodeIds, {
			[detachedRootId]: true,
		});
		assert.deepStrictEqual(initialState.hiddenNodeIds, {
			[filteredFolder.id]: true,
		});
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			filteredFolder.id,
		), undefined);
		graphView.dispose();
	});

	test('Graph 갱신마다 persisted Detached Root를 재적용하고 누락 상태는 보존한다', () => {
		const detachedFolder = {
			kind: 'folder' as const,
			id: 'folder:refresh-detached',
			name: 'detached',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:refresh-detached/index.ts',
				name: 'index.ts',
			}],
		};
		const createWorkspaceGraph = (includeDetachedFolder: boolean): Graph => {
			const project: Project = {
				kind: 'project',
				id: 'project:refresh-detached',
				name: 'workspace',
				status: 'loaded',
				children: includeDetachedFolder ? [detachedFolder] : [],
			};

			return createSingleRootGraph(project, 'root:workspace');
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [detachedFolder.id]: { x: 900, y: 500 } },
			openedFolders: { 'project:refresh-detached': true },
			detachedRootNodeIds: {
				[detachedFolder.id]: true,
				'folder:refresh-missing': true,
			},
		}, createWorkspaceGraph(false));
		const detachedRootId = createPromotedGraphRootId(detachedFolder.id);
		const detachedRootNodeId = createGraphLayoutNodeId(
			detachedRootId,
			detachedFolder.id,
		);
		const backlinkId = createFolderBacklinkId(detachedRootId);

		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace']);
		const refreshedWorkspaceGraph = createWorkspaceGraph(true);

		graphView.updateGraph(refreshedWorkspaceGraph);

		const detachedRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedRootNodeId,
		);

		assert.strictEqual(detachedRoot.style.transform, 'translate(900px, 500px)');
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			backlinkId,
		));
		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace', 'detached/']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedRootId]: true,
			'folder:refresh-missing': true,
		});
		assert.strictEqual(refreshedWorkspaceGraph.roots.length, 1);
		assert.strictEqual(
			refreshedWorkspaceGraph.rootNodes[detachedFolder.id],
			undefined,
		);

		const workspaceGraphWithoutDetachedFolder = createWorkspaceGraph(false);

		graphView.updateGraph(workspaceGraphWithoutDetachedFolder);

		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedRootNodeId,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			backlinkId,
		), undefined);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['workspace']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedRootId]: true,
			'folder:refresh-missing': true,
		});
		assert.strictEqual(workspaceGraphWithoutDetachedFolder.roots.length, 1);
		graphView.dispose();
	});

	test('Navigator Filter Checkbox는 Graph State 경로로 표시를 변경하고 Workspace Refresh Tree를 갱신한다', () => {
		const filteredFile = {
			kind: 'file' as const,
			id: 'file:filter-panel/filtered.ts',
			name: 'filtered.ts',
		};
		const siblingFile = {
			kind: 'file' as const,
			id: 'file:filter-panel/sibling.ts',
			name: 'sibling.ts',
		};
		const project: Project = {
			kind: 'project',
			id: 'project:filter-panel',
			name: 'filter-panel',
			status: 'loaded',
			children: [filteredFile, siblingFile],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [project.id]: true },
			hiddenNodeIds: {},
		}, createSingleRootGraph(project));
		const initialHiddenNodeIds = graphView.state.getState().hiddenNodeIds;
		let checkbox = getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			filteredFile.id,
		);
		const initialFileRow = getDescendantByAttribute(
			root,
			'data-file-id',
			filteredFile.id,
		);

		assert.strictEqual(checkbox.checked, true);
		assert.strictEqual(initialFileRow.hidden, false);
		checkbox.checked = false;
		checkbox.dispatch('change', createClickEvent(checkbox));

		assert.notStrictEqual(
			graphView.state.getState().hiddenNodeIds,
			initialHiddenNodeIds,
		);
		assert.deepStrictEqual(initialHiddenNodeIds, {});
		assert.deepStrictEqual(graphView.state.getState().hiddenNodeIds, {
			[filteredFile.id]: true,
		});
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-file-id',
			filteredFile.id,
		), undefined);

		checkbox = getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			filteredFile.id,
		);
		assert.strictEqual(checkbox.checked, false);
		checkbox.checked = true;
		checkbox.dispatch('change', createClickEvent(checkbox));
		assert.deepStrictEqual(graphView.state.getState().hiddenNodeIds, {});
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-file-id',
			filteredFile.id,
		).hidden, false);

		checkbox = getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			filteredFile.id,
		);
		checkbox.checked = false;
		checkbox.dispatch('change', createClickEvent(checkbox));
		const newFile = {
			kind: 'file' as const,
			id: 'file:filter-panel/new.ts',
			name: 'new.ts',
		};
		const refreshedProject: Project = {
			...project,
			children: [filteredFile, siblingFile, newFile],
		};

		graphView.updateGraph(createSingleRootGraph(refreshedProject));
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			filteredFile.id,
		).checked, false);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			newFile.id,
		).checked, true);

		graphView.updateGraph(createSingleRootGraph({
			...refreshedProject,
			children: [siblingFile, newFile],
		}));
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			filteredFile.id,
		), undefined);
		assert.deepStrictEqual(graphView.state.getState().hiddenNodeIds, {
			[filteredFile.id]: true,
		});
		graphView.dispose();
	});

	test('File Filter Checkbox는 File Group Rows, Footer와 높이를 visibleFiles 기준으로 reflow한다', () => {
		const files = Array.from({ length: 6 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:filter-pagination/${index + 1}.ts`,
			name: `${index + 1}.ts`,
		}));
		const project: Project = {
			kind: 'project',
			id: 'project:filter-pagination',
			name: 'filter-pagination',
			status: 'loaded',
			children: files,
		};
		const graph = createSingleRootGraph(project);
		const fileGroupId = createFileGroupId(project.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [fileGroupId]: { x: 520, y: 240 } },
			fileGroupPages: {},
			openedFolders: { [project.id]: true },
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
		}, graph);
		const initialState = graphView.state.getState();
		let fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		let checkbox = getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			files[2]?.id as string,
		);

		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(row) => row.getAttribute('data-file-id'),
			),
			files.slice(0, 5).map((file) => file.id),
		);
		assert.strictEqual(
			getDescendantByClass(fileGroup, 'graph-file-more').textContent,
			'+ 1개 더보기',
		);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(5, true)}px`);

		checkbox.checked = false;
		checkbox.dispatch('change', createClickEvent(checkbox));
		fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);

		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(row) => row.getAttribute('data-file-id'),
			),
			[files[0]?.id, files[1]?.id, files[3]?.id, files[4]?.id, files[5]?.id],
		);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-more'), undefined);
		assert.strictEqual(findDescendantByClass(fileGroup, 'graph-file-controls'), undefined);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(5, false)}px`);
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		));
		assert.strictEqual(graphView.state.getState().fileGroupPages, initialState.fileGroupPages);
		assert.deepStrictEqual(graphView.state.getState().nodePositions, {
			[fileGroupId]: { x: 520, y: 240 },
		});
		assert.strictEqual(graphView.state.getState().openedFolders, initialState.openedFolders);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds,
			initialState.detachedRootNodeIds,
		);

		checkbox = getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			files[2]?.id as string,
		);
		checkbox.checked = true;
		checkbox.dispatch('change', createClickEvent(checkbox));
		fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);

		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(row) => row.getAttribute('data-file-id'),
			),
			files.slice(0, 5).map((file) => file.id),
		);
		assert.strictEqual(
			getDescendantByClass(fileGroup, 'graph-file-more').textContent,
			'+ 1개 더보기',
		);
		assert.strictEqual(fileGroup.style.height, `${getFileGroupHeight(5, true)}px`);
		assert.deepStrictEqual(graphView.state.getState().hiddenNodeIds, {});
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions,
			initialState.nodePositions,
		);
		assert.strictEqual(project.children.length, 6);
		graphView.dispose();
	});

	test('Workspace Refresh와 기존 File Filter를 함께 적용해 Row, Footer와 Tree를 동기화한다', () => {
		const projectId = 'project:refresh-filter';
		const fileGroupId = createFileGroupId(projectId);
		const createFile = (name: string) => ({
			kind: 'file' as const,
			id: `file:refresh-filter/${name}.ts`,
			name: `${name}.ts`,
		});
		const [a, b, c, d, e, f, g, h, i, j, k] = [
			'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K',
		].map(createFile);

		assert.ok(a && b && c && d && e && f && g && h && i && j && k);
		const createGraph = (children: readonly typeof a[]): Graph => createSingleRootGraph({
			kind: 'project',
			id: projectId,
			name: 'refresh-filter',
			status: 'loaded',
			children,
		});
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 10, y: 20, scale: 1.5 },
			nodePositions: { [fileGroupId]: { x: 480, y: 220 } },
			fileGroupPages: { [fileGroupId]: 1 },
			openedFolders: { [projectId]: true },
			detachedRootNodeIds: {},
			hiddenNodeIds: {
				[c.id]: true,
				[h.id]: true,
				[k.id]: true,
			},
		}, createGraph([a, b, c, d, e, f]));
		const initialState = graphView.state.getState();
		const fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const assertProjection = (
			expected: readonly typeof a[],
			remaining: number,
		): void => {
			const currentGroup = getDescendantByAttribute(
				root,
				'data-graph-node-id',
				fileGroupId,
			);
			const more = findDescendantByClass(currentGroup, 'graph-file-more');

			assert.strictEqual(currentGroup, fileGroup);
			assert.deepStrictEqual(
				getDescendantsByClass(currentGroup, 'graph-file-item').map(
					(row) => row.getAttribute('data-file-id'),
				),
				expected.slice(0, 5).map((file) => file.id),
			);
			assert.strictEqual(
				more?.textContent,
				remaining > 0 ? `+ ${remaining}개 더보기` : undefined,
			);
			assert.strictEqual(
				currentGroup.style.height,
				`${getFileGroupHeight(Math.min(expected.length, 5), remaining > 0)}px`,
			);
			assert.ok(findDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				fileGroupId,
			));
			const currentState = graphView.state.getState();

			assert.deepStrictEqual(currentState.nodePositions, {
				[fileGroupId]: { x: 480, y: 220 },
			});
			assert.strictEqual(currentState.fileGroupPages, initialState.fileGroupPages);
			assert.strictEqual(currentState.openedFolders, initialState.openedFolders);
			assert.strictEqual(
				currentState.detachedRootNodeIds,
				initialState.detachedRootNodeIds,
			);
			assert.strictEqual(currentState.hiddenNodeIds, initialState.hiddenNodeIds);
		};

		assertProjection([a, b, d, e, f], 0);
		graphView.updateGraph(createGraph([a, b, c, e, f]));
		assertProjection([a, b, e, f], 0);

		graphView.updateGraph(createGraph([a, b, c, e, f, g]));
		assertProjection([a, b, e, f, g], 0);

		graphView.updateGraph(createGraph([a, b, c, e, f, g, h]));
		assertProjection([a, b, e, f, g], 0);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			h.id,
		).checked, false);

		graphView.updateGraph(createGraph([a, b, c, e, f, g, h, i]));
		assertProjection([a, b, e, f, g, i], 1);

		graphView.updateGraph(createGraph([a, c, e, f, g, h, i]));
		assertProjection([a, e, f, g, i], 0);

		graphView.updateGraph(createGraph([a, b, c, e, f, g, h]));
		assertProjection([a, b, e, f, g], 0);

		graphView.updateGraph(createGraph([a, b, e, f, g, h]));
		assertProjection([a, b, e, f, g], 0);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			c.id,
		), undefined);
		assert.deepStrictEqual(initialState.hiddenNodeIds, {
			[c.id]: true,
			[h.id]: true,
			[k.id]: true,
		});

		graphView.updateGraph(createGraph([h]));
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			h.id,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			h.id,
		), undefined);

		graphView.updateGraph(createGraph([h, j]));
		const restoredGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);

		assert.notStrictEqual(restoredGroup, fileGroup);
		assert.deepStrictEqual(
			getDescendantsByClass(restoredGroup, 'graph-file-item').map(
				(row) => row.getAttribute('data-file-id'),
			),
			[j.id],
		);
		assert.strictEqual(restoredGroup.style.height, `${getFileGroupHeight(1, false)}px`);

		graphView.updateGraph(createGraph([h, j, k]));
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		), restoredGroup);
		assert.deepStrictEqual(
			getDescendantsByClass(restoredGroup, 'graph-file-item').map(
				(row) => row.getAttribute('data-file-id'),
			),
			[j.id],
		);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-filter-checkbox-id',
			k.id,
		).checked, false);
		assert.deepStrictEqual(graphView.state.getState(), initialState);
		graphView.dispose();
	});

	test('Folder Filter를 subtree, Edge와 Minimap에 반영하고 해제 시 기존 상태로 복원한다', () => {
		const hiddenFile = {
			kind: 'file' as const,
			id: 'file:filter-folder/hidden.ts',
			name: 'hidden.ts',
		};
		const visibleFile = {
			kind: 'file' as const,
			id: 'file:filter-folder/visible.ts',
			name: 'visible.ts',
		};
		const descendantFolder = {
			kind: 'folder' as const,
			id: 'folder:filter-folder/descendant',
			name: 'descendant',
			status: 'loaded' as const,
			children: [],
		};
		const hiddenFolder = {
			kind: 'folder' as const,
			id: 'folder:filter-folder',
			name: 'filter-folder',
			status: 'loaded' as const,
			children: [descendantFolder, hiddenFile, visibleFile],
		};
		const siblingFile = {
			kind: 'file' as const,
			id: 'file:filter-sibling.ts',
			name: 'filter-sibling.ts',
		};
		const project: Project = {
			kind: 'project',
			id: 'project:filter-folder',
			name: 'filter-folder',
			status: 'loaded',
			children: [hiddenFolder, siblingFile],
		};
		const graph = createSingleRootGraph(project);
		const fileGroupId = createFileGroupId(hiddenFolder.id);
		const initialHiddenNodeIds = {
			[project.id]: true as const,
			[hiddenFolder.id]: true as const,
			[hiddenFile.id]: true as const,
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {
				[hiddenFolder.id]: { x: 400, y: 180 },
				[siblingFile.id]: { x: 720, y: 260 },
			},
			fileGroupPages: { [fileGroupId]: 2 },
			openedFolders: {
				[project.id]: true,
				[hiddenFolder.id]: true,
				[descendantFolder.id]: true,
			},
			detachedRootNodeIds: {},
			hiddenNodeIds: initialHiddenNodeIds,
		}, graph);
		const projectNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			project.id,
		);
		const folderNode = findDescendantByAttribute(
			root,
			'data-graph-node-id',
			hiddenFolder.id,
		);
		const fileGroup = findDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const descendantFolderNode = findDescendantByAttribute(
			root,
			'data-graph-node-id',
			descendantFolder.id,
		);
		const siblingNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			siblingFile.id,
		);
		const projectToFolderEdge = findDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${project.id}->${hiddenFolder.id}`,
		);
		const folderToFilesEdge = findDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${hiddenFolder.id}->${fileGroupId}`,
		);
		const folderToDescendantEdge = findDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${hiddenFolder.id}->${descendantFolder.id}`,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);

		assert.strictEqual(projectNode.hidden, false);
		assert.strictEqual(folderNode, undefined);
		assert.strictEqual(descendantFolderNode, undefined);
		assert.strictEqual(fileGroup, undefined);
		assert.strictEqual(siblingNode.hidden, false);
		assert.strictEqual(projectToFolderEdge, undefined);
		assert.strictEqual(folderToFilesEdge, undefined);
		assert.strictEqual(folderToDescendantEdge, undefined);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			hiddenFolder.id,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			descendantFolder.id,
		), undefined);
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			siblingFile.id,
		));
		assert.deepStrictEqual(
			graphView.state.getState().hiddenNodeIds,
			initialHiddenNodeIds,
		);

		const preservedState = graphView.state.getState();

		graphView.state.setState({
			camera: preservedState.camera,
			nodePositions: preservedState.nodePositions,
			hiddenNodeIds: {
				[project.id]: true,
				[hiddenFile.id]: true,
			},
		});
		const restoredFolderNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			hiddenFolder.id,
		);
		const restoredDescendantNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			descendantFolder.id,
		);
		const restoredFileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const visibleRows = getDescendantsByClass(
			restoredFileGroup,
			'graph-file-item',
		);
		const restoredProjectToFolderEdge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${project.id}->${hiddenFolder.id}`,
		);
		const restoredFolderToFilesEdge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${hiddenFolder.id}->${fileGroupId}`,
		);
		const restoredFolderToDescendantEdge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${hiddenFolder.id}->${descendantFolder.id}`,
		);

		assert.strictEqual(projectNode.hidden, false);
		assert.strictEqual(restoredFolderNode.hidden, false);
		assert.strictEqual(restoredDescendantNode.hidden, false);
		assert.strictEqual(restoredFileGroup.hidden, false);
		assert.deepStrictEqual(
			visibleRows.map((row) => row.getAttribute('data-file-id')),
			[visibleFile.id],
		);
		assert.strictEqual(restoredProjectToFolderEdge.getAttribute('visibility'), null);
		assert.strictEqual(restoredFolderToFilesEdge.getAttribute('visibility'), null);
		assert.strictEqual(restoredFolderToDescendantEdge.getAttribute('visibility'), null);
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			hiddenFolder.id,
		));

		const filteredState = graphView.state.getState();

		graphView.state.setState({
			camera: filteredState.camera,
			nodePositions: filteredState.nodePositions,
			hiddenNodeIds: { [project.id]: true },
		});

		const restoredRows = getDescendantsByClass(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		), 'graph-file-item');

		assert.deepStrictEqual(
			restoredRows.map((row) => row.getAttribute('data-file-id')),
			[hiddenFile.id, visibleFile.id],
		);
		assert.ok(restoredRows.every((row) => row.hidden === false));
		const finalState = graphView.state.getState();
		const finalLayout = createGraphLayout(graph, {
			fileGroupPages: finalState.fileGroupPages,
			openedFolders: finalState.openedFolders,
			hiddenNodeIds: finalState.hiddenNodeIds,
			unarrangedNodeIds: new Set([hiddenFolder.id, siblingFile.id]),
		});
		const finalFolderLayout = finalLayout.nodes.find(
			(node) => node.id === hiddenFolder.id,
		);
		const finalDescendantLayout = finalLayout.nodes.find(
			(node) => node.id === descendantFolder.id,
		);
		const finalFileGroupLayout = finalLayout.nodes.find(
			(node) => node.id === fileGroupId,
		);
		const finalFolderPosition = finalState.nodePositions[hiddenFolder.id];

		assert.ok(
			finalFolderLayout
			&& finalDescendantLayout
			&& finalFileGroupLayout
			&& finalFolderPosition,
		);
		assert.deepStrictEqual(finalState.nodePositions[descendantFolder.id], {
			x: finalFolderPosition.x
				+ finalDescendantLayout.position.x - finalFolderLayout.position.x,
			y: finalFolderPosition.y
				+ finalDescendantLayout.position.y - finalFolderLayout.position.y,
		});
		assert.deepStrictEqual(finalState.nodePositions[fileGroupId], {
			x: finalFolderPosition.x
				+ finalFileGroupLayout.position.x - finalFolderLayout.position.x,
			y: finalFolderPosition.y
				+ finalFileGroupLayout.position.y - finalFolderLayout.position.y,
		});
		assert.deepStrictEqual(
			finalState.nodePositions[siblingFile.id],
			preservedState.nodePositions[siblingFile.id],
		);
		assert.strictEqual(graphView.state.getState().openedFolders, preservedState.openedFolders);
		assert.strictEqual(graphView.state.getState().fileGroupPages, preservedState.fileGroupPages);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds,
			preservedState.detachedRootNodeIds,
		);
		assert.deepStrictEqual(graph.roots, createSingleRootGraph(project).roots);
		graphView.dispose();
	});

	test('Grouped와 standalone File Filter가 presentation과 저장 page 상태를 유지한다', () => {
		const groupedFiles = Array.from({ length: 7 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:filter-group/${index}.ts`,
			name: `${index}.ts`,
		}));
		const standaloneFile = {
			kind: 'file' as const,
			id: 'file:filter-standalone/index.ts',
			name: 'index.ts',
		};
		const groupedProject: Project = {
			kind: 'project',
			id: 'project:filter-group',
			name: 'filter-group',
			status: 'loaded',
			children: groupedFiles,
		};
		const standaloneProject: Project = {
			kind: 'project',
			id: 'project:filter-standalone',
			name: 'filter-standalone',
			status: 'loaded',
			children: [standaloneFile],
		};
		const graph: Graph = {
			roots: [
				{ id: 'root:filter-group', nodeId: groupedProject.id },
				{ id: 'root:filter-standalone', nodeId: standaloneProject.id },
			],
			rootNodes: {
				[groupedProject.id]: groupedProject,
				[standaloneProject.id]: standaloneProject,
			},
		};
		const fileGroupId = createFileGroupId(groupedProject.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			fileGroupPages: { [fileGroupId]: 2 },
			openedFolders: {
				[groupedProject.id]: true,
				[standaloneProject.id]: true,
			},
			detachedRootNodeIds: {},
			hiddenNodeIds: Object.fromEntries([
				...groupedFiles.map((file) => [file.id, true]),
				[standaloneFile.id, true],
			]) as Record<string, true>,
		}, graph);
		const groupedNode = findDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const standaloneNode = findDescendantByAttribute(
			root,
			'data-graph-node-id',
			standaloneFile.id,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const initialState = graphView.state.getState();

		assert.strictEqual(groupedNode, undefined);
		assert.strictEqual(standaloneNode, undefined);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		), undefined);
		assert.strictEqual(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			standaloneFile.id,
		), undefined);

		graphView.state.setState({
			camera: initialState.camera,
			nodePositions: initialState.nodePositions,
			hiddenNodeIds: {},
		});

		const restoredGroupedNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const restoredRows = getDescendantsByClass(
			restoredGroupedNode,
			'graph-file-item',
		);
		const restoredStandaloneNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			standaloneFile.id,
		);

		assert.strictEqual(restoredRows.length, groupedFiles.length);
		assert.ok(restoredRows.every((row) => row.hidden === false));
		assert.strictEqual(restoredGroupedNode.hidden, false);
		assert.strictEqual(
			restoredGroupedNode.getAttribute('data-file-group-presentation'),
			'grouped',
		);
		assert.strictEqual(
			restoredStandaloneNode.getAttribute('data-file-group-presentation'),
			'standalone',
		);
		assert.strictEqual(graphView.state.getState().fileGroupPages, initialState.fileGroupPages);
		assert.deepStrictEqual(graphView.state.getState().fileGroupPages, {
			[fileGroupId]: 2,
		});
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			fileGroupId,
		));
		assert.ok(findDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			standaloneFile.id,
		));
		graphView.dispose();
	});

	test('Detached Folder/File Root와 Backlink를 Filter 상태만으로 함께 숨기고 복원한다', () => {
		const folderChild = {
			kind: 'file' as const,
			id: 'file:filter-detached-folder/index.ts',
			name: 'index.ts',
		};
		const detachedFolder = {
			kind: 'folder' as const,
			id: 'folder:filter-detached',
			name: 'filter-detached',
			status: 'loaded' as const,
			children: [folderChild],
		};
		const detachedFile = {
			kind: 'file' as const,
			id: 'file:filter-detached.ts',
			name: 'filter-detached.ts',
		};
		const siblingFile = {
			kind: 'file' as const,
			id: 'file:filter-detached-sibling.ts',
			name: 'filter-detached-sibling.ts',
		};
		const project: Project = {
			kind: 'project',
			id: 'project:filter-detached',
			name: 'filter-detached',
			status: 'loaded',
			children: [detachedFolder, detachedFile, siblingFile],
		};
		const graph = createSingleRootGraph(project);
		const folderRootId = createPromotedGraphRootId(detachedFolder.id);
		const fileRootId = createPromotedGraphRootId(detachedFile.id);
		const folderRootNodeId = createGraphLayoutNodeId(
			folderRootId,
			detachedFolder.id,
		);
		const fileRootNodeId = createGraphLayoutNodeId(
			fileRootId,
			detachedFile.id,
		);
		const folderBacklinkId = createFolderBacklinkId(folderRootId);
		const originalFileGroupId = createFileGroupId(project.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {
				[detachedFolder.id]: { x: 760, y: 300 },
				[detachedFile.id]: { x: 980, y: 420 },
			},
			fileGroupPages: { [originalFileGroupId]: 2 },
			openedFolders: {
				[project.id]: true,
				[detachedFolder.id]: true,
			},
			detachedRootNodeIds: {
				[detachedFolder.id]: true,
				[detachedFile.id]: true,
			},
			hiddenNodeIds: {
				[detachedFolder.id]: true,
				[detachedFile.id]: true,
			},
		}, graph);
		const folderRoot = findDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderRootNodeId,
		);
		const folderBacklink = findDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderBacklinkId,
		);
		const fileRoot = getDescendantsByClass(root, 'graph-file-group-node').find(
			(node) => node.getAttribute('data-graph-node-id') === fileRootNodeId,
		);
		const fileBacklink = getDescendantsByClass(root, 'graph-file-item').find(
			(row) => row.getAttribute('data-file-id') === detachedFile.id,
		);
		const siblingRow = getDescendantsByClass(root, 'graph-file-item').find(
			(row) => row.getAttribute('data-file-id') === siblingFile.id,
		);
		const folderBacklinkEdge = findDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${project.id}->${folderBacklinkId}`,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const initialState = graphView.state.getState();

		assert.ok(siblingRow);
		assert.strictEqual(folderRoot, undefined);
		assert.strictEqual(folderBacklink, undefined);
		assert.strictEqual(fileRoot, undefined);
		assert.strictEqual(fileBacklink, undefined);
		assert.strictEqual(siblingRow.hidden, false);
		assert.strictEqual(folderBacklinkEdge, undefined);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['filter-detached']);
		for (const hiddenLayoutNodeId of [
			detachedFolder.id,
			folderBacklinkId,
			detachedFile.id,
		]) {
			assert.strictEqual(findDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				hiddenLayoutNodeId,
			), undefined);
		}

		graphView.state.setState({
			camera: initialState.camera,
			nodePositions: initialState.nodePositions,
			hiddenNodeIds: {},
		});
		const restoredFolderRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderRootNodeId,
		);
		const restoredFolderBacklink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderBacklinkId,
		);
		const restoredFileRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileRootNodeId,
		);
		const restoredFolderBacklinkEdge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${project.id}->${folderBacklinkId}`,
		);

		assert.strictEqual(restoredFolderRoot.hidden, false);
		assert.strictEqual(restoredFolderBacklink.hidden, false);
		assert.strictEqual(restoredFileRoot.hidden, false);
		assert.deepStrictEqual(getNavigatorRootNames(root), [
			'filter-detached',
			'filter-detached/',
			'filter-detached.ts',
		]);
		const restoredFileBacklink = getDescendantsByClass(root, 'graph-file-item').find(
			(row) => row.getAttribute('data-file-id') === detachedFile.id,
		);

		assert.ok(restoredFileBacklink);
		assert.strictEqual(restoredFileBacklink.hidden, false);
		assert.strictEqual(
			restoredFileBacklink.getAttribute('data-target-root-id'),
			fileRootId,
		);
		assert.strictEqual(restoredFolderBacklinkEdge.getAttribute('visibility'), null);
		for (const restoredLayoutNodeId of [
			folderRootNodeId,
			folderBacklinkId,
			fileRootNodeId,
		]) {
			assert.ok(findDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				restoredLayoutNodeId,
			));
		}
		const detachedGraph = applyDetachedGraphRoots(
			graph,
			initialState.detachedRootNodeIds,
		);
		const expectedNodePositions = rebaseNodePositions(
			createGraphLayout(detachedGraph, {
				fileGroupPages: initialState.fileGroupPages,
				openedFolders: initialState.openedFolders,
				hiddenNodeIds: initialState.hiddenNodeIds,
			}),
			createGraphLayout(detachedGraph, {
				fileGroupPages: initialState.fileGroupPages,
				openedFolders: initialState.openedFolders,
				hiddenNodeIds: {},
			}),
				initialState.nodePositions,
				{
					unarrangedNodeIds: new Set([
						folderRootNodeId,
					fileRootNodeId,
				]),
			},
		);

		assert.deepStrictEqual(
			graphView.state.getState().nodePositions,
			expectedNodePositions,
		);
		assert.strictEqual(graphView.state.getState().openedFolders, initialState.openedFolders);
		assert.strictEqual(graphView.state.getState().fileGroupPages, initialState.fileGroupPages);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds,
			initialState.detachedRootNodeIds,
		);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[folderRootId]: true,
			[fileRootId]: true,
		});
		assert.strictEqual(graph.roots.length, 1);
		assert.strictEqual(graph.rootNodes[detachedFolder.id], undefined);
		assert.strictEqual(graph.rootNodes[detachedFile.id], undefined);
		graphView.dispose();
	});

	test('dispose 이후 Graph 갱신 요청을 무시한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);

		graphView.dispose();
		assert.doesNotThrow(() => graphView.updateGraph(
			createSingleRootGraph(GRAPH_MOCK_PROJECT),
		));
		assert.strictEqual(root.children.length, 0);
	});

	test('Navigator Root 선택은 저장 위치와 Layout fallback을 Focus하고 Camera scale을 유지한다', () => {
		const savedFolderPosition = { x: 900, y: 520 };
		const initialScale = 1.4;
		let visibleArea = calculateGraphVisibleArea(
			{ width: 1000, height: 800 },
			{ left: 0, top: 0, width: 1000, height: 800 },
			{ left: 528, top: 12, right: 988, bottom: 788, width: 460, height: 776 },
			'right',
			false,
		);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: { x: 20, y: -30, scale: initialScale },
				nodePositions: {
					[GRAPH_MOCK_FOLDER_ROOT.id]: savedFolderPosition,
				},
			},
			GRAPH_MOCK,
			{ resolveVisibleGraphArea: () => visibleArea },
		);
		const layout = createGraphLayout(GRAPH_MOCK);
		const folderGraphRoot = GRAPH_MOCK.roots.find(
			(root) => root.nodeId === GRAPH_MOCK_FOLDER_ROOT.id,
		);
		const fileGraphRoot = GRAPH_MOCK.roots.find(
			(root) => root.nodeId === GRAPH_MOCK_FILE_ROOT.id,
		);

		assert.ok(folderGraphRoot);
		assert.ok(fileGraphRoot);
		const folderRootNodeId = getGraphRootLayoutNodeId(folderGraphRoot);
		const fileRootNodeId = getGraphRootLayoutNodeId(fileGraphRoot);
		const folderLayout = layout.nodes.find(
			(node) => node.id === folderRootNodeId,
		);
		const fileLayout = layout.nodes.find(
			(node) => node.id === fileRootNodeId,
		);
		const fileRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileRootNodeId,
		);
		const viewport = getDescendantByClass(root, 'graph-viewport');
		const rootButtons = getDescendantsByClass(
			root,
			'graph-navigator-root-button',
		);

		assert.ok(folderLayout);
		assert.ok(fileLayout);
		assert.strictEqual(rootButtons.length, 3);
		assert.notDeepStrictEqual(savedFolderPosition, folderLayout.position);
		const focusOn = graphView.camera.focusOn;

		graphView.camera.focusOn = (point) => focusOn(point, { duration: 0 });
		const initialCamera = graphView.camera.getState();
		const folderButton = rootButtons[1];

		assert.ok(folderButton);
		folderButton.dispatch('click', createClickEvent(folderButton));
		assert.notDeepStrictEqual(graphView.camera.getState(), initialCamera);
		assert.strictEqual(graphView.camera.getState().scale, initialScale);
		assertPointAlmostEqual(
			graphView.camera.worldToViewport({
				x: savedFolderPosition.x + folderLayout.width / 2,
				y: savedFolderPosition.y + folderLayout.height / 2,
			}),
			visibleArea.center,
		);

		visibleArea = createFullGraphVisibleArea({
			width: viewport.clientWidth,
			height: viewport.clientHeight,
		});
		graphView.refreshVisibleGraphArea();

		const fileButton = rootButtons[2];

		assert.ok(fileButton);
		fileButton.dispatch('click', createClickEvent(fileButton));
		assert.strictEqual(graphView.camera.getState().scale, initialScale);
		const currentFilePosition = readTranslate(fileRoot.style.transform);
		assertPointAlmostEqual(
			graphView.camera.worldToViewport({
				x: currentFilePosition.x + fileLayout.width / 2,
				y: currentFilePosition.y + fileLayout.height / 2,
			}),
			visibleArea.center,
		);
		graphView.dispose();
	});

	test('여러 Root의 저장 위치를 독립적으로 같은 Graph World에 렌더링한다', () => {
		const secondaryProject: Project = {
			kind: 'project',
			id: 'project:secondary',
			name: 'secondary',
			status: 'loaded',
			children: [{
				kind: 'file',
				id: 'file:secondary/index.ts',
				name: 'index.ts',
			}],
		};
		const graph: Graph = {
			roots: [
				{ id: 'root:primary', nodeId: GRAPH_MOCK_PROJECT.id },
				{ id: 'root:secondary', nodeId: secondaryProject.id },
			],
			rootNodes: {
				[GRAPH_MOCK_PROJECT.id]: GRAPH_MOCK_PROJECT,
				[secondaryProject.id]: secondaryProject,
			},
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const primaryPosition = { x: 320, y: 180 };
		const secondaryPosition = { x: 760, y: 420 };
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {
				[GRAPH_MOCK_PROJECT.id]: primaryPosition,
				[secondaryProject.id]: secondaryPosition,
			},
		}, graph);
		const primaryRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);
		const secondaryRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			secondaryProject.id,
		);

		assert.strictEqual(
			primaryRoot.style.transform,
			'translate(320px, 180px)',
		);
		assert.strictEqual(
			secondaryRoot.style.transform,
			'translate(760px, 420px)',
		);

		const nextPrimaryPosition = { x: 540, y: 260 };
		const currentState = graphView.state.getState();

		graphView.state.setState({
			camera: { ...currentState.camera },
			nodePositions: {
				...currentState.nodePositions,
				[GRAPH_MOCK_PROJECT.id]: nextPrimaryPosition,
			},
			fileGroupPages: { ...currentState.fileGroupPages },
			openedFolders: { ...currentState.openedFolders },
		});

		assert.strictEqual(
			primaryRoot.style.transform,
			'translate(540px, 260px)',
		);
		assert.strictEqual(
			secondaryRoot.style.transform,
			'translate(760px, 420px)',
		);
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[secondaryProject.id],
			secondaryPosition,
		);
		graphView.dispose();
	});

	test('Node Drag 중 transient 위치는 무시하고 pointerup 저장 뒤 Minimap을 갱신한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		graphView.camera.setState({ x: 0, y: 0, scale: 4 });
		const project = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);
		const minimapNodeLayer = getDescendantByClass(
			root,
			'graph-navigator-minimap-node-layer',
		);
		const initialMinimapNode = getDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);
		const minimapViewportIndicator = getDescendantByClass(
			root,
			'graph-navigator-minimap-viewport-indicator',
		);
		const initialIndicator = readMinimapViewportAttributes(
			minimapViewportIndicator,
		);

		beginNodeDrag(project, 4_000, 2_500);
		assert.strictEqual(
			getDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				GRAPH_MOCK_PROJECT.id,
			),
			initialMinimapNode,
		);
		assert.strictEqual(
			graphView.state.getState().nodePositions[GRAPH_MOCK_PROJECT.id],
			undefined,
		);
		assert.deepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);

		project.dispatch('pointerup', createPointerEvent(project, 4_000, 2_500));
		assert.notStrictEqual(
			getDescendantByAttribute(
				minimapNodeLayer,
				'data-graph-node-id',
				GRAPH_MOCK_PROJECT.id,
			),
			initialMinimapNode,
		);
		assert.ok(graphView.state.getState().nodePositions[GRAPH_MOCK_PROJECT.id]);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);
		graphView.dispose();
	});

	test('Root Focus는 저장 위치를 우선하고 Layout 크기로 Folder/File 중심을 공통 계산한다', () => {
		const folder = {
			kind: 'folder' as const,
			id: 'folder:focus-target',
			name: 'focus-target',
			status: 'loaded' as const,
			children: [],
		};
		const file = {
			kind: 'file' as const,
			id: 'file:focus-target.ts',
			name: 'focus-target.ts',
		};
		const project: Project = {
			kind: 'project',
			id: 'project:focus',
			name: 'focus',
			status: 'loaded',
			children: [folder, file],
		};
		const folderAddition = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			folder.id,
		);

		assert.ok(folderAddition);
		const fileAddition = addGraphRoot(folderAddition.graph, file.id);

		assert.ok(fileAddition);
		const folderRootNodeId = getGraphRootLayoutNodeId(folderAddition.root);
		const fileRootNodeId = getGraphRootLayoutNodeId(fileAddition.root);
		const state = createGraphState({
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: { [folderRootNodeId]: { x: 700, y: 300 } },
			openedFolders: { [project.id]: true },
		});
		const layout = createGraphLayout(fileAddition.graph, {
			openedFolders: state.getState().openedFolders,
		});
		const folderLayout = layout.nodes.find(
			(node) => node.id === folderRootNodeId,
		);
		const fileLayout = layout.nodes.find((node) => node.id === fileRootNodeId);
		const focusPoints: Array<{ x: number; y: number }> = [];
		const camera = { focusOn: (point: { x: number; y: number }) => {
			focusPoints.push(point);
		} };

		assert.ok(folderLayout);
		assert.ok(fileLayout);
		assert.strictEqual(focusGraphRoot(
			fileAddition.graph,
			layout,
			state,
			camera,
			folderAddition.root.id,
		), true);
		assert.strictEqual(focusGraphRoot(
			fileAddition.graph,
			layout,
			state,
			camera,
			fileAddition.root.id,
		), true);
		assert.deepStrictEqual(focusPoints, [
			{
				x: 700 + folderLayout.width / 2,
				y: 300 + folderLayout.height / 2,
			},
			{
				x: fileLayout.position.x + fileLayout.width / 2,
				y: fileLayout.position.y + fileLayout.height / 2,
			},
		]);
		assert.strictEqual(focusGraphRoot(
			fileAddition.graph,
			layout,
			state,
			camera,
			'root:missing',
		), false);
		assert.strictEqual(focusPoints.length, 2);
	});

	test('Folder/grouped/singleton Root Context는 실제 Backlink client 중심을 World로 변환해 Focus한다', () => {
		const folderTarget = {
			kind: 'folder' as const,
			id: 'folder:context-focus-target',
			name: 'context-focus-target',
			status: 'loaded' as const,
			children: [],
		};
		const groupedTarget = {
			kind: 'file' as const,
			id: 'file:grouped/context-focus.ts',
			name: 'context-focus.ts',
		};
		const groupedFolder = {
			kind: 'folder' as const,
			id: 'folder:grouped-context',
			name: 'grouped-context',
			status: 'loaded' as const,
			children: [groupedTarget, {
				kind: 'file' as const,
				id: 'file:grouped/sibling.ts',
				name: 'sibling.ts',
			}],
		};
		const singletonTarget = {
			kind: 'file' as const,
			id: 'file:singleton/context-focus.ts',
			name: 'context-focus.ts',
		};
		const singletonFolder = {
			kind: 'folder' as const,
			id: 'folder:singleton-context',
			name: 'singleton-context',
			status: 'loaded' as const,
			children: [singletonTarget],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:context-focus',
			name: 'context-focus',
			status: 'loaded',
			children: [folderTarget, groupedFolder, singletonFolder],
		};
		const folderAddition = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			folderTarget.id,
		);

		assert.ok(folderAddition);
		const groupedAddition = addGraphRoot(
			folderAddition.graph,
			groupedTarget.id,
		);

		assert.ok(groupedAddition);
		const singletonAddition = addGraphRoot(
			groupedAddition.graph,
			singletonTarget.id,
		);

		assert.ok(singletonAddition);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: { x: 100, y: 50, scale: 2 },
				nodePositions: {},
				openedFolders: {
					[project.id]: true,
					[groupedFolder.id]: true,
					[singletonFolder.id]: true,
				},
			},
			singletonAddition.graph,
		);
		const viewport = root.children[0];

		assert.ok(viewport);
		viewport.boundsLeft = 20;
		viewport.boundsTop = 30;
		const folderBacklink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(folderAddition.root.id),
		);
		const groupedFileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFileGroupId(groupedFolder.id),
		);
		const groupedBacklink = getDescendantByAttribute(
			groupedFileGroup,
			'data-file-id',
			groupedTarget.id,
		);
		const singletonBacklink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFileBacklinkGroupId(singletonAddition.root.id),
		);

		setClientBounds(folderBacklink, 220, 180, 200, 42);
		setClientBounds(groupedBacklink, 480, 300, 180, 30);
		setClientBounds(singletonBacklink, 740, 420, 200, 42);
		const focusPoints: Array<{ x: number; y: number }> = [];

		graphView.camera.focusOn = (point) => focusPoints.push(point);
		const roots = [
			{
				nodeId: getGraphRootLayoutNodeId(folderAddition.root),
				backlink: folderBacklink,
			},
			{
				nodeId: getGraphRootLayoutNodeId(groupedAddition.root),
				backlink: groupedBacklink,
			},
			{
				nodeId: getGraphRootLayoutNodeId(singletonAddition.root),
				backlink: singletonBacklink,
			},
		];

		for (const entry of roots) {
			const rootNode = getDescendantByAttribute(
				root,
				'data-graph-node-id',
				entry.nodeId,
			);
			const label = getDescendantByClass(rootNode, 'graph-root-context-label');
			const clickEvent = createClickEvent(label);

			label.dispatch('click', clickEvent);
			assert.strictEqual(clickEvent.propagationStopped, true);
		}

		assert.deepStrictEqual(focusPoints, roots.map(({ backlink }) => {
			const bounds = backlink.getBoundingClientRect();

			return {
				x: (bounds.left + bounds.width / 2 - viewport.boundsLeft - 100) / 2,
				y: (bounds.top + bounds.height / 2 - viewport.boundsTop - 50) / 2,
			};
		}));
		assert.strictEqual(graphView.state.isFolderOpened(folderTarget.id), false);

		graphView.state.toggleFolder(project.id);
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-node-id',
				createFolderBacklinkId(folderAddition.root.id),
			),
			undefined,
		);
		const folderRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			getGraphRootLayoutNodeId(folderAddition.root),
		);
		const folderLabel = getDescendantByClass(
			folderRoot,
			'graph-root-context-label',
		);

		folderLabel.dispatch('click', createClickEvent(folderLabel));
		assert.strictEqual(focusPoints.length, 3);
		graphView.dispose();
	});

	test('Promoted Folder/grouped/singleton Root는 Backlink Reattach 시 Navigator에서 제거된다', () => {
		const folderChild = {
			kind: 'file' as const,
			id: 'file:reattach-folder/child.ts',
			name: 'child.ts',
		};
		const folderTarget = {
			kind: 'folder' as const,
			id: 'folder:reattach-target',
			name: 'reattach-target',
			status: 'loaded' as const,
			children: [folderChild],
		};
		const groupedFiles = Array.from({ length: 7 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:reattach-group/file-${index + 1}.ts`,
			name: `file-${index + 1}.ts`,
		}));
		const groupedTarget = groupedFiles[5];

		assert.ok(groupedTarget);
		const groupedFolder = {
			kind: 'folder' as const,
			id: 'folder:reattach-group',
			name: 'reattach-group',
			status: 'loaded' as const,
			children: groupedFiles,
		};
		const singletonTarget = {
			kind: 'file' as const,
			id: 'file:reattach-singleton/index.ts',
			name: 'index.ts',
		};
		const singletonFolder = {
			kind: 'folder' as const,
			id: 'folder:reattach-singleton',
			name: 'reattach-singleton',
			status: 'loaded' as const,
			children: [singletonTarget],
		};
		const positionedSibling = {
			kind: 'folder' as const,
			id: 'folder:reattach-positioned-sibling',
			name: 'positioned-sibling',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:reattach',
			name: 'reattach',
			status: 'loaded',
			children: [
				folderTarget,
				groupedFolder,
				singletonFolder,
				positionedSibling,
			],
		};
		const folderAddition = addGraphRoot(
			createSingleRootGraph(project, 'root:project'),
			folderTarget.id,
		);

		assert.ok(folderAddition);
		const groupedAddition = addGraphRoot(
			folderAddition.graph,
			groupedTarget.id,
		);

		assert.ok(groupedAddition);
		const singletonAddition = addGraphRoot(
			groupedAddition.graph,
			singletonTarget.id,
		);

		assert.ok(singletonAddition);
		const folderRootNodeId = getGraphRootLayoutNodeId(folderAddition.root);
		const groupedRootNodeId = getGraphRootLayoutNodeId(groupedAddition.root);
		const singletonRootNodeId = getGraphRootLayoutNodeId(singletonAddition.root);
		const fileGroupId = createFileGroupId(groupedFolder.id);
		const siblingPosition = { x: 910, y: 440 };
		const initialCamera = { x: 35, y: -15, scale: 1.5 };
		const siblingPositionAfterProjectDrag = {
			x: siblingPosition.x + 300 / initialCamera.scale,
			y: siblingPosition.y + 121 / initialCamera.scale,
		};
		const initialOpenedFolders = {
			[project.id]: true as const,
			[folderTarget.id]: true as const,
			[groupedFolder.id]: true as const,
			[singletonFolder.id]: true as const,
		};
		const initialFileGroupPages = { [fileGroupId]: 2 };
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: initialCamera,
				nodePositions: {
					[folderTarget.id]: { x: 520, y: 180 },
					[groupedTarget.id]: { x: 670, y: 260 },
					[singletonTarget.id]: { x: 820, y: 340 },
					[positionedSibling.id]: siblingPosition,
				},
				openedFolders: initialOpenedFolders,
				fileGroupPages: initialFileGroupPages,
				detachedRootNodeIds: {
					[folderTarget.id]: true,
					[groupedTarget.id]: true,
					[singletonTarget.id]: true,
				},
			},
			singletonAddition.graph,
		);
		const rootListButton = getDescendantByClass(
			root,
			'graph-navigator-action-button',
		);
		const rootListPanel = getDescendantByClass(
			root,
			'graph-navigator-root-list-panel',
		);
		const initialNavigatorRootNames = [
			'reattach',
			'reattach-target/',
			'file-6.ts',
			'index.ts',
		];

		rootListButton.dispatch('click', createClickEvent(rootListButton));
		assert.strictEqual(rootListPanel.hidden, false);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'true');
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			initialNavigatorRootNames,
		);
		const getFolderBacklink = () => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(folderAddition.root.id),
		);
		const getGroupedBacklink = () => getDescendantByAttribute(
			getDescendantByAttribute(
				root,
				'data-graph-node-id',
				fileGroupId,
			),
			'data-file-id',
			groupedTarget.id,
		);
		const getSingletonBacklink = () => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFileBacklinkGroupId(singletonAddition.root.id),
		);
		const setBacklinkBounds = (): {
			folder: FakeElement;
			grouped: FakeElement;
			singleton: FakeElement;
		} => {
			const folder = getFolderBacklink();
			const grouped = getGroupedBacklink();
			const singleton = getSingletonBacklink();

			setClientBounds(folder, 200, 100, 200, 42);
			setClientBounds(grouped, 460, 220, 180, 30);
			setClientBounds(singleton, 720, 340, 200, 42);
			return { folder, grouped, singleton };
		};
		let backlinks = setBacklinkBounds();
		const folderRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderRootNodeId,
		);
		const groupedRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			groupedRootNodeId,
		);
		const singletonRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			singletonRootNodeId,
		);
		const projectRoot = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			project.id,
		);
		performNodeDrop(projectRoot, 300, 121);
		assert.ok(graphView.state.getState().nodePositions[project.id]);
		assert.strictEqual(backlinks.folder.hasClass('is-reattach-target'), false);
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			initialNavigatorRootNames,
		);

		performNodeDrop(folderRoot, 550, 235);
		assert.ok(findDescendantByClass(folderRoot, 'graph-root-context-label'));
		assert.ok(graphView.state.getState().nodePositions[folderRootNodeId]);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds[folderAddition.root.id],
			true,
		);
		assert.strictEqual(backlinks.grouped.hasClass('is-reattach-target'), false);

		graphView.state.toggleFolder(project.id);
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-node-id',
				createFolderBacklinkId(folderAddition.root.id),
			),
			undefined,
		);
		performNodeDrop(folderRoot, 300, 121);
		assert.ok(graphView.state.getState().nodePositions[folderRootNodeId]);
		assert.ok(findDescendantByClass(folderRoot, 'graph-root-context-label'));
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			initialNavigatorRootNames,
		);

		graphView.state.toggleFolder(project.id);
		backlinks = setBacklinkBounds();
		assert.strictEqual(
			graphView.state.getState().nodePositions[folderTarget.id],
			undefined,
		);
		beginNodeDrag(folderRoot, 300, 121);
		assert.strictEqual(backlinks.folder.hasClass('is-reattach-target'), true);
		folderRoot.dispatch('pointerup', createPointerEvent(folderRoot, 300, 121));
		assert.strictEqual(backlinks.folder.hasClass('is-reattach-target'), false);
		assert.strictEqual(
			findDescendantByAttribute(
				root,
				'data-graph-node-id',
				createFolderBacklinkId(folderAddition.root.id),
			),
			undefined,
		);
		const restoredFolder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderTarget.id,
		);

		assert.strictEqual(
			findDescendantByClass(restoredFolder, 'graph-root-context-label'),
			undefined,
		);
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderChild.id,
		));
		assert.strictEqual(
			graphView.state.getState().nodePositions[folderRootNodeId],
			undefined,
		);
		const restoredFolderPosition = graphView.state.getState()
			.nodePositions[folderTarget.id];

		assert.ok(restoredFolderPosition);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds[folderAddition.root.id],
			undefined,
		);
		assert.ok(findDescendantByClass(groupedRoot, 'graph-root-context-label'));
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			['reattach', 'file-6.ts', 'index.ts'],
		);

		backlinks.grouped = getGroupedBacklink();
		setClientBounds(backlinks.grouped, 460, 220, 180, 30);
		beginNodeDrag(groupedRoot, 550, 235);
		assert.strictEqual(backlinks.grouped.hasClass('is-reattach-target'), true);
		groupedRoot.dispatch('pointerup', createPointerEvent(groupedRoot, 550, 235));
		const restoredGroupedRow = getDescendantByAttribute(
			getDescendantByAttribute(
				root,
				'data-graph-node-id',
				fileGroupId,
			),
			'data-file-id',
			groupedTarget.id,
		);

		assert.strictEqual(restoredGroupedRow.hasClass('is-backlink'), false);
		assert.strictEqual(
			findDescendantByClass(restoredGroupedRow, 'graph-root-context-label'),
			undefined,
		);
		assert.strictEqual(
			graphView.state.getState().nodePositions[groupedRootNodeId],
			undefined,
		);
		assert.strictEqual(
			graphView.state.getState().detachedRootNodeIds[groupedAddition.root.id],
			undefined,
		);
		assert.ok(findDescendantByClass(singletonRoot, 'graph-root-context-label'));
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			['reattach', 'index.ts'],
		);

		backlinks.singleton = getSingletonBacklink();
		setClientBounds(backlinks.singleton, 720, 340, 200, 42);
		beginNodeDrag(singletonRoot, 820, 361);
		assert.strictEqual(backlinks.singleton.hasClass('is-reattach-target'), true);
		singletonRoot.dispatch(
			'pointerup',
			createPointerEvent(singletonRoot, 820, 361),
		);
		const restoredSingleton = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			singletonTarget.id,
		);

		assert.strictEqual(restoredSingleton.hasClass('is-backlink'), false);
		assert.strictEqual(
			findDescendantByClass(restoredSingleton, 'graph-root-context-label'),
			undefined,
		);
		const finalState = graphView.state.getState();

		assert.deepStrictEqual(
			finalState.nodePositions[folderTarget.id],
			restoredFolderPosition,
		);
		assert.strictEqual(finalState.nodePositions[groupedTarget.id], undefined);
		const restoredSingletonParent = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			singletonFolder.id,
		);
		const finalLayout = createGraphLayout(createSingleRootGraph(
			project,
			'root:project',
		), {
			openedFolders: finalState.openedFolders,
			fileGroupPages: finalState.fileGroupPages,
		});
		const finalSingletonParentLayout = finalLayout.nodes.find(
			(node) => node.id === singletonFolder.id,
		);
		const finalSingletonLayout = finalLayout.nodes.find(
			(node) => node.id === singletonTarget.id,
		);

		assert.ok(finalSingletonParentLayout && finalSingletonLayout);
		assert.deepStrictEqual(subtractPositions(
			readTranslate(restoredSingleton.style.transform),
			readTranslate(restoredSingletonParent.style.transform),
		), subtractPositions(
			finalSingletonLayout.position,
			finalSingletonParentLayout.position,
		));
		assert.deepStrictEqual(finalState.detachedRootNodeIds, {});
		assert.deepStrictEqual(getNavigatorRootNames(root), ['reattach']);
		assert.strictEqual(rootListPanel.hidden, false);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'true');
		const finalSiblingPosition = finalState.nodePositions[positionedSibling.id];

		assert.ok(finalSiblingPosition);
		assert.strictEqual(finalSiblingPosition.x, siblingPositionAfterProjectDrag.x);
		assert.ok(
			Math.abs(
				finalSiblingPosition.y - siblingPositionAfterProjectDrag.y,
			) < 1e-10,
		);
		assert.ok(finalState.nodePositions[project.id]);
		assert.deepStrictEqual(finalState.openedFolders, initialOpenedFolders);
		assert.deepStrictEqual(finalState.fileGroupPages, initialFileGroupPages);
		assert.deepStrictEqual(finalState.camera, initialCamera);
		graphView.dispose();
	});

	test('이동된 Parent에서 생성한 Folder/File Backlink는 항상 정렬 위치를 상속한다', () => {
		const targetFolder = {
			kind: 'folder' as const,
			id: 'folder:backlink-arrangement/target',
			name: 'target',
			status: 'loaded' as const,
			children: [],
		};
		const siblingFolder = {
			kind: 'folder' as const,
			id: 'folder:backlink-arrangement/sibling',
			name: 'sibling',
			status: 'loaded' as const,
			children: [],
		};
		const targetFile = {
			kind: 'file' as const,
			id: 'file:backlink-arrangement/index.ts',
			name: 'index.ts',
		};
		const movedParent = {
			kind: 'folder' as const,
			id: 'folder:backlink-arrangement',
			name: 'backlink-arrangement',
			status: 'loaded' as const,
			children: [targetFolder, siblingFolder, targetFile],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:backlink-arrangement',
			name: 'backlink-arrangement',
			status: 'loaded',
			children: [movedParent],
		};
		const graph = createSingleRootGraph(project);
		const folderBacklinkId = createFolderBacklinkId(
			createPromotedGraphRootId(targetFolder.id),
		);
		const fileBacklinkId = createFileBacklinkGroupId(
			createPromotedGraphRootId(targetFile.id),
		);
		const openedFolders = {
			[project.id]: true as const,
			[movedParent.id]: true as const,
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			nodePositions: {
				[folderBacklinkId]: { x: -900, y: -700 },
				[fileBacklinkId]: { x: -800, y: -600 },
			},
			openedFolders,
		}, graph);
		const nodeLayer = getDescendantByClass(root, 'graph-node-layer');
		const parent = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			movedParent.id,
		);

		performNodeDrop(parent, 1_200, 900);
		const parentPosition = readTranslate(parent.style.transform);
		const folder = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			targetFolder.id,
		);
		const folderHandle = getDescendantByClass(folder, 'graph-detach-handle');

		folderHandle.dispatch('pointerdown', createPointerEvent(folderHandle, 10, 10));
		folderHandle.dispatch('pointermove', createPointerEvent(folderHandle, 30, 30));
		folderHandle.dispatch('pointerup', createPointerEvent(folderHandle, 1_500, 1_000));

		const folderAddition = addGraphRoot(graph, targetFolder.id);

		assert.ok(folderAddition);
		const folderLayout = createGraphLayout(folderAddition.graph, {
			openedFolders,
			unarrangedNodeIds: new Set([movedParent.id, targetFolder.id]),
		});
		const folderParentLayout = folderLayout.nodes.find(
			(node) => node.id === movedParent.id,
		);
		const folderBacklinkLayout = folderLayout.nodes.find(
			(node) => node.id === folderBacklinkId,
		);
		const folderBacklink = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			folderBacklinkId,
		);

		assert.ok(folderParentLayout && folderBacklinkLayout);
		assert.deepStrictEqual(readTranslate(folderBacklink.style.transform), {
			x: folderBacklinkLayout.position.x
				+ parentPosition.x
				- folderParentLayout.position.x,
			y: folderBacklinkLayout.position.y
				+ parentPosition.y
				- folderParentLayout.position.y,
		});
		assert.strictEqual(classifyGraphLayoutNodeArrangement(
			folderLayout,
			graphView.state.getState().nodePositions,
		).unarrangedNodeIds.has(folderBacklinkId), false);

		const file = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			targetFile.id,
		);
		const fileHandle = getDescendantByClass(file, 'graph-detach-handle');

		fileHandle.dispatch('pointerdown', createPointerEvent(fileHandle, 10, 10));
		fileHandle.dispatch('pointermove', createPointerEvent(fileHandle, 30, 30));
		fileHandle.dispatch('pointerup', createPointerEvent(fileHandle, 1_800, 1_200));

		const fileAddition = addGraphRoot(folderAddition.graph, targetFile.id);

		assert.ok(fileAddition);
		const fileLayout = createGraphLayout(fileAddition.graph, {
			openedFolders,
			unarrangedNodeIds: new Set([
				movedParent.id,
				targetFolder.id,
				targetFile.id,
			]),
		});
		const fileParentLayout = fileLayout.nodes.find(
			(node) => node.id === movedParent.id,
		);
		const fileBacklinkLayout = fileLayout.nodes.find(
			(node) => node.id === fileBacklinkId,
		);
		const fileBacklink = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileBacklinkId,
		);

		assert.ok(fileParentLayout && fileBacklinkLayout);
		assert.deepStrictEqual(readTranslate(fileBacklink.style.transform), {
			x: fileBacklinkLayout.position.x
				+ parentPosition.x
				- fileParentLayout.position.x,
			y: fileBacklinkLayout.position.y
				+ parentPosition.y
				- fileParentLayout.position.y,
		});
		assert.strictEqual(classifyGraphLayoutNodeArrangement(
			fileLayout,
			graphView.state.getState().nodePositions,
		).unarrangedNodeIds.has(fileBacklinkId), false);
		graphView.dispose();
	});

	test('File Detach Drop은 Root/Backlink 승격 후 Navigator 목록에 즉시 추가된다', () => {
		const childFolder = {
			kind: 'folder' as const,
			id: 'folder:detach-child',
			name: 'detach-child',
			status: 'loaded' as const,
			children: [],
		};
		const childFile = {
			kind: 'file' as const,
			id: 'file:detach-child/index.ts',
			name: 'index.ts',
		};
		const rootFolder = {
			kind: 'folder' as const,
			id: 'folder:detach-root',
			name: 'detach-root',
			status: 'loaded' as const,
			children: [childFolder, childFile],
		};
		const rootFile = {
			kind: 'file' as const,
			id: 'file:detach-root.ts',
			name: 'detach-root.ts',
		};
		const graph: Graph = {
			roots: [
				{ id: 'root:folder', nodeId: rootFolder.id },
				{ id: 'root:file', nodeId: rootFile.id },
			],
			rootNodes: {
				[rootFolder.id]: rootFolder,
				[rootFile.id]: rootFile,
			},
		};
		const detachDrops: Array<{
			readonly nodeId: string;
			readonly clientX: number;
			readonly clientY: number;
		}> = [];
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: { x: 0, y: 0, scale: 4 },
				nodePositions: {},
				openedFolders: { [rootFolder.id]: true },
			},
			graph,
			{ onDetachDrop: (request) => detachDrops.push(request) },
		);
		const rootListButton = getDescendantByClass(
			root,
			'graph-navigator-action-button',
		);
		const minimap = getDescendantByClass(root, 'graph-navigator-minimap');
		const minimapNodeLayer = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-node-layer',
		);

		const initialMinimapFile = getDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			childFile.id,
		);
		const minimapViewportIndicator = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-viewport-indicator',
		);
		const initialIndicator = readMinimapViewportAttributes(
			minimapViewportIndicator,
		);

		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			['detach-root/', 'detach-root.ts'],
		);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'false');
		const rootFolderNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			rootFolder.id,
		);
		const childFolderNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			childFolder.id,
		);
		const childFileNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			childFile.id,
		);
		const rootFileNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			rootFile.id,
		);

		assert.strictEqual(
			findDescendantByClass(rootFolderNode, 'graph-detach-handle'),
			undefined,
		);
		assert.ok(findDescendantByClass(childFolderNode, 'graph-detach-handle'));
		assert.ok(findDescendantByClass(childFileNode, 'graph-detach-handle'));
		assert.strictEqual(
			findDescendantByClass(rootFileNode, 'graph-detach-handle'),
			undefined,
		);

		const handle = getDescendantByClass(childFileNode, 'graph-detach-handle');
		const detachedFileRootId = createPromotedGraphRootId(childFile.id);
		const detachedFileRootNodeId = createGraphLayoutNodeId(
			detachedFileRootId,
			childFile.id,
		);

		handle.dispatch('pointerdown', createPointerEvent(handle, 20, 30));
		handle.dispatch('pointermove', createPointerEvent(handle, 1_000, 800));
		handle.dispatch('pointerup', createPointerEvent(handle, 4_000, 3_000));
		assert.deepStrictEqual(detachDrops, [{
			nodeId: childFile.id,
			clientX: 4_000,
			clientY: 3_000,
		}]);
		assert.deepStrictEqual(graphView.state.getState().nodePositions, {
			[detachedFileRootNodeId]: { x: 1_000, y: 750 },
		});
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedFileRootId]: true,
		});
		const detachedFileNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFileRootNodeId,
		);

		assert.strictEqual(
			findDescendantByClass(detachedFileNode, 'graph-detach-handle'),
			undefined,
		);
		assert.strictEqual(
			detachedFileNode.style.transform,
			'translate(1000px, 750px)',
		);
		const backlinkGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFileBacklinkGroupId(createPromotedGraphRootId(childFile.id)),
		);

		assert.strictEqual(backlinkGroup.hasClass('is-backlink'), true);
		assert.strictEqual(
			backlinkGroup.getAttribute('data-target-root-id'),
			createPromotedGraphRootId(childFile.id),
		);
		assert.strictEqual(
			findDescendantByClass(backlinkGroup, 'graph-detach-handle') !== undefined,
			true,
		);
		assert.deepStrictEqual(
			getNavigatorRootNames(root),
			['detach-root/', 'detach-root.ts', 'index.ts'],
		);
		assert.deepStrictEqual(getNavigatorRootPaths(root), ['detach-root/']);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(graph.roots.length, 2);
		assert.strictEqual(getDescendantByClass(root, 'graph-navigator-minimap'), minimap);
		assert.notStrictEqual(getDescendantByAttribute(
			minimapNodeLayer,
			'data-graph-node-id',
			detachedFileRootNodeId,
		), initialMinimapFile);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);

		graphView.dispose();
	});

	test('Backlink 반복 Detach, Instance 독립 이동, 중간 Reattach와 ordinal 재계산을 통합 처리한다', () => {
		const child = {
			kind: 'file' as const,
			id: 'file:multiple-detach/child.ts',
			name: 'child.ts',
		};
		const source = {
			kind: 'folder' as const,
			id: 'folder:multiple-detach',
			name: 'multiple-detach',
			status: 'loaded' as const,
			children: [child],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:multiple-detach',
			name: 'multiple-detach',
			status: 'loaded',
			children: [source],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [project.id]: true, [source.id]: true },
		}, createSingleRootGraph(project));
		const backlinkId = createFolderBacklinkId(source.id);
		const detachFrom = (
			node: FakeElement,
			target: { readonly x: number; readonly y: number },
		): void => {
			const handle = getDescendantByClass(node, 'graph-detach-handle');

			handle.dispatch('pointerdown', createPointerEvent(handle, 10, 10));
			handle.dispatch('pointermove', createPointerEvent(handle, 30, 30));
			handle.dispatch(
				'pointerup',
				createPointerEvent(handle, target.x, target.y),
			);
		};
		const getBacklink = () => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			backlinkId,
		);
		const rootId = (ordinal: number) => createDetachedRootId(source.id, ordinal);
		const rootNodeId = (ordinal: number) => createGraphLayoutNodeId(
			rootId(ordinal),
			source.id,
		);
		const childNodeId = (ordinal: number) => createGraphLayoutNodeId(
			rootId(ordinal),
			child.id,
		);
		const getDetachedRoot = (ordinal: number) => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			rootNodeId(ordinal),
		);

		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			source.id,
		), { x: 500, y: 300 });
		detachFrom(getBacklink(), { x: 1_000, y: 500 });
		detachFrom(getBacklink(), { x: 1_500, y: 700 });

		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
			[rootId(2)]: true,
			[rootId(3)]: true,
		});
		assert.deepStrictEqual(getNavigatorRootNames(root), [
			'multiple-detach',
			'multiple-detach/ (1)',
			'multiple-detach/ (2)',
			'multiple-detach/ (3)',
		]);
		for (const ordinal of [1, 2, 3]) {
			assert.ok(getDetachedRoot(ordinal));
			assert.ok(
				findDescendantByAttribute(
					root,
					'data-graph-node-id',
					childNodeId(ordinal),
				),
				`missing ${childNodeId(ordinal)} in ${getDescendantsByClass(
					root,
					'graph-node',
				).map((node) => node.getAttribute('data-graph-node-id')).join(', ')}`,
			);
			assert.strictEqual(
				getDescendantByClass(
					getDetachedRoot(ordinal),
					'graph-detached-root-badge',
				).textContent,
				String(ordinal),
			);
		}
		const visibleState = graphView.state.getState();

		graphView.state.setState({
			camera: visibleState.camera,
			nodePositions: visibleState.nodePositions,
			hiddenNodeIds: { [source.id]: true },
		});
		assert.deepStrictEqual(getNavigatorRootNames(root), ['multiple-detach']);
		for (const ordinal of [1, 2, 3]) {
			assert.strictEqual(findDescendantByAttribute(
				root,
				'data-graph-node-id',
				rootNodeId(ordinal),
			), undefined);
		}

		const hiddenState = graphView.state.getState();

		graphView.state.setState({
			camera: hiddenState.camera,
			nodePositions: hiddenState.nodePositions,
			hiddenNodeIds: {},
		});
		assert.deepStrictEqual(getNavigatorRootNames(root), [
			'multiple-detach',
			'multiple-detach/ (1)',
			'multiple-detach/ (2)',
			'multiple-detach/ (3)',
		]);
		for (const ordinal of [1, 2, 3]) {
			assert.ok(getDetachedRoot(ordinal));
		}
		const secondPositionBeforeMove = readTranslate(
			getDetachedRoot(2).style.transform,
		);
		const thirdPositionBeforeMove = readTranslate(
			getDetachedRoot(3).style.transform,
		);
		const firstChildPositionBeforeMove = readTranslate(
			getDescendantByAttribute(
				root,
				'data-graph-node-id',
				childNodeId(1),
			).style.transform,
		);

		setClientBounds(getBacklink(), -10_000, -10_000, 1, 1);
		performNodeDrop(getDetachedRoot(1), 120, 80);
		assert.deepStrictEqual(
			readTranslate(getDetachedRoot(2).style.transform),
			secondPositionBeforeMove,
		);
		assert.deepStrictEqual(
			readTranslate(getDetachedRoot(3).style.transform),
			thirdPositionBeforeMove,
		);
		assert.deepStrictEqual(
			readTranslate(getDescendantByAttribute(
				root,
				'data-graph-node-id',
				childNodeId(1),
			).style.transform),
			{
				x: firstChildPositionBeforeMove.x + 120,
				y: firstChildPositionBeforeMove.y + 80,
			},
		);

		const reattach = (ordinal: number): void => {
			const backlink = getBacklink();

			setClientBounds(backlink, 200, 100, 200, 42);
			beginNodeDrag(getDetachedRoot(ordinal), 300, 121);
			getDetachedRoot(ordinal).dispatch(
				'pointerup',
				createPointerEvent(getDetachedRoot(ordinal), 300, 121),
			);
		};

		reattach(2);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
			[rootId(3)]: true,
		});
		assert.deepStrictEqual(getNavigatorRootNames(root), [
			'multiple-detach',
			'multiple-detach/ (1)',
			'multiple-detach/ (3)',
		]);
		assert.ok(getBacklink());
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			rootNodeId(2),
		), undefined);

		detachFrom(getBacklink(), { x: 1_900, y: 900 });
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
			[rootId(3)]: true,
			[rootId(4)]: true,
		});
		assert.deepStrictEqual(getNavigatorRootNames(root), [
			'multiple-detach',
			'multiple-detach/ (1)',
			'multiple-detach/ (3)',
			'multiple-detach/ (4)',
		]);
		assert.strictEqual(
			getDescendantByClass(
				getDetachedRoot(4),
				'graph-detached-root-badge',
			).textContent,
			'4',
		);

		reattach(1);
		reattach(3);
		reattach(4);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {});
		assert.deepStrictEqual(getNavigatorRootNames(root), ['multiple-detach']);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			backlinkId,
		), undefined);
		const restoredSource = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			source.id,
		);

		detachFrom(restoredSource, { x: 700, y: 400 });
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
		});
		assert.deepStrictEqual(getNavigatorRootNames(root), [
			'multiple-detach',
			'multiple-detach/',
		]);
		assert.strictEqual(
			findDescendantByClass(
				getDetachedRoot(1),
				'graph-detached-root-badge',
			),
			undefined,
		);
		graphView.dispose();
	});

	test('Hover Duplicate/Delete는 Multiple Detach/Reattach 경로와 subtree 위치·ordinal을 공유한다', () => {
		const child = {
			kind: 'file' as const,
			id: 'file:hover-action-flow/child.ts',
			name: 'child.ts',
		};
		const source = {
			kind: 'folder' as const,
			id: 'folder:hover-action-flow',
			name: 'hover-action-flow',
			status: 'loaded' as const,
			children: [child],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:hover-action-flow',
			name: 'hover-action-flow',
			status: 'loaded',
			children: [source],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [project.id]: true, [source.id]: true },
		}, createSingleRootGraph(project));
		const rootId = (ordinal: number) => createDetachedRootId(source.id, ordinal);
		const rootNodeId = (ordinal: number) => createGraphLayoutNodeId(
			rootId(ordinal),
			source.id,
		);
		const childNodeId = (ordinal: number) => createGraphLayoutNodeId(
			rootId(ordinal),
			child.id,
		);
		const getDetachedRoot = (ordinal: number) => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			rootNodeId(ordinal),
		);
		const clickAction = (
			ordinal: number,
			action: 'duplicate' | 'delete',
		): void => {
			const button = getDescendantByAttribute(
				getDetachedRoot(ordinal),
				'data-detached-root-action',
				action,
			);

			button.dispatch('click', createClickEvent(button));
		};
		const detachFrom = (
			node: FakeElement,
			target: { readonly x: number; readonly y: number },
		): void => {
			const handle = getDescendantByClass(node, 'graph-detach-handle');

			handle.dispatch('pointerdown', createPointerEvent(handle, 10, 10));
			handle.dispatch('pointermove', createPointerEvent(handle, 30, 30));
			handle.dispatch(
				'pointerup',
				createPointerEvent(handle, target.x, target.y),
			);
		};

		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			source.id,
		), { x: 600, y: 320 });
		const firstRootTransform = getDetachedRoot(1).style.transform;
		const firstChildTransform = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			childNodeId(1),
		).style.transform;
		const firstRootPosition = readTranslate(firstRootTransform);
		const firstChildPosition = readTranslate(firstChildTransform);

		clickAction(1, 'duplicate');
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
			[rootId(2)]: true,
		});
		assert.strictEqual(getDetachedRoot(1).style.transform, firstRootTransform);
		assert.strictEqual(
			getDescendantByAttribute(
				root,
				'data-graph-node-id',
				childNodeId(1),
			).style.transform,
			firstChildTransform,
		);
		assert.deepStrictEqual(readTranslate(getDetachedRoot(2).style.transform), {
			x: firstRootPosition.x,
			y: Math.max(
				firstRootPosition.y + GRAPH_FOLDER_NODE_HEIGHT,
				firstChildPosition.y + GRAPH_FOLDER_NODE_HEIGHT,
			) + GRAPH_LAYOUT_ROOT_GAP,
		});
		assert.ok(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			childNodeId(2),
		));
		for (const ordinal of [1, 2]) {
			assert.strictEqual(
				getDescendantByClass(
					getDetachedRoot(ordinal),
					'graph-detached-root-badge',
				).textContent,
				String(ordinal),
			);
		}

		clickAction(2, 'duplicate');
		clickAction(2, 'delete');
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
			[rootId(3)]: true,
		});
		assert.ok(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(source.id),
		));
		clickAction(1, 'duplicate');
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
			[rootId(3)]: true,
			[rootId(4)]: true,
		});
		for (const ordinal of [1, 3, 4]) {
			assert.strictEqual(
				getDescendantByClass(
					getDetachedRoot(ordinal),
					'graph-detached-root-badge',
				).textContent,
				String(ordinal),
			);
		}

		clickAction(1, 'delete');
		clickAction(3, 'delete');
		assert.strictEqual(
			findDescendantByClass(
				getDetachedRoot(4),
				'graph-detached-root-badge',
			),
			undefined,
		);
		clickAction(4, 'delete');
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {});
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(source.id),
		), undefined);
		const restoredSource = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			source.id,
		);

		detachFrom(restoredSource, { x: 700, y: 400 });
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[rootId(1)]: true,
		});
		graphView.dispose();
	});

	test('standalone/grouped File Detached Root도 동일 Hover Duplicate/Delete를 사용한다', () => {
		for (const presentation of ['standalone', 'grouped'] as const) {
			const source = {
				kind: 'file' as const,
				id: `file:hover-file-action/${presentation}.ts`,
				name: `${presentation}.ts`,
			};
			const sibling = {
				kind: 'file' as const,
				id: `file:hover-file-action/${presentation}-sibling.ts`,
				name: `${presentation}-sibling.ts`,
			};
			const project: Project = {
				kind: 'project',
				id: `project:hover-file-action/${presentation}`,
				name: `hover-file-action-${presentation}`,
				status: 'loaded',
				children: presentation === 'grouped'
					? [source, sibling]
					: [source],
			};
			const ownerDocument = new FakeDocument();
			const root = ownerDocument.createElement('section');
			const graphView = initializeGraphView(root.asHtmlElement(), {
				camera: { x: 0, y: 0, scale: 1 },
				nodePositions: {},
				openedFolders: { [project.id]: true },
			}, createSingleRootGraph(project));
			const sourceElement = getDescendantByAttribute(
				root,
				'data-file-id',
				source.id,
			);
			const detachHandle = getDescendantByClass(
				sourceElement,
				'graph-detach-handle',
			);

			detachHandle.dispatch(
				'pointerdown',
				createPointerEvent(detachHandle, 10, 10),
			);
			detachHandle.dispatch(
				'pointermove',
				createPointerEvent(detachHandle, 30, 30),
			);
			detachHandle.dispatch(
				'pointerup',
				createPointerEvent(detachHandle, 600, 320),
			);
			const rootId = (ordinal: number) => createDetachedRootId(
				source.id,
				ordinal,
			);
			const getDetachedFile = (ordinal: number) => getDescendantByAttribute(
				root,
				'data-graph-node-id',
				createGraphLayoutNodeId(rootId(ordinal), source.id),
			);
			const clickAction = (
				ordinal: number,
				action: 'duplicate' | 'delete',
			): void => {
				const button = getDescendantByAttribute(
					getDetachedFile(ordinal),
					'data-detached-root-action',
					action,
				);

				button.dispatch('click', createClickEvent(button));
			};

			clickAction(1, 'duplicate');
			assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
				[rootId(1)]: true,
				[rootId(2)]: true,
			});
			assert.ok(getDetachedFile(1));
			assert.ok(getDetachedFile(2));
			clickAction(1, 'delete');
			assert.strictEqual(
				findDescendantByClass(
					getDetachedFile(2),
					'graph-detached-root-badge',
				),
				undefined,
			);
			clickAction(2, 'delete');
			assert.deepStrictEqual(
				graphView.state.getState().detachedRootNodeIds,
				{},
			);
			assert.ok(getDescendantByAttribute(
				root,
				'data-file-id',
				source.id,
			));
			graphView.dispose();
		}
	});

	test('Folder open과 하위 File Detach/Reattach는 시작한 Root Instance에만 적용된다', () => {
		const file = {
			kind: 'file' as const,
			id: 'file:instance-owned/child.ts',
			name: 'child.ts',
		};
		const folder = {
			kind: 'folder' as const,
			id: 'folder:instance-owned',
			name: 'instance-owned',
			status: 'loaded' as const,
			children: [file],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:instance-owned',
			name: 'instance-owned',
			status: 'loaded',
			children: [folder],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: { [project.id]: true, [folder.id]: true },
		}, createSingleRootGraph(project));
		const detachFrom = (
			node: FakeElement,
			target: { readonly x: number; readonly y: number },
		): void => {
			const handle = getDescendantByClass(node, 'graph-detach-handle');

			handle.dispatch('pointerdown', createPointerEvent(handle, 10, 10));
			handle.dispatch('pointermove', createPointerEvent(handle, 30, 30));
			handle.dispatch(
				'pointerup',
				createPointerEvent(handle, target.x, target.y),
			);
		};
		const parentRootId = (ordinal: number) => createDetachedRootId(
			folder.id,
			ordinal,
		);
		const parentNodeId = (ordinal: number) => createGraphLayoutNodeId(
			parentRootId(ordinal),
			folder.id,
		);
		const fileNodeId = (ordinal: number) => createGraphLayoutNodeId(
			parentRootId(ordinal),
			file.id,
		);
		const getParent = (ordinal: number) => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parentNodeId(ordinal),
		);
		const getOriginalBacklink = () => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(folder.id),
		);

		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folder.id,
		), { x: 500, y: 300 });
		detachFrom(getOriginalBacklink(), { x: 900, y: 500 });
		detachFrom(getOriginalBacklink(), { x: 1_300, y: 700 });

		getParent(2).dispatch('click', createClickEvent(getParent(2)));
		assert.ok(findDescendantByAttribute(root, 'data-graph-node-id', fileNodeId(1)));
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-node-id', fileNodeId(2)),
			undefined,
		);
		assert.ok(findDescendantByAttribute(root, 'data-graph-node-id', fileNodeId(3)));
		assert.strictEqual(graphView.state.isFolderOpened(parentNodeId(1)), true);
		assert.strictEqual(graphView.state.isFolderOpened(parentNodeId(2)), false);
		assert.strictEqual(graphView.state.isFolderOpened(parentNodeId(3)), true);

		getParent(2).dispatch('click', createClickEvent(getParent(2)));
		const secondFile = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileNodeId(2),
		);

		detachFrom(secondFile, { x: 1_700, y: 900 });
		const detachedFileRootId = createDetachedRootId(
			file.id,
			1,
			parentRootId(2),
		);
		const detachedFileNodeId = createGraphLayoutNodeId(
			detachedFileRootId,
			file.id,
		);
		const secondBacklinkId = createGraphLayoutNodeId(
			parentRootId(2),
			createFileBacklinkGroupId(file.id),
		);
		const firstFile = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileNodeId(1),
		);
		const thirdFile = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileNodeId(3),
		);
		const secondBacklink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			secondBacklinkId,
		);

		assert.strictEqual(getDetachedRootOriginId(detachedFileRootId), parentRootId(2));
		assert.strictEqual(firstFile.hasClass('is-backlink'), false);
		assert.strictEqual(thirdFile.hasClass('is-backlink'), false);
		assert.strictEqual(secondBacklink.hasClass('is-backlink'), true);
		assert.strictEqual(
			getDescendantsByClass(secondBacklink, 'graph-detach-handle').length,
			1,
		);
		assert.strictEqual(
			findDescendantByClass(secondBacklink, 'graph-backlink-indicator'),
			undefined,
		);
		const detachedFile = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFileNodeId,
		);

		setClientBounds(secondBacklink, 2_000, 2_000, 200, 42);
		setClientBounds(firstFile, 200, 100, 200, 42);
		beginNodeDrag(detachedFile, 300, 121);
		detachedFile.dispatch(
			'pointerup',
			createPointerEvent(detachedFile, 300, 121),
		);
		assert.ok(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFileNodeId,
		));

		setClientBounds(secondBacklink, 200, 100, 200, 42);
		beginNodeDrag(detachedFile, 300, 121);
		detachedFile.dispatch(
			'pointerup',
			createPointerEvent(detachedFile, 300, 121),
		);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFileNodeId,
		), undefined);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileNodeId(2),
		).hasClass('is-backlink'), false);
		assert.strictEqual(firstFile.hasClass('is-backlink'), false);
		assert.strictEqual(thirdFile.hasClass('is-backlink'), false);
		graphView.dispose();
	});

	test('하위 Detached Root가 있는 복구는 Drag를 즉시 취소하고 목록 확인 후 깊은 Root부터 함께 복구한다', async () => {
		const file = {
			kind: 'file' as const,
			id: 'file:reattach-warning/child/leaf.ts',
			name: 'leaf.ts',
		};
		const childFolder = {
			kind: 'folder' as const,
			id: 'folder:reattach-warning/child',
			name: 'child',
			status: 'loaded' as const,
			children: [file],
		};
		const parentFolder = {
			kind: 'folder' as const,
			id: 'folder:reattach-warning',
			name: 'reattach-warning',
			status: 'loaded' as const,
			children: [childFolder],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:reattach-warning',
			name: 'warning-workspace',
			status: 'loaded',
			children: [parentFolder],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: {
				[project.id]: true,
				[parentFolder.id]: true,
				[childFolder.id]: true,
			},
		}, createSingleRootGraph(project));
		const detachFrom = (
			node: FakeElement,
			target: { readonly x: number; readonly y: number },
		): void => {
			const handle = getDescendantByClass(node, 'graph-detach-handle');

			handle.dispatch('pointerdown', createPointerEvent(handle, 10, 10));
			handle.dispatch('pointermove', createPointerEvent(handle, 30, 30));
			handle.dispatch(
				'pointerup',
				createPointerEvent(handle, target.x, target.y),
			);
		};
		const parentRootId = createDetachedRootId(parentFolder.id, 1);
		const childRootId = createDetachedRootId(
			childFolder.id,
			1,
			parentRootId,
		);
		const fileRootId = createDetachedRootId(file.id, 1, childRootId);
		const parentRootNodeId = createGraphLayoutNodeId(
			parentRootId,
			parentFolder.id,
		);
		const childNodeInParentId = createGraphLayoutNodeId(
			parentRootId,
			childFolder.id,
		);
		const fileNodeInChildId = createGraphLayoutNodeId(childRootId, file.id);

		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parentFolder.id,
		), { x: 600, y: 300 });
		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			childNodeInParentId,
		), { x: 1_000, y: 500 });
		detachFrom(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileNodeInChildId,
		), { x: 1_400, y: 700 });

		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[parentRootId]: true,
			[childRootId]: true,
			[fileRootId]: true,
		});
		const getParentRoot = () => getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parentRootNodeId,
		);
		const parentBacklink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(parentFolder.id),
		);
		const positionBeforeRestore = getParentRoot().style.transform;

		setClientBounds(parentBacklink, 200, 100, 200, 42);
		beginNodeDrag(getParentRoot(), 300, 121);
		assert.notStrictEqual(getParentRoot().style.transform, positionBeforeRestore);
		getParentRoot().dispatch(
			'pointerup',
			createPointerEvent(getParentRoot(), 300, 121),
		);

		assert.strictEqual(getParentRoot().style.transform, positionBeforeRestore);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[parentRootId]: true,
			[childRootId]: true,
			[fileRootId]: true,
		});
		const warning = getDescendantByClass(
			root,
			'graph-reattach-confirm-overlay',
		);
		const warningItems = getDescendantsByClass(
			warning,
			'graph-reattach-confirm-item',
		);

		assert.strictEqual(warning.hidden, false);
		assert.strictEqual(
			getDescendantByClass(warning, 'graph-reattach-confirm-title').textContent,
			'하위 분리 노드가 있습니다',
		);
		assert.deepStrictEqual(
			warningItems.map((item) => item.getAttribute('data-detached-root-id')),
			[childRootId, fileRootId],
		);
		assert.ok(getText(warningItems[0]).includes(childFolder.name));
		assert.ok(getText(warningItems[1]).includes(file.name));

		getDescendantByClass(warning, 'graph-reattach-confirm-cancel').dispatch(
			'click',
			createClickEvent(getDescendantByClass(
				warning,
				'graph-reattach-confirm-cancel',
			)),
		);
		await Promise.resolve();
		assert.strictEqual(warning.hidden, true);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[parentRootId]: true,
			[childRootId]: true,
			[fileRootId]: true,
		});

		beginNodeDrag(getParentRoot(), 300, 121);
		getParentRoot().dispatch(
			'pointerup',
			createPointerEvent(getParentRoot(), 300, 121),
		);
		getDescendantByClass(warning, 'graph-reattach-confirm-accept').dispatch(
			'click',
			createClickEvent(getDescendantByClass(
				warning,
				'graph-reattach-confirm-accept',
			)),
		);
		await Promise.resolve();

		assert.strictEqual(warning.hidden, true);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {});
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			parentRootNodeId,
		), undefined);
		assert.ok(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parentFolder.id,
		));
		graphView.dispose();
	});

	test('전체 정렬은 미정렬 Node의 저장 좌표를 지우고 기본 Layout 위치로 되돌린다', async () => {
		const folder = {
			kind: 'folder' as const,
			id: 'folder:arrange-all-unarranged',
			name: 'unarranged',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:arrange-all-unarranged',
			name: 'arrange-all',
			status: 'loaded',
			children: [folder],
		};
		const graph = createSingleRootGraph(project);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const openedFolders = { [project.id]: true as const };
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 30, y: -20, scale: 1.25 },
			nodePositions: { [folder.id]: { x: 900, y: 640 } },
			openedFolders,
		}, graph);
		const defaultLayout = createGraphLayout(graph, { openedFolders });
		const defaultFolder = defaultLayout.nodes.find((node) => node.id === folder.id);

		assert.ok(defaultFolder);
		assert.deepStrictEqual(readTranslate(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folder.id,
		).style.transform), { x: 900, y: 640 });

		const dialog = openArrangeAllDialog(root);

		getDescendantByClass(dialog, 'graph-arrange-all-confirm-accept').dispatch(
			'click',
			createClickEvent(getDescendantByClass(
				dialog,
				'graph-arrange-all-confirm-accept',
			)),
		);
		await Promise.resolve();

		assert.deepStrictEqual(graphView.state.getState().nodePositions, {});
		assert.deepStrictEqual(readTranslate(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folder.id,
		).style.transform), defaultFolder.position);
		assert.deepStrictEqual(graphView.state.getState().camera, {
			x: 30,
			y: -20,
			scale: 1.25,
		});
		graphView.dispose();
	});

	test('전체 정렬은 Detached Root와 Backlink를 canonical Workspace Graph로 복구한다', async () => {
		const folder = {
			kind: 'folder' as const,
			id: 'folder:arrange-all-detached',
			name: 'detached',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:arrange-all-detached',
			name: 'arrange-all',
			status: 'loaded',
			children: [folder],
		};
		const graph = createSingleRootGraph(project);
		const rootId = createDetachedRootId(folder.id, 1);
		const detachedFolderId = createGraphLayoutNodeId(rootId, folder.id);
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			openedFolders: {
				[project.id]: true,
				[detachedFolderId]: true,
			},
			detachedRootNodeIds: { [rootId]: true },
		}, graph);

		assert.ok(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFolderId,
		));
		assert.ok(getDescendantByClass(root, 'graph-folder-backlink-node'));

		const dialog = openArrangeAllDialog(root);

		getDescendantByClass(dialog, 'graph-arrange-all-confirm-accept').dispatch(
			'click',
			createClickEvent(getDescendantByClass(
				dialog,
				'graph-arrange-all-confirm-accept',
			)),
		);
		await Promise.resolve();

		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {});
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFolderId,
		), undefined);
		assert.strictEqual(
			findDescendantByClass(root, 'graph-folder-backlink-node'),
			undefined,
		);
		assert.ok(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folder.id,
		));
		assert.strictEqual(graphView.state.isFolderOpened(folder.id), true);
		graphView.dispose();
	});

	test('전체 정렬 취소는 Graph, State와 Layout을 변경하지 않는다', async () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 10, y: 20, scale: 1.5 },
			nodePositions: { [GRAPH_MOCK_PROJECT.id]: { x: 780, y: 520 } },
			openedFolders: { [GRAPH_MOCK_PROJECT.id]: true },
		}, GRAPH_MOCK);
		const beforeState = graphView.state.getState();
		const beforeTransform = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		).style.transform;
		let stateChanges = 0;
		const unsubscribe = graphView.state.subscribe(() => stateChanges += 1);
		const dialog = openArrangeAllDialog(root);

		assert.strictEqual(
			getDescendantByClass(dialog, 'graph-arrange-all-confirm-title').textContent,
			'그래프를 전부 정렬하시겠습니까?',
		);
		assert.strictEqual(
			getDescendantByClass(dialog, 'graph-arrange-all-confirm-message').textContent,
			'분리된 노드와 미정렬 상태의 노드들이 정렬됩니다.',
		);
		getDescendantByClass(dialog, 'graph-arrange-all-confirm-cancel').dispatch(
			'click',
			createClickEvent(getDescendantByClass(
				dialog,
				'graph-arrange-all-confirm-cancel',
			)),
		);
		await Promise.resolve();

		assert.strictEqual(dialog.hidden, true);
		assert.strictEqual(graphView.state.getState(), beforeState);
		assert.strictEqual(stateChanges, 0);
		assert.strictEqual(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		).style.transform, beforeTransform);
		unsubscribe();
		graphView.dispose();
	});

	test('전체 정렬은 중첩 Detached visual state와 미정렬 좌표를 한 번에 복구해 저장한다', async () => {
		const files = Array.from({ length: 12 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:arrange-all/a/b/c/${index}.ts`,
			name: `${index}.ts`,
		}));
		const childC = {
			kind: 'folder' as const,
			id: 'folder:arrange-all/a/b/c',
			name: 'c',
			status: 'loaded' as const,
			children: files,
		};
		const childB = {
			kind: 'folder' as const,
			id: 'folder:arrange-all/a/b',
			name: 'b',
			status: 'loaded' as const,
			children: [childC],
		};
		const childA = {
			kind: 'folder' as const,
			id: 'folder:arrange-all/a',
			name: 'a',
			status: 'loaded' as const,
			children: [childB],
		};
		const unrelated = {
			kind: 'folder' as const,
			id: 'folder:arrange-all/unrelated',
			name: 'unrelated',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:arrange-all/unrelated.ts',
				name: 'unrelated.ts',
			}],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:arrange-all-nested',
			name: 'arrange-all-nested',
			status: 'loaded',
			children: [childA, unrelated],
		};
		const graph = createSingleRootGraph(project);
		const rootA = createDetachedRootId(childA.id, 1);
		const rootB = createDetachedRootId(childB.id, 1, rootA);
		const rootC = createDetachedRootId(childC.id, 1, rootB);
		const detachedAId = createGraphLayoutNodeId(rootA, childA.id);
		const detachedBId = createGraphLayoutNodeId(rootB, childB.id);
		const detachedCId = createGraphLayoutNodeId(rootC, childC.id);
		const childCFileGroupId = createFileGroupId(childC.id);
		const detachedCFileGroupId = createGraphLayoutNodeId(
			rootC,
			childCFileGroupId,
		);
		const unrelatedFileGroupId = createFileGroupId(unrelated.id);
		const camera = { x: 125, y: -75, scale: 1.5 };
		const hiddenNodeIds = { [unrelated.id]: true as const };
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera,
			nodePositions: {
				[project.id]: { x: 420, y: 260 },
				[detachedAId]: { x: 900, y: 540 },
			},
			openedFolders: {
				[project.id]: true,
				[detachedAId]: true,
				[detachedBId]: true,
				[detachedCId]: true,
				[unrelated.id]: true,
			},
			fileGroupPages: {
				[detachedCFileGroupId]: 2,
				[unrelatedFileGroupId]: 3,
			},
			detachedRootNodeIds: {
				[rootA]: true,
				[rootB]: true,
				[rootC]: true,
			},
			hiddenNodeIds,
		}, graph);
		const originalSetState = graphView.state.setState.bind(graphView.state);
		let setStateCalls = 0;
		let stateChanges = 0;

		graphView.state.setState = (nextState) => {
			setStateCalls += 1;
			originalSetState(nextState);
		};
		const unsubscribe = graphView.state.subscribe(() => stateChanges += 1);
		const dialog = openArrangeAllDialog(root);

		getDescendantByClass(dialog, 'graph-arrange-all-confirm-accept').dispatch(
			'click',
			createClickEvent(getDescendantByClass(
				dialog,
				'graph-arrange-all-confirm-accept',
			)),
		);
		await Promise.resolve();

		const arrangedState = graphView.state.getState();

		assert.strictEqual(setStateCalls, 1);
		assert.strictEqual(stateChanges, 1);
		assert.deepStrictEqual(arrangedState.camera, camera);
		assert.deepStrictEqual(arrangedState.hiddenNodeIds, hiddenNodeIds);
		assert.deepStrictEqual(arrangedState.detachedRootNodeIds, {});
		assert.deepStrictEqual(arrangedState.nodePositions, {});
		assert.deepStrictEqual(arrangedState.openedFolders, {
			[project.id]: true,
			[childA.id]: true,
			[childB.id]: true,
			[childC.id]: true,
			[unrelated.id]: true,
		});
		assert.deepStrictEqual(arrangedState.fileGroupPages, {
			[childCFileGroupId]: 2,
			[unrelatedFileGroupId]: 3,
		});
		assert.deepStrictEqual(getNavigatorRootNames(root), [project.name]);
		assert.strictEqual(
			getDescendantsByClass(root, 'graph-folder-backlink-node').length,
			0,
		);
		assert.ok(getDescendantByAttribute(
			root,
			'data-graph-node-id',
			childC.id,
		));

		const restoredRoot = ownerDocument.createElement('section');
		const restoredView = initializeGraphView(restoredRoot.asHtmlElement(), {
			camera: { ...arrangedState.camera },
			nodePositions: { ...arrangedState.nodePositions },
			fileGroupPages: { ...arrangedState.fileGroupPages },
			openedFolders: { ...arrangedState.openedFolders },
			detachedRootNodeIds: { ...arrangedState.detachedRootNodeIds },
			hiddenNodeIds: { ...arrangedState.hiddenNodeIds },
		}, graph);

		assert.deepStrictEqual(restoredView.state.getState().detachedRootNodeIds, {});
		assert.deepStrictEqual(restoredView.state.getState().nodePositions, {});
		assert.deepStrictEqual(getNavigatorRootNames(restoredRoot), [project.name]);
		assert.strictEqual(
			getDescendantsByClass(restoredRoot, 'graph-folder-backlink-node').length,
			0,
		);
		assert.ok(getDescendantByAttribute(
			restoredRoot,
			'data-graph-node-id',
			childC.id,
		));

		unsubscribe();
		restoredView.dispose();
		graphView.dispose();
	});

	test('Folder Detach는 Navigator에 추가되고 Focus 후 Reattach 시 즉시 제거된다', () => {
		const promotedFolder = {
			kind: 'folder' as const,
			id: 'folder:src',
			name: 'src',
			status: 'loaded' as const,
			children: [{
				kind: 'file' as const,
				id: 'file:src/index.ts',
				name: 'index.ts',
			}],
		};
		const sibling = {
			kind: 'folder' as const,
			id: 'folder:docs',
			name: 'docs',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:promotion',
			name: 'crispy',
			status: 'loaded',
			children: [promotedFolder, sibling],
		};
		const graph = createSingleRootGraph(project, 'root:project');
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const siblingPosition = { x: 700, y: 240 };
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 100, y: 50, scale: 2 },
			nodePositions: { [sibling.id]: siblingPosition },
			openedFolders: {
				[project.id]: true,
				[promotedFolder.id]: true,
			},
			fileGroupPages: { [`${promotedFolder.id}:files`]: 3 },
		}, graph);
		const viewport = root.children[0];
		const rootListButton = getDescendantByClass(
			root,
			'graph-navigator-action-button',
		);
		const rootListPanel = getDescendantByClass(
			root,
			'graph-navigator-root-list-panel',
		);
		const minimap = getDescendantByClass(root, 'graph-navigator-minimap');
		const minimapNodeLayer = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-node-layer',
		);
		const initialMinimapNodeCount = minimapNodeLayer.children.length;
		const minimapViewportIndicator = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-viewport-indicator',
		);
		const initialIndicator = readMinimapViewportAttributes(
			minimapViewportIndicator,
		);

		rootListButton.dispatch('click', createClickEvent(rootListButton));
		assert.strictEqual(rootListPanel.hidden, false);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['crispy']);

		assert.ok(viewport);
		viewport.boundsLeft = 20;
		viewport.boundsTop = 30;
		const folder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			promotedFolder.id,
		);
		const folderChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			promotedFolder.children[0].id,
		);
		const initialFolderPosition = readTranslate(folder.style.transform);
		const initialChildPosition = readTranslate(folderChild.style.transform);
		const handle = getDescendantByClass(folder, 'graph-detach-handle');
		const targetRootId = createPromotedGraphRootId(promotedFolder.id);
		const detachedFolderNodeId = createGraphLayoutNodeId(
			targetRootId,
			promotedFolder.id,
		);
		const detachedChildNodeId = createGraphLayoutNodeId(
			targetRootId,
			promotedFolder.children[0].id,
		);
		const detachedFileGroupId = createGraphLayoutNodeId(
			targetRootId,
			`${promotedFolder.id}:files`,
		);

		handle.dispatch('pointerdown', createPointerEvent(handle, 380, 290));
		handle.dispatch('pointermove', createPointerEvent(handle, 1_000, 800));
		handle.dispatch('pointerup', createPointerEvent(handle, 4_120, 3_080));

		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[detachedFolderNodeId],
			{ x: 2_000, y: 1_500 },
		);
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[detachedChildNodeId],
			{
				x: 2_000 + initialChildPosition.x - initialFolderPosition.x,
				y: 1_500 + initialChildPosition.y - initialFolderPosition.y,
			},
		);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[targetRootId]: true,
		});
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[sibling.id],
			siblingPosition,
		);
		assert.deepStrictEqual(graphView.state.getState().openedFolders, {
			[project.id]: true,
			[detachedFolderNodeId]: true,
		});
		assert.deepStrictEqual(graphView.state.getState().fileGroupPages, {
			[detachedFileGroupId]: 3,
		});
		const detachedFolder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedFolderNodeId,
		);

		assert.strictEqual(
			findDescendantByClass(detachedFolder, 'graph-detach-handle'),
			undefined,
		);
		assert.strictEqual(detachedFolder.style.transform, 'translate(2000px, 1500px)');
		assert.ok(findDescendantByClass(detachedFolder, 'graph-root-context-label'));
		const detachedFolderChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedChildNodeId,
		);
		const backlink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(targetRootId),
		);

		assert.strictEqual(backlink.hasClass('graph-folder-backlink-node'), true);
		assert.strictEqual(backlink.getAttribute('data-target-root-id'), targetRootId);
		assert.strictEqual(backlink.getAttribute('data-target-node-id'), promotedFolder.id);
		assert.ok(getText(backlink).includes('src/'));
		assert.strictEqual(
			getDescendantsByClass(backlink, 'graph-detach-handle').length,
			1,
		);
		assert.strictEqual(
			findDescendantByClass(backlink, 'graph-backlink-indicator'),
			undefined,
		);
		assert.strictEqual(
			findDescendantByClass(backlink, 'graph-detach-handle') !== undefined,
			true,
		);
		const backlinkPosition = backlink.style.transform;
		assert.deepStrictEqual(getNavigatorRootNames(root), ['crispy', 'src/']);
		assert.deepStrictEqual(getNavigatorRootPaths(root), ['crispy/']);
		assert.strictEqual(rootListPanel.hidden, false);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'true');
		assert.ok(minimapNodeLayer.children.length > initialMinimapNodeCount);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);
		const focusPoints: Array<{ readonly x: number; readonly y: number }> = [];
		const detachedRootButton = getNavigatorRootButtons(root)[1];

		assert.ok(detachedRootButton);
		graphView.camera.focusOn = (point) => focusPoints.push(point);
		detachedRootButton.dispatch('click', createClickEvent(detachedRootButton));
		assert.deepStrictEqual(focusPoints, [{
			x: 2_000 + GRAPH_FOLDER_NODE_WIDTH / 2,
			y: 1_500 + GRAPH_FOLDER_NODE_HEIGHT / 2,
		}]);

		backlink.dispatch('pointerdown', createPointerEvent(backlink, 100, 100));
		backlink.dispatch('pointermove', createPointerEvent(backlink, 180, 160));
		backlink.dispatch('pointerup', createPointerEvent(backlink, 180, 160));
		backlink.dispatch('click', createClickEvent(backlink));
		assert.strictEqual(backlink.hasPointerCapture(1), false);
		assert.strictEqual(backlink.style.transform, backlinkPosition);
		assert.strictEqual(graphView.state.isFolderOpened(detachedFolderNodeId), true);
		assert.strictEqual(graphView.state.isFolderOpened(promotedFolder.id), false);
		assert.strictEqual(graph.roots.length, 1);

		setClientBounds(backlink, 200, 100, 200, 42);
		const rootPositionBeforeReattachDrag = readTranslate(
			detachedFolder.style.transform,
		);
		const childPositionBeforeReattachDrag = readTranslate(
			detachedFolderChild.style.transform,
		);
		beginNodeDrag(detachedFolder, 300, 121);
		const rootPositionDuringReattachDrag = readTranslate(
			detachedFolder.style.transform,
		);
		const childPositionDuringReattachDrag = readTranslate(
			detachedFolderChild.style.transform,
		);

		assert.deepStrictEqual({
			x: childPositionDuringReattachDrag.x - childPositionBeforeReattachDrag.x,
			y: childPositionDuringReattachDrag.y - childPositionBeforeReattachDrag.y,
		}, {
			x: rootPositionDuringReattachDrag.x - rootPositionBeforeReattachDrag.x,
			y: rootPositionDuringReattachDrag.y - rootPositionBeforeReattachDrag.y,
		});
		assert.strictEqual(backlink.hasClass('is-reattach-target'), true);
		detachedFolder.dispatch(
			'pointerup',
			createPointerEvent(detachedFolder, 300, 121),
		);
		assert.deepStrictEqual(getNavigatorRootNames(root), ['crispy']);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {});
		assert.deepStrictEqual(graphView.state.getState().nodePositions, {
			[sibling.id]: siblingPosition,
		});
		assert.strictEqual(getDescendantByClass(root, 'graph-navigator-minimap'), minimap);
		assert.strictEqual(minimapNodeLayer.children.length, initialMinimapNodeCount);
		assert.deepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);
		assert.strictEqual(rootListPanel.hidden, false);
		assert.strictEqual(rootListButton.getAttribute('aria-expanded'), 'true');
		const focusCountAfterReattach = focusPoints.length;

		detachedRootButton.dispatch('click', createClickEvent(detachedRootButton));
		assert.strictEqual(focusPoints.length, focusCountAfterReattach);

		graphView.dispose();
	});

	test('초기 Graph Camera 상태를 Store와 World transform에 복원한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: { x: 120, y: -45, scale: 1.5 },
				nodePositions: {},
			},
			GRAPH_MOCK,
		);

		assert.deepStrictEqual(graphView.state.getState(), {
			camera: { x: 120, y: -45, scale: 1.5 },
			nodePositions: {},
			fileGroupPages: {},
			openedFolders: {},
			detachedRootNodeIds: {},
			hiddenNodeIds: {},
		});
		assert.deepStrictEqual(graphView.camera.getState(), {
			x: 120,
			y: -45,
			scale: 1.5,
		});
		assert.strictEqual(
			root.children[0]?.children[0]?.style.transform,
			'translate(120px, -45px) scale(1.5)',
		);
		const overlayLayer = root.children[0]?.children[1];
		assert.strictEqual(overlayLayer?.className, 'graph-overlay-layer');
		assert.strictEqual(
			getDescendantByClass(root, 'graph-navigator-coordinate').textContent,
			'(120, -45)',
		);
		assert.strictEqual(
			getDescendantByClass(root, 'graph-navigator-scale').textContent,
			'150%',
		);

		graphView.dispose();
		assert.strictEqual(root.children.length, 0);
	});

	test('Project Root와 Folder가 같은 Open/Close interaction으로 subtree를 제어한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const folderId = 'folder:app';
		const childId = 'folder:app/src';
		const rootEdgeId = `${GRAPH_MOCK_PROJECT.id}->${folderId}`;
		const edgeId = `${folderId}->${childId}`;
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		const project = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);
		const projectTransform = project.style.transform;

		assert.strictEqual(project.getAttribute('data-folder-icon'), 'folder-closed.svg');
		assert.strictEqual(project.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-node-id', folderId),
			undefined,
		);
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-edge-id', rootEdgeId),
			undefined,
		);

		project.dispatch('click', createClickEvent(project));

		assert.deepStrictEqual(graphView.state.getState().openedFolders, {
			[GRAPH_MOCK_PROJECT.id]: true,
		});
		assert.strictEqual(
			getDescendantByAttribute(root, 'data-graph-node-id', GRAPH_MOCK_PROJECT.id),
			project,
		);
		assert.strictEqual(project.getAttribute('data-folder-icon'), 'folder-open.svg');
		assert.strictEqual(project.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(project.style.transform, projectTransform);
		const folder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderId,
		);
		const folderIcon = getDescendantByClass(folder, 'graph-folder-icon');
		const folderTransform = folder.style.transform;

		assert.strictEqual(folder.getAttribute('data-folder-icon'), 'folder-closed.svg');
		assert.strictEqual(folder.getAttribute('aria-expanded'), 'false');
		assert.ok(findDescendantByAttribute(root, 'data-graph-edge-id', rootEdgeId));

		folder.dispatch('click', createClickEvent(folder));

		assert.deepStrictEqual(graphView.state.getState().openedFolders, {
			[GRAPH_MOCK_PROJECT.id]: true,
			[folderId]: true,
		});
		assert.strictEqual(
			getDescendantByAttribute(root, 'data-graph-node-id', folderId),
			folder,
		);
		assert.strictEqual(
			getDescendantByClass(folder, 'graph-folder-icon'),
			folderIcon,
		);
		assert.strictEqual(
			folder.getAttribute('data-folder-icon'),
			'folder-open.svg',
		);
		assert.strictEqual(folder.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(folder.style.transform, folderTransform);
		assert.ok(findDescendantByAttribute(root, 'data-graph-node-id', childId));
		assert.ok(findDescendantByAttribute(root, 'data-graph-edge-id', edgeId));

		folder.dispatch('click', createClickEvent(folder));

		assert.deepStrictEqual(graphView.state.getState().openedFolders, {
			[GRAPH_MOCK_PROJECT.id]: true,
		});
		assert.strictEqual(
			getDescendantByAttribute(root, 'data-graph-node-id', folderId),
			folder,
		);
		assert.strictEqual(folder.getAttribute('data-folder-icon'), 'folder-closed.svg');
		assert.strictEqual(folder.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(folder.style.transform, folderTransform);
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-node-id', childId),
			undefined,
		);
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-edge-id', edgeId),
			undefined,
		);

		project.dispatch('click', createClickEvent(project));
		assert.deepStrictEqual(graphView.state.getState().openedFolders, {});
		assert.strictEqual(project.getAttribute('data-folder-icon'), 'folder-closed.svg');
		assert.strictEqual(project.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(project.style.transform, projectTransform);
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-node-id', folderId),
			undefined,
		);
		assert.strictEqual(
			findDescendantByAttribute(root, 'data-graph-edge-id', rootEdgeId),
			undefined,
		);
		graphView.dispose();
	});

	test('grouped File Row의 Open 요청을 원본 File ID로 상위에 전달한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const fileOpenRequests: string[] = [];
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[GRAPH_MOCK_PROJECT.id]: true,
				'folder:app': true,
				'folder:app/src': true,
			},
		}, GRAPH_MOCK, {
			onFileOpenRequest: (fileId) => fileOpenRequests.push(fileId),
		});
		const fileRow = getDescendantByAttribute(
			root,
			'data-file-id',
			'file:app/src/graphView.ts',
		);

		fileRow.dispatch('dblclick', createClickEvent(fileRow));

		assert.deepStrictEqual(fileOpenRequests, ['file:app/src/graphView.ts']);
		graphView.dispose();
	});

	test('접힌 Parent를 이동한 뒤 열면 하위 Node도 같은 Offset으로 나타난다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const folderId = 'folder:app';
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			INITIAL_GRAPH_STATE,
			GRAPH_MOCK,
		);
		const collapsedLayout = createGraphLayout(GRAPH_MOCK);
		const projectLayoutNode = collapsedLayout.nodes.find(
			(node) => node.id === GRAPH_MOCK_PROJECT.id,
		);
		const project = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			GRAPH_MOCK_PROJECT.id,
		);

		assert.ok(projectLayoutNode);
		performNodeDrop(project, 120, 75);
		const projectPosition = readTranslate(project.style.transform);
		const projectOffset = {
			x: projectPosition.x - projectLayoutNode.position.x,
			y: projectPosition.y - projectLayoutNode.position.y,
		};

		graphView.state.toggleFolder(GRAPH_MOCK_PROJECT.id);

		const folder = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			folderId,
		);
		const folderPosition = readTranslate(folder.style.transform);
		const expandedFolderLayoutNode = createGraphLayout(GRAPH_MOCK, {
			openedFolders: { [GRAPH_MOCK_PROJECT.id]: true },
		}).nodes.find((node) => node.id === folderId);

		assert.ok(expandedFolderLayoutNode);
		assert.deepStrictEqual(folderPosition, {
			x: expandedFolderLayoutNode.position.x + projectOffset.x,
			y: expandedFolderLayoutNode.position.y + projectOffset.y,
		});
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[folderId],
			folderPosition,
		);

		graphView.dispose();
	});

	test('따로 이동한 Folder를 열어도 정렬된 sibling 위치는 바뀌지 않는다', () => {
		const targetFolder = {
			kind: 'folder' as const,
			id: 'folder:unarranged-target',
			name: 'unarranged-target',
			status: 'loaded' as const,
			children: [
				{
					kind: 'folder' as const,
					id: 'folder:unarranged-target/first',
					name: 'first',
					status: 'loaded' as const,
					children: [],
				},
				{
					kind: 'folder' as const,
					id: 'folder:unarranged-target/second',
					name: 'second',
					status: 'loaded' as const,
					children: [],
				},
			],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:unarranged-open',
			name: 'unarranged-open',
			status: 'loaded',
			children: [
				{
					kind: 'folder',
					id: 'folder:unarranged-above',
					name: 'above',
					status: 'loaded',
					children: [],
				},
				targetFolder,
				{
					kind: 'folder',
					id: 'folder:unarranged-below',
					name: 'below',
					status: 'loaded',
					children: [],
				},
			],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: { [project.id]: true },
		}, createSingleRootGraph(project));
		const above = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			'folder:unarranged-above',
		);
		const target = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			targetFolder.id,
		);
		const below = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			'folder:unarranged-below',
		);
		performNodeDrop(target, 300, 120);
		const movedTargetPosition = readTranslate(target.style.transform);
		const aboveTransform = above.style.transform;
		const belowTransform = below.style.transform;

		graphView.state.toggleFolder(targetFolder.id);

		assert.strictEqual(above.style.transform, aboveTransform);
		assert.strictEqual(below.style.transform, belowTransform);
		assert.deepStrictEqual(
			readTranslate(target.style.transform),
			movedTargetPosition,
		);
		const firstChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			'folder:unarranged-target/first',
		);
		const secondChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			'folder:unarranged-target/second',
		);

		assert.ok(readTranslateY(firstChild.style.transform) < movedTargetPosition.y);
		assert.ok(readTranslateY(secondChild.style.transform) > movedTargetPosition.y);

		const abovePosition = readTranslate(above.style.transform);

		performNodeDrop(
			target,
			abovePosition.x + 8,
			abovePosition.y + 8,
		);
		const arrangedState = graphView.state.getState();

		assert.strictEqual(arrangedState.nodePositions[targetFolder.id], undefined);
		assert.strictEqual(
			arrangedState.nodePositions['folder:unarranged-target/first'],
			undefined,
		);
		assert.strictEqual(
			arrangedState.nodePositions['folder:unarranged-target/second'],
			undefined,
		);
		assert.ok(readTranslateY(above.style.transform) < readTranslateY(
			target.style.transform,
		));
		assert.ok(readTranslateY(target.style.transform) < readTranslateY(
			below.style.transform,
		));
		graphView.dispose();
	});

	test('열린 descendant가 있는 unarranged Folder를 닫았다 다시 열어도 sibling flow 높이는 유지한다', () => {
		const nestedFolder = {
			kind: 'folder' as const,
			id: 'folder:toggle-target/nested',
			name: 'nested',
			status: 'loaded' as const,
			children: [
				{
					kind: 'folder' as const,
					id: 'folder:toggle-target/nested/first',
					name: 'first',
					status: 'loaded' as const,
					children: [],
				},
				{
					kind: 'folder' as const,
					id: 'folder:toggle-target/nested/second',
					name: 'second',
					status: 'loaded' as const,
					children: [],
				},
			],
		};
		const targetFolder = {
			kind: 'folder' as const,
			id: 'folder:toggle-target',
			name: 'toggle-target',
			status: 'loaded' as const,
			children: [nestedFolder],
		};
		const aboveId = 'folder:toggle-above';
		const belowId = 'folder:toggle-below';
		const project: Project = {
			kind: 'project',
			id: 'project:unarranged-toggle',
			name: 'unarranged-toggle',
			status: 'loaded',
			children: [
				{
					kind: 'folder',
					id: aboveId,
					name: 'above',
					status: 'loaded',
					children: [],
				},
				targetFolder,
				{
					kind: 'folder',
					id: belowId,
					name: 'below',
					status: 'loaded',
					children: [],
				},
			],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[project.id]: true,
				[targetFolder.id]: true,
				[nestedFolder.id]: true,
			},
		}, createSingleRootGraph(project));
		const above = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			aboveId,
		);
		const target = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			targetFolder.id,
		);
		const below = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			belowId,
		);
		performNodeDrop(target, 520, 260);
		const movedTargetPosition = readTranslate(target.style.transform);
		const arrangedSiblingTransforms = {
			above: above.style.transform,
			below: below.style.transform,
		};

		for (let index = 0; index < 2; index += 1) {
			graphView.state.toggleFolder(targetFolder.id);
			assert.strictEqual(above.style.transform, arrangedSiblingTransforms.above);
			assert.strictEqual(below.style.transform, arrangedSiblingTransforms.below);

			graphView.state.toggleFolder(targetFolder.id);
			assert.strictEqual(above.style.transform, arrangedSiblingTransforms.above);
			assert.strictEqual(below.style.transform, arrangedSiblingTransforms.below);
			assert.deepStrictEqual(
				readTranslate(target.style.transform),
				movedTargetPosition,
			);
			assert.ok(findDescendantByAttribute(
				root,
				'data-graph-node-id',
				'folder:toggle-target/nested/second',
			));
		}

		graphView.dispose();
	});

	test('arranged descendant는 초기 복원과 닫힌 Parent 이동 후에도 직계 Parent local을 유지한다', () => {
		const grandchild = {
			kind: 'folder' as const,
			id: 'folder:arranged-relative/child/grandchild',
			name: 'grandchild',
			status: 'loaded' as const,
			children: [],
		};
		const child = {
			kind: 'folder' as const,
			id: 'folder:arranged-relative/child',
			name: 'child',
			status: 'loaded' as const,
			children: [grandchild],
		};
		const parent = {
			kind: 'folder' as const,
			id: 'folder:arranged-relative',
			name: 'arranged-relative',
			status: 'loaded' as const,
			children: [child],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:arranged-relative',
			name: 'arranged-relative',
			status: 'loaded',
			children: [parent],
		};
		const graph = createSingleRootGraph(project);
		const openedFolders = {
			[project.id]: true as const,
			[parent.id]: true as const,
			[child.id]: true as const,
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			nodePositions: { [parent.id]: { x: 520, y: 280 } },
			openedFolders,
		}, graph);
		const parentNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parent.id,
		);
		let childNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			child.id,
		);
		let grandchildNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			grandchild.id,
		);
		const arrangedLayout = createGraphLayout(graph, {
			openedFolders,
			unarrangedNodeIds: new Set([parent.id]),
		});
		const parentLayout = arrangedLayout.nodes.find(
			(node) => node.id === parent.id,
		);
		const childLayout = arrangedLayout.nodes.find(
			(node) => node.id === child.id,
		);
		const grandchildLayout = arrangedLayout.nodes.find(
			(node) => node.id === grandchild.id,
		);

		assert.ok(parentLayout && childLayout && grandchildLayout);
		const expectedChildLocal = subtractPositions(
			childLayout.position,
			parentLayout.position,
		);
		const expectedGrandchildLocal = subtractPositions(
			grandchildLayout.position,
			childLayout.position,
		);

		assert.deepStrictEqual(subtractPositions(
			readTranslate(childNode.style.transform),
			readTranslate(parentNode.style.transform),
		), expectedChildLocal);
		assert.deepStrictEqual(subtractPositions(
			readTranslate(grandchildNode.style.transform),
			readTranslate(childNode.style.transform),
		), expectedGrandchildLocal);

		graphView.state.toggleFolder(parent.id);
		performNodeDrop(parentNode, 240, 180);
		graphView.state.toggleFolder(parent.id);
		childNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			child.id,
		);
		grandchildNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			grandchild.id,
		);

		assert.deepStrictEqual(subtractPositions(
			readTranslate(childNode.style.transform),
			readTranslate(parentNode.style.transform),
		), expectedChildLocal);
		assert.deepStrictEqual(subtractPositions(
			readTranslate(grandchildNode.style.transform),
			readTranslate(childNode.style.transform),
		), expectedGrandchildLocal);
		graphView.dispose();
	});

	test('접힌 Parent를 이동한 뒤에도 unarranged Child는 Parent 상대 위치를 유지한다', () => {
		const child = {
			kind: 'folder' as const,
			id: 'folder:relative-parent/child',
			name: 'child',
			status: 'loaded' as const,
			children: [],
		};
		const parent = {
			kind: 'folder' as const,
			id: 'folder:relative-parent',
			name: 'relative-parent',
			status: 'loaded' as const,
			children: [child],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:relative-parent',
			name: 'relative-parent',
			status: 'loaded',
			children: [
				parent,
				{
					kind: 'folder',
					id: 'folder:relative-parent-sibling',
					name: 'sibling',
					status: 'loaded',
					children: [],
				},
			],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[project.id]: true,
				[parent.id]: true,
			},
		}, createSingleRootGraph(project));
		const parentNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parent.id,
		);
		let childNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			child.id,
		);

		performNodeDrop(childNode, 520, 260);
		const initialRelativePosition = subtractPositions(
			readTranslate(childNode.style.transform),
			readTranslate(parentNode.style.transform),
		);

		graphView.state.toggleFolder(parent.id);
		assert.strictEqual(findDescendantByAttribute(
			root,
			'data-graph-node-id',
			child.id,
		), undefined);
		performNodeDrop(parentNode, 180, 160);
		graphView.state.toggleFolder(parent.id);
		childNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			child.id,
		);

		assert.deepStrictEqual(subtractPositions(
			readTranslate(childNode.style.transform),
			readTranslate(parentNode.style.transform),
		), initialRelativePosition);
		graphView.dispose();
	});

	test('접힌 Parent를 비정렬 이동 후 재정렬해도 내부 Node의 상대 위치를 유지한다', () => {
		const child = {
			kind: 'folder' as const,
			id: 'folder:relative-rearrange/child',
			name: 'child',
			status: 'loaded' as const,
			children: [],
		};
		const parent = {
			kind: 'folder' as const,
			id: 'folder:relative-rearrange',
			name: 'relative-rearrange',
			status: 'loaded' as const,
			children: [child],
		};
		const sibling = {
			kind: 'folder' as const,
			id: 'folder:relative-rearrange-sibling',
			name: 'sibling',
			status: 'loaded' as const,
			children: [],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:relative-rearrange',
			name: 'relative-rearrange',
			status: 'loaded',
			children: [parent, sibling],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[project.id]: true,
				[parent.id]: true,
			},
		}, createSingleRootGraph(project));
		const parentNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parent.id,
		);
		let childNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			child.id,
		);
		const siblingNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			sibling.id,
		);

		performNodeDrop(childNode, 520, 260);
		const initialRelativePosition = subtractPositions(
			readTranslate(childNode.style.transform),
			readTranslate(parentNode.style.transform),
		);
		graphView.state.toggleFolder(parent.id);
		performNodeDrop(parentNode, 180, 160);
		const siblingPosition = readTranslate(siblingNode.style.transform);

		performNodeDrop(
			parentNode,
			siblingPosition.x + 8,
			siblingPosition.y + 8,
		);
		graphView.state.toggleFolder(parent.id);
		childNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			child.id,
		);

		assert.deepStrictEqual(subtractPositions(
			readTranslate(childNode.style.transform),
			readTranslate(parentNode.style.transform),
		), initialRelativePosition);
		graphView.dispose();
	});

	test('접힌 Parent를 Detach해도 unarranged 내부 subtree의 상대 위치를 새 Instance에 유지한다', () => {
		const grandchild = {
			kind: 'folder' as const,
			id: 'folder:relative-detach/child/grandchild',
			name: 'grandchild',
			status: 'loaded' as const,
			children: [],
		};
		const child = {
			kind: 'folder' as const,
			id: 'folder:relative-detach/child',
			name: 'child',
			status: 'loaded' as const,
			children: [grandchild],
		};
		const parent = {
			kind: 'folder' as const,
			id: 'folder:relative-detach',
			name: 'relative-detach',
			status: 'loaded' as const,
			children: [child],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:relative-detach',
			name: 'relative-detach',
			status: 'loaded',
			children: [parent],
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: {
				[project.id]: true,
				[parent.id]: true,
				[child.id]: true,
			},
		}, createSingleRootGraph(project));
		const parentNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parent.id,
		);
		const childNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			child.id,
		);
		const grandchildNode = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			grandchild.id,
		);

		performNodeDrop(childNode, 520, 260);
		const childRelativePosition = subtractPositions(
			readTranslate(childNode.style.transform),
			readTranslate(parentNode.style.transform),
		);
		const grandchildRelativePosition = subtractPositions(
			readTranslate(grandchildNode.style.transform),
			readTranslate(parentNode.style.transform),
		);

		graphView.state.toggleFolder(parent.id);
		performNodeDrop(parentNode, 180, 160);
		const handle = getDescendantByClass(parentNode, 'graph-detach-handle');

		handle.dispatch('pointerdown', createPointerEvent(handle, 10, 10));
		handle.dispatch('pointermove', createPointerEvent(handle, 30, 30));
		handle.dispatch('pointerup', createPointerEvent(handle, 1_200, 800));

		const detachedRootId = createDetachedRootId(parent.id, 1);
		const detachedParentId = createGraphLayoutNodeId(
			detachedRootId,
			parent.id,
		);
		const detachedChildId = createGraphLayoutNodeId(
			detachedRootId,
			child.id,
		);
		const detachedGrandchildId = createGraphLayoutNodeId(
			detachedRootId,
			grandchild.id,
		);

		graphView.state.toggleFolder(detachedParentId);
		const detachedParent = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedParentId,
		);
		const detachedChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedChildId,
		);
		const detachedGrandchild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			detachedGrandchildId,
		);

		assert.deepStrictEqual(subtractPositions(
			readTranslate(detachedChild.style.transform),
			readTranslate(detachedParent.style.transform),
		), childRelativePosition);
		assert.deepStrictEqual(subtractPositions(
			readTranslate(detachedGrandchild.style.transform),
			readTranslate(detachedParent.style.transform),
		), grandchildRelativePosition);

		graphView.state.toggleFolder(detachedParentId);
		const backlink = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			createFolderBacklinkId(parent.id),
		);
		const backlinkHandle = getDescendantByClass(
			backlink,
			'graph-detach-handle',
		);

		backlinkHandle.dispatch(
			'pointerdown',
			createPointerEvent(backlinkHandle, 10, 10),
		);
		backlinkHandle.dispatch(
			'pointermove',
			createPointerEvent(backlinkHandle, 30, 30),
		);
		backlinkHandle.dispatch(
			'pointerup',
			createPointerEvent(backlinkHandle, 1_600, 900),
		);
		const secondRootId = createDetachedRootId(parent.id, 2);
		const secondParentId = createGraphLayoutNodeId(secondRootId, parent.id);
		const secondChildId = createGraphLayoutNodeId(secondRootId, child.id);
		const secondGrandchildId = createGraphLayoutNodeId(
			secondRootId,
			grandchild.id,
		);

		graphView.state.toggleFolder(secondParentId);
		const secondParent = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			secondParentId,
		);
		const secondChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			secondChildId,
		);
		const secondGrandchild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			secondGrandchildId,
		);

		assert.deepStrictEqual(subtractPositions(
			readTranslate(secondChild.style.transform),
			readTranslate(secondParent.style.transform),
		), childRelativePosition);
		assert.deepStrictEqual(subtractPositions(
			readTranslate(secondGrandchild.style.transform),
			readTranslate(secondParent.style.transform),
		), grandchildRelativePosition);

		setClientBounds(backlink, 200, 100, 200, 42);
		beginNodeDrag(secondParent, 300, 121);
		secondParent.dispatch(
			'pointerup',
			createPointerEvent(secondParent, 300, 121),
		);
		beginNodeDrag(detachedParent, 300, 121);
		detachedParent.dispatch(
			'pointerup',
			createPointerEvent(detachedParent, 300, 121),
		);
		graphView.state.toggleFolder(parent.id);
		const restoredParent = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			parent.id,
		);
		const restoredChild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			child.id,
		);
		const restoredGrandchild = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			grandchild.id,
		);

		assert.deepStrictEqual(subtractPositions(
			readTranslate(restoredChild.style.transform),
			readTranslate(restoredParent.style.transform),
		), childRelativePosition);
		assert.deepStrictEqual(subtractPositions(
			readTranslate(restoredGrandchild.style.transform),
			readTranslate(restoredParent.style.transform),
		), grandchildRelativePosition);
		graphView.dispose();
	});

	test('grouped File은 Row Drag로 standalone이 되지 않고 Detach Handle로만 분리된다', () => {
		const files = ['a', 'b', 'c'].map((name) => ({
			kind: 'file' as const,
			id: `file:view-arrangement/${name}.ts`,
			name: `${name}.ts`,
		}));
		const project: Project = {
			kind: 'project',
			id: 'project:view-file-arrangement',
			name: 'view-file-arrangement',
			status: 'loaded',
			children: files,
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders: { [project.id]: true },
		}, createSingleRootGraph(project));
		const nodeLayer = getDescendantByClass(root, 'graph-node-layer');
		const fileGroupId = createFileGroupId(project.id);
		let fileGroup = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileGroupId,
		);
		const file = files[1];

		assert.ok(file);
		const row = getDescendantByAttribute(fileGroup, 'data-file-id', file.id);

		row.dispatch('pointerdown', createPointerEvent(row, 10, 10));
		row.dispatch('pointermove', createPointerEvent(row, -500, -500));
		row.dispatch('pointerup', createPointerEvent(row, -500, -500));

		fileGroup = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileGroupId,
		);
		assert.strictEqual(findDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			file.id,
		), undefined);
		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(item) => item.getAttribute('data-file-id'),
			),
			files.map((entry) => entry.id),
		);
		assert.strictEqual(graphView.state.getState().nodePositions[file.id], undefined);
		const currentRow = getDescendantByAttribute(
			fileGroup,
			'data-file-id',
			file.id,
		);
		const detachHandle = getDescendantByClass(
			currentRow,
			'graph-detach-handle',
		);

		detachHandle.dispatch(
			'pointerdown',
			createPointerEvent(detachHandle, 10, 10),
		);
		detachHandle.dispatch(
			'pointermove',
			createPointerEvent(detachHandle, 30, 30),
		);
		detachHandle.dispatch(
			'pointerup',
			createPointerEvent(detachHandle, 900, 600),
		);
		const detachedRootId = createPromotedGraphRootId(file.id);
		const detachedNodeId = createGraphLayoutNodeId(detachedRootId, file.id);
		const detachedNode = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			detachedNodeId,
		);

		fileGroup = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileGroupId,
		);
		const backlinkRow = getDescendantByAttribute(
			fileGroup,
			'data-file-id',
			file.id,
		);

		assert.strictEqual(
			detachedNode.getAttribute('data-file-group-presentation'),
			'standalone',
		);
		assert.strictEqual(
			backlinkRow.getAttribute('data-target-root-id'),
			detachedRootId,
		);
		assert.deepStrictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-item').map(
				(item) => item.getAttribute('data-file-id'),
			),
			files.map((entry) => entry.id),
		);
		assert.deepStrictEqual(graphView.state.getState().detachedRootNodeIds, {
			[detachedRootId]: true,
		});
		graphView.dispose();
	});

	test('이동된 Folder 아래 File Group을 재정렬해도 Parent Offset을 유지한다', () => {
		const childFolder = {
			kind: 'folder' as const,
			id: 'folder:moved-parent/src',
			name: 'src',
			status: 'loaded' as const,
			children: [],
		};
		const files = Array.from({ length: 6 }, (_, index) => ({
			kind: 'file' as const,
			id: `file:moved-parent/file-${index + 1}.ts`,
			name: `file-${index + 1}.ts`,
		}));
		const movedParent = {
			kind: 'folder' as const,
			id: 'folder:moved-parent',
			name: 'moved-parent',
			status: 'loaded' as const,
			children: [childFolder, ...files],
		};
		const project: Project = {
			kind: 'project',
			id: 'project:moved-parent-arrangement',
			name: 'moved-parent-arrangement',
			status: 'loaded',
			children: [movedParent],
		};
		const graph = createSingleRootGraph(project);
		const openedFolders = {
			[project.id]: true as const,
			[movedParent.id]: true as const,
		};
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(root.asHtmlElement(), {
			...INITIAL_GRAPH_STATE,
			openedFolders,
		}, graph);
		const nodeLayer = getDescendantByClass(root, 'graph-node-layer');
		const fileGroupId = createFileGroupId(movedParent.id);
		const parent = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			movedParent.id,
		);
		const child = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			childFolder.id,
		);
		const fileGroup = getDescendantByAttribute(
			nodeLayer,
			'data-graph-node-id',
			fileGroupId,
		);

		performNodeDrop(parent, 1_200, 900);
		performNodeDrop(fileGroup, -500, -500);
		const childPosition = readTranslate(child.style.transform);

		performNodeDrop(
			fileGroup,
			childPosition.x + 8,
			childPosition.y + 8,
		);

		const finalParentPosition = readTranslate(parent.style.transform);
		const finalFileGroupPosition = readTranslate(fileGroup.style.transform);
		const arrangedLayout = createGraphLayout(graph, {
			openedFolders,
			unarrangedNodeIds: new Set([movedParent.id]),
		});
		const parentLayout = arrangedLayout.nodes.find(
			(node) => node.id === movedParent.id,
		);
		const fileGroupLayout = arrangedLayout.nodes.find(
			(node) => node.id === fileGroupId,
		);

		assert.ok(parentLayout && fileGroupLayout);
		assert.deepStrictEqual(finalFileGroupPosition, {
			x: fileGroupLayout.position.x
				+ finalParentPosition.x
				- parentLayout.position.x,
			y: fileGroupLayout.position.y
				+ finalParentPosition.y
				- parentLayout.position.y,
		});
		assert.deepStrictEqual(
			graphView.state.getState().nodePositions[fileGroupId],
			finalFileGroupPosition,
		);
		assert.ok(getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			`${movedParent.id}->${fileGroupId}`,
		));
		graphView.dispose();
	});

	test('복원된 File Group page를 최초 Layout 높이와 Renderer contents에 반영한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const fileGroupId = createFileGroupId(
			'folder:pagination-samples/seventeen-files',
		);
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 1 },
			nodePositions: {},
			fileGroupPages: { [fileGroupId]: 2 },
			openedFolders: {
				[GRAPH_MOCK_PROJECT.id]: true,
				'folder:pagination-samples': true,
				'folder:pagination-samples/seventeen-files': true,
			},
		}, GRAPH_MOCK);
		const fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);

		assert.strictEqual(fileGroup.style.height, '348px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 10);
		assert.ok(getText(fileGroup).includes('+ 7개 더보기'));
		assert.strictEqual(
			getDescendantsByClass(fileGroup, 'graph-file-collapse').length,
			1,
		);

		graphView.dispose();
	});

	test('더보기와 접기가 File Group size, sibling 위치와 Edge를 함께 Reflow한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const parentId = 'folder:pagination-samples/seventeen-files';
		const fileGroupId = createFileGroupId(parentId);
		const siblingId = 'folder:pagination-samples/twenty-one-files';
		const edgeId = `${parentId}->${fileGroupId}`;
		const graphView = initializeGraphView(root.asHtmlElement(), {
			camera: { x: 0, y: 0, scale: 4 },
			nodePositions: {},
			openedFolders: {
				[GRAPH_MOCK_PROJECT.id]: true,
				'folder:pagination-samples': true,
				[parentId]: true,
			},
		}, GRAPH_MOCK);
		const fileGroup = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			fileGroupId,
		);
		const sibling = getDescendantByAttribute(
			root,
			'data-graph-node-id',
			siblingId,
		);
		const edge = getDescendantByAttribute(
			root,
			'data-graph-edge-id',
			edgeId,
		);
		const initialSiblingY = readTranslateY(sibling.style.transform);
		const initialFileGroupY = readTranslateY(fileGroup.style.transform);
		const initialEdgePath = edge.getAttribute('d');
		const more = getDescendantByClass(fileGroup, 'graph-file-more');
		const minimap = getDescendantByClass(root, 'graph-navigator-minimap');
		const minimapFileGroup = getDescendantByAttribute(
			getDescendantByClass(minimap, 'graph-navigator-minimap-node-layer'),
			'data-graph-node-id',
			fileGroupId,
		);
		const initialMinimapHeight = minimapFileGroup.getAttribute('height');
		const minimapViewportIndicator = getDescendantByClass(
			minimap,
			'graph-navigator-minimap-viewport-indicator',
		);
		const initialIndicator = readMinimapViewportAttributes(
			minimapViewportIndicator,
		);

		assert.strictEqual(fileGroup.style.height, '198px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 5);
		more.dispatch('click', createClickEvent(more));

		assert.strictEqual(fileGroup.style.height, '348px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 10);
		assert.strictEqual(
			readTranslateY(sibling.style.transform),
			initialSiblingY + 75,
		);
		assert.strictEqual(
			readTranslateY(fileGroup.style.transform),
			initialFileGroupY - 75,
		);
		assert.strictEqual(edge.getAttribute('d'), initialEdgePath);
		assert.notStrictEqual(
			getDescendantByAttribute(
				getDescendantByClass(minimap, 'graph-navigator-minimap-node-layer'),
				'data-graph-node-id',
				fileGroupId,
			).getAttribute('height'),
			initialMinimapHeight,
		);
		assert.notDeepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);

		getDescendantByClass(fileGroup, 'graph-file-more').dispatch(
			'click',
			createClickEvent(getDescendantByClass(fileGroup, 'graph-file-more')),
		);
		assert.strictEqual(fileGroup.style.height, '498px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 15);
		assert.strictEqual(
			readTranslateY(sibling.style.transform),
			initialSiblingY + 150,
		);
		assert.strictEqual(
			readTranslateY(fileGroup.style.transform),
			initialFileGroupY - 150,
		);

		const collapse = getDescendantByClass(fileGroup, 'graph-file-collapse');

		collapse.dispatch('click', createClickEvent(collapse));

		assert.strictEqual(fileGroup.style.height, '198px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 5);
		assert.strictEqual(readTranslateY(sibling.style.transform), initialSiblingY);
		assert.strictEqual(readTranslateY(fileGroup.style.transform), initialFileGroupY);
		assert.strictEqual(edge.getAttribute('d'), initialEdgePath);
		assert.ok(getText(fileGroup).includes('+ 12개 더보기'));
		assert.deepStrictEqual(
			readMinimapViewportAttributes(minimapViewportIndicator),
			initialIndicator,
		);

		graphView.dispose();
		graphView.state.showMoreFiles(fileGroupId);
		assert.strictEqual(fileGroup.style.height, '198px');
		assert.strictEqual(getDescendantsByClass(fileGroup, 'graph-file-item').length, 0);
	});

	test('Layout 입력 변경만 Reflow하고 Camera와 Node 위치 변경은 건너뛴다', () => {
		const state = createGraphState();
		let createLayoutCalls = 0;
		const rendererLayouts: ReturnType<typeof createGraphLayout>[] = [];
		const navigatorLayouts: ReturnType<typeof createGraphLayout>[] = [];
		const navigatorRootProjectionStates: GraphStateSnapshot[] = [];
		let currentLayout = createGraphLayout(
			createSingleRootGraph(GRAPH_MOCK_PROJECT),
		);
		const unsubscribe = initializeGraphLayoutReflow(
			state,
			{
				applyLayout: (layout) => rendererLayouts.push(layout),
			},
			{
				setLayout: (layout) => navigatorLayouts.push(layout),
			},
			() => currentLayout,
			(snapshot) => {
				createLayoutCalls += 1;
				currentLayout = createGraphLayout(
					createSingleRootGraph(GRAPH_MOCK_PROJECT), {
					fileGroupPages: snapshot.fileGroupPages,
					openedFolders: snapshot.openedFolders,
				});

				return currentLayout;
			},
			() => new Map(),
			(snapshot) => navigatorRootProjectionStates.push(snapshot),
		);

		state.setState({
			camera: { x: 80, y: -30, scale: 1.5 },
			nodePositions: {},
		});
		state.setState({
			camera: { x: 80, y: -30, scale: 1.5 },
			nodePositions: { 'folder:app': { x: 700, y: 250 } },
		});
		assert.strictEqual(createLayoutCalls, 0);
		assert.strictEqual(rendererLayouts.length, 0);
		assert.strictEqual(navigatorLayouts.length, 0);
		assert.strictEqual(navigatorRootProjectionStates.length, 0);

		state.toggleFolder('folder:app');
		assert.strictEqual(createLayoutCalls, 1);
		assert.strictEqual(rendererLayouts.length, 1);
		assert.strictEqual(navigatorLayouts.length, 1);
		assert.strictEqual(rendererLayouts[0], navigatorLayouts[0]);
		assert.strictEqual(navigatorRootProjectionStates.length, 0);

		state.showMoreFiles(createFileGroupId('folder:app/src'));
		assert.strictEqual(createLayoutCalls, 2);
		assert.strictEqual(rendererLayouts.length, 2);
		assert.strictEqual(navigatorLayouts.length, 2);
		assert.strictEqual(rendererLayouts[1], navigatorLayouts[1]);
		assert.strictEqual(navigatorRootProjectionStates.length, 0);

		const snapshot = state.getState();

		state.setState({
			camera: snapshot.camera,
			nodePositions: snapshot.nodePositions,
			hiddenNodeIds: { 'folder:app/src': true },
		});
		assert.strictEqual(createLayoutCalls, 3);
		assert.strictEqual(rendererLayouts.length, 3);
		assert.strictEqual(navigatorLayouts.length, 3);
		assert.strictEqual(rendererLayouts[2], navigatorLayouts[2]);
		assert.strictEqual(navigatorRootProjectionStates.length, 1);
		assert.strictEqual(
			navigatorRootProjectionStates[0].hiddenNodeIds['folder:app/src'],
			true,
		);

		unsubscribe();
		state.showMoreFiles(createFileGroupId('folder:app/src'));
		state.toggleFolder('folder:app');
		assert.strictEqual(createLayoutCalls, 3);
		assert.strictEqual(rendererLayouts.length, 3);
		assert.strictEqual(navigatorLayouts.length, 3);
		assert.strictEqual(navigatorRootProjectionStates.length, 1);
	});
});

type GraphEventListener = (event: Event) => void;

class FakeDocument {
	private readonly listeners = new Map<string, Set<GraphEventListener>>();

	createElement(tagName = 'div'): FakeElement {
		return new FakeElement(this, tagName.toLowerCase());
	}

	createElementNS(_namespace?: string, qualifiedName = 'div'): FakeElement {
		return new FakeElement(this, qualifiedName.toLowerCase());
	}

	addEventListener(type: string, listener: GraphEventListener): void {
		const listeners = this.listeners.get(type) ?? new Set();

		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: GraphEventListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatch(type: string, event: Event): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

class FakeStyle {
	transform = '';
	backgroundPosition = '';
	backgroundSize = '';
	width = '';
	height = '';
	left = '';
	right = '';
	top = '';
	bottom = '';
	maxWidth = '';
	opacity = '';
	scale = '';
	private readonly customProperties = new Map<string, string>();

	setProperty(name: string, value: string): void {
		this.customProperties.set(name, value);
	}

	getPropertyValue(name: string): string {
		return this.customProperties.get(name) ?? '';
	}

	removeProperty(name: string): string {
		const previous = this.customProperties.get(name) ?? '';

		this.customProperties.delete(name);
		return previous;
	}
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly style = new FakeStyle();
	readonly classList = {
		add: (...tokens: string[]) => {
			for (const token of tokens) {
				this.classNames.add(token);
			}
		},
		remove: (...tokens: string[]) => {
			for (const token of tokens) {
				this.classNames.delete(token);
			}
		},
		contains: (token: string) => this.hasClass(token),
		toggle: (token: string, force?: boolean) => {
			const enabled = force ?? !this.hasClass(token);

			if (enabled) {
				this.classNames.add(token);
			} else {
				this.classNames.delete(token);
			}
			return enabled;
		},
	};
	className = '';
	checked = false;
	hidden = false;
	indeterminate = false;
	textContent = '';
	title = '';
	type = '';
	clientWidth = 1000;
	clientHeight = 800;
	boundsLeft = 0;
	boundsTop = 0;
	private readonly classNames = new Set<string>();
	private readonly attributes = new Map<string, string>();
	private readonly listeners = new Map<string, Set<GraphEventListener>>();
	private readonly capturedPointers = new Set<number>();
	private parent: FakeElement | undefined;

	constructor(
		readonly ownerDocument: FakeDocument,
		private readonly localName = 'div',
	) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	append(...children: FakeElement[]): void {
		for (const child of children) {
			child.parent = this;
			this.children.push(child);
		}
	}

	replaceChildren(...children: FakeElement[]): void {
		for (const child of this.children) {
			child.parent = undefined;
		}
		this.children.length = 0;
		this.append(...children);
	}

	remove(): void {
		if (!this.parent) {
			return;
		}

		const index = this.parent.children.indexOf(this);

		if (index >= 0) {
			this.parent.children.splice(index, 1);
		}
	}

	setAttribute(name: string, value = ''): void {
		this.attributes.set(name, value);
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	closest(selector: string): FakeElement | null {
		if (selector.split(',').some((part) => this.matchesSelector(part.trim()))) {
			return this;
		}

		return this.parent?.closest(selector) ?? null;
	}

	private matchesSelector(selector: string): boolean {
		if (selector === this.localName) {
			return true;
		}
		if (selector === 'a[href]') {
			return this.localName === 'a' && this.hasAttribute('href');
		}
		if (selector === '[contenteditable]:not([contenteditable="false"])') {
			return this.hasAttribute('contenteditable')
				&& this.getAttribute('contenteditable') !== 'false';
		}

		const attributeMatch = /^\[([^\]]+)\]$/.exec(selector);
		return attributeMatch?.[1] !== undefined
			&& this.hasAttribute(attributeMatch[1]);
	}

	hasClass(className: string): boolean {
		return this.classNames.has(className)
			|| this.className.split(/\s+/).includes(className)
			|| (this.getAttribute('class') ?? '').split(/\s+/).includes(className);
	}

	addEventListener(type: string, listener: GraphEventListener): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: GraphEventListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatch(type: string, event: Event): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}

		if (!(event as Event & { propagationStopped?: boolean }).propagationStopped) {
			this.parent?.dispatch(type, event);
		}
	}

	setPointerCapture(pointerId: number): void {
		this.capturedPointers.add(pointerId);
	}

	hasPointerCapture(pointerId: number): boolean {
		return this.capturedPointers.has(pointerId);
	}

	releasePointerCapture(pointerId: number): void {
		this.capturedPointers.delete(pointerId);
	}

	losePointerCapture(pointerId: number): void {
		this.capturedPointers.delete(pointerId);
		this.dispatch(
			'lostpointercapture',
			createPointerEvent(this, 0, 0, pointerId),
		);
	}

	getBoundingClientRect(): DOMRect {
		return {
			x: this.boundsLeft,
			y: this.boundsTop,
			left: this.boundsLeft,
			top: this.boundsTop,
			right: this.boundsLeft + this.clientWidth,
			bottom: this.boundsTop + this.clientHeight,
			width: this.clientWidth,
			height: this.clientHeight,
			toJSON: () => ({}),
		};
	}
}

function getDescendantByAttribute(
	element: FakeElement,
	attributeName: string,
	attributeValue: string,
): FakeElement {
	for (const child of element.children) {
		if (child.getAttribute(attributeName) === attributeValue) {
			return child;
		}

		const descendant = findDescendantByAttribute(
			child,
			attributeName,
			attributeValue,
		);

		if (descendant) {
			return descendant;
		}
	}

	assert.fail(`${attributeName}="${attributeValue}" 요소가 있어야 한다.`);
}

function findDescendantByAttribute(
	element: FakeElement,
	attributeName: string,
	attributeValue: string,
): FakeElement | undefined {
	for (const child of element.children) {
		if (child.getAttribute(attributeName) === attributeValue) {
			return child;
		}

		const descendant = findDescendantByAttribute(
			child,
			attributeName,
			attributeValue,
		);

		if (descendant) {
			return descendant;
		}
	}

	return undefined;
}

function getTaskElements(
	element: FakeElement,
	attributeName: string,
	attributeValue: string,
): FakeElement[] {
	return element.children.flatMap((child) => [
		...(child.getAttribute(attributeName) === attributeValue ? [child] : []),
		...getTaskElements(child, attributeName, attributeValue),
	]);
}

function getTaskElement(
	element: FakeElement,
	entityAttributeName: string,
	entityId: string,
	taskId: string,
): FakeElement {
	const taskElement = getTaskElements(
		element,
		entityAttributeName,
		entityId,
	).find((candidate) => candidate.getAttribute('data-task-id') === taskId);

	assert.ok(taskElement, `${taskId}의 ${entityAttributeName}="${entityId}" 요소가 있어야 한다.`);
	return taskElement;
}

function findTaskPort(
	element: FakeElement,
	taskId: string,
	nodeId: string,
	direction: 'input' | 'output',
): FakeElement | undefined {
	const node = getTaskElements(element, 'data-task-node-id', nodeId).find(
		(candidate) => candidate.getAttribute('data-task-id') === taskId,
	);

	return node
		? findDescendantByAttribute(node, TASK_PORT_DIRECTION_ATTRIBUTE, direction)
		: undefined;
}

function getTaskPort(
	element: FakeElement,
	taskId: string,
	nodeId: string,
	direction: 'input' | 'output',
): FakeElement {
	const port = findTaskPort(element, taskId, nodeId, direction);

	assert.ok(port, `${taskId}/${nodeId} ${direction} Port가 있어야 한다.`);
	return port;
}

function connectTaskPorts(
	element: FakeElement,
	taskId: string,
	sourceNodeId: string,
	targetNodeId: string,
): void {
	const output = getTaskPort(element, taskId, sourceNodeId, 'output');

	output.dispatch('click', createClickEvent(output));
	const input = getTaskPort(element, taskId, targetNodeId, 'input');

	assert.strictEqual(input.hasClass('is-valid-target'), true);
	input.dispatch('click', createClickEvent(input));
}

function findTaskEdgeAction(
	element: FakeElement,
	taskId: string,
	edgeId: string,
): FakeElement | undefined {
	return getTaskElements(
		element,
		TASK_EDGE_ACTION_EDGE_ID_ATTRIBUTE,
		edgeId,
	).find((candidate) => (
		candidate.getAttribute(TASK_EDGE_ACTION_TASK_ID_ATTRIBUTE) === taskId
	));
}

function getTaskEdgeAction(
	element: FakeElement,
	taskId: string,
	edgeId: string,
): FakeElement {
	const action = findTaskEdgeAction(element, taskId, edgeId);

	assert.ok(action, `${taskId}의 Edge ${edgeId} Action이 있어야 한다.`);
	return action;
}

function getDescendantsByClass(
	element: FakeElement,
	className: string,
): FakeElement[] {
	return element.children.flatMap((child) => [
		...(child.hasClass(className) ? [child] : []),
		...getDescendantsByClass(child, className),
	]);
}

function openArrangeAllDialog(root: FakeElement): FakeElement {
	const button = getDescendantByAttribute(
		root,
		'aria-label',
		'그래프 전부 정렬하기',
	);

	button.dispatch('click', createClickEvent(button));
	const dialog = getDescendantByClass(root, 'graph-arrange-all-confirm-overlay');

	assert.strictEqual(dialog.hidden, false);
	return dialog;
}

function getNavigatorRootNames(root: FakeElement): string[] {
	const rootList = getDescendantByClass(root, 'graph-navigator-root-list');

	return rootList.children.map((item) => (
		getDescendantByClass(item, 'graph-navigator-root-name').textContent
	));
}

function getNavigatorRootPaths(root: FakeElement): string[] {
	return getDescendantsByClass(root, 'graph-navigator-root-path')
		.map((path) => path.textContent);
}

function getNavigatorRootButtons(root: FakeElement): FakeElement[] {
	const rootList = getDescendantByClass(root, 'graph-navigator-root-list');

	return rootList.children.map((item) => (
		getDescendantByClass(item, 'graph-navigator-root-button')
	));
}

function getDescendantByClass(
	element: FakeElement,
	className: string,
): FakeElement {
	for (const child of element.children) {
		if (child.hasClass(className)) {
			return child;
		}

		const descendant = findDescendantByClass(child, className);

		if (descendant) {
			return descendant;
		}
	}

	assert.fail(`${className} 요소가 있어야 한다.`);
}

function findDescendantByClass(
	element: FakeElement,
	className: string,
): FakeElement | undefined {
	for (const child of element.children) {
		if (child.hasClass(className)) {
			return child;
		}

		const descendant = findDescendantByClass(child, className);

		if (descendant) {
			return descendant;
		}
	}

	return undefined;
}

function readMinimapViewportAttributes(
	indicator: FakeElement,
): Record<string, string | null> {
	return {
		x: indicator.getAttribute('x'),
		y: indicator.getAttribute('y'),
		width: indicator.getAttribute('width'),
		height: indicator.getAttribute('height'),
		visibility: indicator.getAttribute('visibility'),
	};
}

function createClickEvent(
	target: FakeElement,
): MouseEvent & { readonly propagationStopped: boolean } {
	let propagationStopped = false;

	return {
		target: target.asHtmlElement(),
		preventDefault: () => undefined,
		stopPropagation: () => {
			propagationStopped = true;
		},
		get propagationStopped() {
			return propagationStopped;
		},
	} as unknown as MouseEvent & { readonly propagationStopped: boolean };
}

function createKeyboardEvent(key: string): KeyboardEvent {
	let propagationStopped = false;

	return {
		key,
		preventDefault: () => undefined,
		stopPropagation: () => {
			propagationStopped = true;
		},
		get propagationStopped() {
			return propagationStopped;
		},
	} as unknown as KeyboardEvent;
}

function createPointerEvent(
	target: FakeElement,
	clientX: number,
	clientY: number,
	pointerId = 1,
): PointerEvent {
	let propagationStopped = false;

	return {
		isPrimary: true,
		button: 0,
		pointerId,
		clientX,
		clientY,
		target: target.asHtmlElement(),
		preventDefault: () => undefined,
		stopPropagation: () => {
			propagationStopped = true;
		},
		get propagationStopped() {
			return propagationStopped;
		},
	} as unknown as PointerEvent;
}

function setClientBounds(
	element: FakeElement,
	left: number,
	top: number,
	width: number,
	height: number,
): void {
	element.boundsLeft = left;
	element.boundsTop = top;
	element.clientWidth = width;
	element.clientHeight = height;
}

function assertPointAlmostEqual(
	actual: { readonly x: number; readonly y: number },
	expected: { readonly x: number; readonly y: number },
): void {
	assert.ok(Math.abs(actual.x - expected.x) < 1e-10);
	assert.ok(Math.abs(actual.y - expected.y) < 1e-10);
}

function beginNodeDrag(
	node: FakeElement,
	clientX: number,
	clientY: number,
): void {
	node.dispatch('pointerdown', createPointerEvent(node, 0, 0));
	node.dispatch('pointermove', createPointerEvent(node, clientX, clientY));
}

function performNodeDrop(
	node: FakeElement,
	clientX: number,
	clientY: number,
): void {
	beginNodeDrag(node, clientX, clientY);
	node.dispatch('pointerup', createPointerEvent(node, clientX, clientY));
}

function readTranslateY(transform: string): number {
	return readTranslate(transform).y;
}

function readTranslate(transform: string): { x: number; y: number } {
	const match = /^translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\)$/.exec(
		transform,
	);

	assert.ok(match?.[1] && match[2]);
	return { x: Number(match[1]), y: Number(match[2]) };
}

function readEffectRegionBounds(region: FakeElement): {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
} {
	const position = readTranslate(region.style.transform);

	return {
		...position,
		width: Number.parseFloat(region.style.width),
		height: Number.parseFloat(region.style.height),
	};
}

function createLayoutPositionMap(
	layout: ReturnType<typeof createGraphLayout>,
): ReadonlyMap<string, { readonly x: number; readonly y: number }> {
	return new Map(layout.nodes.map((node) => [node.id, node.position]));
}

function getNodeEffects(
	element: FakeElement,
	kind?: string,
): FakeElement[] {
	return getDescendantsByClass(element, 'graph-node-effect').filter(
		(effect) => kind === undefined
			|| effect.getAttribute('data-graph-node-effect') === kind,
	);
}

function findEffectRegion(
	root: FakeElement,
	layoutNodeId: string,
): FakeElement | undefined {
	return findDescendantByAttribute(
		root,
		'data-graph-node-effect-region',
		layoutNodeId,
	);
}

function getEffectRegion(root: FakeElement, layoutNodeId: string): FakeElement {
	const region = findEffectRegion(root, layoutNodeId);

	assert.ok(region, `${layoutNodeId} Graph Node Effect Region이 있어야 한다.`);
	return region;
}

function findNodeEffect(
	element: FakeElement,
	kind: string,
): FakeElement | undefined {
	return getNodeEffects(element, kind)[0];
}

function getNodeEffect(element: FakeElement, kind: string): FakeElement {
	const effect = findNodeEffect(element, kind);

	assert.ok(effect, `${kind} Graph Node Effect가 있어야 한다.`);
	return effect;
}

function subtractPositions(
	left: { readonly x: number; readonly y: number },
	right: { readonly x: number; readonly y: number },
): { x: number; y: number } {
	return {
		x: left.x - right.x,
		y: left.y - right.y,
	};
}

function getText(element: FakeElement): string {
	return [element.textContent, ...element.children.map(getText)].join(' ');
}

function assertRenderedTaskGeometry(
	root: FakeElement,
	task: TaskBlueprint,
): void {
	const layout = createTaskGraphLayout([task]);

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
		assert.strictEqual(
			getTaskElement(
				root,
				'data-task-edge-id',
				edge.id,
				edge.taskId,
			).getAttribute('d'),
			[
				`M ${edge.geometry.start.x} ${edge.geometry.start.y}`,
				`C ${edge.geometry.control1.x} ${edge.geometry.control1.y}`,
				`${edge.geometry.control2.x} ${edge.geometry.control2.y}`,
				`${edge.geometry.end.x} ${edge.geometry.end.y}`,
			].join(' '),
		);
		const action = getTaskEdgeAction(root, edge.taskId, edge.id);

		assert.strictEqual(action.style.left, `${edge.geometry.midpoint.x}px`);
		assert.strictEqual(action.style.top, `${edge.geometry.midpoint.y}px`);
	}
}

function createSerialRenderingTask(
	taskId: string,
	origin: { readonly x: number; readonly y: number },
	workCount: number,
): TaskBlueprint {
	let sequence = 0;
	const task = createDefaultTaskBlueprint({
		title: 'Serial Task',
		origin,
	}, () => 'serial-' + ++sequence);
	const start = task.nodes.find((node) => node.kind === 'start');
	const end = task.nodes.find((node) => node.kind === 'end');

	assert.ok(start && end);
	const works = Array.from({ length: workCount }, (_, index) => ({
		id: 'task-node:serial-work-' + index,
		kind: 'work' as const,
		title: 'Work ' + (index + 1),
		description: '',
		prompt: '',
	}));
	const nodes = [start, ...works, end];

	return {
		...task,
		id: taskId,
		nodePositions: {
			...Object.fromEntries(works.map((work, index) => [
				work.id,
				{ x: 320 * (index + 1), y: -14 },
			])),
			[end.id]: { x: 320 * (workCount + 1), y: 28 },
		},
		nodes,
		edges: nodes.slice(0, -1).map((node, index) => ({
			id: 'task-edge:serial-' + index,
			source: node.id,
			target: nodes[index + 1]?.id ?? end.id,
		})),
	};
}

/** Graph View 통합 테스트에 사용할 고정 ID Task Blueprint를 만든다. */
function createRenderingTask(
	origin: { readonly x: number; readonly y: number },
): TaskBlueprint {
	let sequence = 0;
	const state = createTaskState([], () => `render-${++sequence}`);
	const task = state.createTask({
		title: 'Render Task Graph',
		description: 'Show Task and Workspace Graph together.',
		origin,
	});
	const withWork = state.addWork(task.id, {
		title: 'Render Task nodes',
		description: 'Render Start, Work, and End nodes.',
		prompt: 'Reuse the existing Graph World layers.',
	});
	const start = withWork?.nodes.find((node) => node.kind === 'start');
	const work = withWork?.nodes.find((node) => node.kind === 'work');
	const end = withWork?.nodes.find((node) => node.kind === 'end');

	assert.ok(withWork && start && work && end);
	assert.ok(state.connect(task.id, start.id, task.id, work.id));
	assert.ok(state.connect(task.id, work.id, task.id, end.id));
	return state.getTask(task.id) ?? assert.fail('Ready rendering Task가 있어야 한다.');
}

function beginTaskDrag(
	node: FakeElement,
	start: { readonly x: number; readonly y: number },
	end: { readonly x: number; readonly y: number },
): void {
	node.dispatch('pointerdown', createPointerEvent(node, start.x, start.y));
	node.dispatch('pointermove', createPointerEvent(node, end.x, end.y));
}

function performTaskDrag(
	node: FakeElement,
	start: { readonly x: number; readonly y: number },
	end: { readonly x: number; readonly y: number },
): void {
	beginTaskDrag(node, start, end);
	node.dispatch('pointerup', createPointerEvent(node, end.x, end.y));
}

/** 서로 다른 Task가 공유할 고정 Node/Edge ID를 가진 Blueprint를 만든다. */
function createCollidingRenderingTask(
	taskId: string,
	title: string,
	origin: { readonly x: number; readonly y: number },
): TaskBlueprint {
	const ids = [
		'unused-task-id',
		'same-start',
		'same-end',
	];
	let sequence = 0;
	const task = createDefaultTaskBlueprint({
		title,
		description: `${title} description`,
		origin,
	}, () => ids[sequence++] ?? `unexpected-${sequence}`);
	const start = task.nodes.find((node) => node.kind === 'start');
	const end = task.nodes.find((node) => node.kind === 'end');

	assert.ok(start && end);
	const work = {
		id: 'task-node:same-work',
		kind: 'work' as const,
		title: `${title} Work`,
		description: `${title} Work description`,
		prompt: `${title} prompt`,
	};

	return {
		...task,
		id: taskId,
		nodePositions: {
			...task.nodePositions,
			[work.id]: { x: 320, y: -14 },
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
