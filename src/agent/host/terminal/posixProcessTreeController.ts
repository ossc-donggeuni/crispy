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
	readonly gracefulExitMs: number;
	readonly commands: PosixProcessTreeCommands;
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

async function runSignal(
	dependencies: PosixProcessTreeControllerDependencies,
	signal: '-TERM' | '-KILL',
	pid: number,
	deadline: number,
): Promise<CleanupResult | undefined> {
	const timeoutMs = remainingMilliseconds(deadline, dependencies.clock);
	if (timeoutMs <= 0) {
		return { outcome: 'timeout' };
	}

	try {
		return commandFailure(await dependencies.commandRunner.run(
			dependencies.commands.killExecutable,
			[signal, String(pid)],
			timeoutMs,
		));
	} catch {
		return { outcome: 'verification_failed' };
	}
}

async function captureSnapshot(
	dependencies: PosixProcessTreeControllerDependencies,
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
	dependencies: PosixProcessTreeControllerDependencies,
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

	let firstFailure: CleanupResult | undefined;
	for (const pid of initial.pids) {
		const failure = await runSignal(dependencies, '-TERM', pid, deadline);
		firstFailure ??= failure;
	}

	const gracefulTimeoutMs = Math.min(
		dependencies.gracefulExitMs,
		remainingMilliseconds(deadline, dependencies.clock),
	);
	const gracefulVerification = await verifyPidsTerminated(
		terminationOrder,
		{ ...dependencies, timeoutMs: gracefulTimeoutMs },
	);
	if (gracefulVerification.outcome === 'force_terminated') {
		return { outcome: 'gracefully_terminated' };
	}
	if (
		gracefulVerification.outcome === 'permission_denied'
		|| gracefulVerification.outcome === 'verification_failed'
	) {
		return gracefulVerification;
	}

	const remaining = await getAlivePids(
		terminationOrder,
		dependencies.processIdProbe,
	);
	if (remaining.failure !== undefined) {
		return remaining.failure;
	}
	for (const pid of remaining.pids) {
		const failure = await runSignal(dependencies, '-KILL', pid, deadline);
		firstFailure ??= failure;
	}

	const finalVerification = await verifyPidsTerminated(
		terminationOrder,
		{
			...dependencies,
			timeoutMs: remainingMilliseconds(deadline, dependencies.clock),
		},
	);
	if (finalVerification.outcome === 'force_terminated') {
		return finalVerification;
	}
	return firstFailure ?? finalVerification;
}

/** POSIX process table snapshot 뒤 graceful 및 descendant-first force 종료를 수행한다. */
export function createPosixProcessTreeController(
	dependencies: PosixProcessTreeControllerDependencies,
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
