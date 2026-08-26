import { GRAPH_CAMERA_IGNORE_ATTRIBUTE } from '../graph/graphCamera';

/** Task Import 팝업 root를 식별하는 DOM attribute다. */
export const TASK_IMPORT_DIALOG_ATTRIBUTE = 'data-task-import-dialog';
/** Task JSON 입력 textarea를 식별하는 DOM attribute다. */
export const TASK_IMPORT_INPUT_ATTRIBUTE = 'data-task-import-input';
/** Task Import 검증 오류를 식별하는 DOM attribute다. */
export const TASK_IMPORT_ERROR_ATTRIBUTE = 'data-task-import-error';

export const TASK_IMPORT_DIALOG_TITLE = 'Task JSON 가져오기';
export const TASK_IMPORT_ACCEPT_LABEL = '가져오기';
export const TASK_IMPORT_CANCEL_LABEL = '취소';

/** 팝업 submit이 Task 상태를 commit했는지 또는 표시할 오류가 있는지 나타낸다. */
export type TaskImportSubmitResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly message: string };

/** Task JSON을 검증하고 원자적으로 적용하는 GraphView callback이다. */
export interface TaskImportDialogRequest {
	readonly taskTitle: string;
	onSubmit(source: string): TaskImportSubmitResult;
	/** 팝업이 정상적으로 닫힌 뒤 최신 호출 UI에 focus를 복원한다. */
	restoreFocus?: () => void;
}

/** Graph Overlay에 마운트하는 Task Import 팝업 lifecycle이다. */
export interface TaskImportDialog {
	/** 닫혀 있을 때만 Task JSON 입력 팝업을 연다. */
	open(request: TaskImportDialogRequest): boolean;
	/** 열린 팝업을 닫고 입력과 오류를 정리한다. */
	close(): void;
	/** listener와 생성한 DOM을 정리한다. */
	dispose(): void;
}

/** Graph Overlay 안에 textarea와 inline validation을 가진 Task Import 팝업을 만든다. */
export function createTaskImportDialog(host: HTMLElement): TaskImportDialog {
	const ownerDocument = host.ownerDocument;
	const overlay = ownerDocument.createElement('div');
	const panel = ownerDocument.createElement('div');
	const title = ownerDocument.createElement('h2');
	const message = ownerDocument.createElement('p');
	const input = ownerDocument.createElement('textarea');
	const error = ownerDocument.createElement('p');
	const actions = ownerDocument.createElement('div');
	const cancelButton = ownerDocument.createElement('button');
	const acceptButton = ownerDocument.createElement('button');
	let activeRequest: TaskImportDialogRequest | undefined;
	let disposed = false;

	overlay.className = 'task-import-dialog-overlay';
	overlay.hidden = true;
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-label', TASK_IMPORT_DIALOG_TITLE);
	overlay.setAttribute(TASK_IMPORT_DIALOG_ATTRIBUTE, '');
	overlay.setAttribute(GRAPH_CAMERA_IGNORE_ATTRIBUTE, '');
	panel.className = 'task-import-dialog-panel';
	title.className = 'task-import-dialog-title';
	title.textContent = TASK_IMPORT_DIALOG_TITLE;
	message.className = 'task-import-dialog-message';
	input.className = 'task-import-dialog-input';
	input.placeholder = 'Task JSON을 붙여넣으세요.';
	input.spellcheck = false;
	input.setAttribute('aria-label', 'Task JSON');
	input.setAttribute(TASK_IMPORT_INPUT_ATTRIBUTE, '');
	error.className = 'task-import-dialog-error';
	error.hidden = true;
	error.setAttribute('role', 'alert');
	error.setAttribute('aria-live', 'polite');
	error.setAttribute(TASK_IMPORT_ERROR_ATTRIBUTE, '');
	actions.className = 'task-import-dialog-actions';
	cancelButton.type = 'button';
	cancelButton.className = 'task-import-dialog-cancel';
	cancelButton.textContent = TASK_IMPORT_CANCEL_LABEL;
	acceptButton.type = 'button';
	acceptButton.className = 'task-import-dialog-accept';
	acceptButton.textContent = TASK_IMPORT_ACCEPT_LABEL;

	actions.append(cancelButton, acceptButton);
	panel.append(title, message, input, error, actions);
	overlay.append(panel);
	host.append(overlay);

	const clearError = (): void => {
		error.textContent = '';
		error.hidden = true;
		input.removeAttribute('aria-invalid');
	};
	const reset = (): void => {
		activeRequest = undefined;
		overlay.hidden = true;
		input.value = '';
		clearError();
	};
	const close = (): void => {
		const request = activeRequest;

		reset();
		try {
			request?.restoreFocus?.();
		} catch {
			// Focus 복원 실패는 이미 완료된 dialog close를 되돌리지 않는다.
		}
	};
	const submit = (): void => {
		if (!activeRequest) {
			return;
		}
		const result = activeRequest.onSubmit(input.value);

		if (result.ok) {
			close();
			return;
		}

		error.textContent = result.message;
		error.hidden = false;
		input.setAttribute('aria-invalid', 'true');
		input.focus();
	};
	const handleInput = (): void => {
		if (!error.hidden) {
			clearError();
		}
	};
	const stopInteractionPropagation = (event: Event): void => {
		event.stopPropagation();
	};
	const handleKeyDown = (event: KeyboardEvent): void => {
		if (!activeRequest) {
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			close();
			return;
		}
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			submit();
			return;
		}
		if (
			event.key === 'Tab'
			&& event.shiftKey
			&& ownerDocument.activeElement === input
		) {
			event.preventDefault();
			acceptButton.focus();
			return;
		}
		if (
			event.key === 'Tab'
			&& !event.shiftKey
			&& ownerDocument.activeElement === acceptButton
		) {
			event.preventDefault();
			input.focus();
		}
	};

	cancelButton.addEventListener('click', close);
	acceptButton.addEventListener('click', submit);
	input.addEventListener('input', handleInput);
	overlay.addEventListener('pointerdown', stopInteractionPropagation);
	overlay.addEventListener('click', stopInteractionPropagation);
	overlay.addEventListener('keydown', handleKeyDown);

	return {
		open(request): boolean {
			if (disposed || activeRequest) {
				return false;
			}

			activeRequest = request;
			message.textContent = `“${request.taskTitle}”의 현재 내용을 입력한 JSON으로 교체합니다.`;
			overlay.hidden = false;
			input.focus();
			return true;
		},

		close,

		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			reset();
			cancelButton.removeEventListener('click', close);
			acceptButton.removeEventListener('click', submit);
			input.removeEventListener('input', handleInput);
			overlay.removeEventListener('pointerdown', stopInteractionPropagation);
			overlay.removeEventListener('click', stopInteractionPropagation);
			overlay.removeEventListener('keydown', handleKeyDown);
			overlay.remove();
		},
	};
}
