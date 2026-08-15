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

/** 새 탭 생성 버튼에 표시하는 고정 문구다. */
export const AGENT_CREATE_TAB_LABEL = '+';

/** 세션 재시작 버튼에 표시하는 고정 문구다. */
export const AGENT_RESTART_LABEL = '⟳';

/** 새 탭 생성 버튼의 접근성 이름이다. */
export const AGENT_CREATE_TAB_TITLE = 'New agent tab';

/** 재시작 버튼의 접근성 이름이며 provider 전환과 구분되는 동작임을 밝힌다. */
export const AGENT_RESTART_TITLE = 'Restart current agent session';

/** provider 드롭다운의 접근성 이름이다. */
export const AGENT_PROVIDER_SELECT_TITLE = 'Select agent provider';

/**
 * 상단 bar가 상위 계층으로 전달하는 사용자 동작이다.
 *
 * provider 전환과 세션 재시작은 서로 다른 동작이므로 별도의 콜백으로 분리한다.
 * Phase 2에서 각각 다른 Host 메시지로 연결된다.
 */
export interface AgentTopBarCallbacks {
	/** 드롭다운에서 provider를 고른 경우다. */
	onProviderSelect(providerId: ProviderId): void;

	/** `+` 버튼으로 provider 미선택 상태의 새 탭을 요청한 경우다. */
	onCreateTab(): void;

	/** 재시작 버튼으로 현재 활성 탭의 세션 재시작을 요청한 경우다. */
	onRestartActiveTab(): void;
}

/** 상단 bar를 상태 변화에 맞춰 갱신하는 표시 경계다. */
export interface AgentTopBarView {
	/** 주어진 탭 상태를 드롭다운과 버튼의 활성/비활성 상태에 반영한다. */
	render(snapshot: AgentTabModelSnapshot): void;

	/** 상단 bar DOM과 문서 수준 구독을 정리한다. */
	dispose(): void;
}

/**
 * Agent 영역 상단 bar를 만든다.
 * 왼쪽에는 provider 드롭다운을, 오른쪽에는 새 탭과 재시작 버튼을 배치한다.
 *
 * 드롭다운은 native `select` 대신 직접 구성한 목록을 사용한다.
 * native 목록은 VS Code 테마를 따르지 않고 OS 기본 팝업으로 표시되어
 * Webview 안의 다른 요소와 이질적으로 보이기 때문이다.
 *
 * @param container 상단 bar를 렌더링할 컨테이너
 * @param callbacks 드롭다운 선택, 새 탭, 재시작 동작을 전달받는 콜백
 * @param dependencies DOM 생성 및 문서 이벤트 의존성
 * @returns 상태 반영과 정리를 제공하는 상단 bar 표시 객체
 */
export function initializeAgentTopBar(
	container: HTMLElement,
	callbacks: AgentTopBarCallbacks,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentTopBarView {
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

	const triggerCaret = dependencies.createElement('span');
	triggerCaret.className = 'agent-provider-caret';
	triggerCaret.textContent = '⌄';
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

	/* 바깥을 눌렀을 때 목록이 남아 다른 UI를 가리지 않게 한다. */
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
	container.replaceChildren(picker, actions);

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

			/* 재시작은 이미 provider가 정해진 탭에서만 의미가 있다. */
			restartButton.disabled = providerId === undefined;
		},

		dispose(): void {
			closeMenu();
			removeOutsidePointerListener();
			removeKeydownListener();
			container.replaceChildren();
		},
	};
}
