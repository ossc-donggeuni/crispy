import * as assert from 'assert';
import {
	createCenteredGraphCameraState,
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE,
	initializeGraphCamera,
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
	type GraphAnimationFrameScheduler,
} from '../../webview/graph/graphCamera';
import { initializeGraphNodeDrag } from '../../webview/graph/graphNodeDrag';
import { createGraphState } from '../../webview/graph/graphState';
import {
	calculateGraphVisibleArea,
	type GraphVisibleAreaProvider,
} from '../../webview/graph/graphVisibleArea';

suite('Graph Camera', () => {
	test('초기 상태와 setState를 graph-world transform에 적용한다', () => {
		const fixture = createCameraFixture();

		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.deepStrictEqual(fixture.graphState.getState().camera, {
			x: 0,
			y: 0,
			scale: 1,
		});
		assert.strictEqual(
			fixture.world.style.transform,
			'translate(0px, 0px) scale(1)',
		);

		fixture.camera.setState({ x: 120, y: -45, scale: 1.5 });

		assert.deepStrictEqual(fixture.camera.getState(), { x: 120, y: -45, scale: 1.5 });
		assert.deepStrictEqual(fixture.graphState.getState().camera, {
			x: 120,
			y: -45,
			scale: 1.5,
		});
		assert.strictEqual(
			fixture.world.style.transform,
			'translate(120px, -45px) scale(1.5)',
		);
	});

	test('setState의 scale을 최소 및 최대 범위로 제한한다', () => {
		const fixture = createCameraFixture();

		fixture.camera.setState({ x: 1, y: 2, scale: 0 });
		assert.strictEqual(fixture.camera.getState().scale, MIN_CAMERA_SCALE);

		fixture.camera.setState({ x: 1, y: 2, scale: 100 });
		assert.strictEqual(fixture.camera.getState().scale, MAX_CAMERA_SCALE);
	});

	test('viewport 좌표와 world 좌표를 Camera 상태 기준으로 상호 변환한다', () => {
		const fixture = createCameraFixture();
		fixture.graphState.setState({
			camera: { x: 100, y: -40, scale: 2 },
			nodePositions: {},
		});

		assert.deepStrictEqual(
			fixture.camera.worldToViewport({ x: 25, y: 30 }),
			{ x: 150, y: 20 },
		);
		assert.deepStrictEqual(
			fixture.camera.viewportToWorld({ x: 150, y: 20 }),
			{ x: 25, y: 30 },
		);
	});

	test('World Target을 Viewport 중앙에 놓는 Camera State를 기존 focusOn 규칙으로 계산한다', () => {
		assert.deepStrictEqual(createCenteredGraphCameraState(
			{ x: 100, y: 200 },
			{ width: 800, height: 600 },
			1.5,
		), { x: 250, y: 0, scale: 1.5 });
		assert.strictEqual(createCenteredGraphCameraState(
			{ x: Number.NaN, y: 200 },
			{ width: 800, height: 600 },
			1.5,
		), undefined);
		assert.strictEqual(createCenteredGraphCameraState(
			{ x: 100, y: 200 },
			{ width: 800, height: 600 },
			0,
		), undefined);
	});

	test('기본 Pointer Drag로 Pan하고 종료 시 Capture와 Drag 상태를 정리한다', () => {
		const fixture = createCameraFixture();
		fixture.camera.setState({ x: 10, y: 20, scale: 1.5 });

		fixture.viewport.dispatch('pointerdown', createPointerEvent(100, 80));
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), true);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), true);

		fixture.viewport.dispatch('pointermove', createPointerEvent(145, 50));
		assert.deepStrictEqual(fixture.camera.getState(), { x: 55, y: -10, scale: 1.5 });
		assert.deepStrictEqual(fixture.graphState.getState().camera, {
			x: 55,
			y: -10,
			scale: 1.5,
		});

		fixture.viewport.dispatch('pointerup', createPointerEvent(145, 50));
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);

		fixture.viewport.dispatch('pointermove', createPointerEvent(200, 200));
		assert.deepStrictEqual(fixture.camera.getState(), { x: 55, y: -10, scale: 1.5 });
	});

	test('활성 Pointer와 다른 Pointer 이벤트 및 기본 버튼이 아닌 입력을 무시한다', () => {
		const fixture = createCameraFixture();

		fixture.viewport.dispatch('pointerdown', createPointerEvent(10, 10, 1, 1));
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);

		fixture.viewport.dispatch('pointerdown', createPointerEvent(10, 10));
		fixture.viewport.dispatch('pointermove', createPointerEvent(30, 40, 2));
		fixture.viewport.dispatch('pointerup', createPointerEvent(30, 40, 2));

		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), true);

		fixture.viewport.dispatch('pointercancel', createPointerEvent(10, 10));
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);
	});

	test('Camera 입력 차단 속성이 지정된 요소에서 Pointer Drag로 Pan하지 않는다', () => {
		const fixture = createCameraFixture();
		const interactiveElement = new FakeElement();
		interactiveElement.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE);

		fixture.viewport.dispatch(
			'pointerdown',
			createPointerEvent(10, 10, 1, 0, interactiveElement.asEventTarget()),
		);
		fixture.viewport.dispatch('pointermove', createPointerEvent(30, 40));

		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);
	});

	test('Pan 전용 차단 요소에서는 Pointer Pan을 막고 Wheel Pan과 Zoom Gesture는 허용한다', () => {
		const fixture = createCameraFixture();
		const interactiveElement = new FakeElement();
		interactiveElement.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE);

		fixture.viewport.dispatch(
			'pointerdown',
			createPointerEvent(10, 10, 1, 0, interactiveElement.asEventTarget()),
		);
		fixture.viewport.dispatch('pointermove', createPointerEvent(30, 40));

		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);

		const wheelEvent = createWheelEvent(
			100,
			100,
			30,
			interactiveElement.asEventTarget(),
			{ deltaX: -20 },
		);
		fixture.viewport.dispatch('wheel', wheelEvent);

		assert.deepStrictEqual(fixture.camera.getState(), { x: 20, y: -30, scale: 1 });
		assert.strictEqual(wheelEvent.defaultPrevented, true);

		const zoomEvent = createWheelEvent(
			100,
			100,
			-120,
			interactiveElement.asEventTarget(),
			{ ctrlKey: true },
		);
		fixture.viewport.dispatch('wheel', zoomEvent);
		assert.ok(fixture.camera.getState().scale > 1);
		assert.strictEqual(zoomEvent.defaultPrevented, true);
	});

	test('Camera 입력 차단 요소의 자식에서 발생한 Pointer와 Wheel 입력을 처리하지 않는다', () => {
		const fixture = createCameraFixture();
		const interactiveElement = new FakeElement();
		const child = new FakeElement();
		interactiveElement.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE);
		interactiveElement.append(child);

		fixture.viewport.dispatch(
			'pointerdown',
			createPointerEvent(10, 10, 1, 0, child.asEventTarget()),
		);
		fixture.viewport.dispatch('pointermove', createPointerEvent(30, 40));
		const wheelEvent = createWheelEvent(100, 100, -120, child.asEventTarget());
		fixture.viewport.dispatch('wheel', wheelEvent);

		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);
		assert.strictEqual(wheelEvent.defaultPrevented, false);
	});

	test('Camera 입력 차단 속성이 없는 일반 요소에서는 Pointer와 Wheel Pan이 동작한다', () => {
		const fixture = createCameraFixture();
		const graphElement = new FakeElement();

		fixture.viewport.dispatch(
			'pointerdown',
			createPointerEvent(10, 10, 1, 0, graphElement.asEventTarget()),
		);
		fixture.viewport.dispatch('pointermove', createPointerEvent(30, 40));
		fixture.viewport.dispatch('pointerup', createPointerEvent(30, 40));

		assert.deepStrictEqual(fixture.camera.getState(), { x: 20, y: 30, scale: 1 });

		fixture.viewport.dispatch(
			'wheel',
			createWheelEvent(100, 100, -120, graphElement.asEventTarget()),
		);
		assert.deepStrictEqual(fixture.camera.getState(), { x: 20, y: 150, scale: 1 });
	});

	test('Wheel Scroll은 X/Y/diagonal delta로 Pan하고 scale을 변경하지 않는다', () => {
		const fixture = createCameraFixture();

		fixture.viewport.dispatch('wheel', createWheelEvent(0, 0, 24));
		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: -24, scale: 1 });

		fixture.viewport.dispatch('wheel', createWheelEvent(
			0,
			0,
			0,
			null,
			{ deltaX: -18 },
		));
		assert.deepStrictEqual(fixture.camera.getState(), { x: 18, y: -24, scale: 1 });

		fixture.viewport.dispatch('wheel', createWheelEvent(
			0,
			0,
			-12,
			null,
			{ deltaX: 7 },
		));
		assert.deepStrictEqual(fixture.camera.getState(), { x: 11, y: -12, scale: 1 });
	});

	test('Wheel line/page deltaMode를 X/Y viewport pixel로 정규화한다', () => {
		const fixture = createCameraFixture(800, 600);

		fixture.viewport.dispatch('wheel', createWheelEvent(
			0,
			0,
			2,
			null,
			{ deltaX: -1, deltaMode: 1 },
		));
		assert.deepStrictEqual(fixture.camera.getState(), { x: 16, y: -32, scale: 1 });

		fixture.viewport.dispatch('wheel', createWheelEvent(
			0,
			0,
			-1,
			null,
			{ deltaX: 1, deltaMode: 2 },
		));
		assert.deepStrictEqual(fixture.camera.getState(), { x: -784, y: 568, scale: 1 });
	});

	test('Zoom Gesture 전후 Cursor 아래 World 위치를 고정한다', () => {
		const fixture = createCameraFixture(800, 600, 40, 30);
		fixture.camera.setState({ x: 70, y: -20, scale: 1.25 });
		const cursor = { x: 250, y: 180 };
		const before = fixture.camera.viewportToWorld(cursor);
		const event = createWheelEvent(
			cursor.x + 40,
			cursor.y + 30,
			-120,
			null,
			{ ctrlKey: true },
		);

		fixture.viewport.dispatch('wheel', event);

		const after = fixture.camera.viewportToWorld(cursor);
		const graphCameraState = fixture.graphState.getState().camera;
		assert.ok(graphCameraState.scale > 1.25);
		assert.notStrictEqual(graphCameraState.x, 70);
		assert.notStrictEqual(graphCameraState.y, -20);
		assertPointAlmostEqual(after, before);
		assert.strictEqual(event.defaultPrevented, true);
	});

	test('외부 Graph State 변경을 World transform과 Grid에 즉시 반영한다', () => {
		const fixture = createCameraFixture();

		fixture.graphState.setState({
			camera: { x: -80, y: 65, scale: 2 },
			nodePositions: {},
		});

		assert.strictEqual(
			fixture.world.style.transform,
			'translate(-80px, 65px) scale(2)',
		);
		assert.strictEqual(fixture.viewport.style.backgroundPosition, '-80px 65px');
		assert.strictEqual(fixture.viewport.style.backgroundSize, '80px 80px');
	});

	test('focusOn은 scale을 유지하고 Root 중심을 향해 ease-out 보간한 뒤 정확히 완료한다', () => {
		const scheduler = new FakeAnimationFrameScheduler();
		const fixture = createCameraFixture(1000, 800, 0, 0, scheduler);

		fixture.camera.setState({ x: 10, y: 20, scale: 2 });
		fixture.camera.focusOn({ x: 100, y: 200 }, { duration: 300 });
		assert.strictEqual(scheduler.pendingCount, 1);
		assert.deepStrictEqual(fixture.camera.getState(), { x: 10, y: 20, scale: 2 });

		scheduler.runNext(0);
		assert.deepStrictEqual(fixture.camera.getState(), { x: 10, y: 20, scale: 2 });
		assert.strictEqual(scheduler.pendingCount, 1);

		scheduler.runNext(150);
		const intermediate = fixture.camera.getState();

		assert.ok(intermediate.x > 10 && intermediate.x < 300);
		assert.ok(intermediate.y < 20 && intermediate.y > 0);
		assert.ok(intermediate.x > 155);
		assert.strictEqual(intermediate.scale, 2);
		assert.strictEqual(scheduler.pendingCount, 1);

		scheduler.runNext(300);
		assert.deepStrictEqual(fixture.camera.getState(), {
			x: 300,
			y: 0,
			scale: 2,
		});
		assert.strictEqual(scheduler.pendingCount, 0);
	});

	test('focusOn은 호출 시점의 Visible Graph 중앙을 사용하고 Panel 변화도 다시 조회한다', () => {
		let visibleArea = calculateGraphVisibleArea(
			{ width: 1000, height: 800 },
			{ left: 0, top: 0, width: 1000, height: 800 },
			{ left: 528, top: 12, right: 988, bottom: 788, width: 460, height: 776 },
			'right',
			false,
		);
		const fixture = createCameraFixture(
			1000,
			800,
			0,
			0,
			undefined,
			() => visibleArea,
		);

		fixture.camera.setState({ x: 0, y: 0, scale: 2 });
		fixture.camera.focusOn({ x: 100, y: 200 }, { duration: 0 });
		assert.deepStrictEqual(fixture.camera.getState(), {
			x: 64,
			y: 0,
			scale: 2,
		});

		visibleArea = calculateGraphVisibleArea(
			{ width: 1000, height: 800 },
			{ left: 0, top: 0, width: 1000, height: 800 },
			{ left: 12, top: 12, right: 572, bottom: 788, width: 560, height: 776 },
			'left',
			false,
		);
		fixture.camera.focusOn({ x: 100, y: 200 }, { duration: 0 });
		assert.deepStrictEqual(fixture.camera.getState(), {
			x: 586,
			y: 0,
			scale: 2,
		});
	});

	test('새 focusOn은 기존 Frame을 취소하고 현재 Camera 상태에서 단일 Animation을 시작한다', () => {
		const scheduler = new FakeAnimationFrameScheduler();
		const fixture = createCameraFixture(1000, 800, 0, 0, scheduler);

		fixture.camera.focusOn({ x: 100, y: 100 }, { duration: 300 });
		scheduler.runNext(0);
		scheduler.runNext(100);
		const interruptedState = fixture.camera.getState();
		const cancelCount = scheduler.cancelCount;

		fixture.camera.focusOn({ x: 800, y: 600 }, { duration: 300 });
		assert.strictEqual(scheduler.cancelCount, cancelCount + 1);
		assert.strictEqual(scheduler.pendingCount, 1);
		scheduler.runNext(100);
		assert.deepStrictEqual(fixture.camera.getState(), interruptedState);
		scheduler.runNext(400);

		assert.deepStrictEqual(fixture.camera.getState(), {
			x: -300,
			y: -200,
			scale: 1,
		});
		assert.strictEqual(scheduler.pendingCount, 0);
		assert.ok(scheduler.maxPendingCount <= 1);
	});

	test('Focus Animation 중 사용자 Pan과 Zoom Gesture는 예약 Frame을 취소한다', () => {
		const panScheduler = new FakeAnimationFrameScheduler();
		const panFixture = createCameraFixture(1000, 800, 0, 0, panScheduler);

		panFixture.camera.focusOn({ x: 900, y: 700 });
		panScheduler.runNext(0);
		panScheduler.runNext(100);
		const beforePan = panFixture.camera.getState();

		panFixture.viewport.dispatch('pointerdown', createPointerEvent(10, 10));
		panFixture.viewport.dispatch('pointermove', createPointerEvent(40, 50));
		assert.strictEqual(panScheduler.pendingCount, 0);
		assert.deepStrictEqual(panFixture.camera.getState(), {
			x: beforePan.x + 30,
			y: beforePan.y + 40,
			scale: beforePan.scale,
		});

		const zoomScheduler = new FakeAnimationFrameScheduler();
		const zoomFixture = createCameraFixture(1000, 800, 0, 0, zoomScheduler);

		zoomFixture.camera.focusOn({ x: 900, y: 700 });
		zoomScheduler.runNext(0);
		zoomFixture.viewport.dispatch('wheel', createWheelEvent(
			200,
			160,
			-120,
			null,
			{ ctrlKey: true },
		));
		assert.strictEqual(zoomScheduler.pendingCount, 0);
		assert.ok(zoomFixture.camera.getState().scale > 1);
	});

	test('dispose는 Focus Animation을 취소하고 이후 Focus 갱신을 막는다', () => {
		const scheduler = new FakeAnimationFrameScheduler();
		const fixture = createCameraFixture(1000, 800, 0, 0, scheduler);

		fixture.camera.focusOn({ x: 400, y: 300 });
		assert.strictEqual(scheduler.pendingCount, 1);
		fixture.camera.dispose();
		assert.strictEqual(scheduler.pendingCount, 0);
		const disposedState = fixture.camera.getState();

		fixture.camera.focusOn({ x: 900, y: 700 });
		assert.strictEqual(scheduler.pendingCount, 0);
		assert.deepStrictEqual(fixture.camera.getState(), disposedState);
	});

	test('Zoom Gesture의 Zoom Out과 Zoom In을 scale 범위에서 제한한다', () => {
		const fixture = createCameraFixture();

		fixture.viewport.dispatch('wheel', createWheelEvent(
			100,
			100,
			100_000,
			null,
			{ ctrlKey: true },
		));
		assert.strictEqual(fixture.camera.getState().scale, MIN_CAMERA_SCALE);

		fixture.viewport.dispatch('wheel', createWheelEvent(
			100,
			100,
			-100_000,
			null,
			{ ctrlKey: true },
		));
		assert.strictEqual(fixture.camera.getState().scale, MAX_CAMERA_SCALE);
	});

	test('Camera 입력 차단 속성이 지정된 요소에서 Wheel로 Zoom하지 않는다', () => {
		const fixture = createCameraFixture();
		const interactiveElement = new FakeElement();
		interactiveElement.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE);
		const event = createWheelEvent(
			100,
			100,
			-120,
			interactiveElement.asEventTarget(),
		);

		fixture.viewport.dispatch('wheel', event);

		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(event.defaultPrevented, false);
	});

	test('Space + Node Drag는 Node 대신 Camera를 이동하고 Key Up 뒤 Node Drag를 복구한다', () => {
		const fixture = createCameraFixture();
		const node = new FakeElement();
		const nodeDrag = initializeGraphNodeDrag(
			node.asHtmlElement(),
			'node:test',
			{ x: 100, y: 80 },
			fixture.graphState,
		);

		node.classList.add('graph-node');
		fixture.ownerDocument.dispatch('keydown', createKeyboardEvent('Space', ' '));
		assert.strictEqual(fixture.viewport.hasClass('is-space-pan-mode'), true);

		const spacePointerDown = createPointerEvent(
			20,
			30,
			1,
			0,
			node.asEventTarget(),
		);
		fixture.viewport.dispatch('pointerdown', spacePointerDown);
		if (!spacePointerDown.propagationStopped) {
			node.dispatch('pointerdown', spacePointerDown);
		}
		fixture.viewport.dispatch('pointermove', createPointerEvent(70, 75));

		assert.deepStrictEqual(fixture.camera.getState(), { x: 50, y: 45, scale: 1 });
		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});
		assert.strictEqual(node.hasPointerCapture(1), false);
		assert.strictEqual(spacePointerDown.propagationStopped, true);

		fixture.ownerDocument.dispatch('keyup', createKeyboardEvent('Space', ' '));
		assert.strictEqual(fixture.viewport.hasClass('is-space-pan-mode'), false);
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);

		const nodePointerDown = createPointerEvent(
			20,
			30,
			1,
			0,
			node.asEventTarget(),
		);
		fixture.viewport.dispatch('pointerdown', nodePointerDown);
		if (!nodePointerDown.propagationStopped) {
			node.dispatch('pointerdown', nodePointerDown);
		}
		node.dispatch('pointermove', createPointerEvent(50, 60));
		node.dispatch('pointerup', createPointerEvent(50, 60));

		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {
			'node:test': { x: 130, y: 110 },
		});
		nodeDrag.dispose();
	});

	test('Space Pan은 Node 안쪽 UI와 text editing target을 계속 제외한다', () => {
		const fixture = createCameraFixture();
		const node = new FakeElement();
		const button = new FakeElement();
		const editor = new FakeElement();

		node.classList.add('graph-node');
		node.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE);
		button.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE);
		node.append(button);
		editor.setAttribute('contenteditable');

		const editorKeyDown = createKeyboardEvent('Space', ' ', editor.asEventTarget());
		fixture.ownerDocument.dispatch('keydown', editorKeyDown);
		assert.strictEqual(editorKeyDown.defaultPrevented, false);
		assert.strictEqual(fixture.viewport.hasClass('is-space-pan-mode'), false);

		fixture.ownerDocument.dispatch('keydown', createKeyboardEvent('Space', ' '));
		fixture.viewport.dispatch('pointerdown', createPointerEvent(
			10,
			10,
			1,
			0,
			button.asEventTarget(),
		));
		fixture.viewport.dispatch('pointermove', createPointerEvent(60, 50));

		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);
	});

	test('lostpointercapture와 dispose가 진행 상태 및 등록한 이벤트를 정리한다', () => {
		const fixture = createCameraFixture();

		fixture.viewport.dispatch('pointerdown', createPointerEvent(10, 10));
		fixture.viewport.losePointerCapture(1);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);

		fixture.ownerDocument.dispatch('keydown', createKeyboardEvent('Space', ' '));
		fixture.viewport.dispatch('pointerdown', createPointerEvent(10, 10));
		assert.strictEqual(fixture.viewport.hasClass('is-space-pan-mode'), true);
		fixture.camera.dispose();
		fixture.camera.dispose();
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);
		assert.strictEqual(fixture.viewport.hasClass('is-space-pan-mode'), false);
		assert.strictEqual(fixture.ownerDocument.listenerCount, 0);
		assert.strictEqual(fixture.ownerDocument.defaultView.listenerCount, 0);

		fixture.viewport.dispatch('pointerdown', createPointerEvent(10, 10));
		fixture.viewport.dispatch('pointermove', createPointerEvent(30, 40));
		fixture.viewport.dispatch('wheel', createWheelEvent(100, 100, -120));
		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });

		fixture.graphState.setState({
			camera: { x: 90, y: 70, scale: 2 },
			nodePositions: {},
		});
		assert.strictEqual(
			fixture.world.style.transform,
			'translate(0px, 0px) scale(1)',
		);
	});
});

