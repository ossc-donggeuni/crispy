/** 운영체제별로 Codex app-server와 하위 process tree를 best-effort 종료하는 모듈이다. */

import { type ChildProcess, spawn } from 'node:child_process';

/** app-server process tree에 정상 종료 기회를 주는 기본 시간이다. */
export const defaultTerminationGraceMs = 1_500;

/** app-server process tree 종료 동작의 조정 가능한 설정이다. */
export interface CodexProcessTerminationOptions {
	/** SIGTERM 또는 일반 taskkill 뒤 강제 종료 전까지 기다릴 밀리초다. */
	graceMs?: number;
}

/**
 * app-server와 그 하위 프로세스를 정상 종료한 뒤 필요하면 강제 종료한다.
 * POSIX에서는 detached process group, Windows에서는 taskkill 트리를 대상으로 한다.
 *
 * @param child 종료할 app-server root process
 * @param options 정상 종료 유예 시간 설정
 */
export async function terminateCodexProcessTree(
	child: ChildProcess,
	options: CodexProcessTerminationOptions = {},
): Promise<void> {
	if (hasExited(child)) {
		return;
	}
	const pid = child.pid;
	if (!pid || !Number.isInteger(pid) || pid <= 0) {
		throw new Error('종료할 app-server 프로세스의 PID가 올바르지 않습니다.');
	}
	const graceMs = options.graceMs ?? defaultTerminationGraceMs;
	if (!Number.isFinite(graceMs) || graceMs < 0) {
		throw new Error('app-server 종료 유예 시간은 0 이상의 유한한 값이어야 합니다.');
	}

	if (process.platform === 'win32') {
		await runTaskkill(pid, false);
		if (await waitForClose(child, graceMs)) {
			return;
		}
		await runTaskkill(pid, true);
		if (!await waitForClose(child, graceMs)) {
			throw new Error('강제 종료 후에도 app-server process tree가 닫히지 않았습니다.');
		}
		return;
	}

	sendPosixGroupSignal(child, pid, 'SIGTERM');
	if (await waitForClose(child, graceMs)) {
		return;
	}
	sendPosixGroupSignal(child, pid, 'SIGKILL');
	if (!await waitForClose(child, graceMs)) {
		throw new Error('SIGKILL 후에도 app-server process tree가 닫히지 않았습니다.');
	}
}

/**
 * detached POSIX process group에 signal을 보내고 group이 없으면 root child로 fallback한다.
 *
 * @param child fallback signal을 받을 app-server root process.
 * @param pid detached process group ID로 사용하는 root PID.
 * @param signal 정상 또는 강제 종료 signal.
 */
function sendPosixGroupSignal(
	child: ChildProcess,
	pid: number,
	signal: NodeJS.Signals,
): void {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (!isNodeError(error) || error.code !== 'ESRCH') {
			throw error;
		}
		if (!hasExited(child)) {
			child.kill(signal);
		}
	}
}

/**
 * Windows `taskkill /T`로 root PID와 하위 process를 종료한다.
 * taskkill 자체의 실행 실패는 이후 child close 확인에서 최종 판정한다.
 *
 * @param pid 종료할 app-server root PID.
 * @param force `/F` 강제 종료 옵션 사용 여부.
 */
async function runTaskkill(pid: number, force: boolean): Promise<void> {
	await new Promise<void>((resolve) => {
		const args = ['/PID', String(pid), '/T'];
		if (force) {
			args.push('/F');
		}
		const killer = spawn('taskkill', args, {
			shell: false,
			stdio: 'ignore',
			windowsHide: true,
		});
		killer.once('error', () => resolve());
		killer.once('close', () => resolve());
	});
}

/**
 * child가 이미 종료됐는지 먼저 확인하고, 아니면 close event를 제한 시간 동안 기다린다.
 *
 * @param child 종료 상태를 관찰할 process.
 * @param timeoutMs close event를 기다릴 최대 밀리초.
 * @returns 제한 시간 안에 child 종료를 확인했는지 여부.
 */
async function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (hasExited(child)) {
		return true;
	}
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (closed: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			child.off('close', onClose);
			resolve(closed);
		};
		const onClose = (): void => finish(true);
		const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
		child.once('close', onClose);
	});
}

/**
 * @param child 종료 여부를 확인할 process.
 * @returns exit code 또는 signal code가 설정되어 종료가 확인됐는지 여부.
 */
function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

/**
 * @param error process signal API에서 받은 알 수 없는 오류 값.
 * @returns Node errno code를 조회할 수 있는 Error인지 여부.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error;
}
