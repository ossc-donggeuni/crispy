import * as assert from 'assert';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';
import {
	TerminalHost,
	type TerminalHostOptions,
} from '../../agent/host/terminal/terminalHost';
import {
	createPrepareTerminalLaunch,
	type PrepareTerminalLaunch,
} from '../../agent/host/terminal/prepareTerminalLaunch';
import type { PtyAdapter } from '../../agent/host/terminal/ptyAdapter';
import { ID_MAX_LENGTH, ID_PATTERN } from '../../agent/protocol/limits';
import type { HostToWebviewMessage } from '../../agent/protocol/messages';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
} from '../../agent/host/workspace/types';
import { FakePtyAdapter } from './support/fakePtyAdapter';
import {
	createCaptureFailureProcessTreeController,
	FakeProcessTreeController,
} from './support/fakeProcessTreeController';

type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

type Assert<Condition extends true> = Condition;

type StartSessionAcceptsOnlyReadyDimensions = Assert<Equal<
	Parameters<TerminalHost['startSession']>,
	[tabId: string, cols: number, rows: number]
>>;

const root = {
	scheme: 'file',
	fsPath: '/validated/workspace' as ValidatedWorkspaceFsPath,
} as ValidatedWorkspaceRoot;

const launchPolicy: ShellLaunchPolicy = {
	executable: '/host/selected/shell',
	args: ['--host-owned'],
	cwd: root.fsPath,
	env: { CRISPY_HOST_ENV: 'present' },
};

const successfulPrepare: PrepareTerminalLaunch = async () => ({
	ok: true,
	policy: launchPolicy,
});

