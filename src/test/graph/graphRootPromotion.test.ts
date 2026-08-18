import * as assert from 'assert';
import {
	createSingleRootGraph,
	type Project,
} from '../../webview/graph/graphModel';
import {
	addGraphRoot,
	createPromotedGraphRootId,
	createRootContextRelativePath,
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

const NESTED_PROJECT: Project = {
	kind: 'project',
	id: 'project:nested-workspace',
	name: 'crispy',
	children: [{
		kind: 'folder',
		id: 'folder:packages',
		name: 'packages',
		children: [{
			kind: 'folder',
			id: 'folder:demo',
			name: 'demo',
			children: [{
				kind: 'folder',
				id: 'folder:package-src',
				name: 'src',
				children: [{
					kind: 'folder',
					id: 'folder:multi-root-demo',
					name: 'multi-root-demo',
					children: [{
						kind: 'folder',
						id: 'folder:single-file',
						name: 'single-file',
						children: [],
					}, {
						kind: 'folder',
						id: 'folder:a',
						name: 'a',
						children: [{
							kind: 'folder',
							id: 'folder:b',
							name: 'b',
							children: [{
								kind: 'folder',
								id: 'folder:deep-target',
								name: 'target',
								children: [],
							}],
						}],
					}],
				}],
			}],
		}],
	}, {
		kind: 'folder',
		id: 'folder:top-src',
		name: 'src',
		children: [{
			kind: 'folder',
			id: 'folder:top-webview',
			name: 'webview',
			children: [{
				kind: 'file',
				id: 'file:top-graph-view',
				name: 'graphView.ts',
			}],
		}],
	}],
};

suite('Graph Root Promotion', () => {
	test('Context helper는 Source Root 종류와 관계없이 이름과 Parent segment를 조합한다', () => {
		const sourceRoot = {
			id: 'root:workspace',
			nodeId: PROJECT.id,
		};

		assert.strictEqual(
			createRootContextRelativePath(
				sourceRoot,
				PROJECT,
				['packages', 'demo', 'src'],
			),
			'crispy/packages/demo/src/',
		);
		assert.strictEqual(
			createRootContextRelativePath(sourceRoot, PROJECT, []),
			'crispy/',
		);
	});

	test('실제 Tree 관계로 Folder/File 위치와 Root 기준 상대 경로를 찾는다', () => {
		const graph = createSingleRootGraph(PROJECT, 'root:workspace');
		const folder = findGraphNode(graph, 'folder:graph');
		const file = findGraphNode(graph, 'file:graphView');

		assert.strictEqual(folder?.node.name, 'graph');
		assert.strictEqual(folder?.root.id, 'root:workspace');
		assert.strictEqual(folder?.relativePath, 'src/webview/graph');
		assert.deepStrictEqual(folder?.parentPathSegments, ['src', 'webview']);
		assert.strictEqual(file?.node.name, 'graphView.ts');
		assert.strictEqual(file?.relativePath, 'src/webview/graph/graphView.ts');
		assert.deepStrictEqual(
			file?.parentPathSegments,
			['src', 'webview', 'graph'],
		);
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
			context: { relativePath: 'crispy/src/webview/' },
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
			relativePath: 'crispy/src/webview/graph/',
		});
		assert.strictEqual(
			fileAddition.graph.rootNodes['file:graphView']?.kind,
			'file',
		);
	});

	test('Folder/File Context는 대상 이름을 제외한 최초 Graph 기준 부모 경로를 사용한다', () => {
		const graph = createSingleRootGraph(NESTED_PROJECT, 'root:workspace');
		const folderAddition = addGraphRoot(graph, 'folder:multi-root-demo');
		const fileAddition = addGraphRoot(graph, 'file:top-graph-view');

		assert.ok(folderAddition);
		assert.ok(fileAddition);
		assert.strictEqual(
			folderAddition.root.context?.relativePath,
			'crispy/packages/demo/src/',
		);
		assert.strictEqual(
			fileAddition.root.context?.relativePath,
			'crispy/src/webview/',
		);
		assert.ok(!folderAddition.root.context?.relativePath.endsWith(
			'multi-root-demo/',
		));
		assert.ok(!fileAddition.root.context?.relativePath.endsWith(
			'graphView.ts/',
		));
	});

	test('분리된 Root 내부 Promotion은 Source Context와 Root 이름을 한 번만 이어 붙인다', () => {
		const graph = createSingleRootGraph(NESTED_PROJECT, 'root:workspace');
		const sourceAddition = addGraphRoot(graph, 'folder:multi-root-demo');

		assert.ok(sourceAddition);
		const childAddition = addGraphRoot(
			sourceAddition.graph,
			'folder:single-file',
		);

		assert.ok(childAddition);
		assert.strictEqual(
			childAddition.root.context?.relativePath,
			'crispy/packages/demo/src/multi-root-demo/',
		);
		assert.strictEqual(
			childAddition.root.context?.relativePath.match(/packages\/demo\/src/g)?.length,
			1,
		);
	});

	test('깊은 중첩 대상도 자신의 이름을 제외한 전체 Parent segment와 trailing slash를 사용한다', () => {
		const graph = createSingleRootGraph(NESTED_PROJECT, 'root:workspace');
		const sourceAddition = addGraphRoot(graph, 'folder:multi-root-demo');

		assert.ok(sourceAddition);
		const targetAddition = addGraphRoot(
			sourceAddition.graph,
			'folder:deep-target',
		);

		assert.ok(targetAddition);
		assert.strictEqual(
			targetAddition.root.context?.relativePath,
			'crispy/packages/demo/src/multi-root-demo/a/b/',
		);
		assert.ok(!targetAddition.root.context?.relativePath.includes('target'));
	});

	test('Source Project 바로 아래 대상도 Source Root 이름과 trailing slash를 사용한다', () => {
		const addition = addGraphRoot(
			createSingleRootGraph(NESTED_PROJECT, 'root:workspace'),
			'folder:packages',
		);

		assert.ok(addition);
		assert.strictEqual(addition.root.context?.relativePath, 'crispy/');
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
