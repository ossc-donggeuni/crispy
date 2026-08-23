import type { GraphNodeEffectTarget } from '../../messages';
import {
	compareAgentActivities,
	type AgentActivityStore,
	type AgentActivityStoreSnapshot,
	type AgentSessionActivitySnapshot,
} from '../../agent/webview/agentActivityStore';

/** Graph Target DOM과 Agent Activity Binding Box의 독립적인 수명주기다. */
export interface AgentActivityBindings {
	/** 현재 마운트된 정확한 Target DOM에 Store snapshot을 연결한다. */
	registerTarget(target: GraphNodeEffectTarget, element: HTMLElement): () => void;
	/** Store 구독과 G-12.5가 만든 모든 Binding DOM을 정리한다. */
	dispose(): void;
}

interface TargetRegistration {
	readonly element: HTMLElement;
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly bindingsBySession: Map<string, HTMLElement>;
	container?: HTMLElement;
}

/**
 * G-12.3 snapshot의 정렬된 Activity를 Target별 Session Binding Box로 동기화한다.
 * Graph layout에는 관여하지 않고 Renderer가 제공하는 Target DOM lifecycle만 따른다.
 */
export function createAgentActivityBindings(
	store: AgentActivityStore,
): AgentActivityBindings {
	const registrationsByTarget = new Map<string, Set<TargetRegistration>>();
	let snapshotsByTarget = new Map<string, readonly AgentSessionActivitySnapshot[]>();
	let disposed = false;

	const reconcile = (snapshot: AgentActivityStoreSnapshot): void => {
		if (disposed) {
			return;
		}

		const nextSnapshotsByTarget = new Map<
			string,
			readonly AgentSessionActivitySnapshot[]
		>();

		for (const targetSnapshot of snapshot) {
			const key = createTargetKey(targetSnapshot.target);

			nextSnapshotsByTarget.set(key, targetSnapshot.activities);
		}

		for (const registrations of registrationsByTarget.values()) {
			for (const registration of registrations) {
				reconcileTarget(
					registration,
					getEffectiveActivities(
						registration.target,
						nextSnapshotsByTarget,
					),
				);
			}
		}

		snapshotsByTarget = nextSnapshotsByTarget;
	};

	reconcile(store.getSnapshot());
	const unsubscribe = store.subscribe(reconcile);

	return {
		registerTarget(target, element): () => void {
			if (disposed) {
				return () => {};
			}

			const key = createTargetKey(target);
			const registration: TargetRegistration = {
				element,
				target: createTargetSnapshot(target),
				bindingsBySession: new Map(),
			};
			const registrations = registrationsByTarget.get(key) ?? new Set();

			registrations.add(registration);
			registrationsByTarget.set(key, registrations);
			reconcileTarget(
				registration,
				getEffectiveActivities(registration.target, snapshotsByTarget),
			);

			let registered = true;

			return () => {
				if (!registered) {
					return;
				}

				registered = false;
				clearRegistration(registration);
				registrations.delete(registration);
				if (registrations.size === 0) {
					registrationsByTarget.delete(key);
				}
			};
		},

		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			unsubscribe();
			for (const registrations of registrationsByTarget.values()) {
				for (const registration of registrations) {
					clearRegistration(registration);
				}
			}
			registrationsByTarget.clear();
			snapshotsByTarget.clear();
		},
	};
}

/** G-11처럼 source를 모든 occurrence에 투영하고 occurrence Session만 덮어쓴다. */
function getEffectiveActivities(
	target: Readonly<GraphNodeEffectTarget>,
	snapshotsByTarget: ReadonlyMap<
		string,
		readonly AgentSessionActivitySnapshot[]
	>,
): readonly AgentSessionActivitySnapshot[] {
	const sourceActivities = snapshotsByTarget.get(createTargetKey({
		nodeId: target.nodeId,
	})) ?? [];

	if (target.rootId === undefined) {
		return sourceActivities;
	}

	const occurrenceActivities = snapshotsByTarget.get(createTargetKey(target)) ?? [];

	if (occurrenceActivities.length === 0) {
		return sourceActivities;
	}
	if (sourceActivities.length === 0) {
		return occurrenceActivities;
	}

	const occurrenceSessionIds = new Set(
		occurrenceActivities.map((entry) => entry.sessionId),
	);
	const inheritedActivities = sourceActivities.filter(
		(entry) => !occurrenceSessionIds.has(entry.sessionId),
	);

	return mergeOrderedActivities(inheritedActivities, occurrenceActivities);
}

