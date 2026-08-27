import { GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE } from './graphCamera';

/** 복구 경고 팝업에 표시할 하위 Detached Root 정보다. */
export interface GraphReattachDetachedNode {
	readonly rootId: string;
	readonly name: string;
	readonly relativePath?: string;
}

/** 하위 Detached Root를 함께 복구하기 전에 사용자에게 보여줄 내용이다. */
export interface GraphReattachConfirmRequest {
	readonly targetName: string;
	readonly detachedNodes: readonly GraphReattachDetachedNode[];
}

/** Graph 복구 경고 팝업의 확인 및 lifecycle 계약이다. */
export interface GraphReattachConfirmDialog {
	/** 경고와 하위 분리 목록을 표시하고 사용자 선택을 반환한다. */
	confirm(request: GraphReattachConfirmRequest): Promise<boolean>;
	/** 열린 팝업을 취소하고 생성한 DOM을 제거한다. */
	dispose(): void;
}

/** 복구 확인 버튼에 표시하는 고정 문구다. */
export const GRAPH_REATTACH_ACCEPT_LABEL = 'Reattach';

/** 복구 취소 버튼에 표시하는 고정 문구다. */
export const GRAPH_REATTACH_CANCEL_LABEL = 'Cancel';

/** 하위 분리 노드가 있는 복구 요청의 경고 제목이다. */
export const GRAPH_REATTACH_WARNING_TITLE = 'This root contains detached descendants';

/** Context 경로와 Node 이름을 목록 한 줄로 조합한다. */
function formatDetachedNodeLabel(node: GraphReattachDetachedNode): string {
	return `${node.relativePath ?? ''}${node.name}`;
}

/**
 * Graph Overlay 안에 하위 Detached Root 복구 경고 팝업을 만든다.
 * 별도 상태 저장 없이 열린 Promise 하나만 lifecycle 동안 유지한다.
 */
export function createGraphReattachConfirmDialog(
	host: HTMLElement,
): GraphReattachConfirmDialog {
	const ownerDocument = host.ownerDocument;
	const overlay = ownerDocument.createElement('div');
	const panel = ownerDocument.createElement('div');
	const title = ownerDocument.createElement('h2');
	const message = ownerDocument.createElement('p');
	const list = ownerDocument.createElement('ul');
	const actions = ownerDocument.createElement('div');
	const cancelButton = ownerDocument.createElement('button');
	const acceptButton = ownerDocument.createElement('button');
	let resolveActive: ((confirmed: boolean) => void) | undefined;
	let disposed = false;

	overlay.className = 'graph-reattach-confirm-overlay';
	overlay.hidden = true;
	overlay.setAttribute('role', 'alertdialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-label', GRAPH_REATTACH_WARNING_TITLE);
	overlay.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	panel.className = 'graph-reattach-confirm-panel';
	title.className = 'graph-reattach-confirm-title';
	title.textContent = GRAPH_REATTACH_WARNING_TITLE;
	message.className = 'graph-reattach-confirm-message';
	list.className = 'graph-reattach-confirm-list';
	actions.className = 'graph-reattach-confirm-actions';
	cancelButton.type = 'button';
	cancelButton.className = 'graph-reattach-confirm-cancel';
	cancelButton.textContent = GRAPH_REATTACH_CANCEL_LABEL;
	acceptButton.type = 'button';
	acceptButton.className = 'graph-reattach-confirm-accept';
	acceptButton.textContent = GRAPH_REATTACH_ACCEPT_LABEL;

	actions.append(cancelButton, acceptButton);
	panel.append(title, message, list, actions);
	overlay.append(panel);
	host.append(overlay);

	/** 대기 중인 선택을 마무리하고 팝업을 닫는다. */
	const settle = (confirmed: boolean): void => {
		const resolve = resolveActive;

		resolveActive = undefined;
		overlay.hidden = true;
		list.replaceChildren();
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
				|| request.detachedNodes.length === 0
			) {
				return Promise.resolve(false);
			}

			return new Promise<boolean>((resolve) => {
				resolveActive = resolve;
				message.textContent = `Reattaching “${request.targetName}” will also reattach these detached descendants.`;
				list.replaceChildren(...request.detachedNodes.map((node) => {
					const item = ownerDocument.createElement('li');

					item.className = 'graph-reattach-confirm-item';
					item.setAttribute('data-detached-root-id', node.rootId);
					item.textContent = formatDetachedNodeLabel(node);
					return item;
				}));
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
