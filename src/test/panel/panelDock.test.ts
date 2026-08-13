import * as assert from 'assert';
import { initializePanelDock } from '../../webview/panel/panelDock';
import {
	INITIAL_SIDE_SIZE,
	INITIAL_VERTICAL_SIZE,
	type DockPosition,
	type PanelLayoutState,
} from '../../webview/panel/panelState';

suite('Panel Dock', () => {
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

	test('Side Dock은 좁은 Layout에서 Bottom으로 전환되고 확대하면 preferred Left/Right로 복원된다', () => {
		for (const preferredDock of ['left', 'right'] as const) {
			const layout = new FakeElement(INITIAL_SIDE_SIZE * 2 - 1, 800);
			const state = createState(preferredDock);

			initializeDock(layout, state);

			assert.strictEqual(layout.dataset.dock, 'bottom');

			layout.setSize(INITIAL_SIDE_SIZE * 2, 800);
			FakeResizeObserver.trigger(layout);

			assert.strictEqual(layout.dataset.dock, preferredDock);
			assert.strictEqual(state.preferredDock, preferredDock);
		}
	});

	test('사용자가 직접 Bottom을 선택하면 Layout 확대 후에도 Bottom을 유지한다', () => {
		const fixture = createDockFixture(1000, 'right');

		dragDock(fixture.dragHandle, 500, 799);
		assert.strictEqual(fixture.state.preferredDock, 'bottom');

		fixture.layout.setSize(600, 800);
		FakeResizeObserver.trigger(fixture.layout);
		fixture.layout.setSize(1400, 800);
		FakeResizeObserver.trigger(fixture.layout);

		assert.strictEqual(fixture.layout.dataset.dock, 'bottom');
		assert.strictEqual(fixture.state.preferredDock, 'bottom');
		assert.strictEqual(fixture.getChangeCount(), 1);
	});

	test('Left / Right / Top / Bottom 위치로 Drop할 수 있다', () => {
		const cases: Array<{
			target: DockPosition;
			start: DockPosition;
			clientX: number;
			clientY: number;
		}> = [
			{ target: 'left', start: 'right', clientX: 1, clientY: 400 },
			{ target: 'right', start: 'left', clientX: 999, clientY: 400 },
			{ target: 'top', start: 'right', clientX: 500, clientY: 1 },
			{ target: 'bottom', start: 'right', clientX: 500, clientY: 799 },
		];

		for (const { target, start, clientX, clientY } of cases) {
			const fixture = createDockFixture(1000, start);

			dragDock(fixture.dragHandle, clientX, clientY);

			assert.strictEqual(fixture.state.preferredDock, target);
			assert.strictEqual(fixture.layout.dataset.dock, target);
			assert.strictEqual(fixture.dockPreview.hidden, true);
			assert.strictEqual(fixture.layout.hasClass('is-dock-dragging'), false);
			assert.strictEqual(fixture.getChangeCount(), 1);
		}
	});

	test('Layout 외부에 Drop하면 기존 Dock을 유지한다', () => {
		const fixture = createDockFixture(1000, 'right');

		fixture.dragHandle.dispatch('pointerdown', createPointerEvent(500, 400));
		fixture.dragHandle.dispatch('pointermove', createPointerEvent(1, 400));
		assert.strictEqual(fixture.dockPreview.dataset.dock, 'left');

		fixture.dragHandle.dispatch('pointerup', createPointerEvent(-1, 400));

		assert.strictEqual(fixture.state.preferredDock, 'right');
		assert.strictEqual(fixture.layout.dataset.dock, 'right');
		assert.strictEqual(fixture.dockPreview.hidden, true);
		assert.strictEqual(fixture.layout.hasClass('is-dock-dragging'), false);
		assert.strictEqual(fixture.getChangeCount(), 0);
	});

	test('활성 Pointer와 다른 pointerId의 이동 및 종료 이벤트를 무시한다', () => {
		const fixture = createDockFixture(1000, 'right');

		fixture.dragHandle.dispatch('pointerdown', createPointerEvent(500, 400, 1));
		fixture.dragHandle.dispatch('pointermove', createPointerEvent(1, 400, 2));
		fixture.dragHandle.dispatch('pointerup', createPointerEvent(1, 400, 2));

		assert.strictEqual(fixture.dockPreview.hidden, true);
		assert.strictEqual(fixture.layout.hasClass('is-dock-dragging'), true);
		assert.strictEqual(fixture.dragHandle.hasPointerCapture(1), true);
		assert.strictEqual(fixture.state.preferredDock, 'right');

		fixture.dragHandle.dispatch('pointermove', createPointerEvent(500, 799, 1));
		fixture.dragHandle.dispatch('pointerup', createPointerEvent(500, 799, 1));

		assert.strictEqual(fixture.state.preferredDock, 'bottom');
		assert.strictEqual(fixture.getChangeCount(), 1);
	});

	test('pointercancel은 Drag 및 Preview를 정리하고 기존 Dock을 유지한다', () => {
		const fixture = createDockFixture(1000, 'right');

		fixture.dragHandle.dispatch('pointerdown', createPointerEvent(500, 400));
		fixture.dragHandle.dispatch('pointermove', createPointerEvent(1, 400));
		assertDragPreview(fixture, 'left');

		fixture.dragHandle.dispatch('pointercancel', createPointerEvent(1, 400));

		assertDragCleanedUp(fixture);
	});

	test('lostpointercapture는 Drag 및 Preview를 정리하고 기존 Dock을 유지한다', () => {
		const fixture = createDockFixture(1000, 'right');

		fixture.dragHandle.dispatch('pointerdown', createPointerEvent(500, 400));
		fixture.dragHandle.dispatch('pointermove', createPointerEvent(1, 400));
		assertDragPreview(fixture, 'left');

		fixture.dragHandle.losePointerCapture(1);

		assertDragCleanedUp(fixture);
	});

	test('큰 sideSize와 무관하게 초기 너비 기준으로 자동 Bottom 전환과 좌우 복귀를 결정한다', () => {
		const layout = new FakeElement(800);
		const state: PanelLayoutState = {
			preferredDock: 'right',
			sideSize: 700,
			verticalSize: INITIAL_VERTICAL_SIZE,
		};
		initializeDock(layout, state);

		assert.strictEqual(layout.dataset.dock, 'right');

		layout.setSize(INITIAL_SIDE_SIZE * 2 - 1, 800);
		FakeResizeObserver.trigger(layout);
		assert.strictEqual(layout.dataset.dock, 'bottom');

		layout.setSize(INITIAL_SIDE_SIZE * 2, 800);
		FakeResizeObserver.trigger(layout);
		assert.strictEqual(layout.dataset.dock, 'right');
	});

	test('Bottom에서 Left로 Dock하면 sideSize를 초기 너비로 복원한다', () => {
		const fixture = createDockFixture(1000, 'bottom', 640);

		dragDock(fixture.dragHandle, 1, 400);

		assert.strictEqual(fixture.state.preferredDock, 'left');
		assert.strictEqual(fixture.state.sideSize, INITIAL_SIDE_SIZE);
		assert.strictEqual(
			fixture.layout.styleProperties.get('--chat-side-size'),
			'360px',
		);
		assert.strictEqual(fixture.layout.dataset.dock, 'left');
		assert.strictEqual(fixture.getChangeCount(), 1);
	});

	test('자동 Bottom에서는 좌우 Drop으로 상태와 크기를 변경하지 않는다', () => {
		const fixture = createDockFixture(INITIAL_SIDE_SIZE * 2 - 1, 'right', 640);

		assert.strictEqual(fixture.layout.dataset.dock, 'bottom');
		dragDock(fixture.dragHandle, 1, 400);

		assert.strictEqual(fixture.state.preferredDock, 'right');
		assert.strictEqual(fixture.state.sideSize, 640);
		assert.strictEqual(fixture.layout.styleProperties.has('--chat-side-size'), false);
		assert.strictEqual(fixture.layout.dataset.dock, 'bottom');
		assert.strictEqual(fixture.getChangeCount(), 0);
	});

	test('Left에서 Right로 Dock하면 사용자가 조절한 sideSize를 유지한다', () => {
		const fixture = createDockFixture(1200, 'left', 520);

		dragDock(fixture.dragHandle, 1199, 400);

		assert.strictEqual(fixture.state.preferredDock, 'right');
		assert.strictEqual(fixture.state.sideSize, 520);
		assert.strictEqual(fixture.layout.styleProperties.has('--chat-side-size'), false);
		assert.strictEqual(fixture.layout.dataset.dock, 'right');
	});
});

