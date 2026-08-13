/** Host가 Shell 실행을 지원하는 Node.js 플랫폼 식별자다. */
export type SupportedShellPlatform = 'darwin' | 'linux' | 'win32';

/**
 * Extension Host가 해석하고 검증한 뒤 PTY 생성에 사용하는 실행 계약이다.
 * 이 타입은 Host 내부 전용이며 protocol 또는 Webview 메시지에서 재노출하지 않는다.
 */
export interface ShellLaunchPolicy {
	executable: string;
	args: readonly string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** Shell 정책 해석과 향후 실행 파일 검증에서 구분해야 하는 전체 실패 code다. */
export const SHELL_LAUNCH_ERROR_CODES = [
	'unsupported_platform',
	'shell_environment_missing',
	'shell_path_invalid',
	'shell_executable_not_found',
	'shell_path_not_file',
	'shell_not_executable',
] as const;

/** Host 내부 Shell 실행 정책 실패의 안정적인 식별자다. */
export type ShellLaunchErrorCode = typeof SHELL_LAUNCH_ERROR_CODES[number];

/**
 * Shell 실행 정책 실패 정보다.
 * 실행 경로, 환경 변수, 사용자 입력 또는 원본 exception을 저장하지 않는다.
 */
export interface ShellLaunchPolicyError {
	readonly code: ShellLaunchErrorCode;
}

/** Host 내부 Shell 실행 정책 해석이 성공한 결과다. */
export interface ShellLaunchPolicySuccess {
	readonly ok: true;
	readonly policy: ShellLaunchPolicy;
}

/** Host 내부 Shell 실행 정책 해석 또는 검증이 실패한 결과다. */
export interface ShellLaunchPolicyFailure {
	readonly ok: false;
	readonly error: ShellLaunchPolicyError;
}

/** 향후 플랫폼 resolver와 실행 파일 validator가 공유할 typed 결과다. */
export type ShellLaunchPolicyResult =
	| ShellLaunchPolicySuccess
	| ShellLaunchPolicyFailure;
