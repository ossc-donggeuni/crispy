import { win32 } from 'node:path';
import type { ValidatedWorkspaceRoot } from '../workspace/types';
import type { ShellLaunchPolicyResult } from './types';

/** Windows PowerShell 5.1의 SystemRoot 기준 고정 경로 구성 요소다. */
const WINDOWS_POWERSHELL_PATH_SEGMENTS = [
	'System32',
	'WindowsPowerShell',
	'v1.0',
	'powershell.exe',
] as const;

/**
 * Windows Extension Host의 SystemRoot로 Windows PowerShell 5.1 정책을 만든다.
 * PATH, ComSpec, WSL 또는 다른 Shell을 탐색하지 않으며 실행 파일도 검사하지 않는다.
 *
 * @param env Extension Host가 제공한 환경 변수 snapshot이다.
 * @param workspaceRoot 1-3 정책을 통과한 canonical workspace root다.
 * @returns Host 내부 Shell 실행 정책 또는 typed 환경 설정 실패다.
 */
export function resolveWindowsShellLaunchPolicy(
	env: NodeJS.ProcessEnv,
	workspaceRoot: ValidatedWorkspaceRoot,
): ShellLaunchPolicyResult {
	const systemRoot = env.SystemRoot;
	if (typeof systemRoot !== 'string' || systemRoot.length === 0) {
		return {
			ok: false,
			error: { code: 'shell_environment_missing' },
		};
	}

	return {
		ok: true,
		policy: {
			executable: win32.join(
				systemRoot,
				...WINDOWS_POWERSHELL_PATH_SEGMENTS,
			),
			args: [],
			cwd: workspaceRoot.fsPath,
			env: { ...env },
		},
	};
}
