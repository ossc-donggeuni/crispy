import { PROVIDER_IDS, type ProviderId } from '../protocol';
import {
	AGENT_PROVIDER_LABELS,
	UNSELECTED_PROVIDER_LABEL,
} from './agentProviders';
import type { AgentTabModelSnapshot } from './agentTabModel';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

/** provider 드롭다운의 접근성 이름이다. */
export const AGENT_PROVIDER_SELECT_TITLE = 'Select agent provider';

/** 하단 bar가 상위 계층으로 전달하는 사용자 동작이다. */
export interface AgentProviderBarCallbacks {
	/** 드롭다운에서 provider를 고른 경우다. */
	onProviderSelect(providerId: ProviderId): void;
}

/** 하단 bar를 상태 변화에 맞춰 갱신하는 표시 경계다. */
export interface AgentProviderBarView {
	/** 활성 탭의 provider를 드롭다운 표시와 활성/비활성 상태에 반영한다. */
	render(snapshot: AgentTabModelSnapshot): void;

	/** 하단 bar DOM과 문서 수준 구독을 정리한다. */
	dispose(): void;
}

/**
 * Agent 영역 하단 bar에 provider 드롭다운을 만든다.
 *
 * 드롭다운을 하단에 두면 목록이 위로 펼쳐져 탭 strip과 터미널 상단을 가리지 않는다.
 * 새 탭과 재시작처럼 탭 자체를 다루는 동작은 상단 bar에 남는다.
 *
 * 목록은 native `select` 대신 직접 구성한다. native 목록은 VS Code 테마를 따르지 않고
 * OS 기본 팝업으로 표시되어 Webview 안의 다른 요소와 이질적으로 보이기 때문이다.
 *
 * @param container 하단 bar를 렌더링할 컨테이너
 * @param callbacks provider 선택을 전달받는 콜백
 * @param dependencies DOM 생성 및 문서 이벤트 의존성
 * @returns 상태 반영과 정리를 제공하는 하단 bar 표시 객체
 */
export function initializeAgentProviderBar(
	container: HTMLElement,
	callbacks: AgentProviderBarCallbacks,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentProviderBarView {
	const picker = dependencies.createElement('div');
	picker.className = 'agent-provider-picker';

	const trigger = dependencies.createElement('button');
	trigger.type = 'button';
	trigger.className = 'agent-provider-select';
	trigger.title = AGENT_PROVIDER_SELECT_TITLE;
	trigger.setAttribute('aria-label', AGENT_PROVIDER_SELECT_TITLE);
	trigger.setAttribute('aria-haspopup', 'listbox');
	trigger.setAttribute('aria-expanded', 'false');

	const triggerLabel = dependencies.createElement('span');
	triggerLabel.className = 'agent-provider-value';
	triggerLabel.textContent = UNSELECTED_PROVIDER_LABEL;

	/** 펼침 방향 표시는 글리프 대신 CSS로 그리므로 문자를 넣지 않는다. */
	const triggerCaret = dependencies.createElement('span');
	triggerCaret.className = 'agent-provider-caret';
	triggerCaret.setAttribute('aria-hidden', 'true');

	trigger.append(triggerLabel, triggerCaret);

	const menu = dependencies.createElement('div');
	menu.className = 'agent-provider-menu';
	menu.setAttribute('role', 'listbox');
	menu.setAttribute('aria-label', AGENT_PROVIDER_SELECT_TITLE);
	menu.hidden = true;

	const optionElements = new Map<ProviderId, HTMLElement>();
	for (const providerId of PROVIDER_IDS) {
		const option = dependencies.createElement('button');
		option.type = 'button';
		option.className = 'agent-provider-option';
		option.textContent = AGENT_PROVIDER_LABELS[providerId];
		option.dataset.providerId = providerId;
		option.setAttribute('role', 'option');
		option.setAttribute('aria-selected', 'false');
		option.addEventListener('click', () => {
			closeMenu();
			callbacks.onProviderSelect(providerId);
		});

		optionElements.set(providerId, option);
		menu.append(option);
	}

	picker.append(trigger, menu);

	/** 드롭다운 목록을 닫고 열림 상태 표시를 되돌린다. */
	function closeMenu(): void {
		menu.hidden = true;
		trigger.setAttribute('aria-expanded', 'false');
		delete picker.dataset.open;
	}

	/** 드롭다운 목록을 연다. */
	function openMenu(): void {
		menu.hidden = false;
		trigger.setAttribute('aria-expanded', 'true');
		picker.dataset.open = 'true';
	}

	trigger.addEventListener('click', () => {
		if (menu.hidden) {
			openMenu();
			return;
		}

		closeMenu();
	});

	/** 바깥을 눌렀을 때 목록이 남아 터미널을 가리지 않게 한다. */
	const removeOutsidePointerListener = dependencies.addDocumentListener(
		'pointerdown',
		(event) => {
			if (menu.hidden) {
				return;
			}

			const target = event.target as Node | null;
			if (target !== null && picker.contains(target)) {
				return;
			}

			closeMenu();
		},
	);

	const removeKeydownListener = dependencies.addDocumentListener(
		'keydown',
		(event) => {
			if (menu.hidden || (event as KeyboardEvent).key !== 'Escape') {
				return;
			}

			closeMenu();
			trigger.focus();
		},
	);

	container.replaceChildren(picker);

	return {
		render(snapshot): void {
			const activeTab = snapshot.tabs.find(
				(tab) => tab.id === snapshot.activeTabId,
			);
			const providerId = activeTab?.providerId;

			triggerLabel.textContent = providerId === undefined
				? UNSELECTED_PROVIDER_LABEL
				: AGENT_PROVIDER_LABELS[providerId];
			trigger.disabled = activeTab === undefined;
			if (activeTab === undefined) {
				closeMenu();
			}

			for (const [optionProviderId, option] of optionElements) {
				option.setAttribute(
					'aria-selected',
					optionProviderId === providerId ? 'true' : 'false',
				);
			}
		},

		dispose(): void {
			closeMenu();
			removeOutsidePointerListener();
			removeKeydownListener();
			container.replaceChildren();
		},
	};
}
