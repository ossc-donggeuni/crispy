import * as assert from 'assert';
import {
	applyPanelSize,
	initializePanelResize,
} from '../../webview/panel/panelResize';
import {
	INITIAL_SIDE_SIZE,
	INITIAL_VERTICAL_SIZE,
	PANEL_FLOATING_MARGIN,
	type DockPosition,
	type PanelLayoutState,
} from '../../webview/panel/panelState';

suite('Panel Resize', () => {
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

	test('저장된 크기를 초기 표시 크기로 반영한다', () => {
		const fixture = createResizeFixture('right');

		assertPanelSize(fixture, 'right', INITIAL_SIDE_SIZE);
		assertPanelSize(fixture, 'top', INITIAL_VERTICAL_SIZE);
	});

	test('Dock 방향에 따라 Pointer 이동 방향을 크기 증감으로 변환한다', () => {
		const cases: Array<{
			dock: DockPosition;
			moves: Array<{ clientX: number; clientY: number; expectedSize: number }>;
		}> = [
			{
				dock: 'left',
				moves: [
					{ clientX: 540, clientY: 400, expectedSize: 500 },
					{ clientX: 460, clientY: 400, expectedSize: 420 },
				],
			},
			{
				dock: 'right',
				moves: [
					{ clientX: 460, clientY: 400, expectedSize: 500 },
					{ clientX: 540, clientY: 400, expectedSize: 420 },
				],
			},
			{
				dock: 'top',
				moves: [
					{ clientX: 500, clientY: 440, expectedSize: 440 },
					{ clientX: 500, clientY: 360, expectedSize: 360 },
				],
			},
			{
				dock: 'bottom',
				moves: [
					{ clientX: 500, clientY: 360, expectedSize: 440 },
					{ clientX: 500, clientY: 440, expectedSize: 360 },
				],
			},
		];

		for (const { dock, moves } of cases) {
			const fixture = createResizeFixture(dock);
			fixture.resizeHandle.dispatch('pointerdown', createPointerEvent(500, 400));

			for (const { clientX, clientY, expectedSize } of moves) {
				fixture.resizeHandle.dispatch(
					'pointermove',
					createPointerEvent(clientX, clientY),
				);
				assertPanelSize(fixture, dock, expectedSize);
			}

			fixture.resizeHandle.dispatch('pointercancel', createPointerEvent(500, 400));
		}
	});

	test('Side와 Vertical 크기에 최소값을 적용한다', () => {
		const sideFixture = createResizeFixture('left');
		sideFixture.resizeHandle.dispatch('pointerdown', createPointerEvent(500, 400));
		sideFixture.resizeHandle.dispatch('pointermove', createPointerEvent(-1000, 400));
		assertPanelSize(sideFixture, 'left', 240);

		const verticalFixture = createResizeFixture('top');
		verticalFixture.resizeHandle.dispatch('pointerdown', createPointerEvent(500, 400));
		verticalFixture.resizeHandle.dispatch('pointermove', createPointerEvent(500, -1000));
		assertPanelSize(verticalFixture, 'top', 180);
	});

	test('Floating Panel의 외곽 여백을 제외한 최대 크기로 제한한다', () => {
		const sideFixture = createResizeFixture('left', 700, 800);
		sideFixture.resizeHandle.dispatch('pointerdown', createPointerEvent(500, 400));
		sideFixture.resizeHandle.dispatch('pointermove', createPointerEvent(2000, 400));
		assertPanelSize(sideFixture, 'left', 700 - PANEL_FLOATING_MARGIN * 2);

		const verticalFixture = createResizeFixture('top', 1000, 500);
		verticalFixture.resizeHandle.dispatch('pointerdown', createPointerEvent(500, 400));
		verticalFixture.resizeHandle.dispatch('pointermove', createPointerEvent(500, 2000));
		assertPanelSize(verticalFixture, 'top', 500 - PANEL_FLOATING_MARGIN * 2);
	});

	test('pointerup은 변경된 size를 유지하고 onResizeEnd를 정확히 한 번 호출한다', () => {
		const fixture = createResizeFixture('left');

		fixture.resizeHandle.dispatch('pointerdown', createPointerEvent(500, 400));
		fixture.resizeHandle.dispatch('pointermove', createPointerEvent(550, 400));

		assertPanelSize(fixture, 'left', 510);
		assert.strictEqual(fixture.getResizeEndCount(), 0);

		fixture.resizeHandle.dispatch('pointerup', createPointerEvent(550, 400));

		assertPanelSize(fixture, 'left', 510);
		assert.strictEqual(fixture.getResizeEndCount(), 1);
		assert.strictEqual(fixture.getLayoutResizeCount(), 1);
		assert.strictEqual(fixture.layout.hasClass('is-resizing'), false);
		assert.strictEqual(fixture.resizeHandle.hasPointerCapture(1), false);

		fixture.resizeHandle.dispatch('pointermove', createPointerEvent(600, 400));
		fixture.resizeHandle.dispatch('pointerup', createPointerEvent(600, 400));
		assertPanelSize(fixture, 'left', 510);
		assert.strictEqual(fixture.getResizeEndCount(), 1);
		assert.strictEqual(fixture.getLayoutResizeCount(), 1);
	});

	test('pointercancel은 move로 변경된 Side size를 시작 크기로 rollback한다', () => {
		const fixture = createResizeFixture('left');

		fixture.resizeHandle.dispatch('pointerdown', createPointerEvent(500, 400));
		fixture.resizeHandle.dispatch('pointermove', createPointerEvent(560, 400));
		assertPanelSize(fixture, 'left', 520);

		fixture.resizeHandle.dispatch('pointercancel', createPointerEvent(560, 400));

		assertPanelSize(fixture, 'left', INITIAL_SIDE_SIZE);
		assertResizeCancelled(fixture);
	});

	test('lostpointercapture는 move로 변경된 Vertical size를 시작 크기로 rollback한다', () => {
		const fixture = createResizeFixture('bottom');

		fixture.resizeHandle.dispatch('pointerdown', createPointerEvent(500, 400));
		fixture.resizeHandle.dispatch('pointermove', createPointerEvent(500, 340));
		assertPanelSize(fixture, 'bottom', 460);

		fixture.resizeHandle.losePointerCapture(1);

		assertPanelSize(fixture, 'bottom', INITIAL_VERTICAL_SIZE);
		assertResizeCancelled(fixture);
	});

	test('좁은 Webview에서는 저장된 크기를 유지한 채 표시 크기만 제한한다', () => {
		const fixture = createResizeFixture('right');

		fixture.layout.setSize(300, 200);
		FakeResizeObserver.trigger(fixture.layout);

		assert.strictEqual(fixture.state.sideSize, INITIAL_SIDE_SIZE);
		assert.strictEqual(fixture.state.verticalSize, INITIAL_VERTICAL_SIZE);
		assert.strictEqual(
			fixture.layout.styleProperties.get('--chat-side-size'),
			`${300 - PANEL_FLOATING_MARGIN * 2}px`,
		);
		assert.strictEqual(
			fixture.layout.styleProperties.get('--chat-vertical-size'),
			`${200 - PANEL_FLOATING_MARGIN * 2}px`,
		);

		fixture.layout.setSize(1000, 800);
		FakeResizeObserver.trigger(fixture.layout);

		assertPanelSize(fixture, 'right', INITIAL_SIDE_SIZE);
		assertPanelSize(fixture, 'bottom', INITIAL_VERTICAL_SIZE);
	});

	test('좁은 Webview에서는 표시 중인 크기를 기준으로 Resize를 시작한다', () => {
		const fixture = createResizeFixture('right', 400, 800);
		const displayedSize = 400 - PANEL_FLOATING_MARGIN * 2;

		assert.strictEqual(fixture.state.sideSize, INITIAL_SIDE_SIZE);
		assert.strictEqual(
			fixture.layout.styleProperties.get('--chat-side-size'),
			`${displayedSize}px`,
		);

		fixture.resizeHandle.dispatch('pointerdown', createPointerEvent(200, 400));
		fixture.resizeHandle.dispatch('pointermove', createPointerEvent(300, 400));

		assertPanelSize(fixture, 'right', displayedSize - 100);
	});

	test('저장된 크기를 현재 Layout 기준으로 CSS 변수에 적용한다', () => {
		const layout = new FakeElement(1000, 800);
		const state = createState('right');

		applyPanelSize(layout.asHtmlElement(), state);

		assert.strictEqual(
			layout.styleProperties.get('--chat-side-size'),
			`${INITIAL_SIDE_SIZE}px`,
		);
		assert.strictEqual(
			layout.styleProperties.get('--chat-vertical-size'),
			`${INITIAL_VERTICAL_SIZE}px`,
		);
	});
});

