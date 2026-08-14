import * as assert from 'assert';
import {
	NodePtyAdapter,
	PTY_SPAWN_ERROR_CODE,
	PtySpawnError,
	type NodePtyBinding,
} from '../../agent/host/terminal/nodePtyAdapter';
import type {
	PtyExitEvent,
	PtySpawnOptions,
} from '../../agent/host/terminal/ptyAdapter';

const spawnOptions: PtySpawnOptions = {
	executable: '/host/selected/shell',
	args: ['--host-argument'],
	cwd: '/validated/workspace',
	env: { CRISPY_TEST_ENV: 'present' },
	cols: 100,
	rows: 30,
};

suite('Production node-pty adapter', () => {
	test('adapter 생성만으로 native binding을 load하지 않는다', () => {
		let loadCalls = 0;

		const adapter = new NodePtyAdapter(() => {
			loadCalls += 1;
			throw new Error('should only run at spawn');
		});

		assert.ok(adapter);
		assert.strictEqual(loadCalls, 0);
	});

	test('spawn 시점에 binding을 load하고 process 기능과 event를 위임한다', () => {
		let loadCalls = 0;
		const writes: string[] = [];
		const resizes: Array<{ cols: number; rows: number }> = [];
		let killCalls = 0;
		let dataListener: ((data: string) => void) | undefined;
		let exitListener: ((event: PtyExitEvent) => void) | undefined;
		let dataDisposeCalls = 0;
		let exitDisposeCalls = 0;
		const spawnCalls: unknown[][] = [];
		const binding: NodePtyBinding = {
			spawn(executable, args, options) {
				spawnCalls.push([executable, args, options]);
				return {
					pid: 9102,
					write(data) {
						writes.push(data);
					},
					resize(cols, rows) {
						resizes.push({ cols, rows });
					},
					kill() {
						killCalls += 1;
					},
					onData(listener) {
						dataListener = listener;
						return {
							dispose() {
								dataDisposeCalls += 1;
							},
						};
					},
					onExit(listener) {
						exitListener = listener;
						return {
							dispose() {
								exitDisposeCalls += 1;
							},
						};
					},
				};
			},
		};
		const adapter = new NodePtyAdapter(() => {
			loadCalls += 1;
			return binding;
		});

		const process = adapter.spawn(spawnOptions);
		const receivedData: string[] = [];
		const receivedExits: PtyExitEvent[] = [];
		const dataSubscription = process.onData((data) => receivedData.push(data));
		const exitSubscription = process.onExit((event) => receivedExits.push(event));
		process.write('input');
		process.resize(132, 43);
		process.kill();
		dataListener?.('output');
		exitListener?.({ exitCode: 3, signal: 9 });
		dataSubscription.dispose();
		exitSubscription.dispose();

		assert.strictEqual(loadCalls, 1);
		assert.strictEqual(process.pid, 9102);
		assert.deepStrictEqual(spawnCalls, [[
			spawnOptions.executable,
			['--host-argument'],
			{
				cwd: spawnOptions.cwd,
				env: { CRISPY_TEST_ENV: 'present' },
				cols: 100,
				rows: 30,
				encoding: 'utf8',
			},
		]]);
		assert.deepStrictEqual(writes, ['input']);
		assert.deepStrictEqual(resizes, [{ cols: 132, rows: 43 }]);
		assert.strictEqual(killCalls, 1);
		assert.deepStrictEqual(receivedData, ['output']);
		assert.deepStrictEqual(receivedExits, [{ exitCode: 3, signal: 9 }]);
		assert.strictEqual(dataDisposeCalls, 1);
		assert.strictEqual(exitDisposeCalls, 1);
	});

	test('native load/spawn exception을 실행 정보 없는 고정 오류로 바꾼다', () => {
		const sensitiveDetail = '/private/workspace/private-shell';
		const adapter = new NodePtyAdapter(() => {
			throw new Error(`native load failed: ${sensitiveDetail}`);
		});

		assert.throws(
			() => adapter.spawn(spawnOptions),
			(error: unknown) => {
				assert.ok(error instanceof PtySpawnError);
				assert.strictEqual(error.code, PTY_SPAWN_ERROR_CODE);
				assert.strictEqual(error.message.includes(sensitiveDetail), false);
				assert.strictEqual(error.message.includes(spawnOptions.executable), false);
				return true;
			},
		);
	});
});