function createHost(
	options: Omit<TerminalHostOptions, 'emitMessage'>,
): {
	readonly host: TerminalHost;
	readonly messages: HostToWebviewMessage[];
} {
	const messages: HostToWebviewMessage[] = [];
	return {
		host: new TerminalHost({
			...options,
			processTreeController: options.processTreeController
				?? createCaptureFailureProcessTreeController(),
			emitMessage: (message) => messages.push(message),
		}),
		messages,
	};
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('test condition timed out');
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

suite('TerminalHost public session behavior', () => {
	test('Host가 protocol 규칙을 만족하는 고유 sessionId를 생성한다', async () => {
		const { host, messages } = createHost({
			ptyAdapter: new FakePtyAdapter(),
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-generated-one', 80, 24);
		await host.startSession('tab-generated-two', 80, 24);

		const started = messages.filter((message) =>
			message.type === 'terminal.started'
		);
		assert.strictEqual(started.length, 2);
		assert.match(started[0].sessionId, ID_PATTERN);
		assert.ok(started[0].sessionId.length <= ID_MAX_LENGTH);
		assert.notStrictEqual(started[0].sessionId, started[1].sessionId);
	});

	test('Webview 추가 값을 무시하고 Host가 생성한 sessionId만 전달한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});
		const startWithUntrustedExtra = host.startSession.bind(host) as unknown as (
			tabId: string,
			cols: number,
			rows: number,
			webviewSessionId: string,
		) => Promise<void>;

		await startWithUntrustedExtra(
			'tab-one',
			80,
			24,
			'session-from-webview',
		);

		const session = host.getActiveSession('tab-one');
		assert.ok(session);
		assert.match(session.sessionId, ID_PATTERN);
		assert.notStrictEqual(session.sessionId, 'session-from-webview');
		assert.strictEqual(host.getSession('session-from-webview'), undefined);
		assert.deepStrictEqual(messages[1], {
			type: 'terminal.started',
			tabId: 'tab-one',
			sessionId: session.sessionId,
		});
		assert.strictEqual(adapter.spawnCalls.length, 1);
	});

	test('sessionId와 tabId 조회 및 양방향 ownership을 제공한다', async () => {
		const { host } = createHost({
			ptyAdapter: new FakePtyAdapter(),
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-one', 80, 24);
		await host.startSession('tab-two', 80, 24);

		const first = host.getActiveSession('tab-one');
		const second = host.getActiveSession('tab-two');
		assert.ok(first);
		assert.ok(second);
		assert.strictEqual(host.getSession(first.sessionId), first);
		assert.strictEqual(host.getSession(second.sessionId), second);
		assert.strictEqual(host.getActiveSession('tab-one'), first);
		assert.strictEqual(host.getActiveSession('tab-two'), second);
		assert.strictEqual(host.getSession('session-unknown'), undefined);
		assert.strictEqual(host.getActiveSession('tab-unknown'), undefined);
		assert.strictEqual(host.ownsSession('tab-one', first.sessionId), true);
		assert.strictEqual(host.ownsSession('tab-two', second.sessionId), true);
		assert.strictEqual(host.ownsSession('tab-one', second.sessionId), false);
		assert.strictEqual(host.ownsSession('tab-two', first.sessionId), false);
	});

	test('session 제거 후 같은 tab에서 새 Host session을 시작한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-reusable', 80, 24);
		const before = host.getActiveSession('tab-reusable');
		assert.ok(before);
		assert.strictEqual(host.removeSession(before.sessionId), before);
		assert.strictEqual(host.removeSession(before.sessionId), undefined);

		await host.startSession('tab-reusable', 100, 30);
		const after = host.getActiveSession('tab-reusable');
		assert.ok(after);
		assert.notStrictEqual(after.sessionId, before.sessionId);
		assert.strictEqual(adapter.spawnCalls.length, 2);
	});

	test('Agent reset은 탭을 유지하면서 현재 CLI와 provider 배정을 정리한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		host.createTab('tab-agent-reset');
		await host.handleTerminalReady('tab-agent-reset', 80, 24);
		await host.switchAgent('tab-agent-reset', 'codex');
		const session = host.getActiveSession('tab-agent-reset');
		assert.ok(session);

		host.resetAgent('tab-agent-reset');
		await Promise.resolve();

		assert.strictEqual(host.hasTab('tab-agent-reset'), true);
		assert.strictEqual(host.getActiveTabId(), 'tab-agent-reset');
		assert.strictEqual(host.getTabProvider('tab-agent-reset'), undefined);
		assert.strictEqual(host.getActiveSession('tab-agent-reset'), undefined);
		assert.strictEqual(host.getSession(session.sessionId), undefined);
		assert.strictEqual(adapter.handles[0].killCallCount, 1);
		assert.strictEqual(adapter.handles[0].dataListenerCount, 0);
		assert.strictEqual(adapter.handles[0].exitListenerCount, 0);
	});

	test('Agent reset은 routing을 즉시 끊고 성공한 process tree 전체를 종료한다', async () => {
		const adapter = new FakePtyAdapter(4311);
		const controller = new FakeProcessTreeController();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			processTreeController: controller,
		});

		host.createTab('tab-agent-reset-tree');
		await host.handleTerminalReady('tab-agent-reset-tree', 80, 24);
		await host.switchAgent('tab-agent-reset-tree', 'codex');
		const session = host.getActiveSession('tab-agent-reset-tree');
		assert.ok(session);

		host.resetAgent('tab-agent-reset-tree');

		assert.strictEqual(host.getActiveSession('tab-agent-reset-tree'), undefined);
		assert.deepStrictEqual(session.state, { kind: 'disposed' });
		assert.strictEqual(adapter.handles[0].dataListenerCount, 0);
		assert.strictEqual(adapter.handles[0].exitListenerCount, 0);
		await waitUntil(() => controller.calls.length === 2);
		assert.deepStrictEqual(controller.calls, ['capture:4311', 'terminate:4311']);
		assert.strictEqual(adapter.handles[0].killCallCount, 0);
	});

	test('탭 닫기는 UI ownership을 즉시 제거하고 process tree는 백그라운드에서 종료한다', async () => {
		const adapter = new FakePtyAdapter(4312);
		const controller = new FakeProcessTreeController();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			processTreeController: controller,
		});

		host.createTab('tab-close-tree');
		await host.handleTerminalReady('tab-close-tree', 80, 24);
		await host.switchAgent('tab-close-tree', 'codex');
		const session = host.getActiveSession('tab-close-tree');
		assert.ok(session);

		host.closeTab('tab-close-tree');

		assert.strictEqual(host.hasTab('tab-close-tree'), false);
		assert.strictEqual(host.getActiveSession('tab-close-tree'), undefined);
		assert.deepStrictEqual(session.state, { kind: 'disposed' });
		await waitUntil(() => controller.calls.length === 2);
		assert.deepStrictEqual(controller.calls, ['capture:4312', 'terminate:4312']);
		assert.strictEqual(adapter.handles[0].killCallCount, 0);
	});

	test('Agent 재선택은 이전 process tree 종료 전 새 CLI를 시작하지 않는다', async () => {
		const adapter = new FakePtyAdapter(4313);
		let releaseTermination!: () => void;
		const terminationPending = new Promise<void>((resolve) => {
			releaseTermination = resolve;
		});
		const controller = new FakeProcessTreeController({
			beforeTerminate: () => terminationPending,
		});
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			processTreeController: controller,
			resolveAgentAutoRunInput: async () => undefined,
		});

		host.createTab('tab-reselect-tree');
		await host.handleTerminalReady('tab-reselect-tree', 80, 24);
		await host.switchAgent('tab-reselect-tree', 'codex');
		const first = host.getActiveSession('tab-reselect-tree');
		assert.ok(first);

		const reselecting = host.switchAgent('tab-reselect-tree', 'claude');
		await waitUntil(() => controller.calls.includes('terminate:4313'));

		assert.strictEqual(adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(first.state, { kind: 'disposed' });
		assert.strictEqual(adapter.handles[0].dataListenerCount, 0);
		assert.strictEqual(adapter.handles[0].exitListenerCount, 0);
		releaseTermination();
		await reselecting;

		assert.strictEqual(adapter.spawnCalls.length, 2);
		assert.strictEqual(host.getActiveSession('tab-reselect-tree')?.state.kind, 'running');
		assert.deepStrictEqual(controller.calls, ['capture:4313', 'terminate:4313']);
		assert.strictEqual(adapter.handles[0].killCallCount, 0);
	});
});

