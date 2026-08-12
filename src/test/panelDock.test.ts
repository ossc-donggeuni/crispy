import * as assert from 'assert';
import { initializePanelDock } from '../webview/panelDock';
import {
	INITIAL_SIDE_SIZE,
	INITIAL_VERTICAL_SIZE,
	type PanelLayoutState,
} from '../webview/panelState';

suite('Panel Dock', () => {
	const originalResizeObserver = globalThis.ResizeObserver;

	suiteSetup(() => {
		globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
	});

	suiteTeardown(() => {
		globalThis.ResizeObserver = originalResizeObserver;
	});

	test('큰 sideSize와 무관하게 초기 너비 기준으로 자동 Bottom 전환과 좌우 복귀를 결정한다', () => {
		const layout = new FakeElement(800);
		const state: PanelLayoutState = {
			preferredDock: 'right',
			sideSize: 700,
			verticalSize: INITIAL_VERTICAL_SIZE,
		};
		const refreshDock = initializeDock(layout, state);

		assert.strictEqual(layout.dataset.dock, 'right');

		layout.clientWidth = INITIAL_SIDE_SIZE * 2 - 1;
		refreshDock();
		assert.strictEqual(layout.dataset.dock, 'bottom');

		layout.clientWidth = INITIAL_SIDE_SIZE * 2;
		refreshDock();
		assert.strictEqual(layout.dataset.dock, 'right');
	});

	test('Bottom에서 Left로 Dock하면 sideSize를 초기 너비로 복원한다', () => {
		const layout = new FakeElement(1000);
		const dragHandle = new FakeElement();
		const dockPreview = new FakeElement();
		const state: PanelLayoutState = {
			preferredDock: 'bottom',
			sideSize: 640,
			verticalSize: INITIAL_VERTICAL_SIZE,
		};
		let changeCount = 0;

		initializePanelDock(
			layout.asHtmlElement(),
			dragHandle.asHtmlElement(),
			dockPreview.asHtmlElement(),
			state,
			() => changeCount++,
		);
		dragDock(dragHandle, 1, 400);

		assert.strictEqual(state.preferredDock, 'left');
		assert.strictEqual(state.sideSize, INITIAL_SIDE_SIZE);
		assert.strictEqual(layout.styleProperties.get('--chat-side-size'), '360px');
		assert.strictEqual(layout.dataset.dock, 'left');
		assert.strictEqual(changeCount, 1);
	});

	test('자동 Bottom에서는 좌우 Drop으로 상태와 크기를 변경하지 않는다', () => {
		const layout = new FakeElement(INITIAL_SIDE_SIZE * 2 - 1);
		const dragHandle = new FakeElement();
		const dockPreview = new FakeElement();
		const state: PanelLayoutState = {
			preferredDock: 'right',
			sideSize: 640,
			verticalSize: INITIAL_VERTICAL_SIZE,
		};
		let changeCount = 0;

		initializePanelDock(
			layout.asHtmlElement(),
			dragHandle.asHtmlElement(),
			dockPreview.asHtmlElement(),
			state,
			() => changeCount++,
		);
		assert.strictEqual(layout.dataset.dock, 'bottom');

		dragDock(dragHandle, 1, 400);

		assert.strictEqual(state.preferredDock, 'right');
		assert.strictEqual(state.sideSize, 640);
		assert.strictEqual(layout.styleProperties.has('--chat-side-size'), false);
		assert.strictEqual(layout.dataset.dock, 'bottom');
		assert.strictEqual(changeCount, 0);
	});

	test('Left에서 Right로 Dock하면 사용자가 조절한 sideSize를 유지한다', () => {
		const layout = new FakeElement(1200);
		const dragHandle = new FakeElement();
		const dockPreview = new FakeElement();
		const state: PanelLayoutState = {
			preferredDock: 'left',
			sideSize: 520,
			verticalSize: INITIAL_VERTICAL_SIZE,
		};

		initializePanelDock(
			layout.asHtmlElement(),
			dragHandle.asHtmlElement(),
			dockPreview.asHtmlElement(),
			state,
			() => undefined,
		);
		dragDock(dragHandle, 999, 400);

		assert.strictEqual(state.preferredDock, 'right');
		assert.strictEqual(state.sideSize, 520);
		assert.strictEqual(layout.styleProperties.has('--chat-side-size'), false);
		assert.strictEqual(layout.dataset.dock, 'right');
	});
});

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

function dragDock(dragHandle: FakeElement, clientX: number, clientY: number): void {
	dragHandle.dispatch('pointerdown', createPointerEvent(500, 400));
	dragHandle.dispatch('pointermove', createPointerEvent(clientX, clientY));
	dragHandle.dispatch('pointerup', createPointerEvent(clientX, clientY));
}

function createPointerEvent(clientX: number, clientY: number): PointerEvent {
	return {
		isPrimary: true,
		button: 0,
		pointerId: 1,
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
	readonly classList = {
		add: () => undefined,
		remove: () => undefined,
	};
	hidden = false;
	clientHeight = 800;
	private readonly listeners = new Map<string, (event: PointerEvent) => void>();
	private readonly capturedPointers = new Set<number>();

	constructor(public clientWidth = 1000) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
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

	getBoundingClientRect(): DOMRect {
		return {
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 1000,
			bottom: 800,
			width: 1000,
			height: 800,
			toJSON: () => ({}),
		};
	}
}

class FakeResizeObserver {
	observe(): void {}
	disconnect(): void {}
	unobserve(): void {}
}
