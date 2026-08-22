import * as assert from 'assert';
import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	initializeGraphCamera,
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
	type GraphAnimationFrameScheduler,
} from '../../webview/graph/graphCamera';
import { resolveFileIcon } from '../../webview/graph/fileIconResolver';
import type {
	GraphLayout,
	GraphLayoutEdge,
	GraphLayoutNode,
} from '../../webview/graph/graphLayout';
import type {
	Graph,
	Project,
} from '../../webview/graph/graphModel';
import {
	initializeGraphNavigator,
	type GraphNavigatorInteractions,
} from '../../webview/graph/graphNavigator';
import { createGraphState } from '../../webview/graph/graphState';
import {
	calculateGraphVisibleArea,
	createFullGraphVisibleArea,
	type GraphVisibleAreaProvider,
} from '../../webview/graph/graphVisibleArea';
import { DEFAULT_PANEL_LAYOUT_STATE } from '../../webview/panel/panelState';
import {
	restoreWebviewState,
	saveWebviewState,
	type WebviewSessionState,
	type WebviewStateApi,
} from '../../webview/webviewState';

suite('Graph Navigator', () => {
	const originalResizeObserver = globalThis.ResizeObserver;

	suiteSetup(() => {
		globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
	});

	setup(() => {
		FakeResizeObserver.reset();
	});

	suiteTeardown(() => {
		globalThis.ResizeObserver = originalResizeObserver;
	});

	test('Minimap과 Zoom Controls를 같은 하단 Row에 왼쪽부터 배치한다', () => {
		const fixture = createNavigatorFixture();

		assert.strictEqual(fixture.navigatorElement.children.length, 2);
		assert.strictEqual(
			fixture.bottomRow.hasClass('graph-navigator-bottom-row'),
			true,
		);
		assert.deepStrictEqual(fixture.bottomRow.children, [
			fixture.minimap,
			fixture.zoom,
		]);
		assert.strictEqual(fixture.minimap.hasClass('graph-navigator-minimap'), true);
		assert.deepStrictEqual(fixture.minimap.children, [fixture.minimapSvg]);
		assert.strictEqual(
			fixture.minimap.hasAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE),
			true,
		);
		assert.deepStrictEqual(fixture.zoom.children, [
			fixture.coordinate,
			fixture.controls,
		]);
		assert.strictEqual(fixture.featureRow.children[1], fixture.actionRail);
	});

	test('Navigator를 최신 Visible Graph 영역의 우하단 안쪽으로 즉시 재배치한다', () => {
		let visibleArea = calculateGraphVisibleArea(
			{ width: 800, height: 600 },
			{ left: 0, top: 0, width: 800, height: 600 },
			{ left: 520, top: 12, right: 788, bottom: 588, width: 268, height: 576 },
			'right',
			false,
		);
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
			undefined,
			() => visibleArea,
		);
		const navigatorStyle = fixture.navigatorElement.style as unknown as Record<
			string,
			string
		>;

		assert.strictEqual(navigatorStyle.right, '296px');
		assert.strictEqual(navigatorStyle.bottom, '16px');

		visibleArea = calculateGraphVisibleArea(
			{ width: 800, height: 600 },
			{ left: 0, top: 0, width: 800, height: 600 },
			{ left: 12, top: 300, right: 788, bottom: 588, width: 776, height: 288 },
			'bottom',
			false,
		);
		fixture.navigator.refreshVisibleGraphArea();
		assert.strictEqual(navigatorStyle.right, '16px');
		assert.strictEqual(navigatorStyle.bottom, '316px');

		visibleArea = createFullGraphVisibleArea({ width: 800, height: 600 });
		fixture.navigator.refreshVisibleGraphArea();
		assert.strictEqual(navigatorStyle.right, '16px');
		assert.strictEqual(navigatorStyle.bottom, '16px');
	});

	test('초기 Layout을 SVG Line과 Rect로 렌더링하고 Text를 생성하지 않는다', () => {
		const nodes = [
			createMinimapNode('node:a', 0, 0),
			createMinimapNode('node:b', 300, 100),
		];
		const initialLayout = createMinimapLayout(nodes, [{
			id: 'edge:a-b',
			sourceId: 'node:a',
			targetId: 'node:b',
		}]);
		const fixture = createNavigatorFixture(undefined, {}, initialLayout);

		assert.strictEqual(fixture.minimapSvg.tagName, 'SVG');
		assert.strictEqual(fixture.minimapEdgeLayer.children.length, 1);
		assert.strictEqual(fixture.minimapNodeLayer.children.length, 2);
		assert.strictEqual(getChild(fixture.minimapEdgeLayer, 0).tagName, 'LINE');
		assert.strictEqual(getChild(fixture.minimapNodeLayer, 0).tagName, 'RECT');
		assert.strictEqual(
			getDescendantsByTagName(fixture.minimapSvg, 'TEXT').length,
			0,
		);
	});

	test('Viewport Indicator를 Node/Edge 위의 단일 Drag Target으로 표시한다', () => {
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
		);

		assert.deepStrictEqual(fixture.minimapSvg.children, [
			fixture.minimapEdgeLayer,
			fixture.minimapNodeLayer,
			fixture.minimapViewportLayer,
		]);
		assert.deepStrictEqual(
			fixture.minimapViewportLayer.children,
			[fixture.minimapViewportIndicator],
		);
		assert.strictEqual(fixture.minimapViewportIndicator.tagName, 'RECT');
		assert.strictEqual(
			fixture.minimapViewportIndicator.getAttribute('pointer-events'),
			'all',
		);
		assert.strictEqual(fixture.minimap.getAttribute('role'), 'region');
		assert.strictEqual(
			fixture.minimap.getAttribute('aria-label'),
			'Graph minimap navigation',
		);
		assert.strictEqual(fixture.minimap.hasAttribute('aria-hidden'), false);
		assert.strictEqual(
			fixture.minimapViewportIndicator.getAttribute('aria-label'),
			'Current graph viewport; drag to pan',
		);
		assert.strictEqual(
			fixture.minimapViewportIndicator.getAttribute('visibility'),
			null,
		);
		assert.strictEqual(
			getDescendantsByTagName(fixture.minimapSvg, 'TEXT').length,
			0,
		);
	});

	test('투영 크기가 0인 Node도 최소 2px Shape로 표시한다', () => {
		const zeroSizeNode = {
			...createMinimapNode('node:zero', 0, 0),
			width: 0,
			height: 0,
		};
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createMinimapLayout([zeroSizeNode]),
		);
		const rect = getChild(fixture.minimapNodeLayer, 0);

		assert.strictEqual(rect.getAttribute('width'), '2');
		assert.strictEqual(rect.getAttribute('height'), '2');
	});

	test('setLayout은 같은 Minimap/SVG/Indicator를 유지하며 최신 Projection과 Empty 상태를 반영한다', () => {
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
		);
		const indicator = fixture.minimapViewportIndicator;
		const initialIndicatorWidth = Number(indicator.getAttribute('width'));
		const nextLayout = createMinimapLayout([
			createMinimapNode('node:next-a', 0, 0),
			createMinimapNode('node:next-b', 4_000, 2_400),
		]);

		fixture.navigator.setLayout(nextLayout);

		assert.strictEqual(fixture.overlay.children[0], fixture.navigatorElement);
		assert.strictEqual(fixture.bottomRow.children[0], fixture.minimap);
		assert.strictEqual(fixture.minimap.children[0], fixture.minimapSvg);
		assert.strictEqual(fixture.minimapViewportIndicator, indicator);
		assert.ok(Number(indicator.getAttribute('width')) < initialIndicatorWidth);
		assert.strictEqual(fixture.minimapNodeLayer.children.length, 2);
		assert.deepStrictEqual(
			fixture.minimapNodeLayer.children.map((node) => (
				node.getAttribute('data-graph-node-id')
			)),
			['node:next-a', 'node:next-b'],
		);

		fixture.navigator.setLayout(createEmptyLayout());
		assert.strictEqual(fixture.minimapNodeLayer.children.length, 0);
		assert.strictEqual(fixture.minimapEdgeLayer.children.length, 0);
		assert.strictEqual(indicator.getAttribute('visibility'), 'hidden');

		fixture.camera.setState({ x: -200, y: -100, scale: 1.5 });
		assert.strictEqual(indicator.getAttribute('visibility'), 'hidden');
		fixture.navigator.setLayout(nextLayout);
		assert.strictEqual(indicator.getAttribute('visibility'), null);
	});

	test('nodePositions 변경만으로 기존 Minimap Container를 유지하며 Node와 Edge를 다시 투영한다', () => {
		const layout = createMinimapLayout([
			createMinimapNode('node:left', 0, 0),
			createMinimapNode('node:middle', 150, 80),
			createMinimapNode('node:right', 2_000, 160),
		], [{
			id: 'edge:middle-right',
			sourceId: 'node:middle',
			targetId: 'node:right',
		}]);
		const fixture = createNavigatorFixture(undefined, {}, layout);
		const minimap = fixture.minimap;
		const svg = fixture.minimapSvg;
		const initialRight = getChildByAttribute(
			fixture.minimapNodeLayer,
			'data-graph-node-id',
			'node:right',
		);
		const initialX = Number(initialRight.getAttribute('x'));
		const indicator = fixture.minimapViewportIndicator;
		const initialIndicatorWidth = Number(indicator.getAttribute('width'));

		fixture.graphState.setState({
			camera: fixture.graphState.getState().camera,
			nodePositions: { 'node:right': { x: 4_000, y: 30 } },
		});
		const movedRight = getChildByAttribute(
			fixture.minimapNodeLayer,
			'data-graph-node-id',
			'node:right',
		);

		assert.strictEqual(fixture.minimap, minimap);
		assert.strictEqual(fixture.minimapSvg, svg);
		assert.notStrictEqual(Number(movedRight.getAttribute('x')), initialX);
		assert.ok(Number(indicator.getAttribute('width')) < initialIndicatorWidth);
		assert.strictEqual(fixture.minimapEdgeLayer.children.length, 1);

		const currentNodes = [...fixture.minimapNodeLayer.children];

		fixture.graphState.setState({
			camera: { x: 50, y: 60, scale: 1.5 },
			nodePositions: fixture.graphState.getState().nodePositions,
		});
		assert.deepStrictEqual(fixture.minimapNodeLayer.children, currentNodes);
	});

	test('Camera Pan과 Zoom은 같은 Indicator attribute만 갱신하고 Graph Graphic을 유지한다', () => {
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
		);
		const indicator = fixture.minimapViewportIndicator;
		const nodes = [...fixture.minimapNodeLayer.children];
		const edges = [...fixture.minimapEdgeLayer.children];
		const initialX = Number(indicator.getAttribute('x'));
		const initialWidth = Number(indicator.getAttribute('width'));
		const initialHeight = Number(indicator.getAttribute('height'));

		fixture.camera.setState({ x: -300, y: -200, scale: 1 });
		assert.strictEqual(fixture.minimapViewportIndicator, indicator);
		assert.notStrictEqual(Number(indicator.getAttribute('x')), initialX);
		assert.deepStrictEqual(fixture.minimapNodeLayer.children, nodes);
		assert.deepStrictEqual(fixture.minimapEdgeLayer.children, edges);

		fixture.camera.setScaleAt(2, { x: 400, y: 300 });
		assert.strictEqual(fixture.minimapViewportIndicator, indicator);
		assert.ok(Number(indicator.getAttribute('width')) < initialWidth);
		assert.ok(Number(indicator.getAttribute('height')) < initialHeight);
		assert.deepStrictEqual(fixture.minimapNodeLayer.children, nodes);
		assert.deepStrictEqual(fixture.minimapEdgeLayer.children, edges);
	});

	test('Graph Viewport Resize는 Indicator만 갱신하고 Observer를 dispose에서 정리한다', () => {
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
		);
		const indicator = fixture.minimapViewportIndicator;
		const nodes = [...fixture.minimapNodeLayer.children];
		const edges = [...fixture.minimapEdgeLayer.children];
		const initialWidth = Number(indicator.getAttribute('width'));
		const initialHeight = Number(indicator.getAttribute('height'));

		assert.strictEqual(FakeResizeObserver.getInstanceCount(), 1);
		fixture.viewport.clientWidth = 400;
		fixture.viewport.clientHeight = 300;
		FakeResizeObserver.trigger(fixture.viewport);

		assert.ok(Number(indicator.getAttribute('width')) < initialWidth);
		assert.ok(Number(indicator.getAttribute('height')) < initialHeight);
		assert.deepStrictEqual(fixture.minimapNodeLayer.children, nodes);
		assert.deepStrictEqual(fixture.minimapEdgeLayer.children, edges);
		assert.strictEqual(FakeResizeObserver.getInstanceCount(), 1);

		fixture.viewport.clientWidth = 0;
		FakeResizeObserver.trigger(fixture.viewport);
		assert.strictEqual(indicator.getAttribute('visibility'), 'hidden');
		fixture.viewport.clientWidth = 400;
		FakeResizeObserver.trigger(fixture.viewport);
		assert.strictEqual(indicator.getAttribute('visibility'), null);

		const resizedAttributes = readRectAttributes(indicator);

		fixture.navigator.dispose();
		assert.strictEqual(FakeResizeObserver.isObserving(fixture.viewport), false);
		fixture.viewport.clientWidth = 200;
		fixture.viewport.clientHeight = 150;
		FakeResizeObserver.trigger(fixture.viewport);
		assert.deepStrictEqual(readRectAttributes(indicator), resizedAttributes);
	});

	test('Minimap Click을 SVG 논리 좌표에서 World로 역투영해 기존 focusOn에 전달한다', () => {
		const fixture = createNavigatorFixture(
			{ x: 0, y: 0, scale: 1.5 },
			{},
			createLargeMinimapLayout(),
		);
		const nodes = [...fixture.minimapNodeLayer.children];
		const edges = [...fixture.minimapEdgeLayer.children];
		const indicator = fixture.minimapViewportIndicator;
		const initialIndicator = readRectAttributes(indicator);
		const focusTargets: Array<{ x: number; y: number }> = [];
		const focusOn = fixture.camera.focusOn.bind(fixture.camera);

		fixture.camera.focusOn = (point) => {
			focusTargets.push(point);
			focusOn(point, { duration: 0 });
		};
		fixture.minimapSvg.boundsLeft = 100;
		fixture.minimapSvg.boundsTop = 50;
		fixture.minimapSvg.clientWidth = 320;
		fixture.minimapSvg.clientHeight = 192;
		const centerClick = createClickEvent(
			fixture.minimapSvg.asEventTarget(),
			260,
			146,
		);

		fixture.minimapSvg.dispatch('click', centerClick);

		assert.strictEqual(focusTargets.length, 1);
		assertPointAlmostEqual(
			focusTargets[0] ?? assert.fail('Focus Target이 있어야 한다.'),
			{ x: 1_050, y: 620 },
		);
		assertPointAlmostEqual(
			fixture.camera.worldToViewport(focusTargets[0] ?? { x: 0, y: 0 }),
			{ x: 400, y: 300 },
		);
		assert.strictEqual(fixture.camera.getState().scale, 1.5);
		assert.strictEqual(centerClick.defaultPrevented, true);
		assert.strictEqual(centerClick.propagationStopped, true);
		assert.deepStrictEqual(fixture.minimapNodeLayer.children, nodes);
		assert.deepStrictEqual(fixture.minimapEdgeLayer.children, edges);
		assert.strictEqual(fixture.minimapViewportIndicator, indicator);
		assert.notDeepStrictEqual(readRectAttributes(indicator), initialIndicator);

		fixture.minimapSvg.dispatch('click', createClickEvent(
			fixture.minimapSvg.asEventTarget(),
			140,
			90,
		));
		assert.strictEqual(focusTargets.length, 2);
		assert.notDeepStrictEqual(focusTargets[1], focusTargets[0]);
		assert.strictEqual(fixture.camera.getState().scale, 1.5);
	});

	test('Minimap Focus도 Camera와 공유한 Visible Graph 중앙에 Target을 배치한다', () => {
		const visibleArea = calculateGraphVisibleArea(
			{ width: 800, height: 600 },
			{ left: 0, top: 0, width: 800, height: 600 },
			{ left: 520, top: 12, right: 788, bottom: 588, width: 268, height: 576 },
			'right',
			false,
		);
		const fixture = createNavigatorFixture(
			{ x: 0, y: 0, scale: 1.5 },
			{},
			createLargeMinimapLayout(),
			undefined,
			() => visibleArea,
		);
		const focusOn = fixture.camera.focusOn.bind(fixture.camera);

		fixture.camera.focusOn = (point) => focusOn(point, { duration: 0 });
		fixture.minimapSvg.dispatch('click', createClickEvent(
			fixture.minimapSvg.asEventTarget(),
			80,
			48,
		));

		assertPointAlmostEqual(
			fixture.camera.worldToViewport({ x: 1_050, y: 620 }),
			visibleArea.center,
		);
	});

	test('Empty Graph와 Minimap 바깥 또는 invalid Click은 Camera Navigation을 무시한다', () => {
		const fixture = createNavigatorFixture();
		let focusCount = 0;
		const focusOn = fixture.camera.focusOn.bind(fixture.camera);

		fixture.camera.focusOn = (point) => {
			focusCount += 1;
			focusOn(point, { duration: 0 });
		};
		fixture.minimapSvg.dispatch('click', createClickEvent(
			fixture.minimapSvg.asEventTarget(),
			80,
			48,
		));
		assert.strictEqual(focusCount, 0);

		fixture.navigator.setLayout(createLargeMinimapLayout());
		fixture.minimapSvg.dispatch('click', createClickEvent(
			fixture.minimapSvg.asEventTarget(),
			-1,
			48,
		));
		fixture.minimapSvg.dispatch('click', createClickEvent(
			fixture.minimapSvg.asEventTarget(),
			Number.NaN,
			48,
		));
		assert.strictEqual(focusCount, 0);
	});

	test('Viewport Indicator Drag은 저장한 Projection으로 Camera 중심을 실시간 이동하고 DOM과 scale을 유지한다', () => {
		const fixture = createNavigatorFixture(
			{ x: -100, y: -100, scale: 1.25 },
			{},
			createLargeMinimapLayout(),
		);
		const indicator = fixture.minimapViewportIndicator;
		const nodes = [...fixture.minimapNodeLayer.children];
		const edges = [...fixture.minimapEdgeLayer.children];
		const initialCenter = fixture.camera.viewportToWorld({ x: 400, y: 300 });
		const start = readIndicatorCenter(indicator);
		const pointerDown = createPointerEvent(
			indicator.asEventTarget(),
			start.x,
			start.y,
			7,
		);

		indicator.dispatch('pointerdown', pointerDown);
		fixture.viewport.dispatch('pointerdown', pointerDown);
		assert.strictEqual(indicator.hasPointerCapture(7), true);
		assert.strictEqual(indicator.hasClass('is-dragging'), true);
		assert.strictEqual(pointerDown.defaultPrevented, true);
		assert.strictEqual(pointerDown.propagationStopped, true);
		assert.strictEqual(fixture.viewport.hasPointerCapture(7), false);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);

		const beforeOtherPointer = fixture.camera.getState();
		indicator.dispatch('pointermove', createPointerEvent(
			indicator.asEventTarget(),
			start.x + 30,
			start.y + 30,
			8,
		));
		indicator.dispatch('pointerup', createPointerEvent(
			indicator.asEventTarget(),
			start.x + 30,
			start.y + 30,
			8,
		));
		assert.deepStrictEqual(fixture.camera.getState(), beforeOtherPointer);
		assert.strictEqual(indicator.hasPointerCapture(7), true);

		indicator.dispatch('pointermove', createPointerEvent(
			indicator.asEventTarget(),
			start.x + 10.5,
			start.y + 7.25,
			7,
		));
		const movedCenter = fixture.camera.viewportToWorld({ x: 400, y: 300 });

		assert.ok(movedCenter.x > initialCenter.x);
		assert.ok(movedCenter.y > initialCenter.y);
		assert.strictEqual(fixture.camera.getState().scale, 1.25);
		assert.deepStrictEqual(fixture.minimapNodeLayer.children, nodes);
		assert.deepStrictEqual(fixture.minimapEdgeLayer.children, edges);
		assert.strictEqual(fixture.minimapViewportIndicator, indicator);

		indicator.dispatch('pointerup', createPointerEvent(
			indicator.asEventTarget(),
			start.x + 10.5,
			start.y + 7.25,
			7,
		));
		assert.strictEqual(indicator.hasPointerCapture(7), false);
		assert.strictEqual(indicator.hasClass('is-dragging'), false);
		const completedState = fixture.camera.getState();

		indicator.dispatch('pointermove', createPointerEvent(
			indicator.asEventTarget(),
			start.x + 40,
			start.y + 40,
			7,
		));
		assert.deepStrictEqual(fixture.camera.getState(), completedState);

		fixture.minimapSvg.dispatch('click', createClickEvent(
			indicator.asEventTarget(),
			start.x + 10.5,
			start.y + 7.25,
		));
		assert.deepStrictEqual(fixture.camera.getState(), completedState);
		fixture.minimapSvg.dispatch('click', createClickEvent(
			fixture.minimapSvg.asEventTarget(),
			20,
			20,
		));
		assert.notDeepStrictEqual(fixture.camera.getState(), completedState);
	});

	test('Indicator Drag은 X와 Y 단일 축 이동을 독립적으로 반영하고 유효한 Primary Button만 시작한다', () => {
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
		);
		const indicator = fixture.minimapViewportIndicator;
		let start = readIndicatorCenter(indicator);

		indicator.dispatch('pointerdown', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y, 20, 1,
		));
		indicator.dispatch('pointerdown', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y, 21, 0, false,
		));
		assert.strictEqual(indicator.hasPointerCapture(20), false);
		assert.strictEqual(indicator.hasPointerCapture(21), false);
		const beforeIndicatorClick = fixture.camera.getState();
		indicator.dispatch('pointerdown', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y, 24,
		));
		indicator.dispatch('pointerup', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y, 24,
		));
		const indicatorClick = createClickEvent(
			indicator.asEventTarget(), start.x, start.y,
		);
		indicator.dispatch('click', indicatorClick);
		assert.deepStrictEqual(fixture.camera.getState(), beforeIndicatorClick);
		assert.strictEqual(indicatorClick.defaultPrevented, true);
		assert.strictEqual(indicatorClick.propagationStopped, true);

		indicator.dispatch('pointerdown', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y, 22,
		));
		const beforeX = fixture.camera.viewportToWorld({ x: 400, y: 300 });
		indicator.dispatch('pointermove', createPointerEvent(
			indicator.asEventTarget(), start.x + 7, start.y, 22,
		));
		const afterX = fixture.camera.viewportToWorld({ x: 400, y: 300 });
		assert.ok(afterX.x > beforeX.x);
		assert.ok(Math.abs(afterX.y - beforeX.y) < 1e-10);
		indicator.dispatch('pointerup', createPointerEvent(
			indicator.asEventTarget(), start.x + 7, start.y, 22,
		));

		start = readIndicatorCenter(indicator);
		const beforeY = fixture.camera.viewportToWorld({ x: 400, y: 300 });
		indicator.dispatch('pointerdown', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y, 23,
		));
		indicator.dispatch('pointermove', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y - 5, 23,
		));
		const afterY = fixture.camera.viewportToWorld({ x: 400, y: 300 });
		assert.ok(Math.abs(afterY.x - beforeY.x) < 1e-10);
		assert.ok(afterY.y < beforeY.y);
		indicator.dispatch('pointerup', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y - 5, 23,
		));
	});

	test('Indicator Drag은 pointercancel과 lostpointercapture에서 종료하고 후속 Move를 무시한다', () => {
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
		);
		const indicator = fixture.minimapViewportIndicator;
		let start = readIndicatorCenter(indicator);

		indicator.dispatch('pointerdown', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y, 3,
		));
		indicator.dispatch('pointermove', createPointerEvent(
			indicator.asEventTarget(), start.x + 8, start.y - 6, 3,
		));
		indicator.dispatch('pointercancel', createPointerEvent(
			indicator.asEventTarget(), start.x + 8, start.y - 6, 3,
		));
		assert.strictEqual(indicator.hasPointerCapture(3), false);
		assert.strictEqual(indicator.hasClass('is-dragging'), false);
		const cancelledState = fixture.camera.getState();

		indicator.dispatch('pointermove', createPointerEvent(
			indicator.asEventTarget(), start.x + 30, start.y + 30, 3,
		));
		assert.deepStrictEqual(fixture.camera.getState(), cancelledState);

		start = readIndicatorCenter(indicator);
		indicator.dispatch('pointerdown', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y, 4,
		));
		indicator.dispatch('pointermove', createPointerEvent(
			indicator.asEventTarget(), start.x - 9, start.y + 5, 4,
		));
		indicator.losePointerCapture(4);
		assert.strictEqual(indicator.hasPointerCapture(4), false);
		assert.strictEqual(indicator.hasClass('is-dragging'), false);
		const lostState = fixture.camera.getState();

		indicator.dispatch('pointermove', createPointerEvent(
			indicator.asEventTarget(), start.x - 30, start.y + 30, 4,
		));
		assert.deepStrictEqual(fixture.camera.getState(), lostState);
	});

	test('Minimap Click Focus Animation 중 Indicator Drag은 기존 setState 정책으로 Animation을 취소한다', () => {
		const scheduler = new FakeAnimationFrameScheduler();
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
			scheduler,
		);

		fixture.minimapSvg.dispatch('click', createClickEvent(
			fixture.minimapSvg.asEventTarget(),
			120,
			70,
		));
		assert.strictEqual(scheduler.pendingCount, 1);
		const start = readIndicatorCenter(fixture.minimapViewportIndicator);

		fixture.minimapViewportIndicator.dispatch('pointerdown', createPointerEvent(
			fixture.minimapViewportIndicator.asEventTarget(),
			start.x,
			start.y,
			9,
		));
		assert.strictEqual(scheduler.pendingCount, 0);
		assert.strictEqual(scheduler.cancelCount, 1);

		fixture.minimapViewportIndicator.dispatch('pointermove', createPointerEvent(
			fixture.minimapViewportIndicator.asEventTarget(),
			start.x + 6,
			start.y + 4,
			9,
		));
		assert.strictEqual(scheduler.pendingCount, 0);
	});

	test('Navigator dispose는 활성 Minimap Drag을 정리하고 후속 Interaction을 무시한다', () => {
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
		);
		const indicator = fixture.minimapViewportIndicator;
		const start = readIndicatorCenter(indicator);

		indicator.dispatch('pointerdown', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y, 11,
		));
		assert.strictEqual(indicator.hasPointerCapture(11), true);
		fixture.navigator.dispose();
		assert.strictEqual(indicator.hasPointerCapture(11), false);
		assert.strictEqual(indicator.hasClass('is-dragging'), false);
		const disposedState = fixture.camera.getState();

		indicator.dispatch('pointermove', createPointerEvent(
			indicator.asEventTarget(), start.x + 20, start.y + 20, 11,
		));
		indicator.dispatch('pointerdown', createPointerEvent(
			indicator.asEventTarget(), start.x, start.y, 12,
		));
		fixture.minimapSvg.dispatch('click', createClickEvent(
			fixture.minimapSvg.asEventTarget(), 80, 48,
		));
		assert.deepStrictEqual(fixture.camera.getState(), disposedState);
		assert.strictEqual(indicator.hasPointerCapture(12), false);
	});

	test('복원된 Camera 좌표를 반올림하고 scale을 퍼센트로 최초 표시한다', () => {
		const fixture = createNavigatorFixture({
			x: 513.42,
			y: 323.75,
			scale: 1.2,
		});

		assert.strictEqual(fixture.coordinate.textContent, '(513, 324)');
		assert.strictEqual(fixture.scale.textContent, '120%');
		assert.strictEqual(fixture.controls.children.length, 3);
		assert.strictEqual(
			fixture.controls.hasAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE),
			true,
		);
	});

	test('Action Rail과 Root List Action을 접근 가능한 버튼으로 생성한다', () => {
		const fixture = createNavigatorFixture();

		assert.strictEqual(fixture.actionRail.hasClass('graph-navigator-action-rail'), true);
		assert.strictEqual(fixture.actionRail.children.length, 2);
		assert.strictEqual(fixture.actionRail.getAttribute('role'), 'toolbar');
		assert.strictEqual(
			fixture.actionRail.hasAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE),
			true,
		);
		assert.strictEqual(fixture.rootListButton.type, 'button');
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-label'),
			'활성화된 루트 목록',
		);
		assert.strictEqual(fixture.rootListButton.title, '활성화된 루트 목록');
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-controls'),
			fixture.rootListPanel.id,
		);
		assert.strictEqual(fixture.rootListPanel.children.length, 3);
		assert.strictEqual(
			fixture.rootListPanel.getAttribute('aria-labelledby'),
			fixture.rootListTitle.id,
		);
		assert.strictEqual(
			fixture.rootListIcon.getAttribute('data-navigator-icon'),
			'navigator-root.svg',
		);
		assert.strictEqual(
			fixture.rootListIcon.getAttribute('aria-hidden'),
			'true',
		);
		assert.strictEqual(fixture.filterButton.type, 'button');
		assert.strictEqual(
			fixture.filterButton.getAttribute('aria-label'),
			'Workspace Filter',
		);
		assert.strictEqual(fixture.filterButton.title, 'Workspace Filter');
		assert.strictEqual(
			fixture.filterButton.getAttribute('aria-controls'),
			fixture.filterPanel.id,
		);
		assert.strictEqual(
			fixture.filterIcon.getAttribute('data-navigator-icon'),
			'navigator-filter.svg',
		);
		assert.strictEqual(
			fixture.filterPanel.hasAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE),
			true,
		);
	});

	test('Project, Folder와 File Root를 전달 순서와 기존 Icon 규약으로 렌더링한다', () => {
		const fixture = createNavigatorFixture();

		fixture.navigator.setRoots([
			{
				rootId: 'root:project',
				nodeId: 'project:crispy',
				name: 'crispy',
				kind: 'project',
			},
			{
				rootId: 'root:folder',
				nodeId: 'folder:docs',
				name: 'docs',
				kind: 'folder',
				relativePath: 'crispy/src/',
			},
			{
				rootId: 'root:file',
				nodeId: 'file:webview.css',
				name: 'webview.css',
				kind: 'file',
				relativePath: 'crispy/src/webview/',
			},
		]);

		assert.strictEqual(fixture.rootList.hidden, false);
		assert.strictEqual(fixture.rootListEmpty.hidden, true);
		assert.strictEqual(fixture.rootList.children.length, 3);
		const [projectItem, folderItem, fileItem] = fixture.rootList.children;

		assert.ok(projectItem);
		assert.ok(folderItem);
		assert.ok(fileItem);
		assert.deepStrictEqual(
			fixture.rootList.children.map((item) => (
				getChild(getRootContent(item), 0).textContent
			)),
			['crispy', 'docs/', 'webview.css'],
		);
		assert.strictEqual(projectItem.tagName, 'LI');
		assert.strictEqual(getRootButton(projectItem).tagName, 'BUTTON');
		assert.strictEqual(getRootButton(projectItem).type, 'button');
		assert.strictEqual(
			getRootButton(projectItem).getAttribute('aria-label'),
			'crispy',
		);
		assert.strictEqual(
			getRootButton(folderItem).getAttribute('aria-label'),
			'docs/',
		);
		assert.strictEqual(
			getRootIcon(projectItem).getAttribute('data-folder-icon'),
			'folder-open.svg',
		);
		assert.strictEqual(
			getRootIcon(folderItem).getAttribute('data-folder-icon'),
			'folder-closed.svg',
		);
		const fileIcon = getRootIcon(fileItem);

		assert.strictEqual(fileIcon.hasClass('graph-file-icon'), true);
		assert.strictEqual(
			fileIcon.getAttribute('data-file-icon'),
			resolveFileIcon('webview.css'),
		);
		assert.strictEqual(
			getChild(getRootContent(folderItem), 1).textContent,
			'crispy/src/',
		);
		assert.strictEqual(
			getChild(getRootContent(fileItem), 1).textContent,
			'crispy/src/webview/',
		);
	});

	test('Project, Folder와 File Root Button은 rootId 선택을 전달하고 Panel을 열린 채 유지한다', () => {
		const selectedRootIds: string[] = [];
		const fixture = createNavigatorFixture(
			undefined,
			{ onRootSelect: (rootId) => selectedRootIds.push(rootId) },
		);

		fixture.navigator.setRoots([
			{
				rootId: 'root:project',
				nodeId: 'project:crispy',
				name: 'crispy',
				kind: 'project',
			},
			{
				rootId: 'root:folder',
				nodeId: 'folder:docs',
				name: 'docs',
				kind: 'folder',
			},
			{
				rootId: 'root:file',
				nodeId: 'file:webview.css',
				name: 'webview.css',
				kind: 'file',
			},
		]);
		fixture.rootListButton.dispatch('click', {} as Event);

		for (const item of fixture.rootList.children) {
			getRootButton(item).dispatch('click', {} as Event);
		}

		assert.deepStrictEqual(
			selectedRootIds,
			['root:project', 'root:folder', 'root:file'],
		);
		assert.strictEqual(fixture.rootListPanel.hidden, false);
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-expanded'),
			'true',
		);
	});

	test('setRoots와 dispose는 제거된 Root Button의 선택 Listener를 정리한다', () => {
		const selectedRootIds: string[] = [];
		const fixture = createNavigatorFixture(
			undefined,
			{ onRootSelect: (rootId) => selectedRootIds.push(rootId) },
		);

		fixture.navigator.setRoots([{
			rootId: 'root:a',
			nodeId: 'project:a',
			name: 'a',
			kind: 'project',
		}]);
		const removedButton = getRootButton(getChild(fixture.rootList, 0));

		fixture.navigator.setRoots([{
			rootId: 'root:b',
			nodeId: 'folder:b',
			name: 'b',
			kind: 'folder',
		}]);
		const currentButton = getRootButton(getChild(fixture.rootList, 0));

		removedButton.dispatch('click', {} as Event);
		currentButton.dispatch('click', {} as Event);
		assert.deepStrictEqual(selectedRootIds, ['root:b']);

		fixture.navigator.dispose();
		currentButton.dispatch('click', {} as Event);
		assert.deepStrictEqual(selectedRootIds, ['root:b']);
	});

	test('relativePath가 없거나 빈 문자열이면 보조 Path Row를 만들지 않는다', () => {
		const fixture = createNavigatorFixture();

		fixture.navigator.setRoots([
			{
				rootId: 'root:project',
				nodeId: 'project:crispy',
				name: 'crispy',
				kind: 'project',
			},
			{
				rootId: 'root:folder',
				nodeId: 'folder:docs',
				name: 'docs',
				kind: 'folder',
				relativePath: '',
			},
		]);

		for (const item of fixture.rootList.children) {
			assert.strictEqual(getRootContent(item).children.length, 1);
		}
	});

	test('setRoots 재호출은 기존 Item을 최신 목록으로 교체하고 빈 목록을 표시한다', () => {
		const fixture = createNavigatorFixture();

		fixture.navigator.setRoots([
			{
				rootId: 'root:project',
				nodeId: 'project:crispy',
				name: 'crispy',
				kind: 'project',
			},
			{
				rootId: 'root:folder',
				nodeId: 'folder:docs',
				name: 'docs',
				kind: 'folder',
			},
		]);
		fixture.navigator.setRoots([{
			rootId: 'root:file',
			nodeId: 'file:webview.css',
			name: 'webview.css',
			kind: 'file',
		}]);

		assert.strictEqual(fixture.rootList.children.length, 1);
		assert.strictEqual(
			getChild(getRootContent(getChild(fixture.rootList, 0)), 0).textContent,
			'webview.css',
		);

		fixture.navigator.setRoots([]);

		assert.strictEqual(fixture.rootList.children.length, 0);
		assert.strictEqual(fixture.rootList.hidden, true);
		assert.strictEqual(fixture.rootListEmpty.hidden, false);
		assert.strictEqual(
			fixture.rootListEmpty.textContent,
			'활성화된 루트가 없습니다.',
		);
	});

	test('setRoots는 닫힌 Panel을 열지 않고 열린 Panel도 닫지 않는다', () => {
		const fixture = createNavigatorFixture();
		const roots = [{
			rootId: 'root:project',
			nodeId: 'project:crispy',
			name: 'crispy',
			kind: 'project' as const,
		}];

		fixture.navigator.setRoots(roots);
		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-expanded'),
			'false',
		);

		fixture.rootListButton.dispatch('click', {} as Event);
		fixture.navigator.setRoots([]);
		assert.strictEqual(fixture.rootListPanel.hidden, false);
		assert.strictEqual(fixture.filterPanel.hidden, true);
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-expanded'),
			'true',
		);
		assert.strictEqual(fixture.rootListButton.hasClass('is-active'), true);

		fixture.rootListButton.dispatch('click', {} as Event);
		fixture.navigator.setRoots(roots);
		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-expanded'),
			'false',
		);
	});

	test('Root List Panel은 초기에 닫혀 있고 Action을 누를 때마다 열림 상태와 활성 표시를 동기화한다', () => {
		const fixture = createNavigatorFixture();

		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-expanded'),
			'false',
		);
		assert.strictEqual(fixture.rootListButton.hasClass('is-active'), false);
		assert.strictEqual(fixture.rootListTitle.textContent, '활성화된 루트 목록');

		fixture.rootListButton.dispatch('click', {} as Event);

		assert.strictEqual(fixture.rootListPanel.hidden, false);
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-expanded'),
			'true',
		);
		assert.strictEqual(fixture.rootListButton.hasClass('is-active'), true);

		fixture.rootListButton.dispatch('click', {} as Event);

		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-expanded'),
			'false',
		);
		assert.strictEqual(fixture.rootListButton.hasClass('is-active'), false);
	});

	test('Root List와 Filter Action은 단일 active Panel로 visibility와 active 상태를 동기화한다', () => {
		const fixture = createNavigatorFixture();

		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(fixture.filterPanel.hidden, true);
		assert.strictEqual(fixture.filterTitle.textContent, 'Workspace Filter');
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-expanded'),
			'false',
		);
		assert.strictEqual(
			fixture.filterButton.getAttribute('aria-expanded'),
			'false',
		);
		assert.strictEqual(fixture.rootListButton.hasClass('is-active'), false);
		assert.strictEqual(fixture.filterButton.hasClass('is-active'), false);
		assert.strictEqual(
			fixture.filterIcon.getAttribute('data-navigator-icon'),
			'navigator-filter.svg',
		);

		fixture.rootListButton.dispatch('click', {} as Event);

		assert.strictEqual(fixture.rootListPanel.hidden, false);
		assert.strictEqual(fixture.filterPanel.hidden, true);
		assert.strictEqual(fixture.rootListButton.hasClass('is-active'), true);
		assert.strictEqual(fixture.filterButton.hasClass('is-active'), false);
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-expanded'),
			'true',
		);
		fixture.filterButton.dispatch('click', {} as Event);

		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(fixture.filterPanel.hidden, false);
		assert.strictEqual(fixture.rootListButton.hasClass('is-active'), false);
		assert.strictEqual(
			fixture.filterButton.getAttribute('aria-expanded'),
			'true',
		);
		assert.strictEqual(fixture.filterButton.hasClass('is-active'), true);

		fixture.rootListButton.dispatch('click', {} as Event);

		assert.strictEqual(fixture.rootListPanel.hidden, false);
		assert.strictEqual(fixture.filterPanel.hidden, true);
		assert.strictEqual(fixture.rootListButton.hasClass('is-active'), true);
		assert.strictEqual(fixture.filterButton.hasClass('is-active'), false);

		fixture.rootListButton.dispatch('click', {} as Event);

		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(fixture.filterPanel.hidden, true);
		assert.strictEqual(fixture.rootListButton.hasClass('is-active'), false);
		assert.strictEqual(fixture.filterButton.hasClass('is-active'), false);

		fixture.filterButton.dispatch('click', {} as Event);
		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(fixture.filterPanel.hidden, false);
		fixture.filterButton.dispatch('click', {} as Event);
		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(fixture.filterPanel.hidden, true);
		assert.strictEqual(
			fixture.filterButton.getAttribute('aria-expanded'),
			'false',
		);
		assert.strictEqual(fixture.filterButton.hasClass('is-active'), false);

		fixture.navigator.dispose();
		fixture.filterButton.dispatch('click', {} as Event);
		fixture.rootListButton.dispatch('click', {} as Event);
		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(fixture.filterPanel.hidden, true);
	});

	test('원본 Workspace Project hierarchy를 Multi-root Tree로 표시하고 synthetic/Detached 중복을 만들지 않는다', () => {
		const fixture = createNavigatorFixture();
		const workspace = createFilterWorkspaceFixture();
		const graphWithDetachedFolderRoot: Graph = {
			roots: [
				...workspace.graph.roots,
				{ id: 'root:detached-src', nodeId: workspace.srcFolder.id },
			],
			rootNodes: workspace.graph.rootNodes,
		};

		fixture.navigator.setWorkspaceGraph(graphWithDetachedFolderRoot);

		assert.strictEqual(fixture.filterTree.getAttribute('role'), 'tree');
		assert.strictEqual(fixture.filterTree.children.length, 2);
		assert.deepStrictEqual(
			fixture.filterTree.children.map((item) => getFilterItemName(item)),
			['frontend', 'backend'],
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.srcFolder.id).length,
			1,
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.webviewFolder.id).length,
			0,
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphLayoutFile.id).length,
			0,
		);
		const frontendItem = getFilterItem(
			fixture.filterTree,
			workspace.frontendProject.id,
		);

		assert.strictEqual(
			getFilterToggle(frontendItem).getAttribute('aria-expanded'),
			'true',
		);
		assert.ok(findFilterItemChildren(frontendItem));
		assert.strictEqual(
			getFilterItemRow(frontendItem).children.some(
				(child) => child.tagName === 'INPUT',
			),
			false,
		);
		assert.deepStrictEqual(
			getFilterNodeKinds(fixture.filterTree),
			['project', 'folder', 'file', 'project', 'file'],
		);

		const srcToggle = getFilterToggle(getFilterItem(
			fixture.filterTree,
			workspace.srcFolder.id,
		));

		fixture.filterTree.dispatch(
			'click',
			createClickEvent(srcToggle.asEventTarget(), 0, 0),
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.webviewFolder.id).length,
			1,
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphViewFile.id).length,
			0,
		);

		const webviewToggle = getFilterToggle(getFilterItem(
			fixture.filterTree,
			workspace.webviewFolder.id,
		));

		fixture.filterTree.dispatch(
			'click',
			createClickEvent(webviewToggle.asEventTarget(), 0, 0),
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphViewFile.id).length,
			1,
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphLayoutFile.id).length,
			1,
		);
		assert.deepStrictEqual(
			getFilterNodeKinds(fixture.filterTree),
			['project', 'folder', 'folder', 'file', 'file', 'file', 'project', 'file'],
		);
	});

	test('Filter Folder expand 상태는 로컬로 유지되며 Graph openedFolders를 변경하지 않는다', () => {
		const fixture = createNavigatorFixture();
		const workspace = createFilterWorkspaceFixture();

		fixture.navigator.setWorkspaceGraph(workspace.graph);
		fixture.filterButton.dispatch('click', {} as Event);
		const openedFolders = fixture.graphState.getState().openedFolders;
		const initialFolderItem = getFilterItem(fixture.filterTree, workspace.srcFolder.id);

		assert.strictEqual(findFilterItemChildren(initialFolderItem), undefined);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.webviewFolder.id).length,
			0,
		);
		const expandButton = getFilterToggle(initialFolderItem);
		const expandEvent = createClickEvent(expandButton.asEventTarget(), 0, 0);

		fixture.filterTree.dispatch('click', expandEvent);
		const expandedFolderItem = getFilterItem(
			fixture.filterTree,
			workspace.srcFolder.id,
		);

		assert.ok(findFilterItemChildren(expandedFolderItem));
		assert.strictEqual(
			getFilterToggle(expandedFolderItem).getAttribute('aria-expanded'),
			'true',
		);
		assert.strictEqual(fixture.graphState.getState().openedFolders, openedFolders);
		assert.strictEqual(expandEvent.propagationStopped, true);
		const nestedFolderItem = getFilterItem(
			fixture.filterTree,
			workspace.webviewFolder.id,
		);

		assert.strictEqual(findFilterItemChildren(nestedFolderItem), undefined);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphViewFile.id).length,
			0,
		);
		const nestedExpandButton = getFilterToggle(nestedFolderItem);

		fixture.filterTree.dispatch(
			'click',
			createClickEvent(nestedExpandButton.asEventTarget(), 0, 0),
		);
		const expandedNestedFolder = getFilterItem(
			fixture.filterTree,
			workspace.webviewFolder.id,
		);

		assert.ok(findFilterItemChildren(expandedNestedFolder));
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphViewFile.id).length,
			1,
		);

		fixture.rootListButton.dispatch('click', {} as Event);
		assert.strictEqual(fixture.rootListPanel.hidden, false);
		assert.strictEqual(fixture.filterPanel.hidden, true);
		fixture.filterButton.dispatch('click', {} as Event);
		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(fixture.filterPanel.hidden, false);
		assert.strictEqual(
			getFilterToggle(getFilterItem(
				fixture.filterTree,
				workspace.webviewFolder.id,
			)).getAttribute('aria-expanded'),
			'true',
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphViewFile.id).length,
			1,
		);
		fixture.filterButton.dispatch('click', {} as Event);
		fixture.filterButton.dispatch('click', {} as Event);
		assert.strictEqual(
			getFilterToggle(getFilterItem(
				fixture.filterTree,
				workspace.webviewFolder.id,
			)).getAttribute('aria-expanded'),
			'true',
		);
		const nestedCollapseButton = getFilterToggle(getFilterItem(
			fixture.filterTree,
			workspace.webviewFolder.id,
		));

		fixture.filterTree.dispatch(
			'click',
			createClickEvent(nestedCollapseButton.asEventTarget(), 0, 0),
		);
		assert.strictEqual(
			findFilterItemChildren(getFilterItem(
				fixture.filterTree,
				workspace.webviewFolder.id,
			)),
			undefined,
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphViewFile.id).length,
			0,
		);

		const collapseButton = getFilterToggle(getFilterItem(
			fixture.filterTree,
			workspace.srcFolder.id,
		));
		fixture.filterTree.dispatch(
			'click',
			createClickEvent(collapseButton.asEventTarget(), 0, 0),
		);
		assert.strictEqual(
			findFilterItemChildren(getFilterItem(
				fixture.filterTree,
				workspace.srcFolder.id,
			)),
			undefined,
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.webviewFolder.id).length,
			0,
		);
		assert.strictEqual(fixture.graphState.getState().openedFolders, openedFolders);
	});

	test('File Checkbox는 hidden sparse record를 immutable하게 추가하고 제거한다', () => {
		const fixture = createNavigatorFixture();
		const workspace = createFilterWorkspaceFixture();

		fixture.navigator.setWorkspaceGraph(workspace.graph);
		const initialHiddenNodeIds = fixture.graphState.getState().hiddenNodeIds;
		const checkbox = getFilterCheckbox(
			fixture.filterTree,
			workspace.extensionFile.id,
		);

		assert.strictEqual(checkbox.checked, true);
		checkbox.checked = false;
		fixture.filterTree.dispatch('change', createChangeEvent(checkbox));

		const hiddenState = fixture.graphState.getState();

		assert.notStrictEqual(hiddenState.hiddenNodeIds, initialHiddenNodeIds);
		assert.deepStrictEqual(initialHiddenNodeIds, {});
		assert.deepStrictEqual(hiddenState.hiddenNodeIds, {
			[workspace.extensionFile.id]: true,
		});
		const restoredCheckbox = getFilterCheckbox(
			fixture.filterTree,
			workspace.extensionFile.id,
		);

		assert.strictEqual(restoredCheckbox.checked, false);
		restoredCheckbox.checked = true;
		fixture.filterTree.dispatch('change', createChangeEvent(restoredCheckbox));
		assert.deepStrictEqual(fixture.graphState.getState().hiddenNodeIds, {});
	});

	test('Folder Checkbox는 direct hidden과 descendant indeterminate를 계산하고 subtree 표시를 정리한다', () => {
		const fixture = createNavigatorFixture();
		const workspace = createFilterWorkspaceFixture();

		fixture.navigator.setWorkspaceGraph(workspace.graph);
		let srcCheckbox = getFilterCheckbox(fixture.filterTree, workspace.srcFolder.id);

		assert.strictEqual(srcCheckbox.checked, true);
		assert.strictEqual(srcCheckbox.indeterminate, false);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.webviewFolder.id).length,
			0,
		);
		const initialState = fixture.graphState.getState();

		fixture.graphState.setState({
			camera: initialState.camera,
			nodePositions: initialState.nodePositions,
			hiddenNodeIds: { [workspace.graphLayoutFile.id]: true },
		});
		srcCheckbox = getFilterCheckbox(fixture.filterTree, workspace.srcFolder.id);
		assert.strictEqual(srcCheckbox.checked, false);
		assert.strictEqual(srcCheckbox.indeterminate, true);
		assert.strictEqual(srcCheckbox.getAttribute('aria-checked'), 'mixed');

		fixture.graphState.setState({
			camera: initialState.camera,
			nodePositions: initialState.nodePositions,
			hiddenNodeIds: {},
		});
		srcCheckbox = getFilterCheckbox(fixture.filterTree, workspace.srcFolder.id);
		const beforeHide = fixture.graphState.getState().hiddenNodeIds;

		srcCheckbox.checked = false;
		fixture.filterTree.dispatch('change', createChangeEvent(srcCheckbox));
		assert.deepStrictEqual(beforeHide, {});
		assert.deepStrictEqual(fixture.graphState.getState().hiddenNodeIds, {
			[workspace.srcFolder.id]: true,
		});
		srcCheckbox = getFilterCheckbox(fixture.filterTree, workspace.srcFolder.id);
		assert.strictEqual(srcCheckbox.checked, false);
		assert.strictEqual(srcCheckbox.indeterminate, false);

		const hiddenState = fixture.graphState.getState();

		fixture.graphState.setState({
			camera: hiddenState.camera,
			nodePositions: hiddenState.nodePositions,
			hiddenNodeIds: {
				[workspace.srcFolder.id]: true,
				[workspace.webviewFolder.id]: true,
				[workspace.graphViewFile.id]: true,
				[workspace.graphLayoutFile.id]: true,
				'file:stale-outside-subtree': true,
			},
		});
		srcCheckbox = getFilterCheckbox(fixture.filterTree, workspace.srcFolder.id);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphViewFile.id).length,
			0,
		);
		srcCheckbox.checked = true;
		fixture.filterTree.dispatch('change', createChangeEvent(srcCheckbox));
		assert.deepStrictEqual(fixture.graphState.getState().hiddenNodeIds, {
			'file:stale-outside-subtree': true,
		});
	});

	test('Workspace Refresh는 최신 Tree와 새 File 기본 표시를 반영하고 stale hidden ID를 정리하지 않는다', () => {
		const fixture = createNavigatorFixture();
		const workspace = createFilterWorkspaceFixture();
		const state = fixture.graphState.getState();

		fixture.graphState.setState({
			camera: state.camera,
			nodePositions: state.nodePositions,
			hiddenNodeIds: {
				[workspace.extensionFile.id]: true,
				'file:deleted.ts': true,
			},
		});
		fixture.navigator.setWorkspaceGraph(workspace.graph);
		fixture.filterButton.dispatch('click', {} as Event);
		const srcToggle = getFilterToggle(getFilterItem(
			fixture.filterTree,
			workspace.srcFolder.id,
		));

		fixture.filterTree.dispatch(
			'click',
			createClickEvent(srcToggle.asEventTarget(), 0, 0),
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.webviewFolder.id).length,
			1,
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphViewFile.id).length,
			0,
		);
		const newFile = {
			kind: 'file' as const,
			id: 'file:new.ts',
			name: 'new.ts',
		};
		const refreshedProject: Project = {
			...workspace.frontendProject,
			children: [workspace.srcFolder, workspace.extensionFile, newFile],
		};
		const refreshedGraph: Graph = {
			roots: [{ id: 'root:frontend', nodeId: refreshedProject.id }],
			rootNodes: { [refreshedProject.id]: refreshedProject },
		};

		fixture.navigator.setWorkspaceGraph(refreshedGraph);

		assert.strictEqual(fixture.rootListPanel.hidden, true);
		assert.strictEqual(fixture.filterPanel.hidden, false);
		assert.strictEqual(fixture.rootListButton.hasClass('is-active'), false);
		assert.strictEqual(fixture.filterButton.hasClass('is-active'), true);
		assert.strictEqual(
			getFilterToggle(getFilterItem(
				fixture.filterTree,
				workspace.srcFolder.id,
			)).getAttribute('aria-expanded'),
			'true',
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.webviewFolder.id).length,
			1,
		);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, workspace.graphViewFile.id).length,
			0,
		);
		assert.strictEqual(
			getFilterCheckbox(fixture.filterTree, workspace.extensionFile.id).checked,
			false,
		);
		assert.strictEqual(getFilterCheckbox(fixture.filterTree, newFile.id).checked, true);
		assert.strictEqual(
			getFilterItemsById(fixture.filterTree, 'file:deleted.ts').length,
			0,
		);
		assert.deepStrictEqual(fixture.graphState.getState().hiddenNodeIds, {
			[workspace.extensionFile.id]: true,
			'file:deleted.ts': true,
		});
	});

	test('Filter Panel 입력은 Camera Pan/Wheel로 전달되지 않고 dispose 후 Tree Listener가 제거된다', () => {
		const fixture = createNavigatorFixture();
		const workspace = createFilterWorkspaceFixture();

		fixture.navigator.setWorkspaceGraph(workspace.graph);
		const checkbox = getFilterCheckbox(
			fixture.filterTree,
			workspace.extensionFile.id,
		);
		const initialCamera = fixture.camera.getState();

		fixture.viewport.dispatch(
			'pointerdown',
			createPointerEvent(checkbox.asEventTarget(), 10, 10),
		);
		fixture.viewport.dispatch(
			'pointermove',
			createPointerEvent(checkbox.asEventTarget(), 160, 120),
		);
		fixture.viewport.dispatch(
			'pointerup',
			createPointerEvent(checkbox.asEventTarget(), 160, 120),
		);
		fixture.viewport.dispatch(
			'wheel',
			createWheelEvent(10, 10, -120, checkbox.asEventTarget()),
		);
		assert.deepStrictEqual(fixture.camera.getState(), initialCamera);

		fixture.navigator.dispose();
		checkbox.checked = false;
		fixture.filterTree.dispatch('change', createChangeEvent(checkbox));
		assert.deepStrictEqual(fixture.graphState.getState().hiddenNodeIds, {});
	});

	test('Camera Pan과 Wheel Zoom 상태 변경을 즉시 표시한다', () => {
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
		);
		const indicator = fixture.minimapViewportIndicator;
		const nodes = [...fixture.minimapNodeLayer.children];
		const edges = [...fixture.minimapEdgeLayer.children];
		const initialX = indicator.getAttribute('x');

		fixture.viewport.dispatch(
			'pointerdown',
			createPointerEvent(fixture.viewport.asEventTarget(), 10, 10),
		);
		fixture.viewport.dispatch(
			'pointermove',
			createPointerEvent(fixture.viewport.asEventTarget(), 130.6, -35.5),
		);
		fixture.viewport.dispatch(
			'pointerup',
			createPointerEvent(fixture.viewport.asEventTarget(), 130.6, -35.5),
		);
		assert.strictEqual(fixture.coordinate.textContent, '(121, -45)');
		assert.notStrictEqual(indicator.getAttribute('x'), initialX);
		assert.deepStrictEqual(fixture.minimapNodeLayer.children, nodes);
		assert.deepStrictEqual(fixture.minimapEdgeLayer.children, edges);
		const pannedWidth = Number(indicator.getAttribute('width'));

		fixture.viewport.dispatch('wheel', createWheelEvent(400, 300, -120));
		assert.strictEqual(
			fixture.scale.textContent,
			`${Math.round(fixture.camera.getState().scale * 100)}%`,
		);
		assert.notStrictEqual(fixture.scale.textContent, '100%');
		assert.ok(Number(indicator.getAttribute('width')) < pannedWidth);
		assert.deepStrictEqual(fixture.minimapNodeLayer.children, nodes);
		assert.deepStrictEqual(fixture.minimapEdgeLayer.children, edges);
	});

	test('Zoom 버튼은 범위 안에서 scale을 0.1씩 Viewport 중앙 기준으로 변경한다', () => {
		const fixture = createNavigatorFixture({ x: 70, y: -20, scale: 1.2 });
		const viewportCenter = { x: 400, y: 300 };
		const worldAtCenter = fixture.camera.viewportToWorld(viewportCenter);

		fixture.zoomInButton.dispatch('click', {} as Event);

		assert.ok(Math.abs(fixture.camera.getState().scale - 1.3) < 1e-10);
		assertPointAlmostEqual(
			fixture.camera.viewportToWorld(viewportCenter),
			worldAtCenter,
		);
		assert.strictEqual(fixture.scale.textContent, '130%');

		fixture.zoomOutButton.dispatch('click', {} as Event);
		assert.ok(Math.abs(fixture.camera.getState().scale - 1.2) < 1e-10);
		assertPointAlmostEqual(
			fixture.camera.viewportToWorld(viewportCenter),
			worldAtCenter,
		);

		fixture.graphState.setState({
			camera: { x: 1, y: 2, scale: MIN_CAMERA_SCALE },
			nodePositions: {},
		});
		fixture.zoomOutButton.dispatch('click', {} as Event);
		assert.strictEqual(fixture.camera.getState().scale, MIN_CAMERA_SCALE);

		fixture.graphState.setState({
			camera: { x: 1, y: 2, scale: MAX_CAMERA_SCALE },
			nodePositions: {},
		});
		fixture.zoomInButton.dispatch('click', {} as Event);
		assert.strictEqual(fixture.camera.getState().scale, MAX_CAMERA_SCALE);
	});

	test('Zoom Control에서 시작한 Pointer 입력은 Camera Pan을 시작하지 않는다', () => {
		const fixture = createNavigatorFixture();

		fixture.viewport.dispatch(
			'pointerdown',
			createPointerEvent(fixture.zoomInButton.asEventTarget()),
		);
		fixture.viewport.dispatch(
			'pointermove',
			createPointerEvent(fixture.zoomInButton.asEventTarget(), 40, 30),
		);

		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);
	});

	test('Minimap에서 시작한 Pointer와 Wheel 입력은 Camera Pan과 Zoom을 시작하지 않는다', () => {
		const fixture = createNavigatorFixture();
		const initialCamera = fixture.camera.getState();

		fixture.viewport.dispatch(
			'pointerdown',
			createPointerEvent(fixture.minimap.asEventTarget()),
		);
		fixture.viewport.dispatch(
			'pointermove',
			createPointerEvent(fixture.minimap.asEventTarget(), 80, 70),
		);
		fixture.viewport.dispatch(
			'wheel',
			createWheelEvent(80, 70, -120, fixture.minimap.asEventTarget()),
		);

		assert.deepStrictEqual(fixture.camera.getState(), initialCamera);
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);
	});

	test('Action Rail과 Root Button에서 시작한 Pointer 입력은 Camera Pan을 시작하지 않는다', () => {
		const fixture = createNavigatorFixture();

		fixture.navigator.setRoots([{
			rootId: 'root:project',
			nodeId: 'project:crispy',
			name: 'crispy',
			kind: 'project',
		}]);
		const rootButton = getRootButton(getChild(fixture.rootList, 0));

		fixture.viewport.dispatch(
			'pointerdown',
			createPointerEvent(fixture.rootListButton.asEventTarget()),
		);
		fixture.viewport.dispatch(
			'pointermove',
			createPointerEvent(fixture.rootListButton.asEventTarget(), 40, 30),
		);
		fixture.rootListButton.dispatch('click', {} as Event);
		fixture.viewport.dispatch(
			'pointerdown',
			createPointerEvent(rootButton.asEventTarget()),
		);

		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);
	});

	test('getState에서 복원한 Camera의 Zoom 변경을 Session State로 다시 저장한다', () => {
		let savedState: WebviewSessionState | undefined = {
			panel: { ...DEFAULT_PANEL_LAYOUT_STATE },
			camera: { x: 513, y: 324, scale: 1.2 },
		};
		const api: WebviewStateApi = {
			getState: () => savedState,
			setState: (state) => {
				savedState = state;
			},
		};
		const restoredState = restoreWebviewState(api);
		const fixture = createNavigatorFixture(restoredState.graph.camera);
		const unsubscribe = fixture.graphState.subscribe((graph) => {
			saveWebviewState(api, {
				panel: restoredState.panel,
				camera: graph.camera,
			});
		});

		assert.strictEqual(fixture.coordinate.textContent, '(513, 324)');
		assert.strictEqual(fixture.scale.textContent, '120%');
		fixture.zoomInButton.dispatch('click', {} as Event);

		assert.deepStrictEqual(savedState?.camera, fixture.camera.getState());
		assert.ok(Math.abs((savedState?.camera.scale ?? 0) - 1.3) < 1e-10);
		unsubscribe();
	});

	test('dispose 이후 State 구독과 Action/Zoom 버튼 Listener를 정리한다', () => {
		const fixture = createNavigatorFixture(
			undefined,
			{},
			createLargeMinimapLayout(),
		);
		const displayedCoordinate = fixture.coordinate.textContent;
		const displayedMinimapNodes = [...fixture.minimapNodeLayer.children];
		const displayedIndicator = readRectAttributes(
			fixture.minimapViewportIndicator,
		);
		fixture.rootListButton.dispatch('click', {} as Event);

		fixture.navigator.dispose();
		fixture.navigator.dispose();
		fixture.navigator.setLayout(createEmptyLayout());
		assert.strictEqual(fixture.overlay.children.length, 0);

		fixture.graphState.setState({
			camera: { x: 50, y: 60, scale: 2 },
			nodePositions: {},
		});
		assert.strictEqual(fixture.coordinate.textContent, displayedCoordinate);
		assert.deepStrictEqual(
			fixture.minimapNodeLayer.children,
			displayedMinimapNodes,
		);
		assert.deepStrictEqual(
			readRectAttributes(fixture.minimapViewportIndicator),
			displayedIndicator,
		);

		fixture.zoomInButton.dispatch('click', {} as Event);
		assert.deepStrictEqual(fixture.camera.getState(), { x: 50, y: 60, scale: 2 });

		fixture.rootListButton.dispatch('click', {} as Event);
		assert.strictEqual(fixture.rootListPanel.hidden, false);
		assert.strictEqual(
			fixture.rootListButton.getAttribute('aria-expanded'),
			'true',
		);
	});
});

