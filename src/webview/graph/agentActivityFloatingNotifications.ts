import type { GraphNodeLocalEffectHost } from './graphNodeEffects';
import { getAgentActivityEffects } from './agentActivityPresentation';
import {
	getAgentActivityNotificationStatusLabel,
	type AgentActivityNotificationEntry,
} from './agentActivityNotifications';

export const AGENT_ACTIVITY_FLOATING_NOTIFICATION_ATTRIBUTE =
	'data-agent-activity-floating-notification';
export const AGENT_ACTIVITY_FLOATING_NOTIFICATION_SEQUENCE_ATTRIBUTE =
	'data-agent-activity-floating-notification-sequence';
export const AGENT_ACTIVITY_FLOATING_NOTIFICATION_EXIT_ANIMATION =
	'graph-agent-activity-floating-notification-exit';
export const AGENT_ACTIVITY_FLOATING_NOTIFICATION_LIFETIME_MS = 10_000;
export const AGENT_ACTIVITY_FLOATING_NOTIFICATION_EXIT_MS = 180;

/** Floating 알림의 시간 경계를 테스트와 Webview runtime에서 공통으로 주입한다. */
export interface AgentActivityNotificationScheduler {
	setTimeout(callback: () => void, delay: number): unknown;
	clearTimeout(handle: unknown): void;
}

/** 새 Activity event를 표시하고 현재 알림 제거와 전체 dispose를 동기화한다. */
export interface AgentActivityFloatingNotificationStack {
	push(entry: AgentActivityNotificationEntry): void;
	update(entry: AgentActivityNotificationEntry): void;
	clearNotificationKey(key: string): void;
	dispose(): void;
}

interface FloatingNotificationRegistration {
	entry: AgentActivityNotificationEntry;
	readonly id: string;
	readonly element: HTMLButtonElement;
	readonly sessionTitle: HTMLSpanElement;
	readonly status: HTMLSpanElement;
	readonly effectHost: GraphNodeLocalEffectHost;
	exiting: boolean;
	lifetimeTimer?: unknown;
	exitTimer?: unknown;
	handleClick: (event: MouseEvent) => void;
	handleAnimationEnd: (event: AnimationEvent) => void;
}

type GraphNodeLocalEffectHostFactory = (
	element: HTMLElement,
) => GraphNodeLocalEffectHost;

const DEFAULT_SCHEDULER: AgentActivityNotificationScheduler = {
	setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
	clearTimeout: (handle) => globalThis.clearTimeout(
		handle as ReturnType<typeof globalThis.setTimeout>,
	),
};

/**
 * Bell 바로 왼쪽에 새 Activity event를 수신 순서대로 쌓는 transient stack이다.
 * Store 현재값은 소유하지 않으며 Click은 Focus만 요청하고 자신의 박스만 닫는다.
 */
export function initializeAgentActivityFloatingNotificationStack(
	host: HTMLElement,
	createLocalEffectHost: GraphNodeLocalEffectHostFactory,
	onFocus: (entry: AgentActivityNotificationEntry) => void,
	scheduler: AgentActivityNotificationScheduler = DEFAULT_SCHEDULER,
): AgentActivityFloatingNotificationStack {
	const ownerDocument = host.ownerDocument;
	const layer = ownerDocument.createElement('div');
	const registrations = new Map<string, FloatingNotificationRegistration>();
	let disposed = false;

	layer.className = 'graph-agent-activity-floating-notification-stack';
	layer.setAttribute('aria-live', 'polite');
	layer.setAttribute('aria-relevant', 'additions');
	host.append(layer);

	const finalizeRemoval = (
		registration: FloatingNotificationRegistration,
	): void => {
		if (!registrations.delete(registration.id)) {
			return;
		}
		disposeRegistration(registration, scheduler);
	};
	const beginExit = (
		registration: FloatingNotificationRegistration,
	): void => {
		if (registration.exiting || !registrations.has(registration.id)) {
			return;
		}
		registration.exiting = true;
		clearRegistrationTimer(registration, 'lifetimeTimer', scheduler);
		registration.element.classList.add('is-exiting');
		registration.exitTimer = scheduler.setTimeout(
			() => finalizeRemoval(registration),
			AGENT_ACTIVITY_FLOATING_NOTIFICATION_EXIT_MS,
		);
	};

	return {
		push(entry): void {
			if (disposed) {
				return;
			}
			const id = createFloatingNotificationId(entry);

			if (registrations.has(id)) {
				return;
			}
			const registration = createRegistration(
				ownerDocument,
				entry,
				createLocalEffectHost,
				(eventEntry) => {
					beginExit(registration);
					onFocus(eventEntry);
				},
				(event) => {
					if (
						event.target === registration.element
						&& event.animationName
							=== AGENT_ACTIVITY_FLOATING_NOTIFICATION_EXIT_ANIMATION
					) {
						finalizeRemoval(registration);
					}
				},
			);

			registrations.set(id, registration);
			layer.append(registration.element);
			registration.lifetimeTimer = scheduler.setTimeout(
				() => beginExit(registration),
				AGENT_ACTIVITY_FLOATING_NOTIFICATION_LIFETIME_MS,
			);
		},
		update(entry): void {
			const registration = registrations.get(
				createFloatingNotificationId(entry),
			);

			if (registration && !registration.exiting) {
				updateRegistration(registration, entry);
			}
		},
		clearNotificationKey(key): void {
			for (const registration of registrations.values()) {
				if (registration.entry.key === key) {
					beginExit(registration);
				}
			}
		},
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			for (const registration of registrations.values()) {
				disposeRegistration(registration, scheduler);
			}
			registrations.clear();
			layer.remove();
		},
	};
}

