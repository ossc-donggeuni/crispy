import * as assert from 'assert';
import {
	createSingleRootGraph,
	type Project,
} from '../../webview/graph/graphModel';
import {
	addGraphRoot,
	applyDetachedGraphRoots,
	createDetachedRootId,
	createPromotedGraphRootId,
	createRootContextRelativePath,
	findGraphNode,
	getDetachedRootOrdinal,
	getDetachedRootOriginId,
	getDetachedRootNodeId,
	getNextDetachedRootOrdinal,
	isDetachedRootId,
	removeGraphRoot,
} from '../../webview/graph/graphRootPromotion';

const PROJECT: Project = {
	kind: 'project',
	id: 'project:workspace',
	name: 'crispy',
	status: 'loaded',
	children: [{
		kind: 'folder',
		id: 'folder:src',
		name: 'src',
		status: 'loaded',
		children: [{
			kind: 'folder',
			id: 'folder:webview',
			name: 'webview',
			status: 'loaded',
			children: [{
				kind: 'folder',
				id: 'folder:graph',
				name: 'graph',
				status: 'loaded',
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
	status: 'loaded',
	children: [{
		kind: 'folder',
		id: 'folder:packages',
		name: 'packages',
		status: 'loaded',
		children: [{
			kind: 'folder',
			id: 'folder:demo',
			name: 'demo',
			status: 'loaded',
			children: [{
				kind: 'folder',
				id: 'folder:package-src',
				name: 'src',
				status: 'loaded',
				children: [{
					kind: 'folder',
					id: 'folder:multi-root-demo',
					name: 'multi-root-demo',
					status: 'loaded',
					children: [{
						kind: 'folder',
						id: 'folder:single-file',
						name: 'single-file',
						status: 'loaded',
						children: [],
					}, {
						kind: 'folder',
						id: 'folder:a',
						name: 'a',
						status: 'loaded',
						children: [{
							kind: 'folder',
							id: 'folder:b',
							name: 'b',
							status: 'loaded',
							children: [{
								kind: 'folder',
								id: 'folder:deep-target',
								name: 'target',
								status: 'loaded',
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
		status: 'loaded',
		children: [{
			kind: 'folder',
			id: 'folder:top-webview',
			name: 'webview',
			status: 'loaded',
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

	test('Project와 잘못된 Node ID는 거부하고 기존 Source는 새 Instance로 추가한다', () => {
		const graph = createSingleRootGraph(PROJECT, 'root:workspace');

		assert.strictEqual(addGraphRoot(graph, PROJECT.id), undefined);
		assert.strictEqual(addGraphRoot(graph, 'folder:missing'), undefined);

		const addition = addGraphRoot(graph, 'folder:src');

		assert.ok(addition);
		const second = addGraphRoot(addition.graph, 'folder:src');

		assert.ok(second);
		assert.strictEqual(second.root.id, createDetachedRootId('folder:src', 2));
		assert.strictEqual(second.root.nodeId, addition.root.nodeId);
		assert.strictEqual(second.graph.rootNodes['folder:src'], PROJECT.children[0]);
	});

	test('Detached ID helper와 Source별 최고 ordinal + 1 계산을 metadata 없이 수행한다', () => {
		const sourceId = 'folder:/src/components::detached:name';
		const firstId = createDetachedRootId(sourceId, 1);
		const thirdId = createDetachedRootId(sourceId, 3);
		const graph = {
			roots: [
				{ id: 'root:workspace', nodeId: PROJECT.id },
				{ id: firstId, nodeId: sourceId },
				{ id: thirdId, nodeId: sourceId },
			],
			rootNodes: { [PROJECT.id]: PROJECT },
		};

		assert.strictEqual(firstId, `${sourceId}::detached:1`);
		assert.strictEqual(getDetachedRootOrdinal(thirdId), 3);
		assert.strictEqual(isDetachedRootId(thirdId), true);
		assert.strictEqual(isDetachedRootId(`${sourceId}::detached:0`), false);
		assert.strictEqual(getNextDetachedRootOrdinal(graph, sourceId), 4);
		assert.strictEqual(getNextDetachedRootOrdinal(graph, 'folder:other'), 1);
	});

	test('중첩 Detach ID는 원본 Node와 분리 시작 Root Instance를 함께 복원한다', () => {
		const originRootId = createDetachedRootId('folder:parent', 2);
		const nestedId = createDetachedRootId('file:parent/child.ts', 4, originRootId);

		assert.strictEqual(getDetachedRootNodeId(nestedId), 'file:parent/child.ts');
		assert.strictEqual(getDetachedRootOriginId(nestedId), originRootId);
		assert.strictEqual(getDetachedRootOrdinal(nestedId), 4);
	});

	test('중간 Instance 제거 후 최고 순번 다음을 쓰고 전체 제거 후 1부터 재시작한다', () => {
		const graph = createSingleRootGraph(PROJECT, 'root:workspace');
		const first = addGraphRoot(graph, 'folder:src');

		assert.ok(first);
		const second = addGraphRoot(first.graph, 'folder:src');
		assert.ok(second);
		const third = addGraphRoot(second.graph, 'folder:src');
		assert.ok(third);
		const withoutSecond = removeGraphRoot(third.graph, second.root.id);
		const fourth = addGraphRoot(withoutSecond, 'folder:src');

		assert.ok(fourth);
		assert.deepStrictEqual(
			fourth.graph.roots.filter((root) => root.nodeId === 'folder:src')
				.map((root) => getDetachedRootOrdinal(root.id)),
			[1, 3, 4],
		);
		const withoutAll = [first.root.id, third.root.id, fourth.root.id].reduce(
			(current, rootId) => removeGraphRoot(current, rootId),
			fourth.graph,
		);
		const restarted = addGraphRoot(withoutAll, 'folder:src');

		assert.ok(restarted);
		assert.strictEqual(getDetachedRootOrdinal(restarted.root.id), 1);
	});

	test('저장된 Detached Root를 순서대로 적용하고 존재하지 않는 Node는 유지한 채 무시한다', () => {
		const graph = createSingleRootGraph(PROJECT, 'root:workspace');
		const restored = applyDetachedGraphRoots(graph, {
			'folder:graph': true,
			'file:graphView': true,
			'folder:missing': true,
		});

		assert.deepStrictEqual(
			restored.roots.map((root) => root.nodeId),
			[PROJECT.id, 'folder:graph', 'file:graphView'],
		);
		assert.strictEqual(restored.rootNodes['folder:graph']?.kind, 'folder');
		assert.strictEqual(restored.rootNodes['file:graphView']?.kind, 'file');
		assert.strictEqual(restored.rootNodes['folder:missing'], undefined);
		assert.strictEqual(
			applyDetachedGraphRoots(graph, { 'folder:missing': true }),
			graph,
		);
	});

	test('저장된 sparse ordinal을 ID에서 복원하고 다음 Detach는 최고 순번 다음을 사용한다', () => {
		const graph = createSingleRootGraph(PROJECT, 'root:workspace');
		const firstId = createDetachedRootId('folder:src', 1);
		const thirdId = createDetachedRootId('folder:src', 3);
		const restored = applyDetachedGraphRoots(graph, {
			[firstId]: true,
			[thirdId]: true,
		});

		assert.deepStrictEqual(
			restored.roots
				.filter((root) => root.nodeId === 'folder:src')
				.map((root) => root.id),
			[firstId, thirdId],
		);
		const addition = addGraphRoot(restored, 'folder:src');

		assert.ok(addition);
		assert.strictEqual(
			addition.root.id,
			createDetachedRootId('folder:src', 4),
		);
	});

	test('중첩 Detach의 origin-scoped ID를 별도 metadata 없이 그대로 복원한다', () => {
		const graph = createSingleRootGraph(PROJECT, 'root:workspace');
		const parentId = createDetachedRootId('folder:graph', 1);
		const childId = createDetachedRootId('file:graphView', 1, parentId);
		const restored = applyDetachedGraphRoots(graph, {
			[parentId]: true,
			[childId]: true,
		});

		assert.ok(restored.roots.some((root) => root.id === parentId));
		assert.ok(restored.roots.some((root) => root.id === childId));
		assert.strictEqual(
			getDetachedRootOriginId(childId),
			parentId,
		);
		assert.strictEqual(
			restored.roots.find((root) => root.id === childId)?.nodeId,
			'file:graphView',
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