function createNavigatorFixture(
	initialCamera = { x: 0, y: 0, scale: 1 },
	interactions: GraphNavigatorInteractions = {},
	initialLayout: GraphLayout = createEmptyLayout(),
	animationFrameScheduler?: GraphAnimationFrameScheduler,
	getVisibleGraphArea?: GraphVisibleAreaProvider,
) {
	const ownerDocument = new FakeDocument();
	const viewport = ownerDocument.createSizedElement(800, 600);
	const world = ownerDocument.createElement();
	const overlay = ownerDocument.createElement();
	const graphState = createGraphState({
		camera: initialCamera,
		nodePositions: {},
	});
	const camera = initializeGraphCamera(
		viewport.asHtmlElement(),
		world.asHtmlElement(),
		graphState,
		{ animationFrameScheduler, getVisibleGraphArea },
	);
	const navigator = initializeGraphNavigator(
		overlay.asHtmlElement(),
		viewport.asHtmlElement(),
		graphState,
		camera,
		initialLayout,
		interactions,
		getVisibleGraphArea,
	);
	const navigatorElement = getChild(overlay, 0);
	const bottomRow = getChild(navigatorElement, 0);
	const minimap = getChild(bottomRow, 0);
	const minimapSvg = getChild(minimap, 0);
	const minimapEdgeLayer = getChild(minimapSvg, 0);
	const minimapNodeLayer = getChild(minimapSvg, 1);
	const minimapViewportLayer = getChild(minimapSvg, 2);
	const minimapViewportIndicator = getChild(minimapViewportLayer, 0);
	const zoom = getChild(bottomRow, 1);
	const coordinate = getChild(zoom, 0);
	const controls = getChild(zoom, 1);
	const featureRow = getChild(navigatorElement, 1);
	const rootListPanel = getChild(featureRow, 0);
	const rootListTitle = getChild(rootListPanel, 0);
	const rootList = getChild(rootListPanel, 1);
	const rootListEmpty = getChild(rootListPanel, 2);
	const actionRail = getChild(featureRow, 1);
	const rootListButton = getChild(actionRail, 0);
	const rootListIcon = getChild(rootListButton, 0);
	const filterButton = getChild(actionRail, 1);
	const filterIcon = getChild(filterButton, 0);
	const filterPanel = getChild(featureRow, 2);
	const filterTitle = getChild(filterPanel, 0);
	const filterTree = getChild(filterPanel, 1);
	const zoomOutButton = getChild(controls, 0);
	const scale = getChild(controls, 1);
	const zoomInButton = getChild(controls, 2);

	return {
		viewport,
		overlay,
		graphState,
		camera,
		navigator,
		navigatorElement,
		bottomRow,
		minimap,
		minimapSvg,
		minimapEdgeLayer,
		minimapNodeLayer,
		minimapViewportLayer,
		minimapViewportIndicator,
		zoom,
		featureRow,
		actionRail,
		rootListPanel,
		rootListTitle,
		rootList,
		rootListEmpty,
		rootListButton,
		rootListIcon,
		filterButton,
		filterIcon,
		filterPanel,
		filterTitle,
		filterTree,
		coordinate,
		controls,
		zoomOutButton,
		scale,
		zoomInButton,
	};
}

