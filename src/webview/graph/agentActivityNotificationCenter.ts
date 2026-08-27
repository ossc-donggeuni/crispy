import type { AgentActivityStore } from '../../agent/webview/agentActivityStore';
import type { AgentSessionPresentationStore } from '../../agent/webview/agentSessionPresentationStore';
import {
	GRAPH_CAMERA_IGNORE_ATTRIBUTE,
} from './graphCamera';
import type { Graph } from './graphModel';
import type { GraphNodeLocalEffectHost } from './graphNodeEffects';
import { getAgentActivityEffects } from './agentActivityPresentation';
import {
	createAgentActivityNotificationEntriesFromIndex,
	createAgentActivityTargetPresentationIndex,
	getAgentActivityNotificationStatusLabel,
	groupAgentActivityNotificationsBySession,
	type AgentActivityNotificationEntry,
} from './agentActivityNotifications';
import {
	createFullGraphVisibleArea,
	type GraphVisibleAreaProvider,
} from './graphVisibleArea';
import {
	initializeAgentActivityFloatingNotificationStack,
	type AgentActivityNotificationScheduler,
} from './agentActivityFloatingNotifications';

export const AGENT_ACTIVITY_NOTIFICATION_CENTER_ATTRIBUTE =
	'data-agent-activity-notification-center';
export const AGENT_ACTIVITY_NOTIFICATION_KEY_ATTRIBUTE =
	'data-agent-activity-notification-key';

/** 알림 Focus와 사용자 dismiss를 Graph runtime 동작으로 전달한다. */
export interface AgentActivityNotificationCenterInteractions {
	onFocus?: (entry: AgentActivityNotificationEntry) => void;
	onDismiss?: (entry: AgentActivityNotificationEntry) => void;
	/** true인 Activity는 같은 Session의 모든 Target을 하나의 알림으로 표시한다. */
	shouldGroupBySession?: (entry: AgentActivityNotificationEntry) => boolean;
}

/** 알림 Center의 Graph 표시 정보, 위치와 DOM lifecycle이다. */
export interface AgentActivityNotificationCenter {
	refreshVisibleGraphArea(): void;
	setGraph(graph: Graph): void;
	dispose(): void;
}

interface NotificationRegistration {
	entry: AgentActivityNotificationEntry;
	readonly element: HTMLLIElement;
	readonly focusButton: HTMLButtonElement;
	readonly sessionTitle: HTMLSpanElement;
	readonly status: HTMLSpanElement;
	readonly targetName: HTMLSpanElement;
	readonly targetPath: HTMLSpanElement;
	readonly currentMessage: HTMLSpanElement;
	readonly dismissButton: HTMLButtonElement;
	readonly effectHost: GraphNodeLocalEffectHost;
	handleFocus: (event: MouseEvent) => void;
	handleDismiss: (event: MouseEvent) => void;
}

type GraphNodeLocalEffectHostFactory = (
	element: HTMLElement,
) => GraphNodeLocalEffectHost;

const CENTER_TITLE = 'Notifications';
const CENTER_PANEL_ID = 'graph-agent-activity-notification-panel';
const CENTER_TITLE_ID = 'graph-agent-activity-notification-title';
const CENTER_VIEWPORT_MARGIN = 16;
const CENTER_CONTROL_SIZE = 40;

/**
 * Graph Overlay 우측 상단에 현재 MCP Activity 전체를 표시하는 알림 Center를 만든다.
 * 목록은 Store state를 소유하지 않고 Target 또는 그룹 Session dismiss를 상위에 요청한다.
 */
