import * as assert from 'assert';
import {
	createSingleRootGraph,
	type Project,
} from '../../webview/graph/graphModel';
import {
	addGraphRoot,
	createPromotedGraphRootId,
	findGraphNode,
	removeGraphRoot,
} from '../../webview/graph/graphRootPromotion';

const PROJECT: Project = {
	kind: 'project',
	id: 'project:workspace',
	name: 'crispy',
	children: [{
		kind: 'folder',
		id: 'folder:src',
		name: 'src',
		children: [{
			kind: 'folder',
			id: 'folder:webview',
			name: 'webview',
			children: [{
				kind: 'folder',
				id: 'folder:graph',
				name: 'graph',
				children: [{
					kind: 'file',
					id: 'file:graphView',
					name: 'graphView.ts',
				}],
			}],
		}],
	}],
};

suite('Graph Root Promotion', () => {
	test('실제 Tree 관계로 Folder/File 위치와 Root 기준 상대 경로를 찾는다', () => {
		const graph = createSingleRootGraph(PROJECT, 'root:workspace');
		const folder = findGraphNode(graph, 'folder:graph');
		const file = findGraphNode(graph, 'file:graphView');

		assert.strictEqual(folder?.node.name, 'graph');
		assert.strictEqual(folder?.root.id, 'root:workspace');
		assert.strictEqual(folder?.relativePath, 'src/webview/graph');
		assert.strictEqual(file?.node.name, 'graphView.ts');
		assert.strictEqual(file?.relativePath, 'src/webview/graph/graphView.ts');
		assert.ok(!folder?.relativePath.startsWith(`${PROJECT.name}/`));
	});

	test('Folder/File을 같은 immutable addGraphRoot 경로로 추가한다', () => {
		const graph = createSingleRootGraph(PROJECT, 'root:workspace');
		const folderAddition = addGraphRoot(graph, 'folder:graph');

		assert.ok(folderAddition);
		assert.strictEqual(graph.roots.length, 1);
		assert.strictEqual(graph.rootNodes['folder:graph'], undefined);
		assert.deepStrictEqual(folderAddition.root, {
			id: createPromotedGraphRootId('folder:graph'),
			nodeId: 'folder:graph',
			context: { relativePath: 'src/webview/graph' },
		});
		assert.strictEqual(
			folderAddition.graph.rootNodes['folder:graph']?.kind,
			'folder',
		);

		const fileAddition = addGraphRoot(
			folderAddition.graph,
			'file:graphView',
		);

		assert.ok(fileAddition);
		assert.deepStrictEqual(fileAddition.root.context, {
			relativePath: 'graphView.ts',
		});
		assert.strictEqual(
			fileAddition.graph.rootNodes['file:graphView']?.kind,
			'file',
		);
	});

	test('Project, 기존 Root와 잘못된 Node ID는 안전하게 거부한다', () => {
		const graph = createSingleRootGraph(PROJECT, 'root:workspace');

		assert.strictEqual(addGraphRoot(graph, PROJECT.id), undefined);
		assert.strictEqual(addGraphRoot(graph, 'folder:missing'), undefined);

		const addition = addGraphRoot(graph, 'folder:src');

		assert.ok(addition);
		assert.strictEqual(
			addGraphRoot(addition.graph, 'folder:src'),
			undefined,
		);
	});

	test('removeGraphRoot는 Root 목록과 직접 Root 참조만 immutable하게 제거한다', () => {
		const graph = createSingleRootGraph(PROJECT, 'root:workspace');
		const addition = addGraphRoot(graph, 'folder:src');

		assert.ok(addition);
		const removed = removeGraphRoot(addition.graph, addition.root.id);

		assert.deepStrictEqual(removed.roots, graph.roots);
		assert.strictEqual(removed.rootNodes['folder:src'], undefined);
		assert.strictEqual(removed.rootNodes[PROJECT.id], PROJECT);
		assert.strictEqual(removeGraphRoot(graph, 'root:missing'), graph);
	});
});
