import {
	PROVIDER_IDS,
	type ProviderId,
	type WorkspaceRootId,
} from '../protocol';
import type { WorkspaceRootCatalogEntry } from '../../workspace/workspaceRootCatalog';
import { AGENT_PROVIDER_LABELS } from './agentProviders';
import type { AgentTabModelSnapshot } from './agentTabModel';
import {
	initializeAgentWorkspacePicker,
	type AgentWorkspacePickerState,
} from './agentWorkspacePicker';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

/** 중앙 provider 선택기의 제목과 안내 문구다. */
export const AGENT_PROVIDER_PICKER_TITLE = 'Choose an agent';
export const AGENT_PROVIDER_PICKER_DESCRIPTION =
	'Select a CLI to start this terminal';

/** 공식 로고가 없는 CLI 항목에 쓰는 기존 터미널 표식이다. */
export const AGENT_PROVIDER_MARK = '>_';

/** 공식 provider 로고를 로컬 Webview asset 선택자와 연결한다. */
export const AGENT_PROVIDER_LOGOS: Readonly<
	Partial<Record<ProviderId, 'openai' | 'claude'>>
> = Object.freeze({
	codex: 'openai',
	claude: 'claude',
});

/** 중앙 선택기가 상위 계층으로 전달하는 사용자 동작이다. */
export interface AgentProviderPickerCallbacks {
	/** 목록에서 provider를 고른 경우다. */
	onProviderSelect(providerId: ProviderId): void;

	/** Agent를 시작할 Workspace root를 고른 경우다. */
	onWorkspaceSelect(workspaceRootId: WorkspaceRootId): void;
}

export interface AgentProviderPickerState extends AgentWorkspacePickerState {
	readonly workspaceSelected: boolean;
	readonly forceShow?: boolean;
}

/** 중앙 선택기를 탭 상태에 맞춰 갱신하는 표시 경계다. */
export interface AgentProviderPickerView {
	/** 활성 탭이 provider 미선택 상태일 때만 선택기를 표시한다. */
	render(
		snapshot: AgentTabModelSnapshot,
		workspaceCatalog?: readonly WorkspaceRootCatalogEntry[],
		state?: AgentProviderPickerState,
	): void;

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
	const headingCopy = dependencies.createElement('div');
	headingCopy.className = 'agent-provider-picker-heading-copy';

	const title = dependencies.createElement('p');
	title.className = 'agent-provider-picker-title';
	title.textContent = AGENT_PROVIDER_PICKER_TITLE;

	const description = dependencies.createElement('p');
	description.className = 'agent-provider-picker-description';
	description.textContent = AGENT_PROVIDER_PICKER_DESCRIPTION;
	headingCopy.append(title, description);

	const workspacePickerHost = dependencies.createElement('div');
	workspacePickerHost.className = 'agent-workspace-picker-host';
	const workspacePicker = initializeAgentWorkspacePicker(
		workspacePickerHost,
		callbacks.onWorkspaceSelect,
		dependencies,
	);
	heading.append(headingCopy, workspacePickerHost);

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
		mark.setAttribute('aria-hidden', 'true');
		const providerLogo = AGENT_PROVIDER_LOGOS[providerId];
		if (providerLogo === undefined) {
			mark.textContent = AGENT_PROVIDER_MARK;
		} else {
			const logo = dependencies.createElement('span');
			logo.className = 'agent-provider-logo';
			logo.dataset.providerLogo = providerLogo;
			mark.append(logo);
		}

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
		render(snapshot, workspaceCatalog = [], state): void {
			const activeTab = snapshot.tabs.find(
				(tab) => tab.id === snapshot.activeTabId,
			);
			const shouldShow = activeTab !== undefined
				&& (
					activeTab.providerId === undefined
					|| state?.forceShow === true
				);

			container.hidden = !shouldShow;
			workspacePicker.render(workspaceCatalog, state);
			panel.setAttribute(
				'aria-busy',
				state?.pending || state?.resetting ? 'true' : 'false',
			);
			for (const option of Array.from(list.children)) {
				(option as HTMLButtonElement).disabled = state === undefined
					|| !state.workspaceSelected
					|| state.pending
					|| state.resetting;
			}
		},

		dispose(): void {
			workspacePicker.dispose();
			container.hidden = true;
			container.replaceChildren();
		},
	};
}
