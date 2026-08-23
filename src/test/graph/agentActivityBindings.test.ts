import * as assert from 'assert';
import type { GraphNodeEffectTarget } from '../../messages';
import {
	createAgentActivityStore,
	type AgentActivityStore,
} from '../../agent/webview/agentActivityStore';
import { createAgentActivityBindings } from '../../webview/graph/agentActivityBindings';

const TARGET_X: GraphNodeEffectTarget = { nodeId: 'file:workspace/src/x.ts' };
const TARGET_Y: GraphNodeEffectTarget = { nodeId: 'folder:workspace/src/y' };

suite('Agent Activity Bindings', () => {
	test('단일 Session Binding에 Target, Session Id와 Activity를 표시한다', () => {
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const element = createTargetElement();

		bindings.registerTarget(TARGET_X, element.asHtmlElement());
		store.setAgentActivity('session-A', TARGET_X, 'editing');

		const container = getBindingContainer(element);
		const [binding] = getBindingElements(element);

		assert.strictEqual(container.getAttribute('data-graph-node-id'), TARGET_X.nodeId);
		assert.strictEqual(container.getAttribute('data-graph-root-id'), null);
		assert.strictEqual(binding.getAttribute('data-session-id'), 'session-A');
		assert.strictEqual(binding.getAttribute('data-activity'), 'editing');
		assert.strictEqual(binding.children[0]?.textContent, 'session-A');
		assert.strictEqual(binding.children[1]?.textContent, '[editing]');

		bindings.dispose();
	});

	test('Store snapshot의 정렬 순서를 재조회나 재정렬 없이 그대로 렌더링한다', () => {
		const sourceStore = createAgentActivityStore();
		let getActivitiesCallCount = 0;
		const store: AgentActivityStore = {
			...sourceStore,
			getActivities(target) {
				getActivitiesCallCount += 1;
				return sourceStore.getActivities(target);
			},
		};
		const bindings = createAgentActivityBindings(store);
		const element = createTargetElement();

		bindings.registerTarget(TARGET_X, element.asHtmlElement());
		store.setAgentActivity('session-A', TARGET_X, 'planned');
		store.setAgentActivity('session-B', TARGET_X, 'editing');
		store.setAgentActivity('session-C', TARGET_X, 'active');

		assert.deepStrictEqual(getBindingState(element), [
			['session-B', 'editing'],
			['session-C', 'active'],
			['session-A', 'planned'],
		]);
		assert.strictEqual(getActivitiesCallCount, 0);

		bindings.dispose();
	});

	test('같은 Session DOM을 갱신하고 snapshot 순서의 새 위치로 이동한다', () => {
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const element = createTargetElement();

		bindings.registerTarget(TARGET_X, element.asHtmlElement());
		store.setAgentActivity('session-A', TARGET_X, 'planned');
		store.setAgentActivity('session-B', TARGET_X, 'active');
		const sessionABinding = getBindingElements(element)[1];

		store.setAgentActivity('session-A', TARGET_X, 'rejected');

		assert.strictEqual(getBindingElements(element)[0], sessionABinding);
		assert.deepStrictEqual(getBindingState(element), [
			['session-A', 'rejected'],
			['session-B', 'active'],
		]);
		assert.strictEqual(getBindingElements(element).length, 2);

		bindings.dispose();
	});

	test('단일 clear와 clearSession은 관계없는 Session과 Target을 유지한다', () => {
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const elementX = createTargetElement();
		const elementY = createTargetElement();

		bindings.registerTarget(TARGET_X, elementX.asHtmlElement());
		bindings.registerTarget(TARGET_Y, elementY.asHtmlElement());
		store.setAgentActivity('session-A', TARGET_X, 'editing');
		store.setAgentActivity('session-B', TARGET_X, 'planned');
		store.setAgentActivity('session-A', TARGET_Y, 'active');
		store.setAgentActivity('session-C', TARGET_Y, 'mentioned');
		const targetYContainer = getBindingContainer(elementY);
		const sessionCBinding = getBindingElements(elementY)[1];

		store.clearAgentActivity('session-A', TARGET_X);

		assert.deepStrictEqual(getBindingState(elementX), [
			['session-B', 'planned'],
		]);
		assert.deepStrictEqual(getBindingState(elementY), [
			['session-A', 'active'],
			['session-C', 'mentioned'],
		]);
		assert.strictEqual(getBindingContainer(elementY), targetYContainer);
		assert.strictEqual(getBindingElements(elementY)[1], sessionCBinding);

		store.clearAgentActivitiesBySession('session-A');

		assert.deepStrictEqual(getBindingState(elementX), [
			['session-B', 'planned'],
		]);
		assert.deepStrictEqual(getBindingState(elementY), [
			['session-C', 'mentioned'],
		]);
		assert.strictEqual(getBindingElements(elementY)[0], sessionCBinding);

		store.clearAgentActivitiesBySession('session-B');
		assert.strictEqual(findBindingContainer(elementX), undefined);
		assert.strictEqual(
			elementX.hasClass('graph-agent-activity-binding-host'),
			false,
		);

		bindings.dispose();
	});

	test('Source Activity를 Detached occurrence에 기존 ordering으로 투영한다', () => {
		const occurrenceTarget: GraphNodeEffectTarget = {
			nodeId: TARGET_X.nodeId,
			rootId: 'detached:root:A',
		};
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const elementX = createTargetElement();
		const occurrenceElement = createTargetElement();

		bindings.registerTarget(TARGET_X, elementX.asHtmlElement());
		bindings.registerTarget(occurrenceTarget, occurrenceElement.asHtmlElement());
		store.setAgentActivity('session-A', TARGET_X, 'planned');
		store.setAgentActivity('session-B', occurrenceTarget, 'editing');

		assert.deepStrictEqual(getBindingState(elementX), [
			['session-A', 'planned'],
		]);
		assert.deepStrictEqual(getBindingState(occurrenceElement), [
			['session-B', 'editing'],
			['session-A', 'planned'],
		]);

		bindings.dispose();
	});

	test('occurrence Activity는 동일 Session만 override하고 다른 occurrence는 Source를 유지한다', () => {
		const rootATarget: GraphNodeEffectTarget = {
			nodeId: TARGET_X.nodeId,
			rootId: 'detached:root:A',
		};
		const rootBTarget: GraphNodeEffectTarget = {
			nodeId: TARGET_X.nodeId,
			rootId: 'detached:root:B',
		};
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const elementA = createTargetElement();
		const elementB = createTargetElement();

		bindings.registerTarget(rootATarget, elementA.asHtmlElement());
		bindings.registerTarget(rootBTarget, elementB.asHtmlElement());
		store.setAgentActivity('session-A', TARGET_X, 'planned');
		store.setAgentActivity('session-B', TARGET_X, 'active');
		store.setAgentActivity('session-A', rootATarget, 'editing');
		store.setAgentActivity('session-C', rootATarget, 'mentioned');

		assert.deepStrictEqual(getBindingState(elementA), [
			['session-A', 'editing'],
			['session-B', 'active'],
			['session-C', 'mentioned'],
		]);
		assert.deepStrictEqual(getBindingState(elementB), [
			['session-B', 'active'],
			['session-A', 'planned'],
		]);

		store.clearAgentActivity('session-A', rootATarget);

		assert.deepStrictEqual(getBindingState(elementA), [
			['session-B', 'active'],
			['session-A', 'planned'],
			['session-C', 'mentioned'],
		]);
		assert.deepStrictEqual(getBindingState(elementB), [
			['session-B', 'active'],
			['session-A', 'planned'],
		]);

		bindings.dispose();
	});

	test('Target remount 시 snapshot을 복원하고 dispose 후 DOM과 구독을 정리한다', () => {
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const firstElement = createTargetElement();
		const secondElement = createTargetElement();

		store.setAgentActivity('session-A', TARGET_X, 'completed');
		const unregisterFirst = bindings.registerTarget(
			TARGET_X,
			firstElement.asHtmlElement(),
		);

		assert.deepStrictEqual(getBindingState(firstElement), [
			['session-A', 'completed'],
		]);

		unregisterFirst();
		assert.strictEqual(findBindingContainer(firstElement), undefined);
		bindings.registerTarget(TARGET_X, secondElement.asHtmlElement());
		assert.deepStrictEqual(getBindingState(secondElement), [
			['session-A', 'completed'],
		]);

		bindings.dispose();
		assert.strictEqual(findBindingContainer(secondElement), undefined);
		store.setAgentActivity('session-B', TARGET_X, 'editing');
		assert.strictEqual(findBindingContainer(secondElement), undefined);

		const afterDisposeElement = createTargetElement();
		bindings.registerTarget(TARGET_X, afterDisposeElement.asHtmlElement());
		assert.strictEqual(findBindingContainer(afterDisposeElement), undefined);
	});
});

