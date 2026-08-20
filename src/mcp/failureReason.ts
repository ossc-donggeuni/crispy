export const MCP_FAILURE_REASONS = Object.freeze([
	'adapter_start_failed',
	'adapter_ready_timeout',
	'adapter_exited',
	'auth_registration_failed',
	'provider_config_rejected',
	'provider_policy_blocked',
	'provider_update_required',
	'safe_session_injection_unavailable',
	'unsupported_platform',
	'unsupported_runtime',
] as const);

export type McpFailureReason = typeof MCP_FAILURE_REASONS[number];

export const retryabilityByFailureReason = Object.freeze({
	adapter_start_failed: true,
	adapter_ready_timeout: true,
	adapter_exited: true,
	auth_registration_failed: true,
	provider_config_rejected: false,
	provider_policy_blocked: false,
	provider_update_required: false,
	safe_session_injection_unavailable: false,
	unsupported_platform: false,
	unsupported_runtime: false,
} satisfies Readonly<Record<McpFailureReason, boolean>>);

export interface McpFailure {
	readonly reason: McpFailureReason;
	readonly retryable: boolean;
}

/** Raw exception, process 정보와 credential을 담지 않는 단일 domain failure 생성 경계다. */
export function createMcpFailure(reason: McpFailureReason): McpFailure {
	return Object.freeze({
		reason,
		retryable: retryabilityByFailureReason[reason],
	});
}