function createCameraFixture(
	width = 1000,
	height = 800,
	left = 0,
	top = 0,
	animationFrameScheduler?: GraphAnimationFrameScheduler,
	getVisibleGraphArea?: GraphVisibleAreaProvider,
) {
	const ownerDocument = new FakeDocument();
	const viewport = new FakeElement(width, height, left, top, ownerDocument);
	const world = new FakeElement(1000, 800, 0, 0, ownerDocument);
	const graphState = createGraphState();
	const camera = initializeGraphCamera(
		viewport.asHtmlElement(),
		world.asHtmlElement(),
		graphState,
		{ animationFrameScheduler, getVisibleGraphArea },
	);

	return { viewport, world, camera, graphState, ownerDocument };
}

class FakeAnimationFrameScheduler implements GraphAnimationFrameScheduler {
	private nextRequestId = 1;
	private readonly callbacks = new Map<number, FrameRequestCallback>();
	cancelCount = 0;
	maxPendingCount = 0;

	get pendingCount(): number {
		return this.callbacks.size;
	}

	request(callback: FrameRequestCallback): number {
		const requestId = this.nextRequestId;

		this.nextRequestId += 1;
		this.callbacks.set(requestId, callback);
		this.maxPendingCount = Math.max(this.maxPendingCount, this.callbacks.size);
		return requestId;
	}

