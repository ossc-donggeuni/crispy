import * as assert from 'assert';
import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
	GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE,
	initializeGraphCamera,
} from '../../webview/graph/graphCamera';
import {
	createFileGroupId,
	createGraphLayout,
	type GraphLayout,
	type GraphLayoutNode,
} from '../../webview/graph/graphLayout';
import { GRAPH_MOCK_PROJECT } from '../../webview/graph/graphMockData';
import { GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE } from '../../webview/graph/graphNodeDrag';
import {
	initializeGraphRenderer,
	type GraphRendererInteractions,
} from '../../webview/graph/graphRenderer';
import { createGraphState } from '../../webview/graph/graphState';
import { DEFAULT_PANEL_LAYOUT_STATE } from '../../webview/panel/panelState';
import {
	restoreWebviewState,
	saveWebviewState,
	type PersistedWebviewState,
	type WebviewStateApi,
} from '../../webview/webviewState';

suite('Graph Renderer / Node Drag', () => {
	test('Project Root, Folder, File Group과 Edge를 지정된 Layer에 렌더링한다', () => {
		const fixture = createRendererFixture();
		const root = fixture.getNode(GRAPH_MOCK_PROJECT.id);
		const folder = fixture.getNode('folder:app/src');
		const fileGroup = fixture.getNode(createFileGroupId('folder:app/src'));

		assert.strictEqual(fixture.nodeLayer.children.length, fixture.layout.nodes.length);
		assert.strictEqual(fixture.edgeLayer.children.length, fixture.layout.edges.length);
		assert.strictEqual(root.hasClass('graph-project-node'), true);
		assert.strictEqual(folder.hasClass('graph-folder-node'), true);
		assert.strictEqual(fileGroup.hasClass('graph-file-group-node'), true);
		const folderIcons = fixture.nodeLayer.children
			.filter((node) => !node.hasClass('graph-file-group-node'))
			.map((node) => getDescendantByClass(node, 'graph-folder-icon'));
		const folderIconPaths = folderIcons.map(
			(icon) => icon.children[0]?.getAttribute('d'),
		);

		assert.ok(folderIcons.every((icon) => icon.tagName === 'svg'));
		assert.ok(folderIcons.every((icon) => icon.getAttribute('src') === null));
		assert.ok(folderIconPaths[0]);
		assert.ok(folderIconPaths.every((path) => path === folderIconPaths[0]));
		assert.ok(!getText(root).includes('📁'));
		assert.ok(getText(root).includes('crispy/'));
		assert.ok(getText(folder).includes('src/'));
		assert.ok(getText(fileGroup).includes('graphView.ts'));
		assert.ok(getText(fileGroup).includes('graphRenderer.ts'));
		assert.ok(!getText(fileGroup).includes('graphNodeDrag.ts'));
		assert.ok(getText(fileGroup).includes('+ 2개 더보기'));
		assert.strictEqual(
			fixture.edgeLayer.children.every((edge) => edge.hasClass('graph-edge')),
			true,
		);
		fixture.renderer.dispose();
	});

	test('Folder, File Group, File Row Click을 각각 Callback으로 구분한다', () => {
		const folderClicks: string[] = [];
		const fileGroupClicks: string[] = [];
		const fileClicks: string[] = [];
		const fixture = createRendererFixture(1, undefined, {
			onFolderClick: (folderId) => folderClicks.push(folderId),
			onFileGroupClick: (folderId) => fileGroupClicks.push(folderId),
			onFileClick: (fileId) => fileClicks.push(fileId),
		});
		const folder = fixture.getNode('folder:app');
		const fileGroup = fixture.getNode(createFileGroupId('folder:app/src'));
		const fileRow = getDescendantByClass(fileGroup, 'graph-file-item');
		const fileClick = createClickEvent(fileRow);

		folder.dispatch('click', createClickEvent(folder));
		fileGroup.dispatch('click', createClickEvent(fileGroup));
		fileRow.dispatch('click', fileClick);

		assert.deepStrictEqual(folderClicks, ['folder:app']);
		assert.deepStrictEqual(fileGroupClicks, ['folder:app/src']);
		assert.deepStrictEqual(fileClicks, ['file:app/src/graphView.ts']);
		assert.strictEqual(fileClick.propagationStopped, true);
		assert.strictEqual(fileRow.hasClass('is-file-clicking'), true);
		fileRow.dispatch('animationend', createAnimationEvent(fileRow));
		assert.strictEqual(fileRow.hasClass('is-file-clicking'), false);
		assert.strictEqual(
			fileRow.getAttribute('data-file-id'),
			'file:app/src/graphView.ts',
		);
		assert.strictEqual(
			fileRow.hasAttribute(GRAPH_NODE_DRAG_IGNORE_ATTRIBUTE),
			true,
		);
		fixture.renderer.dispose();
	});

	test('Threshold를 넘긴 Node Drag 뒤 Click Callback을 실행하지 않는다', () => {
		const folderClicks: string[] = [];
		const fixture = createRendererFixture(1, undefined, {
			onFolderClick: (folderId) => folderClicks.push(folderId),
		});
		const folder = fixture.getNode('folder:app');

		folder.dispatch('pointerdown', createPointerEvent(folder, 10, 10));
		folder.dispatch('pointermove', createPointerEvent(folder, 40, 30));
		folder.dispatch('pointerup', createPointerEvent(folder, 40, 30));
		folder.dispatch('click', createClickEvent(folder));
		assert.deepStrictEqual(folderClicks, []);

		folder.dispatch('pointerdown', createPointerEvent(folder, 40, 30));
		folder.dispatch('pointermove', createPointerEvent(folder, 42, 31));
		folder.dispatch('pointerup', createPointerEvent(folder, 42, 31));
		folder.dispatch('click', createClickEvent(folder));
		assert.deepStrictEqual(folderClicks, ['folder:app']);
		fixture.renderer.dispose();
	});

	test('File Row Pointer 입력은 File Group Drag와 Camera Pan을 시작하지 않는다', () => {
		const fixture = createRendererFixture();
		const viewport = fixture.document.createSizedElement(1000, 800);
		const world = fixture.document.createElement('div');
		const camera = initializeGraphCamera(
			viewport.asHtmlElement(),
			world.asHtmlElement(),
			fixture.graphState,
		);
		const fileGroup = fixture.getNode(createFileGroupId('folder:app/src'));
		const fileRow = getDescendantByClass(fileGroup, 'graph-file-item');
		const pointerDown = createPointerEvent(fileRow, 10, 10);

		fileRow.dispatch('pointerdown', pointerDown);
		fileRow.dispatch('pointermove', createPointerEvent(fileRow, 60, 40));
		viewport.dispatch('pointerdown', pointerDown);
		viewport.dispatch('pointermove', createPointerEvent(fileRow, 60, 40));

		assert.strictEqual(fileGroup.hasPointerCapture(1), false);
		assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});
		assert.deepStrictEqual(camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(viewport.hasPointerCapture(1), false);
		camera.dispose();
		fixture.renderer.dispose();
	});

	test('Folder, File Group, File Row 위 Wheel은 Cursor 기준 Camera Zoom을 수행한다', () => {
		const fixture = createRendererFixture();
		const viewport = fixture.document.createSizedElement(1000, 800);
		const world = fixture.document.createElement('div');
		const camera = initializeGraphCamera(
			viewport.asHtmlElement(),
			world.asHtmlElement(),
			fixture.graphState,
		);
		const folder = fixture.getNode('folder:app');
		const fileGroup = fixture.getNode(createFileGroupId('folder:app/src'));
		const fileRow = getDescendantByClass(fileGroup, 'graph-file-item');
		const cursor = { x: 160, y: 120 };

		for (const target of [folder, fileGroup, fileRow]) {
			const scaleBefore = camera.getState().scale;
			const worldBefore = camera.viewportToWorld(cursor);
			const wheelEvent = createWheelEvent(target, cursor.x, cursor.y, -120);

			viewport.dispatch('wheel', wheelEvent);

			assert.ok(camera.getState().scale > scaleBefore);
			assertPointAlmostEqual(camera.viewportToWorld(cursor), worldBefore);
			assert.strictEqual(wheelEvent.defaultPrevented, true);
		}

		camera.dispose();
		fixture.renderer.dispose();
	});

	test('Camera-only 변경은 Edge를 다시 계산하지 않고 Node 위치 변경만 반영한다', () => {
		const fixture = createRendererFixture();
		const nodeId = 'folder:app';
		const node = fixture.getNode(nodeId);
		const edge = fixture.getConnectedEdge(nodeId);
		const edgeWritesBeforeCamera = edge.getAttributeWriteCount('d');

		fixture.graphState.setState({
			camera: { x: 100, y: -40, scale: 2 },
			nodePositions: {},
		});

		assert.strictEqual(edge.getAttributeWriteCount('d'), edgeWritesBeforeCamera);

		fixture.graphState.setState({
			camera: { x: 100, y: -40, scale: 2 },
			nodePositions: { [nodeId]: { x: 700, y: 240 } },
		});

		assert.strictEqual(node.style.transform, 'translate(700px, 240px)');
		assert.ok(edge.getAttributeWriteCount('d') > edgeWritesBeforeCamera);
		fixture.renderer.dispose();
	});

	for (const [label, nodeId] of [
		['Project Root', GRAPH_MOCK_PROJECT.id],
		['Folder', 'folder:app'],
		['File Group', createFileGroupId('folder:app/src')],
	] as const) {
		test(`${label} Node를 Capture하여 Camera scale 기준 World 좌표로 이동한다`, () => {
			const fixture = createRendererFixture(2);
			const layoutNode = getLayoutNode(fixture.layout, nodeId);
			const node = fixture.getNode(nodeId);
			const connectedEdge = fixture.getConnectedEdge(nodeId);
			const edgePathBefore = connectedEdge.getAttribute('d');
			let stateChanges = 0;
			const unsubscribe = fixture.graphState.subscribe(() => {
				stateChanges += 1;
			});

			node.dispatch('pointerdown', createPointerEvent(node, 100, 80));
			assert.strictEqual(node.hasPointerCapture(1), true);
			assert.strictEqual(node.hasClass('is-dragging'), true);
			assert.strictEqual(
				node.hasAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE),
				true,
			);
			assert.strictEqual(node.hasAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE), false);

			node.dispatch('pointermove', createPointerEvent(node, 140, 60));
			assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});
			assert.strictEqual(stateChanges, 0);
			assert.strictEqual(
				node.style.transform,
				`translate(${layoutNode.position.x + 20}px, ${layoutNode.position.y - 10}px)`,
			);
			assert.notStrictEqual(connectedEdge.getAttribute('d'), edgePathBefore);

			node.dispatch('pointerup', createPointerEvent(node, 140, 60));
			assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {
				[nodeId]: {
					x: layoutNode.position.x + 20,
					y: layoutNode.position.y - 10,
				},
			});
			assert.strictEqual(stateChanges, 1);
			assert.strictEqual(node.hasPointerCapture(1), false);
			assert.strictEqual(node.hasClass('is-dragging'), false);
			unsubscribe();
			fixture.renderer.dispose();
		});
	}

	test('pointercancel과 lostpointercapture는 임시 위치를 복원하고 저장하지 않는다', () => {
		for (const eventType of ['pointercancel', 'lostpointercapture'] as const) {
			const fixture = createRendererFixture();
			const nodeId = 'folder:app';
			const layoutNode = getLayoutNode(fixture.layout, nodeId);
			const node = fixture.getNode(nodeId);
			const edge = fixture.getConnectedEdge(nodeId);
			const edgePathBefore = edge.getAttribute('d');

			node.dispatch('pointerdown', createPointerEvent(node, 10, 10));
			node.dispatch('pointermove', createPointerEvent(node, 50, 40));
			assert.notStrictEqual(edge.getAttribute('d'), edgePathBefore);

			if (eventType === 'lostpointercapture') {
				node.releasePointerCapture(1);
			}

			node.dispatch(eventType, createPointerEvent(node, 50, 40));

			assert.deepStrictEqual(fixture.graphState.getState().nodePositions, {});
			assert.strictEqual(
				node.style.transform,
				`translate(${layoutNode.position.x}px, ${layoutNode.position.y}px)`,
			);
			assert.strictEqual(edge.getAttribute('d'), edgePathBefore);
			assert.strictEqual(node.hasPointerCapture(1), false);
			assert.strictEqual(node.hasClass('is-dragging'), false);
			fixture.renderer.dispose();
		}
	});

	test('Node 입력 차단 규약으로 Drag 중 Camera Pan을 시작하지 않는다', () => {
		const fixture = createRendererFixture();
		const viewport = fixture.document.createSizedElement(1000, 800);
		const world = fixture.document.createElement('div');
		const camera = initializeGraphCamera(
			viewport.asHtmlElement(),
			world.asHtmlElement(),
			fixture.graphState,
		);
		const folder = fixture.getNode('folder:app');

		viewport.dispatch('pointerdown', createPointerEvent(folder, 10, 10));
		viewport.dispatch('pointermove', createPointerEvent(folder, 60, 40));

		assert.deepStrictEqual(camera.getState(), { x: 0, y: 0, scale: 1 });
		assert.strictEqual(viewport.hasPointerCapture(1), false);
		assert.strictEqual(viewport.hasClass('is-panning'), false);
		camera.dispose();
		fixture.renderer.dispose();
	});

	test('Node 이동을 기존 Webview State로 저장하고 새 Store/Renderer에서 일부 위치만 복원한다', () => {
		let savedState: PersistedWebviewState | undefined;
		const api: WebviewStateApi = {
			getState: () => savedState,
			setState: (state) => {
				savedState = state;
			},
		};
		const firstState = restoreWebviewState(api);
		const first = createRendererFixture(1, firstState.graph);
		const movedId = 'folder:app';
		const untouchedId = 'folder:src';
		const movedLayout = getLayoutNode(first.layout, movedId);
		const untouchedLayout = getLayoutNode(first.layout, untouchedId);
		const unsubscribe = first.graphState.subscribe((graph) => {
			saveWebviewState(api, {
				panel: { ...DEFAULT_PANEL_LAYOUT_STATE },
				graph,
			});
		});

		const movedNode = first.getNode(movedId);
		movedNode.dispatch('pointerdown', createPointerEvent(movedNode, 20, 30));
		movedNode.dispatch('pointermove', createPointerEvent(movedNode, 100, 70));
		assert.strictEqual(savedState, undefined);
		movedNode.dispatch('pointerup', createPointerEvent(movedNode, 100, 70));
		const savedAfterPointerUp = api.getState() as PersistedWebviewState | undefined;

		assert.deepStrictEqual(savedAfterPointerUp?.graph.nodePositions, {
			[movedId]: {
				x: movedLayout.position.x + 80,
				y: movedLayout.position.y + 40,
			},
		});
		unsubscribe();
		first.renderer.dispose();

		const restored = restoreWebviewState(api);
		const second = createRendererFixture(1, restored.graph);

		assert.notStrictEqual(second.graphState, first.graphState);
		assert.strictEqual(
			second.getNode(movedId).style.transform,
			`translate(${movedLayout.position.x + 80}px, ${movedLayout.position.y + 40}px)`,
		);
		assert.strictEqual(
			second.getNode(untouchedId).style.transform,
			`translate(${untouchedLayout.position.x}px, ${untouchedLayout.position.y}px)`,
		);
		assert.deepStrictEqual(
			Object.keys(second.graphState.getState().nodePositions),
			[movedId],
		);
		second.renderer.dispose();
	});
});

