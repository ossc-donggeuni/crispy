import * as assert from 'assert';
import {
	TerminalSession,
	TerminalSessionStateError,
	type TerminalSessionStateErrorCode,
} from '../../agent/host/terminal/terminalSession';
import { FakePtyAdapter } from './support/fakePtyAdapter';

function createSession(): {
	readonly adapter: FakePtyAdapter;
	readonly session: TerminalSession;
} {
	const adapter = new FakePtyAdapter(8101);
	return {
		adapter,
		session: new TerminalSession({
			tabId: 'tab-state-test',
			sessionId: 'session-state-test',
			ptyAdapter: adapter,
		}),
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