function createRegistration(
	ownerDocument: Document,
	entry: AgentActivityNotificationEntry,
	createLocalEffectHost: GraphNodeLocalEffectHostFactory,
	onFocus: (entry: AgentActivityNotificationEntry) => void,
	onAnimationEnd: (event: AnimationEvent) => void,
): FloatingNotificationRegistration {
	const element = ownerDocument.createElement('button');
	const sessionTitle = ownerDocument.createElement('span');
	const status = ownerDocument.createElement('span');
	const registration: FloatingNotificationRegistration = {
		entry,
		id: createFloatingNotificationId(entry),
		element,
		sessionTitle,
		status,
		effectHost: createLocalEffectHost(element),
		exiting: false,
		handleClick: (_event: MouseEvent) => undefined,
		handleAnimationEnd: onAnimationEnd,
	};

	element.className = 'graph-agent-activity-floating-notification';
	element.type = 'button';
	element.setAttribute(AGENT_ACTIVITY_FLOATING_NOTIFICATION_ATTRIBUTE, '');
	element.setAttribute(
		AGENT_ACTIVITY_FLOATING_NOTIFICATION_SEQUENCE_ATTRIBUTE,
		String(entry.sequence),
	);
	sessionTitle.className =
		'graph-agent-activity-floating-notification-session-title';
	status.className = 'graph-agent-activity-floating-notification-status';
	element.append(sessionTitle, status);
	registration.handleClick = (event: MouseEvent): void => {
		event.preventDefault();
		event.stopPropagation();
		onFocus(registration.entry);
	};
	element.addEventListener('click', registration.handleClick);
	element.addEventListener('animationend', registration.handleAnimationEnd);
	updateRegistration(registration, entry);
	return registration;
}

function updateRegistration(
	registration: FloatingNotificationRegistration,
	entry: AgentActivityNotificationEntry,
): void {
	registration.entry = entry;
	registration.element.setAttribute('data-activity', entry.activity);
	registration.element.setAttribute('data-availability', entry.availability);
	registration.element.setAttribute(
		'aria-label',
		`${entry.sessionTitle}, ${getAgentActivityNotificationStatusLabel(
			entry.activity,
		)}, ${entry.targetPath}`,
	);
	registration.element.disabled = entry.availability === 'outside';
	registration.element.title = entry.availability === 'outside'
		? '현재 Workspace Graph 범위 밖의 대상입니다.'
		: entry.targetPath;
	registration.sessionTitle.textContent = entry.sessionTitle;
	registration.status.textContent = getAgentActivityNotificationStatusLabel(
		entry.activity,
	);
	registration.effectHost.setEffects(getAgentActivityEffects(
		entry.sessionId,
		entry.activity,
		entry.sessionColor,
	));
}

function disposeRegistration(
	registration: FloatingNotificationRegistration,
	scheduler: AgentActivityNotificationScheduler,
): void {
	clearRegistrationTimer(registration, 'lifetimeTimer', scheduler);
	clearRegistrationTimer(registration, 'exitTimer', scheduler);
	registration.element.removeEventListener('click', registration.handleClick);
	registration.element.removeEventListener(
		'animationend',
		registration.handleAnimationEnd,
	);
	registration.effectHost.dispose();
	registration.element.remove();
}

function clearRegistrationTimer(
	registration: FloatingNotificationRegistration,
	field: 'lifetimeTimer' | 'exitTimer',
	scheduler: AgentActivityNotificationScheduler,
): void {
	const handle = registration[field];

	if (handle !== undefined) {
		scheduler.clearTimeout(handle);
		registration[field] = undefined;
	}
}

function createFloatingNotificationId(
	entry: AgentActivityNotificationEntry,
): string {
	return JSON.stringify([entry.key, entry.sequence]);
}