function createRendererFixture(
	scale = 1,
	initialState = {
		camera: { x: 0, y: 0, scale },
		nodePositions: {},
	},
	interactions: GraphRendererInteractions = {},
) {
	const document = new FakeDocument();
	const edgeLayer = document.createElementNS('', 'svg');
	const nodeLayer = document.createElement('div');
	const layout = createGraphLayout(GRAPH_MOCK_PROJECT);
	const graphState = createGraphState(initialState);
	const renderer = initializeGraphRenderer(
		edgeLayer.asSvgElement(),
		nodeLayer.asHtmlElement(),
		layout,
		graphState,
		interactions,
	);
	const getNode = (nodeId: string): FakeElement => {
		const node = nodeLayer.children.find(
			(child) => child.getAttribute('data-graph-node-id') === nodeId,
		);

		assert.ok(node, `${nodeId} Node가 렌더링되어야 한다.`);
		return node;
	};
	const getConnectedEdge = (nodeId: string): FakeElement => {
		const edge = layout.edges.find(
			(candidate) => candidate.sourceId === nodeId || candidate.targetId === nodeId,
		);

		assert.ok(edge, `${nodeId}에 연결된 Edge가 있어야 한다.`);
		const element = edgeLayer.children.find(
			(child) => child.getAttribute('data-graph-edge-id') === edge.id,
		);
		assert.ok(element);
		return element;
	};

	return {
		document,
		edgeLayer,
		nodeLayer,
		layout,
		graphState,
		renderer,
		getNode,
		getConnectedEdge,
	};
}