interface DockFixture {
	layout: FakeElement;
	dragHandle: FakeElement;
	dockPreview: FakeElement;
	state: PanelLayoutState;
	getChangeCount(): number;
}

function createDockFixture(
	width: number,
	preferredDock: DockPosition,
	sideSize = INITIAL_SIDE_SIZE,
): DockFixture {
	const layout = new FakeElement(width, 800);
	const dragHandle = new FakeElement();
	const dockPreview = new FakeElement();
	const state = createState(preferredDock, sideSize);
	let changeCount = 0;

	initializePanelDock(
		layout.asHtmlElement(),
		dragHandle.asHtmlElement(),
		dockPreview.asHtmlElement(),
		state,
		() => changeCount++,
	);

	return {
		layout,
		dragHandle,
		dockPreview,
		state,
		getChangeCount: () => changeCount,
	};
}

function createState(
	preferredDock: DockPosition,
	sideSize = INITIAL_SIDE_SIZE,
): PanelLayoutState {
	return {
		preferredDock,
		sideSize,
		verticalSize: INITIAL_VERTICAL_SIZE,
	};
}

function initializeDock(layout: FakeElement, state: PanelLayoutState): void {
	initializePanelDock(
		layout.asHtmlElement(),
		new FakeElement().asHtmlElement(),
		new FakeElement().asHtmlElement(),
		state,
		() => undefined,
	);
}

function dragDock(
	dragHandle: FakeElement,
	clientX: number,
	clientY: number,
	pointerId = 1,
): void {
	dragHandle.dispatch('pointerdown', createPointerEvent(500, 400, pointerId));
	dragHandle.dispatch('pointermove', createPointerEvent(clientX, clientY, pointerId));
	dragHandle.dispatch('pointerup', createPointerEvent(clientX, clientY, pointerId));
}

function assertDragPreview(fixture: DockFixture, dock: DockPosition): void {
	assert.strictEqual(fixture.dockPreview.hidden, false);
	assert.strictEqual(fixture.dockPreview.dataset.dock, dock);
	assert.strictEqual(fixture.layout.hasClass('is-dock-dragging'), true);
	assert.strictEqual(fixture.dragHandle.hasPointerCapture(1), true);
}

function assertDragCleanedUp(fixture: DockFixture): void {
	assert.strictEqual(fixture.state.preferredDock, 'right');
	assert.strictEqual(fixture.layout.dataset.dock, 'right');
	assert.strictEqual(fixture.dockPreview.hidden, true);
	assert.strictEqual(fixture.dockPreview.dataset.dock, undefined);
	assert.strictEqual(fixture.layout.hasClass('is-dock-dragging'), false);
	assert.strictEqual(fixture.dragHandle.hasPointerCapture(1), false);
	assert.strictEqual(fixture.getChangeCount(), 0);
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
	hidden = false;
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
