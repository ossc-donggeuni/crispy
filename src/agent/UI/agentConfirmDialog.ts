import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

/** 확인 버튼에 표시하는 고정 문구다. */
export const AGENT_CONFIRM_ACCEPT_LABEL = 'Close';

/** 취소 버튼에 표시하는 고정 문구다. */
export const AGENT_CONFIRM_CANCEL_LABEL = 'Cancel';

/** 재시작 확인 요청에 사용하는 확인 버튼 문구다. */
export const AGENT_RESTART_ACCEPT_LABEL = 'Restart';
export const MCP_RESTART_ACCEPT_LABEL = 'MCP와 Agent 다시 시작';

/**
 * 탭 닫기 확인 문구를 만든다.
 * 이 단계에서는 프로세스 실행 여부를 알 수 없으므로 항상 같은 문구를 사용한다.
 *
 * @param tabLabel 닫으려는 탭의 표시 라벨
 * @returns 확인 다이얼로그에 표시할 문구
 */
export function formatTabCloseConfirmMessage(tabLabel: string): string {
	return `Close ${tabLabel}?`;
}

/**
 * 현재 CLI 세션을 종료하고 다시 시작하기 전에 표시할 문구를 만든다.
 *
 * @param tabLabel 재시작할 탭의 표시 라벨
 * @returns 현재 세션 종료 영향을 밝히는 확인 문구
 */
export function formatSessionRestartConfirmMessage(tabLabel: string): string {
	return `Restart ${tabLabel}? The current CLI session will be terminated and you'll return to agent selection.`;
}

/** 현재 Agent 대화 종료와 fresh MCP/CLI session 생성을 명확히 알리는 고정 문구다. */
export function formatMcpRestartConfirmMessage(): string {
	return 'MCP와 Agent를 다시 시작하면 이 탭에서 실행 중인 Agent와 현재 CLI 대화가 종료됩니다. 새 MCP 연결과 새 Agent 세션으로 다시 시작하시겠습니까?';
}

/** 탭 닫기처럼 되돌릴 수 없는 동작 전에 사용자 확인을 받는 경계다. */
export interface AgentConfirmDialog {
	/**
	 * 확인 다이얼로그를 표시하고 사용자의 선택을 반환한다.
	 * 이미 다이얼로그가 열려 있으면 새 요청은 취소로 처리한다.
	 */
	confirm(message: string, acceptLabel?: string): Promise<boolean>;

	/** 열려 있는 다이얼로그를 닫고 대기 중인 요청을 취소로 마무리한다. */
	dispose(): void;
}

/**
 * Webview 안에서만 동작하는 확인 다이얼로그를 만든다.
 *
 * VS Code Webview는 `window.confirm`을 사용할 수 없으므로 DOM 요소로 직접 구성한다.
 * 다이얼로그는 주어진 host 요소 안에서만 렌더링되어 Graph, Dock, Layout 영역에
 * 영향을 주지 않는다.
 *
 * @param host 다이얼로그를 렌더링할 Agent 영역 안의 컨테이너
 * @param dependencies DOM 생성 의존성
 * @returns 확인 요청과 정리를 제공하는 다이얼로그 객체
 */
export function createAgentConfirmDialog(
	host: HTMLElement,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentConfirmDialog {
	let resolveActive: ((confirmed: boolean) => void) | undefined;
	let disposed = false;

	const panel = dependencies.createElement('div');
	panel.className = 'agent-confirm-panel';

	const messageElement = dependencies.createElement('p');
	messageElement.className = 'agent-confirm-message';

	const actions = dependencies.createElement('div');
	actions.className = 'agent-confirm-actions';

	const cancelButton = dependencies.createElement('button');
	cancelButton.type = 'button';
	cancelButton.className = 'agent-confirm-cancel';
	cancelButton.textContent = AGENT_CONFIRM_CANCEL_LABEL;

	const acceptButton = dependencies.createElement('button');
	acceptButton.type = 'button';
	acceptButton.className = 'agent-confirm-accept';
	acceptButton.textContent = AGENT_CONFIRM_ACCEPT_LABEL;

	actions.append(cancelButton, acceptButton);
	panel.append(messageElement, actions);

	/**
	 * 대기 중인 확인 요청을 마무리하고 다이얼로그를 화면에서 제거한다.
	 *
	 * @param confirmed 사용자가 확인을 선택했으면 `true`
	 */
	const settle = (confirmed: boolean): void => {
		const resolve = resolveActive;
		resolveActive = undefined;

		try {
			host.hidden = true;
			host.replaceChildren();
			host.removeAttribute('role');
		} catch {
			/** 다이얼로그 제거 실패가 탭 상태 전이를 막지 않게 한다. */
		}

		resolve?.(confirmed);
	};

	cancelButton.addEventListener('click', () => settle(false));
	acceptButton.addEventListener('click', () => settle(true));

	host.hidden = true;

	return {
		confirm(message, acceptLabel = AGENT_CONFIRM_ACCEPT_LABEL): Promise<boolean> {
			if (disposed || resolveActive !== undefined) {
				return Promise.resolve(false);
			}

			return new Promise<boolean>((resolve) => {
				resolveActive = resolve;

				try {
					messageElement.textContent = message;
					acceptButton.textContent = acceptLabel;
					host.replaceChildren(panel);
					host.setAttribute('role', 'alertdialog');
					host.hidden = false;
					acceptButton.focus();
				} catch {
					/** 표시 실패는 되돌릴 수 없는 동작을 진행시키지 않고 취소로 처리한다. */
					settle(false);
				}
			});
		},

		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			settle(false);
		},
	};
}
