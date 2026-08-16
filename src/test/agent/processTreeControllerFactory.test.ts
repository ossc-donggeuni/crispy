import * as assert from 'assert';
import type {
	CleanupClock,
	CleanupPoller,
} from '../../agent/host/terminal/processTreeCleanupCoordinator';
import type { ProcessTreeController } from '../../agent/host/terminal/processTreeController';
import { createHostProcessTreeController } from '../../agent/host/terminal/processTreeControllerFactory';
import type {
	HostCommandResult,
	HostCommandRunner,
	ProcessIdProbe,
	ProcessIdProbeResult,
} from '../../agent/host/terminal/processTreePlatform';

interface TestCase {
	readonly name: string;
	readonly run: () => Promise<void>;
}

interface CommandCall {
	readonly executable: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
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

class FakeProcessIdProbe implements ProcessIdProbe {
	readonly states = new Map<number, ProcessIdProbeResult>();
	readonly calls: number[] = [];

	async inspect(pid: number): Promise<ProcessIdProbeResult> {
		this.calls.push(pid);
		return this.states.get(pid) ?? { state: 'terminated' };
	}
}

class FakeCommandRunner implements HostCommandRunner {
	readonly calls: CommandCall[] = [];

	constructor(
		private readonly handler: (
			call: CommandCall,
			index: number,
		) => HostCommandResult | Promise<HostCommandResult>,
	) {}

