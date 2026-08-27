import type { AgentUiDependencies } from '../../../agent/UI/agentUiDom';

/**
 * Agent UI 검증에 필요한 최소 DOM 동작만 제공하는 테스트 대역이다.
 * Extension Host 테스트 환경에는 `document`가 없으므로 요소 생성을 직접 대신한다.
 */
export class FakeAgentElement {
	className = '';
	textContent = '';
	title = '';
	type = '';
	value = '';
	disabled = false;
	hidden = false;
	tabIndex = 0;
	selectCount = 0;
	scrollLeft = 0;
	scrollWidth = 0;
	clientWidth = 0;
	private readonly capturedPointerIds = new Set<number>();
	private readonly styleProperties = new Map<string, string>();
	readonly style = {
		left: '',
		top: '',
		setProperty: (name: string, value: string) => {
			this.styleProperties.set(name, value);
		},
		getPropertyValue: (name: string) => this.styleProperties.get(name) ?? '',
	};
	readonly rect = {
		left: 0,
		top: 0,
		right: 160,
		bottom: 32,
		width: 160,
		height: 32,
	};
	readonly dataset: Record<string, string | undefined> = {};
	readonly attributes = new Map<string, string>();
	children: FakeAgentElement[] = [];
	focusCount = 0;

	/** `remove()`가 자신을 떼어낼 수 있도록 유지하는 부모 참조다. */
	parent: FakeAgentElement | undefined;

	private readonly listeners = new Map<
		string,
		Array<(event: Event) => void>
	>();

	constructor(
		readonly tagName: string = 'div',
		private readonly onFocus?: (element: FakeAgentElement) => void,
	) {}

	get parentElement(): FakeAgentElement | undefined {
		return this.parent;
	}

	/** production 코드가 기대하는 DOM 타입으로 대역을 전달한다. */
	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	append(...nodes: FakeAgentElement[]): void {
		for (const node of nodes) {
			node.parent = this;
		}
		this.children.push(...nodes);
	}

	replaceChildren(...nodes: FakeAgentElement[]): void {
		for (const child of this.children) {
			child.parent = undefined;
		}
		for (const node of nodes) {
			node.parent = this;
		}
		this.children = [...nodes];
	}

	/** 부모의 자식 목록에서 자신을 제거한다. */
	remove(): void {
		const parent = this.parent;
		if (parent === undefined) {
			return;
		}

		parent.children = parent.children.filter((child) => child !== this);
		this.parent = undefined;
	}

	addEventListener(type: string, listener: (event: Event) => void): void {
		const registered = this.listeners.get(type) ?? [];
		registered.push(listener);
		this.listeners.set(type, registered);
	}

	removeEventListener(type: string, listener: (event: Event) => void): void {
		this.listeners.set(
			type,
			(this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
		);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | undefined {
		return this.attributes.get(name);
	}

	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}

	setPointerCapture(pointerId: number): void {
		this.capturedPointerIds.add(pointerId);
	}

	hasPointerCapture(pointerId: number): boolean {
		return this.capturedPointerIds.has(pointerId);
	}

	releasePointerCapture(pointerId: number): void {
		this.capturedPointerIds.delete(pointerId);
	}

	focus(): void {
		this.focusCount += 1;
		this.onFocus?.(this);
	}

	select(): void {
		this.selectCount += 1;
	}

	/** 자신을 포함한 하위 트리에 주어진 요소가 있는지 확인한다. */
	contains(node: unknown): boolean {
		if (this === node) {
			return true;
		}

		return this.children.some((child) => child.contains(node));
	}

	/** 등록된 listener를 순서대로 실행한다. */
	dispatch(type: string, event: Record<string, unknown> = {}): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event as unknown as Event);
		}
	}

	/** click listener를 실행한다. */
	click(): void {
		this.dispatch('click');
	}

	/** 현재 요소를 포함한 하위 트리에서 주어진 class를 가진 첫 요소를 찾는다. */
	find(className: string): FakeAgentElement | undefined {
		return this.findAll(className)[0];
	}

	/** 현재 요소를 포함한 하위 트리에서 주어진 class를 가진 모든 요소를 찾는다. */
	findAll(className: string): FakeAgentElement[] {
		const matched: FakeAgentElement[] = [];
		if (this.className === className) {
			matched.push(this);
		}

		for (const child of this.children) {
			matched.push(...child.findAll(className));
		}

		return matched;
	}
}

/** 문서 수준 이벤트를 기록하고 테스트에서 직접 발생시키는 대역이다. */
export class FakeDocumentEvents {
	activeElement: FakeAgentElement | undefined;
	private readonly listeners = new Map<string, Array<(event: Event) => void>>();

	/** production 코드가 사용하는 구독 함수다. */
	add(type: string, listener: (event: Event) => void): () => void {
		const registered = this.listeners.get(type) ?? [];
		registered.push(listener);
		this.listeners.set(type, registered);

		return () => {
			this.listeners.set(
				type,
				(this.listeners.get(type) ?? []).filter((entry) => entry !== listener),
			);
		};
	}

	/** 등록된 listener 수를 반환한다. */
	countListeners(type: string): number {
		return (this.listeners.get(type) ?? []).length;
	}

	/** 주어진 이벤트를 등록된 listener에 전달한다. */
	dispatch(type: string, event: Record<string, unknown> = {}): void {
		for (const listener of [...(this.listeners.get(type) ?? [])]) {
			listener(event as unknown as Event);
		}
	}
}

/**
 * `FakeAgentElement`만 생성하는 Agent UI DOM 의존성을 만든다.
 *
 * @param documentEvents 문서 수준 이벤트를 기록할 대역
 * @returns production 코드에 주입할 DOM 의존성
 */
export function createFakeAgentUiDependencies(
	documentEvents: FakeDocumentEvents = new FakeDocumentEvents(),
): AgentUiDependencies {
	return {
		createElement: ((tagName: string) =>
			new FakeAgentElement(
				tagName,
				(element) => documentEvents.activeElement = element,
			).asHtmlElement()) as AgentUiDependencies['createElement'],
		addDocumentListener: (type, listener) => documentEvents.add(type, listener),
		getElementRect: (element) => ({
			...(element as unknown as FakeAgentElement).rect,
			toJSON: () => ({}),
			x: (element as unknown as FakeAgentElement).rect.left,
			y: (element as unknown as FakeAgentElement).rect.top,
		} as DOMRect),
		getViewportSize: () => ({ width: 1024, height: 768 }),
		getActiveElement: () => documentEvents.activeElement?.asHtmlElement() ?? null,
		addWindowListener: (type, listener) => documentEvents.add(`window:${type}`, listener),
	};
}

/** 대기 중인 microtask가 모두 실행되도록 한 tick을 넘긴다. */
export function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
