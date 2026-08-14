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

export interface PosixProcessTreeCommands {
	readonly processTable: ProcessTableCommand;
	readonly killExecutable: string;
}

export interface PosixProcessTreeControllerDependencies {
	readonly commandRunner: HostCommandRunner;
	readonly processIdProbe: ProcessIdProbe;
	readonly clock: CleanupClock;
	readonly poller: CleanupPoller;
	readonly timeoutMs: number;
	readonly commands: PosixProcessTreeCommands;
}

function isValidPid(pid: number): boolean {
	return Number.isSafeInteger(pid) && pid > 1;
}

function initialProbeFailure(
	state: 'permission_denied' | 'verification_failed',
): CleanupResult {
	return state === 'permission_denied'
		? { outcome: 'permission_denied' }
		: { outcome: 'verification_failed' };
}

async function runKill(
	commandRunner: HostCommandRunner,
	executable: string,
	pid: number,
): Promise<CleanupResult | undefined> {
	let result: HostCommandResult;
	try {
		result = await commandRunner.run(executable, ['-KILL', String(pid)]);
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

/** POSIX process table을 기준으로 descendant-first 종료를 수행한다. */
export function createPosixProcessTreeController(
	dependencies: PosixProcessTreeControllerDependencies,
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
			if (
				initial.state === 'permission_denied' ||
				initial.state === 'verification_failed'
			) {
				return initialProbeFailure(initial.state);
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

			const terminationOrder = [...snapshot.descendants, pid];
			let commandFailure: CleanupResult | undefined;
			for (const targetPid of terminationOrder) {
				const failure = await runKill(
					dependencies.commandRunner,
					dependencies.commands.killExecutable,
					targetPid,
				);
				commandFailure ??= failure;
			}

			const verification = await verifyPidsTerminated(
				terminationOrder,
				dependencies,
			);
			if (verification.outcome === 'force_terminated') {
				return verification;
			}
			return commandFailure ?? verification;
		},
	};
}
