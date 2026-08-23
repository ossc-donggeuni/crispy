import type { GraphNodeEffectTarget } from '../../messages';
import {
	compareAgentActivities,
	type AgentActivityStore,
	type AgentActivityStoreSnapshot,
	type AgentSessionActivitySnapshot,
} from '../../agent/webview/agentActivityStore';
import type {
	GraphLayout,
	GraphLayoutPosition,
} from './graphLayout';
import { getGraphNodeEffectRegionBounds } from './graphNodeEffectGeometry';
import {
	createGraphNodeLocalEffectHost,
	type GraphNodeLocalEffectHost,
} from './graphNodeEffects';
import { getAgentActivityEffects } from './agentActivityPresentation';

export interface AgentActivityBindingRegistrationOptions {
	/** Project/Folder Binding을 G-11 visible subtree horizontal bounds에 맞춘다. */
	readonly layoutNodeId?: string;
}

/** Graph Target DOM과 Agent Activity Binding Box의 독립적인 수명주기다. */
export interface AgentActivityBindings {
	/** 현재 마운트된 정확한 Target DOM에 Store snapshot을 연결한다. */
	registerTarget(
		target: GraphNodeEffectTarget,
		element: HTMLElement,
		options?: AgentActivityBindingRegistrationOptions,
	): () => void;
	/** 최신 World Layout으로 subtree Binding의 horizontal geometry를 동기화한다. */
	syncLayout(
		layout: GraphLayout,
		positions: ReadonlyMap<string, GraphLayoutPosition>,
		transitionDuration?: number,
	): boolean;
	/** G-12.5 source/occurrence merge가 실제 표시하는 Binding 개수를 반환한다. */
	getBindingCount(target: GraphNodeEffectTarget): number;
	/** 마운트된 Target의 effective Binding 개수가 바뀔 때만 구독자를 호출한다. */
	subscribeBindingCountChanges(subscriber: () => void): () => void;
	/** Store 구독과 G-12.5가 만든 모든 Binding DOM을 정리한다. */
	dispose(): void;
}

/** Binding Container가 Target 표시 범위 아래에 두는 고정 간격이다. */
export const AGENT_ACTIVITY_BINDING_TOP_GAP = 6;
/** 현재 한 줄 Agent Binding Box의 border-box 높이다. */
export const AGENT_ACTIVITY_BINDING_ROW_HEIGHT = 26;
/** 같은 Target의 Agent Binding Box 사이 고정 간격이다. */
export const AGENT_ACTIVITY_BINDING_ROW_GAP = 4;

/** 한 Target의 Agent Binding들이 차지하는 결정적인 추가 Layout 높이다. */
export function getAgentActivityBindingBlockHeight(bindingCount: number): number {
	const normalizedCount = Math.max(0, Math.floor(bindingCount));

	return normalizedCount === 0
		? 0
		: AGENT_ACTIVITY_BINDING_TOP_GAP
			+ normalizedCount * AGENT_ACTIVITY_BINDING_ROW_HEIGHT
			+ (normalizedCount - 1) * AGENT_ACTIVITY_BINDING_ROW_GAP;
}

interface TargetRegistration {
	readonly element: HTMLElement;
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly bindingsBySession: Map<string, BindingRegistration>;
	readonly layoutNodeId?: string;
	container?: HTMLElement;
	horizontalBounds?: Readonly<{ left: number; width: number }>;
}

interface BindingRegistration {
	readonly element: HTMLElement;
	readonly effectHost: GraphNodeLocalEffectHost;
}

/**
 * G-12.3 snapshot의 정렬된 Activity를 Target별 Session Binding Box로 동기화한다.
 * Graph layout에는 관여하지 않고 Renderer가 제공하는 Target DOM lifecycle만 따른다.
 */
