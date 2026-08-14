import * as assert from 'assert';
import type {
	PtyAdapter,
	PtyProcessHandle,
	PtySpawnOptions,
} from '../../agent/host/terminal/ptyAdapter';
import {
	FakePtyAdapter,
} from './support/fakePtyAdapter';

const spawnOptions: PtySpawnOptions = {
	executable: '/validated/shell',
	args: [],
	cwd: '/validated/workspace',
	env: { TERM: 'xterm-256color' },
	cols: 120,
	rows: 40,
};

/** 다음 단계의 TerminalSession과 같은 생성자 주입 경계를 검증하는 test probe다. */
class TerminalSessionPtyProbe {
	constructor(private readonly ptyAdapter: PtyAdapter) {}

	start(options: PtySpawnOptions): PtyProcessHandle {
		return this.ptyAdapter.spawn(options);
	}
}

suite('PTY adapter test fake', () => {
	test('상위 session 계층에 adapter를 주입하고 spawn 계약과 fake PID를 제어한다', () => {
		const adapter = new FakePtyAdapter(7301);
		const session = new TerminalSessionPtyProbe(adapter);

		const process = session.start(spawnOptions);

		assert.strictEqual(adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(adapter.spawnCalls[0], spawnOptions);
		assert.strictEqual(process, adapter.handles[0]);
		assert.strictEqual(process.pid, 7301);
	});

	test('write, resize와 kill 호출을 process handle에 기록한다', () => {
		const adapter = new FakePtyAdapter();
		const process = adapter.spawn(spawnOptions);

		process.write('first input');
		process.write('second input');
		process.resize(80, 24);
		process.resize(160, 50);
		process.kill();
		process.kill();

		assert.deepStrictEqual(process.writes, [
			'first input',
			'second input',
		]);
		assert.deepStrictEqual(process.resizes, [
			{ cols: 80, rows: 24 },
			{ cols: 160, rows: 50 },
		]);
		assert.strictEqual(process.killCallCount, 2);
	});

	test('data와 exit event를 임의 발생시키고 listener를 개별 dispose한다', () => {
		const adapter = new FakePtyAdapter();
		const process = adapter.spawn(spawnOptions);
		const receivedData: string[] = [];
		const receivedExits: Array<{ exitCode: number; signal?: number }> = [];
		const dataSubscription = process.onData((data) => {
			receivedData.push(data);
		});
		const exitSubscription = process.onExit((event) => {
			receivedExits.push(event);
		});

		process.emitData('before dispose');
		process.emitExit({ exitCode: 7, signal: 15 });
		dataSubscription.dispose();
		exitSubscription.dispose();
		dataSubscription.dispose();
		exitSubscription.dispose();
		process.emitData('after dispose');
		process.emitExit({ exitCode: 0 });

		assert.deepStrictEqual(receivedData, ['before dispose']);
		assert.deepStrictEqual(receivedExits, [{ exitCode: 7, signal: 15 }]);
		assert.strictEqual(process.dataListenerCount, 0);
		assert.strictEqual(process.exitListenerCount, 0);
	});

	test('spawn options 기록은 호출자가 이후 변경해도 유지된다', () => {
		const args = ['--host-owned'];
		const env: NodeJS.ProcessEnv = { CRISPY_TEST: 'initial' };
		const adapter = new FakePtyAdapter();

		adapter.spawn({ ...spawnOptions, args, env });
		args.push('--changed');
		env.CRISPY_TEST = 'changed';

		assert.deepStrictEqual(adapter.spawnCalls[0].args, ['--host-owned']);
		assert.deepStrictEqual(adapter.spawnCalls[0].env, {
			CRISPY_TEST: 'initial',
		});
	});
});