interface ResizeFixture {
	layout: FakeElement;
	resizeHandle: FakeElement;
	state: PanelLayoutState;
	getResizeEndCount(): number;
	getLayoutResizeCount(): number;
}

function createResizeFixture(
	dock: DockPosition,
	width = 1000,
	height = 800,
): ResizeFixture {
	const layout = new FakeElement(width, height);
	const resizeHandle = new FakeElement();
	const state = createState(dock);
	let resizeEndCount = 0;
	let layoutResizeCount = 0;

	layout.dataset.dock = dock;
	initializePanelResize(
		layout.asHtmlElement(),
		resizeHandle.asHtmlElement(),
		state,
		() => undefined,
		() => resizeEndCount++,
		() => layoutResizeCount++,
	);

	return {
		layout,
		resizeHandle,
		state,
		getResizeEndCount: () => resizeEndCount,
		getLayoutResizeCount: () => layoutResizeCount,
	};
}

function createState(dock: DockPosition): PanelLayoutState {
	return {
		preferredDock: dock,
		sideSize: INITIAL_SIDE_SIZE,
		verticalSize: INITIAL_VERTICAL_SIZE,
		collapsed: false,
	};
}

function assertPanelSize(
	fixture: ResizeFixture,
	dock: DockPosition,
	expectedSize: number,
): void {
	const isSideDock = dock === 'left' || dock === 'right';
	const stateSize = isSideDock ? fixture.state.sideSize : fixture.state.verticalSize;
	const customProperty = isSideDock ? '--chat-side-size' : '--chat-vertical-size';

	assert.strictEqual(stateSize, expectedSize);
	assert.strictEqual(
		fixture.layout.styleProperties.get(customProperty),
		`${expectedSize}px`,
	);
}

