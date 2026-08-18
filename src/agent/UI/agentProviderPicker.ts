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
 * 선택기는 활성 탭에 provider가 없을 때만 표시되며, 사용자가 provider 버튼을
 * 직접 누르면 탭 모델 변경을 통해 즉시 숨겨진다.
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
	list.setAttribute('role', 'group');
	list.setAttribute('aria-label', AGENT_PROVIDER_PICKER_TITLE);

	for (const providerId of PROVIDER_IDS) {
		const option = dependencies.createElement('button');
		option.type = 'button';
		option.className = 'agent-provider-option';
		option.dataset.providerId = providerId;

		const mark = dependencies.createElement('span');
		mark.className = 'agent-provider-mark';
		mark.textContent = AGENT_PROVIDER_MARK;
		mark.setAttribute('aria-hidden', 'true');

		const label = dependencies.createElement('span');
		label.className = 'agent-provider-option-label';
		label.textContent = AGENT_PROVIDER_LABELS[providerId];

		option.append(mark, label);
		option.addEventListener('click', () => callbacks.onProviderSelect(providerId));

		list.append(option);
	}

	panel.append(heading, list);
	container.replaceChildren(panel);
	container.hidden = true;

	return {
		render(snapshot): void {
			const activeTab = snapshot.tabs.find(
				(tab) => tab.id === snapshot.activeTabId,
			);
			const shouldShow = activeTab !== undefined
				&& activeTab.providerId === undefined;

			container.hidden = !shouldShow;
		},

		dispose(): void {
			container.hidden = true;
			container.replaceChildren();
		},
	};
}