	cancel(requestId: number): void {
		if (this.callbacks.delete(requestId)) {
			this.cancelCount += 1;
		}
	}

	runNext(timestamp: number): void {
		const next = this.callbacks.entries().next().value as
			| [number, FrameRequestCallback]
			| undefined;

		assert.ok(next, '실행할 Animation Frame이 있어야 한다.');
		const [requestId, callback] = next;

		this.callbacks.delete(requestId);
		callback(timestamp);
	}
}

function createPointerEvent(
	clientX: number,
	clientY: number,
	pointerId = 1,
	button = 0,
	target: EventTarget | null = null,
): PointerEvent & { readonly propagationStopped: boolean } {
	let propagationStopped = false;

	return {
		isPrimary: true,
		button,
		pointerId,
		clientX,
		clientY,
		target,
		preventDefault: () => undefined,
		stopPropagation: () => {
			propagationStopped = true;
		},
		get propagationStopped() {
			return propagationStopped;
		},
	} as PointerEvent & { readonly propagationStopped: boolean };
}

function createWheelEvent(
	clientX: number,
	clientY: number,
	deltaY: number,
	target: EventTarget | null = null,
	options: {
		readonly ctrlKey?: boolean;
		readonly deltaX?: number;
		readonly deltaMode?: number;
	} = {},
): WheelEvent & {
	defaultPrevented: boolean;
} {
	let defaultPrevented = false;

	return {
		clientX,
		clientY,
		ctrlKey: options.ctrlKey ?? false,
		deltaX: options.deltaX ?? 0,
		deltaY,
		deltaMode: options.deltaMode ?? 0,
		target,
		preventDefault: () => {
			defaultPrevented = true;
		},
		get defaultPrevented() {
			return defaultPrevented;
		},
	} as WheelEvent & { defaultPrevented: boolean };
}

