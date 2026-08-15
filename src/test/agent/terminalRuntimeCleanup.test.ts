import * as assert from 'assert';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';
import { TerminalHost } from '../../agent/host/terminal/terminalHost';
import type { PrepareTerminalLaunch } from '../../agent/host/terminal/prepareTerminalLaunch';
import type { ValidatedWorkspaceFsPath } from '../../agent/host/workspace/types';
import {
	createTerminalRuntimeCleanup,
	runCleanupWithTimeout,
	TERMINAL_CLEANUP_TIMEOUT_MS,
	type DisposableTerminalRuntime,
	type TerminalRuntimeSubscription,
} from '../../agent/host/terminal/terminalRuntimeCleanup';
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

suite('Terminal runtime cleanup composition', () => {
	test('terminal runtime을 먼저 정리한 뒤 Webview 구독을 해제한다', async () => {
		const order: string[] = [];
		const runtime: DisposableTerminalRuntime = {
			dispose(): void {
				order.push('runtime');
			},
		};

		await createTerminalRuntimeCleanup(runtime, [
			createRecordingSubscription('subscription-one', order),
			createRecordingSubscription('subscription-two', order),
		])();

		assert.deepStrictEqual(order, [
			'runtime',
			'subscription-one',
			'subscription-two',
		]);
	});

	test('runtime 정리 실패에도 남은 구독을 모두 해제한다', async () => {
		const order: string[] = [];
		const runtime: DisposableTerminalRuntime = {
			dispose(): void {
				throw new Error('pty cleanup failed');
			},
		};

		await createTerminalRuntimeCleanup(runtime, [
			{
				dispose(): void {
					throw new Error('subscription cleanup failed');
				},
			},
			createRecordingSubscription('subscription-last', order),
		])();

		assert.deepStrictEqual(order, ['subscription-last']);
	});

	test('비동기 runtime 정리가 끝난 뒤에 구독을 해제한다', async () => {
		const order: string[] = [];
		const runtime: DisposableTerminalRuntime = {
			async dispose(): Promise<void> {
				await Promise.resolve();
				order.push('runtime');
			},
		};

		await createTerminalRuntimeCleanup(runtime, [
			createRecordingSubscription('subscription', order),
		])();

		assert.deepStrictEqual(order, ['runtime', 'subscription']);
	});
});

suite('Panel dispose cleanup with fake PTY', () => {
	test('Panel 정리 경로가 PTY를 종료하고 Webview 구독까지 해제한다', async () => {
		const adapter = new FakePtyAdapter();
		const host = new TerminalHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			emitMessage: () => undefined,
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

		await cleanup();

		assert.deepStrictEqual(session.state, { kind: 'disposed' });
		assert.strictEqual(handle.killCallCount, 1);
		assert.strictEqual(handle.dataListenerCount, 0);
		assert.strictEqual(handle.exitListenerCount, 0);
		assert.strictEqual(messageSubscriptionDisposed, true);
		assert.strictEqual(host.getActiveSession('tab-panel-dispose'), undefined);
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

		/* Panel hide/reveal은 정리 경로를 호출하지 않으므로 상태가 변하지 않아야 한다. */
		assert.strictEqual(session.state.kind, 'running');
		assert.strictEqual(handle.killCallCount, 0);
		assert.strictEqual(handle.dataListenerCount, 1);
		assert.strictEqual(handle.exitListenerCount, 1);
		assert.strictEqual(
			host.getActiveSession('tab-panel-hidden'),
			session,
		);
		assert.strictEqual(adapter.spawnCalls.length, 1);
	});
});

suite('Terminal cleanup timeout', () => {
	test('기본 상한 시간이 Extension 종료를 막지 않는 짧은 값이다', () => {
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

		/* 상한을 넘긴 정리는 반환 이후 best-effort로 계속 진행한다. */
		released();
		await pendingCleanup;
	});

	test('정리 중 동기 및 비동기 오류를 호출자에게 전파하지 않는다', async () => {
		await runCleanupWithTimeout(() => {
			throw new Error('sync cleanup failed');
		}, 10);

		await runCleanupWithTimeout(
			async () => {
				throw new Error('async cleanup failed');
			},
			10,
		);
	});
});
