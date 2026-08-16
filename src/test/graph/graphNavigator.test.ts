import * as assert from 'assert';
import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	initializeGraphCamera,
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
} from '../../webview/graph/graphCamera';
import { initializeGraphNavigator } from '../../webview/graph/graphNavigator';
import { createGraphState } from '../../webview/graph/graphState';
import { DEFAULT_PANEL_LAYOUT_STATE } from '../../webview/panel/panelState';
import {
	restoreWebviewState,
	saveWebviewState,
	type PersistedWebviewState,
	type WebviewStateApi,
} from '../../webview/webviewState';

suite('Graph Navigator', () => {
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

	test('Camera Pan과 Wheel Zoom 상태 변경을 즉시 표시한다', () => {
		const fixture = createNavigatorFixture();

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

		fixture.viewport.dispatch('wheel', createWheelEvent(400, 300, -120));
		assert.strictEqual(
			fixture.scale.textContent,
			`${Math.round(fixture.camera.getState().scale * 100)}%`,
		);
		assert.notStrictEqual(fixture.scale.textContent, '100%');
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

	test('getState에서 복원한 Camera의 Zoom 변경을 기존 Webview State 흐름으로 다시 저장한다', () => {
		let savedState: PersistedWebviewState | undefined = {
			panel: { ...DEFAULT_PANEL_LAYOUT_STATE },
			graph: {
				camera: { x: 513, y: 324, scale: 1.2 },
				nodePositions: {},
			},
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
				graph,
			});
		});

		assert.strictEqual(fixture.coordinate.textContent, '(513, 324)');
		assert.strictEqual(fixture.scale.textContent, '120%');
		fixture.zoomInButton.dispatch('click', {} as Event);

		assert.deepStrictEqual(savedState?.graph.camera, fixture.camera.getState());
		assert.ok(Math.abs((savedState?.graph.camera.scale ?? 0) - 1.3) < 1e-10);
		unsubscribe();
	});

	test('dispose 이후 State 구독과 Zoom 버튼 Listener를 정리한다', () => {
		const fixture = createNavigatorFixture();
		const displayedCoordinate = fixture.coordinate.textContent;

		fixture.navigator.dispose();
		fixture.navigator.dispose();
		assert.strictEqual(fixture.overlay.children.length, 0);

		fixture.graphState.setState({
			camera: { x: 50, y: 60, scale: 2 },
			nodePositions: {},
		});
		assert.strictEqual(fixture.coordinate.textContent, displayedCoordinate);

		fixture.zoomInButton.dispatch('click', {} as Event);
		assert.deepStrictEqual(fixture.camera.getState(), { x: 50, y: 60, scale: 2 });
	});
});

function createNavigatorFixture(
	initialCamera = { x: 0, y: 0, scale: 1 },
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
	);
	const navigator = initializeGraphNavigator(
		overlay.asHtmlElement(),
		viewport.asHtmlElement(),
		graphState,
		camera,
	);
	const navigatorElement = getChild(overlay, 0);
	const coordinate = getChild(navigatorElement, 0);
	const controls = getChild(navigatorElement, 1);
	const zoomOutButton = getChild(controls, 0);
	const scale = getChild(controls, 1);
	const zoomInButton = getChild(controls, 2);

	return {
		viewport,
		overlay,
		graphState,
		camera,
		navigator,
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

function createPointerEvent(
	target: EventTarget,
	clientX = 10,
	clientY = 10,
): PointerEvent {
	return {
		isPrimary: true,
		button: 0,
		pointerId: 1,
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
): WheelEvent {
	return {
		clientX,
		clientY,
		deltaY,
		deltaMode: 0,
		target: null,
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
	createElement(_tagName?: string): FakeElement {
		return new FakeElement(this);
	}

	createSizedElement(clientWidth: number, clientHeight: number): FakeElement {
		return new FakeElement(this, clientWidth, clientHeight);
	}
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
	textContent = '';
	type = '';
	private readonly attributes = new Set<string>();
	private readonly classNames = new Set<string>();
	private readonly listeners = new Map<string, Set<GraphEventListener>>();
	private readonly capturedPointers = new Set<number>();
	private parent: FakeElement | undefined;

	constructor(
		readonly ownerDocument: FakeDocument,
		readonly clientWidth = 0,
		readonly clientHeight = 0,
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

	remove(): void {
		if (!this.parent) {
			return;
		}

		const index = this.parent.children.indexOf(this);

		if (index >= 0) {
			this.parent.children.splice(index, 1);
		}
	}

	setAttribute(name: string): void {
		this.attributes.add(name);
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
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

	getBoundingClientRect(): DOMRect {
		return {
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: this.clientWidth,
			bottom: this.clientHeight,
			width: this.clientWidth,
			height: this.clientHeight,
			toJSON: () => ({}),
		};
	}
}