export function initializeAgentActivityNotificationCenter(
	overlayLayer: HTMLElement,
	viewport: HTMLElement,
	store: AgentActivityStore,
	presentationStore: AgentSessionPresentationStore,
	initialGraph: Graph,
	createLocalEffectHost: GraphNodeLocalEffectHostFactory,
	interactions: AgentActivityNotificationCenterInteractions = {},
	getVisibleGraphArea: GraphVisibleAreaProvider = () => (
		createFullGraphVisibleArea({
			width: viewport.clientWidth,
			height: viewport.clientHeight,
		})
	),
	scheduler?: AgentActivityNotificationScheduler,
): AgentActivityNotificationCenter {
	const ownerDocument = overlayLayer.ownerDocument;
	const center = ownerDocument.createElement('div');
	const controlRow = ownerDocument.createElement('div');
	const trigger = ownerDocument.createElement('button');
	const triggerIcon = ownerDocument.createElement('span');
	const badge = ownerDocument.createElement('span');
	const panel = ownerDocument.createElement('section');
	const header = ownerDocument.createElement('header');
	const title = ownerDocument.createElement('h2');
	const list = ownerDocument.createElement('ul');
	const empty = ownerDocument.createElement('p');
	const registrations = new Map<string, NotificationRegistration>();
	let currentGraph = initialGraph;
	let targetPresentations = createAgentActivityTargetPresentationIndex(
		currentGraph,
	);
	let open = false;
	let disposed = false;
	let hasReconciled = false;
	const observedSequencesByKey = new Map<string, number>();

	center.className = 'graph-agent-activity-notification-center';
	center.setAttribute(AGENT_ACTIVITY_NOTIFICATION_CENTER_ATTRIBUTE, '');
	center.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE, '');
	controlRow.className = 'graph-agent-activity-notification-control-row';
	trigger.className = 'graph-agent-activity-notification-trigger';
	trigger.type = 'button';
	trigger.setAttribute('aria-controls', CENTER_PANEL_ID);
	trigger.setAttribute('aria-expanded', 'false');
	triggerIcon.className = 'graph-agent-activity-notification-trigger-icon';
	triggerIcon.setAttribute('aria-hidden', 'true');
	badge.className = 'graph-agent-activity-notification-badge';
	badge.hidden = true;
	badge.setAttribute('aria-hidden', 'true');
	trigger.append(triggerIcon, badge);
	panel.className = 'graph-agent-activity-notification-panel';
	panel.id = CENTER_PANEL_ID;
	panel.hidden = true;
	panel.tabIndex = -1;
	panel.setAttribute('aria-labelledby', CENTER_TITLE_ID);
	header.className = 'graph-agent-activity-notification-header';
	title.className = 'graph-agent-activity-notification-title';
	title.id = CENTER_TITLE_ID;
	title.textContent = CENTER_TITLE;
	header.append(title);
	list.className = 'graph-agent-activity-notification-list';
	list.setAttribute('role', 'list');
	empty.className = 'graph-agent-activity-notification-empty';
	empty.textContent = 'No new notifications.';
	panel.append(header, list, empty);
	controlRow.append(trigger);
	center.append(controlRow, panel);
	overlayLayer.append(center);

	const setOpen = (nextOpen: boolean, restoreTriggerFocus = false): void => {
		if (disposed || open === nextOpen) {
			return;
		}

		open = nextOpen;
		panel.hidden = !open;
		trigger.setAttribute('aria-expanded', String(open));
		trigger.classList.toggle('is-active', open);
		if (open) {
			const firstFocusButton = registrations.values().next().value
				?.focusButton;

			(firstFocusButton ?? panel).focus();
		} else if (restoreTriggerFocus) {
			trigger.focus();
		}
	};

	const handleTriggerClick = (event: MouseEvent): void => {
		event.stopPropagation();
		setOpen(!open, open);
	};
	const handleDocumentPointerDown = (event: PointerEvent): void => {
		if (!open || isNotificationCenterEventTarget(event.target)) {
			return;
		}
		setOpen(false);
	};
	const handleDocumentKeyDown = (event: KeyboardEvent): void => {
		if (!open || event.key !== 'Escape') {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		setOpen(false, true);
	};

	trigger.addEventListener('click', handleTriggerClick);
	ownerDocument.addEventListener('pointerdown', handleDocumentPointerDown);
	ownerDocument.addEventListener('keydown', handleDocumentKeyDown);
	const floatingNotifications = initializeAgentActivityFloatingNotificationStack(
		controlRow,
		createLocalEffectHost,
		(entry) => {
			setOpen(false);
			interactions.onFocus?.(entry);
		},
		scheduler,
	);

	const reconcile = (): void => {
		if (disposed) {
			return;
		}

		const entries = groupAgentActivityNotificationsBySession(
			createAgentActivityNotificationEntriesFromIndex(
				store.getSnapshot(),
				presentationStore,
				targetPresentations,
			),
			(entry) => interactions.shouldGroupBySession?.(entry) === true,
		);
		const currentKeys = new Set(entries.map(({ key }) => key));
		const orderedElements: HTMLLIElement[] = [];
		const newEntries: AgentActivityNotificationEntry[] = [];

		for (const entry of entries) {
			const observedSequence = observedSequencesByKey.get(entry.key);

			if (hasReconciled && observedSequence !== entry.sequence) {
				newEntries.push(entry);
			}
			observedSequencesByKey.set(entry.key, entry.sequence);
			floatingNotifications.update(entry);
			let registration = registrations.get(entry.key);

			if (!registration) {
				registration = createNotificationRegistration(
					ownerDocument,
					entry,
					createLocalEffectHost,
					interactions,
				);
				registrations.set(entry.key, registration);
			}
			updateNotificationRegistration(registration, entry);
			orderedElements.push(registration.element);
		}

		for (const [key, registration] of registrations) {
			if (currentKeys.has(key)) {
				continue;
			}
			disposeNotificationRegistration(registration);
			registration.element.remove();
			registrations.delete(key);
			floatingNotifications.clearNotificationKey(key);
		}
		newEntries
			.sort((left, right) => left.sequence - right.sequence)
			.forEach((entry) => floatingNotifications.push(entry));
		hasReconciled = true;

		if (
			list.children.length !== orderedElements.length
			|| orderedElements.some((element, index) => list.children[index] !== element)
		) {
			list.replaceChildren(...orderedElements);
		}

		const count = entries.length;
		badge.hidden = count === 0;
		badge.textContent = count > 99 ? '99+' : String(count);
		empty.hidden = count !== 0;
		list.hidden = count === 0;
		trigger.setAttribute('aria-label', `${CENTER_TITLE}: ${count}`);
		trigger.title = `${CENTER_TITLE}: ${count}`;
	};

	const unsubscribeStore = store.subscribe(() => reconcile());
	const unsubscribePresentation = presentationStore.subscribe(() => reconcile());

	reconcile();

	const refreshVisibleGraphArea = (): void => {
		if (
			disposed
			|| viewport.clientWidth <= 0
			|| viewport.clientHeight <= 0
		) {
			return;
		}
		const visibleArea = getVisibleGraphArea();
		const rightInset = Math.max(0, viewport.clientWidth - visibleArea.right);
		const topInset = Math.max(0, visibleArea.top);
		const maximumRight = Math.max(0, viewport.clientWidth - CENTER_CONTROL_SIZE);
		const maximumTop = Math.max(0, viewport.clientHeight - CENTER_CONTROL_SIZE);

		center.style.right = `${Math.min(
			rightInset + CENTER_VIEWPORT_MARGIN,
			maximumRight,
		)}px`;
		center.style.top = `${Math.min(
			topInset + CENTER_VIEWPORT_MARGIN,
			maximumTop,
		)}px`;
	};

	refreshVisibleGraphArea();

	return {
		refreshVisibleGraphArea,
		setGraph(graph): void {
			if (disposed) {
				return;
			}
			currentGraph = graph;
			targetPresentations = createAgentActivityTargetPresentationIndex(
				currentGraph,
			);
			reconcile();
		},
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			floatingNotifications.dispose();
			unsubscribeStore();
			unsubscribePresentation();
			trigger.removeEventListener('click', handleTriggerClick);
			ownerDocument.removeEventListener('pointerdown', handleDocumentPointerDown);
			ownerDocument.removeEventListener('keydown', handleDocumentKeyDown);
			for (const registration of registrations.values()) {
				disposeNotificationRegistration(registration);
			}
			registrations.clear();
			center.remove();
		},
	};
}

