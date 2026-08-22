import * as assert from 'assert';
import type {
	GraphLayout,
	GraphLayoutEdge,
	GraphLayoutNode,
} from '../../webview/graph/graphLayout';
import {
	calculateCameraWorldBounds,
	calculateGraphBounds,
	calculateMinimapWorldDelta,
	clientToMinimapPoint,
	createMinimapGraphGeometry,
	createMinimapProjection,
	createMinimapViewportGeometry,
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

	test('Client 좌표를 CSS 크기와 SVG 논리 크기 차이를 반영해 Minimap 좌표로 변환한다', () => {
		assert.deepStrictEqual(clientToMinimapPoint(
			{ x: 260, y: 146 },
			{ left: 100, top: 50, width: 320, height: 192 },
			{ width: 160, height: 96 },
		), { x: 80, y: 48 });
		assert.deepStrictEqual(clientToMinimapPoint(
			{ x: 500, y: 260 },
			{ left: 100, top: 50, width: 320, height: 192 },
			{ width: 160, height: 96 },
		), { x: 200, y: 105 });
	});

	test('Client 좌표 변환은 0-size와 유효하지 않은 입력을 거부한다', () => {
		assert.strictEqual(clientToMinimapPoint(
			{ x: 10, y: 10 },
			{ left: 0, top: 0, width: 0, height: 96 },
			{ width: 160, height: 96 },
		), undefined);
		assert.strictEqual(clientToMinimapPoint(
			{ x: Number.NaN, y: 10 },
			{ left: 0, top: 0, width: 160, height: 96 },
			{ width: 160, height: 96 },
		), undefined);
	});

	test('Minimap Drag 이동량을 기존 역투영으로 fractional World 이동량에 변환한다', () => {
		const projection = createMinimapProjection(
			{ x: -200, y: 100, width: 1_000, height: 500 },
			{ width: 160, height: 96 },
			8,
		);

		assert.ok(projection);
		const start = { x: 40.5, y: 50.25 };
		const current = { x: 73.75, y: 31.5 };
		const expectedStart = projection.minimapToWorld(start);
		const expectedCurrent = projection.minimapToWorld(current);

		assertPointAlmostEqual(
			calculateMinimapWorldDelta(projection, start, current)
				?? assert.fail('World 이동량을 계산해야 한다.'),
			{
				x: expectedCurrent.x - expectedStart.x,
				y: expectedCurrent.y - expectedStart.y,
			},
		);
	});

	test('Minimap Drag World 이동량은 유효하지 않은 좌표를 안전하게 거부한다', () => {
		const projection = createMinimapProjection(
			{ x: 0, y: 0, width: 100, height: 50 },
			{ width: 160, height: 96 },
		);

		assert.ok(projection);
		assert.strictEqual(calculateMinimapWorldDelta(
			projection,
			{ x: 10, y: 10 },
			{ x: Number.POSITIVE_INFINITY, y: 20 },
		), undefined);
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

	test('Layout에서 숨김 처리된 Node와 Edge를 Minimap geometry에서 제외한다', () => {
		const hiddenNode = {
			...createNode('node:hidden', 0, 0, 100, 40),
			hidden: true as const,
		};
		const visibleNode = createNode('node:visible', 300, 100, 100, 40);
		const geometry = createMinimapGraphGeometry(
			createLayout([hiddenNode, visibleNode], [{
				id: 'edge:hidden',
				sourceId: hiddenNode.id,
				targetId: visibleNode.id,
				hidden: true,
			}]),
			{},
			{ width: 160, height: 96 },
		);

		assert.ok(geometry);
		assert.deepStrictEqual(geometry.nodes.map((node) => node.id), [
			visibleNode.id,
		]);
		assert.deepStrictEqual(geometry.edges, []);
		assert.deepStrictEqual(geometry.bounds, {
			x: visibleNode.position.x,
			y: visibleNode.position.y,
			width: visibleNode.width,
			height: visibleNode.height,
		});
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

	test('기본 Camera와 Pan Camera의 Viewport를 기존 API로 World Bounds화한다', () => {
		const viewportSize = { width: 800, height: 600 };

		assert.deepStrictEqual(calculateCameraWorldBounds(
			createCameraTransform({ x: 0, y: 0, scale: 1 }),
			viewportSize,
		), { x: 0, y: 0, width: 800, height: 600 });
		assert.deepStrictEqual(calculateCameraWorldBounds(
			createCameraTransform({ x: 100, y: -50, scale: 1 }),
			viewportSize,
		), { x: -100, y: 50, width: 800, height: 600 });
	});

	test('Zoom과 fractional scale을 Camera World Bounds 크기에 반영한다', () => {
		const viewportSize = { width: 800, height: 600 };
		const zoomIn = calculateCameraWorldBounds(
			createCameraTransform({ x: 0, y: 0, scale: 2 }),
			viewportSize,
		);
		const zoomOut = calculateCameraWorldBounds(
			createCameraTransform({ x: 0, y: 0, scale: 0.5 }),
			viewportSize,
		);
		const fractional = calculateCameraWorldBounds(
			createCameraTransform({ x: 25, y: 50, scale: 1.25 }),
			viewportSize,
		);

		assert.deepStrictEqual(zoomIn, { x: 0, y: 0, width: 400, height: 300 });
		assert.deepStrictEqual(zoomOut, { x: 0, y: 0, width: 1_600, height: 1_200 });
		assert.ok((zoomIn?.width ?? 0) < (zoomOut?.width ?? 0));
		assert.deepStrictEqual(fractional, {
			x: -20,
			y: -40,
			width: 640,
			height: 480,
		});
	});

	test('Camera 좌표 순서를 normalize하고 0-size 및 유효하지 않은 입력을 거부한다', () => {
		const invertedCamera = {
			viewportToWorld: (point: { x: number; y: number }) => ({
				x: 100 - point.x,
				y: 50 - point.y,
			}),
		};

		assert.deepStrictEqual(calculateCameraWorldBounds(
			invertedCamera,
			{ width: 80, height: 40 },
		), { x: 20, y: 10, width: 80, height: 40 });
		assert.strictEqual(calculateCameraWorldBounds(
			invertedCamera,
			{ width: 0, height: 40 },
		), undefined);
		assert.strictEqual(calculateCameraWorldBounds({
			viewportToWorld: () => ({ x: Number.NaN, y: 0 }),
		}, { width: 80, height: 40 }), undefined);
		assert.strictEqual(calculateCameraWorldBounds({
			viewportToWorld: () => {
				throw new Error('invalid camera');
			},
		}, { width: 80, height: 40 }), undefined);
	});

	test('Camera World Bounds를 기존 Projection의 Minimap Indicator로 변환한다', () => {
		const minimapSize = { width: 160, height: 96 };
		const projection = createMinimapProjection(
			{ x: 0, y: 0, width: 100, height: 100 },
			minimapSize,
			8,
		);

		assert.ok(projection);
		assert.deepStrictEqual(createMinimapViewportGeometry(
			{ x: 25, y: 25, width: 50, height: 50 },
			projection,
			minimapSize,
		), { x: 60, y: 28, width: 40, height: 40 });
	});

	test('Graph보다 큰 Camera Indicator와 Graph 밖 Camera를 SVG Bounds로 Clamp한다', () => {
		const minimapSize = { width: 160, height: 96 };
		const projection = createMinimapProjection(
			{ x: 0, y: 0, width: 100, height: 100 },
			minimapSize,
			8,
		);

		assert.ok(projection);
		assert.deepStrictEqual(createMinimapViewportGeometry(
			{ x: -100, y: -100, width: 300, height: 300 },
			projection,
			minimapSize,
		), { x: 0, y: 0, width: 160, height: 96 });
		assert.deepStrictEqual(createMinimapViewportGeometry(
			{ x: 1_000, y: 1_000, width: 100, height: 100 },
			projection,
			minimapSize,
		), { x: 160, y: 96, width: 0, height: 0 });
		assert.strictEqual(createMinimapViewportGeometry(
			{ x: 0, y: 0, width: -1, height: 10 },
			projection,
			minimapSize,
		), undefined);
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

function createCameraTransform(
	state: { readonly x: number; readonly y: number; readonly scale: number },
): { viewportToWorld(point: { x: number; y: number }): { x: number; y: number } } {
	return {
		viewportToWorld: (point) => ({
			x: (point.x - state.x) / state.scale,
			y: (point.y - state.y) / state.scale,
		}),
	};
}