class FakeDocument {
	createElement(): FakeElement {
		return new FakeElement(this);
	}
}

class FakeElement {
	readonly children: FakeElement[] = [];
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
	private readonly classNames = new Set<string>();
	private readonly attributes = new Map<string, string>();
	private parent: FakeElement | undefined;

	constructor(readonly ownerDocument: FakeDocument) {}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	append(...children: FakeElement[]): void {
		for (const child of children) {
			child.remove();
			child.parent = this;
			this.children.push(child);
		}
	}

	replaceChildren(...children: FakeElement[]): void {
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

	setAttribute(name: string, value = ''): void {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	hasClass(className: string): boolean {
		return this.classNames.has(className)
			|| this.className.split(/\s+/).includes(className);
	}
}

function createTargetElement(): FakeElement {
	return new FakeDocument().createElement();
}

function findBindingContainer(element: FakeElement): FakeElement | undefined {
	return element.children.find((child) => (
		child.hasClass('graph-agent-activity-bindings')
	));
}

function getBindingContainer(element: FakeElement): FakeElement {
	const container = findBindingContainer(element);

	assert.ok(container);
	return container;
}

function getBindingElements(element: FakeElement): FakeElement[] {
	return getBindingContainer(element).children;
}

function getBindingState(element: FakeElement): Array<readonly [string, string]> {
	return getBindingElements(element).map((binding) => [
		binding.getAttribute('data-session-id') ?? '',
		binding.getAttribute('data-activity') ?? '',
	]);
}
