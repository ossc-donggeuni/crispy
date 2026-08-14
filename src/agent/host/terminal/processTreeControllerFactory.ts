import {
	createDeadlineCleanupPoller,
	type CleanupClock,
	type CleanupPoller,
} from './processTreeCleanupCoordinator';
import type { ProcessTreeController } from './processTreeController';
import { createPosixProcessTreeController } from './posixProcessTreeController';
import {
	hostCommandRunner,
	hostProcessIdProbe,
	type HostCommandRunner,
	type ProcessIdProbe,
} from './processTreePlatform';
import { createWindowsProcessTreeController } from './windowsProcessTreeController';

export interface ProcessTreeControllerFactoryOptions {
	readonly readPlatform?: () => NodeJS.Platform;
	readonly commandRunner?: HostCommandRunner;
	readonly processIdProbe?: ProcessIdProbe;
	readonly clock?: CleanupClock;
	readonly poller?: CleanupPoller;
	readonly timeoutMs?: number;
}

const POSIX_PROCESS_TABLE_ARGS = ['-axo', 'pid=,ppid='] as const;
const WINDOWS_PROCESS_TABLE_SCRIPT = [
	'Get-CimInstance Win32_Process',
	"ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
].join(' | ');

/** 실제 시간을 사용하지만 unit test에서 교체 가능한 production clock이다. */
export const hostCleanupClock: CleanupClock = {
	now: () => Date.now(),
	wait: (milliseconds) => new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	}),
};

/**
 * 현재 Extension Host 플랫폼을 한 번 읽어 재사용 가능한 controller를 만든다.
 * 지원하지 않는 플랫폼에서는 외부 명령 없이 안전한 결과만 반환한다.
 */
export function createHostProcessTreeController(
	options: ProcessTreeControllerFactoryOptions = {},
): ProcessTreeController {
	const platform = (options.readPlatform ?? (() => process.platform))();
	const commandRunner = options.commandRunner ?? hostCommandRunner;
	const processIdProbe = options.processIdProbe ?? hostProcessIdProbe;
	const clock = options.clock ?? hostCleanupClock;
	const poller = options.poller ?? createDeadlineCleanupPoller(25);
	const timeoutMs = options.timeoutMs ?? 2_000;

	if (platform === 'darwin' || platform === 'linux') {
		const isDarwin = platform === 'darwin';
		return createPosixProcessTreeController({
			commandRunner,
			processIdProbe,
			clock,
			poller,
			timeoutMs,
			commands: {
				processTable: {
					executable: isDarwin ? '/bin/ps' : '/usr/bin/ps',
					args: POSIX_PROCESS_TABLE_ARGS,
				},
				killExecutable: isDarwin ? '/bin/kill' : '/usr/bin/kill',
			},
		});
	}

	if (platform === 'win32') {
		return createWindowsProcessTreeController({
			commandRunner,
			processIdProbe,
			clock,
			poller,
			timeoutMs,
			commands: {
				processTable: {
					executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
					args: [
						'-NoProfile',
						'-NonInteractive',
						'-Command',
						WINDOWS_PROCESS_TABLE_SCRIPT,
					],
				},
				taskkillExecutable: 'C:\\Windows\\System32\\taskkill.exe',
			},
		});
	}

	return {
		async terminate(): Promise<{ readonly outcome: 'platform_unsupported' }> {
			return { outcome: 'platform_unsupported' };
		},
	};
}
