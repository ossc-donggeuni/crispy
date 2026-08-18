import { PROVIDER_IDS, type ProviderId } from '../protocol';
import { AGENT_PROVIDER_LABELS } from './agentProviders';
import type { AgentTabModelSnapshot } from './agentTabModel';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

/** 중앙 provider 선택기의 제목과 안내 문구다. */
export const AGENT_PROVIDER_PICKER_TITLE = 'Choose an agent';
export const AGENT_PROVIDER_PICKER_DESCRIPTION =
	'Select a CLI to start this terminal';

/** 키보드 조작 안내에 표시하는 고정 문구다. */
export const AGENT_PROVIDER_NAVIGATE_HINT = '↑↓ Navigate';
export const AGENT_PROVIDER_SELECT_HINT = 'Enter Select';

/** 상표 자산을 대신해 모든 CLI 항목에 공통으로 쓰는 터미널 표식이다. */
export const AGENT_PROVIDER_MARK = '>_';

/** 중앙 선택기가 상위 계층으로 전달하는 사용자 동작이다. */
export interface AgentProviderPickerCallbacks {
	/** 목록에서 provider를 고른 경우다. */
	onProviderSelect(providerId: ProviderId): void;
}

/** 중앙 선택기를 탭 상태에 맞춰 갱신하는 표시 경계다. */
export interface AgentProviderPickerView {
	/** 활성 탭이 provider 미선택 상태일 때만 선택기를 표시한다. */
	render(snapshot: AgentTabModelSnapshot): void;

	/** 선택기 DOM을 정리한다. */
	dispose(): void;
}

/**
 * xterm 영역 중앙에 세로형 provider 선택기를 만든다.
 *
 * 선택기는 활성 탭에 provider가 없을 때만 표시되며, 선택이 끝나면 탭 모델 변경을
 * 통해 즉시 숨겨진다. 위·아래 방향키는 순환 이동하고 Enter는 포커스된 버튼의
 * 기본 동작으로 provider 선택을 확정한다.
 *
 * @param container xterm 위에 겹쳐 표시할 선택기 host
 * @param callbacks provider 선택을 전달받는 콜백
 * @param dependencies DOM 생성 의존성
 * @returns 상태 반영과 정리를 제공하는 중앙 선택기
 */
export function initializeAgentProviderPicker(
	container: HTMLElement,
	callbacks: AgentProviderPickerCallbacks,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentProviderPickerView {
	const panel = dependencies.createElement('div');
	panel.className = 'agent-provider-picker-panel';
	panel.setAttribute('role', 'region');
	panel.setAttribute('aria-label', AGENT_PROVIDER_PICKER_TITLE);

	const heading = dependencies.createElement('div');
	heading.className = 'agent-provider-picker-heading';

	const title = dependencies.createElement('p');
	title.className = 'agent-provider-picker-title';
	title.textContent = AGENT_PROVIDER_PICKER_TITLE;

	const description = dependencies.createElement('p');
	description.className = 'agent-provider-picker-description';
	description.textContent = AGENT_PROVIDER_PICKER_DESCRIPTION;
	heading.append(title, description);

	const list = dependencies.createElement('div');
	list.className = 'agent-provider-list';
	list.setAttribute('role', 'listbox');
	list.setAttribute('aria-label', AGENT_PROVIDER_PICKER_TITLE);

	const optionElements: HTMLButtonElement[] = [];
	let focusedIndex = 0;

	/** 키보드 포커스 표시와 roving tabindex를 한 provider에 맞춘다. */
	const focusOption = (index: number): void => {
		const optionCount = optionElements.length;
		if (optionCount === 0) {
			return;
		}

		focusedIndex = (index + optionCount) % optionCount;
		for (const [optionIndex, option] of optionElements.entries()) {
			const focused = optionIndex === focusedIndex;
			option.setAttribute('tabindex', focused ? '0' : '-1');
			if (focused) {
				option.dataset.focused = 'true';
			} else {
				delete option.dataset.focused;
			}
		}
		optionElements[focusedIndex]?.focus();
	};

	for (const providerId of PROVIDER_IDS) {
		const option = dependencies.createElement('button');
		option.type = 'button';
		option.className = 'agent-provider-option';
		option.dataset.providerId = providerId;
		option.setAttribute('role', 'option');
		option.setAttribute('aria-selected', 'false');

		const mark = dependencies.createElement('span');
		mark.className = 'agent-provider-mark';
		mark.textContent = AGENT_PROVIDER_MARK;
		mark.setAttribute('aria-hidden', 'true');

		const label = dependencies.createElement('span');
		label.className = 'agent-provider-option-label';
		label.textContent = AGENT_PROVIDER_LABELS[providerId];

		option.append(mark, label);
		option.addEventListener('focus', () => {
			focusedIndex = optionElements.indexOf(option);
			for (const entry of optionElements) {
				if (entry === option) {
					entry.dataset.focused = 'true';
				} else {
					delete entry.dataset.focused;
				}
			}
		});
		option.addEventListener('click', () => callbacks.onProviderSelect(providerId));

		optionElements.push(option);
		list.append(option);
	}

	list.addEventListener('keydown', (event) => {
		const key = (event as KeyboardEvent).key;
		if (key !== 'ArrowDown' && key !== 'ArrowUp') {
			return;
		}

		event.preventDefault();
		focusOption(focusedIndex + (key === 'ArrowDown' ? 1 : -1));
	});

	const hints = dependencies.createElement('div');
	hints.className = 'agent-provider-picker-hints';

	const navigateHint = dependencies.createElement('span');
	navigateHint.textContent = AGENT_PROVIDER_NAVIGATE_HINT;

	const selectHint = dependencies.createElement('span');
	selectHint.textContent = AGENT_PROVIDER_SELECT_HINT;

	hints.append(navigateHint, selectHint);
	panel.append(heading, list, hints);
	container.replaceChildren(panel);
	container.hidden = true;

	let visibleTabId: string | undefined;

	return {
		render(snapshot): void {
			const activeTab = snapshot.tabs.find(
				(tab) => tab.id === snapshot.activeTabId,
			);
			const shouldShow = activeTab !== undefined
				&& activeTab.providerId === undefined;

			container.hidden = !shouldShow;
			if (!shouldShow) {
				visibleTabId = undefined;
				return;
			}

			if (visibleTabId !== activeTab.id) {
				visibleTabId = activeTab.id;
				focusOption(0);
			}
		},

		dispose(): void {
			visibleTabId = undefined;
			container.hidden = true;
			container.replaceChildren();
		},
	};
}
