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
		message: '작업공간을 신뢰한 후 다시 시도하세요.',
		canRestart: true,
	},
	workspace_root_unavailable: {
		message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
		canRestart: true,
	},
	workspace_virtual_unsupported: {
		message: '로컬 파일 작업공간을 연 후 다시 시도하세요.',
		canRestart: true,
	},
	workspace_path_invalid: {
		message: '유효한 로컬 작업공간 폴더를 연 후 다시 시도하세요.',
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
