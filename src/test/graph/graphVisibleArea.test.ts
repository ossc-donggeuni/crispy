import * as assert from 'assert';
import {
	calculateGraphVisibleArea,
	createFullGraphVisibleArea,
	resolveGraphVisibleArea,
} from '../../webview/graph/graphVisibleArea';

suite('Graph Visible Area', () => {
	const viewportSize = { width: 1000, height: 800 };
	const viewportBounds = {
		left: 100,
		top: 50,
		width: 1000,
		height: 800,
	};

	test('Dock 방향별 실제 Panel 안쪽 경계를 Visible Graph 경계로 사용한다', () => {
		assert.deepStrictEqual(calculateGraphVisibleArea(
			viewportSize,
			viewportBounds,
			createBounds(112, 62, 460, 776),
			'left',
			false,
		), createExpectedArea(472, 0, 1000, 800));
		assert.deepStrictEqual(calculateGraphVisibleArea(
			viewportSize,
			viewportBounds,
			createBounds(628, 62, 460, 776),
			'right',
			false,
		), createExpectedArea(0, 0, 528, 800));
		assert.deepStrictEqual(calculateGraphVisibleArea(
			viewportSize,
			viewportBounds,
			createBounds(112, 62, 976, 400),
			'top',
			false,
		), createExpectedArea(0, 412, 1000, 800));
		assert.deepStrictEqual(calculateGraphVisibleArea(
			viewportSize,
			viewportBounds,
			createBounds(112, 438, 976, 400),
			'bottom',
			false,
		), createExpectedArea(0, 0, 1000, 388));
	});

	test('Panel resize와 Dock 변경은 전달된 최신 bounds로 즉시 다시 계산한다', () => {
		const resizedRight = calculateGraphVisibleArea(
			viewportSize,
			viewportBounds,
			createBounds(528, 62, 560, 776),
			'right',
			false,
		);
		const samePanelAtBottom = calculateGraphVisibleArea(
			viewportSize,
			viewportBounds,
			createBounds(112, 338, 976, 500),
			'bottom',
			false,
		);

		assert.deepStrictEqual(resizedRight, createExpectedArea(0, 0, 428, 800));
		assert.deepStrictEqual(samePanelAtBottom, createExpectedArea(0, 0, 1000, 288));
	});

	test('Collapsed 또는 표시 크기가 없는 Panel은 전체 Graph 영역으로 복귀한다', () => {
		const fullArea = createFullGraphVisibleArea(viewportSize);

		assert.deepStrictEqual(calculateGraphVisibleArea(
			viewportSize,
			viewportBounds,
			createBounds(628, 62, 460, 776),
			'right',
			true,
		), fullArea);
		assert.deepStrictEqual(calculateGraphVisibleArea(
			viewportSize,
			viewportBounds,
			createBounds(628, 62, 0, 0),
			'right',
			false,
		), fullArea);
	});

	test('Runtime resolver는 Chat transform의 실제 bounds를 따라 연속 이동한다', () => {
		const viewport = createMeasuredElement(
			1000,
			800,
			createBounds(100, 50, 1000, 800),
		);
		const panel = createMeasuredElement(
			460,
			776,
			createBounds(728, 62, 460, 776),
		);

		assert.deepStrictEqual(
			resolveGraphVisibleArea(viewport, panel, 'right'),
			createExpectedArea(0, 0, 628, 800),
		);

		panel.setBounds(createBounds(900, 62, 460, 776));
		assert.deepStrictEqual(
			resolveGraphVisibleArea(viewport, panel, 'right'),
			createExpectedArea(0, 0, 800, 800),
		);
	});

	test('Runtime resolver는 창 전환 중 0 또는 역전 bounds를 전체 Viewport로 복구한다', () => {
		const viewport = createMeasuredElement(
			1000,
			800,
			createBounds(100, 50, 1000, 800),
		);
		const panel = createMeasuredElement(
			460,
			776,
			createBounds(0, 62, 460, 776),
		);
		const fullArea = createFullGraphVisibleArea(viewportSize);

		assert.deepStrictEqual(
			resolveGraphVisibleArea(viewport, panel, 'right'),
			fullArea,
		);

		viewport.clientWidth = 0;
		viewport.clientHeight = 0;
		assert.deepStrictEqual(
			resolveGraphVisibleArea(viewport, panel, 'right'),
			createFullGraphVisibleArea({ width: 0, height: 0 }),
		);
	});
});

function createMeasuredElement(
	clientWidth: number,
	clientHeight: number,
	initialBounds: ReturnType<typeof createBounds>,
): HTMLElement & {
	clientWidth: number;
	clientHeight: number;
	setBounds(bounds: ReturnType<typeof createBounds>): void;
} {
	let bounds = initialBounds;

	return {
		clientWidth,
		clientHeight,
		hidden: false,
		getBoundingClientRect: () => ({
			...bounds,
			x: bounds.left,
			y: bounds.top,
			toJSON: () => ({}),
		}),
		setBounds: (nextBounds: ReturnType<typeof createBounds>) => {
			bounds = nextBounds;
		},
	} as unknown as HTMLElement & {
		clientWidth: number;
		clientHeight: number;
		setBounds(bounds: ReturnType<typeof createBounds>): void;
	};
}

function createBounds(
	left: number,
	top: number,
	width: number,
	height: number,
) {
	return {
		left,
		top,
		right: left + width,
		bottom: top + height,
		width,
		height,
	};
}

function createExpectedArea(
	left: number,
	top: number,
	right: number,
	bottom: number,
) {
	const width = right - left;
	const height = bottom - top;

	return {
		left,
		top,
		right,
		bottom,
		width,
		height,
		center: {
			x: left + width / 2,
			y: top + height / 2,
		},
	};
}
