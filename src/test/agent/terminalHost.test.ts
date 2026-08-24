import * as assert from 'assert';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';
import {
	TerminalHost,
	WORKSPACE_TRUST_MONITOR_INTERVAL_MS,
	type TerminalHostOptions,
	type WorkspaceTrustMonitorScheduler,
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
const WORKSPACE_ROOT_ID = 'workspace-root:file:///validated/workspace';

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
			resolveAgentAutoRunInput: options.resolveAgentAutoRunInput
				?? (async () => undefined),
			workspaceResolver: options.workspaceResolver
				?? (() => ({ ok: true, root })),
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

class FakeWorkspaceTrustMonitorScheduler
	implements WorkspaceTrustMonitorScheduler {
	readonly intervals: number[] = [];
	readonly clearedHandles: number[] = [];
	private nextHandle = 0;
	private readonly callbacks = new Map<number, () => void>();

	get activeCount(): number {
		return this.callbacks.size;
	}

	setInterval(callback: () => void, intervalMs: number): number {
		this.nextHandle += 1;
		this.intervals.push(intervalMs);
		this.callbacks.set(this.nextHandle, callback);
		return this.nextHandle;
	}

	clearInterval(handle: unknown): void {
		if (typeof handle !== 'number') {
			return;
		}
		this.clearedHandles.push(handle);
		this.callbacks.delete(handle);
	}

	fireAll(): void {
		for (const callback of [...this.callbacks.values()]) {
			callback();
		}
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
		await host.switchAgent('tab-agent-reset', 'codex', WORKSPACE_ROOT_ID, 1);
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
		await host.switchAgent(
			'tab-agent-reset-tree',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);
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
		await host.switchAgent('tab-close-tree', 'codex', WORKSPACE_ROOT_ID, 1);
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
		await host.switchAgent('tab-reselect-tree', 'codex', WORKSPACE_ROOT_ID, 1);
		const first = host.getActiveSession('tab-reselect-tree');
		assert.ok(first);

		const reselecting = host.switchAgent(
			'tab-reselect-tree',
			'claude',
			WORKSPACE_ROOT_ID,
			2,
		);
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

suite('TerminalHost Workspace assignment', () => {
	test('최초 switch preflight 실패는 assignment, session과 revision을 변경하지 않는다', async () => {
		let prepareCalls = 0;
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			workspaceResolver: () => ({
				ok: false,
				code: 'workspace_untrusted',
			}),
			prepareLaunch: async () => {
				prepareCalls += 1;
				return { ok: true, policy: launchPolicy };
			},
		});
		host.createTab('tab-preflight-rejected');
		await host.handleTerminalReady('tab-preflight-rejected', 80, 24);

		await host.switchAgent(
			'tab-preflight-rejected',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);

		assert.strictEqual(host.getTabAssignment('tab-preflight-rejected'), undefined);
		assert.strictEqual(host.getActiveSession('tab-preflight-rejected'), undefined);
		assert.strictEqual(host.getAssignmentRevision('tab-preflight-rejected'), 0);
		assert.strictEqual(prepareCalls, 0);
		assert.strictEqual(adapter.spawnCalls.length, 0);
		assert.deepStrictEqual(messages, [{
			type: 'terminal.error',
			tabId: 'tab-preflight-rejected',
			sessionId: null,
			code: 'workspace_untrusted',
			message: '작업공간을 신뢰한 후 다시 시도하세요.',
			canRestart: false,
			switchAttemptId: 1,
		}]);
	});

	test('기존 assignment의 provider switch preflight 실패는 session ownership을 유지한다', async () => {
		let workspaceAvailable = true;
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			workspaceResolver: () => workspaceAvailable
				? { ok: true, root }
				: { ok: false, code: 'workspace_root_unavailable' },
		});
		host.createTab('tab-preserve-on-preflight');
		await host.handleTerminalReady('tab-preserve-on-preflight', 80, 24);
		await host.switchAgent(
			'tab-preserve-on-preflight',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);
		const assignment = host.getTabAssignment('tab-preserve-on-preflight');
		const session = host.getActiveSession('tab-preserve-on-preflight');
		assert.ok(assignment);
		assert.ok(session);
		workspaceAvailable = false;

		await host.switchAgent(
			'tab-preserve-on-preflight',
			'claude',
			WORKSPACE_ROOT_ID,
			2,
		);

		assert.strictEqual(host.getTabAssignment('tab-preserve-on-preflight'), assignment);
		assert.strictEqual(host.getActiveSession('tab-preserve-on-preflight'), session);
		assert.strictEqual(host.getAssignmentRevision('tab-preserve-on-preflight'), 1);
		assert.strictEqual(adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(session.state.kind, 'running');
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-preserve-on-preflight',
			sessionId: null,
			code: 'workspace_root_unavailable',
			message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
			canRestart: false,
			switchAttemptId: 2,
		});
	});

	test('성공 commit마다 frozen assignment identity와 revision을 새로 만든다', async () => {
		const { host, messages } = createHost({
			ptyAdapter: new FakePtyAdapter(),
			prepareLaunch: successfulPrepare,
		});
		host.createTab('tab-assignment');

		await host.switchAgent('tab-assignment', 'codex', WORKSPACE_ROOT_ID, 1);
		const first = host.getTabAssignment('tab-assignment');
		assert.ok(first);
		assert.ok(Object.isFrozen(first));
		assert.strictEqual(host.getAssignmentRevision('tab-assignment'), 1);

		await host.switchAgent('tab-assignment', 'codex', WORKSPACE_ROOT_ID, 2);
		const second = host.getTabAssignment('tab-assignment');
		assert.ok(second);
		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(second, first);
		assert.strictEqual(host.getAssignmentRevision('tab-assignment'), 2);

		host.resetAgent('tab-assignment');
		assert.strictEqual(host.getTabAssignment('tab-assignment'), undefined);
		assert.strictEqual(host.getAssignmentRevision('tab-assignment'), 3);
		assert.deepStrictEqual(messages.at(-1), {
			type: 'agent.resetCompleted',
			tabId: 'tab-assignment',
			assignmentRevision: 3,
		});
	});

	test('assignment가 있는 탭의 다른 Workspace switch를 mutation 없이 거부한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
		});
		host.createTab('tab-workspace-lock');
		await host.handleTerminalReady('tab-workspace-lock', 80, 24);
		await host.switchAgent(
			'tab-workspace-lock',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);
		const assignment = host.getTabAssignment('tab-workspace-lock');
		const session = host.getActiveSession('tab-workspace-lock');
		assert.ok(assignment);
		assert.ok(session);

		await host.switchAgent(
			'tab-workspace-lock',
			'claude',
			'workspace-root:file:///different/workspace',
			2,
		);

		assert.strictEqual(host.getTabAssignment('tab-workspace-lock'), assignment);
		assert.strictEqual(host.getActiveSession('tab-workspace-lock'), session);
		assert.strictEqual(host.getAssignmentRevision('tab-workspace-lock'), 1);
		assert.strictEqual(adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-workspace-lock',
			sessionId: null,
			code: 'workspace_change_requires_reset',
			message: 'Reset the Agent before changing its Workspace.',
			canRestart: false,
			switchAttemptId: 2,
		});
	});

	test('동일 값 ABA switch도 object identity와 cleanup barrier로 한 번만 시작한다', async () => {
		let releaseTermination!: () => void;
		const terminationPending = new Promise<void>((resolve) => {
			releaseTermination = resolve;
		});
		const controller = new FakeProcessTreeController({
			beforeTerminate: () => terminationPending,
		});
		const adapter = new FakePtyAdapter(4315);
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			processTreeController: controller,
		});
		host.createTab('tab-assignment-aba');
		await host.handleTerminalReady('tab-assignment-aba', 80, 24);
		await host.switchAgent(
			'tab-assignment-aba',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);

		const switchA = host.switchAgent(
			'tab-assignment-aba',
			'codex',
			WORKSPACE_ROOT_ID,
			2,
		);
		await waitUntil(() => controller.calls.includes('terminate:4315'));
		const assignmentA = host.getTabAssignment('tab-assignment-aba');
		const switchB = host.switchAgent(
			'tab-assignment-aba',
			'codex',
			WORKSPACE_ROOT_ID,
			3,
		);
		const assignmentB = host.getTabAssignment('tab-assignment-aba');
		assert.ok(assignmentA);
		assert.ok(assignmentB);
		assert.notStrictEqual(assignmentB, assignmentA);
		assert.strictEqual(adapter.spawnCalls.length, 1);

		releaseTermination();
		await Promise.all([switchA, switchB]);

		assert.strictEqual(adapter.spawnCalls.length, 2);
		assert.strictEqual(host.getTabAssignment('tab-assignment-aba'), assignmentB);
		assert.strictEqual(host.getAssignmentRevision('tab-assignment-aba'), 3);
		assert.strictEqual(host.getActiveSession('tab-assignment-aba')?.state.kind, 'running');
	});

	test('switchAccepted publish 시점에는 이전 session input ownership이 이미 제거된다', async () => {
		const adapter = new FakePtyAdapter();
		const messages: HostToWebviewMessage[] = [];
		let host!: TerminalHost;
		let previousSessionId: string | undefined;
		host = new TerminalHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			workspaceResolver: () => ({ ok: true, root }),
			processTreeController: createCaptureFailureProcessTreeController(),
			emitMessage: (message) => {
				messages.push(message);
				if (
					message.type === 'agent.switchAccepted'
					&& message.switchAttemptId === 2
					&& previousSessionId !== undefined
				) {
					host.routeInput({
						type: 'terminal.input',
						tabId: message.tabId,
						sessionId: previousSessionId,
						data: 'must-not-reach-old-process',
					});
				}
			},
		});
		host.createTab('tab-accepted-input-cutoff');
		await host.handleTerminalReady('tab-accepted-input-cutoff', 80, 24);
		await host.switchAgent(
			'tab-accepted-input-cutoff',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);
		previousSessionId = host.getActiveSession(
			'tab-accepted-input-cutoff',
		)?.sessionId;
		const writesBeforeSwitch = [...adapter.handles[0].writes];

		await host.switchAgent(
			'tab-accepted-input-cutoff',
			'claude',
			WORKSPACE_ROOT_ID,
			2,
		);

		assert.deepStrictEqual(adapter.handles[0].writes, writesBeforeSwitch);
		assert.strictEqual(messages.some((message) =>
			message.type === 'agent.switchAccepted'
			&& message.switchAttemptId === 2
		), true);
	});

	test('Reset commit 중 reentrant switch는 mutation 없이 거부된다', async () => {
		const messages: HostToWebviewMessage[] = [];
		let host!: TerminalHost;
		host = new TerminalHost({
			ptyAdapter: new FakePtyAdapter(),
			prepareLaunch: successfulPrepare,
			workspaceResolver: () => ({ ok: true, root }),
			processTreeController: createCaptureFailureProcessTreeController(),
			emitMessage: (message) => {
				messages.push(message);
				if (message.type === 'agent.resetCompleted') {
					void host.switchAgent(
						message.tabId,
						'claude',
						WORKSPACE_ROOT_ID,
						2,
					);
				}
			},
		});
		host.createTab('tab-reset-reentrant');
		await host.switchAgent(
			'tab-reset-reentrant',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);

		host.resetAgent('tab-reset-reentrant');

		assert.strictEqual(host.getTabAssignment('tab-reset-reentrant'), undefined);
		assert.strictEqual(host.getAssignmentRevision('tab-reset-reentrant'), 2);
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-reset-reentrant',
			sessionId: null,
			code: 'invalid_session_state',
			message: 'Agent reset is still being committed.',
			canRestart: false,
			switchAttemptId: 2,
		});
	});

	test('Reset 완료 뒤 새 assignment start는 이전 cleanup barrier를 기다린다', async () => {
		let releaseTermination!: () => void;
		const terminationPending = new Promise<void>((resolve) => {
			releaseTermination = resolve;
		});
		const controller = new FakeProcessTreeController({
			beforeTerminate: () => terminationPending,
		});
		const adapter = new FakePtyAdapter(4316);
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			processTreeController: controller,
		});
		host.createTab('tab-reset-barrier');
		await host.handleTerminalReady('tab-reset-barrier', 80, 24);
		await host.switchAgent(
			'tab-reset-barrier',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);

		host.resetAgent('tab-reset-barrier');
		const switching = host.switchAgent(
			'tab-reset-barrier',
			'claude',
			WORKSPACE_ROOT_ID,
			2,
		);
		const ready = host.handleTerminalReady('tab-reset-barrier', 100, 30);
		await waitUntil(() => controller.calls.includes('terminate:4316'));
		assert.strictEqual(adapter.spawnCalls.length, 1);

		releaseTermination();
		await Promise.all([switching, ready]);

		assert.strictEqual(adapter.spawnCalls.length, 2);
		assert.strictEqual(host.getTabAssignment('tab-reset-barrier')?.providerId, 'claude');
		assert.strictEqual(host.getActiveSession('tab-reset-barrier')?.state.kind, 'running');
	});
});

