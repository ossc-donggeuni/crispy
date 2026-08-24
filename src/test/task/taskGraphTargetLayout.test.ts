import * as assert from 'assert';
import {
	createGraphLayout,
	GRAPH_FOLDER_NODE_HEIGHT,
	GRAPH_FOLDER_NODE_WIDTH,
} from '../../webview/graph/graphLayout';
import type { Graph, Project } from '../../webview/graph/graphModel';
import {
	GRAPH_ROOT_CONTEXT_GAP,
	GRAPH_ROOT_CONTEXT_LINE_HEIGHT,
} from '../../webview/graph/graphRootContext';
import {
	createTaskGraphScopeLayout,
	createTaskGraphScopeNodePositions,
	createTaskGraphTargetIndex,
	sortTaskGraphTargetIds,
	TASK_SCOPE_GRAPH_HEADER_HEIGHT,
	TASK_SCOPE_GRAPH_PADDING_Y,
} from '../../webview/task/taskGraphTargetLayout';

suite('Task Graph Target actual occurrence Layout', () => {
	test('Project Root를 제외하고 Folder/File canonical source를 hierarchy 순서로 index한다', () => {
		const graph = createTargetGraph();
		const index = createTaskGraphTargetIndex(graph);

		assert.strictEqual(index.has('project:workspace'), false);
		assert.deepStrictEqual([...index.values()].map((source) => ({
			id: source.sourceId,
			kind: source.kind,
			path: source.relativePath,
			parentId: source.parentId,
			order: source.order,
		})), [{
			id: 'folder:file:///workspace/src',
			kind: 'folder',
			path: 'workspace/src',
			parentId: undefined,
			order: 0,
		}, {
			id: 'folder:file:///workspace/src/webview',
			kind: 'folder',
			path: 'workspace/src/webview',
			parentId: 'folder:file:///workspace/src',
			order: 1,
		}, {
			id: 'file:file:///workspace/src/webview/graphView.ts',
			kind: 'file',
			path: 'workspace/src/webview/graphView.ts',
			parentId: 'folder:file:///workspace/src/webview',
			order: 2,
		}, {
			id: 'file:file:///workspace/src/esbuild.js',
			kind: 'file',
			path: 'workspace/src/esbuild.js',
			parentId: 'folder:file:///workspace/src',
			order: 3,
		}, {
			id: 'folder:file:///workspace/docs',
			kind: 'folder',
			path: 'workspace/docs',
			parentId: undefined,
			order: 4,
		}]);
	});

	test('Canonical Target은 workspace traversal 순서로 중복 없이 정렬한다', () => {
		const index = createTaskGraphTargetIndex(createTargetGraph());

		assert.deepStrictEqual(sortTaskGraphTargetIds(index, [
			'folder:file:///workspace/docs',
			'file:file:///workspace/src/esbuild.js',
			'folder:file:///workspace/src',
			'file:file:///workspace/missing.ts',
			'file:file:///workspace/src/esbuild.js',
		]), [
			'folder:file:///workspace/src',
			'file:file:///workspace/src/esbuild.js',
			'folder:file:///workspace/docs',
			'file:file:///workspace/missing.ts',
		]);
	});

	test('실제 Graph Root subtree geometry와 relation을 보존해 Region World 좌표를 계산한다', () => {
		const graph = createFolderRootGraph();
		const rootId = 'folder:file:///workspace/src';
		const childId = 'folder:file:///workspace/src/webview';
		const layout = createGraphLayout(graph, {
			openedFolders: { [rootId]: true, [childId]: true },
		});
		const scope = createTaskGraphScopeLayout(layout, {}, [{
			sourceId: rootId,
			occurrenceNodeId: rootId,
		}]);

		assert.strictEqual(scope.occurrences.length, 1);
		assert.ok(scope.width > GRAPH_FOLDER_NODE_WIDTH);
		assert.ok(scope.height > GRAPH_FOLDER_NODE_HEIGHT);
		assert.deepStrictEqual(
			[...scope.occurrences[0]?.nodePositions.keys() ?? []],
			[
				rootId,
				'file:file:///workspace/src/esbuild.js',
				childId,
				'file:file:///workspace/src/webview/graphView.ts',
			],
		);
		assert.strictEqual(
			scope.occurrences[0]?.nodePositions.has('folder:file:///workspace/docs'),
			false,
		);
		const area = {
			kind: 'work' as const,
			position: { x: 800, y: 300 },
			width: scope.width,
			height: scope.height,
			sourceIds: [rootId],
		};
		const positioned = createTaskGraphScopeNodePositions(area, scope);
		const beforeRoot = layout.nodes.find((node) => node.id === rootId)?.position;
		const beforeChild = layout.nodes.find((node) => node.id === childId)?.position;
		const afterRoot = positioned.get(rootId);
		const afterChild = positioned.get(childId);

		assert.ok(beforeRoot && beforeChild && afterRoot && afterChild);
		assert.deepStrictEqual({
			x: afterChild.x - afterRoot.x,
			y: afterChild.y - afterRoot.y,
		}, {
			x: beforeChild.x - beforeRoot.x,
			y: beforeChild.y - beforeRoot.y,
		});
		const occurrence = scope.occurrences[0];

		assert.ok(occurrence);
		const deltaX = afterRoot.x - beforeRoot.x;

		assert.strictEqual(
			occurrence.bounds.x + deltaX + occurrence.bounds.width / 2,
			area.position.x + area.width / 2,
		);
		assert.strictEqual(
			Math.min(...[...positioned.values()].map((position) => position.y)),
			area.position.y + TASK_SCOPE_GRAPH_HEADER_HEIGHT + TASK_SCOPE_GRAPH_PADDING_Y,
		);
	});

	test('Detached Root context label의 세로 bounds를 Region 배치에 포함한다', () => {
		const baseGraph = createFolderRootGraph();
		const rootId = 'folder:file:///workspace/src';
		const graph: Graph = {
			...baseGraph,
			roots: baseGraph.roots.map((root) => root.nodeId === rootId
				? { ...root, context: { relativePath: 'workspace/src' } }
				: root),
		};
		const layout = createGraphLayout(graph);
		const root = layout.nodes.find((node) => node.id === rootId);
		const scope = createTaskGraphScopeLayout(layout, {}, [{
			sourceId: rootId,
			occurrenceNodeId: rootId,
		}]);
		const occurrence = scope.occurrences[0];

		assert.ok(root && occurrence);
		assert.strictEqual(
			occurrence.bounds.y,
			root.position.y
				- GRAPH_ROOT_CONTEXT_GAP
				- GRAPH_ROOT_CONTEXT_LINE_HEIGHT,
		);
		assert.strictEqual(occurrence.bounds.width, root.width);
		const area = {
			kind: 'reference' as const,
			position: { x: 500, y: 300 },
			width: scope.width,
			height: scope.height,
			sourceIds: [rootId],
		};
		const positionedRoot = createTaskGraphScopeNodePositions(area, scope).get(
			rootId,
		);

		assert.ok(positionedRoot);
		assert.strictEqual(
			positionedRoot.y
				- GRAPH_ROOT_CONTEXT_GAP
				- GRAPH_ROOT_CONTEXT_LINE_HEIGHT,
			area.position.y + TASK_SCOPE_GRAPH_HEADER_HEIGHT + TASK_SCOPE_GRAPH_PADDING_Y,
		);
	});

	test('실제 Root occurrence만 결정적으로 쌓고 unavailable ID용 fake item을 만들지 않는다', () => {
		const graph = createFolderRootGraph();
		const layout = createGraphLayout(graph);
		const scope = createTaskGraphScopeLayout(layout, {}, [{
			sourceId: 'folder:file:///workspace/src',
			occurrenceNodeId: 'folder:file:///workspace/src',
		}, {
			sourceId: 'folder:file:///workspace/docs',
			occurrenceNodeId: 'folder:file:///workspace/docs',
		}, {
			sourceId: 'file:file:///workspace/missing.ts',
			occurrenceNodeId: 'missing-visual',
		}]);

		assert.deepStrictEqual(scope.occurrences.map((item) => item.sourceId), [
			'folder:file:///workspace/src',
			'folder:file:///workspace/docs',
		]);
		const area = {
			kind: 'reference' as const,
			position: { x: 0, y: 0 },
			width: scope.width,
			height: scope.height,
			sourceIds: scope.occurrences.map((item) => item.sourceId),
		};
		const positioned = createTaskGraphScopeNodePositions(area, scope);

		assert.ok(
			(positioned.get('folder:file:///workspace/src')?.y ?? 0)
				< (positioned.get('folder:file:///workspace/docs')?.y ?? 0),
		);
		assert.strictEqual(positioned.has('missing-visual'), false);
	});

	test('Workspace hierarchy의 non-root actual Folder occurrence와 자기 subtree만 측정한다', () => {
		const graph = createTargetGraph();
		const sourceId = 'folder:file:///workspace/src/webview';
		const layout = createGraphLayout(graph, {
			openedFolders: {
				'project:workspace': true,
				'folder:file:///workspace/src': true,
				[sourceId]: true,
			},
		});
		const scope = createTaskGraphScopeLayout(layout, {}, [{
			sourceId,
			occurrenceNodeId: sourceId,
		}]);

		assert.strictEqual(layout.rootNodeIds.has(sourceId), false);
		assert.deepStrictEqual(
			[...scope.occurrences[0]?.nodePositions.keys() ?? []],
			[sourceId, 'file:file:///workspace/src/webview/graphView.ts'],
		);
		assert.strictEqual(
			scope.occurrences[0]?.nodePositions.has('folder:file:///workspace/src'),
			false,
		);
	});

	test('별도 Scope에 바인딩된 descendant actual occurrence를 부모 이동 경계에서 제외한다', () => {
		const graph = createTargetGraph();
		const parentId = 'folder:file:///workspace/src';
		const childId = 'folder:file:///workspace/src/webview';
		const childFileId = 'file:file:///workspace/src/webview/graphView.ts';
		const siblingFileId = 'file:file:///workspace/src/esbuild.js';
		const layout = createGraphLayout(graph, {
			openedFolders: {
				'project:workspace': true,
				[parentId]: true,
				[childId]: true,
			},
			unarrangedNodeIds: new Set([parentId, childId]),
		});
		const scopeBoundaries = new Set([parentId, childId]);
		const parentScope = createTaskGraphScopeLayout(layout, {}, [{
			sourceId: parentId,
			occurrenceNodeId: parentId,
		}], scopeBoundaries);
		const childScope = createTaskGraphScopeLayout(layout, {}, [{
			sourceId: childId,
			occurrenceNodeId: childId,
		}], scopeBoundaries);

		assert.deepStrictEqual(
			[...parentScope.occurrences[0]?.nodePositions.keys() ?? []],
			[parentId, siblingFileId],
		);
		assert.deepStrictEqual(
			[...childScope.occurrences[0]?.nodePositions.keys() ?? []],
			[childId, childFileId],
		);
	});
});

