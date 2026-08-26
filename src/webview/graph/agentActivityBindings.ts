import type { GraphNodeEffectTarget } from '../../messages';
import {
	type AgentActivityStore,
	type AgentActivityStoreSnapshot,
	type AgentSessionActivitySnapshot,
} from '../../agent/webview/agentActivityStore';
import type {
	GraphLayout,
	GraphLayoutPosition,
} from './graphLayout';
import {
	AGENT_SESSION_UNTITLED_TITLE,
	AGENT_SESSION_WAITING_MESSAGE,
	type AgentSessionPresentationSnapshot,
	type AgentSessionPresentationStore,
} from '../../agent/webview/agentSessionPresentationStore';
import { getGraphNodeEffectRegionBounds } from './graphNodeEffectGeometry';
import {
	createGraphNodeLocalEffectHost,
	type GraphNodeLocalEffectHost,
} from './graphNodeEffects';
import { getAgentActivityEffects } from './agentActivityPresentation';
import {
	type AgentActivitiesByTarget,
	createAgentActivityTargetKey,
	getEffectiveAgentActivities,
	indexAgentActivitiesByTarget,
} from './agentActivityProjection';

export interface AgentActivityBindingRegistrationOptions {
	/** Project/Folder Binding을 G-11 visible subtree horizontal bounds에 맞춘다. */
	readonly layoutNodeId?: string;
}

/** Session별 이벤트 Animation 표시에서 발생한 사용자 동작이다. */
export interface AgentActivityBindingInteractions {
	/** Binding을 Double Click한 정확한 Session을 Agent Panel에 표시한다. */
	onSessionOpenRequest?: (sessionId: string) => void;
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
	/** Store 구독, Local Effect와 모든 Binding DOM을 정리한다. */
	dispose(): void;
}

/** Binding Container가 Target 표시 범위 아래에 두는 고정 간격이다. */
export const AGENT_ACTIVITY_BINDING_TOP_GAP = 6;
/** 제목과 현재 메시지를 한 줄에 담는 Agent Binding Box의 고정 border-box 높이다. */
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
	readonly createLocalEffectHost: GraphNodeLocalEffectHostFactory;
	readonly interactions: AgentActivityBindingInteractions;
	readonly layoutNodeId?: string;
	container?: HTMLElement;
	horizontalBounds?: Readonly<{ left: number; width: number }>;
}

interface BindingRegistration {
	readonly sessionId: string;
	readonly element: HTMLElement;
	readonly titleElement: HTMLElement;
	readonly messageElement: HTMLElement;
	readonly effectHost: GraphNodeLocalEffectHost;
	readonly handlePointerDown: (event: PointerEvent) => void;
	readonly handleClick: (event: MouseEvent) => void;
	readonly handleDoubleClick: (event: MouseEvent) => void;
}

type GraphNodeLocalEffectHostFactory = (
	element: HTMLElement,
) => GraphNodeLocalEffectHost;

/**
 * G-12.3 snapshot의 정렬된 Activity를 Target별 Session Binding Box로 동기화한다.
 * Binding DOM, Local Effect와 presentation geometry를 Renderer lifecycle에 맞춘다.
 * 고정 footprint 규약은 Graph Layout과 공유하고 개수 변경을 reflow에 통지한다.
 */