suite('TerminalHost start orchestration', () => {
	test('final preflight의 latest fsPath를 await 없이 generic spawn cwd에 적용한다', async () => {
		let workspaceCalls = 0;
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: async () => ({
				ok: true,
				policy: { ...launchPolicy, cwd: '/stale/preparation/path' },
			}),
			workspaceResolver: () => {
				workspaceCalls += 1;
				return {
					ok: true,
					root: {
						...root,
						fsPath: (
							workspaceCalls === 1
								? '/preflight/path'
								: '/fresh/final/path'
						) as ValidatedWorkspaceFsPath,
					},
				};
			},
		});
		host.createTab('tab-final-cwd');
		await host.handleTerminalReady('tab-final-cwd', 80, 24);

		await host.switchAgent(
			'tab-final-cwd',
			'antigravity',
			WORKSPACE_ROOT_ID,
			1,
		);

		assert.strictEqual(workspaceCalls, 2);
		assert.strictEqual(adapter.spawnCalls.length, 1);
		assert.strictEqual(adapter.spawnCalls[0].cwd, '/fresh/final/path');
	});

	test('post-assignment Workspace 실패는 non-null retry session과 assignment를 보존한다', async () => {
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			workspaceResolver: () => ({ ok: true, root }),
			prepareLaunch: async (tabId, sessionId) => ({
				ok: false,
				error: {
					type: 'terminal.error',
					tabId,
					sessionId,
					code: 'workspace_root_unavailable',
					message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
					canRestart: true,
				},
			}),
		});
		host.createTab('tab-post-assignment-failure');
		await host.handleTerminalReady('tab-post-assignment-failure', 80, 24);

		await host.switchAgent(
			'tab-post-assignment-failure',
			'antigravity',
			WORKSPACE_ROOT_ID,
			1,
		);

		const assignment = host.getTabAssignment('tab-post-assignment-failure');
		const session = host.getActiveSession('tab-post-assignment-failure');
		assert.ok(assignment);
		assert.ok(session);
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_root_unavailable',
		});
		assert.strictEqual(adapter.spawnCalls.length, 0);
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-post-assignment-failure',
			sessionId: session.sessionId,
			code: 'workspace_root_unavailable',
			message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
			canRestart: true,
		});
	});

	test('final preflight 실패는 spawn 없이 retry session을 error로 보존한다', async () => {
		let workspaceCalls = 0;
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			workspaceResolver: () => {
				workspaceCalls += 1;
				return workspaceCalls === 1
					? { ok: true, root }
					: { ok: false, code: 'workspace_path_invalid' };
			},
		});
		host.createTab('tab-final-preflight-failure');
		await host.handleTerminalReady('tab-final-preflight-failure', 80, 24);

		await host.switchAgent(
			'tab-final-preflight-failure',
			'antigravity',
			WORKSPACE_ROOT_ID,
			1,
		);

		const session = host.getActiveSession('tab-final-preflight-failure');
		assert.ok(session);
		assert.strictEqual(workspaceCalls, 2);
		assert.strictEqual(adapter.spawnCalls.length, 0);
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_path_invalid',
		});
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-final-preflight-failure',
			sessionId: session.sessionId,
			code: 'workspace_path_invalid',
			message: '유효한 로컬 작업공간 폴더를 연 후 다시 시도하세요.',
			canRestart: true,
		});
	});

	test('generic Windows child guard 실패 뒤 final preflight도 PTY start를 차단한다', async () => {
		let workspaceAvailable = true;
		let workspaceCalls = 0;
		let childGuardCalls = 0;
		const adapter = new FakePtyAdapter();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			workspaceResolver: () => {
				workspaceCalls += 1;
				return workspaceAvailable
					? { ok: true, root }
					: { ok: false, code: 'workspace_root_unavailable' };
			},
			resolveAgentAutoRunInput: async (
				_providerId,
				_policy,
				_signal,
				resolveWorkspaceCwdBeforeSpawn,
			) => {
				workspaceAvailable = false;
				childGuardCalls += 1;
				assert.strictEqual(resolveWorkspaceCwdBeforeSpawn?.(), undefined);
				return 'agy\r';
			},
		});
		host.createTab('tab-windows-probe-preflight');
		await host.handleTerminalReady('tab-windows-probe-preflight', 80, 24);

		await host.switchAgent(
			'tab-windows-probe-preflight',
			'antigravity',
			WORKSPACE_ROOT_ID,
			1,
		);

		const session = host.getActiveSession('tab-windows-probe-preflight');
		assert.ok(session);
		assert.strictEqual(childGuardCalls, 1);
		assert.strictEqual(workspaceCalls, 3);
		assert.strictEqual(adapter.spawnCalls.length, 0);
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_root_unavailable',
		});
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-windows-probe-preflight',
			sessionId: session.sessionId,
			code: 'workspace_root_unavailable',
			message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
			canRestart: true,
		});
	});

	test('stale preparation continuation은 같은 root의 새 assignment를 spawn하지 않는다', async () => {
		let releaseFirst!: (
			value: Awaited<ReturnType<PrepareTerminalLaunch>>,
		) => void;
		let preparationCalls = 0;
		const adapter = new FakePtyAdapter();
		const { host } = createHost({
			ptyAdapter: adapter,
			workspaceResolver: () => ({ ok: true, root }),
			prepareLaunch: () => {
				preparationCalls += 1;
				if (preparationCalls === 1) {
					return new Promise((resolve) => {
						releaseFirst = resolve;
					});
				}
				return Promise.resolve({ ok: true, policy: launchPolicy });
			},
		});
		host.createTab('tab-stale-preparation');
		await host.handleTerminalReady('tab-stale-preparation', 80, 24);
		const switchA = host.switchAgent(
			'tab-stale-preparation',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);
		await waitUntil(() => preparationCalls === 1);

		const switchB = host.switchAgent(
			'tab-stale-preparation',
			'claude',
			WORKSPACE_ROOT_ID,
			2,
		);
		await switchB;
		releaseFirst({ ok: true, policy: launchPolicy });
		await switchA;

		assert.strictEqual(preparationCalls, 2);
		assert.strictEqual(adapter.spawnCalls.length, 1);
		assert.strictEqual(host.getTabAssignment('tab-stale-preparation')?.providerId, 'claude');
		assert.strictEqual(host.getActiveSession('tab-stale-preparation')?.state.kind, 'running');
	});

	test('workspace와 Shell policy 결과로 PTY를 시작하고 Host sessionId를 전달한다', async () => {
		let workspaceCalls = 0;
		let shellCalls = 0;
		const adapter = new FakePtyAdapter(9201);
		const prepare = createPrepareTerminalLaunch({
			workspaceResolver: (workspaceRootId) => {
				workspaceCalls += 1;
				assert.strictEqual(workspaceRootId, WORKSPACE_ROOT_ID);
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

		host.createTab('tab-start-success');
		await host.handleTerminalReady('tab-start-success', 120, 36);
		await host.switchAgent(
			'tab-start-success',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);

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
				type: 'agent.switchAccepted',
				tabId: 'tab-start-success',
				providerId: 'codex',
				workspaceRootId: WORKSPACE_ROOT_ID,
				switchAttemptId: 1,
				assignmentRevision: 1,
			},
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

		host.createTab('tab-workspace-failure');
		await host.handleTerminalReady('tab-workspace-failure', 80, 24);
		await host.switchAgent(
			'tab-workspace-failure',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);

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

		host.createTab('tab-shell-failure');
		await host.handleTerminalReady('tab-shell-failure', 80, 24);
		await host.switchAgent(
			'tab-shell-failure',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);

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
	test('cleanup 전 Workspace preflight 실패는 기존 session과 process를 보존한다', async () => {
		let workspaceAvailable = true;
		const adapter = new FakePtyAdapter(4313);
		const controller = new FakeProcessTreeController();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			processTreeController: controller,
			workspaceResolver: () => workspaceAvailable
				? { ok: true, root }
				: { ok: false, code: 'workspace_root_unavailable' },
		});
		host.createTab('tab-restart-preflight');
		await host.handleTerminalReady('tab-restart-preflight', 80, 24);
		await host.switchAgent(
			'tab-restart-preflight',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);
		const session = host.getActiveSession('tab-restart-preflight');
		assert.ok(session);
		adapter.handles[0].emitExit({ exitCode: 1 });
		workspaceAvailable = false;

		await host.restartSession('tab-restart-preflight', session.sessionId);

		assert.strictEqual(host.getActiveSession('tab-restart-preflight'), session);
		assert.deepStrictEqual(session.state, {
			kind: 'exited',
			exitCode: 1,
			signal: null,
		});
		assert.strictEqual(adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(controller.calls, []);
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-restart-preflight',
			sessionId: session.sessionId,
			code: 'workspace_root_unavailable',
			message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
			canRestart: true,
		});
	});

	test('cleanup 이후 Workspace 실패는 새 retry session을 error로 보존한다', async () => {
		let workspaceAvailable = true;
		let releaseTermination!: () => void;
		const terminationPending = new Promise<void>((resolve) => {
			releaseTermination = resolve;
		});
		const controller = new FakeProcessTreeController({
			beforeTerminate: () => terminationPending,
		});
		const adapter = new FakePtyAdapter(4312);
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			processTreeController: controller,
			workspaceResolver: () => workspaceAvailable
				? { ok: true, root }
				: { ok: false, code: 'workspace_path_invalid' },
		});
		host.createTab('tab-restart-post-cleanup');
		await host.handleTerminalReady('tab-restart-post-cleanup', 80, 24);
		await host.switchAgent(
			'tab-restart-post-cleanup',
			'antigravity',
			WORKSPACE_ROOT_ID,
			1,
		);
		const first = host.getActiveSession('tab-restart-post-cleanup');
		assert.ok(first);
		adapter.handles[0].emitExit({ exitCode: 0 });

		const restarting = host.restartSession(
			'tab-restart-post-cleanup',
			first.sessionId,
		);
		await waitUntil(() => controller.calls.includes('terminate:4312'));
		workspaceAvailable = false;
		releaseTermination();
		await restarting;

		const second = host.getActiveSession('tab-restart-post-cleanup');
		assert.ok(second);
		assert.notStrictEqual(second.sessionId, first.sessionId);
		assert.deepStrictEqual(second.state, {
			kind: 'error',
			code: 'workspace_path_invalid',
		});
		assert.strictEqual(adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-restart-post-cleanup',
			sessionId: second.sessionId,
			code: 'workspace_path_invalid',
			message: '유효한 로컬 작업공간 폴더를 연 후 다시 시도하세요.',
			canRestart: true,
		});
	});

	test('restart final preflight의 latest fsPath를 새 PTY cwd로 사용한다', async () => {
		let workspaceCalls = 0;
		const adapter = new FakePtyAdapter(4311);
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: async () => ({
				ok: true,
				policy: { ...launchPolicy, cwd: '/stale/preparation/path' },
			}),
			workspaceResolver: () => {
				workspaceCalls += 1;
				return {
					ok: true,
					root: {
						...root,
						fsPath: `/fresh/workspace-${workspaceCalls}` as ValidatedWorkspaceFsPath,
					},
				};
			},
		});
		host.createTab('tab-restart-fresh-cwd');
		await host.handleTerminalReady('tab-restart-fresh-cwd', 80, 24);
		await host.switchAgent(
			'tab-restart-fresh-cwd',
			'antigravity',
			WORKSPACE_ROOT_ID,
			1,
		);
		const first = host.getActiveSession('tab-restart-fresh-cwd');
		assert.ok(first);
		adapter.handles[0].emitExit({ exitCode: 0 });

		await host.restartSession('tab-restart-fresh-cwd', first.sessionId);

		assert.strictEqual(workspaceCalls, 4);
		assert.strictEqual(adapter.spawnCalls[0].cwd, '/fresh/workspace-2');
		assert.strictEqual(adapter.spawnCalls[1].cwd, '/fresh/workspace-4');
	});

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

		host.createTab('tab-restart');
		await host.handleTerminalReady('tab-restart', 120, 36);
		await host.switchAgent(
			'tab-restart',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);
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

