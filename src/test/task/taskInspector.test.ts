import * as assert from 'assert';
import { createDefaultTaskBlueprint } from '../../task';
import { calculateTaskInspectorPosition } from '../../webview/task/taskInspector';
import { createTaskGraphLayout } from '../../webview/task/taskLayout';

suite('Task Inspector', () => {
	test('Node 오른쪽 World anchor를 Camera로 투영한 뒤 viewport gap을 적용한다', () => {
		const node = createStartLayoutNode({ x: 100, y: 80 });
		const camera = createCameraProjection({ x: 20, y: -10, scale: 1.5 });
		const position = calculateTaskInspectorPosition(
			node,
			camera,
			{ width: 1_600, height: 900 },
			{ width: 320, height: 192 },
		);

		assert.deepStrictEqual(position, { x: 602, y: 110 });
		const projectedRight = camera.worldToViewport({
			x: node.position.x + node.width,
			y: node.position.y,
		});

		assert.strictEqual(position.x - projectedRight.x, 12);
	});

	test('Camera scale 변경은 anchor만 다시 투영하고 panel pixel 크기는 계산에 유지한다', () => {
		const node = createStartLayoutNode({ x: 100, y: 80 });
		const inspectorSize = { width: 320, height: 192 };
		const initial = calculateTaskInspectorPosition(
			node,
			createCameraProjection({ x: 20, y: -10, scale: 1 }),
			{ width: 2_000, height: 1_200 },
			inspectorSize,
		);
		const zoomed = calculateTaskInspectorPosition(
			node,
			createCameraProjection({ x: 40, y: 30, scale: 2 }),
			{ width: 2_000, height: 1_200 },
			inspectorSize,
		);

		assert.deepStrictEqual(initial, { x: 412, y: 70 });
		assert.deepStrictEqual(zoomed, { x: 812, y: 190 });
		assert.deepStrictEqual(inspectorSize, { width: 320, height: 192 });
	});

	test('오른쪽 공간이 부족하면 Node 왼쪽으로 전환하고 Viewport 안으로 clamp한다', () => {
		const node = createStartLayoutNode({ x: 800, y: -200 });
		const position = calculateTaskInspectorPosition(
			node,
			createCameraProjection({ x: 0, y: 0, scale: 1 }),
			{ width: 1_200, height: 800 },
			{ width: 320, height: 192 },
		);

		assert.deepStrictEqual(position, { x: 468, y: 12 });
	});
});

function createStartLayoutNode(origin: { readonly x: number; readonly y: number }) {
	let sequence = 0;
	const task = createDefaultTaskBlueprint({
		title: 'Inspector Task',
		origin,
	}, () => `inspector-${++sequence}`);
	const node = createTaskGraphLayout([task]).nodes.find(
		(candidate) => candidate.kind === 'start',
	);

	assert.ok(node);
	return node;
}

function createCameraProjection(
	state: { readonly x: number; readonly y: number; readonly scale: number },
) {
	return {
		worldToViewport: (point: { readonly x: number; readonly y: number }) => ({
			x: point.x * state.scale + state.x,
			y: point.y * state.scale + state.y,
		}),
	};
}
