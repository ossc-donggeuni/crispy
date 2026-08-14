import type { ValidatedWorkspaceRoot } from '../workspace/types';
import { resolvePosixShellLaunchPolicy } from './posixShellResolver';
import type { ShellLaunchPolicyResult } from './types';
import { resolveWindowsShellLaunchPolicy } from './windowsShellResolver';

/**
 * Host가 주입한 플랫폼에 맞는 Shell 정책 resolver를 선택한다.
 * OS별 실행 계약은 POSIX와 Windows 전용 모듈에 계속 격리한다.
 *
 * @param platform Extension Host가 제공한 Node.js 플랫폼 식별자다.
 * @param env Extension Host가 제공한 환경 변수 snapshot이다.
 * @param workspaceRoot 1-3 정책을 통과한 canonical workspace root다.
 * @returns Host 내부 Shell 실행 정책 또는 typed 플랫폼·환경 실패다.
 */
export function resolveShellLaunchPolicy(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	workspaceRoot: ValidatedWorkspaceRoot,
): ShellLaunchPolicyResult {
	switch (platform) {
		case 'darwin':
		case 'linux':
			return resolvePosixShellLaunchPolicy(env, workspaceRoot);
		case 'win32':
			return resolveWindowsShellLaunchPolicy(env, workspaceRoot);
		default:
			return {
				ok: false,
				error: { code: 'unsupported_platform' },
			};
	}
}