function createNotificationRegistration(
	ownerDocument: Document,
	entry: AgentActivityNotificationEntry,
	createLocalEffectHost: GraphNodeLocalEffectHostFactory,
	interactions: AgentActivityNotificationCenterInteractions,
): NotificationRegistration {
	const element = ownerDocument.createElement('li');
	const focusButton = ownerDocument.createElement('button');
	const summary = ownerDocument.createElement('span');
	const sessionTitle = ownerDocument.createElement('span');
	const status = ownerDocument.createElement('span');
	const target = ownerDocument.createElement('span');
	const targetName = ownerDocument.createElement('span');
	const targetPath = ownerDocument.createElement('span');
	const currentMessage = ownerDocument.createElement('span');
	const dismissButton = ownerDocument.createElement('button');
	const dismissIcon = ownerDocument.createElement('span');
	const registration: NotificationRegistration = {
		entry,
		element,
		focusButton,
		sessionTitle,
		status,
		targetName,
		targetPath,
		currentMessage,
		dismissButton,
		effectHost: createLocalEffectHost(focusButton),
		handleFocus: (_event: MouseEvent) => undefined,
		handleDismiss: (_event: MouseEvent) => undefined,
	};

	element.className = 'graph-agent-activity-notification-item';
	element.setAttribute(AGENT_ACTIVITY_NOTIFICATION_KEY_ATTRIBUTE, entry.key);
	focusButton.className = 'graph-agent-activity-notification-focus';
	focusButton.type = 'button';
	summary.className = 'graph-agent-activity-notification-summary';
	sessionTitle.className = 'graph-agent-activity-notification-session-title';
	status.className = 'graph-agent-activity-notification-status';
	target.className = 'graph-agent-activity-notification-target';
	targetName.className = 'graph-agent-activity-notification-target-name';
	targetPath.className = 'graph-agent-activity-notification-target-path';
	currentMessage.className = 'graph-agent-activity-notification-message';
	summary.append(sessionTitle, status);
	target.append(targetName, targetPath);
	focusButton.append(summary, target, currentMessage);
	dismissButton.className = 'graph-agent-activity-notification-dismiss';
	dismissButton.type = 'button';
	dismissButton.setAttribute('aria-label', 'Dismiss notification');
	dismissButton.title = 'Dismiss notification';
	dismissIcon.className = 'graph-agent-activity-notification-dismiss-icon';
	dismissIcon.setAttribute('aria-hidden', 'true');
	dismissButton.append(dismissIcon);
	element.append(focusButton, dismissButton);

	registration.handleFocus = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		interactions.onFocus?.(registration.entry);
	};
	registration.handleDismiss = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		interactions.onDismiss?.(registration.entry);
	};
	focusButton.addEventListener('click', registration.handleFocus);
	dismissButton.addEventListener('click', registration.handleDismiss);
	return registration;
}

