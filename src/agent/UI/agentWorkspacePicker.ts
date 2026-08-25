import type { WorkspaceRootId } from '../protocol';
import type { WorkspaceRootCatalogEntry } from '../../workspace/workspaceRootCatalog';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

export const AGENT_WORKSPACE_PICKER_LABEL = 'Workspace';
export const AGENT_WORKSPACE_PICKER_PLACEHOLDER = 'Choose a workspace';

let nextWorkspacePickerId = 0;

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
	const pickerId = ++nextWorkspacePickerId;
	const listboxId = `agent-workspace-picker-listbox-${pickerId}`;
	const optionId = (index: number): string =>
		`agent-workspace-picker-option-${pickerId}-${index}`;

	const label = dependencies.createElement('div');
	label.className = 'agent-workspace-picker-label';

	const labelText = dependencies.createElement('span');
	labelText.className = 'agent-workspace-picker-label-text';
	labelText.textContent = AGENT_WORKSPACE_PICKER_LABEL;

	const picker = dependencies.createElement('button');
	picker.type = 'button';
	picker.className = 'agent-workspace-picker';
	picker.setAttribute('role', 'combobox');
	picker.setAttribute('aria-haspopup', 'listbox');
	picker.setAttribute('aria-controls', listboxId);
	picker.setAttribute('aria-expanded', 'false');
	picker.setAttribute('aria-label', AGENT_WORKSPACE_PICKER_LABEL);

	const value = dependencies.createElement('span');
	value.className = 'agent-workspace-picker-value';
	value.textContent = AGENT_WORKSPACE_PICKER_PLACEHOLDER;

	const indicator = dependencies.createElement('span');
	indicator.className = 'agent-workspace-picker-indicator';
	indicator.textContent = '\u25be';
	indicator.setAttribute('aria-hidden', 'true');

	const listbox = dependencies.createElement('div');
	listbox.setAttribute('id', listboxId);
	listbox.className = 'agent-workspace-picker-listbox';
	listbox.setAttribute('role', 'listbox');
	listbox.setAttribute('aria-label', `${AGENT_WORKSPACE_PICKER_LABEL} options`);
	listbox.hidden = true;

	picker.append(value, indicator);
	label.append(labelText, picker, listbox);
	container.replaceChildren(label);

	let entries: readonly WorkspaceRootCatalogEntry[] = [];
	let options: HTMLElement[] = [];
	let selectedWorkspaceRootId: WorkspaceRootId | null = null;
	let activeIndex: number | undefined;
	let open = false;
	let disposed = false;

	const setOpen = (nextOpen: boolean, restoreFocus = false): void => {
		open = nextOpen && !picker.disabled && options.length > 0;
		listbox.hidden = !open;
		picker.setAttribute('aria-expanded', open ? 'true' : 'false');
		label.dataset.open = String(open);
		if (!open) {
			activeIndex = undefined;
			picker.removeAttribute('aria-activedescendant');
			for (const option of options) {
				option.dataset.active = 'false';
			}
			if (restoreFocus) {
				picker.focus();
			}
		}
	};

	const setActiveIndex = (index: number | undefined): void => {
		activeIndex = index;
		for (const [optionIndex, option] of options.entries()) {
			option.dataset.active = String(optionIndex === index);
		}
		if (index === undefined) {
			picker.removeAttribute('aria-activedescendant');
			return;
		}
		picker.setAttribute('aria-activedescendant', optionId(index));
	};

	const selectableIndexes = (): number[] => entries.flatMap((entry, index) =>
		entry.selectable ? [index] : []
	);

	const openList = (preferred: 'selected' | 'first' | 'last'): void => {
		if (picker.disabled || options.length === 0) {
			return;
		}

		setOpen(true);
		const selectable = selectableIndexes();
		if (selectable.length === 0) {
			setActiveIndex(undefined);
			return;
		}

		const selectedIndex = entries.findIndex(
			(entry) => entry.id === selectedWorkspaceRootId && entry.selectable,
		);
		if (preferred === 'selected' && selectedIndex >= 0) {
			setActiveIndex(selectedIndex);
		} else if (preferred === 'last') {
			setActiveIndex(selectable[selectable.length - 1]);
		} else {
			setActiveIndex(selectable[0]);
		}
		picker.focus();
	};

	const moveActive = (direction: -1 | 1): void => {
		const selectable = selectableIndexes();
		if (selectable.length === 0) {
			setActiveIndex(undefined);
			return;
		}

		const currentPosition = activeIndex === undefined
			? -1
			: selectable.indexOf(activeIndex);
		const nextPosition = currentPosition < 0
			? direction > 0 ? 0 : selectable.length - 1
			: (currentPosition + direction + selectable.length) % selectable.length;
		setActiveIndex(selectable[nextPosition]);
	};

	const updateSelectedPresentation = (
		workspaceRootId: WorkspaceRootId | null,
	): void => {
		selectedWorkspaceRootId = workspaceRootId;
		picker.value = workspaceRootId ?? '';
		const selected = entries.find((entry) => entry.id === workspaceRootId);
		value.textContent = selected?.name ?? AGENT_WORKSPACE_PICKER_PLACEHOLDER;
		value.dataset.placeholder = String(selected === undefined);
		picker.title = selected?.description ?? AGENT_WORKSPACE_PICKER_PLACEHOLDER;
		picker.setAttribute(
			'aria-label',
			selected === undefined
				? AGENT_WORKSPACE_PICKER_LABEL
				: `${AGENT_WORKSPACE_PICKER_LABEL}: ${selected.name}, ${selected.description}`,
		);
		for (const [index, option] of options.entries()) {
			option.setAttribute(
				'aria-selected',
				entries[index]?.id === workspaceRootId ? 'true' : 'false',
			);
		}
	};

	const selectIndex = (index: number): void => {
		const entry = entries[index];
		if (picker.disabled || entry === undefined || !entry.selectable) {
			return;
		}

		updateSelectedPresentation(entry.id);
		setOpen(false, true);
		onWorkspaceSelect(entry.id);
	};

	picker.addEventListener('click', () => {
		if (open) {
			setOpen(false);
		} else {
			openList('selected');
		}
	});
	picker.addEventListener('keydown', (event) => {
		const keyboardEvent = event as KeyboardEvent;
		switch (keyboardEvent.key) {
			case 'ArrowDown':
				keyboardEvent.preventDefault();
				if (open) {
					moveActive(1);
				} else {
					openList('selected');
				}
				return;
			case 'ArrowUp':
				keyboardEvent.preventDefault();
				if (open) {
					moveActive(-1);
				} else {
					openList(selectedWorkspaceRootId === null ? 'last' : 'selected');
				}
				return;
			case 'Home':
			case 'End':
				if (!open) {
					return;
				}
				keyboardEvent.preventDefault();
				openList(keyboardEvent.key === 'Home' ? 'first' : 'last');
				return;
			case 'Enter':
			case ' ':
				keyboardEvent.preventDefault();
				if (!open) {
					openList('selected');
				} else if (activeIndex !== undefined) {
					selectIndex(activeIndex);
				}
				return;
			case 'Escape':
				if (open) {
					keyboardEvent.preventDefault();
					setOpen(false, true);
				}
				return;
			case 'Tab':
				setOpen(false);
				return;
			default:
				return;
		}
	});
	/* 기존 테스트 및 host adapter가 dispatch하는 select-like change도 계속 받는다. */
	picker.addEventListener('change', () => {
		const index = entries.findIndex((entry) => entry.id === picker.value);
		if (index >= 0) {
			selectIndex(index);
		}
	});

	const removePointerListener = dependencies.addDocumentListener(
		'pointerdown',
		(event) => {
			if (open && !label.contains(event.target as Node | null)) {
				setOpen(false);
			}
		},
	);

	return {
		render(catalog, state): void {
			if (disposed) {
				return;
			}
			setOpen(false);
			entries = catalog;
			const nameCounts = new Map<string, number>();
			for (const entry of catalog) {
				nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
			}

			options = catalog.map((entry, index) => {
				const option = dependencies.createElement('div');
				option.setAttribute('id', optionId(index));
				option.className = 'agent-workspace-picker-option';
				option.setAttribute('role', 'option');
				option.tabIndex = -1;
				option.title = entry.description;
				option.setAttribute(
					'aria-label',
					`${entry.name}, ${entry.description}${
						entry.selectable ? '' : `, ${describeUnavailable(entry)}`
					}`,
				);
				option.setAttribute('aria-disabled', entry.selectable ? 'false' : 'true');
				option.dataset.workspaceRootId = entry.id;
				option.dataset.selectable = String(entry.selectable);
				option.dataset.active = 'false';
				if (entry.reason !== undefined) {
					option.dataset.reason = entry.reason;
				}

				const optionName = dependencies.createElement('span');
				optionName.className = 'agent-workspace-picker-option-name';
				optionName.textContent = entry.selectable
					? entry.name
					: `${entry.name} (${describeUnavailable(entry)})`;

				const optionDescription = dependencies.createElement('span');
				optionDescription.className = 'agent-workspace-picker-option-description';
				optionDescription.textContent = entry.description;
				optionDescription.title = entry.description;

				option.dataset.label = formatWorkspaceOptionLabel(
					entry,
					(nameCounts.get(entry.name) ?? 0) > 1,
				);
				option.append(optionName, optionDescription);
				option.addEventListener('pointermove', () => {
					if (open && entry.selectable) {
						setActiveIndex(index);
					}
				});
				option.addEventListener('click', () => selectIndex(index));
				return option;
			});

			listbox.replaceChildren(...options);
			picker.disabled = state === undefined
				|| state.locked
				|| state.pending
				|| state.resetting
				|| catalog.length === 0;
			picker.setAttribute('aria-disabled', picker.disabled ? 'true' : 'false');
			picker.setAttribute(
				'aria-busy',
				state?.pending || state?.resetting ? 'true' : 'false',
			);
			updateSelectedPresentation(state?.selectedWorkspaceRootId ?? null);
		},

		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			setOpen(false);
			removePointerListener();
			container.replaceChildren();
		},
	};
}
