/** 원본 exception이나 실행 정보를 포함하지 않는 cleanup outcome allowlist다. */
export const CLEANUP_OUTCOMES = [
	'gracefully_terminated',
	'already_terminated',
	'force_terminated',
	'timeout',
	'permission_denied',
	'platform_unsupported',
	'verification_failed',
] as const;

/**
 * API 호출 성공 여부가 아니라 process tree의 실제 종료 확인 결과다.
 * 성공 outcome은 graceful, already, force 세 가지뿐이며 나머지는 실패다.
 */
export type CleanupResult =
	| { readonly outcome: 'gracefully_terminated' }
	| { readonly outcome: 'already_terminated' }
	| { readonly outcome: 'force_terminated' }
	| { readonly outcome: 'timeout' }
	| { readonly outcome: 'permission_denied' }
	| { readonly outcome: 'platform_unsupported' }
	| { readonly outcome: 'verification_failed' };

/**
 * Extension Host가 소유한 shell PID의 전체 process tree를 종료하고 검증한다.
 * 구현은 성공을 반환하기 전에 shell과 모든 자식 프로세스의 비생존을 확인해야 한다.
 */
export interface ProcessTreeController {
	terminate(pid: number): Promise<CleanupResult>;
}
