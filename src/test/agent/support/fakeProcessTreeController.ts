import type {
	CleanupResult,
	ProcessTreeCaptureResult,
	ProcessTreeController,
	ProcessTreeSnapshot,
} from '../../../agent/host/terminal/processTreeController';

export interface FakeProcessTreeControllerOptions {
	readonly captureStatus?: Exclude<
		ProcessTreeCaptureResult['status'],
		'captured'
	>;
	readonly terminationResult?: CleanupResult;
	readonly beforeTerminate?: () => void | Promise<void>;
}

/** TerminalHost lifecycle 테스트에서 외부 process 명령 없이 tree cleanup을 기록한다. */
export class FakeProcessTreeController implements ProcessTreeController {
	readonly calls: string[] = [];

	constructor(
		private readonly options: FakeProcessTreeControllerOptions = {},
	) {}

	async capture(rootPid: number): Promise<ProcessTreeCaptureResult> {
		this.calls.push(`capture:${rootPid}`);
		if (this.options.captureStatus !== undefined) {
			return { status: this.options.captureStatus };
		}
		return {
			status: 'captured',
			snapshot: { rootPid, descendants: [rootPid + 1] },
		};
	}

	async terminate(snapshot: ProcessTreeSnapshot): Promise<CleanupResult> {
		this.calls.push(`terminate:${snapshot.rootPid}`);
		await this.options.beforeTerminate?.();
		return this.options.terminationResult ?? { outcome: 'force_terminated' };
	}
}

/** 기존 root-kill fallback 단언이 OS process table에 의존하지 않게 하는 controller다. */
export function createCaptureFailureProcessTreeController(): ProcessTreeController {
	return new FakeProcessTreeController({
		captureStatus: 'verification_failed',
	});
}