suite('TerminalHost start orchestration', () => {
	test('workspace와 Shell policy 결과로 PTY를 시작하고 Host sessionId를 전달한다', async () => {
		let workspaceCalls = 0;
		let shellCalls = 0;
		const adapter = new FakePtyAdapter(9201);
		const prepare = createPrepareTerminalLaunch({
			workspaceResolver: () => {
				workspaceCalls += 1;
				return { ok: true, root };
			},
			shellResolver: async (platform, env, workspaceRoot) => {
				shellCalls += 1;
				assert.strictEqual(platform, 'linux');
				assert.deepStrictEqual(env, { HOST_ENV: 'snapshot' });
				assert.strictEqual(workspaceRoot, root);
				return { ok: true, policy: launchPolicy };
			},
			readPlatform: () => 'linux',
			readEnvironment: () => ({ HOST_ENV: 'snapshot' }),
		});
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: prepare,
		});

		await host.startSession('tab-start-success', 120, 36);

		const session = host.getActiveSession('tab-start-success');
		assert.ok(session);
		assert.strictEqual(workspaceCalls, 1);
		assert.strictEqual(shellCalls, 1);
		assert.deepStrictEqual(adapter.spawnCalls, [{
			...launchPolicy,
			args: ['--host-owned'],
			env: { CRISPY_HOST_ENV: 'present' },
			cols: 120,
			rows: 36,
		}]);
		assert.deepStrictEqual(session.state, { kind: 'running', pid: 9201 });
		assert.deepStrictEqual(messages, [
			{
				type: 'terminal.starting',
				tabId: 'tab-start-success',
				sessionId: session.sessionId,
			},
			{
				type: 'terminal.started',
				tabId: 'tab-start-success',
				sessionId: session.sessionId,
			},
		]);
	});

	test('Webview fallback 크기 80x24로도 session을 running 상태까지 시작한다', async () => {
		const adapter = new FakePtyAdapter(9204);
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-fallback-size', 80, 24);

		const session = host.getActiveSession('tab-fallback-size');
		assert.ok(session);
		assert.deepStrictEqual(session.state, { kind: 'running', pid: 9204 });
		assert.deepStrictEqual(adapter.spawnCalls, [{
			...launchPolicy,
			args: ['--host-owned'],
			env: { CRISPY_HOST_ENV: 'present' },
			cols: 80,
			rows: 24,
		}]);
		assert.strictEqual(messages.at(-1)?.type, 'terminal.started');
	});

	test('정책 준비 중 starting 상태를 유지하고 같은 tab의 중복 start를 거부한다', async () => {
		let finishPreparation!: (
			value: Awaited<ReturnType<PrepareTerminalLaunch>>,
		) => void;
		const prepare: PrepareTerminalLaunch = () => new Promise((resolve) => {
			finishPreparation = resolve;
		});
		const adapter = new FakePtyAdapter(9202);
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: prepare,
		});

		const firstStart = host.startSession('tab-pending', 80, 24);
		const pendingSession = host.getActiveSession('tab-pending');
		assert.ok(pendingSession);
		assert.deepStrictEqual(pendingSession.state, { kind: 'starting' });

		await host.startSession('tab-pending', 100, 30);

		assert.strictEqual(host.getActiveSession('tab-pending'), pendingSession);
		assert.strictEqual(adapter.spawnCalls.length, 0);
		assert.deepStrictEqual(pendingSession.state, { kind: 'starting' });
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-pending',
			sessionId: pendingSession.sessionId,
			code: 'invalid_session_state',
			message: 'Terminal tab already has an active session.',
			canRestart: false,
		});

		finishPreparation({ ok: true, policy: launchPolicy });
		await firstStart;
		assert.strictEqual(pendingSession.state.kind, 'running');
	});

	test('workspace policy 실패를 starting에서 안전한 error 상태로 전환한다', async () => {
		let workspaceCalls = 0;
		let shellCalls = 0;
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: createPrepareTerminalLaunch({
				workspaceResolver: () => {
					workspaceCalls += 1;
					return { ok: false, code: 'workspace_untrusted' };
				},
				shellResolver: async () => {
					shellCalls += 1;
					return { ok: true, policy: launchPolicy };
				},
				readPlatform: () => 'darwin',
				readEnvironment: () => ({}),
			}),
		});

		await host.startSession('tab-workspace-failure', 80, 24);

		assert.strictEqual(workspaceCalls, 1);
		assert.strictEqual(shellCalls, 0);
		assert.strictEqual(adapter.spawnCalls.length, 0);
		assert.deepStrictEqual(host.getActiveSession('tab-workspace-failure')?.state, {
			kind: 'error',
			code: 'workspace_untrusted',
		});
		assert.strictEqual(messages.at(-1)?.type, 'terminal.error');
	});

	test('Shell policy 실패를 starting에서 안전한 error 상태로 전환한다', async () => {
		let shellCalls = 0;
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: createPrepareTerminalLaunch({
				workspaceResolver: () => ({ ok: true, root }),
				shellResolver: async () => {
					shellCalls += 1;
					return {
						ok: false,
						error: { code: 'shell_not_executable' },
					};
				},
				readPlatform: () => 'linux',
				readEnvironment: () => ({}),
			}),
		});

		await host.startSession('tab-shell-failure', 80, 24);

		assert.strictEqual(shellCalls, 1);
		assert.strictEqual(adapter.spawnCalls.length, 0);
		assert.deepStrictEqual(host.getActiveSession('tab-shell-failure')?.state, {
			kind: 'error',
			code: 'shell_unavailable',
		});
		const error = messages.at(-1);
		assert.strictEqual(
			error?.type === 'terminal.error' ? error.code : undefined,
			'shell_unavailable',
		);
	});

	test('PTY spawn 원본 예외와 실행 계약을 노출하지 않고 start_failed로 변환한다', async () => {
		const secrets = [
			'/private/workspace/secret',
			'/private/executable/secret',
			'--secret-argument',
			'SECRET_TOKEN=value',
			'raw native exception',
		];
		const unsafePolicy: ShellLaunchPolicy = {
			executable: secrets[1],
			args: [secrets[2]],
			cwd: secrets[0],
			env: { SECRET_TOKEN: secrets[3] },
		};
		const adapter: PtyAdapter = {
			spawn: () => {
				throw new Error(secrets[4]);
			},
		};
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: async () => ({ ok: true, policy: unsafePolicy }),
		});

		await host.startSession('tab-spawn-failure', 80, 24);

		const failedSession = host.getActiveSession('tab-spawn-failure');
		assert.ok(failedSession);
		assert.deepStrictEqual(failedSession.state, {
			kind: 'error',
			code: 'start_failed',
		});
		assert.strictEqual(messages.length, 2);
		const serialized = JSON.stringify(messages);
		for (const secret of secrets) {
			assert.strictEqual(serialized.includes(secret), false);
		}
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-spawn-failure',
			sessionId: failedSession.sessionId,
			code: 'start_failed',
			message: 'Terminal process could not be started.',
			canRestart: true,
		});
	});
});

