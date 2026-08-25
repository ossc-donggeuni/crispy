import * as assert from 'assert';
import { createDefaultTaskBlueprint, createTaskState } from '../../task';
import {
	calculateTaskInspectorPosition,
	initializeTaskInspector,
	TASK_INSPECTOR_ATTRIBUTE,
	TASK_INSPECTOR_FIELD_ATTRIBUTE,
	type TaskInspectorFieldInput,
} from '../../webview/task/taskInspector';
import { createTaskGraphLayout } from '../../webview/task/taskLayout';

suite('Task Inspector', () => {
	test('Node 오른쪽 World anchor를 Camera로 투영한 뒤 viewport gap을 적용한다', () => {
		const node = createStartLayoutNode({ x: 100, y: 80 });
		const camera = createCameraProjection({ x: 20, y: -10, scale: 1.5 });
		const position = calculateTaskInspectorPosition(
			node,
			camera,
			{ width: 1_600, height: 900 },
			{ width: 320, height: 192 },
		);

		assert.deepStrictEqual(position, { x: 602, y: 110 });
		const projectedRight = camera.worldToViewport({
			x: node.position.x + node.width,
			y: node.position.y,
		});

		assert.strictEqual(position.x - projectedRight.x, 12);
	});

	test('Camera scale 변경은 anchor만 다시 투영하고 panel pixel 크기는 계산에 유지한다', () => {
		const node = createStartLayoutNode({ x: 100, y: 80 });
		const inspectorSize = { width: 320, height: 192 };
		const initial = calculateTaskInspectorPosition(
			node,
			createCameraProjection({ x: 20, y: -10, scale: 1 }),
			{ width: 2_000, height: 1_200 },
			inspectorSize,
		);
		const zoomed = calculateTaskInspectorPosition(
			node,
			createCameraProjection({ x: 40, y: 30, scale: 2 }),
			{ width: 2_000, height: 1_200 },
			inspectorSize,
		);

		assert.deepStrictEqual(initial, { x: 412, y: 70 });
		assert.deepStrictEqual(zoomed, { x: 812, y: 190 });
		assert.deepStrictEqual(inspectorSize, { width: 320, height: 192 });
	});

	test('오른쪽 공간이 부족하면 Node 왼쪽으로 전환하고 Viewport 안으로 clamp한다', () => {
		const node = createStartLayoutNode({ x: 800, y: -200 });
		const position = calculateTaskInspectorPosition(
			node,
			createCameraProjection({ x: 0, y: 0, scale: 1 }),
			{ width: 1_200, height: 800 },
			{ width: 320, height: 192 },
		);

		assert.deepStrictEqual(position, { x: 468, y: 12 });
	});

	test('START ownerRootId select는 동적 문자열 option과 현재 owner를 표시하고 변경을 전달한다', () => {
		const fixture = createInspectorFixture();
		const harness = createInspectorHarness();
		const inputs: TaskInspectorFieldInput[] = [];
		const inspector = initializeTaskInspector(
			harness.overlay.asHtmlElement(),
			harness.viewport.asHtmlElement(),
			createCameraProjection({ x: 0, y: 0, scale: 1 }),
			{ onFieldInput: (input) => inputs.push(input) },
		);

		inspector.apply(
			{ taskId: fixture.taskId, nodeId: fixture.startNodeId },
			fixture.layout,
			{
				options: [{ value: 'workspace-root:file:///app', label: 'app' }, {
					value: 'workspace-root:file:///api',
					label: 'api',
				}],
				ownerRootId: 'workspace-root:file:///api',
			},
		);

		const root = getInspectorRoot(harness.overlay);
		const ownerSelect = getInspectorControl(root, 'ownerRootId');

		assert.strictEqual(ownerSelect.localName, 'select');
		assert.strictEqual(ownerSelect.value, 'workspace-root:file:///api');
		assert.strictEqual(ownerSelect.disabled, false);
		assert.deepStrictEqual(ownerSelect.children.map((option) => ({
			value: option.value,
			label: option.textContent,
		})), [{
			value: 'workspace-root:file:///app',
			label: 'app',
		}, {
			value: 'workspace-root:file:///api',
			label: 'api',
		}]);

		ownerSelect.value = 'workspace-root:file:///app';
		ownerSelect.dispatch('change');
		assert.deepStrictEqual(inputs, [{
			kind: 'start',
			taskId: fixture.taskId,
			nodeId: fixture.startNodeId,
			field: 'ownerRootId',
			value: 'workspace-root:file:///app',
		}]);

		ownerSelect.value = 'workspace-root:file:///unknown';
		ownerSelect.dispatch('change');
		assert.strictEqual(inputs.length, 1);
		inspector.dispose();
	});

	test('Root option/current owner 동기화는 START Inspector와 text caret DOM을 보존한다', () => {
		const fixture = createInspectorFixture();
		const harness = createInspectorHarness();
		const inspector = initializeTaskInspector(
			harness.overlay.asHtmlElement(),
			harness.viewport.asHtmlElement(),
			createCameraProjection({ x: 0, y: 0, scale: 1 }),
		);
		const focus = { taskId: fixture.taskId, nodeId: fixture.startNodeId };

		inspector.apply(focus, fixture.layout, {
			options: [{ value: 'root:a', label: 'A' }, { value: 'root:b', label: 'B' }],
			ownerRootId: 'root:b',
		});
		const firstRoot = getInspectorRoot(harness.overlay);
		const firstTitle = getInspectorControl(firstRoot, 'title');
		const firstOwnerSelect = getInspectorControl(firstRoot, 'ownerRootId');

		firstTitle.focus();
		firstTitle.setSelectionRange(4, 4);
		inspector.apply(focus, fixture.layout, {
			options: [{ value: 'root:b', label: 'Backend' }, {
				value: 'root:a',
				label: 'Frontend',
			}],
			ownerRootId: 'root:a',
		});

		assert.strictEqual(getInspectorRoot(harness.overlay), firstRoot);
		assert.strictEqual(getInspectorControl(firstRoot, 'title'), firstTitle);
		assert.strictEqual(
			getInspectorControl(firstRoot, 'ownerRootId'),
			firstOwnerSelect,
		);
		assert.strictEqual(harness.ownerDocument.activeElement, firstTitle);
		assert.strictEqual(firstTitle.selectionStart, 4);
		assert.strictEqual(firstTitle.selectionEnd, 4);
		assert.strictEqual(firstOwnerSelect.value, 'root:a');
		assert.deepStrictEqual(firstOwnerSelect.children.map((option) => ({
			value: option.value,
			label: option.textContent,
		})), [{ value: 'root:b', label: 'Backend' }, {
			value: 'root:a',
			label: 'Frontend',
		}]);
		inspector.dispose();
	});

	test('ownerRootId는 WORK Inspector에 노출하지 않고 단일 Root select는 비활성화한다', () => {
		const fixture = createInspectorFixture();
		const harness = createInspectorHarness();
		const inspector = initializeTaskInspector(
			harness.overlay.asHtmlElement(),
			harness.viewport.asHtmlElement(),
			createCameraProjection({ x: 0, y: 0, scale: 1 }),
		);
		const workspaceContext = {
			options: [{ value: 'root:only', label: 'Only workspace' }],
			ownerRootId: 'root:only',
		};

		inspector.apply(
			{ taskId: fixture.taskId, nodeId: fixture.startNodeId },
			fixture.layout,
			workspaceContext,
		);
		assert.strictEqual(
			getInspectorControl(getInspectorRoot(harness.overlay), 'ownerRootId').disabled,
			true,
		);

		inspector.apply(
			{ taskId: fixture.taskId, nodeId: fixture.workNodeId },
			fixture.layout,
			workspaceContext,
		);
		const workInspector = getInspectorRoot(harness.overlay);

		assert.strictEqual(findInspectorControl(workInspector, 'ownerRootId'), undefined);
		assert.ok(findInspectorControl(workInspector, 'agentProviderId'));
		inspector.dispose();
	});
});

