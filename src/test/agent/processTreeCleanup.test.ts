import * as assert from 'assert';
import type {
	CleanupResult,
	ProcessTreeCaptureResult,
	ProcessTreeController,
	ProcessTreeSnapshot,
} from '../../agent/host/terminal/processTreeController';
import {
	createProcessTreeCleanupCoordinator,
	type CleanupClock,
	type CleanupPoller,
	type ProcessTreeCleanupDependencies,
	type PtyExitProbe,
	type PtyTerminationRequester,
} from '../../agent/host/terminal/processTreeCleanupCoordinator';

// @ts-expect-error Cleanup 계약은 protocol 공개 타입이 아니다.
import type { CleanupResult as ProtocolCleanupResult } from '../../agent/protocol';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;
type Assert<Condition extends true> = Condition;

type ControllerCapturesPid = Assert<Equal<
	Parameters<ProcessTreeController['capture']>,
	[rootPid: number]
>>;
type ControllerTerminatesSnapshot = Assert<Equal<
	Parameters<ProcessTreeController['terminate']>,
	[snapshot: ProcessTreeSnapshot]
>>;
type CleanupResultIsExactUnion = Assert<Equal<
	CleanupResult,
	| { readonly outcome: 'gracefully_terminated' }
	| { readonly outcome: 'already_terminated' }
	| { readonly outcome: 'force_terminated' }
	| { readonly outcome: 'timeout' }
	| { readonly outcome: 'permission_denied' }
	| { readonly outcome: 'platform_unsupported' }
	| { readonly outcome: 'verification_failed' }
>>;

interface TestCase {
	readonly name: string;
	readonly run: () => Promise<void>;
}

class FakeClock implements CleanupClock {
	current = 100;
	now(): number {
		return this.current;
	}
	async wait(milliseconds: number): Promise<void> {
		this.current += milliseconds;
	}
}

class FakePoller implements CleanupPoller {
	async waitUntil(
		condition: () => boolean | Promise<boolean>,
		_deadline: number,
		_clock: CleanupClock,
	): Promise<boolean> {
		return condition();
	}
}

class FakePty implements PtyTerminationRequester, PtyExitProbe {
	exited = false;
	constructor(private readonly calls: string[]) {}
	requestExit(): void {
		this.calls.push('pty.requestExit');
		this.exited = true;
	}
	hasExited(): boolean {
		this.calls.push('pty.hasExited');
		return this.exited;
	}
}

class FakeController implements ProcessTreeController {
	readonly snapshot: ProcessTreeSnapshot = Object.freeze({
		rootPid: 4101,
		descendants: Object.freeze([4103, 4102]),
	});

	constructor(
		private readonly calls: string[],
		private readonly result: CleanupResult = { outcome: 'force_terminated' },
		private readonly captureResult?: ProcessTreeCaptureResult,
		private readonly error?: unknown,
	) {}

	async capture(rootPid: number): Promise<ProcessTreeCaptureResult> {
		this.calls.push(`capture:${rootPid}`);
		return this.captureResult ?? { status: 'captured', snapshot: this.snapshot };
	}

	async terminate(snapshot: ProcessTreeSnapshot): Promise<CleanupResult> {
		this.calls.push(`terminate:${snapshot.rootPid}:${snapshot.descendants.join(',')}`);
		if (this.error !== undefined) {
			throw this.error;
		}
		return this.result;
	}
}

function dependencies(options: {
	readonly controllerResult?: CleanupResult;
	readonly captureResult?: ProcessTreeCaptureResult;
	readonly controllerError?: unknown;
} = {}): ProcessTreeCleanupDependencies & { readonly calls: string[] } {
	const calls: string[] = [];
	const pty = new FakePty(calls);
	return {
		pid: 4101,
		ptyTerminationRequester: pty,
		ptyExitProbe: pty,
		processTreeController: new FakeController(
			calls,
			options.controllerResult,
			options.captureResult,
			options.controllerError,
		),
		clock: new FakeClock(),
		poller: new FakePoller(),
		timeouts: { gracefulExitMs: 10, forceExitMs: 20 },
		calls,
	};
}

const cases: readonly TestCase[] = [
	{
		name: '어떤 PTY 종료 요청보다 먼저 descendant snapshot을 확보한다',
		run: async () => {
			const deps = dependencies();

			const result = await createProcessTreeCleanupCoordinator(deps).cleanup();

			assert.deepStrictEqual(result, { outcome: 'force_terminated' });
			assert.deepStrictEqual(deps.calls, [
				'capture:4101',
				'pty.requestExit',
				'pty.hasExited',
				'terminate:4101:4103,4102',
			]);
		},
	},
	{
		name: 'snapshot 전체가 graceful 요청으로 종료됐을 때만 graceful success다',
		run: async () => {
			const deps = dependencies({
				controllerResult: { outcome: 'already_terminated' },
			});

			const result = await createProcessTreeCleanupCoordinator(deps).cleanup();

			assert.deepStrictEqual(result, { outcome: 'gracefully_terminated' });
		},
	},
	{
		name: 'snapshot timeout이면 PTY와 종료 명령을 호출하지 않는다',
		run: async () => {
			const deps = dependencies({ captureResult: { status: 'timeout' } });

			const result = await createProcessTreeCleanupCoordinator(deps).cleanup();

			assert.deepStrictEqual(result, { outcome: 'timeout' });
			assert.deepStrictEqual(deps.calls, ['capture:4101']);
		},
	},
	{
		name: 'controller 오류는 원문 없는 verification 실패로 변환한다',
		run: async () => {
			const secret = 'raw controller exception should not leak';
			const deps = dependencies({ controllerError: new Error(secret) });

			const result = await createProcessTreeCleanupCoordinator(deps).cleanup();

			assert.deepStrictEqual(result, { outcome: 'verification_failed' });
			assert.strictEqual(JSON.stringify(result).includes(secret), false);
		},
	},
	{
		name: '중복 cleanup은 같은 Promise와 snapshot을 재사용한다',
		run: async () => {
			const deps = dependencies();
			const coordinator = createProcessTreeCleanupCoordinator(deps);

			const first = coordinator.cleanup();
			const duplicate = coordinator.cleanup();
			assert.strictEqual(duplicate, first);
			await Promise.all([first, duplicate]);

			assert.strictEqual(
				deps.calls.filter((call) => call === 'capture:4101').length,
				1,
			);
			assert.strictEqual(
				deps.calls.filter((call) => call.startsWith('terminate:')).length,
				1,
			);
		},
	},
];

if (typeof suite === 'function' && typeof test === 'function') {
	suite('Process-tree cleanup coordinator', () => {
		for (const testCase of cases) {
			test(testCase.name, testCase.run);
		}
	});
}

async function runDirectly(): Promise<void> {
	for (const testCase of cases) {
		await testCase.run();
	}
	console.log('Process tree cleanup tests: PASS');
}

if (require.main === module) {
	void runDirectly().catch(() => {
		console.error('Process tree cleanup tests: FAIL');
		process.exitCode = 1;
	});
}
