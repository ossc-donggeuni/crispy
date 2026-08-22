import * as assert from 'assert';
import {
	TerminalProcessExitedBeforeReadyError,
	TerminalSession,
	TerminalSessionStateError,
	type TerminalSessionStateErrorCode,
} from '../../agent/host/terminal/terminalSession';
import type {
	PtyAdapter,
	PtyExitEvent,
	PtyListenerDisposable,
} from '../../agent/host/terminal/ptyAdapter';
import {
	FakePtyAdapter,
	FakePtyProcessHandle,
} from './support/fakePtyAdapter';

const launchPolicy = {
	executable: '/host/selected/shell',
	args: ['--host-owned'],
	cwd: '/validated/workspace',
	env: { CRISPY_TERMINAL_TEST: 'enabled' },
} as const;

function createSession(): {
	readonly adapter: FakePtyAdapter;
	readonly session: TerminalSession;
	readonly outputs: string[];
	readonly exits: PtyExitEvent[];
} {
	const adapter = new FakePtyAdapter(8101);
	const outputs: string[] = [];
	const exits: PtyExitEvent[] = [];
	let session!: TerminalSession;
	session = new TerminalSession({
		tabId: 'tab-state-test',
		sessionId: 'session-state-test',
		ptyAdapter: adapter,
		onOutput: (data) => outputs.push(data),
		onRunning: () => undefined,
		onExit: (event) => {
			exits.push(event);
			session.markExited(event.exitCode, event.signal ?? null);
		},
	});
	return {
		adapter,
		session,
		outputs,
		exits,
	};
}

function assertStateError(
	action: () => void,
	code: TerminalSessionStateErrorCode,
): void {
	assert.throws(action, (error: unknown) => {
		assert.ok(error instanceof TerminalSessionStateError);
		assert.strictEqual(error.code, code);
		return true;
	});
}

