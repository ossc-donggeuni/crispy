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
	readonly dataset: Record<string, string | undefined> = {};
	readonly attributes = new Map<string, string>();
	children: FakeAgentElement[] = [];
	focusCount = 0;

	private readonly listeners = new Map<string, Array<() => void>>();

	constructor(readonly tagName: string = 'div') {}

	/** production 코드가 기대하는 DOM 타입으로 대역을 전달한다. */
	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	append(...nodes: FakeAgentElement[]): void {
		this.children.push(...nodes);
	}

	replaceChildren(...nodes: FakeAgentElement[]): void {
		this.children = [...nodes];
	}

	addEventListener(type: string, listener: () => void): void {
		const registered = this.listeners.get(type) ?? [];
		registered.push(listener);
		this.listeners.set(type, registered);
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

	focus(): void {
		this.focusCount += 1;
	}

	/** 자신을 포함한 하위 트리에 주어진 요소가 있는지 확인한다. */
	contains(node: unknown): boolean {
		if (this === node) {
			return true;
		}

		return this.children.some((child) => child.contains(node));
	}

	/** 등록된 listener를 순서대로 실행한다. */
	dispatch(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener();
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
			new FakeAgentElement(tagName).asHtmlElement()) as AgentUiDependencies['createElement'],
		addDocumentListener: (type, listener) => documentEvents.add(type, listener),
	};
}

/** 대기 중인 microtask가 모두 실행되도록 한 tick을 넘긴다. */
export function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}
