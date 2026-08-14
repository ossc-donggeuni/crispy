import {
	CLEANUP_OUTCOMES,
	type CleanupResult,
	type ProcessTreeController,
} from './processTreeController';

/** Coordinator가 process 또는 descendant 생존을 확인한 안전한 내부 상태다. */
export type ProcessTreeProbeResult =
	| { readonly state: 'alive' }
	| { readonly state: 'terminated' }
	| { readonly state: 'permission_denied' }
	| { readonly state: 'platform_unsupported' }
	| { readonly state: 'verification_failed' };

/** Shell PID와 descendant의 실제 생존 상태를 확인하는 Host 내부 probe다. */
export interface ProcessTreeProbe {
	inspect(pid: number): Promise<ProcessTreeProbeResult>;
}

/** PTY에 정상 종료를 요청하는 Host 내부 포트다. */
export interface PtyTerminationRequester {
	requestExit(): void | Promise<void>;
}

/** PTY exit event가 관찰됐는지 읽는 Host 내부 포트다. */
export interface PtyExitProbe {
	hasExited(): boolean | Promise<boolean>;
}

/** Deadline 계산과 polling 대기를 교체할 수 있게 하는 clock이다. */
export interface CleanupClock {
	now(): number;
	wait(milliseconds: number): Promise<void>;
}

/** Deadline까지 조건을 polling하는 교체 가능한 Host 내부 포트다. */
export interface CleanupPoller {
	waitUntil(
		condition: () => boolean | Promise<boolean>,
		deadline: number,
		clock: CleanupClock,
	): Promise<boolean>;
}

/** Graceful exit와 강제 종료 확인에 사용하는 제한 시간이다. */
export interface ProcessTreeCleanupTimeouts {
	readonly gracefulExitMs: number;
	readonly forceExitMs: number;
}

/** Session 하나에 바인딩되는 cleanup coordinator 계약이다. */
export interface ProcessTreeCleanupCoordinator {
	cleanup(): Promise<CleanupResult>;
}

/** Coordinator 생성 시 Extension Host가 독점 제공하는 의존성이다. */
export interface ProcessTreeCleanupDependencies {
	readonly pid: number;
	readonly ptyTerminationRequester: PtyTerminationRequester;
	readonly ptyExitProbe: PtyExitProbe;
	readonly processTreeProbe: ProcessTreeProbe;
	readonly processTreeController: ProcessTreeController;
	readonly clock: CleanupClock;
	readonly poller: CleanupPoller;
	readonly timeouts: ProcessTreeCleanupTimeouts;
}

const cleanupOutcomes = new Set(CLEANUP_OUTCOMES);

function isValidPid(pid: number): boolean {
	return Number.isSafeInteger(pid) && pid > 1;
}

function isValidTimeout(value: number): boolean {
	return Number.isFinite(value) && value >= 0;
}

function sanitizeControllerResult(result: CleanupResult): CleanupResult {
	if (
		result !== null &&
		typeof result === 'object' &&
		'outcome' in result &&
		cleanupOutcomes.has(result.outcome)
	) {
		return { outcome: result.outcome };
	}

	return { outcome: 'verification_failed' };
}

function probeFailureResult(
	probe: ProcessTreeProbeResult,
): CleanupResult | undefined {
	switch (probe.state) {
		case 'permission_denied':
			return { outcome: 'permission_denied' };
		case 'platform_unsupported':
			return { outcome: 'platform_unsupported' };
		case 'verification_failed':
			return { outcome: 'verification_failed' };
		default:
			return undefined;
	}
}

async function inspectSafely(
	probe: ProcessTreeProbe,
	pid: number,
): Promise<ProcessTreeProbeResult> {
	try {
		const result = await probe.inspect(pid);
		switch (result?.state) {
			case 'alive':
			case 'terminated':
			case 'permission_denied':
			case 'platform_unsupported':
			case 'verification_failed':
				return { state: result.state };
			default:
				return { state: 'verification_failed' };
		}
	} catch {
		return { state: 'verification_failed' };
	}
}

