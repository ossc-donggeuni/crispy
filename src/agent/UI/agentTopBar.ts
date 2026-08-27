import type { AgentTabModelSnapshot } from './agentTabModel';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

/** 새 탭 생성 버튼의 접근성 이름이다. */
export const AGENT_CREATE_TAB_TITLE = 'New agent tab';

/** 재시작 버튼의 접근성 이름이며 Agent 선택 화면으로 돌아가는 동작임을 밝힌다. */
export const AGENT_RESTART_TITLE = 'Restart and choose an agent';

export const AGENT_CHANGE_PROVIDER_TITLE = 'Choose another agent';

export const MCP_RESTART_LABEL = 'Restart MCP and Agent';

/**
 * 상단 bar가 상위 계층으로 전달하는 사용자 동작이다.
 *
 * 상단 bar는 탭 자체를 다루는 동작만 담당한다.
 * 활성 탭의 provider 선택은 xterm 중앙 선택기가 별도로 담당한다.
 */
export interface AgentTopBarCallbacks {
	/** 현재 Workspace assignment를 유지한 채 provider 선택기를 연다. */
	onChangeProvider(): void;

	/** `+` 버튼으로 provider 미선택 상태의 새 탭을 요청한 경우다. */
	onCreateTab(): void;

	/** 재시작 버튼으로 현재 CLI 종료와 provider 재선택을 요청한 경우다. */
	onRestartActiveTab(): void;

	/** retryable MCP failure에서 current Agent와 MCP의 명시적 재시작을 요청한다. */
	onRestartMcpActiveTab(): void;
}

/** 상단 액션의 활성화 여부에 필요한 assignment lifecycle 상태다. */
export interface AgentTopBarState {
	readonly pending: boolean;
	readonly resetting: boolean;
}

/** 상단 bar를 상태 변화에 맞춰 갱신하는 표시 경계다. */
export interface AgentTopBarView {
	/** 주어진 탭 상태를 버튼의 활성/비활성 상태에 반영한다. */
	render(snapshot: AgentTabModelSnapshot, state?: AgentTopBarState): void;

	/** 상단 bar DOM을 제거한다. */
	dispose(): void;
}

/**
 * Agent 영역 상단 bar에 새 탭과 재시작 버튼을 만든다.
 *
 * provider 선택은 미선택 탭의 xterm 중앙 선택기가 소유한다.
 *
 * @param container 상단 bar를 렌더링할 컨테이너
 * @param callbacks 새 탭과 재시작 동작을 전달받는 콜백
 * @param dependencies DOM 생성 의존성
 * @returns 상태 반영과 정리를 제공하는 상단 bar 표시 객체
 */
export function initializeAgentTopBar(
	container: HTMLElement,
	callbacks: AgentTopBarCallbacks,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentTopBarView {
	const actions = dependencies.createElement('div');
	actions.className = 'agent-top-bar-actions';

	const createTabButton = dependencies.createElement('button');
	createTabButton.type = 'button';
	createTabButton.className = 'agent-create-tab';
	createTabButton.title = AGENT_CREATE_TAB_TITLE;
	createTabButton.setAttribute('aria-label', AGENT_CREATE_TAB_TITLE);
	createTabButton.addEventListener('click', () => callbacks.onCreateTab());

	const restartButton = dependencies.createElement('button');
	restartButton.type = 'button';
	restartButton.className = 'agent-restart-session';
	restartButton.title = AGENT_RESTART_TITLE;
	restartButton.setAttribute('aria-label', AGENT_RESTART_TITLE);
	restartButton.addEventListener('click', () => callbacks.onRestartActiveTab());

	const changeProviderButton = dependencies.createElement('button');
	changeProviderButton.type = 'button';
	changeProviderButton.className = 'agent-change-provider';
	changeProviderButton.title = AGENT_CHANGE_PROVIDER_TITLE;
	changeProviderButton.setAttribute('aria-label', AGENT_CHANGE_PROVIDER_TITLE);
	changeProviderButton.addEventListener('click', () => callbacks.onChangeProvider());

	const mcpStatus = dependencies.createElement('div');
	mcpStatus.className = 'agent-mcp-status';
	mcpStatus.hidden = true;

	const mcpStatusText = dependencies.createElement('span');
	mcpStatusText.className = 'agent-mcp-status-text';

	const mcpRestartButton = dependencies.createElement('button');
	mcpRestartButton.type = 'button';
	mcpRestartButton.className = 'agent-mcp-restart';
	mcpRestartButton.textContent = MCP_RESTART_LABEL;
	mcpRestartButton.setAttribute('aria-label', MCP_RESTART_LABEL);
	mcpRestartButton.addEventListener('click', () => callbacks.onRestartMcpActiveTab());
	mcpStatus.append(mcpStatusText, mcpRestartButton);

	actions.append(createTabButton, changeProviderButton, restartButton);
	container.replaceChildren(mcpStatus, actions);

	return {
		render(snapshot, state): void {
			const activeTab = snapshot.tabs.find(
				(tab) => tab.id === snapshot.activeTabId,
			);

			/** Pending 시작도 취소할 수 있게 하되 Reset 중 연타는 막는다. */
			restartButton.disabled = (
				activeTab?.providerId === undefined
				&& state?.pending !== true
			) || state?.resetting === true;
			changeProviderButton.disabled = activeTab?.providerId === undefined
				|| state?.pending === true
				|| state?.resetting === true
				|| activeTab.mcpRestartPending;

			const visibleStatus = activeTab?.mcpStatus;
			if (visibleStatus === undefined || visibleStatus.kind !== 'failed') {
				mcpStatus.hidden = true;
				mcpStatus.removeAttribute('role');
				mcpStatus.removeAttribute('aria-label');
				mcpStatus.removeAttribute('data-kind');
				mcpStatusText.textContent = '';
				mcpRestartButton.hidden = true;
				mcpRestartButton.disabled = false;
				return;
			}

			mcpStatus.hidden = false;
			mcpStatus.dataset.kind = 'failed';
			mcpStatus.setAttribute('role', 'alert');
			mcpStatus.setAttribute('aria-label', visibleStatus.message);
			mcpStatusText.textContent = visibleStatus.message;
			mcpRestartButton.hidden = !visibleStatus.retryable;
			mcpRestartButton.disabled = activeTab?.mcpRestartPending === true;
		},

		dispose(): void {
			container.replaceChildren();
		},
	};
}
