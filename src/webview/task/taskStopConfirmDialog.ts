import { GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE } from '../graph/graphCamera';

/** 실행 중 Task를 강제 종료하기 전에 표시할 현재 Agent 작업 정보다. */
export interface TaskStopConfirmRequest {
	readonly taskTitle: string;
	readonly workCount: number;
}

/** Task 강제 종료 확인 팝업의 interaction과 lifecycle 계약이다. */
export interface TaskStopConfirmDialog {
	/** 확인 팝업을 표시하고 사용자 선택을 반환한다. */
	confirm(request: TaskStopConfirmRequest): Promise<boolean>;
	/** 열린 팝업을 취소하고 생성한 DOM을 제거한다. */
	dispose(): void;
}

export const TASK_STOP_CONFIRM_TITLE = 'Force stop this task?';
export const TASK_STOP_ACCEPT_LABEL = 'Force Stop';
export const TASK_STOP_CANCEL_LABEL = 'Cancel';

/** Graph Overlay 안에 실행 중 Task 전용 강제 종료 확인 팝업을 만든다. */
export function createTaskStopConfirmDialog(
	host: HTMLElement,
): TaskStopConfirmDialog {
	const ownerDocument = host.ownerDocument;
	const overlay = ownerDocument.createElement('div');
	const panel = ownerDocument.createElement('div');
	const title = ownerDocument.createElement('h2');
	const message = ownerDocument.createElement('p');
	const actions = ownerDocument.createElement('div');
	const cancelButton = ownerDocument.createElement('button');
	const acceptButton = ownerDocument.createElement('button');
	let resolveActive: ((confirmed: boolean) => void) | undefined;
	let disposed = false;

	overlay.className = 'task-stop-confirm-overlay';
	overlay.hidden = true;
	overlay.setAttribute('role', 'alertdialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-label', TASK_STOP_CONFIRM_TITLE);
	overlay.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	panel.className = 'task-stop-confirm-panel';
	title.className = 'task-stop-confirm-title';
	title.textContent = TASK_STOP_CONFIRM_TITLE;
	message.className = 'task-stop-confirm-message';
	actions.className = 'task-stop-confirm-actions';
	cancelButton.type = 'button';
	cancelButton.className = 'task-stop-confirm-cancel';
	cancelButton.textContent = TASK_STOP_CANCEL_LABEL;
	acceptButton.type = 'button';
	acceptButton.className = 'task-stop-confirm-accept';
	acceptButton.textContent = TASK_STOP_ACCEPT_LABEL;

	actions.append(cancelButton, acceptButton);
	panel.append(title, message, actions);
	overlay.append(panel);
	host.append(overlay);

	const settle = (confirmed: boolean): void => {
		const resolve = resolveActive;

		resolveActive = undefined;
		overlay.hidden = true;
		resolve?.(confirmed);
	};

	cancelButton.addEventListener('click', () => settle(false));
	acceptButton.addEventListener('click', () => settle(true));
	overlay.addEventListener('keydown', (event) => {
		if ((event as KeyboardEvent).key === 'Escape') {
			event.preventDefault();
			settle(false);
		}
	});

	return {
		confirm(request): Promise<boolean> {
			if (
				disposed
				|| resolveActive !== undefined
				|| request.workCount < 1
			) {
				return Promise.resolve(false);
			}

			return new Promise<boolean>((resolve) => {
				resolveActive = resolve;
				message.textContent = `Stop ${request.workCount} Agent work session(s) assigned to “${request.taskTitle}” and close their tabs.`;
				overlay.hidden = false;
				acceptButton.focus?.();
			});
		},

		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			settle(false);
			overlay.remove();
		},
	};
}