function createKeyboardEvent(
	code: string,
	key: string,
	target: EventTarget | null = null,
): KeyboardEvent & { readonly defaultPrevented: boolean } {
	let defaultPrevented = false;

	return {
		code,
		key,
		target,
		preventDefault: () => {
			defaultPrevented = true;
		},
		get defaultPrevented() {
			return defaultPrevented;
		},
	} as KeyboardEvent & { readonly defaultPrevented: boolean };
}

function assertPointAlmostEqual(
	actual: { x: number; y: number },
	expected: { x: number; y: number },
): void {
	assert.ok(Math.abs(actual.x - expected.x) < 1e-10);
	assert.ok(Math.abs(actual.y - expected.y) < 1e-10);
}

type GraphEvent = Event;
type GraphEventListener = (event: never) => void;

class FakeEventTarget {
	private readonly listeners = new Map<string, Set<GraphEventListener>>();

	get listenerCount(): number {
		return [...this.listeners.values()].reduce(
			(count, listeners) => count + listeners.size,
			0,
		);
	}

	addEventListener(type: string, listener: GraphEventListener): void {
		const listeners = this.listeners.get(type) ?? new Set();

		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: GraphEventListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatch(type: string, event: GraphEvent): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event as never);
		}
	}
}

class FakeDocument extends FakeEventTarget {
	readonly defaultView = new FakeEventTarget();
}