function getLayoutNode(layout: GraphLayout, nodeId: string): GraphLayoutNode {
	const node = layout.nodes.find((candidate) => candidate.id === nodeId);

	assert.ok(node);
	return node;
}

function createPointerEvent(
	target: FakeElement,
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
		target: target.asEventTarget(),
		preventDefault: () => undefined,
	} as PointerEvent;
}

function createWheelEvent(
	target: FakeElement,
	clientX: number,
	clientY: number,
	deltaY: number,
): WheelEvent & { defaultPrevented: boolean } {
	let defaultPrevented = false;

	return {
		target: target.asEventTarget(),
		clientX,
		clientY,
		deltaY,
		deltaMode: 0,
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

function createClickEvent(
	target: FakeElement,
): MouseEvent & { readonly propagationStopped: boolean } {
	let propagationStopped = false;
	let defaultPrevented = false;

	return {
		target: target.asEventTarget(),
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
	} as unknown as MouseEvent & { readonly propagationStopped: boolean };
}

function createAnimationEvent(target: FakeElement): AnimationEvent {
	return {
		target: target.asEventTarget(),
	} as AnimationEvent;
}

function getDescendantByClass(
	element: FakeElement,
	className: string,
): FakeElement {
	for (const child of element.children) {
		if (child.hasClass(className)) {
			return child;
		}

		const descendant = findDescendantByClass(child, className);

		if (descendant) {
			return descendant;
		}
	}

	assert.fail(`${className} 요소가 있어야 한다.`);
}

function findDescendantByClass(
	element: FakeElement,
	className: string,
): FakeElement | undefined {
	for (const child of element.children) {
		if (child.hasClass(className)) {
			return child;
		}

		const descendant = findDescendantByClass(child, className);

		if (descendant) {
			return descendant;
		}
	}

	return undefined;
}

function getText(element: FakeElement): string {
	return [element.textContent, ...element.children.map(getText)].join(' ');
}

type GraphEventListener = (event: never) => void;

class FakeDocument {
	createElement(tagName = 'div'): FakeElement {
		return new FakeElement(this, tagName);
	}

	createElementNS(_namespace: string, tagName: string): FakeElement {
		return new FakeElement(this, tagName);
	}

	createSizedElement(width: number, height: number): FakeElement {
		return new FakeElement(this, 'div', width, height);
	}
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly style: Record<string, string> = {
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
	private readonly attributes = new Map<string, string>();
	private readonly attributeWriteCounts = new Map<string, number>();
	private readonly classNames = new Set<string>();
	private readonly listeners = new Map<string, Set<GraphEventListener>>();
	private readonly capturedPointers = new Set<number>();
	private parent: FakeElement | undefined;

	constructor(
		readonly ownerDocument: FakeDocument,
		readonly tagName: string,
		readonly clientWidth = 0,
		readonly clientHeight = 0,
	) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	asSvgElement(): SVGSVGElement {
		return this as unknown as SVGSVGElement;
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
		this.attributeWriteCounts.set(
			name,
			(this.attributeWriteCounts.get(name) ?? 0) + 1,
		);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	getAttributeWriteCount(name: string): number {
		return this.attributeWriteCounts.get(name) ?? 0;
	}

	closest(selector: string): FakeElement | null {
		const attribute = selector.slice(1, -1);

		if (this.hasAttribute(attribute)) {
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

		if (!(event as Event & { propagationStopped?: boolean }).propagationStopped) {
			this.parent?.dispatch(type, event);
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
