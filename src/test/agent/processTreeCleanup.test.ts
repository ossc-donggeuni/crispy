import * as assert from 'assert';
import type {
	CleanupResult,
	ProcessTreeController,
} from '../../agent/host/terminal/processTreeController';
import {
	createProcessTreeCleanupCoordinator,
	type CleanupClock,
	type CleanupPoller,
	type ProcessTreeCleanupDependencies,
	type ProcessTreeProbe,
	type ProcessTreeProbeResult,
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

type ControllerAcceptsOnlyPid = Assert<Equal<
	Parameters<ProcessTreeController['terminate']>,
	[pid: number]
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
	readonly waits: number[] = [];

	now(): number {
		return this.current;
	}

	async wait(milliseconds: number): Promise<void> {
		this.waits.push(milliseconds);
		this.current += milliseconds;
	}
}

class FakePoller implements CleanupPoller {
	readonly deadlines: number[] = [];

	async waitUntil(
		condition: () => boolean | Promise<boolean>,
		deadline: number,
		_clock: CleanupClock,
	): Promise<boolean> {
		this.deadlines.push(deadline);
		return condition();
	}
}

class FakeProcessTreeProbe implements ProcessTreeProbe {
	readonly calls: string[];
	private readonly results: ProcessTreeProbeResult[];
	private lastResult: ProcessTreeProbeResult;

	constructor(calls: string[], results: ProcessTreeProbeResult[]) {
		this.calls = calls;
		this.results = [...results];
		this.lastResult = results.at(-1) ?? { state: 'verification_failed' };
	}

	async inspect(pid: number): Promise<ProcessTreeProbeResult> {
		this.calls.push(`probe:${pid}`);
		this.lastResult = this.results.shift() ?? this.lastResult;
		return this.lastResult;
	}
}

class FakePty implements PtyTerminationRequester, PtyExitProbe {
	readonly calls: string[];
	readonly exitOnRequest: boolean;
	exited = false;

	constructor(calls: string[], exitOnRequest: boolean) {
		this.calls = calls;
		this.exitOnRequest = exitOnRequest;
	}

	requestExit(): void {
		this.calls.push('pty.requestExit');
		this.exited = this.exitOnRequest;
	}

	hasExited(): boolean {
		this.calls.push('pty.hasExited');
		return this.exited;
	}
}

class FakeController implements ProcessTreeController {
	readonly calls: string[];
	private readonly result: CleanupResult;
	private readonly error?: unknown;

	constructor(calls: string[], result: CleanupResult, error?: unknown) {
		this.calls = calls;
		this.result = result;
		this.error = error;
	}

	async terminate(pid: number): Promise<CleanupResult> {
		this.calls.push(`controller:${pid}`);
		if (this.error !== undefined) {
			throw this.error;
		}
		return this.result;
	}
}

function dependencies(
	probeResults: ProcessTreeProbeResult[],
	options: {
		readonly exitOnRequest?: boolean;
		readonly controllerResult?: CleanupResult;
		readonly controllerError?: unknown;
	} = {},
): ProcessTreeCleanupDependencies & {
	readonly calls: string[];
	readonly clock: FakeClock;
	readonly poller: FakePoller;
} {
	const calls: string[] = [];
	const pty = new FakePty(calls, options.exitOnRequest ?? false);
	const clock = new FakeClock();
	const poller = new FakePoller();
	return {
		pid: 4101,
		ptyTerminationRequester: pty,
		ptyExitProbe: pty,
		processTreeProbe: new FakeProcessTreeProbe(calls, probeResults),
		processTreeController: new FakeController(
			calls,
			options.controllerResult ?? { outcome: 'force_terminated' },
			options.controllerError,
		),
		clock,
		poller,
		timeouts: { gracefulExitMs: 10, forceExitMs: 20 },
		calls,
	};
}

const cases: readonly TestCase[] = [
	{
		name: '정상 종료 요청만으로 종료된 process tree를 확인한다',
		run: async () => {
			const deps = dependencies(
				[{ state: 'alive' }, { state: 'terminated' }],
				{ exitOnRequest: true },
			);

			const result = await createProcessTreeCleanupCoordinator(deps).cleanup();

			assert.deepStrictEqual(result, { outcome: 'gracefully_terminated' });
			assert.deepStrictEqual(deps.calls, [
				'probe:4101',
				'pty.requestExit',
				'pty.hasExited',
				'probe:4101',
			]);
			assert.deepStrictEqual(deps.poller.deadlines, [110]);
		},
	},
	{
		name: '이미 종료된 PID에는 종료 요청을 보내지 않는다',
		run: async () => {
			const deps = dependencies([{ state: 'terminated' }]);

			const result = await createProcessTreeCleanupCoordinator(deps).cleanup();

			assert.deepStrictEqual(result, { outcome: 'already_terminated' });
			assert.deepStrictEqual(deps.calls, ['probe:4101']);
		},
	},
	{
		name: 'graceful timeout 뒤 강제 cleanup의 실제 종료를 확인한다',
		run: async () => {
			const deps = dependencies([
				{ state: 'alive' },
				{ state: 'alive' },
				{ state: 'terminated' },
			]);

			const result = await createProcessTreeCleanupCoordinator(deps).cleanup();

			assert.deepStrictEqual(result, { outcome: 'force_terminated' });
			assert.deepStrictEqual(deps.calls, [
				'probe:4101',
				'pty.requestExit',
				'pty.hasExited',
				'probe:4101',
				'controller:4101',
				'probe:4101',
				'probe:4101',
			]);
			assert.deepStrictEqual(deps.poller.deadlines, [110, 120]);
		},
	},
	{
		name: '강제 cleanup 뒤에도 process tree가 생존하면 timeout이다',
		run: async () => {
			const deps = dependencies([
				{ state: 'alive' },
				{ state: 'alive' },
				{ state: 'alive' },
			]);

			const result = await createProcessTreeCleanupCoordinator(deps).cleanup();

			assert.deepStrictEqual(result, { outcome: 'timeout' });
		},
	},
	{
		name: 'controller 오류를 원문 없는 verification 실패로 변환한다',
		run: async () => {
			const secret = 'raw controller exception should not leak';
			const deps = dependencies(
				[
					{ state: 'alive' },
					{ state: 'alive' },
					{ state: 'alive' },
				],
				{ controllerError: new Error(secret) },
			);

			const result = await createProcessTreeCleanupCoordinator(deps).cleanup();

			assert.deepStrictEqual(result, { outcome: 'verification_failed' });
			assert.strictEqual(JSON.stringify(result).includes(secret), false);
		},
	},
	{
		name: '중복 cleanup은 같은 Promise를 재사용하고 두 번째 종료를 막는다',
		run: async () => {
			const deps = dependencies([
				{ state: 'alive' },
				{ state: 'alive' },
				{ state: 'terminated' },
			]);
			const coordinator = createProcessTreeCleanupCoordinator(deps);

			const first = coordinator.cleanup();
			const duplicate = coordinator.cleanup();
			assert.strictEqual(duplicate, first);
			const firstResult = await first;
			const completedDuplicate = await coordinator.cleanup();

			assert.deepStrictEqual(firstResult, { outcome: 'force_terminated' });
			assert.deepStrictEqual(completedDuplicate, firstResult);
			assert.strictEqual(
				deps.calls.filter((call) => call === 'pty.requestExit').length,
				1,
			);
			assert.strictEqual(
				deps.calls.filter((call) => call === 'controller:4101').length,
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
