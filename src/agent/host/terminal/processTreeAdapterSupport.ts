import type {
	CleanupClock,
	CleanupPoller,
} from './processTreeCleanupCoordinator';
import type {
	CleanupResult,
	ProcessTreeCaptureResult,
	ProcessTreeSnapshot,
} from './processTreeController';
import type {
	HostCommandResult,
	HostCommandRunner,
	ProcessIdProbe,
	ProcessIdProbeResult,
} from './processTreePlatform';

export interface ProcessTableCommand {
	readonly executable: string;
	readonly args: readonly string[];
}

export type ProcessTreeSnapshotResult =
	| { readonly status: 'completed'; readonly descendants: readonly number[] }
	| { readonly status: 'timeout' }
	| { readonly status: 'permission_denied' }
	| { readonly status: 'platform_unsupported' }
	| { readonly status: 'verification_failed' };

export interface ProcessTerminationVerificationDependencies {
	readonly processIdProbe: ProcessIdProbe;
	readonly clock: CleanupClock;
	readonly poller: CleanupPoller;
	readonly timeoutMs: number;
}

export async function inspectPidSafely(
	probe: ProcessIdProbe,
	pid: number,
): Promise<ProcessIdProbeResult> {
	try {
		const result = await probe.inspect(pid);
		switch (result?.state) {
			case 'alive':
			case 'terminated':
			case 'permission_denied':
			case 'verification_failed':
				return { state: result.state };
			default:
				return { state: 'verification_failed' };
		}
	} catch {
		return { state: 'verification_failed' };
	}
}

export async function readDescendantsDeepestFirst(
	commandRunner: HostCommandRunner,
	command: ProcessTableCommand,
	rootPid: number,
	timeoutMs: number,
): Promise<ProcessTreeSnapshotResult> {
	let result: HostCommandResult;
	try {
		result = await commandRunner.run(
			command.executable,
			command.args,
			timeoutMs,
		);
	} catch {
		return { status: 'verification_failed' };
	}

	if (result.status !== 'completed') {
		return result.status === 'failed'
			? { status: 'verification_failed' }
			: { status: result.status };
	}

	const children = new Map<number, number[]>();
	let validEntryCount = 0;
	for (const line of result.stdout.split(/\r?\n/u)) {
		const match = line.match(/^\s*(\d+)\s+(\d+)\s*$/u);
		if (match === null) {
			continue;
		}

		const pid = Number(match[1]);
		const parentPid = Number(match[2]);
		if (
			!Number.isSafeInteger(pid) ||
			!Number.isSafeInteger(parentPid) ||
			pid <= 1 ||
			parentPid < 0
		) {
			continue;
		}

		const siblings = children.get(parentPid) ?? [];
		siblings.push(pid);
		children.set(parentPid, siblings);
		validEntryCount += 1;
	}
	if (validEntryCount === 0) {
		return { status: 'verification_failed' };
	}

	const descendants: number[] = [];
	const visited = new Set<number>([rootPid]);
	function visit(parentPid: number): void {
		for (const childPid of children.get(parentPid) ?? []) {
			if (visited.has(childPid)) {
				continue;
			}
			visited.add(childPid);
			visit(childPid);
			descendants.push(childPid);
		}
	}
	visit(rootPid);

	return { status: 'completed', descendants };
}

/** Process table adapter 결과를 공개 가능한 snapshot capture 결과로 축약한다. */
export function toProcessTreeCaptureResult(
	rootPid: number,
	result: ProcessTreeSnapshotResult,
): ProcessTreeCaptureResult {
	if (result.status === 'completed') {
		return {
			status: 'captured',
			snapshot: Object.freeze({
				rootPid,
				descendants: Object.freeze([...result.descendants]),
			}),
		};
	}

	return { status: result.status };
}

/** Snapshot이 runtime 소유 PID로만 구성된 안전한 값인지 확인한다. */
export function getValidatedTerminationOrder(
	snapshot: ProcessTreeSnapshot,
): readonly number[] | undefined {
	if (
		snapshot === null
		|| typeof snapshot !== 'object'
		|| !Number.isSafeInteger(snapshot.rootPid)
		|| snapshot.rootPid <= 1
		|| !Array.isArray(snapshot.descendants)
	) {
		return undefined;
	}

	const seen = new Set<number>([snapshot.rootPid]);
	const descendants: number[] = [];
	for (const pid of snapshot.descendants) {
		if (!Number.isSafeInteger(pid) || pid <= 1 || seen.has(pid)) {
			return undefined;
		}
		seen.add(pid);
		descendants.push(pid);
	}

	return [...descendants, snapshot.rootPid];
}

export interface PidSetInspection {
	readonly allTerminated: boolean;
	readonly failure?: CleanupResult;
}

export async function inspectPidSet(
	pids: readonly number[],
	probe: ProcessIdProbe,
): Promise<PidSetInspection> {
	let failure: CleanupResult | undefined;
	for (const pid of pids) {
		const result = await inspectPidSafely(probe, pid);
		if (result.state === 'alive') {
			return { allTerminated: false, failure };
		}
		if (result.state === 'permission_denied') {
			failure = { outcome: 'permission_denied' };
		}
		if (result.state === 'verification_failed' && failure === undefined) {
			failure = { outcome: 'verification_failed' };
		}
	}

	return { allTerminated: failure === undefined, failure };
}

/** 현재 살아 있는 PID만 입력 순서를 유지해 반환한다. */
export async function getAlivePids(
	pids: readonly number[],
	probe: ProcessIdProbe,
): Promise<{
	readonly pids: readonly number[];
	readonly failure?: CleanupResult;
}> {
	const alive: number[] = [];
	let failure: CleanupResult | undefined;
	for (const pid of pids) {
		const result = await inspectPidSafely(probe, pid);
		if (result.state === 'alive') {
			alive.push(pid);
		} else if (result.state === 'permission_denied') {
			failure = { outcome: 'permission_denied' };
		} else if (result.state === 'verification_failed' && failure === undefined) {
			failure = { outcome: 'verification_failed' };
		}
	}

	return { pids: alive, ...(failure === undefined ? {} : { failure }) };
}

export async function verifyPidsTerminated(
	pids: readonly number[],
	dependencies: ProcessTerminationVerificationDependencies,
): Promise<CleanupResult> {
	const uniquePids = [...new Set(pids)];
	try {
		await dependencies.poller.waitUntil(
			async () => {
				const inspection = await inspectPidSet(
					uniquePids,
					dependencies.processIdProbe,
				);
				return inspection.allTerminated || inspection.failure !== undefined;
			},
			dependencies.clock.now() + dependencies.timeoutMs,
			dependencies.clock,
		);
	} catch {
		return { outcome: 'verification_failed' };
	}

	const finalInspection = await inspectPidSet(
		uniquePids,
		dependencies.processIdProbe,
	);
	if (finalInspection.allTerminated) {
		return { outcome: 'force_terminated' };
	}
	return finalInspection.failure ?? { outcome: 'timeout' };
}
