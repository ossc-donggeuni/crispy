import * as assert from 'assert';
import type {
	GraphFileGroupNode,
	GraphFolderBacklinkNode,
	GraphLayout,
	GraphLayoutEdge,
	GraphLayoutNode,
	GraphProjectNode,
} from '../../webview/graph/graphLayout';
import { getGraphNodeEffectRegionBounds } from '../../webview/graph/graphNodeEffectGeometry';

suite('Graph Node Effect Geometry', () => {
	test('Folder Backlink의 runtime 너비는 포함하고 세로 범위는 제외한다', () => {
		const root = createProjectNode();
		const backlink: GraphFolderBacklinkNode = {
			kind: 'folder-backlink',
			id: 'folder-backlink:src',
			name: 'src',
			depth: 1,
			position: { x: 400, y: 800 },
			width: 240,
			height: 42,
			targetRootId: 'detached-root:src',
			targetRootIds: ['detached-root:src'],
			targetNodeId: 'folder:src',
		};
		const layout = createLayout(root, backlink);
		const positions = new Map([
			[backlink.id, { x: 520, y: 900 }],
		]);

		assert.deepStrictEqual(
			getGraphNodeEffectRegionBounds(layout, positions, root.id),
			{
				x: 94,
				y: 194,
				width: 672,
				height: 54,
			},
		);
	});

	test('Backlink-only File Group의 왼쪽 너비는 포함하고 세로 범위는 제외한다', () => {
		const root = createProjectNode();
		const backlink: GraphFileGroupNode = {
			kind: 'file-group',
			id: 'file-backlink-group:index',
			name: 'index.ts',
			depth: 1,
			position: { x: -300, y: -500 },
			width: 240,
			height: 42,
			presentation: 'standalone',
			children: [{
				kind: 'file',
				id: 'file:index',
				name: 'index.ts',
				presentation: 'backlink',
				targetRootId: 'detached-root:index',
				targetRootIds: ['detached-root:index'],
			}],
		};
		const layout = createLayout(root, backlink);

		assert.deepStrictEqual(
			getGraphNodeEffectRegionBounds(layout, new Map(), root.id),
			{
				x: -306,
				y: 194,
				width: 652,
				height: 54,
			},
		);
	});
});

function createProjectNode(): GraphProjectNode {
	return {
		kind: 'project',
		id: 'project:effect-backlink-width',
		name: 'effect-backlink-width',
		status: 'loaded',
		depth: 0,
		position: { x: 100, y: 200 },
		width: 240,
		height: 42,
	};
}

function createLayout(
	root: GraphProjectNode,
	backlink: GraphLayoutNode,
): GraphLayout {
	const edge: GraphLayoutEdge = {
		id: `${root.id}->${backlink.id}`,
		sourceId: root.id,
		targetId: backlink.id,
	};

	return {
		nodes: [root, backlink],
		edges: [edge],
		rootContexts: {},
		rootNodeIds: new Set([root.id]),
		arrangedNodeIds: new Set([root.id, backlink.id]),
		unarrangedNodeIds: new Set(),
	};
}
