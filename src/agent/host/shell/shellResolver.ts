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

/** Crispy Terminal을 그리는 xterm.js가 해석하는 terminal 형식이다. */
const HOST_TERM = 'xterm-256color';

/** xterm.js가 RGB SGR을 렌더링하므로 CLI에 광고하는 24bit 색상 capability다. */
const HOST_COLORTERM = 'truecolor';

/**
 * Node 기반 CLI가 xterm.js의 24bit 색상 capability를 사용하도록 요구하는 수준이다.
 * `supports-color` 규약에서 3은 truecolor를 뜻한다.
 */
const HOST_FORCE_COLOR = '3';

/**
 * PTY가 협상할 색상 계약을 Host가 고정한 값으로 다시 쓴다.
 *
 * 색 지원 단계를 감지하는 CLI는 `TERM`, `COLORTERM`, `TERM_PROGRAM`을 근거로 삼는데,
 * 이 값들은 VS Code를 어떻게 실행했는지에 따라 달라진다. 예를 들어 Dock에서 띄우면
 * `TERM`이 아예 없고, tmux 안에서 띄우면 `screen`이 상속되며, `COLORTERM`은
 * 터미널 앱마다 다르다. 상속값을 그대로 두면 같은 저장소가 기여자 환경에 따라 다른
 * 색으로 렌더링되므로, 실제 렌더러인 xterm.js를 기준으로 값을 확정한다.
 *
 * @param base Extension Host가 읽은 환경 변수 snapshot이다.
 * @returns 원본을 변경하지 않고 색상 계약만 고정한 새 환경이다.
 */
export function buildShellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const env = { ...base };

	/** 색을 끄는 상속 설정은 Crispy Terminal 안에서는 적용하지 않는다. */
	delete env.NO_COLOR;
	if (env.CLICOLOR === '0') {
		delete env.CLICOLOR;
	}

	/** 감지 근거를 상속값이 아니라 렌더러 기준으로 통일한다. */
	env.TERM = HOST_TERM;
	env.COLORTERM = HOST_COLORTERM;
	env.FORCE_COLOR = HOST_FORCE_COLOR;

	/**
	 * TERM_PROGRAM은 터미널 앱별 분기(예: Apple_Terminal은 256색, iTerm은 24bit)에
	 * 쓰이므로 상속되면 위에서 고정한 계약을 다시 흔든다.
	 */
	delete env.TERM_PROGRAM;
	delete env.TERM_PROGRAM_VERSION;

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