function assertResizeCancelled(fixture: ResizeFixture): void {
	assert.strictEqual(fixture.getResizeEndCount(), 0);
	assert.strictEqual(fixture.layout.hasClass('is-resizing'), false);
	assert.strictEqual(fixture.resizeHandle.hasPointerCapture(1), false);
}

function createPointerEvent(
	clientX: number,
	clientY: number,
	pointerId = 1,
): PointerEvent {
	return {
		isPrimary: true,
		button: 0,
		pointerId,
		clientX,
		clientY,
		preventDefault: () => undefined,
	} as PointerEvent;
}

class FakeElement {
	readonly dataset = {} as DOMStringMap;
	readonly styleProperties = new Map<string, string>();
	readonly style = {
		setProperty: (property: string, value: string) => {
			this.styleProperties.set(property, value);
		},
	};
	readonly classNames = new Set<string>();
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
	private readonly listeners = new Map<string, (event: PointerEvent) => void>();
	private readonly capturedPointers = new Set<number>();

	constructor(
		public clientWidth = 1000,
		public clientHeight = 800,
		private readonly left = 0,
		private readonly top = 0,
	) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	setSize(clientWidth: number, clientHeight: number): void {
		this.clientWidth = clientWidth;
		this.clientHeight = clientHeight;
	}

	hasClass(className: string): boolean {
		return this.classNames.has(className);
	}

	addEventListener(type: string, listener: (event: PointerEvent) => void): void {
		this.listeners.set(type, listener);
	}

	dispatch(type: string, event: PointerEvent): void {
		this.listeners.get(type)?.(event);
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

class FakeResizeObserver {
	private static instances: FakeResizeObserver[] = [];
	private readonly observedElements = new Set<Element>();

	constructor(private readonly callback: ResizeObserverCallback) {
		FakeResizeObserver.instances.push(this);
	}

	static reset(): void {
		FakeResizeObserver.instances = [];
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
