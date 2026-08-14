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
			emitMessage: (message) => messages.push(message),
		}),
		messages,
	};
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
			{ type: 'terminal.starting', tabId: 'tab-start-success' },
			{
				type: 'terminal.started',
				tabId: 'tab-start-success',
				sessionId: session.sessionId,
			},
		]);
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
