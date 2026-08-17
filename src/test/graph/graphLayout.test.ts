import * as assert from 'assert';
import {
	createFileGroupId,
	createGraphLayout,
	GRAPH_FILE_GROUP_MORE_HEIGHT,
	GRAPH_FILE_GROUP_NODE_WIDTH,
	GRAPH_FILE_GROUP_PADDING,
	GRAPH_FILE_GROUP_ROW_HEIGHT,
	GRAPH_FOLDER_NODE_HEIGHT,
	GRAPH_FOLDER_NODE_WIDTH,
	GRAPH_MAX_VISIBLE_FILES,
	type GraphFileGroupNode,
} from '../../webview/graph/graphLayout';
import { GRAPH_MOCK_PROJECT } from '../../webview/graph/graphMockData';
import { isFile, isFolder } from '../../webview/graph/graphModel';

suite('Graph Model / Layout', () => {
	test('실제 Graph Mock이 중첩 Folder와 Folder별 여러 File을 포함한다', () => {
		const app = GRAPH_MOCK_PROJECT.children.find(
			(entry) => isFolder(entry) && entry.id === 'folder:app',
		);

		assert.ok(app && isFolder(app));
		const appSrc = app.children.find(
			(entry) => isFolder(entry) && entry.id === 'folder:app/src',
		);
		const appDocs = app.children.find(
			(entry) => isFolder(entry) && entry.id === 'folder:app/docs',
		);
		assert.ok(appSrc && isFolder(appSrc));
		assert.ok(appDocs && isFolder(appDocs));
		assert.ok(app.children.filter(isFile).length > 1);
		assert.ok(appSrc.children.filter(isFile).length > GRAPH_MAX_VISIBLE_FILES);
		assert.ok(appSrc.children.some(isFolder));
	});

	test('각 Container의 직접 File을 하나의 안정적인 File Group으로 만든다', () => {
		const layout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const appSrcFiles = getFileGroup(layout.nodes, 'folder:app/src');
		const expectedFiles = [
			'graphView.ts',
			'graphCamera.ts',
			'graphState.ts',
			'graphLayout.ts',
			'graphRenderer.ts',
			'graphNodeDrag.ts',
			'index.ts',
		];

		assert.strictEqual(appSrcFiles.id, createFileGroupId('folder:app/src'));
		assert.deepStrictEqual(
			appSrcFiles.files.map((file) => file.name),
			expectedFiles,
		);
		assert.deepStrictEqual(
			appSrcFiles.visibleFiles.map((file) => file.name),
			expectedFiles.slice(0, GRAPH_MAX_VISIBLE_FILES),
		);
		assert.strictEqual(appSrcFiles.hiddenFileCount, 2);
	});

	test('Project/Folder에서 직접 Child Folder와 File Group으로만 Edge를 만든다', () => {
		const layout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const rootTargets = layout.edges
			.filter((edge) => edge.sourceId === GRAPH_MOCK_PROJECT.id)
			.map((edge) => edge.targetId);
		const appTargets = layout.edges
			.filter((edge) => edge.sourceId === 'folder:app')
			.map((edge) => edge.targetId);

		assert.deepStrictEqual(rootTargets, [
			'folder:app',
			'folder:src',
			createFileGroupId(GRAPH_MOCK_PROJECT.id),
		]);
		assert.deepStrictEqual(appTargets, [
			'folder:app/src',
			'folder:app/docs',
			createFileGroupId('folder:app'),
		]);
		assert.strictEqual(
			layout.edges.some((edge) => edge.targetId.startsWith('file:')),
			false,
		);
	});

	test('동일 입력은 동일 Layout이며 같은 Depth는 같은 X Column에 놓는다', () => {
		const first = createGraphLayout(GRAPH_MOCK_PROJECT);
		const second = createGraphLayout(GRAPH_MOCK_PROJECT);

		assert.deepStrictEqual(second, first);
		const xByDepth = new Map<number, number>();

		for (const node of first.nodes) {
			const columnX = xByDepth.get(node.depth);

			if (columnX === undefined) {
				xByDepth.set(node.depth, node.position.x);
			} else {
				assert.strictEqual(node.position.x, columnX);
			}
		}

		for (const edge of first.edges) {
			const source = first.nodes.find((node) => node.id === edge.sourceId);
			const target = first.nodes.find((node) => node.id === edge.targetId);

			assert.ok(source && target);
			assert.ok(target.position.x > source.position.x);
		}
	});

	test('Folder와 File Group을 동일한 폭과 조밀한 Depth 간격으로 배치한다', () => {
		const layout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const root = layout.nodes.find((node) => node.kind === 'project');
		const folder = layout.nodes.find((node) => node.kind === 'folder');
		const fileGroup = layout.nodes.find((node) => node.kind === 'file-group');

		assert.ok(root && folder && fileGroup);
		assert.strictEqual(GRAPH_FOLDER_NODE_WIDTH, 200);
		assert.strictEqual(GRAPH_FOLDER_NODE_HEIGHT, 42);
		assert.strictEqual(GRAPH_FILE_GROUP_NODE_WIDTH, 200);
		assert.strictEqual(root.width, folder.width);
		assert.strictEqual(folder.width, fileGroup.width);
		assert.strictEqual(folder.position.x - root.position.x, 262);
	});

	test('30px File Row와 More 높이를 File Group Layout 높이에 반영한다', () => {
		const layout = createGraphLayout(GRAPH_MOCK_PROJECT);
		const fileGroup = getFileGroup(layout.nodes, 'folder:app/src');
		const borderSize = 4;
		const expectedHeight = borderSize
			+ GRAPH_FILE_GROUP_PADDING * 2
			+ GRAPH_MAX_VISIBLE_FILES * GRAPH_FILE_GROUP_ROW_HEIGHT
			+ GRAPH_FILE_GROUP_MORE_HEIGHT;

		assert.strictEqual(GRAPH_FILE_GROUP_ROW_HEIGHT, 30);
		assert.strictEqual(fileGroup.hiddenFileCount, 2);
		assert.strictEqual(fileGroup.height, expectedHeight);
		assert.strictEqual(fileGroup.height, 198);
	});
});

function getFileGroup(
	nodes: ReturnType<typeof createGraphLayout>['nodes'],
	parentId: string,
): GraphFileGroupNode {
	const node = nodes.find(
		(candidate): candidate is GraphFileGroupNode =>
			candidate.kind === 'file-group' && candidate.parentId === parentId,
	);

	assert.ok(node, `${parentId}의 File Group이 있어야 한다.`);
	return node;
}