function getChild(element: FakeElement, index: number): FakeElement {
	const child = element.children[index];

	assert.ok(child);
	return child;
}

function getRootButton(item: FakeElement): FakeElement {
	return getChild(item, 0);
}

function getRootIcon(item: FakeElement): FakeElement {
	return getChild(getRootButton(item), 0);
}

function getRootContent(item: FakeElement): FakeElement {
	return getChild(getRootButton(item), 1);
}

function getFilterItemsById(root: FakeElement, nodeId: string): FakeElement[] {
	return getDescendantsByAttribute(root, 'data-filter-node-id', nodeId);
}

function getFilterItem(root: FakeElement, nodeId: string): FakeElement {
	const items = getFilterItemsById(root, nodeId);

	assert.strictEqual(items.length, 1);
	return items[0] as FakeElement;
}

function getFilterItemRow(item: FakeElement): FakeElement {
	return getChild(item, 0);
}

function findFilterItemChildren(item: FakeElement): FakeElement | undefined {
	return item.children.find((child) => (
		child.hasClass('graph-navigator-filter-children')
	));
}

function getFilterToggle(item: FakeElement): FakeElement {
	const toggle = getFilterItemRow(item).children.find((child) => (
		child.hasAttribute('data-filter-toggle-id')
	));

	assert.ok(toggle);
	return toggle;
}

