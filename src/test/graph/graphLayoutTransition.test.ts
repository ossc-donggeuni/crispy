import * as assert from 'assert';
import type {
	GraphLayout,
	GraphLayoutEdge,
	GraphLayoutNode,
} from '../../webview/graph/graphLayout';
import {
	classifyGraphLayoutNodeArrangement,
	rebaseNodePositions,
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
			{ unarrangedNodeIds: new Set(['moved']) },
		), {
			moved: { x: 140, y: 180 },
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
			{ unarrangedNodeIds: new Set(['moved-sibling']) },
		);

		assert.deepStrictEqual(expandedPositions, {
			'moved-sibling': { x: 390, y: 220 },
		});
		assert.deepStrictEqual(rebaseNodePositions(
			expandedLayout,
			collapsedLayout,
			expandedPositions,
			{ unarrangedNodeIds: new Set(['moved-sibling']) },
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
			{ unarrangedNodeIds: new Set(['root']) },
		), {
			root: { x: 160, y: 130 },
			child: { x: 460, y: 150 },
			grandchild: { x: 760, y: 190 },
		});
	});

	test('Layout에서 접힌 저장 Descendant는 현재 Parent의 이동량을 따른다', () => {
		const previousLayout = createLayout([
			createNode('root', 100, 100),
			createNode('parent', 400, 100),
		], [createEdge('root', 'parent')]);
		const nextLayout = createLayout([
			createNode('root', 160, 140),
			createNode('parent', 560, 180),
		], [createEdge('root', 'parent')]);

		assert.deepStrictEqual(rebaseNodePositions(
			previousLayout,
			nextLayout,
			{
				root: { x: 120, y: 130 },
				parent: { x: 420, y: 130 },
				'collapsed-child': { x: 720, y: 360 },
				'collapsed-grandchild': { x: 1_020, y: 390 },
			},
			{
				unarrangedNodeIds: new Set(['root']),
				logicalParentByChild: new Map([
					['parent', 'root'],
					['collapsed-child', 'parent'],
					['collapsed-grandchild', 'collapsed-child'],
				]),
			},
		), {
			root: { x: 120, y: 130 },
			parent: { x: 520, y: 170 },
			'collapsed-child': { x: 820, y: 400 },
			'collapsed-grandchild': { x: 1_120, y: 430 },
		});
	});

	test('닫힐 때 arranged descendant의 직계 Parent local을 저장하고 다시 열 때 복원한다', () => {
		const expandedLayout = createLayout([
			createNode('root', 100, 100),
			createNode('parent', 400, 100),
			createNode('child', 700, 120),
			createNode('grandchild', 1_000, 140),
		], [
			createEdge('root', 'parent'),
			createEdge('parent', 'child'),
			createEdge('child', 'grandchild'),
		]);
		const collapsedLayout = createLayout([
			createNode('root', 100, 100),
			createNode('parent', 400, 100),
		], [createEdge('root', 'parent')]);
		const logicalParentByChild = new Map([
			['parent', 'root'],
			['child', 'parent'],
			['grandchild', 'child'],
		]);
		const movedSubtreePositions = {
			root: { x: 600, y: 400 },
			parent: { x: 900, y: 400 },
			child: { x: 1_200, y: 420 },
			grandchild: { x: 1_500, y: 440 },
		};
		const collapsedPositions = rebaseNodePositions(
			expandedLayout,
			collapsedLayout,
			movedSubtreePositions,
			{
				captureCollapsedNodePositions: true,
				logicalParentByChild,
				unarrangedNodeIds: new Set(['root']),
			},
		);

		assert.deepStrictEqual(collapsedPositions, movedSubtreePositions);
		assert.deepStrictEqual(rebaseNodePositions(
			collapsedLayout,
			expandedLayout,
			collapsedPositions,
			{
				logicalParentByChild,
				unarrangedNodeIds: new Set(['root']),
			},
		), movedSubtreePositions);
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
			{ unarrangedNodeIds: new Set(['parent', 'child']) },
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

	test('재정렬은 Parent Layout local을 사용하고 내부 비정렬 Node local은 유지한다', () => {
		const previousLayout = createLayout([
			createNode('root', 100, 100),
			createNode('target', 400, 200),
			createNode('child', 700, 220),
			createNode('grandchild', 1_000, 230),
		], [
			createEdge('root', 'target'),
			createEdge('target', 'child'),
			createEdge('child', 'grandchild'),
		]);
		const nextLayout = createLayout([
			createNode('root', 100, 100),
			createNode('target', 400, 220),
			createNode('child', 700, 260),
			createNode('grandchild', 1_000, 280),
		], [
			createEdge('root', 'target'),
			createEdge('target', 'child'),
			createEdge('child', 'grandchild'),
		]);
		const positions = {
			root: { x: 600, y: 400 },
			target: { x: 900, y: 800 },
			child: { x: 1_200, y: 820 },
			grandchild: { x: 1_500, y: 1_000 },
		};

		assert.deepStrictEqual(rebaseNodePositions(
			previousLayout,
			nextLayout,
			positions,
			{
				unarrangedNodeIds: new Set(['root', 'grandchild']),
			},
		), {
			root: { x: 600, y: 400 },
			target: { x: 900, y: 520 },
			child: { x: 1_200, y: 560 },
			grandchild: { x: 1_500, y: 740 },
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
