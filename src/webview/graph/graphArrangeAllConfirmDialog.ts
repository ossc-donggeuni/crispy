import { GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE } from './graphCamera';

/** Graph 전체 정렬 확인 팝업의 interaction과 lifecycle 계약이다. */
export interface GraphArrangeAllConfirmDialog {
	/** 확인 팝업을 표시하고 사용자 선택을 반환한다. */
	confirm(): Promise<boolean>;
	/** 열린 팝업을 취소하고 생성한 DOM을 제거한다. */
	dispose(): void;
}

export const GRAPH_ARRANGE_ALL_CONFIRM_TITLE = '그래프를 전부 정렬하시겠습니까?';
export const GRAPH_ARRANGE_ALL_CONFIRM_MESSAGE = '분리된 노드와 미정렬 상태의 노드들이 정렬됩니다.';
export const GRAPH_ARRANGE_ALL_ACCEPT_LABEL = '확인';
export const GRAPH_ARRANGE_ALL_CANCEL_LABEL = '취소';

/** Graph Overlay 안에 전체 정렬 전용 확인 팝업을 만든다. */
export function createGraphArrangeAllConfirmDialog(
	host: HTMLElement,
): GraphArrangeAllConfirmDialog {
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

	overlay.className = 'graph-arrange-all-confirm-overlay';
	overlay.hidden = true;
	overlay.setAttribute('role', 'alertdialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-label', GRAPH_ARRANGE_ALL_CONFIRM_TITLE);
	overlay.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	panel.className = 'graph-arrange-all-confirm-panel';
	title.className = 'graph-arrange-all-confirm-title';
	title.textContent = GRAPH_ARRANGE_ALL_CONFIRM_TITLE;
	message.className = 'graph-arrange-all-confirm-message';
	message.textContent = GRAPH_ARRANGE_ALL_CONFIRM_MESSAGE;
	actions.className = 'graph-arrange-all-confirm-actions';
	cancelButton.type = 'button';
	cancelButton.className = 'graph-arrange-all-confirm-cancel';
	cancelButton.textContent = GRAPH_ARRANGE_ALL_CANCEL_LABEL;
	acceptButton.type = 'button';
	acceptButton.className = 'graph-arrange-all-confirm-accept';
	acceptButton.textContent = GRAPH_ARRANGE_ALL_ACCEPT_LABEL;

	actions.append(cancelButton, acceptButton);
	panel.append(title, message, actions);
	overlay.append(panel);
	host.append(overlay);

	/** 대기 중인 선택을 마무리하고 팝업을 닫는다. */
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
		confirm(): Promise<boolean> {
			if (disposed || resolveActive !== undefined) {
				return Promise.resolve(false);
			}

			return new Promise<boolean>((resolve) => {
				resolveActive = resolve;
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