function getFilterCheckbox(root: FakeElement, nodeId: string): FakeElement {
	const checkbox = getDescendantsByAttribute(
		root,
		'data-filter-checkbox-id',
		nodeId,
	);

	assert.strictEqual(checkbox.length, 1);
	return checkbox[0] as FakeElement;
}

function getFilterItemName(item: FakeElement): string {
	const names = getDescendantsByClass(item, 'graph-navigator-filter-name');

	assert.ok(names[0]);
	return names[0].textContent;
}

function getFilterNodeKinds(root: FakeElement): string[] {
	return getDescendantsByAttributeName(root, 'data-filter-node-kind')
		.map((item) => item.getAttribute('data-filter-node-kind') ?? '');
}

function getDescendantsByAttribute(
	root: FakeElement,
	attributeName: string,
	attributeValue: string,
): FakeElement[] {
	return root.children.flatMap((child) => [
		...(child.getAttribute(attributeName) === attributeValue ? [child] : []),
		...getDescendantsByAttribute(child, attributeName, attributeValue),
	]);
}

function getDescendantsByAttributeName(
	root: FakeElement,
	attributeName: string,
): FakeElement[] {
	return root.children.flatMap((child) => [
		...(child.hasAttribute(attributeName) ? [child] : []),
		...getDescendantsByAttributeName(child, attributeName),
	]);
}

