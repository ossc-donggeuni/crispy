import * as assert from 'assert';
import { initializePanelDock } from '../../webview/panel/panelDock';
import {
	INITIAL_SIDE_SIZE,
	INITIAL_VERTICAL_SIZE,
	type DockPosition,
	type PanelLayoutState,
} from '../../webview/panel/panelState';

suite('Panel Dock', () => {
	test('좁은 Webview에서도 선호 Dock 위치를 그대로 유지한다', () => {
		for (const preferredDock of ['left', 'right', 'top', 'bottom'] as const) {
			const layout = new FakeElement(320, 240);
			const state = createState(preferredDock);

			const refreshDock = initializeDock(layout, state);

			assert.strictEqual(layout.dataset.dock, preferredDock);

			layout.setSize(200, 160);
			refreshDock();

			assert.strictEqual(layout.dataset.dock, preferredDock);
			assert.strictEqual(state.preferredDock, preferredDock);
			assert.strictEqual(state.sideSize, INITIAL_SIDE_SIZE);
			assert.strictEqual(state.verticalSize, INITIAL_VERTICAL_SIZE);
		}
	});

	test('사용자가 직접 Bottom을 선택하면 Layout 크기가 변해도 Bottom을 유지한다', () => {
		const fixture = createDockFixture(1000, 'right');

		dragDock(fixture.dragHandle, 500, 799);
		assert.strictEqual(fixture.state.preferredDock, 'bottom');

		fixture.layout.setSize(600, 800);
		fixture.refreshDock();
		fixture.layout.setSize(1400, 800);
		fixture.refreshDock();

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

	test('좁은 Webview에서도 좌우 Dock으로 이동할 수 있다', () => {
		const fixture = createDockFixture(INITIAL_SIDE_SIZE, 'right');

		dragDock(fixture.dragHandle, 1, 400);

		assert.strictEqual(fixture.state.preferredDock, 'left');
		assert.strictEqual(fixture.layout.dataset.dock, 'left');
		assert.strictEqual(fixture.getChangeCount(), 1);
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

	test('Bottom에서 Left로 Dock하면 sideSize를 초기 너비로 복원한다', () => {
		const fixture = createDockFixture(1000, 'bottom', 640);

		dragDock(fixture.dragHandle, 1, 400);

		assert.strictEqual(fixture.state.preferredDock, 'left');
		assert.strictEqual(fixture.state.sideSize, INITIAL_SIDE_SIZE);
		assert.strictEqual(fixture.layout.dataset.dock, 'left');
		assert.strictEqual(fixture.getChangeCount(), 1);
	});

	test('Left에서 Right로 Dock하면 사용자가 조절한 sideSize를 유지한다', () => {
		const fixture = createDockFixture(1200, 'left', 520);

		dragDock(fixture.dragHandle, 1199, 400);

		assert.strictEqual(fixture.state.preferredDock, 'right');
		assert.strictEqual(fixture.state.sideSize, 520);
		assert.strictEqual(fixture.layout.dataset.dock, 'right');
	});

	test('Dock 변경 완료 콜백을 변경이 확정된 경우에만 호출한다', () => {
		const fixture = createDockFixture(1000, 'right');

		dragDock(fixture.dragHandle, 1, 400);
		assert.strictEqual(fixture.getDockChangeCount(), 1);

		dragDock(fixture.dragHandle, -1, 400);
		assert.strictEqual(fixture.getDockChangeCount(), 1);
	});
});

interface DockFixture {
	layout: FakeElement;
	dragHandle: FakeElement;
	dockPreview: FakeElement;
	state: PanelLayoutState;
	refreshDock(): void;
	getChangeCount(): number;
	getDockChangeCount(): number;
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
	let dockChangeCount = 0;

	const refreshDock = initializePanelDock(
		layout.asHtmlElement(),
		dragHandle.asHtmlElement(),
		dockPreview.asHtmlElement(),
		state,
		() => changeCount++,
		() => dockChangeCount++,
	);

	return {
		layout,
		dragHandle,
		dockPreview,
		state,
		refreshDock,
		getChangeCount: () => changeCount,
		getDockChangeCount: () => dockChangeCount,
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
		collapsed: false,
	};
}

function initializeDock(
	layout: FakeElement,
	state: PanelLayoutState,
): () => void {
	return initializePanelDock(
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
