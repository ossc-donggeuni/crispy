import * as nodePty from 'node-pty';
import { createHostProcessTreeController } from '../../agent/host/terminal/processTreeControllerFactory';

const CHILD_PID_MARKER = '__CRISPY_PTY_SMOKE_CHILD_PID__=';
const STARTUP_TIMEOUT_MS = 2_000;
const GRACEFUL_EXIT_TIMEOUT_MS = 250;
const TERMINATION_TIMEOUT_MS = 2_000;
const CLEANUP_TIMEOUT_MS = 1_000;
const POLL_INTERVAL_MS = 25;

interface SmokeLaunch {
    readonly executable: string;
    readonly args: readonly string[];
}

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
            return false;
        }

        const shellPid = pty.pid;
        const measuredChildPid = childPid;
        pty.kill();

        await Promise.all([
            pollUntil(() => !isAlive(shellPid), GRACEFUL_EXIT_TIMEOUT_MS),
            pollUntil(() => !isAlive(measuredChildPid), GRACEFUL_EXIT_TIMEOUT_MS),
        ]);

        const controllerResult = await createHostProcessTreeController({
            timeoutMs: TERMINATION_TIMEOUT_MS,
        }).terminate(shellPid);
        const [shellTerminated, childTerminated] = await Promise.all([
            pollUntil(() => !isAlive(shellPid), TERMINATION_TIMEOUT_MS),
            pollUntil(() => !isAlive(measuredChildPid), TERMINATION_TIMEOUT_MS),
        ]);
        measuredSuccess =
            (controllerResult.outcome === 'force_terminated' ||
                controllerResult.outcome === 'already_terminated') &&
            shellTerminated &&
            childTerminated;
    } finally {
        try {
            dataSubscription?.dispose();
        } catch {
            // Cleanup must continue even if listener disposal fails.
        }

        const childStopped = childPid === undefined ? true : await stopPid(childPid);
        const groupStopped = pty === undefined ? true : await stopProcessGroup(pty.pid);
        const shellStopped = pty === undefined ? true : await stopPid(pty.pid);
        cleanupSuccess = childStopped && groupStopped && shellStopped;
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

    console.error('PTY kill smoke: FAIL');
    process.exitCode = 1;
}

void main();
