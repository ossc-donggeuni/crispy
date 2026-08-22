import * as assert from 'assert';
import type {
	File,
	Folder,
	Graph,
	Project,
} from '../../webview/graph/graphModel';
import { createGraphNavigatorRoots } from '../../webview/graph/graphNavigatorRoots';
import { createDetachedRootId } from '../../webview/graph/graphRootPromotion';

const PROJECT: Project = {
	kind: 'project',
	id: 'project:crispy',
	name: 'crispy',
	status: 'loaded',
	children: [],
};
const FOLDER_B: Folder = {
	kind: 'folder',
	id: 'folder:b',
	name: 'folder-b',
	status: 'loaded',
	children: [],
};
const FILE_A: File = {
	kind: 'file',
	id: 'file:a',
	name: 'webview.css',
};
const FOLDER_A: Folder = {
	kind: 'folder',
	id: 'folder:a',
	name: 'folder-a',
	status: 'loaded',
	children: [],
};

suite('Graph Navigator Root Data', () => {
	test('Project Root의 식별자, 이름과 kind를 표시 데이터로 변환한다', () => {
		const roots = createGraphNavigatorRoots({
			roots: [{ id: 'root:project', nodeId: PROJECT.id }],
			rootNodes: { [PROJECT.id]: PROJECT },
		});

		assert.deepStrictEqual(roots, [{
			rootId: 'root:project',
			nodeId: PROJECT.id,
			name: 'crispy',
			kind: 'project',
		}]);
		assert.strictEqual(
			Object.prototype.hasOwnProperty.call(roots[0], 'relativePath'),
			false,
		);
	});

	test('Folder Root의 context.relativePath를 변형 없이 전달한다', () => {
		const roots = createGraphNavigatorRoots({
			roots: [{
				id: 'root:folder-b',
				nodeId: FOLDER_B.id,
				context: { relativePath: 'crispy/src/' },
			}],
			rootNodes: { [FOLDER_B.id]: FOLDER_B },
		});

		assert.deepStrictEqual(roots, [{
			rootId: 'root:folder-b',
			nodeId: FOLDER_B.id,
			name: 'folder-b',
			kind: 'folder',
			relativePath: 'crispy/src/',
		}]);
	});

	test('File Root의 실제 이름과 file kind를 전달한다', () => {
		const roots = createGraphNavigatorRoots({
			roots: [{
				id: 'root:file-a',
				nodeId: FILE_A.id,
				context: { relativePath: 'crispy/src/webview/' },
			}],
			rootNodes: { [FILE_A.id]: FILE_A },
		});

		assert.deepStrictEqual(roots, [{
			rootId: 'root:file-a',
			nodeId: FILE_A.id,
			name: 'webview.css',
			kind: 'file',
			relativePath: 'crispy/src/webview/',
		}]);
	});

	test('Project, Folder B, File A, Folder A의 Graph Root 순서를 그대로 유지한다', () => {
		const roots = createGraphNavigatorRoots(createGraphFixture());

		assert.deepStrictEqual(
			roots.map((root) => root.rootId),
			['root:project', 'root:folder-b', 'root:file-a', 'root:folder-a'],
		);
	});

	test('없는 Root Node 참조만 제외하고 앞뒤의 정상 Root를 유지한다', () => {
		const graph: Graph = {
			roots: [
				{ id: 'root:project', nodeId: PROJECT.id },
				{ id: 'root:missing', nodeId: 'node:missing' },
				{ id: 'root:file-a', nodeId: FILE_A.id },
			],
			rootNodes: {
				[PROJECT.id]: PROJECT,
				[FILE_A.id]: FILE_A,
			},
		};

		assert.deepStrictEqual(
			createGraphNavigatorRoots(graph).map((root) => root.rootId),
			['root:project', 'root:file-a'],
		);
	});

	test('빈 context.relativePath와 중복 Root 항목을 임의로 변경하거나 제거하지 않는다', () => {
		const duplicateRoot = {
			id: 'root:folder-a',
			nodeId: FOLDER_A.id,
			context: { relativePath: '' },
		};
		const graph: Graph = {
			roots: [duplicateRoot, duplicateRoot],
			rootNodes: { [FOLDER_A.id]: FOLDER_A },
		};

		assert.deepStrictEqual(createGraphNavigatorRoots(graph), [
			{
				rootId: 'root:folder-a',
				nodeId: FOLDER_A.id,
				name: 'folder-a',
				kind: 'folder',
				relativePath: '',
			},
			{
				rootId: 'root:folder-a',
				nodeId: FOLDER_A.id,
				name: 'folder-a',
				kind: 'folder',
				relativePath: '',
			},
		]);
	});

	test('동일 Source Detached Root가 여러 개일 때만 보존된 ordinal을 표시 데이터에 넣는다', () => {
		const firstRootId = createDetachedRootId(FOLDER_A.id, 1);
		const thirdRootId = createDetachedRootId(FOLDER_A.id, 3);
		const singleRootId = createDetachedRootId(FOLDER_B.id, 1);
		const roots = createGraphNavigatorRoots({
			roots: [
				{ id: firstRootId, nodeId: FOLDER_A.id },
				{ id: thirdRootId, nodeId: FOLDER_A.id },
				{ id: singleRootId, nodeId: FOLDER_B.id },
			],
			rootNodes: {
				[FOLDER_A.id]: FOLDER_A,
				[FOLDER_B.id]: FOLDER_B,
			},
		});

		assert.deepStrictEqual(roots, [
			{
				rootId: firstRootId,
				nodeId: FOLDER_A.id,
				name: FOLDER_A.name,
				kind: 'folder',
				detachedOrdinal: 1,
			},
			{
				rootId: thirdRootId,
				nodeId: FOLDER_A.id,
				name: FOLDER_A.name,
				kind: 'folder',
				detachedOrdinal: 3,
			},
			{
				rootId: singleRootId,
				nodeId: FOLDER_B.id,
				name: FOLDER_B.name,
				kind: 'folder',
			},
		]);
	});

	test('변환 과정에서 Graph Root, Root Node와 입력 Container를 변경하지 않는다', () => {
		const graph = createGraphFixture();
		const graphBefore = JSON.parse(JSON.stringify(graph)) as Graph;
		const rootsReference = graph.roots;
		const rootNodesReference = graph.rootNodes;
		const firstRootReference = graph.roots[0];
		const projectReference = graph.rootNodes[PROJECT.id];

		createGraphNavigatorRoots(graph);

		assert.deepStrictEqual(graph, graphBefore);
		assert.strictEqual(graph.roots, rootsReference);
		assert.strictEqual(graph.rootNodes, rootNodesReference);
		assert.strictEqual(graph.roots[0], firstRootReference);
		assert.strictEqual(graph.rootNodes[PROJECT.id], projectReference);
	});
});

function createGraphFixture(): Graph {
	return {
		roots: [
			{ id: 'root:project', nodeId: PROJECT.id },
			{
				id: 'root:folder-b',
				nodeId: FOLDER_B.id,
				context: { relativePath: 'crispy/packages/' },
			},
			{
				id: 'root:file-a',
				nodeId: FILE_A.id,
				context: { relativePath: 'crispy/src/webview/' },
			},
			{
				id: 'root:folder-a',
				nodeId: FOLDER_A.id,
				context: { relativePath: 'crispy/src/' },
			},
		],
		rootNodes: {
			[PROJECT.id]: PROJECT,
			[FOLDER_B.id]: FOLDER_B,
			[FILE_A.id]: FILE_A,
			[FOLDER_A.id]: FOLDER_A,
		},
	};
}