suite('TerminalHost input and resize routing', () => {
	test('소유한 running session에 input 원문과 resize 값을 그대로 전달한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});
		await host.startSession('tab-routing', 80, 24);
		const session = host.getActiveSession('tab-routing');
		assert.ok(session);
		const inputs = [
			'  keep surrounding spaces  ',
			'\r',
			'\x03',
			'한글🙂',
			'\x1b[200~paste\nwithout rewrite\x1b[201~',
		];

		for (const data of inputs) {
			host.routeInput({
				type: 'terminal.input',
				tabId: 'tab-routing',
				sessionId: session.sessionId,
				data,
			});
		}
		host.routeResize({
			type: 'terminal.resize',
			tabId: 'tab-routing',
			sessionId: session.sessionId,
			cols: 132,
			rows: 43,
		});

		assert.deepStrictEqual(adapter.handles[0].writes, inputs);
		assert.deepStrictEqual(adapter.handles[0].resizes, [
			{ cols: 132, rows: 43 },
		]);
	});

	test('wrong ownership, unknown 및 stale session 요청을 PTY에 전달하지 않는다', async () => {
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});
		await host.startSession('tab-first', 80, 24);
		await host.startSession('tab-second', 80, 24);
		const first = host.getActiveSession('tab-first');
		const second = host.getActiveSession('tab-second');
		assert.ok(first);
		assert.ok(second);

		host.routeInput({
			type: 'terminal.input',
			tabId: 'tab-first',
			sessionId: second.sessionId,
			data: 'wrong-owner',
		});
		host.routeResize({
			type: 'terminal.resize',
			tabId: 'tab-first',
			sessionId: 'session-unknown',
			cols: 100,
			rows: 30,
		});

		const staleSessionId = first.sessionId;
		host.removeSession(staleSessionId);
		await host.startSession('tab-first', 100, 30);
		const replacementHandle = adapter.handles[2];
		host.routeInput({
			type: 'terminal.input',
			tabId: 'tab-first',
			sessionId: staleSessionId,
			data: 'stale-input',
		});
		host.routeResize({
			type: 'terminal.resize',
			tabId: 'tab-first',
			sessionId: staleSessionId,
			cols: 140,
			rows: 50,
		});

		for (const handle of adapter.handles) {
			assert.deepStrictEqual(handle.writes, []);
			assert.deepStrictEqual(handle.resizes, []);
		}
		assert.ok(replacementHandle);
	});

	test('starting 및 종료 lifecycle의 session 요청을 차단한다', async () => {
		let finishPreparation!: (
			value: Awaited<ReturnType<PrepareTerminalLaunch>>,
		) => void;
		const pendingPrepare: PrepareTerminalLaunch = () => new Promise((resolve) => {
			finishPreparation = resolve;
		});
		const startingAdapter = new FakePtyAdapter();
		const { host: startingHost } = createHost({
			ptyAdapter: startingAdapter,
			prepareLaunch: pendingPrepare,
		});
		const pendingStart = startingHost.startSession('tab-starting-route', 80, 24);
		const starting = startingHost.getActiveSession('tab-starting-route');
		assert.ok(starting);

		startingHost.routeInput({
			type: 'terminal.input',
			tabId: starting.tabId,
			sessionId: starting.sessionId,
			data: 'blocked-while-starting',
		});
		startingHost.routeResize({
			type: 'terminal.resize',
			tabId: starting.tabId,
			sessionId: starting.sessionId,
			cols: 120,
			rows: 40,
		});
		assert.strictEqual(startingAdapter.handles.length, 0);
		finishPreparation({ ok: true, policy: launchPolicy });
		await pendingStart;
		assert.deepStrictEqual(startingAdapter.handles[0].writes, []);
		assert.deepStrictEqual(startingAdapter.handles[0].resizes, []);

		const transitions: Array<{
			readonly name: string;
			readonly apply: (session: NonNullable<ReturnType<TerminalHost['getActiveSession']>>) => void;
		}> = [
			{ name: 'stopping', apply: (session) => session.markStopping() },
			{
				name: 'exited',
				apply: (session) => {
					session.markStopping();
					session.markExited(0, null);
				},
			},
			{ name: 'error', apply: (session) => session.markError('internal_error') },
			{ name: 'disposed', apply: (session) => session.markDisposed() },
		];

		for (const transition of transitions) {
			const adapter = new FakePtyAdapter();
			const { host } = createHost({
				ptyAdapter: adapter,
				prepareLaunch: successfulPrepare,
			});
			await host.startSession(`tab-${transition.name}`, 80, 24);
			const session = host.getActiveSession(`tab-${transition.name}`);
			assert.ok(session);
			transition.apply(session);

			host.routeInput({
				type: 'terminal.input',
				tabId: session.tabId,
				sessionId: session.sessionId,
				data: `blocked-${transition.name}`,
			});
			host.routeResize({
				type: 'terminal.resize',
				tabId: session.tabId,
				sessionId: session.sessionId,
				cols: 120,
				rows: 40,
			});

			assert.deepStrictEqual(adapter.handles[0].writes, []);
			assert.deepStrictEqual(adapter.handles[0].resizes, []);
		}
	});
});