/** 두 G-12.3 ordered 배열을 동일 comparator로 병합하며 별도 sort하지 않는다. */
function mergeOrderedActivities(
	left: readonly AgentSessionActivitySnapshot[],
	right: readonly AgentSessionActivitySnapshot[],
): readonly AgentSessionActivitySnapshot[] {
	const merged: AgentSessionActivitySnapshot[] = [];
	let leftIndex = 0;
	let rightIndex = 0;

	while (leftIndex < left.length && rightIndex < right.length) {
		const leftEntry = left[leftIndex];
		const rightEntry = right[rightIndex];

		if (compareAgentActivities(leftEntry, rightEntry) <= 0) {
			merged.push(leftEntry);
			leftIndex += 1;
		} else {
			merged.push(rightEntry);
			rightIndex += 1;
		}
	}

	merged.push(...left.slice(leftIndex), ...right.slice(rightIndex));
	return Object.freeze(merged);
}

/** Store가 제공한 순서를 유지하며 Session DOM을 갱신하고 이동한다. */
function reconcileTarget(
	registration: TargetRegistration,
	activities: readonly AgentSessionActivitySnapshot[],
): void {
	if (activities.length === 0) {
		clearRegistration(registration);
		return;
	}

	const container = registration.container
		?? createBindingContainer(registration);
	const currentSessionIds = new Set<string>();
	const orderedBindings: HTMLElement[] = [];

	for (const entry of activities) {
		currentSessionIds.add(entry.sessionId);
		let binding = registration.bindingsBySession.get(entry.sessionId);

		if (!binding) {
			binding = createBindingElement(
				registration.element.ownerDocument,
				entry.sessionId,
			);
			registration.bindingsBySession.set(entry.sessionId, binding);
		}

		updateBindingElement(binding, entry);
		orderedBindings.push(binding);
	}

	for (const [sessionId, binding] of registration.bindingsBySession) {
		if (currentSessionIds.has(sessionId)) {
			continue;
		}

		binding.remove();
		registration.bindingsBySession.delete(sessionId);
	}

	const orderChanged = container.children.length !== orderedBindings.length
		|| orderedBindings.some((binding, index) => (
			container.children[index] !== binding
		));

	if (orderChanged) {
		container.replaceChildren(...orderedBindings);
	}
}

function createBindingContainer(registration: TargetRegistration): HTMLElement {
	const container = registration.element.ownerDocument.createElement('div');

	container.className = 'graph-agent-activity-bindings';
	container.setAttribute('role', 'list');
	container.setAttribute('data-graph-node-id', registration.target.nodeId);
	if (registration.target.rootId !== undefined) {
		container.setAttribute('data-graph-root-id', registration.target.rootId);
	}
	registration.element.classList.add('graph-agent-activity-binding-host');
	registration.element.append(container);
	registration.container = container;
	return container;
}

function createBindingElement(
	ownerDocument: Document,
	sessionId: string,
): HTMLElement {
	const binding = ownerDocument.createElement('div');
	const session = ownerDocument.createElement('span');
	const activity = ownerDocument.createElement('span');

	binding.className = 'graph-agent-activity-binding';
	binding.setAttribute('role', 'listitem');
	binding.setAttribute('data-session-id', sessionId);
	session.className = 'graph-agent-activity-session-id';
	session.textContent = sessionId;
	session.setAttribute('title', sessionId);
	activity.className = 'graph-agent-activity-kind';
	binding.append(session, activity);
	return binding;
}

function updateBindingElement(
	binding: HTMLElement,
	entry: AgentSessionActivitySnapshot,
): void {
	if (binding.getAttribute('data-activity') === entry.activity) {
		return;
	}

	binding.setAttribute('data-activity', entry.activity);
	const activity = binding.children[1];

	if (activity) {
		activity.textContent = `[${entry.activity}]`;
	}
}

function clearRegistration(registration: TargetRegistration): void {
	registration.container?.remove();
	registration.container = undefined;
	registration.bindingsBySession.clear();
	registration.element.classList.remove('graph-agent-activity-binding-host');
}

function createTargetKey(target: Readonly<GraphNodeEffectTarget>): string {
	return JSON.stringify([target.nodeId, target.rootId ?? null]);
}

function createTargetSnapshot(
	target: GraphNodeEffectTarget,
): Readonly<GraphNodeEffectTarget> {
	return Object.freeze({
		nodeId: target.nodeId,
		...(target.rootId === undefined ? {} : { rootId: target.rootId }),
	});
}