function failureAfterForce(
	controllerResult: CleanupResult,
): CleanupResult {
	switch (controllerResult.outcome) {
		case 'permission_denied':
		case 'platform_unsupported':
		case 'verification_failed':
		case 'timeout':
			return { outcome: controllerResult.outcome };
		default:
			return { outcome: 'timeout' };
	}
}

async function runCleanup(
	dependencies: ProcessTreeCleanupDependencies,
): Promise<CleanupResult> {
	const {
		pid,
		ptyTerminationRequester,
		ptyExitProbe,
		processTreeProbe,
		processTreeController,
		clock,
		poller,
		timeouts,
	} = dependencies;

	if (
		!isValidPid(pid) ||
		!isValidTimeout(timeouts.gracefulExitMs) ||
		!isValidTimeout(timeouts.forceExitMs)
	) {
		return { outcome: 'verification_failed' };
	}

	const initialProbe = await inspectSafely(processTreeProbe, pid);
	if (initialProbe.state === 'terminated') {
		return { outcome: 'already_terminated' };
	}
	const initialFailure = probeFailureResult(initialProbe);
	if (initialFailure !== undefined) {
		return initialFailure;
	}

	try {
		await ptyTerminationRequester.requestExit();
	} catch {
		// Process-tree probe와 controller fallback을 계속 수행한다.
	}

	try {
		await poller.waitUntil(
			() => ptyExitProbe.hasExited(),
			clock.now() + timeouts.gracefulExitMs,
			clock,
		);
	} catch {
		// PTY exit 관찰 실패도 실제 process-tree probe로 재확인한다.
	}

	const gracefulProbe = await inspectSafely(processTreeProbe, pid);
	if (gracefulProbe.state === 'terminated') {
		return { outcome: 'gracefully_terminated' };
	}
	const gracefulFailure = probeFailureResult(gracefulProbe);
	if (gracefulFailure !== undefined) {
		return gracefulFailure;
	}

	let controllerResult: CleanupResult;
	try {
		controllerResult = sanitizeControllerResult(
			await processTreeController.terminate(pid),
		);
	} catch {
		controllerResult = { outcome: 'verification_failed' };
	}

	try {
		await poller.waitUntil(
			async () => {
				const probe = await inspectSafely(processTreeProbe, pid);
				return probe.state !== 'alive';
			},
			clock.now() + timeouts.forceExitMs,
			clock,
		);
	} catch {
		return { outcome: 'verification_failed' };
	}

	const finalProbe = await inspectSafely(processTreeProbe, pid);
	if (finalProbe.state === 'terminated') {
		return { outcome: 'force_terminated' };
	}
	const finalFailure = probeFailureResult(finalProbe);
	if (finalFailure !== undefined) {
		return finalFailure;
	}

	return failureAfterForce(controllerResult);
}

/**
 * 같은 session의 중복 cleanup 호출은 최초 Promise와 결과를 재사용한다.
 * 따라서 같은 PID에 PTY 종료나 강제 종료를 두 번 요청하지 않는다.
 */
export function createProcessTreeCleanupCoordinator(
	dependencies: ProcessTreeCleanupDependencies,
): ProcessTreeCleanupCoordinator {
	let cleanupPromise: Promise<CleanupResult> | undefined;

	return {
		cleanup(): Promise<CleanupResult> {
			cleanupPromise ??= runCleanup(dependencies).catch(() => ({
				outcome: 'verification_failed',
			}));
			return cleanupPromise;
		},
	};
}

/** 실제 시간을 사용하는 기본 deadline poller다. */
export function createDeadlineCleanupPoller(
	pollIntervalMs: number,
): CleanupPoller {
	const safePollIntervalMs =
		Number.isFinite(pollIntervalMs) && pollIntervalMs > 0
			? pollIntervalMs
			: 1;

	return {
		async waitUntil(condition, deadline, clock): Promise<boolean> {
			while (true) {
				if (await condition()) {
					return true;
				}

				const remaining = deadline - clock.now();
				if (remaining <= 0) {
					return false;
				}

				await clock.wait(Math.min(safePollIntervalMs, remaining));
			}
		},
	};
}
