import type {
	HostToWebviewMessage,
	SessionId,
	TabId,
} from '../../protocol/messages';
import type {
	ShellLaunchErrorCode,
	ShellLaunchPolicyFailure,
} from './types';

/** 기존 Host→Webview 계약에서 terminal.error 메시지만 추출한 타입이다. */
export type ShellTerminalErrorMessage = Extract<
	HostToWebviewMessage,
	{ type: 'terminal.error' }
>;

/** Shell 내부 오류 code별로 Webview에 공개할 수 있는 고정 정책이다. */
interface ShellErrorMessagePolicy {
	readonly message: string;
	readonly canRestart: boolean;
}

/**
 * 내부 Shell 실패를 고정된 사용자 안내와 재시도 가능 여부에 연결한다.
 * 원본 경로, 환경 변수 또는 exception 문자열을 입력받지 않는 완전한 allowlist다.
 */
const SHELL_ERROR_MESSAGE_POLICIES = {
	unsupported_platform: {
		message: '현재 운영체제에서는 Shell terminal을 지원하지 않습니다.',
		canRestart: false,
	},
	shell_environment_missing: {
		message: 'Shell 환경 설정을 찾을 수 없습니다.',
		canRestart: true,
	},
	shell_path_invalid: {
		message: 'Shell 경로 설정이 올바르지 않습니다.',
		canRestart: true,
	},
	shell_executable_not_found: {
		message: '설정된 Shell 실행 파일을 찾을 수 없습니다.',
		canRestart: true,
	},
	shell_path_not_file: {
		message: '설정된 Shell 경로가 실행 파일이 아닙니다.',
		canRestart: true,
	},
	shell_not_executable: {
		message: '설정된 Shell을 실행할 권한이 없습니다.',
		canRestart: true,
	},
} as const satisfies Record<ShellLaunchErrorCode, ShellErrorMessagePolicy>;

/**
 * Host 내부 Shell 정책 실패를 기존 terminal.error 계약으로 안전하게 변환한다.
 * 세부 실패 code는 Host에만 유지하고 Webview에는 shell_unavailable만 공개한다.
 *
 * @param failure 경로나 원본 오류를 담지 않는 Host 내부 typed 실패다.
 * @param tabId protocol validation을 이미 통과한 Webview tab 식별자다.
 * @param sessionId 기존 session 오류면 해당 식별자, 시작 전 오류면 null이다.
 * @returns 기존 Host→Webview schema와 일치하는 안전한 terminal.error 메시지다.
 */
export function mapShellLaunchFailureToTerminalError(
	failure: ShellLaunchPolicyFailure,
	tabId: TabId,
	sessionId: SessionId | null,
): ShellTerminalErrorMessage {
	const policy = SHELL_ERROR_MESSAGE_POLICIES[failure.error.code];

	return {
		type: 'terminal.error',
		tabId,
		sessionId,
		code: 'shell_unavailable',
		message: policy.message,
		canRestart: policy.canRestart,
	};
}