function createInspectorFixture(): {
	readonly taskId: string;
	readonly startNodeId: string;
	readonly workNodeId: string;
	readonly layout: ReturnType<typeof createTaskGraphLayout>;
} {
	let sequence = 0;
	const state = createTaskState([], () => `owner-${++sequence}`);
	const task = state.createTask({ title: 'Inspector Task', origin: { x: 100, y: 80 } });
	const withWork = state.addWork(task.id, { title: 'Inspector Work' });
	const start = withWork?.nodes.find((node) => node.kind === 'start');
	const work = withWork?.nodes.find((node) => node.kind === 'work');

	assert.ok(withWork && start && work?.kind === 'work');
	return {
		taskId: withWork.id,
		startNodeId: start.id,
		workNodeId: work.id,
		layout: createTaskGraphLayout([withWork]),
	};
}

function createInspectorHarness(): {
	readonly ownerDocument: FakeInspectorDocument;
	readonly overlay: FakeInspectorElement;
	readonly viewport: FakeInspectorElement;
} {
	const ownerDocument = new FakeInspectorDocument();
	const overlay = ownerDocument.createElement('div');
	const viewport = ownerDocument.createElement('div');

	viewport.clientWidth = 1_200;
	viewport.clientHeight = 800;
	return { ownerDocument, overlay, viewport };
}