function getDescendantsByClass(root: FakeElement, className: string): FakeElement[] {
	return root.children.flatMap((child) => [
		...(child.hasClass(className) ? [child] : []),
		...getDescendantsByClass(child, className),
	]);
}

function createFilterWorkspaceFixture() {
	const graphViewFile = {
		kind: 'file' as const,
		id: 'file:frontend/src/webview/graphView.ts',
		name: 'graphView.ts',
	};
	const graphLayoutFile = {
		kind: 'file' as const,
		id: 'file:frontend/src/webview/graphLayout.ts',
		name: 'graphLayout.ts',
	};
	const webviewFolder = {
		kind: 'folder' as const,
		id: 'folder:frontend/src/webview',
		name: 'webview',
		status: 'loaded' as const,
		children: [graphViewFile, graphLayoutFile],
	};
	const srcFolder = {
		kind: 'folder' as const,
		id: 'folder:frontend/src',
		name: 'src',
		status: 'loaded' as const,
		children: [webviewFolder],
	};
	const extensionFile = {
		kind: 'file' as const,
		id: 'file:frontend/extension.ts',
		name: 'extension.ts',
	};
	const frontendProject: Project = {
		kind: 'project',
		id: 'project:frontend',
		name: 'frontend',
		status: 'loaded',
		children: [srcFolder, extensionFile],
	};
	const packageFile = {
		kind: 'file' as const,
		id: 'file:backend/package.json',
		name: 'package.json',
	};
	const backendProject: Project = {
		kind: 'project',
		id: 'project:backend',
		name: 'backend',
		status: 'loaded',
		children: [packageFile],
	};
	const graph: Graph = {
		roots: [
			{ id: 'root:frontend', nodeId: frontendProject.id },
			{ id: 'root:backend', nodeId: backendProject.id },
		],
		rootNodes: {
			[frontendProject.id]: frontendProject,
			[backendProject.id]: backendProject,
		},
	};

	return {
		graph,
		frontendProject,
		backendProject,
		srcFolder,
		webviewFolder,
		graphViewFile,
		graphLayoutFile,
		extensionFile,
		packageFile,
	};
}

