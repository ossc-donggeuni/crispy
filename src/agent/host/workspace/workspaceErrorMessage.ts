import type {
	HostToWebviewMessage,
	SessionId,
	TabId,
} from '../../protocol/messages';
import type {
	WorkspaceValidationErrorCode,
	WorkspaceValidationFailure,
} from './types';

/** 기존 Host→Webview 계약에서 terminal.error 메시지만 추출한 타입이다. */
export type WorkspaceTerminalErrorMessage = Extract<
	HostToWebviewMessage,
	{ type: 'terminal.error' }
>;

/** MCP restart의 cleanup 전 Workspace 거부에 사용하는 Host→Webview 메시지다. */
export type WorkspaceMcpRestartRejectedMessage = Extract<
	HostToWebviewMessage,
	{ type: 'mcp.restartRejected' }
>;

/** Workspace 오류 code별로 Webview에 공개할 수 있는 고정 정책이다. */
interface WorkspaceErrorMessagePolicy {
	readonly message: string;
	readonly canRestart: boolean;
}

/**
 * Workspace 정책 오류를 사용자 안내 문구와 재시도 가능 여부에 연결한다.
 * 입력값이나 내부 예외 문자열을 사용하지 않는 완전한 code allowlist다.
 */
const WORKSPACE_ERROR_MESSAGE_POLICIES = {
	workspace_untrusted: {
		message: 'Trust the workspace and try again.',
		canRestart: true,
	},
	workspace_root_unavailable: {
		message: 'Reopen the selected workspace folder and try again.',
		canRestart: true,
	},
	workspace_virtual_unsupported: {
		message: 'Open a local file workspace and try again.',
		canRestart: true,
	},
	workspace_path_invalid: {
		message: 'Open a valid local workspace folder and try again.',
		canRestart: true,
	},
} as const satisfies Record<
	WorkspaceValidationErrorCode,
	WorkspaceErrorMessagePolicy
>;

/**
 * Workspace resolver 실패를 안전한 terminal.error 메시지로 변환한다.
 * 실제 경로, URI, 작업공간 이름이나 내부 오류를 읽거나 메시지에 반영하지 않는다.
 *
 * @param failure Workspace resolver가 반환한 정책 실패 결과다.
 * @param tabId protocol validation을 이미 통과한 Webview tab 식별자다.
 * @param sessionId 기존 session 오류면 해당 식별자, 시작 전 오류면 null이다.
 * @returns 기존 Host→Webview protocol schema와 일치하는 terminal.error 메시지다.
 */
export function mapWorkspaceFailureToTerminalError(
	failure: WorkspaceValidationFailure,
	tabId: TabId,
	sessionId: SessionId | null,
): WorkspaceTerminalErrorMessage {
	const policy = WORKSPACE_ERROR_MESSAGE_POLICIES[failure.code];

	return {
		type: 'terminal.error',
		tabId,
		sessionId,
		code: failure.code,
		message: policy.message,
		canRestart: policy.canRestart,
	};
}

/**
 * Workspace resolver 실패를 현재 CLI/MCP 상태를 보존하는 MCP restart 거부로 변환한다.
 * terminal mapper와 같은 고정 allowlist 문구를 사용하며 경로나 URI를 반사하지 않는다.
 */
export function mapWorkspaceFailureToMcpRestartRejected(
	failure: WorkspaceValidationFailure,
	tabId: TabId,
	sessionId: SessionId,
): WorkspaceMcpRestartRejectedMessage {
	const policy = WORKSPACE_ERROR_MESSAGE_POLICIES[failure.code];

	return {
		type: 'mcp.restartRejected',
		tabId,
		sessionId,
		code: failure.code,
		message: policy.message,
	};
}
