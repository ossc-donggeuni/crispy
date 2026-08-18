import { execFile } from 'child_process';

/** 외부 명령 결과에서 노출 가능한 최소 내부 상태다. */
export type HostCommandResult =
	| { readonly status: 'completed'; readonly stdout: string }
	| { readonly status: 'timeout' }
	| { readonly status: 'permission_denied' }
	| { readonly status: 'platform_unsupported' }
	| { readonly status: 'failed' };

/** 실행 파일과 인자는 Host adapter만 구성하며 Webview에서 입력받지 않는다. */
export interface HostCommandRunner {
	run(
		executable: string,
		args: readonly string[],
		timeoutMs: number,
	): Promise<HostCommandResult>;
}

/** 개별 PID의 실제 생존 확인 결과다. */
export type ProcessIdProbeResult =
	| { readonly state: 'alive' }
	| { readonly state: 'terminated' }
	| { readonly state: 'permission_denied' }
	| { readonly state: 'verification_failed' };

/** 개별 PID의 생존을 확인하는 주입 가능한 Host 내부 probe다. */
export interface ProcessIdProbe {
	inspect(pid: number): Promise<ProcessIdProbeResult>;
}

const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

/** 외부 명령 timeout 뒤 native process를 남기지 않기 위한 고정 강제 종료 signal이다. */
const HOST_COMMAND_KILL_SIGNAL: NodeJS.Signals = 'SIGKILL';

/** stderr와 원본 exception을 결과에 포함하지 않는 production command runner다. */
export const hostCommandRunner: HostCommandRunner = {
	run(executable, args, timeoutMs): Promise<HostCommandResult> {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			return Promise.resolve({ status: 'timeout' });
		}

		return new Promise((resolve) => {
			execFile(
				executable,
				[...args],
				{
					encoding: 'utf8',
					killSignal: HOST_COMMAND_KILL_SIGNAL,
					maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
					timeout: Math.max(1, Math.floor(timeoutMs)),
					windowsHide: true,
				},
				(error, stdout) => {
					if (error === null) {
						resolve({ status: 'completed', stdout });
						return;
					}

					const commandError = error as NodeJS.ErrnoException & {
						readonly killed?: boolean;
					};
					const code = commandError.code;
					if (code === 'ETIMEDOUT' || commandError.killed === true) {
						resolve({ status: 'timeout' });
						return;
					}
					if (code === 'EACCES' || code === 'EPERM') {
						resolve({ status: 'permission_denied' });
						return;
					}
					if (code === 'ENOENT') {
						resolve({ status: 'platform_unsupported' });
						return;
					}

					resolve({ status: 'failed' });
				},
			);
		});
	},
};

/** Node의 signal 0을 사용하되 원본 exception을 보존하지 않는 PID probe다. */
export const hostProcessIdProbe: ProcessIdProbe = {
	async inspect(pid): Promise<ProcessIdProbeResult> {
		try {
			process.kill(pid, 0);
			return { state: 'alive' };
		} catch (error: unknown) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ESRCH') {
				return { state: 'terminated' };
			}
			if (code === 'EACCES' || code === 'EPERM') {
				return { state: 'permission_denied' };
			}
			return { state: 'verification_failed' };
		}
	},
};
