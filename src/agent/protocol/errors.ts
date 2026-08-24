/** 실행 경계의 fresh Workspace 검증이 반환할 수 있는 안정적인 오류 code다. */
export const WORKSPACE_EXECUTION_ERROR_CODES = [
	'workspace_untrusted',
	'workspace_root_unavailable',
	'workspace_virtual_unsupported',
	'workspace_path_invalid',
] as const;

/** Workspace 실행 검증 실패를 Webview에 공개하는 오류 code union이다. */
export type WorkspaceExecutionErrorCode =
	typeof WORKSPACE_EXECUTION_ERROR_CODES[number];

/** Webview에 전달할 수 있는 안정적인 terminal 오류 code allowlist다. */
export const TERMINAL_ERROR_CODES = [
	...WORKSPACE_EXECUTION_ERROR_CODES,
	'workspace_change_requires_reset',
	'provider_not_allowed',
	'shell_unavailable',
	'start_failed',
	'session_not_found',
	'invalid_session_state',
	'cleanup_failed',
	'internal_error',
] as const;

/** Host가 terminal.error로 보고할 수 있는 오류의 안정적인 식별자다. */
export type TerminalErrorCode = typeof TERMINAL_ERROR_CODES[number];
