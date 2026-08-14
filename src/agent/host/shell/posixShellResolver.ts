import type { ValidatedWorkspaceRoot } from '../workspace/types';
import type { ShellLaunchPolicyResult } from './types';

/**
 * Host가 주입한 환경과 검증된 workspace root로 macOS/Linux Shell 정책을 만든다.
 * 플랫폼 resolver는 실행 파일이나 PATH를 검사하지 않고 SHELL 값을 그대로 사용한다.
 */
export function resolvePosixShellLaunchPolicy(
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
