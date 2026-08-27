import type { AgentActivityNotificationScheduler } from './agentActivityFloatingNotifications';
import {
	createFullGraphVisibleArea,
	type GraphVisibleAreaProvider,
} from './graphVisibleArea';

export const TASK_AGENT_SESSION_END_NOTICE_STACK_ATTRIBUTE =
	'data-task-agent-session-end-notice-stack';
export const TASK_AGENT_SESSION_END_NOTICE_ATTRIBUTE =
	'data-task-agent-session-end-notice';
export const TASK_AGENT_SESSION_END_NOTICE_LIFETIME_MS = 4_000;

/** Task-owned Agent 탭 정리 결과를 transient overlay notice로 표시한다. */
export interface TaskAgentSessionEndNoticeStack {
	show(sessionId: string, sessionTitle: string): void;
	refreshVisibleGraphArea(): void;
	dispose(): void;
}

interface TaskAgentSessionEndNoticeRegistration {
	readonly element: HTMLDivElement;
	timer?: unknown;
}

const DEFAULT_SCHEDULER: AgentActivityNotificationScheduler = {
	setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
	clearTimeout: (handle) => globalThis.clearTimeout(
		handle as ReturnType<typeof globalThis.setTimeout>,
	),
};

/**
 * Graph의 현재 표시 가능 영역 중앙 하단에 세션별 종료 안내를 쌓는다.
 * 같은 Session은 중복 표시하지 않으며 각 안내는 정확히 4초 뒤 제거된다.
 */
export function initializeTaskAgentSessionEndNoticeStack(
	overlayLayer: HTMLElement,
	viewport: HTMLElement,
	getVisibleGraphArea: GraphVisibleAreaProvider = () => (
		createFullGraphVisibleArea({
			width: viewport.clientWidth,
			height: viewport.clientHeight,
		})
	),
	scheduler: AgentActivityNotificationScheduler = DEFAULT_SCHEDULER,
): TaskAgentSessionEndNoticeStack {
	const ownerDocument = overlayLayer.ownerDocument;
	const stack = ownerDocument.createElement('div');
	const registrations = new Map<
		string,
		TaskAgentSessionEndNoticeRegistration
	>();
	let disposed = false;

	stack.className = 'task-agent-session-end-notice-stack';
	stack.setAttribute(TASK_AGENT_SESSION_END_NOTICE_STACK_ATTRIBUTE, '');
	stack.setAttribute('aria-live', 'polite');
	stack.setAttribute('aria-relevant', 'additions');
	overlayLayer.append(stack);

	const remove = (sessionId: string): void => {
		const registration = registrations.get(sessionId);

		if (!registration) {
			return;
		}
		registrations.delete(sessionId);
		if (registration.timer !== undefined) {
			scheduler.clearTimeout(registration.timer);
		}
		registration.element.remove();
	};
	const refreshVisibleGraphArea = (): void => {
		if (
			disposed
			|| viewport.clientWidth <= 0
			|| viewport.clientHeight <= 0
		) {
			return;
		}
		const area = getVisibleGraphArea();

		stack.style.left = `${area.left + area.width / 2}px`;
		stack.style.bottom = `${Math.max(0, viewport.clientHeight - area.bottom) + 24}px`;
		stack.style.maxWidth = `${Math.max(0, area.width - 32)}px`;
	};

	refreshVisibleGraphArea();

	return {
		show(sessionId, sessionTitle): void {
			if (disposed || registrations.has(sessionId)) {
				return;
			}
			const notice = ownerDocument.createElement('div');

			notice.className = 'task-agent-session-end-notice';
			notice.setAttribute(TASK_AGENT_SESSION_END_NOTICE_ATTRIBUTE, '');
			notice.textContent = `${sessionTitle}, assigned to this task, has ended.`;
			stack.append(notice);
			const registration: TaskAgentSessionEndNoticeRegistration = {
				element: notice,
			};

			registrations.set(sessionId, registration);
			registration.timer = scheduler.setTimeout(
				() => remove(sessionId),
				TASK_AGENT_SESSION_END_NOTICE_LIFETIME_MS,
			);
		},
		refreshVisibleGraphArea,
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			for (const registration of registrations.values()) {
				if (registration.timer !== undefined) {
					scheduler.clearTimeout(registration.timer);
				}
				registration.element.remove();
			}
			registrations.clear();
			stack.remove();
		},
	};
}