function updateNotificationRegistration(
	registration: NotificationRegistration,
	entry: AgentActivityNotificationEntry,
): void {
	const targetName = entry.dismissalScope === 'session'
		? 'Entire task'
		: entry.targetName;
	const targetPath = entry.dismissalScope === 'session'
		? `Completion events for ${entry.groupedTargetCount} nodes`
		: entry.targetPath;

	registration.entry = entry;
	registration.element.setAttribute('data-activity', entry.activity);
	registration.element.setAttribute('data-availability', entry.availability);
	registration.focusButton.setAttribute(
		'aria-label',
		`${entry.sessionTitle}, ${targetPath}, ${getAgentActivityNotificationStatusLabel(
			entry.activity,
		)}`,
	);
	registration.focusButton.disabled = entry.availability === 'outside';
	registration.focusButton.title = entry.availability === 'outside'
		? 'This target is outside the current Workspace Graph.'
		: targetPath;
	registration.sessionTitle.textContent = entry.sessionTitle;
	registration.status.textContent = getAgentActivityNotificationStatusLabel(
		entry.activity,
	);
	registration.targetName.textContent = targetName;
	registration.targetPath.textContent = targetPath;
	registration.currentMessage.textContent = entry.currentMessage;
	registration.effectHost.setEffects(getAgentActivityEffects(
		entry.sessionId,
		entry.activity,
		entry.sessionColor,
	));
}

function disposeNotificationRegistration(
	registration: NotificationRegistration,
): void {
	registration.focusButton.removeEventListener('click', registration.handleFocus);
	registration.dismissButton.removeEventListener(
		'click',
		registration.handleDismiss,
	);
	registration.effectHost.dispose();
}

function isNotificationCenterEventTarget(target: EventTarget | null): boolean {
	const candidate = target as { closest?: (selector: string) => unknown } | null;

	return typeof candidate?.closest === 'function'
		&& candidate.closest(`[${AGENT_ACTIVITY_NOTIFICATION_CENTER_ATTRIBUTE}]`)
			!== null;
}
