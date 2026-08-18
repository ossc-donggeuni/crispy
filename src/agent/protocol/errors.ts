/** Webview에 전달할 수 있는 안정적인 terminal 오류 code allowlist다. */
export const TERMINAL_ERROR_CODES = [
	'workspace_not_found',
	'workspace_untrusted',
	'workspace_multi_root_unsupported',
	'workspace_virtual_unsupported',
	'workspace_path_invalid',
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
