/** 1단계 Terminal Host가 공유하는 입력·크기·버퍼·종료 제한값이다. */
export const TERMINAL_POLICY = Object.freeze({
	maxBufferedOutputBytes: 8 * 1024 * 1024,
	maxInputBytes: 64 * 1024,
	maxSessionIdLength: 128,
	minDimension: 1,
	maxDimension: 1_000,
	gracefulShutdownTimeoutMs: 2_000,
	forceShutdownTimeoutMs: 2_000,
});

/** Host가 실행할 shell executable, 고정 인자 및 표시명을 정의한다. */
export interface ShellLaunchPolicy {
	executable: string;
	args: readonly string[];
	label: string;
}

/**
 * 플랫폼별 기본 shell 실행 계약을 Host에서만 결정한다.
 * PTY 자체가 interactive 환경을 제공하므로 Unix shell에는 login 등의 인자를 추가하지 않는다.
 *
 * @param platform 실행 대상 Node.js 플랫폼
 * @param environment 사용자의 기본 shell을 조회할 환경 변수
 * @returns Webview가 변경할 수 없는 기본 shell 실행 계약
 */
export function getDefaultShellPolicy(
	platform: NodeJS.Platform = process.platform,
	environment: NodeJS.ProcessEnv = process.env,
): ShellLaunchPolicy {
	if (platform === 'win32') {
		return {
			executable: 'powershell.exe',
			args: [],
			label: 'Windows PowerShell',
		};
	}

	const executable = environment.SHELL?.trim() || '/bin/sh';
	const segments = executable.split('/');

	return {
		executable,
		args: [],
		label: segments.at(-1) || executable,
	};
}

/**
 * PTY에 전달할 환경을 복사하고 terminal capability만 중앙에서 보정한다.
 *
 * @param source 상위 Extension Host의 환경 변수
 * @returns undefined 값을 제거하고 terminal capability를 보정한 환경
 */
export function createTerminalEnvironment(
	source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const environment: Record<string, string> = {};

	for (const [key, value] of Object.entries(source)) {
		if (value !== undefined) {
			environment[key] = value;
		}
	}

	environment.TERM = 'xterm-256color';
	environment.COLORTERM = 'truecolor';
	environment.TERM_PROGRAM = 'vscode';
	delete environment.NO_COLOR;
	environment.CLICOLOR = '1';

	return environment;
}
