import type { ValidatedWorkspaceRoot } from '../workspace/types';
import { resolvePosixShellLaunchPolicy } from './posixShellResolver';
import { validateShellExecutable } from './shellExecutableValidator';
import {
	nodeShellFilesystemAdapter,
	type ShellFilesystemAdapter,
} from './shellFilesystem';
import type {
	ShellLaunchPolicyResult,
	SupportedShellPlatform,
} from './types';
import { resolveWindowsShellLaunchPolicy } from './windowsShellResolver';

/** Host가 플랫폼별 Shell 선택과 executable 검증을 수행하는 비동기 진입점이다. */
export type ShellLaunchPolicyResolver = (
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	workspaceRoot: ValidatedWorkspaceRoot,
) => Promise<ShellLaunchPolicyResult>;

/** 인터랙티브 PTY가 색상 출력을 협상하도록 Host 환경 snapshot을 보정한다. */
export function buildShellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...base };
	delete env.NO_COLOR;
	env.FORCE_COLOR = '1';
	if (env.TERM === undefined || env.TERM === 'dumb') {
		env.TERM = 'xterm-256color';
	}
	return env;
}

/** 지원 플랫폼의 resolver를 호출하고 선택된 플랫폼을 함께 반환한다. */
function selectShellLaunchPolicy(
	platform: NodeJS.Platform,
	env: NodeJS.ProcessEnv,
	workspaceRoot: ValidatedWorkspaceRoot,
): {
	readonly platform: SupportedShellPlatform;
	readonly result: ShellLaunchPolicyResult;
} | undefined {
	switch (platform) {
		case 'darwin':
		case 'linux':
			return {
				platform,
				result: resolvePosixShellLaunchPolicy(env, workspaceRoot),
			};
		case 'win32':
			return {
				platform,
				result: resolveWindowsShellLaunchPolicy(env, workspaceRoot),
			};
		default:
			return undefined;
	}
}

/**
 * 주입된 filesystem adapter로 플랫폼 선택과 검증을 수행하는 resolver를 만든다.
 * 반환된 resolver의 입력은 platform, Host env와 검증된 workspace root뿐이다.
 *
 * @param filesystem executable 검증 I/O를 격리하는 Host adapter다.
 * @returns 선택된 후보를 검증한 뒤에만 정책을 반환하는 비동기 resolver다.
 */
export function createShellLaunchPolicyResolver(
	filesystem: ShellFilesystemAdapter,
): ShellLaunchPolicyResolver {
	return async function resolveShellLaunchPolicy(
		platform: NodeJS.Platform,
		env: NodeJS.ProcessEnv,
		workspaceRoot: ValidatedWorkspaceRoot,
	): Promise<ShellLaunchPolicyResult> {
		const selected = selectShellLaunchPolicy(
			platform,
			buildShellEnv(env),
			workspaceRoot,
		);
		if (!selected) {
			return {
				ok: false,
				error: { code: 'unsupported_platform' },
			};
		}
		if (!selected.result.ok) {
			return selected.result;
		}

		return validateShellExecutable(
			selected.platform,
			selected.result.policy,
			filesystem,
		);
	};
}

/** 실제 Node filesystem adapter를 사용하는 Extension Host 표준 진입점이다. */
export const resolveShellLaunchPolicy = createShellLaunchPolicyResolver(
	nodeShellFilesystemAdapter,
);
