import * as assert from 'assert';
import type {
	GraphLayout,
	GraphLayoutEdge,
	GraphLayoutNode,
} from '../../webview/graph/graphLayout';
import {
	calculateGraphBounds,
	createMinimapGraphGeometry,
	createMinimapProjection,
} from '../../webview/graph/graphNavigatorMinimap';

suite('Graph Navigator Minimap Geometry', () => {
	test('단일 Node 위치와 width/height를 전체 Bounds에 포함한다', () => {
		assert.deepStrictEqual(
			calculateGraphBounds([createNode('node:a', 20, 30, 120, 48)]),
			{ x: 20, y: 30, width: 120, height: 48 },
		);
	});

	test('음수 좌표와 멀리 떨어진 Multi-Root Node를 하나의 Bounds로 계산한다', () => {
		const nodes = [
			createNode('root:left', -420, -160, 200, 42),
			createNode('root:right', 1_200, 740, 180, 60),
		];

		assert.deepStrictEqual(calculateGraphBounds(nodes), {
			x: -420,
			y: -160,
			width: 1_800,
			height: 960,
		});
	});

	test('저장된 nodePositions를 Layout 기본 위치보다 우선한다', () => {
		const nodes = [
			createNode('node:moved', 10, 20, 100, 40),
			createNode('node:fixed', 300, 200, 100, 40),
		];

		assert.deepStrictEqual(calculateGraphBounds(nodes, {
			'node:moved': { x: -200, y: -100 },
		}), {
			x: -200,
			y: -100,
			width: 600,
			height: 340,
		});
	});

	test('Empty Layout과 유효하지 않은 Node는 Bounds 없이 안전하게 처리한다', () => {
		assert.strictEqual(calculateGraphBounds([]), undefined);
		assert.strictEqual(calculateGraphBounds([
			createNode('node:invalid', Number.NaN, 0, 100, 40),
		]), undefined);
	});

	test('0 또는 0에 가까운 Bounds도 유한한 Projection과 중앙 좌표를 만든다', () => {
		const projection = createMinimapProjection(
			{ x: 50, y: -30, width: 0, height: 0 },
			{ width: 160, height: 96 },
			8,
		);

		assert.ok(projection);
		assert.strictEqual(projection.scale, 1);
		assert.deepStrictEqual(projection.worldToMinimap({ x: 50, y: -30 }), {
			x: 80,
			y: 48,
		});
		assert.ok(Number.isFinite(projection.minimapToWorld({ x: 80, y: 48 }).x));

		const nearZeroProjection = createMinimapProjection(
			{
				x: 0,
				y: 0,
				width: Number.MIN_VALUE,
				height: Number.MIN_VALUE,
			},
			{ width: 160, height: 96 },
			8,
		);

		assert.ok(nearZeroProjection);
		assert.ok(Number.isFinite(nearZeroProjection.scale));
		assert.ok(Number.isFinite(
			nearZeroProjection.worldToMinimap({ x: 0, y: 0 }).x,
		));
	});

	test('단일 scale로 aspect ratio를 유지하고 Padding 안에서 중앙 정렬한다', () => {
		const projection = createMinimapProjection(
			{ x: 0, y: 0, width: 200, height: 100 },
			{ width: 120, height: 100 },
			10,
		);

		assert.ok(projection);
		assert.strictEqual(projection.scale, 0.5);
		assert.deepStrictEqual(projection.worldToMinimap({ x: 0, y: 0 }), {
			x: 10,
			y: 25,
		});
		assert.deepStrictEqual(projection.worldToMinimap({ x: 200, y: 100 }), {
			x: 110,
			y: 75,
		});
	});

	test('World → Minimap → World 변환을 음수 좌표에서도 왕복한다', () => {
		const projection = createMinimapProjection(
			{ x: -300, y: -120, width: 600, height: 240 },
			{ width: 160, height: 96 },
		);
		const worldPoint = { x: -75.5, y: 42.25 };

		assert.ok(projection);
		assertPointAlmostEqual(
			projection.minimapToWorld(projection.worldToMinimap(worldPoint)),
			worldPoint,
		);
	});

	test('저장 위치 기반 Node와 Edge를 투영하고 잘못된 Edge는 제외한다', () => {
		const source = createNode('node:source', 0, 0, 100, 40);
		const target = createNode('node:target', 300, 100, 100, 40);
		const layout = createLayout([source, target], [
			{ id: 'edge:valid', sourceId: source.id, targetId: target.id },
			{ id: 'edge:invalid', sourceId: source.id, targetId: 'node:missing' },
		]);
		const geometry = createMinimapGraphGeometry(
			layout,
			{ [source.id]: { x: -100, y: 50 } },
			{ width: 160, height: 96 },
		);

		assert.ok(geometry);
		assert.strictEqual(geometry.nodes.length, 2);
		assert.deepStrictEqual(geometry.edges.map((edge) => edge.id), ['edge:valid']);
		const projectedSourceRightCenter = geometry.projection.worldToMinimap({
			x: 0,
			y: 70,
		});

		assertPointAlmostEqual(
			geometry.edges[0]?.source ?? assert.fail('Edge geometry가 있어야 한다.'),
			projectedSourceRightCenter,
		);
	});

	test('렌더 영역이나 Padding이 유효하지 않으면 Projection을 만들지 않는다', () => {
		const bounds = { x: 0, y: 0, width: 100, height: 50 };

		assert.strictEqual(
			createMinimapProjection(bounds, { width: 0, height: 96 }),
			undefined,
		);
		assert.strictEqual(
			createMinimapProjection(bounds, { width: 16, height: 16 }, 8),
			undefined,
		);
	});
});

function createNode(
	id: string,
	x: number,
	y: number,
	width: number,
	height: number,
): GraphLayoutNode {
	return {
		kind: 'folder',
		id,
		name: id,
		status: 'loaded',
		depth: 0,
		position: { x, y },
		width,
		height,
	};
}

function createLayout(
	nodes: readonly GraphLayoutNode[],
	edges: readonly GraphLayoutEdge[] = [],
): GraphLayout {
	return {
		nodes,
		edges,
		rootContexts: {},
		rootNodeIds: new Set(),
	};
}

function assertPointAlmostEqual(
	actual: { readonly x: number; readonly y: number },
	expected: { readonly x: number; readonly y: number },
): void {
	assert.ok(Math.abs(actual.x - expected.x) < 1e-10);
	assert.ok(Math.abs(actual.y - expected.y) < 1e-10);
}
