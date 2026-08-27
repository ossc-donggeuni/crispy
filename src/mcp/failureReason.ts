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

/** Webview에 raw reason이나 provider 출력을 반사하지 않는 고정 사용자 문구다. */
export const messageByMcpFailureReason = Object.freeze({
	adapter_start_failed: 'Could not start Crispy MCP.',
	adapter_ready_timeout: 'Crispy MCP did not become ready in time.',
	adapter_exited: 'The Crispy MCP connection ended.',
	auth_registration_failed: 'Could not prepare the authenticated Crispy MCP connection.',
	provider_config_rejected: 'The Agent cannot use the Crispy MCP configuration.',
	provider_policy_blocked: 'The Agent policy does not allow the Crispy MCP connection.',
	provider_update_required: 'Update the Agent to use Crispy MCP.',
	safe_session_injection_unavailable:
		'Crispy MCP cannot be connected safely to the current Agent session.',
	unsupported_platform: 'Automatic Crispy MCP connection is not supported on this platform.',
	unsupported_runtime: 'Crispy MCP is not supported by this Extension Host runtime.',
} satisfies Readonly<Record<McpFailureReason, string>>);

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
