import type { AgentTabId, AgentTabModelSnapshot } from './agentTabModel';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

/** 탭 닫기 컨트롤에 표시하는 고정 문구다. */
export const AGENT_TAB_CLOSE_LABEL = '×';

/**
 * 탭 닫기 컨트롤의 접근성 이름을 만든다.
 *
 * @param tabLabel 대상 탭의 표시 라벨
 * @returns 닫기 버튼에 사용할 접근성 이름
 */
export function formatTabCloseTitle(tabLabel: string): string {
	return `Close ${tabLabel}`;
}

/** 탭 strip이 상위 계층으로 전달하는 사용자 동작이다. */
export interface AgentTabStripCallbacks {
	/** 탭 본문을 눌러 활성 탭 전환을 요청한 경우다. */
	onSelectTab(tabId: AgentTabId): void;

	/**
	 * 닫기 컨트롤을 눌러 탭 닫기를 요청한 경우다.
	 * 실제 닫기 전 확인은 상위 계층이 담당한다.
	 */
	onRequestCloseTab(tabId: AgentTabId): void;
}

/** 탭 목록을 상태 변화에 맞춰 갱신하는 표시 경계다. */
export interface AgentTabStripView {
	/** 주어진 탭 상태로 탭 목록과 활성 표시를 다시 그린다. */
	render(snapshot: AgentTabModelSnapshot): void;

	/** 탭 strip DOM을 제거한다. */
	dispose(): void;
}

/**
 * Agent 영역의 탭 strip을 만든다.
 * 각 탭은 활성 전환용 본문 버튼과 별도의 닫기 컨트롤로 구성한다.
 *
 * @param container 탭 strip을 렌더링할 컨테이너
 * @param callbacks 탭 전환과 닫기 요청을 전달받는 콜백
 * @param dependencies DOM 생성 의존성
 * @returns 상태 반영과 정리를 제공하는 탭 strip 표시 객체
 */
export function initializeAgentTabStrip(
	container: HTMLElement,
	callbacks: AgentTabStripCallbacks,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentTabStripView {
	container.setAttribute('role', 'tablist');

	return {
		render(snapshot): void {
			const tabElements = snapshot.tabs.map((tab) => {
				const tabElement = dependencies.createElement('div');
				tabElement.className = 'agent-tab';
				tabElement.dataset.tabId = tab.id;

				const isActive = tab.id === snapshot.activeTabId;
				if (isActive) {
					tabElement.dataset.active = 'true';
				}

				const selectButton = dependencies.createElement('button');
				selectButton.type = 'button';
				selectButton.className = 'agent-tab-select';
				selectButton.textContent = tab.label;
				selectButton.title = tab.label;
				selectButton.setAttribute('role', 'tab');
				selectButton.setAttribute('aria-selected', isActive ? 'true' : 'false');
				selectButton.addEventListener('click', () => callbacks.onSelectTab(tab.id));

				const closeButton = dependencies.createElement('button');
				closeButton.type = 'button';
				closeButton.className = 'agent-tab-close';
				closeButton.textContent = AGENT_TAB_CLOSE_LABEL;
				closeButton.title = formatTabCloseTitle(tab.label);
				closeButton.setAttribute('aria-label', formatTabCloseTitle(tab.label));
				closeButton.addEventListener('click', () => {
					callbacks.onRequestCloseTab(tab.id);
				});

				tabElement.append(selectButton, closeButton);
				return tabElement;
			});

			container.replaceChildren(...tabElements);
		},

		dispose(): void {
			container.replaceChildren();
			container.removeAttribute('role');
		},
	};
}
