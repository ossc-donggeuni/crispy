import * as assert from 'assert';
import { initializeGraphView } from '../../webview/graph/graphView';

suite('Graph View', () => {
	test('초기 Graph Camera 상태를 Store와 World transform에 복원한다', () => {
		const ownerDocument = new FakeDocument();
		const root = ownerDocument.createElement('section');
		const graphView = initializeGraphView(
			root.asHtmlElement(),
			{
				camera: { x: 120, y: -45, scale: 1.5 },
				nodePositions: {},
			},
		);

		assert.deepStrictEqual(graphView.state.getState(), {
			camera: { x: 120, y: -45, scale: 1.5 },
			nodePositions: {},
			fileGroupPages: {},
		});
		assert.deepStrictEqual(graphView.camera.getState(), {
			x: 120,
			y: -45,
			scale: 1.5,
		});
		assert.strictEqual(
			root.children[0]?.children[0]?.style.transform,
			'translate(120px, -45px) scale(1.5)',
		);
		const overlayLayer = root.children[0]?.children[1];
		assert.strictEqual(overlayLayer?.className, 'graph-overlay-layer');
		assert.strictEqual(
			overlayLayer?.children[0]?.children[0]?.textContent,
			'(120, -45)',
		);
		assert.strictEqual(
			overlayLayer?.children[0]?.children[1]?.children[1]?.textContent,
			'150%',
		);

		graphView.dispose();
		assert.strictEqual(root.children.length, 0);
	});
});

type GraphEventListener = (event: Event) => void;

class FakeDocument {
	createElement(_tagName?: string): FakeElement {
		return new FakeElement(this);
	}

	createElementNS(_namespace?: string, _qualifiedName?: string): FakeElement {
		return new FakeElement(this);
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
	clientWidth = 1000;
	clientHeight = 800;
	private readonly classNames = new Set<string>();
	private readonly listeners = new Map<string, Set<GraphEventListener>>();
	private parent: FakeElement | undefined;

	constructor(readonly ownerDocument: FakeDocument) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
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

	setAttribute(): void {}

	addEventListener(type: string, listener: GraphEventListener): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: GraphEventListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	hasPointerCapture(): boolean {
		return false;
	}

	releasePointerCapture(): void {}

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
