import type { ValidatedWorkspaceRoot } from '../workspace/types';
import type { ShellLaunchPolicyResult } from './types';

/**
 * Host가 주입한 환경과 검증된 workspace root로 macOS/Linux Shell 정책을 만든다.
 * 플랫폼 resolver는 실행 파일이나 PATH를 검사하지 않고 SHELL 값을 그대로 사용한다.
 */
function resolvePosixShellLaunchPolicy(
	env: NodeJS.ProcessEnv,
	workspaceRoot: ValidatedWorkspaceRoot,
): ShellLaunchPolicyResult {
	const executable = env.SHELL;
	if (typeof executable !== 'string' || executable.length === 0) {
		return {
			ok: false,
			error: { code: 'shell_environment_missing' },
		};
	}

	return {
		ok: true,
		policy: {
			executable,
			args: [],
			cwd: workspaceRoot.fsPath,
			env: { ...env },
		},
	};
}

/**
 * macOS Extension Host의 SHELL 환경으로 실행 정책을 해석한다.
 *
 * @param env Extension Host가 제공한 환경 변수 snapshot이다.
 * @param workspaceRoot 1-3 정책을 통과한 canonical workspace root다.
 * @returns Host 내부 Shell 실행 정책 또는 typed 환경 설정 실패다.
 */
export function resolveDarwinShellLaunchPolicy(
	env: NodeJS.ProcessEnv,
	workspaceRoot: ValidatedWorkspaceRoot,
): ShellLaunchPolicyResult {
	return resolvePosixShellLaunchPolicy(env, workspaceRoot);
}

/**
 * Linux Extension Host의 SHELL 환경으로 실행 정책을 해석한다.
 *
 * @param env Extension Host가 제공한 환경 변수 snapshot이다.
 * @param workspaceRoot 1-3 정책을 통과한 canonical workspace root다.
 * @returns Host 내부 Shell 실행 정책 또는 typed 환경 설정 실패다.
 */
export function resolveLinuxShellLaunchPolicy(
	env: NodeJS.ProcessEnv,
	workspaceRoot: ValidatedWorkspaceRoot,
): ShellLaunchPolicyResult {
	return resolvePosixShellLaunchPolicy(env, workspaceRoot);
}