function createChangeEvent(
	target: FakeElement,
): Event & { readonly propagationStopped: boolean } {
	let propagationStopped = false;

	return {
		target: target.asEventTarget(),
		preventDefault: () => undefined,
		stopPropagation: () => {
			propagationStopped = true;
		},
		get propagationStopped() {
			return propagationStopped;
		},
	} as unknown as Event & { readonly propagationStopped: boolean };
}

function createPointerEvent(
	target: EventTarget,
	clientX = 10,
	clientY = 10,
	pointerId = 1,
	button = 0,
	isPrimary = true,
): PointerEvent & { defaultPrevented: boolean; propagationStopped: boolean } {
	let defaultPrevented = false;
	let propagationStopped = false;

	return {
		isPrimary,
		button,
		pointerId,
		clientX,
		clientY,
		target,
		preventDefault: () => {
			defaultPrevented = true;
		},
		stopPropagation: () => {
			propagationStopped = true;
		},
		get defaultPrevented() {
			return defaultPrevented;
		},
		get propagationStopped() {
			return propagationStopped;
		},
	} as PointerEvent & {
		defaultPrevented: boolean;
		propagationStopped: boolean;
	};
}

function createClickEvent(
	target: EventTarget,
	clientX: number,
	clientY: number,
): MouseEvent & { defaultPrevented: boolean; propagationStopped: boolean } {
	let defaultPrevented = false;
	let propagationStopped = false;

	return {
		target,
		clientX,
		clientY,
		preventDefault: () => {
			defaultPrevented = true;
		},
		stopPropagation: () => {
			propagationStopped = true;
		},
		get defaultPrevented() {
			return defaultPrevented;
		},
		get propagationStopped() {
			return propagationStopped;
		},
	} as MouseEvent & {
		defaultPrevented: boolean;
		propagationStopped: boolean;
	};
}

