import type { WorkspaceRootId } from '../protocol';
import type { WorkspaceRootCatalogEntry } from '../../workspace/workspaceRootCatalog';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

export const AGENT_WORKSPACE_PICKER_LABEL = 'Workspace';
export const AGENT_WORKSPACE_PICKER_PLACEHOLDER = 'Choose a workspace';

/** 활성 탭의 assignment lifecycle에서 Workspace 선택기가 필요한 최소 상태다. */
export interface AgentWorkspacePickerState {
	readonly selectedWorkspaceRootId: WorkspaceRootId | null;
	readonly locked: boolean;
	readonly pending: boolean;
	readonly resetting: boolean;
}

export interface AgentWorkspacePickerView {
	render(
		catalog: readonly WorkspaceRootCatalogEntry[],
		state: AgentWorkspacePickerState | undefined,
	): void;
	dispose(): void;
}

function describeUnavailable(entry: WorkspaceRootCatalogEntry): string {
	switch (entry.reason) {
		case 'workspace_untrusted':
			return 'Workspace is not trusted';
		case 'workspace_virtual_unsupported':
			return 'Virtual workspace is unsupported';
		case 'workspace_path_invalid':
			return 'Workspace path is invalid';
		case 'workspace_root_unavailable':
			return 'Workspace is no longer available';
		default:
			return 'Workspace is unavailable';
	}
}

/** 같은 이름의 root도 description으로 구별할 수 있는 option 표시 문자열을 만든다. */
export function formatWorkspaceOptionLabel(
	entry: WorkspaceRootCatalogEntry,
	includeDescription = false,
): string {
	const description = includeDescription ? ` — ${entry.description}` : '';
	const suffix = entry.selectable ? '' : ` (${describeUnavailable(entry)})`;
	return `${entry.name}${description}${suffix}`;
}

/** Agent 선택 card에 탭별 Workspace root 선택기를 만든다. */
export function initializeAgentWorkspacePicker(
	container: HTMLElement,
	onWorkspaceSelect: (workspaceRootId: WorkspaceRootId) => void,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentWorkspacePickerView {
	const label = dependencies.createElement('label');
	label.className = 'agent-workspace-picker-label';

	const labelText = dependencies.createElement('span');
	labelText.className = 'agent-workspace-picker-label-text';
	labelText.textContent = AGENT_WORKSPACE_PICKER_LABEL;

	const select = dependencies.createElement('select');
	select.className = 'agent-workspace-picker';
	select.setAttribute('aria-label', AGENT_WORKSPACE_PICKER_LABEL);
	select.addEventListener('change', () => {
		if (!select.disabled && select.value.startsWith('workspace-root:')) {
			onWorkspaceSelect(select.value as WorkspaceRootId);
		}
	});

	label.append(labelText, select);
	container.replaceChildren(label);

	return {
		render(catalog, state): void {
			const nameCounts = new Map<string, number>();
			for (const entry of catalog) {
				nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
			}

			const placeholder = dependencies.createElement('option');
			placeholder.value = '';
			placeholder.textContent = AGENT_WORKSPACE_PICKER_PLACEHOLDER;
			placeholder.disabled = true;

			const options = catalog.map((entry) => {
				const option = dependencies.createElement('option');
				option.value = entry.id;
				option.textContent = formatWorkspaceOptionLabel(
					entry,
					(nameCounts.get(entry.name) ?? 0) > 1,
				);
				option.title = entry.description;
				option.setAttribute(
					'aria-label',
					`${entry.name}, ${entry.description}`,
				);
				option.disabled = !entry.selectable;
				option.dataset.workspaceRootId = entry.id;
				option.dataset.selectable = String(entry.selectable);
				if (entry.reason !== undefined) {
					option.dataset.reason = entry.reason;
				}
				return option;
			});

			select.replaceChildren(placeholder, ...options);
			select.value = state?.selectedWorkspaceRootId ?? '';
			select.disabled = state === undefined
				|| state.locked
				|| state.pending
				|| state.resetting;

			const selected = catalog.find(
				(entry) => entry.id === state?.selectedWorkspaceRootId,
			);
			const accessibleName = selected === undefined
				? AGENT_WORKSPACE_PICKER_LABEL
				: `${AGENT_WORKSPACE_PICKER_LABEL}: ${selected.name}, ${selected.description}`;
			select.title = selected?.description ?? AGENT_WORKSPACE_PICKER_PLACEHOLDER;
			select.setAttribute('aria-label', accessibleName);
			select.setAttribute('aria-busy', state?.pending || state?.resetting ? 'true' : 'false');
		},

		dispose(): void {
			container.replaceChildren();
		},
	};
}
