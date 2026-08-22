import * as assert from 'assert';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';
import type {
	CleanupResult,
	ProcessTreeCaptureResult,
	ProcessTreeController,
	ProcessTreeSnapshot,
} from '../../agent/host/terminal/processTreeController';
import {
	DETACHED_PID_READY_TIMEOUT_MS,
	TerminalHost,
} from '../../agent/host/terminal/terminalHost';
import type { PrepareTerminalLaunch } from '../../agent/host/terminal/prepareTerminalLaunch';
import {
	createTerminalRuntimeCleanup,
	runCleanupWithTimeout,
	TERMINAL_CLEANUP_TIMEOUT_MS,
	type DetachableTerminalRuntime,
	type TerminalRuntimeSubscription,
} from '../../agent/host/terminal/terminalRuntimeCleanup';
import type { ValidatedWorkspaceFsPath } from '../../agent/host/workspace/types';
import { FakePtyAdapter } from './support/fakePtyAdapter';

const launchPolicy: ShellLaunchPolicy = {
	executable: '/host/selected/shell',
	args: ['--host-owned'],
	cwd: '/validated/workspace' as ValidatedWorkspaceFsPath,
	env: { CRISPY_HOST_ENV: 'present' },
};

const successfulPrepare: PrepareTerminalLaunch = async () => ({
	ok: true,
	policy: launchPolicy,
});

/** 테스트에서 정리 순서를 관찰하기 위한 구독 대체 구현이다. */
function createRecordingSubscription(
	label: string,
	order: string[],
): TerminalRuntimeSubscription {
	return {
		dispose(): void {
			order.push(label);
		},
	};
}

class FakeProcessTreeController implements ProcessTreeController {
	readonly calls: string[] = [];
	result: CleanupResult = { outcome: 'force_terminated' };

	async capture(rootPid: number): Promise<ProcessTreeCaptureResult> {
		this.calls.push(`capture:${rootPid}`);
		return {
			status: 'captured',
			snapshot: { rootPid, descendants: [] },
		};
	}

	async terminate(snapshot: ProcessTreeSnapshot): Promise<CleanupResult> {
		this.calls.push(`terminate:${snapshot.rootPid}`);
		return this.result;
	}
}

suite('Terminal runtime detach/terminate composition', () => {
	test('detach가 runtime routing과 Webview 구독을 동기적으로 먼저 해제한다', () => {
		const order: string[] = [];
		const runtime: DetachableTerminalRuntime = {
			detach: () => order.push('runtime.detach'),
			terminate: () => {
				order.push('runtime.terminate');
			},
		};
		const cleanup = createTerminalRuntimeCleanup(runtime, [
			createRecordingSubscription('subscription-one', order),
			createRecordingSubscription('subscription-two', order),
		]);

		cleanup.detach();

		assert.deepStrictEqual(order, [
			'runtime.detach',
			'subscription-one',
			'subscription-two',
		]);
	});

	test('detach 실패에도 구독을 모두 해제하고 반복 호출은 no-op이다', () => {
		const order: string[] = [];
		let detachCalls = 0;
		const runtime: DetachableTerminalRuntime = {
			detach(): void {
				detachCalls += 1;
				throw new Error('routing detach failed');
			},
			terminate: () => undefined,
		};
		const cleanup = createTerminalRuntimeCleanup(runtime, [
			{
				dispose(): void {
					throw new Error('subscription cleanup failed');
				},
			},
			createRecordingSubscription('subscription-last', order),
		]);

		cleanup.detach();
		cleanup.detach();

		assert.strictEqual(detachCalls, 1);
		assert.deepStrictEqual(order, ['subscription-last']);
	});

	test('pending terminate에서도 listener는 먼저 해제되고 같은 Promise를 재사용한다', async () => {
		const order: string[] = [];
		let release = (): void => undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const cleanup = createTerminalRuntimeCleanup({
			detach: () => order.push('detach'),
			terminate: () => pending,
		}, [createRecordingSubscription('subscription', order)]);

		const first = cleanup.terminate();
		const duplicate = cleanup.terminate();

		assert.strictEqual(duplicate, first);
		assert.deepStrictEqual(order, ['detach', 'subscription']);
		release();
		await first;
	});

	test('terminate 실패는 호출자에게 원문을 전파하지 않는다', async () => {
		const cleanup = createTerminalRuntimeCleanup({
			detach: () => undefined,
			terminate: async () => {
				throw new Error('sensitive termination error');
			},
		}, []);

		await cleanup.terminate();
	});
});

