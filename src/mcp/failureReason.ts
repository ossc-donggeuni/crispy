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
	adapter_start_failed: 'Crispy MCP를 시작하지 못했습니다.',
	adapter_ready_timeout: 'Crispy MCP가 준비되지 않았습니다.',
	adapter_exited: 'Crispy MCP 연결이 종료되었습니다.',
	auth_registration_failed: 'Crispy MCP 인증 연결을 준비하지 못했습니다.',
	provider_config_rejected: 'Codex가 Crispy MCP 구성을 사용할 수 없습니다.',
	provider_policy_blocked: 'Codex 정책이 Crispy MCP 연결을 허용하지 않습니다.',
	provider_update_required: 'Codex 업데이트 후 Crispy MCP를 사용할 수 있습니다.',
	safe_session_injection_unavailable:
		'현재 Codex 세션에 Crispy MCP를 안전하게 연결할 수 없습니다.',
	unsupported_platform: '이 플랫폼에서는 Crispy MCP 자동 연결을 지원하지 않습니다.',
	unsupported_runtime: '이 Extension Host runtime에서는 Crispy MCP를 지원하지 않습니다.',
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