function createWheelEvent(
	clientX: number,
	clientY: number,
	deltaY: number,
	target: EventTarget | null = null,
): WheelEvent {
	return {
		clientX,
		clientY,
		deltaY,
		deltaMode: 0,
		target,
		preventDefault: () => undefined,
	} as WheelEvent;
}

function assertPointAlmostEqual(
	actual: { x: number; y: number },
	expected: { x: number; y: number },
): void {
	assert.ok(Math.abs(actual.x - expected.x) < 1e-10);
	assert.ok(Math.abs(actual.y - expected.y) < 1e-10);
}

type GraphEventListener = (event: never) => void;

class FakeDocument {
	createElement(tagName = 'div'): FakeElement {
		return new FakeElement(this, 160, 96, tagName.toUpperCase());
	}

	createElementNS(_namespace: string, qualifiedName: string): FakeElement {
		return qualifiedName === 'svg'
			? new FakeElement(this, 160, 96, 'SVG')
			: new FakeElement(this, 0, 0, qualifiedName.toUpperCase());
	}

	createSizedElement(clientWidth: number, clientHeight: number): FakeElement {
		return new FakeElement(this, clientWidth, clientHeight, 'DIV');
	}
}

function createEmptyLayout(): GraphLayout {
	return {
		nodes: [],
		edges: [],
		rootContexts: {},
		rootNodeIds: new Set(),
		arrangedNodeIds: new Set(),
		unarrangedNodeIds: new Set(),
	};
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly style = {
		transform: '',
		backgroundPosition: '',
		backgroundSize: '',
	};
	readonly classList = {
		add: (...tokens: string[]) => {
			for (const token of tokens) {
				this.classNames.add(token);
			}
		},
		remove: (...tokens: string[]) => {
			for (const token of tokens) {
				this.classNames.delete(token);
			}
		},
	};
	className = '';
	checked = false;
	hidden = false;
	id = '';
	indeterminate = false;
	textContent = '';
	title = '';
	type = '';
	private readonly attributes = new Map<string, string>();
	private readonly classNames = new Set<string>();
	private readonly listeners = new Map<string, Set<GraphEventListener>>();
	private readonly capturedPointers = new Set<number>();
	private parent: FakeElement | undefined;
	public boundsLeft = 0;
	public boundsTop = 0;

	constructor(
		readonly ownerDocument: FakeDocument,
		public clientWidth = 0,
		public clientHeight = 0,
		readonly tagName = 'DIV',
	) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	asEventTarget(): EventTarget {
		return this as unknown as EventTarget;
	}

	append(...children: FakeElement[]): void {
		for (const child of children) {
			child.parent = this;
			this.children.push(child);
		}
	}

	replaceChildren(...children: FakeElement[]): void {
		for (const child of this.children) {
			child.parent = undefined;
		}
		this.children.length = 0;
		this.append(...children);
	}

	remove(): void {
		if (!this.parent) {
			return;
		}

		const index = this.parent.children.indexOf(this);

		if (index >= 0) {
			this.parent.children.splice(index, 1);
		}
	}

	setAttribute(name: string, value = ''): void {
		this.attributes.set(name, value);
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	closest(selector: string): FakeElement | null {
		const attribute = selector.slice(1, -1);

		if (this.attributes.has(attribute)) {
			return this;
		}

		return this.parent?.closest(selector) ?? null;
	}

	hasClass(className: string): boolean {
		return this.classNames.has(className)
			|| this.className.split(/\s+/).includes(className);
	}

	addEventListener(type: string, listener: GraphEventListener): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: GraphEventListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatch(type: string, event: Event): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event as never);
		}
	}

	setPointerCapture(pointerId: number): void {
		this.capturedPointers.add(pointerId);
	}

	hasPointerCapture(pointerId: number): boolean {
		return this.capturedPointers.has(pointerId);
	}

	releasePointerCapture(pointerId: number): void {
		this.capturedPointers.delete(pointerId);
	}

	losePointerCapture(pointerId: number): void {
		this.capturedPointers.delete(pointerId);
		this.dispatch(
			'lostpointercapture',
			createPointerEvent(this.asEventTarget(), 0, 0, pointerId),
		);
	}

	getBoundingClientRect(): DOMRect {
		return {
			x: this.boundsLeft,
			y: this.boundsTop,
			left: this.boundsLeft,
			top: this.boundsTop,
			right: this.boundsLeft + this.clientWidth,
			bottom: this.boundsTop + this.clientHeight,
			width: this.clientWidth,
			height: this.clientHeight,
			toJSON: () => ({}),
		};
	}
}