function createTargetGraph(): Graph {
	const project: Project = {
		kind: 'project',
		id: 'project:workspace',
		name: 'workspace',
		status: 'loaded',
		children: createWorkspaceChildren(),
	};

	return {
		roots: [{ id: 'root:workspace', nodeId: project.id }],
		rootNodes: { [project.id]: project },
	};
}

function createFolderRootGraph(): Graph {
	const [src, docs] = createWorkspaceChildren();

	assert.ok(src?.kind === 'folder' && docs?.kind === 'folder');
	return {
		roots: [{ id: src.id, nodeId: src.id }, { id: docs.id, nodeId: docs.id }],
		rootNodes: { [src.id]: src, [docs.id]: docs },
	};
}

function createWorkspaceChildren(): Project['children'] {
	return [{
		kind: 'folder',
		id: 'folder:file:///workspace/src',
		name: 'src',
		status: 'loaded',
		children: [{
			kind: 'folder',
			id: 'folder:file:///workspace/src/webview',
			name: 'webview',
			status: 'loaded',
			children: [{
				kind: 'file',
				id: 'file:file:///workspace/src/webview/graphView.ts',
				name: 'graphView.ts',
			}],
		}, {
			kind: 'file',
			id: 'file:file:///workspace/src/esbuild.js',
			name: 'esbuild.js',
		}],
	}, {
		kind: 'folder',
		id: 'folder:file:///workspace/docs',
		name: 'docs',
		status: 'loaded',
		children: [],
	}];
}
