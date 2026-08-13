import * as assert from 'assert';
import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	initializeGraphCamera,
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
} from '../../webview/graph/graphCamera';
import { createGraphState } from '../../webview/graph/graphState';

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
		fixture.graphState.setState({ camera: { x: 100, y: -40, scale: 2 } });

		assert.deepStrictEqual(
			fixture.camera.worldToViewport({ x: 25, y: 30 }),
			{ x: 150, y: 20 },
		);
		assert.deepStrictEqual(
			fixture.camera.viewportToWorld({ x: 150, y: 20 }),
			{ x: 25, y: 30 },
		);
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

	test('Camera 입력 차단 속성이 없는 일반 요소에서는 Pan과 Zoom이 동작한다', () => {
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
		assert.ok(fixture.camera.getState().scale > 1);
	});

	test('Wheel Zoom 전후 Cursor 아래 World 위치를 고정한다', () => {
		const fixture = createCameraFixture(800, 600, 40, 30);
		fixture.camera.setState({ x: 70, y: -20, scale: 1.25 });
		const cursor = { x: 250, y: 180 };
		const before = fixture.camera.viewportToWorld(cursor);
		const event = createWheelEvent(cursor.x + 40, cursor.y + 30, -120);

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

		fixture.graphState.setState({ camera: { x: -80, y: 65, scale: 2 } });

		assert.strictEqual(
			fixture.world.style.transform,
			'translate(-80px, 65px) scale(2)',
		);
		assert.strictEqual(fixture.viewport.style.backgroundPosition, '-80px 65px');
		assert.strictEqual(fixture.viewport.style.backgroundSize, '40px 40px');
	});

	test('Wheel Zoom Out과 Zoom In을 scale 범위에서 제한한다', () => {
		const fixture = createCameraFixture();

		fixture.viewport.dispatch('wheel', createWheelEvent(100, 100, 100_000));
		assert.strictEqual(fixture.camera.getState().scale, MIN_CAMERA_SCALE);

		fixture.viewport.dispatch('wheel', createWheelEvent(100, 100, -100_000));
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

	test('lostpointercapture와 dispose가 진행 상태 및 등록한 이벤트를 정리한다', () => {
		const fixture = createCameraFixture();

		fixture.viewport.dispatch('pointerdown', createPointerEvent(10, 10));
		fixture.viewport.losePointerCapture(1);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);

		fixture.viewport.dispatch('pointerdown', createPointerEvent(10, 10));
		fixture.camera.dispose();
		fixture.camera.dispose();
		assert.strictEqual(fixture.viewport.hasPointerCapture(1), false);
		assert.strictEqual(fixture.viewport.hasClass('is-panning'), false);

		fixture.viewport.dispatch('pointerdown', createPointerEvent(10, 10));
		fixture.viewport.dispatch('pointermove', createPointerEvent(30, 40));
		fixture.viewport.dispatch('wheel', createWheelEvent(100, 100, -120));
		assert.deepStrictEqual(fixture.camera.getState(), { x: 0, y: 0, scale: 1 });

		fixture.graphState.setState({ camera: { x: 90, y: 70, scale: 2 } });
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
) {
	const viewport = new FakeElement(width, height, left, top);
	const world = new FakeElement();
	const graphState = createGraphState();
	const camera = initializeGraphCamera(
		viewport.asHtmlElement(),
		world.asHtmlElement(),
		graphState,
	);

	return { viewport, world, camera, graphState };
}

function createPointerEvent(
	clientX: number,
	clientY: number,
	pointerId = 1,
	button = 0,
	target: EventTarget | null = null,
): PointerEvent {
	return {
		isPrimary: true,
		button,
		pointerId,
		clientX,
		clientY,
		target,
		preventDefault: () => undefined,
	} as PointerEvent;
}

function createWheelEvent(
	clientX: number,
	clientY: number,
	deltaY: number,
	target: EventTarget | null = null,
): WheelEvent & {
	defaultPrevented: boolean;
} {
	let defaultPrevented = false;

	return {
		clientX,
		clientY,
		deltaY,
		deltaMode: 0,
		target,
		preventDefault: () => {
			defaultPrevented = true;
		},
		get defaultPrevented() {
			return defaultPrevented;
		},
	} as WheelEvent & { defaultPrevented: boolean };
}

function assertPointAlmostEqual(
	actual: { x: number; y: number },
	expected: { x: number; y: number },
): void {
	assert.ok(Math.abs(actual.x - expected.x) < 1e-10);
	assert.ok(Math.abs(actual.y - expected.y) < 1e-10);
}

type GraphEvent = PointerEvent | WheelEvent;
type GraphEventListener = (event: never) => void;

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
