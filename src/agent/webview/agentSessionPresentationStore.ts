import type { SessionId, TabId } from '../protocol';
import {
	resolveAgentSessionColor,
	type AgentSessionColorResolver,
} from '../agentSessionColor';

/** 노드 Binding에 표시할 세션 상태다. PTY 전체 이력은 보관하지 않는다. */
export interface AgentSessionPresentationSnapshot {
	readonly tabId: TabId;
	readonly sessionId: SessionId;
	readonly color: string;
	readonly title: string;
	readonly currentMessage: string;
	readonly state: 'starting' | 'running';
}

export type AgentSessionPresentationStoreSnapshot =
	readonly AgentSessionPresentationSnapshot[];

/** 고빈도 텍스트 변경과 Binding 개수를 바꿀 수 있는 수명주기 변경을 구분한다. */
export interface AgentSessionPresentationChange {
	readonly kind: 'lifecycle' | 'content';
	readonly sessionId: SessionId;
}

export type AgentSessionPresentationSubscriber = (
	change: AgentSessionPresentationChange,
) => void;

/** Webview runtime에서만 유지하는 현재 세션 표시 정보 경계다. */
export interface AgentSessionPresentationStore {
	getSession(sessionId: SessionId): AgentSessionPresentationSnapshot | undefined;
	getSessionForTab(tabId: TabId): AgentSessionPresentationSnapshot | undefined;
	getSnapshot(): AgentSessionPresentationStoreSnapshot;
	isKnownSession(sessionId: SessionId): boolean;
	isRunningSession(sessionId: SessionId): boolean;
	startSession(
		tabId: TabId,
		sessionId: SessionId,
		title: string,
		initialColor?: string,
	): void;
	activateSession(
		tabId: TabId,
		sessionId: SessionId,
		title: string,
		initialColor?: string,
	): void;
	updateTitle(sessionId: SessionId, title: string): void;
	updateCurrentMessage(
		tabId: TabId,
		sessionId: SessionId,
		currentMessage: string,
	): void;
	endSession(sessionId: SessionId): boolean;
	endSessionForTab(tabId: TabId): SessionId | undefined;
	subscribe(subscriber: AgentSessionPresentationSubscriber): () => void;
	dispose(): void;
}

/** Graph Binding 한 행에 보관하는 현재 메시지의 최대 Unicode code point 수다. */
export const AGENT_SESSION_CURRENT_MESSAGE_MAX_CODE_POINTS = 256;

/** 새 PTY가 아직 화면 메시지를 만들지 못했을 때 사용하는 고정 표시다. */
export const AGENT_SESSION_WAITING_MESSAGE = 'Waiting for output…';

/** 비정상적으로 빈 탭 제목이 들어와도 raw session ID를 노출하지 않는 fallback이다. */
export const AGENT_SESSION_UNTITLED_TITLE = 'Agent session';