suite('TerminalHost PTY output and exit routing', () => {
	test('fake PTY output을 원문 그대로 같은 microtask에서 병합해 전달한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});
		await host.startSession('tab-output', 80, 24);
		const session = host.getActiveSession('tab-output');
		assert.ok(session);

		adapter.handles[0].emitData('hello');
		adapter.handles[0].emitData('\r\n\x1b[32m한글🙂\x1b[0m  ');
		assert.strictEqual(
			messages.some((message) => message.type === 'terminal.output'),
			false,
		);

		await Promise.resolve();

		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.output',
			tabId: 'tab-output',
			sessionId: session.sessionId,
			data: 'hello\r\n\x1b[32m한글🙂\x1b[0m  ',
		});
	});

	test('fake PTY exit을 보존하고 exited 메시지 뒤 input과 resize를 차단한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});
		await host.startSession('tab-exit', 80, 24);
		const session = host.getActiveSession('tab-exit');
		assert.ok(session);
		const handle = adapter.handles[0];

		handle.emitExit({ exitCode: 9, signal: 15 });

		assert.strictEqual(host.getActiveSession('tab-exit'), session);
		assert.strictEqual(host.getSession(session.sessionId), session);
		assert.deepStrictEqual(session.state, {
			kind: 'exited',
			exitCode: 9,
			signal: 15,
		});
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.exited',
			tabId: 'tab-exit',
			sessionId: session.sessionId,
			exitCode: 9,
			signal: 15,
		});
		assert.strictEqual(handle.dataListenerCount, 0);
		assert.strictEqual(handle.exitListenerCount, 0);

		host.routeInput({
			type: 'terminal.input',
			tabId: session.tabId,
			sessionId: session.sessionId,
			data: 'blocked-after-exit',
		});
		host.routeResize({
			type: 'terminal.resize',
			tabId: session.tabId,
			sessionId: session.sessionId,
			cols: 120,
			rows: 40,
		});

		assert.deepStrictEqual(handle.writes, []);
		assert.deepStrictEqual(handle.resizes, []);
	});

	test('signal이 없으면 terminal.exited에서 signal 필드를 생략한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});
		await host.startSession('tab-exit-no-signal', 80, 24);
		const session = host.getActiveSession('tab-exit-no-signal');
		assert.ok(session);

		adapter.handles[0].emitExit({ exitCode: 0 });

		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.exited',
			tabId: session.tabId,
			sessionId: session.sessionId,
			exitCode: 0,
		});
	});

	test('Webview dispose 이후 output과 exit 메시지 전달을 중단한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});
		await host.startSession('tab-disposed-webview', 80, 24);
		const messageCount = messages.length;

		host.stopMessageDelivery();
		adapter.handles[0].emitData('must-not-be-delivered');
		await Promise.resolve();
		adapter.handles[0].emitExit({ exitCode: 0 });

		assert.strictEqual(messages.length, messageCount);
		assert.strictEqual(
			host.getActiveSession('tab-disposed-webview')?.state.kind,
			'exited',
		);
	});
});