function getInspectorRoot(element: FakeInspectorElement): FakeInspectorElement {
	const inspector = findByAttribute(element, TASK_INSPECTOR_ATTRIBUTE, '');

	assert.ok(inspector);
	return inspector;
}

function getInspectorControl(
	element: FakeInspectorElement,
	field: string,
): FakeInspectorElement {
	const control = findInspectorControl(element, field);

	assert.ok(control);
	return control;
}

function findInspectorControl(
	element: FakeInspectorElement,
	field: string,
): FakeInspectorElement | undefined {
	return findByAttribute(element, TASK_INSPECTOR_FIELD_ATTRIBUTE, field);
}

function findByAttribute(
	element: FakeInspectorElement,
	name: string,
	value: string,
): FakeInspectorElement | undefined {
	for (const child of element.children) {
		if (child.getAttribute(name) === value) {
			return child;
		}
		const descendant = findByAttribute(child, name, value);

		if (descendant) {
			return descendant;
		}
	}

	return undefined;
}

type FakeInspectorEventListener = (event: Event) => void;

class FakeInspectorDocument {
	activeElement: FakeInspectorElement | null = null;

	createElement(localName: string): FakeInspectorElement {
		return new FakeInspectorElement(this, localName);
	}
}

class FakeInspectorElement {
	readonly children: FakeInspectorElement[] = [];
	readonly style = { width: '', left: '', top: '' };
	className = '';
	textContent = '';
	value = '';
	type = '';
	rows = 0;
	disabled = false;
	clientWidth = 0;
	clientHeight = 0;
	offsetHeight = 0;
	selectionStart: number | null = null;
	selectionEnd: number | null = null;
	private readonly attributes = new Map<string, string>();
	private readonly listeners = new Map<string, Set<FakeInspectorEventListener>>();
	private parent: FakeInspectorElement | undefined;

	constructor(
		readonly ownerDocument: FakeInspectorDocument,
		readonly localName: string,
	) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	append(...children: FakeInspectorElement[]): void {
		for (const child of children) {
			child.parent = this;
			this.children.push(child);
		}
	}

	replaceChildren(...children: FakeInspectorElement[]): void {
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
		this.parent = undefined;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}

	addEventListener(type: string, listener: FakeInspectorEventListener): void {
		const listeners = this.listeners.get(type) ?? new Set();

		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: FakeInspectorEventListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	dispatch(type: string, event?: Event): void {
		const dispatched = event ?? createFakeInspectorEvent(this);

		for (const listener of this.listeners.get(type) ?? []) {
			listener(dispatched);
		}
		if (!(dispatched as Event & { propagationStopped?: boolean }).propagationStopped) {
			this.parent?.dispatch(type, dispatched);
		}
	}

	focus(): void {
		this.ownerDocument.activeElement = this;
	}

	setSelectionRange(start: number, end: number): void {
		this.selectionStart = start;
		this.selectionEnd = end;
	}
}

function createFakeInspectorEvent(target: FakeInspectorElement): Event {
	const event = {
		target,
		propagationStopped: false,
		stopPropagation(): void {
			this.propagationStopped = true;
		},
	};

	return event as unknown as Event;
}

function createStartLayoutNode(origin: { readonly x: number; readonly y: number }) {
	let sequence = 0;
	const task = createDefaultTaskBlueprint({
		title: 'Inspector Task',
		origin,
	}, () => `inspector-${++sequence}`);
	const node = createTaskGraphLayout([task]).nodes.find(
		(candidate) => candidate.kind === 'start',
	);

	assert.ok(node);
	return node;
}

function createCameraProjection(
	state: { readonly x: number; readonly y: number; readonly scale: number },
) {
	return {
		worldToViewport: (point: { readonly x: number; readonly y: number }) => ({
			x: point.x * state.scale + state.x,
			y: point.y * state.scale + state.y,
		}),
	};
}
