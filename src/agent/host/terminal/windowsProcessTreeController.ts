import type {
	CleanupClock,
	CleanupPoller,
} from './processTreeCleanupCoordinator';
import type {
	CleanupResult,
	ProcessTreeController,
	ProcessTreeSnapshot,
} from './processTreeController';
import {
	getAlivePids,
	getValidatedTerminationOrder,
	readDescendantsDeepestFirst,
	toProcessTreeCaptureResult,
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

function remainingMilliseconds(deadline: number, clock: CleanupClock): number {
	return Math.max(0, deadline - clock.now());
}

function commandFailure(result: HostCommandResult): CleanupResult | undefined {
	switch (result.status) {
		case 'completed':
			return undefined;
		case 'timeout':
			return { outcome: 'timeout' };
		case 'platform_unsupported':
			return { outcome: 'platform_unsupported' };
		case 'permission_denied':
			return { outcome: 'permission_denied' };
		case 'failed':
			return { outcome: 'verification_failed' };
	}
}

async function runTaskkill(
	dependencies: WindowsProcessTreeControllerDependencies,
	pid: number,
	deadline: number,
): Promise<CleanupResult | undefined> {
	const timeoutMs = remainingMilliseconds(deadline, dependencies.clock);
	if (timeoutMs <= 0) {
		return { outcome: 'timeout' };
	}

	try {
		return commandFailure(await dependencies.commandRunner.run(
			dependencies.commands.taskkillExecutable,
			['/PID', String(pid), '/T', '/F'],
			timeoutMs,
		));
	} catch {
		return { outcome: 'verification_failed' };
	}
}

async function captureSnapshot(
	dependencies: WindowsProcessTreeControllerDependencies,
	rootPid: number,
	deadline: number,
) {
	if (!isValidPid(rootPid)) {
		return { status: 'verification_failed' } as const;
	}

	const result = await readDescendantsDeepestFirst(
		dependencies.commandRunner,
		dependencies.commands.processTable,
		rootPid,
		remainingMilliseconds(deadline, dependencies.clock),
	);
	return toProcessTreeCaptureResult(rootPid, result);
}

async function terminateSnapshot(
	dependencies: WindowsProcessTreeControllerDependencies,
	snapshot: ProcessTreeSnapshot,
	deadline: number,
): Promise<CleanupResult> {
	const terminationOrder = getValidatedTerminationOrder(snapshot);
	if (terminationOrder === undefined) {
		return { outcome: 'verification_failed' };
	}

	const initial = await getAlivePids(
		terminationOrder,
		dependencies.processIdProbe,
	);
	if (initial.failure !== undefined) {
		return initial.failure;
	}
	if (initial.pids.length === 0) {
		return { outcome: 'already_terminated' };
	}

	let firstFailure = await runTaskkill(
		dependencies,
		snapshot.rootPid,
		deadline,
	);

	/** Root가 먼저 사라져 tree taskkill이 실패해도 캡처된 PID를 계속 정리한다. */
	const remaining = await getAlivePids(
		terminationOrder,
		dependencies.processIdProbe,
	);
	if (remaining.failure !== undefined) {
		return remaining.failure;
	}
	for (const pid of remaining.pids) {
		const failure = await runTaskkill(dependencies, pid, deadline);
		firstFailure ??= failure;
	}

	const verification = await verifyPidsTerminated(
		terminationOrder,
		{
			...dependencies,
			timeoutMs: remainingMilliseconds(deadline, dependencies.clock),
		},
	);
	if (verification.outcome === 'force_terminated') {
		return verification;
	}
	return firstFailure ?? verification;
}

/** Windows tree 종료 뒤 캡처된 descendant를 개별 보완하고 전체 PID를 재검증한다. */
export function createWindowsProcessTreeController(
	dependencies: WindowsProcessTreeControllerDependencies,
): ProcessTreeController {
	const deadlines = new WeakMap<ProcessTreeSnapshot, number>();
	return {
		async capture(rootPid) {
			const deadline = dependencies.clock.now() + dependencies.timeoutMs;
			const result = await captureSnapshot(dependencies, rootPid, deadline);
			if (result.status === 'captured') {
				deadlines.set(result.snapshot, deadline);
			}
			return result;
		},
		terminate: (snapshot) => terminateSnapshot(
			dependencies,
			snapshot,
			deadlines.get(snapshot)
				?? dependencies.clock.now() + dependencies.timeoutMs,
		),
	};
}
