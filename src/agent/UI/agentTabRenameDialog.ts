import type { AgentTabId, RenameAgentTabResult } from './agentTabModel';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

export const AGENT_TAB_RENAME_EMPTY_ERROR = '이름을 입력해주세요.';
export const AGENT_TAB_RENAME_LENGTH_ERROR = '40자 이하로 입력해주세요.';
export const AGENT_TAB_RENAME_DUPLICATE_ERROR = '이미 사용 중인 이름입니다.';

export interface AgentTabRenameDialog {
	open(
		tabId: AgentTabId,
		currentName: string,
		onSave: (value: string) => RenameAgentTabResult,
		onClosed: () => void,
	): void;
	syncTabs(tabIds: readonly AgentTabId[]): void;
	dispose(): void;
}

/** 수동 이름 변경과 검증 오류를 Agent Panel 안에 표시한다. */
export function createAgentTabRenameDialog(
	host: HTMLElement,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentTabRenameDialog {
	let targetTabId: AgentTabId | undefined;
	let closeCallback: (() => void) | undefined;
	let saveCallback: ((value: string) => RenameAgentTabResult) | undefined;
	let disposed = false;

	const panel = dependencies.createElement('div');
	panel.className = 'agent-tab-rename-panel';
	panel.setAttribute('role', 'document');

	const heading = dependencies.createElement('p');
	heading.className = 'agent-tab-rename-title';
	heading.textContent = '탭 이름 변경';

	const input = dependencies.createElement('input');
	input.type = 'text';
	input.className = 'agent-tab-rename-input';
	input.setAttribute('aria-label', '새 탭 이름');
	input.setAttribute('aria-describedby', 'agent-tab-rename-error');

	const error = dependencies.createElement('p');
	error.className = 'agent-tab-rename-error';
	error.setAttribute('id', 'agent-tab-rename-error');
	error.setAttribute('aria-live', 'polite');

	const actions = dependencies.createElement('div');
	actions.className = 'agent-tab-rename-actions';

	const cancelButton = dependencies.createElement('button');
	cancelButton.type = 'button';
	cancelButton.className = 'agent-tab-rename-cancel';
	cancelButton.textContent = '취소';
	cancelButton.setAttribute('aria-label', '탭 이름 변경 취소');

	const saveButton = dependencies.createElement('button');
	saveButton.type = 'button';
	saveButton.className = 'agent-tab-rename-save';
	saveButton.textContent = '저장';
	saveButton.setAttribute('aria-label', '탭 이름 저장');

	actions.append(cancelButton, saveButton);
	panel.append(heading, input, error, actions);

	const close = (restoreFocus = true): void => {
		const onClosed = closeCallback;
		targetTabId = undefined;
		closeCallback = undefined;
		saveCallback = undefined;
		error.textContent = '';
		try {
			host.hidden = true;
			host.replaceChildren();
			host.removeAttribute('role');
			host.removeAttribute('aria-label');
		} catch {
			/** 다이얼로그 제거 실패가 이름 상태로 전파되지 않게 한다. */
		}
		if (restoreFocus) {
			try {
				onClosed?.();
			} catch {
				/** 원래 탭 focus 복귀 실패는 저장 결과를 바꾸지 않는다. */
			}
		}
	};

	const save = (): void => {
		const result = saveCallback?.(input.value);
		if (result?.ok === true) {
			close();
			return;
		}

		error.textContent = result?.error === 'tooLong'
			? AGENT_TAB_RENAME_LENGTH_ERROR
			: result?.error === 'duplicate'
				? AGENT_TAB_RENAME_DUPLICATE_ERROR
				: AGENT_TAB_RENAME_EMPTY_ERROR;
		input.focus();
	};

	cancelButton.addEventListener('click', () => close());
	saveButton.addEventListener('click', save);
	input.addEventListener('input', () => {
		error.textContent = '';
	});
	panel.addEventListener('keydown', (event) => {
		const keyboardEvent = event as KeyboardEvent;
		if (keyboardEvent.key === 'Escape') {
			keyboardEvent.preventDefault();
			close();
			return;
		}
		if (keyboardEvent.key === 'Enter') {
			keyboardEvent.preventDefault();
			save();
			return;
		}
		if (keyboardEvent.key !== 'Tab') {
			return;
		}

		const focusable: HTMLElement[] = [input, cancelButton, saveButton];
		const current = dependencies.getActiveElement() as HTMLElement | null;
		const currentIndex = Math.max(0, focusable.indexOf(current ?? input));
		const nextIndex = keyboardEvent.shiftKey
			? (currentIndex - 1 + focusable.length) % focusable.length
			: (currentIndex + 1) % focusable.length;
		keyboardEvent.preventDefault();
		focusable[nextIndex].focus();
	});

	const removeFocusListener = dependencies.addDocumentListener('focusin', (event) => {
		if (
			targetTabId !== undefined
			&& !panel.contains(event.target as Node | null)
		) {
			input.focus();
		}
	});

	host.hidden = true;

	return {
		open(tabId, currentName, onSave, onClosed): void {
			if (disposed || targetTabId !== undefined) {
				return;
			}

			targetTabId = tabId;
			saveCallback = onSave;
			closeCallback = onClosed;
			input.value = currentName;
			error.textContent = '';
			try {
				host.replaceChildren(panel);
				host.setAttribute('role', 'dialog');
				host.setAttribute('aria-label', '탭 이름 변경');
				host.hidden = false;
				input.focus();
				input.select();
			} catch {
				close();
			}
		},

		syncTabs(tabIds): void {
			if (targetTabId !== undefined && !tabIds.includes(targetTabId)) {
				close(false);
			}
		},

		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			close(false);
			removeFocusListener();
		},
	};
}