class FakeElement {
	readonly style = {
		transform: '',
		backgroundPosition: '',
		backgroundSize: '',
	};
	private readonly attributes = new Set<string>();
	private readonly classNames = new Set<string>();
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
	private readonly listeners = new Map<string, Set<GraphEventListener>>();
	private readonly capturedPointers = new Set<number>();
	private parent: FakeElement | undefined;

	constructor(
		public clientWidth = 1000,
		public clientHeight = 800,
		private readonly left = 0,
		private readonly top = 0,
		readonly ownerDocument: FakeDocument = new FakeDocument(),
	) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	asEventTarget(): EventTarget {
		return this as unknown as EventTarget;
	}

	setAttribute(name: string): void {
		this.attributes.add(name);
	}

	append(child: FakeElement): void {
		child.parent = this;
	}

	closest(selector: string): FakeElement | null {
		if (selector === '.graph-node' && this.hasClass('graph-node')) {
			return this;
		}

		if (selector.includes('[contenteditable]') && this.attributes.has('contenteditable')) {
			return this;
		}

		const attribute = selector.slice(1, -1);

		if (this.attributes.has(attribute)) {
			return this;
		}

		return this.parent?.closest(selector) ?? null;
	}

	hasClass(className: string): boolean {
		return this.classNames.has(className);
	}

	addEventListener(type: string, listener: GraphEventListener): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: GraphEventListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatch(type: string, event: GraphEvent): void {
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
		this.dispatch('lostpointercapture', createPointerEvent(0, 0, pointerId));
	}

	getBoundingClientRect(): DOMRect {
		return {
			x: this.left,
			y: this.top,
			left: this.left,
			top: this.top,
			right: this.left + this.clientWidth,
			bottom: this.top + this.clientHeight,
			width: this.clientWidth,
			height: this.clientHeight,
			toJSON: () => ({}),
		};
	}
}
