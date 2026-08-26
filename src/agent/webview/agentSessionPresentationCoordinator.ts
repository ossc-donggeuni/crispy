import type { AgentTabModel, AgentTabModelSnapshot } from '../UI/agentTabModel';
import type { HostToWebviewMessage, SessionId, TabId } from '../protocol';
import type { AgentActivityStore } from './agentActivityStore';
import type {
	AgentSessionPresentationSnapshot,
	AgentSessionPresentationStore,
} from './agentSessionPresentationStore';

/** Host lifecycle, 탭 제목과 Activity 정리를 한 세션 identity로 묶는다. */
export interface AgentSessionPresentationCoordinator {
	handleHostMessage(message: HostToWebviewMessage): void;
	endTabSession(tabId: TabId): void;
	dispose(): void;
}

export interface AgentSessionPresentationCoordinatorOptions {
	/** 실제 AgentTabModel이 아니라 다른 UI runtime이 lifecycle을 소유한 세션이다. */
	readonly isSessionExternallyManaged?: (
		session: AgentSessionPresentationSnapshot,
	) => boolean;
}

/** 활성 PTY만 Graph Binding에 노출하고 종료 시 모든 Target Activity를 정리한다. */
export function createAgentSessionPresentationCoordinator(
	model: AgentTabModel,
	presentationStore: AgentSessionPresentationStore,
	activityStore: AgentActivityStore,
	options: AgentSessionPresentationCoordinatorOptions = {},
): AgentSessionPresentationCoordinator {
	let disposed = false;

	const getTab = (tabId: TabId) => (
		model.getSnapshot().tabs.find((tab) => tab.id === tabId)
	);

	const terminateSession = (sessionId: SessionId): void => {
		activityStore.clearAgentActivitiesBySession(sessionId);
		presentationStore.endSession(sessionId);
	};

	const terminateTabSession = (tabId: TabId): void => {
		const sessionId = presentationStore.getSessionForTab(tabId)?.sessionId;
		if (sessionId !== undefined) {
			terminateSession(sessionId);
		}
	};

	const syncModel = (snapshot: AgentTabModelSnapshot): void => {
		if (disposed) {
			return;
		}
		const tabsById = new Map(snapshot.tabs.map((tab) => [tab.id, tab]));

		for (const session of presentationStore.getSnapshot()) {
			const tab = tabsById.get(session.tabId);
			if (tab === undefined) {
				if (options.isSessionExternallyManaged?.(session) === true) {
					continue;
				}
				terminateSession(session.sessionId);
				continue;
			}
			if (
				(session.state === 'running' && tab.sessionId !== session.sessionId)
				|| (
					session.state === 'starting'
					&& tab.sessionId !== undefined
					&& tab.sessionId !== session.sessionId
				)
			) {
				terminateSession(session.sessionId);
				continue;
			}
			presentationStore.updateTitle(session.sessionId, tab.displayName);
		}
	};

	const unsubscribeModel = model.subscribe(syncModel);

	return {
		handleHostMessage(message): void {
			if (disposed) {
				return;
			}
			switch (message.type) {
				case 'agent.switchAccepted':
				case 'agent.resetCompleted':
					terminateTabSession(message.tabId);
					break;
				case 'terminal.starting': {
					const tab = getTab(message.tabId);
					if (tab === undefined) {
						break;
					}
					const current = presentationStore.getSessionForTab(message.tabId);
					if (current !== undefined && current.sessionId !== message.sessionId) {
						terminateSession(current.sessionId);
					}
					presentationStore.startSession(
						message.tabId,
						message.sessionId,
						tab.displayName,
					);
					break;
				}
				case 'terminal.started': {
					const tab = getTab(message.tabId);
					if (tab?.sessionId !== message.sessionId) {
						break;
					}
					const current = presentationStore.getSessionForTab(message.tabId);
					if (current !== undefined && current.sessionId !== message.sessionId) {
						terminateSession(current.sessionId);
					}
					presentationStore.activateSession(
						message.tabId,
						message.sessionId,
						tab.displayName,
					);
					break;
				}
				case 'terminal.exited': {
					const current = presentationStore.getSessionForTab(message.tabId);
					if (current?.sessionId === message.sessionId) {
						terminateSession(message.sessionId);
					}
					break;
				}
				case 'terminal.error': {
					if (message.sessionId === null) {
						break;
					}
					const current = presentationStore.getSessionForTab(message.tabId);
					if (current?.sessionId === message.sessionId) {
						terminateSession(message.sessionId);
					}
					break;
				}
			}
		},
		endTabSession(tabId): void {
			if (!disposed) {
				terminateTabSession(tabId);
			}
		},
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			unsubscribeModel();
			for (const session of presentationStore.getSnapshot()) {
				activityStore.clearAgentActivitiesBySession(session.sessionId);
			}
			presentationStore.dispose();
		},
	};
}
