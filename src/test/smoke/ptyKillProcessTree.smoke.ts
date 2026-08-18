import * as nodePty from 'node-pty';
import { createHostProcessTreeController } from '../../agent/host/terminal/processTreeControllerFactory';

const CHILD_PID_MARKER = '__CRISPY_PTY_SMOKE_CHILD_PID__=';
const STARTUP_TIMEOUT_MS = 2_000;
const TERMINATION_TIMEOUT_MS = 2_000;
const CLEANUP_TIMEOUT_MS = 1_000;
const POLL_INTERVAL_MS = 25;

interface SmokeLaunch {
    readonly executable: string;
    readonly args: readonly string[];
}

type SmokeFailureStage =
	| 'startup'
	| 'snapshot'
	| 'snapshot_missing_child'
	| 'termination_outcome'
	| 'process_survived'
	| 'final_cleanup'
	| 'unexpected';

let failureStage: SmokeFailureStage = 'unexpected';

function createSmokeLaunch(): SmokeLaunch {
    if (process.platform === 'win32') {
        const systemRoot = process.env.SystemRoot;
        if (systemRoot === undefined || systemRoot.length === 0) {
            throw new Error('Smoke launch unavailable');
        }

        const executable = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
        const childCommand = Buffer.from(
            'while ($true) { Start-Sleep -Milliseconds 250 }',
            'utf16le',
        ).toString('base64');
        const startChildCommand = [
            `$child = Start-Process -FilePath '${executable.replace(/'/gu, "''")}'`,
            `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${childCommand}'`,
            '-NoNewWindow',
            '-PassThru',
        ].join(' ');
        const shellCommand = [
            startChildCommand,
            `Write-Output \"${CHILD_PID_MARKER}$($child.Id)\"`,
            'Wait-Process -Id $child.Id',
        ].join('; ');

        return {
            executable,
            args: ['-NoProfile', '-NonInteractive', '-Command', shellCommand],
        };
    }

    if (process.platform === 'darwin' || process.platform === 'linux') {
        const shellCommand = `trap '' HUP; /usr/bin/tail -f /dev/null & child_pid=$!; printf '${CHILD_PID_MARKER}%s\\n' \"$child_pid\"; wait \"$child_pid\"`;
        return {
            executable: '/bin/sh',
            args: ['-c', shellCommand],
        };
    }

    throw new Error('Smoke launch unavailable');
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

function isProcessGroupAlive(groupId: number): boolean {
    try {
        process.kill(-groupId, 0);
        return true;
    } catch (error: unknown) {
        return (error as NodeJS.ErrnoException).code !== 'ESRCH';
    }
}

async function pollUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) {
            return true;
        }

        await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }

    return predicate();
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(pid, signal);
    } catch {
        // The target already exited or cannot be signalled; polling verifies the result.
    }
}

async function stopPid(pid: number): Promise<boolean> {
    if (!isAlive(pid)) {
        return true;
    }

    sendSignal(pid, 'SIGTERM');
    if (await pollUntil(() => !isAlive(pid), CLEANUP_TIMEOUT_MS / 2)) {
        return true;
    }

    sendSignal(pid, 'SIGKILL');
    return pollUntil(() => !isAlive(pid), CLEANUP_TIMEOUT_MS);
}

async function stopProcessGroup(groupId: number): Promise<boolean> {
    if (process.platform === 'win32') {
        return true;
    }

    if (!isProcessGroupAlive(groupId)) {
        return true;
    }

    sendSignal(-groupId, 'SIGTERM');
    if (await pollUntil(() => !isProcessGroupAlive(groupId), CLEANUP_TIMEOUT_MS / 2)) {
        return true;
    }

    sendSignal(-groupId, 'SIGKILL');
    return pollUntil(() => !isProcessGroupAlive(groupId), CLEANUP_TIMEOUT_MS);
}

async function runSmoke(): Promise<boolean> {
    let pty: nodePty.IPty | undefined;
    let childPid: number | undefined;
    let dataSubscription: nodePty.IDisposable | undefined;
    let measuredSuccess = false;
    let cleanupSuccess = false;

    try {
        const launch = createSmokeLaunch();
        pty = nodePty.spawn(launch.executable, [...launch.args], {
            cols: 80,
            rows: 24,
            cwd: process.cwd(),
            env: process.env,
            name: 'xterm-256color',
        });

        let bufferedData = '';
        dataSubscription = pty.onData((data) => {
            bufferedData = (bufferedData + data).slice(-512);
            const match = bufferedData.match(new RegExp(`${CHILD_PID_MARKER}(\\d+)`));
            if (match !== null) {
                const parsedPid = Number(match[1]);
                if (Number.isSafeInteger(parsedPid) && parsedPid > 1) {
                    childPid = parsedPid;
                }
            }
        });

        const childStarted = await pollUntil(
            () => childPid !== undefined && isAlive(childPid),
            STARTUP_TIMEOUT_MS,
        );
        if (!childStarted || childPid === undefined || !isAlive(pty.pid)) {
            failureStage = 'startup';
            return false;
        }

        const shellPid = pty.pid;
        const measuredChildPid = childPid;
        const controller = createHostProcessTreeController({
            timeoutMs: TERMINATION_TIMEOUT_MS,
        });
        const capture = await controller.capture(shellPid);
        if (capture.status !== 'captured') {
            failureStage = 'snapshot';
            return false;
        }
        if (!capture.snapshot.descendants.includes(measuredChildPid)) {
            failureStage = 'snapshot_missing_child';
            return false;
        }

        const controllerResult = await controller.terminate(capture.snapshot);
        const [shellTerminated, childTerminated] = await Promise.all([
            pollUntil(() => !isAlive(shellPid), TERMINATION_TIMEOUT_MS),
            pollUntil(() => !isAlive(measuredChildPid), TERMINATION_TIMEOUT_MS),
        ]);
        measuredSuccess =
            (controllerResult.outcome === 'force_terminated' ||
                controllerResult.outcome === 'gracefully_terminated' ||
                controllerResult.outcome === 'already_terminated') &&
            shellTerminated &&
            childTerminated;
        if (!measuredSuccess) {
            failureStage = shellTerminated && childTerminated
                ? 'termination_outcome'
                : 'process_survived';
        }
    } finally {
        try {
            dataSubscription?.dispose();
        } catch {
            // Cleanup must continue even if listener disposal fails.
        }

		try {
			/**
			 * 외부 process-tree 종료 뒤에도 Windows ConPTY worker와 pipe handle은
			 * node-pty 객체에 남을 수 있다. 측정은 이미 끝났으므로 public kill 경계로
			 * native handle까지 해제한 뒤 최종 생존 검사를 수행한다.
			 */
			pty?.kill();
		} catch {
			/** 이미 종료된 PTY의 handle 해제 실패와 process 생존 검사는 분리한다. */
		}

        const childStopped = childPid === undefined ? true : await stopPid(childPid);
        const groupStopped = pty === undefined ? true : await stopProcessGroup(pty.pid);
        const shellStopped = pty === undefined ? true : await stopPid(pty.pid);
        cleanupSuccess = childStopped && groupStopped && shellStopped;
        if (!cleanupSuccess) {
            failureStage = 'final_cleanup';
        }
    }

    return measuredSuccess && cleanupSuccess;
}

async function main(): Promise<void> {
    let passed = false;

    try {
        passed = await runSmoke();
    } catch {
        passed = false;
    }

    if (passed) {
        console.log('PTY kill smoke: PASS');
        return;
    }

	console.error(`PTY kill smoke: FAIL (${failureStage})`);
    process.exitCode = 1;
}

void main();
