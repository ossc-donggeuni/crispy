import * as assert from 'assert';
import type {
	CleanupClock,
	CleanupPoller,
} from '../../agent/host/terminal/processTreeCleanupCoordinator';
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
}

class FakeClock implements CleanupClock {
	now(): number {
		return 100;
	}

	async wait(_milliseconds: number): Promise<void> {}
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
	readonly handler: (
		call: CommandCall,
		index: number,
	) => HostCommandResult | Promise<HostCommandResult>;

	constructor(
		handler: (
			call: CommandCall,
			index: number,
		) => HostCommandResult | Promise<HostCommandResult>,
	) {
		this.handler = handler;
	}

	async run(
		executable: string,
		args: readonly string[],
	): Promise<HostCommandResult> {
		const call = { executable, args: [...args] };
		this.calls.push(call);
		return this.handler(call, this.calls.length - 1);
	}
}

function controller(
	platform: NodeJS.Platform,
	commandRunner: HostCommandRunner,
	processIdProbe: ProcessIdProbe,
) {
	return createHostProcessTreeController({
		readPlatform: () => platform,
		commandRunner,
		processIdProbe,
		clock: new FakeClock(),
		poller: new FakePoller(),
		timeoutMs: 10,
	});
}

const processTable = [
	'4101 1',
	'4102 4101',
	'4103 4102',
	'4104 4101',
].join('\n');

const cases: readonly TestCase[] = [
	{
		name: 'macOS adapter는 descendant deepest-first 뒤 root를 종료하고 재확인한다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			for (const pid of [4101, 4102, 4103, 4104]) {
				probe.states.set(pid, { state: 'alive' });
			}
			const runner = new FakeCommandRunner((call, index) => {
				if (index === 0) {
					return { status: 'completed', stdout: processTable };
				}
				const targetPid = Number(call.args.at(-1));
				probe.states.set(targetPid, { state: 'terminated' });
				return { status: 'completed', stdout: '' };
			});

			const result = await controller('darwin', runner, probe).terminate(4101);

			assert.deepStrictEqual(result, { outcome: 'force_terminated' });
			assert.deepStrictEqual(
				runner.calls.slice(1).map((call) => call.args),
				[
					['-KILL', '4103'],
					['-KILL', '4102'],
					['-KILL', '4104'],
					['-KILL', '4101'],
				],
			);
		},
	},
	{
		name: 'Linux dispatch는 POSIX 명령 계약을 선택한다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			probe.states.set(4101, { state: 'alive' });
			const runner = new FakeCommandRunner((call, index) => {
				if (index === 0) {
					return { status: 'completed', stdout: '4101 1' };
				}
				probe.states.set(4101, { state: 'terminated' });
				return { status: 'completed', stdout: '' };
			});

			const result = await controller('linux', runner, probe).terminate(4101);

			assert.deepStrictEqual(result, { outcome: 'force_terminated' });
			assert.strictEqual(runner.calls.length, 2);
			assert.deepStrictEqual(runner.calls[0].args, ['-axo', 'pid=,ppid=']);
			assert.deepStrictEqual(runner.calls[1].args, ['-KILL', '4101']);
		},
	},
	{
		name: 'Windows dispatch는 OS tree 종료 기능 뒤 캡처 PID를 재확인한다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			for (const pid of [4101, 4102, 4103, 4104]) {
				probe.states.set(pid, { state: 'alive' });
			}
			const runner = new FakeCommandRunner((_call, index) => {
				if (index === 0) {
					return { status: 'completed', stdout: processTable };
				}
				for (const pid of [4101, 4102, 4103, 4104]) {
					probe.states.set(pid, { state: 'terminated' });
				}
				return { status: 'completed', stdout: '' };
			});

			const result = await controller('win32', runner, probe).terminate(4101);

			assert.deepStrictEqual(result, { outcome: 'force_terminated' });
			assert.strictEqual(runner.calls.length, 2);
			assert.deepStrictEqual(runner.calls[1].args, [
				'/PID',
				'4101',
				'/T',
				'/F',
			]);
		},
	},
	{
		name: '잘못된 PID와 이미 종료된 PID에는 명령을 실행하지 않는다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			const runner = new FakeCommandRunner(() => ({
				status: 'completed',
				stdout: '',
			}));
			const adapter = controller('darwin', runner, probe);

			assert.deepStrictEqual(await adapter.terminate(1), {
				outcome: 'verification_failed',
			});
			assert.deepStrictEqual(await adapter.terminate(4101), {
				outcome: 'already_terminated',
			});
			assert.deepStrictEqual(runner.calls, []);
		},
	},
	{
		name: '종료 뒤 PID가 남아 있으면 timeout을 반환한다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			probe.states.set(4101, { state: 'alive' });
			const runner = new FakeCommandRunner((_call, index) => ({
				status: 'completed',
				stdout: index === 0 ? '4101 1' : '',
			}));

			const result = await controller('darwin', runner, probe).terminate(4101);

			assert.deepStrictEqual(result, { outcome: 'timeout' });
		},
	},
	{
		name: '권한 실패와 runner exception을 안전한 결과로 축약한다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			probe.states.set(4101, { state: 'alive' });
			const permissionRunner = new FakeCommandRunner(() => ({
				status: 'permission_denied',
			}));
			const secret = 'raw runner exception should not leak';
			const throwingRunner = new FakeCommandRunner(() => {
				throw new Error(secret);
			});

			const permission = await controller(
				'darwin',
				permissionRunner,
				probe,
			).terminate(4101);
			const failed = await controller(
				'darwin',
				throwingRunner,
				probe,
			).terminate(4101);

			assert.deepStrictEqual(permission, { outcome: 'permission_denied' });
			assert.deepStrictEqual(failed, { outcome: 'verification_failed' });
			assert.strictEqual(JSON.stringify(failed).includes(secret), false);
		},
	},
	{
		name: '미지원 플랫폼은 외부 명령 없이 안전하게 거부한다',
		run: async () => {
			const probe = new FakeProcessIdProbe();
			const runner = new FakeCommandRunner(() => ({
				status: 'completed',
				stdout: '',
			}));

			const result = await controller('aix', runner, probe).terminate(4101);

			assert.deepStrictEqual(result, { outcome: 'platform_unsupported' });
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