function createMinimapNode(
	id: string,
	x: number,
	y: number,
): GraphLayoutNode {
	return {
		kind: 'folder',
		id,
		name: id,
		status: 'loaded',
		depth: 0,
		position: { x, y },
		width: 100,
		height: 40,
	};
}

function createMinimapLayout(
	nodes: readonly GraphLayoutNode[],
	edges: readonly GraphLayoutEdge[] = [],
): GraphLayout {
	return {
		nodes,
		edges,
		rootContexts: {},
		rootNodeIds: new Set(),
		arrangedNodeIds: new Set(nodes.map((node) => node.id)),
		unarrangedNodeIds: new Set(),
	};
}

function createLargeMinimapLayout(): GraphLayout {
	return createMinimapLayout([
		createMinimapNode('node:large-a', 0, 0),
		createMinimapNode('node:large-b', 2_000, 1_200),
	], [{
		id: 'edge:large',
		sourceId: 'node:large-a',
		targetId: 'node:large-b',
	}]);
}

function readRectAttributes(element: FakeElement): Record<string, string | null> {
	return {
		x: element.getAttribute('x'),
		y: element.getAttribute('y'),
		width: element.getAttribute('width'),
		height: element.getAttribute('height'),
		visibility: element.getAttribute('visibility'),
	};
}

function readIndicatorCenter(element: FakeElement): { x: number; y: number } {
	return {
		x: Number(element.getAttribute('x'))
			+ Number(element.getAttribute('width')) / 2,
		y: Number(element.getAttribute('y'))
			+ Number(element.getAttribute('height')) / 2,
	};
}

function getChildByAttribute(
	element: FakeElement,
	attribute: string,
	value: string,
): FakeElement {
	const child = element.children.find(
		(candidate) => candidate.getAttribute(attribute) === value,
	);

	assert.ok(child);
	return child;
}

function getDescendantsByTagName(
	element: FakeElement,
	tagName: string,
): FakeElement[] {
	return element.children.flatMap((child) => [
		...(child.tagName === tagName ? [child] : []),
		...getDescendantsByTagName(child, tagName),
	]);
}

class FakeAnimationFrameScheduler implements GraphAnimationFrameScheduler {
	private nextRequestId = 1;
	private readonly callbacks = new Map<number, FrameRequestCallback>();
	cancelCount = 0;

	get pendingCount(): number {
		return this.callbacks.size;
	}

	request(callback: FrameRequestCallback): number {
		const requestId = this.nextRequestId;

		this.nextRequestId += 1;
		this.callbacks.set(requestId, callback);
		return requestId;
	}

	cancel(requestId: number): void {
		if (this.callbacks.delete(requestId)) {
			this.cancelCount += 1;
		}
	}
}

class FakeResizeObserver {
	private static instances: FakeResizeObserver[] = [];
	private readonly observedElements = new Set<Element>();

	constructor(private readonly callback: ResizeObserverCallback) {
		FakeResizeObserver.instances.push(this);
	}

	static reset(): void {
		FakeResizeObserver.instances = [];
	}

	static getInstanceCount(): number {
		return FakeResizeObserver.instances.length;
	}

	static isObserving(target: FakeElement): boolean {
		const element = target.asHtmlElement();

		return FakeResizeObserver.instances.some(
			(observer) => observer.observedElements.has(element),
		);
	}

	static trigger(target: FakeElement): void {
		const element = target.asHtmlElement();

		for (const observer of FakeResizeObserver.instances) {
			if (!observer.observedElements.has(element)) {
				continue;
			}

			observer.callback(
				[{
					target: element,
					contentRect: target.getBoundingClientRect(),
				} as unknown as ResizeObserverEntry],
				observer as unknown as ResizeObserver,
			);
		}
	}

	observe(target: Element): void {
		this.observedElements.add(target);
	}

	disconnect(): void {
		this.observedElements.clear();
	}

	unobserve(target: Element): void {
		this.observedElements.delete(target);
	}
}
