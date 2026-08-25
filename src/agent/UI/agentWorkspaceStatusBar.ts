import type { AgentTabModelSnapshot } from './agentTabModel';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

/** 활성 Agent 세션의 Workspace를 보조 기술에 설명하는 고정 문구다. */
export const AGENT_WORKSPACE_STATUS_ACCESSIBLE_LABEL = 'Active Workspace';

/** 활성 탭의 확정된 Workspace 이름을 표시하는 하단 status bar 경계다. */
export interface AgentWorkspaceStatusBarView {
	/** 활성 탭에 확정된 provider/Workspace assignment가 있을 때 root 이름을 표시한다. */
	render(snapshot: AgentTabModelSnapshot): void;

	/** status bar DOM을 정리한다. */
	dispose(): void;
}

/**
 * Terminal 아래에 활성 Agent 세션의 Workspace root 이름만 표시한다.
 *
 * 경로나 URI가 노출되지 않도록 `workspaceDescription`은 읽지 않으며 hover
 * title도 만들지 않는다. provider가 없거나 reset으로 assignment metadata가
 * 제거된 탭에서는 status bar를 숨긴다.
 *
 * @param container Workspace status bar를 렌더링할 host
 * @param dependencies DOM 생성 의존성
 * @returns 탭 snapshot 반영과 정리를 제공하는 status bar 표시 객체
 */
export function initializeAgentWorkspaceStatusBar(
	container: HTMLElement,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentWorkspaceStatusBarView {
	const statusBar = dependencies.createElement('div');
	statusBar.className = 'agent-workspace-status-bar';
	statusBar.setAttribute('role', 'status');
	statusBar.setAttribute('aria-live', 'polite');
	statusBar.setAttribute('aria-atomic', 'true');
	statusBar.hidden = true;

	const workspaceName = dependencies.createElement('span');
	workspaceName.className = 'agent-workspace-status-name';
	statusBar.append(workspaceName);
	container.replaceChildren(statusBar);
	container.hidden = true;

	return {
		render(snapshot): void {
			const activeTab = snapshot.tabs.find(
				(tab) => tab.id === snapshot.activeTabId,
			);
			const committedWorkspaceName = activeTab?.providerId === undefined
				? undefined
				: activeTab.workspaceName;

			if (committedWorkspaceName === undefined) {
				workspaceName.textContent = '';
				statusBar.removeAttribute('aria-label');
				statusBar.hidden = true;
				container.hidden = true;
				return;
			}

			workspaceName.textContent = committedWorkspaceName;
			statusBar.setAttribute(
				'aria-label',
				`${AGENT_WORKSPACE_STATUS_ACCESSIBLE_LABEL}: ${committedWorkspaceName}`,
			);
			statusBar.hidden = false;
			container.hidden = false;
		},

		dispose(): void {
			workspaceName.textContent = '';
			statusBar.removeAttribute('aria-label');
			statusBar.hidden = true;
			container.hidden = true;
			container.replaceChildren();
		},
	};
}
