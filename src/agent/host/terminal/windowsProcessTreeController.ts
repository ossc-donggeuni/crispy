import type {
	CleanupClock,
	CleanupPoller,
} from './processTreeCleanupCoordinator';
import type {
	CleanupResult,
	ProcessTreeController,
} from './processTreeController';
import {
	inspectPidSafely,
	readDescendantsDeepestFirst,
	verifyPidsTerminated,
	type ProcessTableCommand,
} from './processTreeAdapterSupport';
import type {
	HostCommandResult,
	HostCommandRunner,
	ProcessIdProbe,
} from './processTreePlatform';

export interface WindowsProcessTreeCommands {
	readonly processTable: ProcessTableCommand;
	readonly taskkillExecutable: string;
}

export interface WindowsProcessTreeControllerDependencies {
	readonly commandRunner: HostCommandRunner;
	readonly processIdProbe: ProcessIdProbe;
	readonly clock: CleanupClock;
	readonly poller: CleanupPoller;
	readonly timeoutMs: number;
	readonly commands: WindowsProcessTreeCommands;
}

function isValidPid(pid: number): boolean {
	return Number.isSafeInteger(pid) && pid > 1;
}

async function runTaskkill(
	commandRunner: HostCommandRunner,
	executable: string,
	pid: number,
): Promise<CleanupResult | undefined> {
	let result: HostCommandResult;
	try {
		result = await commandRunner.run(executable, [
			'/PID',
			String(pid),
			'/T',
			'/F',
		]);
	} catch {
		return { outcome: 'verification_failed' };
	}
	switch (result.status) {
		case 'completed':
			return undefined;
		case 'platform_unsupported':
			return { outcome: 'platform_unsupported' };
		case 'permission_denied':
		case 'failed':
			return { outcome: 'permission_denied' };
	}
}

/** Windows의 OS process-tree 종료 기능 뒤에 실제 PID 재확인을 둔다. */
export function createWindowsProcessTreeController(
	dependencies: WindowsProcessTreeControllerDependencies,
): ProcessTreeController {
	return {
		async terminate(pid): Promise<CleanupResult> {
			if (!isValidPid(pid)) {
				return { outcome: 'verification_failed' };
			}

			const initial = await inspectPidSafely(
				dependencies.processIdProbe,
				pid,
			);
			if (initial.state === 'terminated') {
				return { outcome: 'already_terminated' };
			}
			if (initial.state === 'permission_denied') {
				return { outcome: 'permission_denied' };
			}
			if (initial.state === 'verification_failed') {
				return { outcome: 'verification_failed' };
			}

			const snapshot = await readDescendantsDeepestFirst(
				dependencies.commandRunner,
				dependencies.commands.processTable,
				pid,
			);
			if (snapshot.status !== 'completed') {
				return snapshot.status === 'permission_denied'
					? { outcome: 'permission_denied' }
					: snapshot.status === 'platform_unsupported'
						? { outcome: 'platform_unsupported' }
						: { outcome: 'verification_failed' };
			}

			const commandFailure = await runTaskkill(
				dependencies.commandRunner,
				dependencies.commands.taskkillExecutable,
				pid,
			);
			const verification = await verifyPidsTerminated(
				[...snapshot.descendants, pid],
				dependencies,
			);
			if (verification.outcome === 'force_terminated') {
				return verification;
			}
			return commandFailure ?? verification;
		},
	};
}