export function createAgentActivityBindings(
	store: AgentActivityStore,
	createLocalEffectHost: GraphNodeLocalEffectHostFactory = (
		createGraphNodeLocalEffectHost
	),
	presentationStore?: AgentSessionPresentationStore,
	interactions: AgentActivityBindingInteractions = {},
): AgentActivityBindings {
	const registrationsByTarget = new Map<string, Set<TargetRegistration>>();
	const bindingsBySession = new Map<string, Set<BindingRegistration>>();
	const bindingCountSubscribers = new Set<() => void>();
	let snapshotsByTarget: AgentActivitiesByTarget = new Map();
	let currentLayout: GraphLayout | undefined;
	let currentPositions: ReadonlyMap<string, GraphLayoutPosition> = new Map();
	let disposed = false;

	const getVisibleActivities = (
		target: GraphNodeEffectTarget,
		byTarget: AgentActivitiesByTarget,
	): readonly AgentSessionActivitySnapshot[] => {
		const activities = getEffectiveAgentActivities(target, byTarget);
		return presentationStore === undefined
			? activities
			: activities.filter(({ sessionId }) => (
				presentationStore.isRunningSession(sessionId)
			));
	};

	const getPresentation = (
		entry: AgentSessionActivitySnapshot,
	): AgentSessionPresentationSnapshot | undefined => {
		if (presentationStore === undefined) {
			return {
				tabId: entry.sessionId,
				sessionId: entry.sessionId,
				color: getAgentActivityEffects(
					entry.sessionId,
					entry.activity,
				)[0]?.color ?? 'transparent',
				title: entry.sessionId,
				currentMessage: `[${entry.activity}]`,
				state: 'running',
			};
		}

		const presentation = presentationStore.getSession(entry.sessionId);
		return presentation?.state === 'running' ? presentation : undefined;
	};

	const reconcile = (snapshot: AgentActivityStoreSnapshot): void => {
		if (disposed) {
			return;
		}

		const nextSnapshotsByTarget = indexAgentActivitiesByTarget(snapshot);

		let bindingCountChanged = false;

		for (const registrations of registrationsByTarget.values()) {
			const registration = registrations.values().next().value;

			if (
				registration
				&& registration.bindingsBySession.size !== getVisibleActivities(
					registration.target,
					nextSnapshotsByTarget,
				).length
			) {
				bindingCountChanged = true;
			}

			for (const registration of registrations) {
				reconcileTarget(
					registration,
					getVisibleActivities(
						registration.target,
						nextSnapshotsByTarget,
					),
					getPresentation,
					bindingsBySession,
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
	const unsubscribePresentation = presentationStore?.subscribe((change) => {
		if (disposed) {
			return;
		}
		if (change.kind === 'lifecycle') {
			reconcile(store.getSnapshot());
			return;
		}

		const presentation = presentationStore.getSession(change.sessionId);
		if (presentation?.state !== 'running') {
			return;
		}
		for (const binding of bindingsBySession.get(change.sessionId) ?? []) {
			updateBindingPresentation(binding, presentation);
		}
	});

	return {
		registerTarget(target, element, options = {}): () => void {
			if (disposed) {
				return () => {};
			}

			const key = createAgentActivityTargetKey(target);
			const registration: TargetRegistration = {
				element,
				target: createTargetSnapshot(target),
				bindingsBySession: new Map(),
				createLocalEffectHost,
				interactions,
				...(options.layoutNodeId
					? { layoutNodeId: options.layoutNodeId }
					: {}),
			};
			const registrations = registrationsByTarget.get(key) ?? new Set();

			registrations.add(registration);
			registrationsByTarget.set(key, registrations);
			reconcileTarget(
				registration,
				getVisibleActivities(registration.target, snapshotsByTarget),
				getPresentation,
				bindingsBySession,
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
				clearRegistration(registration, bindingsBySession);
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
				: getVisibleActivities(target, snapshotsByTarget).length;
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
			unsubscribePresentation?.();
			for (const registrations of registrationsByTarget.values()) {
				for (const registration of registrations) {
					clearRegistration(registration, bindingsBySession);
				}
			}
			registrationsByTarget.clear();
			bindingsBySession.clear();
			bindingCountSubscribers.clear();
			snapshotsByTarget = new Map();
			currentLayout = undefined;
			currentPositions = new Map();
		},
	};
}

/** Store가 제공한 순서를 유지하며 Session DOM을 갱신하고 이동한다. */
function reconcileTarget(
	registration: TargetRegistration,
	activities: readonly AgentSessionActivitySnapshot[],
	getPresentation: (
		entry: AgentSessionActivitySnapshot,
	) => AgentSessionPresentationSnapshot | undefined,
	bindingsBySession: Map<string, Set<BindingRegistration>>,
): void {
	if (activities.length === 0) {
		clearRegistration(registration, bindingsBySession);
		return;
	}

	const container = registration.container
		?? createBindingContainer(registration);
	const currentSessionIds = new Set<string>();
	const orderedBindings: HTMLElement[] = [];

	for (const entry of activities) {
		const presentation = getPresentation(entry);
		if (presentation === undefined) {
			continue;
		}
		currentSessionIds.add(entry.sessionId);
		let binding = registration.bindingsBySession.get(entry.sessionId);

		if (!binding) {
			binding = createBindingRegistration(
				registration.element.ownerDocument,
				entry.sessionId,
				registration.createLocalEffectHost,
				registration.interactions,
			);
			registration.bindingsBySession.set(entry.sessionId, binding);
			const indexedBindings = bindingsBySession.get(entry.sessionId) ?? new Set();
			indexedBindings.add(binding);
			bindingsBySession.set(entry.sessionId, indexedBindings);
		}

		updateBindingElement(binding, entry, presentation);
		orderedBindings.push(binding.element);
	}

	for (const [sessionId, binding] of registration.bindingsBySession) {
		if (currentSessionIds.has(sessionId)) {
			continue;
		}

		disposeBinding(binding, bindingsBySession);
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
	createLocalEffectHost: GraphNodeLocalEffectHostFactory,
	interactions: AgentActivityBindingInteractions,
): BindingRegistration {
	const binding = ownerDocument.createElement('div');
	const title = ownerDocument.createElement('span');
	const message = ownerDocument.createElement('span');

	binding.className = 'graph-agent-activity-binding';
	binding.setAttribute('role', 'listitem');
	binding.setAttribute('data-session-id', sessionId);
	title.className = 'graph-agent-activity-session-title';
	message.className = 'graph-agent-activity-current-message';
	binding.append(title, message);
	const handlePointerDown = (event: PointerEvent): void => {
		event.stopPropagation();
	};
	const handleClick = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
	};
	const handleDoubleClick = (event: MouseEvent): void => {
		handleClick(event);

		try {
			interactions.onSessionOpenRequest?.(sessionId);
		} catch {
			/** Session 표시 실패가 Activity DOM과 기존 File interaction으로 전파되지 않게 한다. */
		}
	};
	binding.addEventListener('pointerdown', handlePointerDown);
	binding.addEventListener('click', handleClick);
	binding.addEventListener('dblclick', handleDoubleClick);
	return {
		sessionId,
		element: binding,
		titleElement: title,
		messageElement: message,
		effectHost: createLocalEffectHost(binding),
		handlePointerDown,
		handleClick,
		handleDoubleClick,
	};
}

function updateBindingElement(
	binding: BindingRegistration,
	entry: AgentSessionActivitySnapshot,
	presentation: AgentSessionPresentationSnapshot,
): void {
	if (binding.element.getAttribute('data-activity') !== entry.activity) {
		binding.element.setAttribute('data-activity', entry.activity);
		binding.effectHost.setEffects(getAgentActivityEffects(
			entry.sessionId,
			entry.activity,
			presentation.color,
		));
	}
	updateBindingPresentation(binding, presentation);
}

function updateBindingPresentation(
	binding: BindingRegistration,
	presentation: AgentSessionPresentationSnapshot,
): void {
	const title = presentation.title || AGENT_SESSION_UNTITLED_TITLE;
	const message = presentation.currentMessage || AGENT_SESSION_WAITING_MESSAGE;

	if (binding.titleElement.textContent !== title) {
		binding.titleElement.textContent = title;
		binding.titleElement.setAttribute('title', title);
	}
	if (binding.messageElement.textContent !== message) {
		binding.messageElement.textContent = message;
	}
	binding.element.setAttribute(
		'aria-label',
		`${title}: ${message}`,
	);
}

function disposeBinding(
	binding: BindingRegistration,
	bindingsBySession: Map<string, Set<BindingRegistration>>,
): void {
	binding.element.removeEventListener('pointerdown', binding.handlePointerDown);
	binding.element.removeEventListener('click', binding.handleClick);
	binding.element.removeEventListener('dblclick', binding.handleDoubleClick);
	binding.effectHost.dispose();
	binding.element.remove();
	const indexedBindings = bindingsBySession.get(binding.sessionId);
	indexedBindings?.delete(binding);
	if (indexedBindings?.size === 0) {
		bindingsBySession.delete(binding.sessionId);
	}
}

function clearRegistration(
	registration: TargetRegistration,
	bindingsBySession: Map<string, Set<BindingRegistration>>,
): void {
	for (const binding of registration.bindingsBySession.values()) {
		disposeBinding(binding, bindingsBySession);
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

function createTargetSnapshot(
	target: GraphNodeEffectTarget,
): Readonly<GraphNodeEffectTarget> {
	return Object.freeze({
		nodeId: target.nodeId,
		...(target.rootId === undefined ? {} : { rootId: target.rootId }),
	});
}