suite('TerminalHost restart orchestration', () => {
	test('재시작은 이전 process tree 종료 전 새 PTY를 만들지 않는다', async () => {
		const adapter = new FakePtyAdapter(4314);
		let releaseTermination!: () => void;
		const terminationPending = new Promise<void>((resolve) => {
			releaseTermination = resolve;
		});
		const controller = new FakeProcessTreeController({
			beforeTerminate: () => terminationPending,
		});
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			processTreeController: controller,
		});
		await host.startSession('tab-restart-tree', 80, 24);
		const first = host.getActiveSession('tab-restart-tree');
		assert.ok(first);
		adapter.handles[0].emitExit({ exitCode: 0 });

		const restarting = host.restartSession(
			'tab-restart-tree',
			first.sessionId,
		);
		await waitUntil(() => controller.calls.includes('terminate:4314'));
		assert.strictEqual(adapter.spawnCalls.length, 1);

		releaseTermination();
		await restarting;

		assert.strictEqual(adapter.spawnCalls.length, 2);
		assert.deepStrictEqual(controller.calls, ['capture:4314', 'terminate:4314']);
		assert.strictEqual(adapter.handles[0].killCallCount, 0);
	});

	test('종료된 session을 정리하고 새 sessionId로 정책을 다시 적용해 시작한다', async () => {
		let workspaceCalls = 0;
		let shellCalls = 0;
		const adapter = new FakePtyAdapter();
		const prepare = createPrepareTerminalLaunch({
			workspaceResolver: () => {
				workspaceCalls += 1;
				return { ok: true, root };
			},
			shellResolver: async () => {
				shellCalls += 1;
				return { ok: true, policy: launchPolicy };
			},
			readPlatform: () => 'linux',
			readEnvironment: () => ({ HOST_ENV: 'snapshot' }),
		});
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: prepare,
		});

		await host.startSession('tab-restart', 120, 36);
		const first = host.getActiveSession('tab-restart');
		assert.ok(first);
		adapter.handles[0].emitExit({ exitCode: 1 });

		await host.restartSession('tab-restart', first.sessionId);

		const second = host.getActiveSession('tab-restart');
		assert.ok(second);
		assert.notStrictEqual(second.sessionId, first.sessionId);
		assert.strictEqual(second.state.kind, 'running');
		assert.strictEqual(host.getSession(first.sessionId), undefined);
		assert.strictEqual(first.state.kind, 'disposed');
		assert.strictEqual(workspaceCalls, 2);
		assert.strictEqual(shellCalls, 2);
		assert.strictEqual(adapter.spawnCalls.length, 2);
		assert.deepStrictEqual(adapter.spawnCalls[1], {
			...launchPolicy,
			args: ['--host-owned'],
			env: { CRISPY_HOST_ENV: 'present' },
			cols: 120,
			rows: 36,
		});
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.started',
			tabId: 'tab-restart',
			sessionId: second.sessionId,
		});
	});

	test('재시작 PTY는 마지막으로 확인된 terminal 크기를 재사용한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-restart-size', 80, 24);
		const session = host.getActiveSession('tab-restart-size');
		assert.ok(session);
		host.routeResize({
			type: 'terminal.resize',
			tabId: 'tab-restart-size',
			sessionId: session.sessionId,
			cols: 132,
			rows: 43,
		});
		adapter.handles[0].emitExit({ exitCode: 0 });

		await host.restartSession('tab-restart-size', session.sessionId);

		assert.strictEqual(adapter.spawnCalls[1].cols, 132);
		assert.strictEqual(adapter.spawnCalls[1].rows, 43);
	});

	test('error 상태 session의 재시작에서 이전 PTY와 구독을 먼저 정리한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-restart-cleanup', 80, 24);
		const session = host.getActiveSession('tab-restart-cleanup');
		assert.ok(session);
		const handle = adapter.handles[0];
		/* 실행 중 PTY 동작 실패는 PTY를 살려 둔 채 session을 error로 만든다. */
		handle.resize = () => {
			throw new Error('resize failed');
		};
		host.routeResize({
			type: 'terminal.resize',
			tabId: 'tab-restart-cleanup',
			sessionId: session.sessionId,
			cols: 100,
			rows: 30,
		});
		assert.strictEqual(session.state.kind, 'error');

		await host.restartSession('tab-restart-cleanup', session.sessionId);

		assert.strictEqual(handle.killCallCount, 1);
		assert.strictEqual(handle.dataListenerCount, 0);
		assert.strictEqual(handle.exitListenerCount, 0);
		assert.strictEqual(adapter.spawnCalls.length, 2);
	});

	test('starting, running 및 stopping 상태의 중복 restart를 거부한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-restart-duplicate', 80, 24);
		const session = host.getActiveSession('tab-restart-duplicate');
		assert.ok(session);

		await host.restartSession('tab-restart-duplicate', session.sessionId);
		session.markStopping();
		await host.restartSession('tab-restart-duplicate', session.sessionId);

		assert.strictEqual(host.getActiveSession('tab-restart-duplicate'), session);
		assert.strictEqual(adapter.spawnCalls.length, 1);
		for (const message of messages.slice(-2)) {
			assert.deepStrictEqual(message, {
				type: 'terminal.error',
				tabId: 'tab-restart-duplicate',
				sessionId: session.sessionId,
				code: 'invalid_session_state',
				message: 'Terminal restart is already in progress.',
				canRestart: false,
			});
		}
	});

	test('소유 관계가 다른 restart 요청을 session_not_found로 거부한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-owner', 80, 24);
		const session = host.getActiveSession('tab-owner');
		assert.ok(session);
		adapter.handles[0].emitExit({ exitCode: 0 });

		await host.restartSession('tab-other', session.sessionId);
		await host.restartSession('tab-owner', 'session-unknown');

		assert.strictEqual(adapter.spawnCalls.length, 1);
		assert.strictEqual(host.getActiveSession('tab-owner'), session);
		for (const message of messages.slice(-2)) {
			assert.strictEqual(
				message.type === 'terminal.error' ? message.code : undefined,
				'session_not_found',
			);
			assert.strictEqual(
				message.type === 'terminal.error' ? message.sessionId : undefined,
				null,
			);
		}
	});

	test('재시작 spawn 실패를 start_failed로 변환하고 이전 session 메시지를 차단한다', async () => {
		const workingAdapter = new FakePtyAdapter();
		let spawnCalls = 0;
		const adapter: PtyAdapter = {
			spawn: (options) => {
				spawnCalls += 1;
				if (spawnCalls > 1) {
					throw new Error('raw native exception');
				}

				return workingAdapter.spawn(options);
			},
		};
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-restart-failure', 80, 24);
		const first = host.getActiveSession('tab-restart-failure');
		assert.ok(first);
		const handle = workingAdapter.handles[0];
		handle.emitExit({ exitCode: 0 });

		await host.restartSession('tab-restart-failure', first.sessionId);

		const second = host.getActiveSession('tab-restart-failure');
		assert.ok(second);
		assert.notStrictEqual(second.sessionId, first.sessionId);
		assert.deepStrictEqual(second.state, {
			kind: 'error',
			code: 'start_failed',
		});
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-restart-failure',
			sessionId: second.sessionId,
			code: 'start_failed',
			message: 'Terminal process could not be started.',
			canRestart: true,
		});
		assert.strictEqual(
			JSON.stringify(messages).includes('raw native exception'),
			false,
		);

		const messageCount = messages.length;
		handle.emitData('late output');
		await Promise.resolve();
		assert.strictEqual(messages.length, messageCount);
	});
});