suite('Panel dispose cleanup with fake PTY', () => {
	test('detach는 PTY kill/외부 명령 없이 input·resize·output과 listener를 차단한다', async () => {
		const adapter = new FakePtyAdapter();
		const controller = new FakeProcessTreeController();
		const messages: unknown[] = [];
		const host = new TerminalHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			emitMessage: (message) => messages.push(message),
			processTreeController: controller,
		});
		let messageSubscriptionDisposed = false;
		const cleanup = createTerminalRuntimeCleanup(host, [{
			dispose(): void {
				messageSubscriptionDisposed = true;
			},
		}]);

		await host.startSession('tab-panel-dispose', 80, 24);
		const session = host.getActiveSession('tab-panel-dispose');
		assert.ok(session);
		const handle = adapter.handles[0];
		const messageCountBeforeDetach = messages.length;

		cleanup.detach();
		host.routeInput({
			type: 'terminal.input',
			tabId: 'tab-panel-dispose',
			sessionId: session.sessionId,
			data: 'blocked input',
		});
		host.routeResize({
			type: 'terminal.resize',
			tabId: 'tab-panel-dispose',
			sessionId: session.sessionId,
			cols: 120,
			rows: 40,
		});
		handle.emitData('blocked output');
		await Promise.resolve();

		assert.deepStrictEqual(session.state, { kind: 'disposed' });
		assert.strictEqual(handle.killCallCount, 0);
		assert.strictEqual(handle.writes.length, 0);
		assert.strictEqual(handle.resizes.length, 0);
		assert.strictEqual(handle.dataListenerCount, 0);
		assert.strictEqual(handle.exitListenerCount, 0);
		assert.strictEqual(messageSubscriptionDisposed, true);
		assert.strictEqual(host.getActiveSession('tab-panel-dispose'), undefined);
		assert.strictEqual(messages.length, messageCountBeforeDetach);
		assert.deepStrictEqual(controller.calls, []);

		await cleanup.terminate();
		assert.deepStrictEqual(controller.calls, ['capture:4242', 'terminate:4242']);
		assert.strictEqual(handle.killCallCount, 0);
	});

	test('Panel을 유지하는 동안에는 PTY와 session이 그대로 살아 있다', async () => {
		const adapter = new FakePtyAdapter();
		const host = new TerminalHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			emitMessage: () => undefined,
		});
		createTerminalRuntimeCleanup(host, []);

		await host.startSession('tab-panel-hidden', 80, 24);
		const session = host.getActiveSession('tab-panel-hidden');
		assert.ok(session);
		const handle = adapter.handles[0];

		assert.strictEqual(session.state.kind, 'running');
		assert.strictEqual(handle.killCallCount, 0);
		assert.strictEqual(handle.dataListenerCount, 1);
		assert.strictEqual(handle.exitListenerCount, 1);
		assert.strictEqual(host.getActiveSession('tab-panel-hidden'), session);
		assert.strictEqual(adapter.spawnCalls.length, 1);
	});

	test('PID가 0인 ConPTY를 detach해도 handle을 보존하고 준비된 tree를 종료한다', async () => {
		const adapter = new FakePtyAdapter(0);
		const controller = new FakeProcessTreeController();
		const messages: unknown[] = [];
		const host = new TerminalHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			emitMessage: (message) => messages.push(message),
			processTreeController: controller,
		});
		const cleanup = createTerminalRuntimeCleanup(host, []);
		const starting = host.startSession('tab-delayed-panel-dispose', 80, 24);
		await waitUntil(() => adapter.handles.length === 1);
		const session = host.getActiveSession('tab-delayed-panel-dispose');
		assert.ok(session !== undefined);
		const handle = adapter.handles[0];

		cleanup.detach();
		const terminating = cleanup.terminate();
		assert.deepStrictEqual(session.state, { kind: 'disposed' });
		assert.strictEqual(handle.killCallCount, 0);
		assert.deepStrictEqual(controller.calls, []);

		handle.setReadyPid(4343);
		await Promise.all([starting, terminating]);

		assert.deepStrictEqual(controller.calls, ['capture:4343', 'terminate:4343']);
		assert.strictEqual(handle.killCallCount, 0);
		assert.strictEqual(host.getActiveSession('tab-delayed-panel-dispose'), undefined);
		assert.strictEqual(messages.some(
			(message) => typeof message === 'object'
				&& message !== null
				&& 'type' in message
				&& message.type === 'terminal.started',
		), false);
	});

	test('detach PID 대기는 종료 전용 상한 뒤 root kill로 fallback한다', async () => {
		const adapter = new FakePtyAdapter(0);
		const controller = new FakeProcessTreeController();
		const host = new TerminalHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			emitMessage: () => undefined,
			processTreeController: controller,
		});
		const cleanup = createTerminalRuntimeCleanup(host, []);
		const starting = host.startSession('tab-delayed-cleanup-timeout', 80, 24);
		await waitUntil(() => adapter.handles.length === 1);
		const handle = adapter.handles[0];

		cleanup.detach();
		const terminating = cleanup.terminate();
		await waitUntil(() => handle.readyPidWaitTimeouts.length === 2);
		assert.deepStrictEqual(handle.readyPidWaitTimeouts, [
			undefined,
			DETACHED_PID_READY_TIMEOUT_MS,
		]);

		handle.rejectReadyPid();
		await Promise.all([starting, terminating]);

		assert.strictEqual(DETACHED_PID_READY_TIMEOUT_MS, 500);
		assert.strictEqual(handle.killCallCount, 1);
		assert.deepStrictEqual(controller.calls, []);
	});

	test('detach 중 완료된 launch 준비가 새 PTY나 routing을 다시 만들지 않는다', async () => {
		const adapter = new FakePtyAdapter();
		let finishPreparation!: (
			result: Awaited<ReturnType<PrepareTerminalLaunch>>,
		) => void;
		const pendingPreparation = new Promise<
			Awaited<ReturnType<PrepareTerminalLaunch>>
		>((resolve) => {
			finishPreparation = resolve;
		});
		const host = new TerminalHost({
			ptyAdapter: adapter,
			prepareLaunch: () => pendingPreparation,
			emitMessage: () => undefined,
		});

		const starting = host.startSession('tab-detach-during-prepare', 80, 24);
		await Promise.resolve();
		host.detach();
		finishPreparation({ ok: true, policy: launchPolicy });
		await starting;

		assert.strictEqual(adapter.spawnCalls.length, 0);
		assert.strictEqual(host.getActiveSession('tab-detach-during-prepare'), undefined);
	});
});

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('test condition timed out');
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

suite('Terminal cleanup timeout', () => {
	test('기본 상한 시간이 Extension 종료를 막지 않는 3초다', () => {
		assert.strictEqual(TERMINAL_CLEANUP_TIMEOUT_MS, 3000);
	});

	test('정리가 끝나면 상한 시간을 기다리지 않고 반환한다', async () => {
		let cleanupCalls = 0;
		await runCleanupWithTimeout(() => {
			cleanupCalls += 1;
		}, 60_000);
		assert.strictEqual(cleanupCalls, 1);
	});

	test('정리가 끝나지 않아도 상한 시간 뒤 정상적으로 반환한다', async () => {
		let released = (): void => undefined;
		const pendingCleanup = new Promise<void>((resolve) => {
			released = resolve;
		});

		await runCleanupWithTimeout(() => pendingCleanup, 10);

		released();
		await pendingCleanup;
	});

	test('정리 중 동기 및 비동기 오류를 호출자에게 전파하지 않는다', async () => {
		await runCleanupWithTimeout(() => {
			throw new Error('sync cleanup failed');
		}, 10);
		await runCleanupWithTimeout(async () => {
			throw new Error('async cleanup failed');
		}, 10);
	});
});