suite('TerminalSession state model', () => {
	test('Host identity와 idle 상태를 생성 후 변경하지 않는다', () => {
		const { adapter, session } = createSession();

		assert.strictEqual(session.tabId, 'tab-state-test');
		assert.strictEqual(session.sessionId, 'session-state-test');
		assert.deepStrictEqual(session.state, { kind: 'idle' });
		assert.strictEqual(Object.isFrozen(session.state), true);
		assert.strictEqual(adapter.spawnCalls.length, 0);
	});

	test('idle부터 exited까지 정상 상태와 PID를 순서대로 보존한다', () => {
		const { adapter, session } = createSession();

		session.markStarting();
		assert.deepStrictEqual(session.state, { kind: 'starting' });

		session.markRunning(8101);
		assert.deepStrictEqual(session.state, { kind: 'running', pid: 8101 });

		session.markStopping();
		assert.deepStrictEqual(session.state, { kind: 'stopping', pid: 8101 });

		session.markExited(0, null);
		assert.deepStrictEqual(session.state, {
			kind: 'exited',
			exitCode: 0,
			signal: null,
		});
		assert.strictEqual(Object.isFrozen(session.state), true);
		assert.strictEqual(session.tabId, 'tab-state-test');
		assert.strictEqual(session.sessionId, 'session-state-test');
		assert.strictEqual(adapter.spawnCalls.length, 0);
	});

	test('starting 상태에서 Host policy로 PTY를 spawn하고 handle과 PID를 소유한다', () => {
		const { adapter, session } = createSession();
		session.markStarting();

		session.start(launchPolicy, 132, 43);

		assert.deepStrictEqual(adapter.spawnCalls, [{
			...launchPolicy,
			args: ['--host-owned'],
			env: { CRISPY_TERMINAL_TEST: 'enabled' },
			cols: 132,
			rows: 43,
		}]);
		assert.deepStrictEqual(session.state, { kind: 'running', pid: 8101 });
		assert.strictEqual(adapter.handles[0].dataListenerCount, 1);
		assert.strictEqual(adapter.handles[0].exitListenerCount, 1);
	});

	test('Windows delayed PID가 준비될 때까지 starting을 유지한 뒤 running으로 전환한다', async () => {
		const adapter = new FakePtyAdapter(0);
		const outputs: string[] = [];
		let runningCalls = 0;
		const session = new TerminalSession({
			tabId: 'tab-delayed-pid',
			sessionId: 'session-delayed-pid',
			ptyAdapter: adapter,
			onOutput: (data) => outputs.push(data),
			onExit: () => undefined,
			onRunning: () => {
				runningCalls += 1;
			},
		});
		session.markStarting();

		const starting = session.start(launchPolicy, 80, 24);
		const handle = adapter.handles[0];
		assert.deepStrictEqual(session.state, { kind: 'starting' });
		handle.emitData('PowerShell prompt');
		assert.deepStrictEqual(outputs, []);

		handle.setReadyPid(8401);
		await starting;
		await Promise.resolve();

		assert.deepStrictEqual(session.state, { kind: 'running', pid: 8401 });
		assert.strictEqual(runningCalls, 1);
		assert.deepStrictEqual(outputs, ['PowerShell prompt']);
	});

	test('listener 등록 도중 실패하면 이미 생성한 PTY와 구독을 되돌린다', () => {
		class ExitListenerFailingHandle extends FakePtyProcessHandle {
			override onExit(): PtyListenerDisposable {
				throw new Error('fake exit listener registration failed');
			}
		}
		const handle = new ExitListenerFailingHandle(8501);
		const adapter: PtyAdapter = { spawn: () => handle };
		const session = new TerminalSession({
			tabId: 'tab-listener-failure',
			sessionId: 'session-listener-failure',
			ptyAdapter: adapter,
			onOutput: () => undefined,
			onExit: () => undefined,
			onRunning: () => undefined,
		});
		session.markStarting();

		assert.throws(
			() => session.start(launchPolicy, 80, 24),
			/fake exit listener registration failed/,
		);
		assert.strictEqual(handle.killCallCount, 1);
		assert.strictEqual(handle.dataListenerCount, 0);
		assert.strictEqual(handle.exitListenerCount, 0);
		assert.deepStrictEqual(session.state, { kind: 'starting' });
	});

	test('PID 준비가 실패하면 partial PTY를 종료하고 starting transaction을 되돌린다', async () => {
		const adapter = new FakePtyAdapter(0);
		const session = new TerminalSession({
			tabId: 'tab-pid-failure',
			sessionId: 'session-pid-failure',
			ptyAdapter: adapter,
			onOutput: () => undefined,
			onExit: () => undefined,
			onRunning: () => undefined,
		});
		session.markStarting();
		const starting = session.start(launchPolicy, 80, 24);
		const handle = adapter.handles[0];

		handle.rejectReadyPid();
		await assert.rejects(starting, /fake PTY PID was not ready/);

		assert.strictEqual(handle.killCallCount, 1);
		assert.strictEqual(handle.dataListenerCount, 0);
		assert.strictEqual(handle.exitListenerCount, 0);
		assert.deepStrictEqual(session.state, { kind: 'starting' });
	});

	test('PID 준비 전 process exit은 buffered output과 함께 spawn 실패와 구분한다', async () => {
		const adapter = new FakePtyAdapter(0);
		const session = new TerminalSession({
			tabId: 'tab-exit-before-pid',
			sessionId: 'session-exit-before-pid',
			ptyAdapter: adapter,
			onOutput: () => undefined,
			onExit: () => undefined,
			onRunning: () => undefined,
		});
		session.markStarting();
		const starting = session.start(launchPolicy, 80, 24);
		const handle = adapter.handles[0];
		handle.emitData('Authentication failed before PID readiness.');

		handle.emitExit({ exitCode: 1 });

		await assert.rejects(starting, (error: unknown) => {
			assert.ok(error instanceof TerminalProcessExitedBeforeReadyError);
			assert.deepStrictEqual(error.event, { exitCode: 1 });
			assert.strictEqual(
				error.withBufferedOutput((output) => output),
				'Authentication failed before PID readiness.',
			);
			assert.strictEqual(
				JSON.stringify(error).includes('Authentication failed'),
				false,
			);
			return true;
		});
		assert.strictEqual(handle.killCallCount, 0);
		assert.strictEqual(handle.dataListenerCount, 0);
		assert.strictEqual(handle.exitListenerCount, 0);
		assert.deepStrictEqual(session.state, { kind: 'starting' });
	});

	test('같은 tick의 PTY output을 순서대로 단순 concat해 다음 microtask에 전달한다', async () => {
		const { adapter, outputs, session } = createSession();
		session.markStarting();
		session.start(launchPolicy, 80, 24);

		adapter.handles[0].emitData('  hello\r\n');
		adapter.handles[0].emitData('\x1b[31m한글🙂\x1b[0m');
		adapter.handles[0].emitData('');
		assert.deepStrictEqual(outputs, []);

		await Promise.resolve();

		assert.deepStrictEqual(outputs, [
			'  hello\r\n\x1b[31m한글🙂\x1b[0m',
		]);
	});

	test('PTY exit을 상태에 저장하고 pending output 뒤 listener를 정리한다', () => {
		const { adapter, exits, outputs, session } = createSession();
		session.markStarting();
		session.start(launchPolicy, 80, 24);
		const handle = adapter.handles[0];
		handle.emitData('last-output');

		handle.emitExit({ exitCode: 7, signal: 15 });

		assert.deepStrictEqual(outputs, ['last-output']);
		assert.deepStrictEqual(exits, [{ exitCode: 7, signal: 15 }]);
		assert.deepStrictEqual(session.state, {
			kind: 'exited',
			exitCode: 7,
			signal: 15,
		});
		assert.strictEqual(handle.dataListenerCount, 0);
		assert.strictEqual(handle.exitListenerCount, 0);
	});

	test('starting 전에는 PTY spawn을 호출하지 않는다', () => {
		const { adapter, session } = createSession();

		assertStateError(
			() => session.start(launchPolicy, 80, 24),
			'invalid_transition',
		);

		assert.deepStrictEqual(session.state, { kind: 'idle' });
		assert.strictEqual(adapter.spawnCalls.length, 0);
	});

	test('running이 아닌 모든 상태에서 input과 resize를 PTY에 전달하지 않는다', () => {
		const cases: Array<{
			readonly name: string;
			readonly prepare: (session: TerminalSession) => void;
		}> = [
			{ name: 'idle', prepare: () => undefined },
			{
				name: 'starting',
				prepare: (session) => session.markStarting(),
			},
			{
				name: 'stopping',
				prepare: (session) => {
					session.markStarting();
					session.start(launchPolicy, 80, 24);
					session.markStopping();
				},
			},
			{
				name: 'exited',
				prepare: (session) => {
					session.markStarting();
					session.start(launchPolicy, 80, 24);
					session.markStopping();
					session.markExited(0, null);
				},
			},
			{
				name: 'error',
				prepare: (session) => {
					session.markStarting();
					session.start(launchPolicy, 80, 24);
					session.markError('internal_error');
				},
			},
			{
				name: 'disposed',
				prepare: (session) => {
					session.markStarting();
					session.start(launchPolicy, 80, 24);
					session.markDisposed();
				},
			},
		];

		for (const testCase of cases) {
			const { adapter, session } = createSession();
			testCase.prepare(session);

			session.writeInput(`sensitive-${testCase.name}`);
			session.resize(120, 40);

			for (const handle of adapter.handles) {
				assert.deepStrictEqual(handle.writes, []);
				assert.deepStrictEqual(handle.resizes, []);
			}
		}
	});

	test('starting, running과 stopping에서 안전한 error 상태로 전이한다', () => {
		const starting = createSession().session;
		starting.markStarting();
		starting.markError('start_failed');
		assert.deepStrictEqual(starting.state, {
			kind: 'error',
			code: 'start_failed',
		});

		const running = createSession().session;
		running.markStarting();
		running.markRunning(8102);
		running.markError('internal_error');
		assert.deepStrictEqual(running.state, {
			kind: 'error',
			code: 'internal_error',
		});

		const stopping = createSession().session;
		stopping.markStarting();
		stopping.markRunning(8103);
		stopping.markStopping();
		stopping.markError('cleanup_failed');
		assert.deepStrictEqual(stopping.state, {
			kind: 'error',
			code: 'cleanup_failed',
		});
	});

	test('순서를 건너뛴 상태 전이와 exited에서 running 직접 전이를 거부한다', () => {
		const idle = createSession().session;
		assertStateError(() => idle.markRunning(8101), 'invalid_transition');
		assert.deepStrictEqual(idle.state, { kind: 'idle' });

		const exited = createSession().session;
		exited.markStarting();
		exited.markRunning(8101);
		exited.markStopping();
		exited.markExited(0, null);
		assertStateError(
			() => exited.markRunning(8102),
			'invalid_transition',
		);
		assert.strictEqual(exited.state.kind, 'exited');
	});

	test('running 상태에 유효하지 않은 PID를 기록하지 않는다', () => {
		for (const pid of [0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const session = createSession().session;
			session.markStarting();

			assertStateError(() => session.markRunning(pid), 'invalid_pid');
			assert.deepStrictEqual(session.state, { kind: 'starting' });
		}
	});

	test('잘못된 exit payload와 allowlist 밖 error code를 상태에 저장하지 않는다', () => {
		const exiting = createSession().session;
		exiting.markStarting();
		exiting.markRunning(8101);
		exiting.markStopping();
		assertStateError(
			() => exiting.markExited(Number.NaN, null),
			'invalid_exit_event',
		);
		assert.strictEqual(exiting.state.kind, 'stopping');

		const failing = createSession().session;
		failing.markStarting();
		assertStateError(
			() => failing.markError('raw-native-error' as 'start_failed'),
			'invalid_error_code',
		);
		assert.strictEqual(failing.state.kind, 'starting');
	});

	test('disposed는 최종 상태이며 반복 dispose 외의 전이를 허용하지 않는다', () => {
		const { adapter, session } = createSession();

		session.markDisposed();
		session.markDisposed();

		assert.deepStrictEqual(session.state, { kind: 'disposed' });
		assertStateError(() => session.markStarting(), 'invalid_transition');
		assertStateError(
			() => session.markError('internal_error'),
			'invalid_transition',
		);
		assert.strictEqual(adapter.spawnCalls.length, 0);
	});
});
