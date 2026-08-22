import * as assert from 'assert';
import type {
	GraphLayout,
	GraphLayoutEdge,
	GraphLayoutNode,
} from '../../webview/graph/graphLayout';
import {
	classifyGraphLayoutNodeArrangement,
	rebaseArrangedSubtree,
	rebaseNodePositions,
	rebaseReattachedSubtree,
	translateDetachedSubtree,
} from '../../webview/graph/graphLayoutTransition';

suite('Graph Layout Transition', () => {
	test('Parent와 다른 수동 Offset을 가진 직접 이동 Node만 unarranged로 분류한다', () => {
		const layout = createSubtreeLayout({
			root: { x: 300, y: 200 },
			childA: { x: 602, y: 180 },
			childB: { x: 602, y: 240 },
			grandchild: { x: 904, y: 240 },
			unrelated: { x: 48, y: 700 },
		});
		const positions = {
			root: { x: 400, y: 250 },
			'child-a': { x: 702, y: 230 },
			'child-b': { x: 727, y: 300 },
			grandchild: { x: 1_029, y: 300 },
		};
		const arrangement = classifyGraphLayoutNodeArrangement(layout, positions);

		assert.deepStrictEqual(
			[...arrangement.unarrangedNodeIds].sort(),
			['child-b', 'root'],
		);
		assert.deepStrictEqual(
			[...arrangement.arrangedNodeIds].sort(),
			['child-a', 'grandchild', 'unrelated'],
		);
	});

	test('Reflow는 수동 Node만 이전 기본점 Offset을 유지하고 나머지 저장값을 보존한다', () => {
		const previousLayout = createLayout([
			createNode('root', 100, 100),
			createNode('moved', 100, 200),
			createNode('automatic', 100, 300),
		]);
		const nextLayout = createLayout([
			createNode('root', 100, 100),
			createNode('moved', 160, 350),
			createNode('automatic', 100, 450),
		]);

		assert.deepStrictEqual(rebaseNodePositions(
			previousLayout,
			nextLayout,
			{
				moved: { x: 140, y: 180 },
				'missing-from-layout': { x: 900, y: 700 },
			},
		), {
			moved: { x: 200, y: 330 },
			'missing-from-layout': { x: 900, y: 700 },
		});
	});

	test('Pagination 확장·축소 Reflow에서 수동 X/Y Offset을 유지하며 같이 밀고 당긴다', () => {
		const collapsedLayout = createLayout([
			createNode('file-group', 350, 100),
			createNode('moved-sibling', 350, 240),
		]);
		const expandedLayout = createLayout([
			createNode('file-group', 350, 100),
			createNode('moved-sibling', 350, 540),
		]);
		const expandedPositions = rebaseNodePositions(
			collapsedLayout,
			expandedLayout,
			{ 'moved-sibling': { x: 390, y: 220 } },
		);

		assert.deepStrictEqual(expandedPositions, {
			'moved-sibling': { x: 390, y: 520 },
		});
		assert.deepStrictEqual(rebaseNodePositions(
			expandedLayout,
			collapsedLayout,
			expandedPositions,
		), {
			'moved-sibling': { x: 390, y: 220 },
		});
	});

	test('접힌 Parent를 이동한 뒤 열면 새 Descendant가 Parent Offset을 상속한다', () => {
		const collapsedLayout = createLayout([
			createNode('root', 100, 100),
		]);
		const expandedLayout = createLayout([
			createNode('root', 100, 100),
			createNode('child', 400, 120),
			createNode('grandchild', 700, 160),
		], [
			createEdge('root', 'child'),
			createEdge('child', 'grandchild'),
		]);

		assert.deepStrictEqual(rebaseNodePositions(
			collapsedLayout,
			expandedLayout,
			{ root: { x: 160, y: 130 } },
			{ inheritAncestorOffsets: true },
		), {
			root: { x: 160, y: 130 },
			child: { x: 460, y: 150 },
			grandchild: { x: 760, y: 190 },
		});
	});

	test('Detach는 Edge subtree 전체 실제 위치에 같은 Delta를 적용한다', () => {
		const previousLayout = createSubtreeLayout({
			root: { x: 300, y: 200 },
			childA: { x: 602, y: 180 },
			childB: { x: 602, y: 240 },
			grandchild: { x: 904, y: 240 },
			unrelated: { x: 48, y: 700 },
		});
		const detachedLayout = createSubtreeLayout({
			root: { x: 48, y: 100 },
			childA: { x: 350, y: 80 },
			childB: { x: 350, y: 140 },
			grandchild: { x: 652, y: 140 },
			unrelated: { x: 48, y: 700 },
		});
		const positions = translateDetachedSubtree(
			previousLayout,
			detachedLayout,
			{
				'child-b': { x: 642, y: 220 },
				unrelated: { x: 1_000, y: 900 },
			},
			'root',
			{ x: 900, y: 500 },
		);

		assert.deepStrictEqual(positions, {
			root: { x: 900, y: 500 },
			'child-a': { x: 1_202, y: 480 },
			'child-b': { x: 1_242, y: 520 },
			grandchild: { x: 1_504, y: 540 },
			unrelated: { x: 1_000, y: 900 },
		});
		assert.deepStrictEqual(
			subtract(positions['child-b'], positions.root),
			{ x: 342, y: 20 },
		);
	});

	test('Detach 대상이 Grouped File Row처럼 이전 Layout Node가 아니면 새 Root만 배치한다', () => {
		const previousLayout = createLayout([createNode('file-group', 350, 100)]);
		const nextLayout = createLayout([createNode('file', 48, 300)]);

		assert.deepStrictEqual(translateDetachedSubtree(
			previousLayout,
			nextLayout,
			{ unrelated: { x: 80, y: 90 } },
			'file',
			{ x: 700, y: 400 },
		), {
			file: { x: 700, y: 400 },
			unrelated: { x: 80, y: 90 },
		});
	});

	test('Detach 시 새 Backlink는 이동된 Parent Offset을 상속한 정렬 위치를 사용한다', () => {
		const previousLayout = createLayout([
			createNode('parent', 100, 100),
			createNode('child', 400, 100),
		], [createEdge('parent', 'child')]);
		const nextLayout = createLayout([
			createNode('parent', 100, 100),
			createNode('backlink', 400, 160),
			createNode('child', 48, 600),
		], [createEdge('parent', 'backlink')]);
		const positions = {
			parent: { x: 600, y: 400 },
			child: { x: 900, y: 400 },
		};
		const rebasedPositions = rebaseNodePositions(
			previousLayout,
			nextLayout,
			positions,
			{ inheritAncestorOffsets: true },
		);

		assert.deepStrictEqual(translateDetachedSubtree(
			previousLayout,
			nextLayout,
			positions,
			'child',
			{ x: 1_200, y: 800 },
			{ baseNodePositions: rebasedPositions },
		), {
			parent: { x: 600, y: 400 },
			backlink: { x: 900, y: 460 },
			child: { x: 1_200, y: 800 },
		});
	});

	test('Reattach는 Group Translation과 Root override를 제거하고 Child 수동 Offset만 보존한다', () => {
		const detachedLayout = createSubtreeLayout({
			root: { x: 48, y: 100 },
			childA: { x: 350, y: 80 },
			childB: { x: 350, y: 140 },
			grandchild: { x: 652, y: 140 },
			unrelated: { x: 48, y: 700 },
		});
		const reattachedLayout = createSubtreeLayout({
			root: { x: 350, y: 200 },
			childA: { x: 652, y: 180 },
			childB: { x: 652, y: 240 },
			grandchild: { x: 954, y: 240 },
			unrelated: { x: 48, y: 700 },
		});
		const positions = rebaseReattachedSubtree(
			detachedLayout,
			reattachedLayout,
			{
				root: { x: 900, y: 500 },
				'child-a': { x: 1_202, y: 480 },
				'child-b': { x: 1_242, y: 520 },
				grandchild: { x: 1_504, y: 540 },
				unrelated: { x: 1_000, y: 900 },
			},
			'root',
		);

		assert.strictEqual(positions.root, undefined);
		assert.deepStrictEqual(positions, {
			'child-b': { x: 692, y: 220 },
			unrelated: { x: 1_000, y: 900 },
		});
	});

	test('재정렬은 Node 독립 Offset만 제거하고 이동된 Parent Offset을 유지한다', () => {
		const previousLayout = createLayout([
			createNode('parent', 100, 100),
			createNode('file-group', 400, 100),
		], [createEdge('parent', 'file-group')]);
		const nextLayout = createLayout([
			createNode('parent', 100, 100),
			createNode('file-group', 400, 220),
		], [createEdge('parent', 'file-group')]);
		const positions = {
			parent: { x: 600, y: 400 },
			'file-group': { x: 900, y: 800 },
		};
		const rebasedPositions = rebaseNodePositions(
			previousLayout,
			nextLayout,
			positions,
		);

		assert.deepStrictEqual(rebaseArrangedSubtree(
			previousLayout,
			nextLayout,
			positions,
			rebasedPositions,
			'file-group',
		), {
			parent: { x: 600, y: 400 },
			'file-group': { x: 900, y: 520 },
		});
	});
});

