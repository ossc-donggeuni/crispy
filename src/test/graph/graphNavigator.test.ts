import * as assert from 'assert';
import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	initializeGraphCamera,
	MAX_CAMERA_SCALE,
	MIN_CAMERA_SCALE,
} from '../../webview/graph/graphCamera';
import { resolveFileIcon } from '../../webview/graph/fileIconResolver';
import type { GraphLayout } from '../../webview/graph/graphLayout';
import {
	initializeGraphNavigator,
	type GraphNavigatorInteractions,
} from '../../webview/graph/graphNavigator';
import { createGraphState } from '../../webview/graph/graphState';
import { DEFAULT_PANEL_LAYOUT_STATE } from '../../webview/panel/panelState';
import {
	restoreWebviewState,
	saveWebviewState,
	type PersistedWebviewState,
	type WebviewStateApi,
} from '../../webview/webviewState';

suite('Graph Navigator', () => {
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
		assert.strictEqual(fixture.minimap.children.length, 0);
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

	test('초기 Layout을 받고 setLayout 시 Navigator와 빈 Minimap DOM을 재생성하지 않는다', () => {
		const initialLayout = createEmptyLayout();
		const fixture = createNavigatorFixture(undefined, {}, initialLayout);
		const nextLayout = createEmptyLayout();

		fixture.navigator.setLayout(nextLayout);

		assert.strictEqual(fixture.overlay.children[0], fixture.navigatorElement);
		assert.strictEqual(fixture.bottomRow.children[0], fixture.minimap);
		assert.strictEqual(fixture.minimap.children.length, 0);
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
		assert.strictEqual(fixture.actionRail.children.length, 1);
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

	test('dispose 이후 State 구독과 Action/Zoom 버튼 Listener를 정리한다', () => {
		const fixture = createNavigatorFixture();
		const displayedCoordinate = fixture.coordinate.textContent;
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
		initialLayout,
		interactions,
	);
	const navigatorElement = getChild(overlay, 0);
	const bottomRow = getChild(navigatorElement, 0);
	const minimap = getChild(bottomRow, 0);
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
		zoom,
		featureRow,
		actionRail,
		rootListPanel,
		rootListTitle,
		rootList,
		rootListEmpty,
		rootListButton,
		rootListIcon,
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
		return new FakeElement(this, 0, 0, tagName.toUpperCase());
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
	hidden = false;
	id = '';
	textContent = '';
	title = '';
	type = '';
	private readonly attributes = new Map<string, string>();
	private readonly classNames = new Set<string>();
	private readonly listeners = new Map<string, Set<GraphEventListener>>();
	private readonly capturedPointers = new Set<number>();
	private parent: FakeElement | undefined;

	constructor(
		readonly ownerDocument: FakeDocument,
		readonly clientWidth = 0,
		readonly clientHeight = 0,
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
