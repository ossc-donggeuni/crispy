import type { AgentTabModelSnapshot } from './agentTabModel';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

/** 활성 Agent 세션의 Workspace를 보조 기술에 설명하는 고정 문구다. */
export const AGENT_WORKSPACE_STATUS_ACCESSIBLE_LABEL = 'Active Workspace';
export const MCP_CONNECTED_ACCESSIBLE_LABEL = 'MCP 연결됨';
export const MCP_CONNECTED_VISIBLE_LABEL = 'connected';
export const MCP_FAILED_VISIBLE_LABEL = 'failed';

/** 활성 탭의 Workspace와 MCP 연결 상태를 표시하는 하단 status bar 경계다. */
export interface AgentWorkspaceStatusBarView {
	/** 활성 탭의 확정된 Workspace와 현재 session의 MCP 상태를 표시한다. */
	render(snapshot: AgentTabModelSnapshot): void;

	/** status bar DOM을 정리한다. */
	dispose(): void;
}

/**
 * Terminal 아래 왼쪽에 활성 Agent 세션의 Workspace root 이름을,
 * 오른쪽에 MCP 연결 상태를 표시한다.
 *
 * 경로나 URI가 노출되지 않도록 `workspaceDescription`은 읽지 않으며 hover
 * title도 만들지 않는다. Workspace와 MCP 상태가 모두 없는 탭에서는
 * status bar를 숨긴다.
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

	const mcpConnection = dependencies.createElement('span');
	mcpConnection.className = 'agent-mcp-connection-status';
	mcpConnection.hidden = true;

	const mcpIndicator = dependencies.createElement('span');
	mcpIndicator.className = 'agent-mcp-connection-indicator';
	mcpIndicator.setAttribute('aria-hidden', 'true');

	const mcpLabel = dependencies.createElement('span');
	mcpLabel.className = 'agent-mcp-connection-label';
	mcpConnection.append(mcpIndicator, mcpLabel);

	statusBar.append(workspaceName, mcpConnection);
	container.replaceChildren(statusBar);
	container.hidden = true;

	const clearMcpStatus = (): void => {
		mcpConnection.hidden = true;
		mcpConnection.removeAttribute('data-kind');
		mcpConnection.removeAttribute('aria-label');
		mcpConnection.removeAttribute('title');
		mcpLabel.textContent = '';
	};

	return {
		render(snapshot): void {
			const activeTab = snapshot.tabs.find(
				(tab) => tab.id === snapshot.activeTabId,
			);
			const committedWorkspaceName = activeTab?.providerId === undefined
				? undefined
				: activeTab.workspaceName;
			const visibleMcpStatus = activeTab?.mcpStatus;
			const hasVisibleMcpStatus = visibleMcpStatus !== undefined
				&& visibleMcpStatus.kind !== 'none';

			if (committedWorkspaceName === undefined && !hasVisibleMcpStatus) {
				workspaceName.textContent = '';
				workspaceName.hidden = true;
				clearMcpStatus();
				statusBar.removeAttribute('aria-label');
				statusBar.hidden = true;
				container.hidden = true;
				return;
			}

			workspaceName.textContent = committedWorkspaceName ?? '';
			workspaceName.hidden = committedWorkspaceName === undefined;
			const accessibleParts: string[] = [];
			if (committedWorkspaceName !== undefined) {
				accessibleParts.push(
					`${AGENT_WORKSPACE_STATUS_ACCESSIBLE_LABEL}: ${committedWorkspaceName}`,
				);
			}

			if (!hasVisibleMcpStatus) {
				clearMcpStatus();
			} else {
				mcpConnection.hidden = false;
				mcpConnection.dataset.kind = visibleMcpStatus.kind;
				const accessibleLabel = visibleMcpStatus.kind === 'connected'
					? MCP_CONNECTED_ACCESSIBLE_LABEL
					: visibleMcpStatus.message;
				mcpConnection.setAttribute('aria-label', accessibleLabel);
				mcpLabel.textContent = visibleMcpStatus.kind === 'connected'
					? MCP_CONNECTED_VISIBLE_LABEL
					: MCP_FAILED_VISIBLE_LABEL;
				if (visibleMcpStatus.kind === 'failed') {
					mcpConnection.title = visibleMcpStatus.message;
				} else {
					mcpConnection.removeAttribute('title');
				}
				accessibleParts.push(accessibleLabel);
			}

			statusBar.setAttribute('aria-label', accessibleParts.join(', '));
			statusBar.hidden = false;
			container.hidden = false;
		},

		dispose(): void {
			workspaceName.textContent = '';
			workspaceName.hidden = true;
			clearMcpStatus();
			statusBar.removeAttribute('aria-label');
			statusBar.hidden = true;
			container.hidden = true;
			container.replaceChildren();
		},
	};
}