suite('TerminalHost lifecycle cleanup', () => {
	test('dispose가 실행 중 session을 disposed로 전이하고 PTY와 구독을 정리한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-dispose-running', 80, 24);
		const session = host.getActiveSession('tab-dispose-running');
		assert.ok(session);
		assert.strictEqual(session.state.kind, 'running');
		const handle = adapter.handles[0];

		host.dispose();

		assert.deepStrictEqual(session.state, { kind: 'disposed' });
		assert.strictEqual(handle.killCallCount, 1);
		assert.strictEqual(handle.dataListenerCount, 0);
		assert.strictEqual(handle.exitListenerCount, 0);
		assert.strictEqual(host.getSession(session.sessionId), undefined);
		assert.strictEqual(host.getActiveSession('tab-dispose-running'), undefined);
		assert.strictEqual(
			host.ownsSession('tab-dispose-running', session.sessionId),
			false,
		);
	});

	test('dispose 이후 input과 resize를 PTY에 전달하지 않는다', async () => {
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-dispose-routing', 80, 24);
		const session = host.getActiveSession('tab-dispose-routing');
		assert.ok(session);
		const handle = adapter.handles[0];

		host.dispose();
		host.routeInput({
			type: 'terminal.input',
			tabId: 'tab-dispose-routing',
			sessionId: session.sessionId,
			data: 'input after dispose',
		});
		host.routeResize({
			type: 'terminal.resize',
			tabId: 'tab-dispose-routing',
			sessionId: session.sessionId,
			cols: 100,
			rows: 30,
		});

		assert.deepStrictEqual(handle.writes, []);
		assert.deepStrictEqual(handle.resizes, []);
	});

	test('dispose 이후 남은 PTY output과 exit 메시지를 전달하지 않는다', async () => {
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-dispose-messages', 80, 24);
		const handle = adapter.handles[0];

		host.dispose();
		const messageCount = messages.length;
		handle.emitData('late output');
		handle.emitExit({ exitCode: 0 });
		await Promise.resolve();

		assert.strictEqual(messages.length, messageCount);
	});

	test('PTY kill 실패에도 dispose가 나머지 session 정리를 계속한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-dispose-failing', 80, 24);
		await host.startSession('tab-dispose-remaining', 80, 24);
		const failingSession = host.getActiveSession('tab-dispose-failing');
		const remainingSession = host.getActiveSession('tab-dispose-remaining');
		assert.ok(failingSession);
		assert.ok(remainingSession);
		const failingHandle = adapter.handles[0];
		const remainingHandle = adapter.handles[1];
		failingHandle.kill = () => {
			throw new Error('kill failed');
		};

		host.dispose();

		assert.deepStrictEqual(failingSession.state, { kind: 'disposed' });
		assert.deepStrictEqual(remainingSession.state, { kind: 'disposed' });
		assert.strictEqual(failingHandle.dataListenerCount, 0);
		assert.strictEqual(failingHandle.exitListenerCount, 0);
		assert.strictEqual(remainingHandle.killCallCount, 1);
		assert.strictEqual(remainingHandle.dataListenerCount, 0);
	});

	test('반복 dispose 호출이 추가 PTY 종료 요청을 만들지 않는다', async () => {
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});

		await host.startSession('tab-dispose-idempotent', 80, 24);
		const handle = adapter.handles[0];

		host.dispose();
		host.dispose();

		assert.strictEqual(handle.killCallCount, 1);
	});
});
