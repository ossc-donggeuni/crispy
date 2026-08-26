import * as assert from 'assert';
import { getAgentActivityBindingBlockHeight } from '../../webview/graph/agentActivityBindings';
import {
	createAgentActivityTargetRevealState,
	resolveAgentActivityTargetFocusPoint,
} from '../../webview/graph/agentActivityFocus';
import {
	createFileGroupId,
	createGraphLayout,
	createGraphLayoutNodeId,
	GRAPH_FILE_GROUP_PADDING,
	GRAPH_FILE_GROUP_ROW_HEIGHT,
	type GraphLayout,
} from '../../webview/graph/graphLayout';
import {
	GRAPH_MOCK,
	GRAPH_MOCK_PROJECT,
} from '../../webview/graph/graphMockData';
import { createDetachedRootId } from '../../webview/graph/graphRootPromotion';
import { INITIAL_GRAPH_STATE } from '../../webview/graph/graphState';
import { createTaskGraphTargetIndex } from '../../webview/task/taskGraphTargetLayout';

suite('Agent Activity Focus', () => {
	test('접힌/숨긴 ancestor와 File pagination을 Target 표시 범위까지만 연다', () => {
		const targetId = 'file:pagination-samples/seventeen-files/sample-12.ts';
		const targetIndex = createTaskGraphTargetIndex(GRAPH_MOCK);
		const result = createAgentActivityTargetRevealState(
			GRAPH_MOCK,
			targetIndex,
			{ nodeId: targetId },
			{
				...INITIAL_GRAPH_STATE,
				hiddenNodeIds: {
					'folder:pagination-samples': true,
					'folder:pagination-samples/seventeen-files': true,
					[targetId]: true,
					'file:app/src/graphView.ts': true,
				},
			},
		);

		assert.ok(result);
		assert.strictEqual(result.preferredRootId, undefined);
		assert.strictEqual(result.state.openedFolders?.['project:crispy'], true);
		assert.strictEqual(
			result.state.openedFolders?.['folder:pagination-samples'],
			true,
		);
		assert.strictEqual(
			result.state.openedFolders?.[
				'folder:pagination-samples/seventeen-files'
			],
			true,
		);
		assert.strictEqual(
			result.state.fileGroupPages?.[createFileGroupId(
				'folder:pagination-samples/seventeen-files',
			)],
			3,
		);
		assert.strictEqual(result.state.hiddenNodeIds?.[targetId], undefined);
		assert.strictEqual(
			result.state.hiddenNodeIds?.['folder:pagination-samples'],
			undefined,
		);
		assert.strictEqual(
			result.state.hiddenNodeIds?.['file:app/src/graphView.ts'],
			true,
		);

		const layout = createGraphLayout(GRAPH_MOCK, {
			openedFolders: result.state.openedFolders,
			fileGroupPages: result.state.fileGroupPages,
			hiddenNodeIds: result.state.hiddenNodeIds,
		});
		assert.ok(resolveAgentActivityTargetFocusPoint(
			layout,
			{},
			{ nodeId: targetId },
		));
	});

	test('grouped File 행의 저장 위치와 앞선 Binding footprint를 반영한다', () => {
		const groupId = 'folder:files';
		const layout: GraphLayout = {
			nodes: [{
				kind: 'file-group',
				id: groupId,
				name: 'files',
				depth: 1,
				position: { x: 10, y: 20 },
				width: 240,
				height: 120,
				presentation: 'grouped',
				children: [
					{
						kind: 'file',
						id: 'file:first.ts',
						name: 'first.ts',
						presentation: 'normal',
						agentActivityBindingCount: 2,
					},
					{
						kind: 'file',
						id: 'file:target.ts',
						name: 'target.ts',
						presentation: 'normal',
					},
				],
			}],
			edges: [],
			rootContexts: {},
			rootNodeIds: new Set(),
			arrangedNodeIds: new Set([groupId]),
			unarrangedNodeIds: new Set(),
		};
		const point = resolveAgentActivityTargetFocusPoint(
			layout,
			{ [groupId]: { x: 500, y: 600 } },
			{ nodeId: 'file:target.ts' },
		);

		assert.deepStrictEqual(point, {
			x: 620,
			y: 600
				+ GRAPH_FILE_GROUP_PADDING
				+ GRAPH_FILE_GROUP_ROW_HEIGHT
				+ getAgentActivityBindingBlockHeight(2)
				+ GRAPH_FILE_GROUP_ROW_HEIGHT / 2,
		});
	});

	test('source보다 명시적/preferred Detached occurrence를 우선한다', () => {
		const sourceId = 'folder:target';
		const detachedRootId = createDetachedRootId(sourceId, 1);
		const detachedNodeId = createGraphLayoutNodeId(detachedRootId, sourceId);
		const layout: GraphLayout = {
			nodes: [
				{
					kind: 'folder',
					id: sourceId,
					name: 'target',
					status: 'loaded',
					depth: 0,
					position: { x: 10, y: 20 },
					width: 240,
					height: 42,
				},
				{
					kind: 'folder',
					id: detachedNodeId,
					name: 'target',
					status: 'loaded',
					depth: 0,
					position: { x: 400, y: 500 },
					width: 240,
					height: 42,
				},
			],
			edges: [],
			rootContexts: {},
			rootNodeIds: new Set([sourceId, detachedNodeId]),
			arrangedNodeIds: new Set([sourceId, detachedNodeId]),
			unarrangedNodeIds: new Set(),
		};

		assert.deepStrictEqual(resolveAgentActivityTargetFocusPoint(
			layout,
			{},
			{ nodeId: sourceId },
		), { x: 130, y: 41 });
		assert.deepStrictEqual(resolveAgentActivityTargetFocusPoint(
			layout,
			{},
			{ nodeId: sourceId },
			detachedRootId,
		), { x: 520, y: 521 });
		assert.deepStrictEqual(resolveAgentActivityTargetFocusPoint(
			layout,
			{},
			{ nodeId: sourceId, rootId: detachedRootId },
		), { x: 520, y: 521 });
	});

	test('Detached Root 자체 Focus는 원래 Tree ancestor를 열지 않는다', () => {
		const targetId = 'folder:app/src';
		const detachedRootId = createDetachedRootId(targetId, 1);
		const app = GRAPH_MOCK_PROJECT.children.find(
			(entry) => entry.id === 'folder:app',
		);

		assert.ok(app?.kind === 'folder');
		const target = app.children.find((entry) => entry.id === targetId);

		assert.ok(target?.kind === 'folder');
		const graph = {
			...GRAPH_MOCK,
			roots: [
				...GRAPH_MOCK.roots,
				{ id: detachedRootId, nodeId: targetId },
			],
			rootNodes: {
				...GRAPH_MOCK.rootNodes,
				[targetId]: target,
			},
		};
		const result = createAgentActivityTargetRevealState(
			graph,
			createTaskGraphTargetIndex(GRAPH_MOCK),
			{ nodeId: targetId, rootId: detachedRootId },
			INITIAL_GRAPH_STATE,
		);

		assert.ok(result);
		assert.strictEqual(result.preferredRootId, detachedRootId);
		assert.deepStrictEqual(result.state.openedFolders, {});
	});

	test('존재하지 않는 Target은 reveal과 focus를 안전하게 생략한다', () => {
		assert.strictEqual(createAgentActivityTargetRevealState(
			GRAPH_MOCK,
			createTaskGraphTargetIndex(GRAPH_MOCK),
			{ nodeId: 'file:missing.ts' },
			INITIAL_GRAPH_STATE,
		), undefined);
		assert.strictEqual(resolveAgentActivityTargetFocusPoint(
			{
				nodes: [],
				edges: [],
				rootContexts: {},
				rootNodeIds: new Set(),
				arrangedNodeIds: new Set(),
				unarrangedNodeIds: new Set(),
			},
			{},
			{ nodeId: 'file:missing.ts' },
		), undefined);
	});
});