interface SubtreePositions {
	readonly root: Readonly<{ x: number; y: number }>;
	readonly childA: Readonly<{ x: number; y: number }>;
	readonly childB: Readonly<{ x: number; y: number }>;
	readonly grandchild: Readonly<{ x: number; y: number }>;
	readonly unrelated: Readonly<{ x: number; y: number }>;
}

function createSubtreeLayout(positions: SubtreePositions): GraphLayout {
	return createLayout([
		createNode('root', positions.root.x, positions.root.y),
		createNode('child-a', positions.childA.x, positions.childA.y),
		createNode('child-b', positions.childB.x, positions.childB.y),
		createNode('grandchild', positions.grandchild.x, positions.grandchild.y),
		createNode('unrelated', positions.unrelated.x, positions.unrelated.y),
	], [
		createEdge('root', 'child-a'),
		createEdge('root', 'child-b'),
		createEdge('child-b', 'grandchild'),
	]);
}

function createLayout(
	nodes: readonly GraphLayoutNode[],
	edges: readonly GraphLayoutEdge[] = [],
): GraphLayout {
	return {
		nodes,
		edges,
		rootContexts: {},
		rootNodeIds: new Set(['root']),
		arrangedNodeIds: new Set(nodes.map((node) => node.id)),
		unarrangedNodeIds: new Set(),
	};
}

function createNode(id: string, x: number, y: number): GraphLayoutNode {
	return {
		kind: 'folder',
		id,
		name: id,
		status: 'loaded',
		depth: 0,
		position: { x, y },
		width: 240,
		height: 42,
	};
}

function createEdge(sourceId: string, targetId: string): GraphLayoutEdge {
	return {
		id: `${sourceId}->${targetId}`,
		sourceId,
		targetId,
	};
}

function subtract(
	left: Readonly<{ x: number; y: number }> | undefined,
	right: Readonly<{ x: number; y: number }> | undefined,
) {
	assert.ok(left);
	assert.ok(right);

	return { x: left.x - right.x, y: left.y - right.y };
}
