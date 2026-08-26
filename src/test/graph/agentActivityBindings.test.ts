import * as assert from 'assert';
import type { AgentActivityKind, GraphNodeEffectTarget } from '../../messages';
import {
	createAgentActivityStore,
	type AgentActivityStore,
} from '../../agent/webview/agentActivityStore';
import { createAgentSessionPresentationStore } from '../../agent/webview/agentSessionPresentationStore';
import {
	AGENT_ACTIVITY_BINDING_ROW_GAP,
	AGENT_ACTIVITY_BINDING_ROW_HEIGHT,
	AGENT_ACTIVITY_BINDING_TOP_GAP,
	createAgentActivityBindings,
	getAgentActivityBindingBlockHeight,
} from '../../webview/graph/agentActivityBindings';
import {
	getAgentActivityEffects,
	resolveAgentActivityColor,
} from '../../webview/graph/agentActivityPresentation';
import { createGraphNodeEffects } from '../../webview/graph/graphNodeEffects';

const TARGET_X: GraphNodeEffectTarget = { nodeId: 'file:workspace/src/x.ts' };
const TARGET_Y: GraphNodeEffectTarget = { nodeId: 'folder:workspace/src/y' };

suite('Agent Activity Bindings', () => {
	test('running 세션의 제목과 현재 메시지만 표시하고 content 갱신은 DOM과 Layout을 재사용한다', () => {
		const store = createAgentActivityStore();
		const presentations = createAgentSessionPresentationStore();
		const bindings = createAgentActivityBindings(store, undefined, presentations);
		const elementX = createTargetElement();
		const elementY = createTargetElement();

		bindings.registerTarget(TARGET_X, elementX.asHtmlElement());
		bindings.registerTarget(TARGET_Y, elementY.asHtmlElement());
		store.setAgentActivity('session-A', TARGET_X, 'editing');
		store.setAgentActivity('session-A', TARGET_Y, 'active');
		assert.strictEqual(findBindingContainer(elementX), undefined);

		presentations.startSession('tab-A', 'session-A', 'Implement bindings');
		assert.strictEqual(findBindingContainer(elementX), undefined);
		presentations.activateSession('tab-A', 'session-A', 'Implement bindings');
		const bindingX = getBindingElements(elementX)[0];
		const bindingY = getBindingElements(elementY)[0];
		const effectLayerX = getBindingEffectLayer(bindingX);
		let countNotifications = 0;
		bindings.subscribeBindingCountChanges(() => countNotifications += 1);

		assert.strictEqual(bindingX.children[0]?.textContent, 'Implement bindings');
		assert.strictEqual(bindingX.children[1]?.textContent, 'Waiting for output…');
		assert.strictEqual(bindingX.getAttribute('data-session-id'), 'session-A');
		assert.strictEqual(bindingX.getAttribute('data-activity'), 'editing');

		presentations.updateCurrentMessage('tab-A', 'session-A', 'Running tests');
		presentations.updateTitle('session-A', 'Agent binding feature');

		assert.strictEqual(getBindingElements(elementX)[0], bindingX);
		assert.strictEqual(getBindingElements(elementY)[0], bindingY);
		assert.strictEqual(getBindingEffectLayer(bindingX), effectLayerX);
		assert.strictEqual(bindingX.children[0]?.textContent, 'Agent binding feature');
		assert.strictEqual(bindingX.children[1]?.textContent, 'Running tests');
		assert.strictEqual(bindingY.children[1]?.textContent, 'Running tests');
		assert.strictEqual(countNotifications, 0);

		presentations.endSession('session-A');
		assert.strictEqual(findBindingContainer(elementX), undefined);
		assert.strictEqual(findBindingContainer(elementY), undefined);
		assert.strictEqual(countNotifications, 1);
		bindings.dispose();
	});

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

	test('effective Binding 개수 변경만 Layout subscriber에 한 번 통지한다', () => {
		const occurrenceTarget: GraphNodeEffectTarget = {
			nodeId: TARGET_X.nodeId,
			rootId: 'detached:root:layout',
		};
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const occurrenceElement = createTargetElement();
		let notifications = 0;

		bindings.registerTarget(
			occurrenceTarget,
			occurrenceElement.asHtmlElement(),
		);
		const unsubscribe = bindings.subscribeBindingCountChanges(() => {
			notifications += 1;
		});

		store.setAgentActivity('session-A', TARGET_X, 'planned');
		assert.strictEqual(bindings.getBindingCount(occurrenceTarget), 1);
		assert.strictEqual(notifications, 1);

		store.setAgentActivity('session-A', TARGET_X, 'editing');
		store.setAgentActivity('session-A', occurrenceTarget, 'rejected');
		assert.strictEqual(bindings.getBindingCount(occurrenceTarget), 1);
		assert.strictEqual(notifications, 1);

		store.setAgentActivity('session-B', occurrenceTarget, 'active');
		assert.strictEqual(bindings.getBindingCount(occurrenceTarget), 2);
		assert.strictEqual(notifications, 2);

		store.clearAgentActivitiesBySession('session-A');
		assert.strictEqual(bindings.getBindingCount(occurrenceTarget), 1);
		assert.strictEqual(notifications, 3);

		unsubscribe();
		store.clearAgentActivitiesBySession('session-B');
		assert.strictEqual(notifications, 3);
		bindings.dispose();
	});

	test('Binding CSS와 Layout이 공유하는 고정 Row footprint 규약을 노출한다', () => {
		assert.strictEqual(AGENT_ACTIVITY_BINDING_TOP_GAP, 6);
		assert.strictEqual(AGENT_ACTIVITY_BINDING_ROW_HEIGHT, 42);
		assert.strictEqual(AGENT_ACTIVITY_BINDING_ROW_GAP, 4);
		assert.strictEqual(getAgentActivityBindingBlockHeight(2), 94);
	});

	test('각 Binding은 6개 Activity별 G-11 Effect 조합을 독립적으로 렌더링한다', () => {
		const mappings: ReadonlyArray<readonly [AgentActivityKind, readonly string[]]> = [
			['planned', ['marching-dash', 'icon:alert']],
			['active', ['shimmer']],
			['editing', ['pulse']],
			['completed', ['outline', 'icon:check']],
			['mentioned', ['outline-strong']],
			['rejected', ['outline', 'icon:cancel']],
		];

		for (const [activity, expectedEffects] of mappings) {
			const store = createAgentActivityStore();
			const bindings = createAgentActivityBindings(store);
			const element = createTargetElement();

			bindings.registerTarget(TARGET_X, element.asHtmlElement());
			store.setAgentActivity('session-A', TARGET_X, activity);

			const binding = getBindingElements(element)[0];
			assert.deepStrictEqual(getBindingEffectKinds(binding), expectedEffects);
			assert.strictEqual(binding.hasClass('graph-node-effect-host'), true);
			assert.strictEqual(
				getBindingEffectColor(binding),
				getAgentActivityEffects('session-A', activity)[0]?.color,
			);

			bindings.dispose();
		}
	});

	test('Multi-Session Binding은 자신의 Activity Effect만 유지한다', () => {
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const element = createTargetElement();

		bindings.registerTarget(TARGET_X, element.asHtmlElement());
		store.setAgentActivity('session-A', TARGET_X, 'active');
		store.setAgentActivity('session-B', TARGET_X, 'planned');

		const [activeBinding, plannedBinding] = getBindingElements(element);
		assert.strictEqual(activeBinding.getAttribute('data-session-id'), 'session-A');
		assert.deepStrictEqual(getBindingEffectKinds(activeBinding), ['shimmer']);
		assert.strictEqual(plannedBinding.getAttribute('data-session-id'), 'session-B');
		assert.deepStrictEqual(getBindingEffectKinds(plannedBinding), [
			'marching-dash',
			'icon:alert',
		]);

		bindings.dispose();
	});

	test('Activity 변경은 Binding DOM을 재사용하며 이전 Effect를 제거하고 같은 Activity는 재생성하지 않는다', () => {
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const element = createTargetElement();

		bindings.registerTarget(TARGET_X, element.asHtmlElement());
		store.setAgentActivity('session-A', TARGET_X, 'planned');
		const binding = getBindingElements(element)[0];
		const originalLayer = getBindingEffectLayer(binding);

		store.setAgentActivity('session-A', TARGET_X, 'editing');

		assert.strictEqual(getBindingElements(element)[0], binding);
		assert.deepStrictEqual(getBindingEffectKinds(binding), ['pulse']);
		assert.strictEqual(findBindingEffect(binding, 'marching-dash'), undefined);
		assert.strictEqual(findBindingEffect(binding, 'icon'), undefined);
		assert.strictEqual(getBindingEffectLayer(binding), originalLayer);

		const updatedLayer = getBindingEffectLayer(binding);
		const updatedPulse = findBindingEffect(binding, 'pulse');
		store.setAgentActivity('session-A', TARGET_X, 'editing');
		assert.strictEqual(getBindingEffectLayer(binding), updatedLayer);
		assert.strictEqual(findBindingEffect(binding, 'pulse'), updatedPulse);
		assert.deepStrictEqual(getBindingEffectKinds(binding), ['pulse']);

		bindings.dispose();
	});

	test('clear, clearSession, unregister 및 dispose는 Binding local Effect를 함께 정리한다', () => {
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const elementX = createTargetElement();
		const elementY = createTargetElement();

		const unregisterX = bindings.registerTarget(TARGET_X, elementX.asHtmlElement());
		bindings.registerTarget(TARGET_Y, elementY.asHtmlElement());
		store.setAgentActivity('session-A', TARGET_X, 'editing');
		store.setAgentActivity('session-A', TARGET_Y, 'active');
		const bindingX = getBindingElements(elementX)[0];
		const bindingY = getBindingElements(elementY)[0];

		store.clearAgentActivity('session-A', TARGET_X);
		assert.strictEqual(getBindingEffectLayer(bindingX), undefined);
		assert.strictEqual(bindingX.hasClass('graph-node-effect-host'), false);

		store.clearAgentActivitiesBySession('session-A');
		assert.strictEqual(getBindingEffectLayer(bindingY), undefined);
		assert.strictEqual(bindingY.hasClass('graph-node-effect-host'), false);

		store.setAgentActivity('session-B', TARGET_X, 'planned');
		const bindingAfterReregister = getBindingElements(elementX)[0];
		unregisterX();
		assert.strictEqual(getBindingEffectLayer(bindingAfterReregister), undefined);
		assert.strictEqual(bindingAfterReregister.hasClass('graph-node-effect-host'), false);

		store.setAgentActivity('session-C', TARGET_Y, 'rejected');
		const bindingBeforeDispose = getBindingElements(elementY)[0];
		bindings.dispose();
		assert.strictEqual(getBindingEffectLayer(bindingBeforeDispose), undefined);
		assert.strictEqual(bindingBeforeDispose.hasClass('graph-node-effect-host'), false);
	});

	test('debug-g12 Binding은 target representative와 공유하는 안정적인 Session 색을 사용한다', () => {
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(store);
		const element = createTargetElement();
		const sessionId = 'debug-g12-editing';

		bindings.registerTarget(TARGET_X, element.asHtmlElement());
		store.setAgentActivity(sessionId, TARGET_X, 'editing');

		const binding = getBindingElements(element)[0];
		assert.strictEqual(
			getBindingEffectColor(binding),
			resolveAgentActivityColor(sessionId, 'editing'),
		);

		bindings.dispose();
	});

	test('Parent Effect와 remount된 Binding은 같은 G-11 animation timeline에 합류한다', () => {
		const ownerDocument = new FakeDocument();
		let animationTime = 100;
		const nodeEffects = createGraphNodeEffects(
			ownerDocument as unknown as Document,
			() => animationTime,
		);
		const store = createAgentActivityStore();
		const bindings = createAgentActivityBindings(
			store,
			nodeEffects.createLocalEffectHost,
		);
		const element = ownerDocument.createElement();

		nodeEffects.registerNode(TARGET_X, element.asHtmlElement());
		const unregisterBinding = bindings.registerTarget(
			TARGET_X,
			element.asHtmlElement(),
		);
		animationTime = 350;
		for (const effect of getAgentActivityEffects('session-A', 'active')) {
			nodeEffects.setNodeEffect(TARGET_X, effect);
		}
		store.setAgentActivity('session-A', TARGET_X, 'active');
		const parentShimmer = findBindingEffect(element, 'shimmer');
		const firstBinding = getBindingElements(element)[0];

		assert.ok(parentShimmer);
		assert.strictEqual(parentShimmer.style.getPropertyValue(
			'--graph-node-effect-animation-delay',
		), '-250ms');
		assert.strictEqual(findBindingEffect(
			firstBinding,
			'shimmer',
		)?.style.getPropertyValue('--graph-node-effect-animation-delay'), '-250ms');

		unregisterBinding();
		animationTime = 850;
		bindings.registerTarget(TARGET_X, element.asHtmlElement());
		const remountedBinding = getBindingElements(element)[0];

		assert.strictEqual(findBindingEffect(element, 'shimmer'), parentShimmer);
		assert.strictEqual(findBindingEffect(
			remountedBinding,
			'shimmer',
		)?.style.getPropertyValue('--graph-node-effect-animation-delay'), '-750ms');

		bindings.dispose();
		nodeEffects.dispose();
	});
});