export function createAgentActivityBindings(
	store: AgentActivityStore,
): AgentActivityBindings {
	const registrationsByTarget = new Map<string, Set<TargetRegistration>>();
	const bindingCountSubscribers = new Set<() => void>();
	let snapshotsByTarget = new Map<string, readonly AgentSessionActivitySnapshot[]>();
	let currentLayout: GraphLayout | undefined;
	let currentPositions: ReadonlyMap<string, GraphLayoutPosition> = new Map();
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

		let bindingCountChanged = false;

		for (const registrations of registrationsByTarget.values()) {
			const registration = registrations.values().next().value;

			if (
				registration
				&& getEffectiveActivities(
					registration.target,
					snapshotsByTarget,
				).length !== getEffectiveActivities(
					registration.target,
					nextSnapshotsByTarget,
				).length
			) {
				bindingCountChanged = true;
			}

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
		if (bindingCountChanged) {
			for (const subscriber of [...bindingCountSubscribers]) {
				try {
					subscriber();
				} catch {
					/** 후속 Layout subscriber가 다른 Binding DOM reconcile을 막지 않는다. */
				}
			}
		}
	};

	reconcile(store.getSnapshot());
	const unsubscribe = store.subscribe(reconcile);

	return {
		registerTarget(target, element, options = {}): () => void {
			if (disposed) {
				return () => {};
			}

			const key = createTargetKey(target);
			const registration: TargetRegistration = {
				element,
				target: createTargetSnapshot(target),
				bindingsBySession: new Map(),
				...(options.layoutNodeId
					? { layoutNodeId: options.layoutNodeId }
					: {}),
			};
			const registrations = registrationsByTarget.get(key) ?? new Set();

			registrations.add(registration);
			registrationsByTarget.set(key, registrations);
			reconcileTarget(
				registration,
				getEffectiveActivities(registration.target, snapshotsByTarget),
			);
			if (currentLayout) {
				syncTargetHorizontalGeometry(
					registration,
					currentLayout,
					currentPositions,
					0,
				);
			}

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

		syncLayout(layout, positions, transitionDuration = 0): boolean {
			if (disposed) {
				return false;
			}

			currentLayout = layout;
			currentPositions = positions;
			let changed = false;

			for (const registrations of registrationsByTarget.values()) {
				for (const registration of registrations) {
					changed = syncTargetHorizontalGeometry(
						registration,
						layout,
						positions,
						transitionDuration,
					) || changed;
				}
			}

			return changed;
		},

		getBindingCount(target): number {
			return disposed
				? 0
				: getEffectiveActivities(target, snapshotsByTarget).length;
		},

		subscribeBindingCountChanges(subscriber): () => void {
			if (disposed) {
				return () => {};
			}

			bindingCountSubscribers.add(subscriber);
			return () => {
				bindingCountSubscribers.delete(subscriber);
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
			bindingCountSubscribers.clear();
			snapshotsByTarget.clear();
			currentLayout = undefined;
			currentPositions = new Map();
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
			binding = createBindingRegistration(
				registration.element.ownerDocument,
				entry.sessionId,
			);
			registration.bindingsBySession.set(entry.sessionId, binding);
		}

		updateBindingElement(binding, entry);
		orderedBindings.push(binding.element);
	}

	for (const [sessionId, binding] of registration.bindingsBySession) {
		if (currentSessionIds.has(sessionId)) {
			continue;
		}

		binding.effectHost.dispose();
		binding.element.remove();
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
	container.style.setProperty(
		'--graph-agent-activity-binding-top-gap',
		`${AGENT_ACTIVITY_BINDING_TOP_GAP}px`,
	);
	container.style.setProperty(
		'--graph-agent-activity-binding-row-height',
		`${AGENT_ACTIVITY_BINDING_ROW_HEIGHT}px`,
	);
	container.style.setProperty(
		'--graph-agent-activity-binding-row-gap',
		`${AGENT_ACTIVITY_BINDING_ROW_GAP}px`,
	);
	container.setAttribute('role', 'list');
	container.setAttribute('data-graph-node-id', registration.target.nodeId);
	if (registration.target.rootId !== undefined) {
		container.setAttribute('data-graph-root-id', registration.target.rootId);
	}
	registration.element.classList.add('graph-agent-activity-binding-host');
	registration.element.append(container);
	registration.container = container;
	applyTargetHorizontalGeometry(registration, 0);
	return container;
}

function createBindingRegistration(
	ownerDocument: Document,
	sessionId: string,
): BindingRegistration {
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
	return {
		element: binding,
		effectHost: createGraphNodeLocalEffectHost(binding),
	};
}

function updateBindingElement(
	binding: BindingRegistration,
	entry: AgentSessionActivitySnapshot,
): void {
	if (binding.element.getAttribute('data-activity') === entry.activity) {
		return;
	}

	binding.element.setAttribute('data-activity', entry.activity);
	const activity = binding.element.children[1];

	if (activity) {
		activity.textContent = `[${entry.activity}]`;
	}
	binding.effectHost.setEffects(getAgentActivityEffects(
		entry.sessionId,
		entry.activity,
	));
}

function clearRegistration(registration: TargetRegistration): void {
	for (const binding of registration.bindingsBySession.values()) {
		binding.effectHost.dispose();
	}
	registration.container?.remove();
	registration.container = undefined;
	registration.bindingsBySession.clear();
	registration.element.classList.remove('graph-agent-activity-binding-host');
}

function syncTargetHorizontalGeometry(
	registration: TargetRegistration,
	layout: GraphLayout,
	positions: ReadonlyMap<string, GraphLayoutPosition>,
	transitionDuration: number,
): boolean {
	const layoutNodeId = registration.layoutNodeId;

	if (!layoutNodeId) {
		return false;
	}
	const node = layout.nodes.find(({ id }) => id === layoutNodeId);
	const bounds = getGraphNodeEffectRegionBounds(
		layout,
		positions,
		layoutNodeId,
	);

	if (!node || !bounds) {
		const changed = registration.horizontalBounds !== undefined;

		registration.horizontalBounds = undefined;
		applyTargetHorizontalGeometry(registration, transitionDuration);
		return changed;
	}
	const nodePosition = positions.get(layoutNodeId) ?? node.position;
	const horizontalBounds = {
		left: bounds.x - nodePosition.x,
		width: bounds.width,
	};
	const changed = registration.horizontalBounds?.left !== horizontalBounds.left
		|| registration.horizontalBounds.width !== horizontalBounds.width;

	if (!changed) {
		return false;
	}

	registration.horizontalBounds = horizontalBounds;
	applyTargetHorizontalGeometry(registration, transitionDuration);
	return true;
}

function applyTargetHorizontalGeometry(
	registration: TargetRegistration,
	transitionDuration: number,
): void {
	const container = registration.container;

	if (!container) {
		return;
	}
	const bounds = registration.horizontalBounds;

	if (!bounds) {
		container.style.removeProperty('left');
		container.style.removeProperty('width');
		container.classList.remove('is-layout-transitioning');
		container.style.removeProperty(
			'--graph-agent-activity-binding-transition-duration',
		);
		return;
	}

	if (transitionDuration > 0) {
		container.classList.add('is-layout-transitioning');
		container.style.setProperty(
			'--graph-agent-activity-binding-transition-duration',
			`${transitionDuration}ms`,
		);
	} else {
		container.classList.remove('is-layout-transitioning');
		container.style.removeProperty(
			'--graph-agent-activity-binding-transition-duration',
		);
	}
	container.style.left = `${bounds.left}px`;
	container.style.width = `${bounds.width}px`;
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
