import type {
	HostToWebviewMessage,
	SessionId,
	TabId,
} from '../../protocol/messages';
import {
	mapShellLaunchFailureToTerminalError,
} from '../shell/shellErrorMessage';
import {
	resolveShellLaunchPolicy,
	type ShellLaunchPolicyResolver,
} from '../shell/shellResolver';
import type { ShellLaunchPolicy } from '../shell/types';
import {
	mapWorkspaceFailureToTerminalError,
} from '../workspace/workspaceErrorMessage';
import {
	resolveCurrentWorkspace,
	type WorkspaceResolver,
} from '../workspace/workspaceResolver';

/** 기존 protocol에서 terminal launch 실패로 공개할 수 있는 오류 메시지다. */
export type TerminalLaunchErrorMessage = Extract<
	HostToWebviewMessage,
	{ type: 'terminal.error' }
>;

/**
 * initial start와 restart가 공유하는 Host 실행 준비 진입점이다.
 * root, executable, args, cwd, env 또는 provider 값을 입력받지 않는다.
 */
export type PrepareTerminalLaunch = (
	tabId: TabId,
	sessionId: SessionId | null,
) => Promise<
	| { readonly ok: true; readonly policy: ShellLaunchPolicy }
	| { readonly ok: false; readonly error: TerminalLaunchErrorMessage }
>;

/** 현재 Host 플랫폼을 요청 시점에 읽는 주입형 함수다. */
export type HostPlatformReader = () => NodeJS.Platform;

/** 현재 Host 환경을 요청 시점에 읽는 주입형 함수다. */
export type HostEnvironmentReader = () => NodeJS.ProcessEnv;

/** Workspace와 Shell 정책을 연결하는 Host 내부 의존성이다. */
export interface PrepareTerminalLaunchDependencies {
	readonly workspaceResolver: WorkspaceResolver;
	readonly shellResolver: ShellLaunchPolicyResolver;
	readonly readPlatform: HostPlatformReader;
	readonly readEnvironment: HostEnvironmentReader;
}

/**
 * Workspace 검증 뒤에만 Shell 후보 선택과 실행 파일 검증을 수행한다.
 * 생성된 API는 호출할 때마다 workspace, platform과 Host env를 다시 평가한다.
 *
 * @param dependencies Host가 소유한 workspace 및 Shell 정책 의존성이다.
 * @returns initial start와 restart가 함께 사용하는 실행 준비 함수다.
 */
export function createPrepareTerminalLaunch(
	dependencies: PrepareTerminalLaunchDependencies,
): PrepareTerminalLaunch {
	const {
		workspaceResolver,
		shellResolver,
		readPlatform,
		readEnvironment,
	} = dependencies;

	return async function prepareLaunch(
		tabId: TabId,
		sessionId: SessionId | null,
	): ReturnType<PrepareTerminalLaunch> {
		const workspaceResult = workspaceResolver();
		if (!workspaceResult.ok) {
			return {
				ok: false,
				error: mapWorkspaceFailureToTerminalError(
					workspaceResult,
					tabId,
					sessionId,
				),
			};
		}

		const shellResult = await shellResolver(
			readPlatform(),
			readEnvironment(),
			workspaceResult.root,
		);
		if (!shellResult.ok) {
			return {
				ok: false,
				error: mapShellLaunchFailureToTerminalError(
					shellResult,
					tabId,
					sessionId,
				),
			};
		}

		return { ok: true, policy: shellResult.policy };
	};
}

/** 실제 Host 상태를 요청 시점마다 읽는 start/restart 공통 준비 함수다. */
export const prepareTerminalLaunch = createPrepareTerminalLaunch({
	workspaceResolver: resolveCurrentWorkspace,
	shellResolver: resolveShellLaunchPolicy,
	readPlatform: () => process.platform,
	readEnvironment: () => ({ ...process.env }),
});