/** 제목과 현재 출력만 보관하는 비영속 세션 표시 Store를 만든다. */
export function createAgentSessionPresentationStore(
	resolveSessionColor: AgentSessionColorResolver = resolveAgentSessionColor,
): AgentSessionPresentationStore {
	const sessionsById = new Map<SessionId, AgentSessionPresentationSnapshot>();
	const sessionIdsByTab = new Map<TabId, SessionId>();
	const subscribers = new Set<AgentSessionPresentationSubscriber>();
	let disposed = false;

	const notify = (change: AgentSessionPresentationChange): void => {
		for (const subscriber of [...subscribers]) {
			try {
				subscriber(change);
			} catch {
				/** 한 표시 구독자의 실패를 다른 Graph/Terminal 구독자와 격리한다. */
			}
		}
	};

	const removeSession = (sessionId: SessionId): boolean => {
		const current = sessionsById.get(sessionId);

		if (current === undefined) {
			return false;
		}

		sessionsById.delete(sessionId);
		if (sessionIdsByTab.get(current.tabId) === sessionId) {
			sessionIdsByTab.delete(current.tabId);
		}
		notify({ kind: 'lifecycle', sessionId });
		return true;
	};

	const setSession = (
		tabId: TabId,
		sessionId: SessionId,
		title: string,
		state: AgentSessionPresentationSnapshot['state'],
		initialColor?: string,
	): void => {
		if (disposed) {
			return;
		}

		const previousSessionId = sessionIdsByTab.get(tabId);
		if (previousSessionId !== undefined && previousSessionId !== sessionId) {
			removeSession(previousSessionId);
		}

		const current = sessionsById.get(sessionId);
		const normalizedTitle = normalizePresentationText(title);
		if (current !== undefined) {
			if (current.tabId !== tabId) {
				sessionIdsByTab.delete(current.tabId);
			}
			const next = Object.freeze({
				...current,
				tabId,
				title: normalizedTitle,
				state,
			});
			const lifecycleChanged = current.tabId !== tabId || current.state !== state;
			const contentChanged = current.title !== normalizedTitle;

			sessionsById.set(sessionId, next);
			sessionIdsByTab.set(tabId, sessionId);
			if (lifecycleChanged) {
				notify({ kind: 'lifecycle', sessionId });
			} else if (contentChanged) {
				notify({ kind: 'content', sessionId });
			}
			return;
		}

		sessionsById.set(sessionId, Object.freeze({
			tabId,
			sessionId,
			color: initialColor ?? resolveSessionColor(sessionId),
			title: normalizedTitle,
			currentMessage: '',
			state,
		}));
		sessionIdsByTab.set(tabId, sessionId);
		notify({ kind: 'lifecycle', sessionId });
	};

	return {
		getSession: (sessionId) => sessionsById.get(sessionId),
		getSessionForTab(tabId) {
			const sessionId = sessionIdsByTab.get(tabId);
			return sessionId === undefined ? undefined : sessionsById.get(sessionId);
		},
		getSnapshot: () => Object.freeze([...sessionsById.values()]),
		isKnownSession: (sessionId) => sessionsById.has(sessionId),
		isRunningSession: (sessionId) => (
			sessionsById.get(sessionId)?.state === 'running'
		),
		startSession(tabId, sessionId, title, initialColor): void {
			const current = sessionsById.get(sessionId);
			setSession(
				tabId,
				sessionId,
				title,
				current?.state === 'running' ? 'running' : 'starting',
				initialColor,
			);
		},
		activateSession(tabId, sessionId, title, initialColor): void {
			setSession(tabId, sessionId, title, 'running', initialColor);
		},
		updateTitle(sessionId, title): void {
			if (disposed) {
				return;
			}
			const current = sessionsById.get(sessionId);
			const normalizedTitle = normalizePresentationText(title);
			if (current === undefined || current.title === normalizedTitle) {
				return;
			}
			sessionsById.set(sessionId, Object.freeze({
				...current,
				title: normalizedTitle,
			}));
			notify({ kind: 'content', sessionId });
		},
		updateCurrentMessage(tabId, sessionId, currentMessage): void {
			if (disposed) {
				return;
			}
			const current = sessionsById.get(sessionId);
			if (
				current === undefined
				|| current.tabId !== tabId
				|| current.state !== 'running'
			) {
				return;
			}
			const normalizedMessage = truncateCodePoints(
				normalizePresentationText(currentMessage),
				AGENT_SESSION_CURRENT_MESSAGE_MAX_CODE_POINTS,
			);
			if (current.currentMessage === normalizedMessage) {
				return;
			}
			sessionsById.set(sessionId, Object.freeze({
				...current,
				currentMessage: normalizedMessage,
			}));
			notify({ kind: 'content', sessionId });
		},
		endSession: (sessionId) => disposed ? false : removeSession(sessionId),
		endSessionForTab(tabId): SessionId | undefined {
			if (disposed) {
				return undefined;
			}
			const sessionId = sessionIdsByTab.get(tabId);
			if (sessionId !== undefined) {
				removeSession(sessionId);
			}
			return sessionId;
		},
		subscribe(subscriber): () => void {
			if (disposed) {
				return () => {};
			}
			subscribers.add(subscriber);
			return () => subscribers.delete(subscriber);
		},
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			sessionsById.clear();
			sessionIdsByTab.clear();
			subscribers.clear();
		},
	};
}

/** DOM에 넣기 전 제어문자와 불필요한 줄바꿈을 제거한다. */
function normalizePresentationText(value: string): string {
	const normalized = value
		.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();

	try {
		return normalized.normalize('NFC');
	} catch {
		return normalized;
	}
}

function truncateCodePoints(value: string, maximum: number): string {
	const codePoints = [...value];
	if (codePoints.length <= maximum) {
		return value;
	}

	return `${codePoints.slice(0, Math.max(0, maximum - 1)).join('')}…`;
}