	async run(
		executable: string,
		args: readonly string[],
		timeoutMs: number,
	): Promise<HostCommandResult> {
		const call = { executable, args: [...args], timeoutMs };
		this.calls.push(call);
		return this.handler(call, this.calls.length - 1);
	}
}

function controller(
	platform: NodeJS.Platform,
	commandRunner: HostCommandRunner,
	processIdProbe: ProcessIdProbe,
	clock: CleanupClock = new FakeClock(),
): ProcessTreeController {
	return createHostProcessTreeController({
		readPlatform: () => platform,
		commandRunner,
		processIdProbe,
		clock,
		poller: new FakePoller(),
		timeoutMs: 100,
	});
}

async function captureAndTerminate(
	adapter: ProcessTreeController,
	rootPid: number,
) {
	const capture = await adapter.capture(rootPid);
	assert.strictEqual(capture.status, 'captured');
	if (capture.status !== 'captured') {
		throw new Error('capture failed');
	}
	return {
		capture,
		result: await adapter.terminate(capture.snapshot),
	};
}

const processTable = [
	'4101 1',
	'4102 4101',
	'4103 4102',
	'4104 4101',
].join('\n');

const cases: readonly TestCase[] = [
	{
		name: 'macOS adapter는 snapshot 뒤 TERM을 deepest-first로 보내고 전체 PID를 확인한다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			for (const pid of [4101, 4102, 4103, 4104]) {
				probe.states.set(pid, { state: 'alive' });
			}
			const runner = new FakeCommandRunner((call, index) => {
				if (index === 0) {
					return { status: 'completed', stdout: processTable };
				}
				probe.states.set(Number(call.args.at(-1)), { state: 'terminated' });
				return { status: 'completed', stdout: '' };
			});

			const { capture, result } = await captureAndTerminate(
				controller('darwin', runner, probe),
				4101,
			);

			assert.deepStrictEqual(capture.snapshot, {
				rootPid: 4101,
				descendants: [4103, 4102, 4104],
			});
			assert.deepStrictEqual(result, { outcome: 'gracefully_terminated' });
			assert.deepStrictEqual(
				runner.calls.slice(1).map((call) => call.args),
				[
					['-TERM', '4103'],
					['-TERM', '4102'],
					['-TERM', '4104'],
					['-TERM', '4101'],
				],
			);
		},
	},
	{
		name: 'POSIX graceful 뒤 남은 descendant와 root를 KILL하고 전체를 재검증한다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			for (const pid of [4101, 4102, 4103, 4104]) {
				probe.states.set(pid, { state: 'alive' });
			}
			const runner = new FakeCommandRunner((call, index) => {
				if (index === 0) {
					return { status: 'completed', stdout: processTable };
				}
				if (call.args[0] === '-KILL') {
					probe.states.set(Number(call.args.at(-1)), { state: 'terminated' });
				}
				return { status: 'completed', stdout: '' };
			});

			const { result } = await captureAndTerminate(
				controller('linux', runner, probe),
				4101,
			);

			assert.deepStrictEqual(result, { outcome: 'force_terminated' });
			assert.deepStrictEqual(
				runner.calls.filter((call) => call.args[0] === '-KILL')
					.map((call) => call.args.at(-1)),
				['4103', '4102', '4104', '4101'],
			);
		},
	},
	{
		name: 'Windows는 root taskkill 실패 뒤에도 캡처 descendant를 개별 종료한다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			for (const pid of [4101, 4102, 4103, 4104]) {
				probe.states.set(pid, { state: 'alive' });
			}
			const runner = new FakeCommandRunner((call, index) => {
				if (index === 0) {
					return { status: 'completed', stdout: processTable };
				}
				const targetPid = Number(call.args[1]);
				if (index === 1) {
					/* Root-first race를 재현해 root만 사라지고 descendant는 남긴다. */
					probe.states.set(4101, { state: 'terminated' });
					return { status: 'failed' };
				}
				probe.states.set(targetPid, { state: 'terminated' });
				return { status: 'completed', stdout: '' };
			});

			const { result } = await captureAndTerminate(
				controller('win32', runner, probe),
				4101,
			);

			assert.deepStrictEqual(result, { outcome: 'force_terminated' });
			assert.deepStrictEqual(runner.calls[1].args, [
				'/PID', '4101', '/T', '/F',
			]);
			assert.deepStrictEqual(
				runner.calls.slice(2).map((call) => call.args[1]),
				['4103', '4102', '4104'],
			);
		},
	},
	{
		name: 'root만 종료되고 descendant가 남으면 success로 처리하지 않는다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			probe.states.set(4101, { state: 'terminated' });
			probe.states.set(4102, { state: 'alive' });
			const runner = new FakeCommandRunner((_call, index) => ({
				status: index === 0 ? 'completed' : 'timeout',
				...(index === 0 ? { stdout: '4101 1\n4102 4101' } : {}),
			}) as HostCommandResult);
			const adapter = controller('win32', runner, probe);
			const capture = await adapter.capture(4101);
			assert.strictEqual(capture.status, 'captured');
			if (capture.status !== 'captured') {
				return;
			}

			const result = await adapter.terminate(capture.snapshot);

			assert.notStrictEqual(result.outcome, 'already_terminated');
			assert.notStrictEqual(result.outcome, 'gracefully_terminated');
			assert.notStrictEqual(result.outcome, 'force_terminated');
		},
	},
	{
		name: '잘못된 PID와 command timeout은 명령 추가 실행 없이 allowlist 결과가 된다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			const runner = new FakeCommandRunner(() => ({ status: 'timeout' }));
			const adapter = controller('darwin', runner, probe);

			assert.deepStrictEqual(await adapter.capture(1), {
				status: 'verification_failed',
			});
			assert.deepStrictEqual(await adapter.capture(4101), {
				status: 'timeout',
			});
			assert.strictEqual(runner.calls.length, 1);
			assert.ok(runner.calls[0].timeoutMs > 0);
		},
	},
	{
		name: '모든 외부 명령 timeout은 하나의 controller deadline 이하로 제한된다',
		run: async () => {
			const clock = new FakeClock();
			const probe = new FakeProcessIdProbe();
			probe.states.set(4101, { state: 'alive' });
			const runner = new FakeCommandRunner((call, index) => {
				if (index === 0) {
					clock.current += 40;
					return { status: 'completed', stdout: '4101 1' };
				}
				return { status: 'timeout' };
			});
			const adapter = controller('darwin', runner, probe, clock);

			const capture = await adapter.capture(4101);
			assert.strictEqual(capture.status, 'captured');
			if (capture.status !== 'captured') {
				return;
			}
			await adapter.terminate(capture.snapshot);

			assert.strictEqual(runner.calls[0].timeoutMs, 100);
			assert.ok(runner.calls.slice(1).every((call) => call.timeoutMs <= 60));
		},
	},
	{
		name: '미지원 플랫폼은 외부 명령 없이 안전하게 거부한다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			const runner = new FakeCommandRunner(() => ({
				status: 'completed', stdout: '',
			}));
			const adapter = controller('aix', runner, probe);

			assert.deepStrictEqual(await adapter.capture(4101), {
				status: 'platform_unsupported',
			});
			assert.deepStrictEqual(await adapter.terminate({
				rootPid: 4101,
				descendants: [],
			}), { outcome: 'platform_unsupported' });
			assert.deepStrictEqual(runner.calls, []);
		},
	},
];

if (typeof suite === 'function' && typeof test === 'function') {
	suite('Platform process-tree controller factory', () => {
		for (const testCase of cases) {
			test(testCase.name, testCase.run);
		}
	});
}

async function runDirectly(): Promise<void> {
	for (const testCase of cases) {
		await testCase.run();
	}
	console.log('Process tree adapter tests: PASS');
}

if (require.main === module) {
	void runDirectly().catch(() => {
		console.error('Process tree adapter tests: FAIL');
		process.exitCode = 1;
	});
}
