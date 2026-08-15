import type { AgentTabModelSnapshot } from './agentTabModel';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

/** 새 탭 생성 버튼에 표시하는 고정 문구다. */
export const AGENT_CREATE_TAB_LABEL = '+';

/** 세션 재시작 버튼에 표시하는 고정 문구다. */
export const AGENT_RESTART_LABEL = '⟳';

/** 새 탭 생성 버튼의 접근성 이름이다. */
export const AGENT_CREATE_TAB_TITLE = 'New agent tab';

/** 재시작 버튼의 접근성 이름이며 provider 전환과 구분되는 동작임을 밝힌다. */
export const AGENT_RESTART_TITLE = 'Restart current agent session';

/**
 * 상단 bar가 상위 계층으로 전달하는 사용자 동작이다.
 *
 * 상단 bar는 탭 자체를 다루는 동작만 담당한다.
 * 활성 탭의 provider 선택은 하단 bar가 별도로 담당한다.
 */
export interface AgentTopBarCallbacks {
	/** `+` 버튼으로 provider 미선택 상태의 새 탭을 요청한 경우다. */
	onCreateTab(): void;

	/** 재시작 버튼으로 현재 활성 탭의 세션 재시작을 요청한 경우다. */
	onRestartActiveTab(): void;
}

/** 상단 bar를 상태 변화에 맞춰 갱신하는 표시 경계다. */
export interface AgentTopBarView {
	/** 주어진 탭 상태를 버튼의 활성/비활성 상태에 반영한다. */
	render(snapshot: AgentTabModelSnapshot): void;

	/** 상단 bar DOM을 제거한다. */
	dispose(): void;
}

/**
 * Agent 영역 상단 bar에 새 탭과 재시작 버튼을 만든다.
 *
 * provider 드롭다운은 하단 bar가 소유한다. 목록이 아래로 펼쳐지면
 * 탭 strip과 터미널 상단을 가리기 때문에 선택 UI를 반대편에 두었다.
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
	createTabButton.textContent = AGENT_CREATE_TAB_LABEL;
	createTabButton.title = AGENT_CREATE_TAB_TITLE;
	createTabButton.setAttribute('aria-label', AGENT_CREATE_TAB_TITLE);
	createTabButton.addEventListener('click', () => callbacks.onCreateTab());

	const restartButton = dependencies.createElement('button');
	restartButton.type = 'button';
	restartButton.className = 'agent-restart-session';
	restartButton.textContent = AGENT_RESTART_LABEL;
	restartButton.title = AGENT_RESTART_TITLE;
	restartButton.setAttribute('aria-label', AGENT_RESTART_TITLE);
	restartButton.addEventListener('click', () => callbacks.onRestartActiveTab());

	actions.append(createTabButton, restartButton);
	container.replaceChildren(actions);

	return {
		render(snapshot): void {
			const activeTab = snapshot.tabs.find(
				(tab) => tab.id === snapshot.activeTabId,
			);

			/* 재시작은 이미 provider가 정해진 탭에서만 의미가 있다. */
			restartButton.disabled = activeTab?.providerId === undefined;
		},

		dispose(): void {
			container.replaceChildren();
		},
	};
}