class FakeDocument {
	createElement(): FakeElement {
		return new FakeElement(this);
	}

	createElementNS(): FakeElement {
		return new FakeElement(this);
	}
}

class FakeElement {
	readonly children: FakeElement[] = [];
	readonly style = {
		setProperty: (name: string, value: string) => {
			this.styleProperties.set(name, value);
		},
		getPropertyValue: (name: string) => (
			this.styleProperties.get(name) ?? ''
		),
		removeProperty: (name: string) => {
			const previous = this.styleProperties.get(name) ?? '';

			this.styleProperties.delete(name);
			return previous;
		},
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
	private readonly classNames = new Set<string>();
	private readonly attributes = new Map<string, string>();
	private readonly styleProperties = new Map<string, string>();
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

function getBindingEffectLayer(binding: FakeElement): FakeElement | undefined {
	return binding.children.find((child) => (
		child.hasClass('graph-node-effect-layer')
	));
}

function findBindingEffect(
	binding: FakeElement,
	kind: string,
): FakeElement | undefined {
	return getBindingEffectLayer(binding)?.children.find((effect) => (
		effect.getAttribute('data-graph-node-effect') === kind
	));
}

function getBindingEffectKinds(binding: FakeElement): string[] {
	const layer = getBindingEffectLayer(binding);

	return (layer?.children ?? []).map((effect) => {
		const kind = effect.getAttribute('data-graph-node-effect') ?? '';

		return kind === 'icon'
			? `icon:${effect.getAttribute('data-graph-node-effect-icon')}`
			: kind;
	});
}

function getBindingEffectColor(binding: FakeElement): string | undefined {
	return getBindingEffectLayer(binding)?.children[0]?.style.getPropertyValue(
		'--graph-node-effect-color',
	) || undefined;
}