suite('TerminalHost Workspace Trust revoke', () => {
	test('input 경계의 revoke는 I/O를 즉시 차단하고 assignment와 retry session을 보존한다', async () => {
		let trusted = true;
		let refreshCalls = 0;
		const scheduler = new FakeWorkspaceTrustMonitorScheduler();
		const adapter = new FakePtyAdapter(9311);
		const controller = new FakeProcessTreeController();
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			readWorkspaceTrust: () => trusted,
			workspaceTrustMonitorScheduler: scheduler,
			onWorkspaceTrustRevoked: () => refreshCalls += 1,
			processTreeController: controller,
		});

		host.createTab('tab-trust-input');
		await host.handleTerminalReady('tab-trust-input', 80, 24);
		await host.switchAgent(
			'tab-trust-input',
			'antigravity',
			WORKSPACE_ROOT_ID,
			1,
		);
		const assignment = host.getTabAssignment('tab-trust-input');
		const session = host.getActiveSession('tab-trust-input');
		assert.ok(assignment !== undefined);
		assert.ok(session !== undefined);
		const writesBeforeRevoke = adapter.handles[0].writes.length;
		const outputCountBeforeRevoke = messages.filter(
			(message) => message.type === 'terminal.output',
		).length;

		trusted = false;
		host.routeInput({
			type: 'terminal.input',
			tabId: session.tabId,
			sessionId: session.sessionId,
			data: 'must-not-run',
		});
		host.routeResize({
			type: 'terminal.resize',
			tabId: session.tabId,
			sessionId: session.sessionId,
			cols: 120,
			rows: 40,
		});
		adapter.handles[0].emitData('must-not-publish');

		assert.strictEqual(adapter.handles[0].writes.length, writesBeforeRevoke);
		assert.strictEqual(adapter.handles[0].resizes.length, 0);
		assert.strictEqual(adapter.handles[0].dataListenerCount, 0);
		assert.strictEqual(adapter.handles[0].exitListenerCount, 0);
		assert.strictEqual(
			messages.filter((message) => message.type === 'terminal.output').length,
			outputCountBeforeRevoke,
		);
		assert.strictEqual(host.getTabAssignment(session.tabId), assignment);
		assert.strictEqual(host.getActiveSession(session.tabId), session);
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_untrusted',
		});
		assert.strictEqual(refreshCalls, 1);
		assert.strictEqual(scheduler.activeCount, 0);
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal.error',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'workspace_untrusted',
			message: '작업공간을 신뢰한 후 다시 시도하세요.',
			canRestart: true,
		});

		await waitUntil(() => controller.calls.includes('terminate:9311'));
		assert.strictEqual(adapter.handles[0].killCallCount, 0);
	});

	test('bounded monitor는 출력 없는 CLI revoke를 감지하고 Trust 복구 뒤 같은 assignment를 재시작한다', async () => {
		let trusted = true;
		let refreshCalls = 0;
		const scheduler = new FakeWorkspaceTrustMonitorScheduler();
		const adapter = new FakePtyAdapter(9312);
		const controller = new FakeProcessTreeController();
		const { host } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			workspaceResolver: () => trusted
				? { ok: true, root }
				: { ok: false, code: 'workspace_untrusted' },
			readWorkspaceTrust: () => trusted,
			workspaceTrustMonitorScheduler: scheduler,
			onWorkspaceTrustRevoked: () => refreshCalls += 1,
			processTreeController: controller,
		});

		host.createTab('tab-trust-monitor');
		await host.handleTerminalReady('tab-trust-monitor', 100, 30);
		await host.switchAgent(
			'tab-trust-monitor',
			'antigravity',
			WORKSPACE_ROOT_ID,
			1,
		);
		const assignment = host.getTabAssignment('tab-trust-monitor');
		const originalSession = host.getActiveSession('tab-trust-monitor');
		assert.ok(assignment !== undefined);
		assert.ok(originalSession !== undefined);
		assert.strictEqual(scheduler.activeCount, 1);
		assert.deepStrictEqual(scheduler.intervals, [
			WORKSPACE_TRUST_MONITOR_INTERVAL_MS,
		]);

		trusted = false;
		scheduler.fireAll();
		scheduler.fireAll();

		assert.deepStrictEqual(originalSession.state, {
			kind: 'error',
			code: 'workspace_untrusted',
		});
		assert.strictEqual(refreshCalls, 1);
		assert.strictEqual(scheduler.activeCount, 0);
		await waitUntil(() => controller.calls.includes('terminate:9312'));

		const spawnCountBeforeRejectedRestart = adapter.spawnCalls.length;
		await host.restartSession(
			originalSession.tabId,
			originalSession.sessionId,
		);
		assert.strictEqual(
			host.getActiveSession('tab-trust-monitor'),
			originalSession,
		);
		assert.strictEqual(host.getTabAssignment('tab-trust-monitor'), assignment);
		assert.deepStrictEqual(originalSession.state, {
			kind: 'error',
			code: 'workspace_untrusted',
		});
		assert.strictEqual(
			adapter.spawnCalls.length,
			spawnCountBeforeRejectedRestart,
		);

		trusted = true;
		await host.restartSession(
			originalSession.tabId,
			originalSession.sessionId,
		);
		const restartedSession = host.getActiveSession('tab-trust-monitor');
		assert.ok(restartedSession !== undefined);
		assert.notStrictEqual(restartedSession, originalSession);
		assert.strictEqual(host.getTabAssignment('tab-trust-monitor'), assignment);
		assert.strictEqual(restartedSession.state.kind, 'running');
		assert.strictEqual(scheduler.activeCount, 1);
		assert.deepStrictEqual(scheduler.intervals, [
			WORKSPACE_TRUST_MONITOR_INTERVAL_MS,
			WORKSPACE_TRUST_MONITOR_INTERVAL_MS,
		]);
	});

	test('root removal은 Trust gate를 닫지 않아 running CLI와 I/O를 유지한다', async () => {
		let rootAvailable = true;
		const scheduler = new FakeWorkspaceTrustMonitorScheduler();
		const adapter = new FakePtyAdapter(9313);
		const { host, messages } = createHost({
			ptyAdapter: adapter,
			prepareLaunch: successfulPrepare,
			workspaceResolver: () => rootAvailable
				? { ok: true, root }
				: { ok: false, code: 'workspace_root_unavailable' },
			readWorkspaceTrust: () => true,
			workspaceTrustMonitorScheduler: scheduler,
		});

		host.createTab('tab-root-removal-running');
		await host.handleTerminalReady('tab-root-removal-running', 80, 24);
		await host.switchAgent(
			'tab-root-removal-running',
			'antigravity',
			WORKSPACE_ROOT_ID,
			1,
		);
		const session = host.getActiveSession('tab-root-removal-running');
		assert.ok(session !== undefined);
		const writesBefore = adapter.handles[0].writes.length;

		rootAvailable = false;
		scheduler.fireAll();
		host.routeInput({
			type: 'terminal.input',
			tabId: session.tabId,
			sessionId: session.sessionId,
			data: 'still-running',
		});
		adapter.handles[0].emitData('still-visible');
		await Promise.resolve();

		assert.strictEqual(session.state.kind, 'running');
		assert.strictEqual(adapter.handles[0].writes.length, writesBefore + 1);
		assert.strictEqual(adapter.handles[0].writes.at(-1), 'still-running');
		assert.strictEqual(adapter.handles[0].killCallCount, 0);
		assert.strictEqual(messages.some((message) => (
			message.type === 'terminal.output'
			&& message.data === 'still-visible'
		)), true);
	});

	test('detach와 dispose는 active Trust monitor interval을 정확히 한 번 해제한다', async () => {
		for (const lifecycle of ['detach', 'dispose'] as const) {
			let trusted = true;
			let refreshCalls = 0;
			const scheduler = new FakeWorkspaceTrustMonitorScheduler();
			const { host } = createHost({
				ptyAdapter: new FakePtyAdapter(),
				prepareLaunch: successfulPrepare,
				readWorkspaceTrust: () => trusted,
				workspaceTrustMonitorScheduler: scheduler,
				onWorkspaceTrustRevoked: () => refreshCalls += 1,
			});
			const tabId = `tab-trust-monitor-${lifecycle}`;
			host.createTab(tabId);
			await host.handleTerminalReady(tabId, 80, 24);
			await host.switchAgent(
				tabId,
				'antigravity',
				WORKSPACE_ROOT_ID,
				1,
			);
			assert.strictEqual(scheduler.activeCount, 1);

			if (lifecycle === 'detach') {
				host.detach();
				host.detach();
			} else {
				host.dispose();
				host.dispose();
			}

			assert.strictEqual(scheduler.activeCount, 0);
			assert.deepStrictEqual(scheduler.clearedHandles, [1]);
			trusted = false;
			scheduler.fireAll();
			assert.strictEqual(refreshCalls, 0);
			if (lifecycle === 'detach') {
				await host.terminate();
			}
		}
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
