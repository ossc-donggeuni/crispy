import * as assert from 'node:assert/strict';
import type { HostToWebviewMessage } from '../../agent/protocol/messages';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';
import type { PrepareTerminalLaunch } from '../../agent/host/terminal/prepareTerminalLaunch';
import {
	TerminalHost,
	type CodexMcpSupervisor,
	type TaskTerminalSessionEvent,
} from '../../agent/host/terminal/terminalHost';
import type { SupervisorRuntimeEvent } from '../../mcp/adapterSupervisor';
import { buildCodexMcpLaunchPlan } from '../../mcp/codexLaunchPlan';
import { McpConnectionDescriptor } from '../../mcp/sessionRuntime';
import type {
	McpPrepareResult,
	McpRuntimeLifecycle,
	McpSessionRuntime,
	McpSessionRuntimeEvent,
} from '../../mcp/sessionRuntime';
import { FakePtyAdapter } from './support/fakePtyAdapter';
import { createCaptureFailureProcessTreeController } from './support/fakeProcessTreeController';
import { FakeProcessTreeController } from './support/fakeProcessTreeController';
import type { ProcessTreeController } from '../../agent/host/terminal/processTreeController';
import type { ValidatedWorkspaceFsPath } from '../../agent/host/workspace/types';
import type { TaskToolLease } from '../../mcp/taskToolProtocol';

const shellPolicy: ShellLaunchPolicy = {
	executable: '/host/shell',
	args: [],
	cwd: '/trusted/workspace',
	env: { PATH: '/bin' },
};
const WORKSPACE_ROOT_ID = 'workspace-root:file:///trusted/workspace';
const workspaceRoot = {
	id: WORKSPACE_ROOT_ID,
	scheme: 'file',
	fsPath: '/trusted/workspace',
	workspaceFolder: {
		name: 'trusted-workspace',
		index: 0,
		uri: { toString: () => 'file:///trusted/workspace' },
	},
} as unknown as import('../../agent/host/workspace/types').ValidatedWorkspaceRoot;

const successfulShellPrepare: PrepareTerminalLaunch = async () => ({
	ok: true,
	policy: shellPolicy,
});

class FakeCodexRuntime {
	lifecycle: McpRuntimeLifecycle = 'running';
	markProviderStartedCount = 0;

	constructor(
		readonly sessionId: string,
		readonly generation: string,
	) {}

	markProviderStarted(): boolean {
		if (this.lifecycle !== 'running') {
			return false;
		}
		this.markProviderStartedCount += 1;
		return true;
	}
}

type FakeCodexRuntimeHandle = FakeCodexRuntime & McpSessionRuntime;

class FakeCodexSupervisor implements CodexMcpSupervisor {
	readonly prepareCalls: string[] = [];
	readonly taskLeases: Array<TaskToolLease | undefined> = [];
	readonly stopCalls: string[] = [];
	disposeCallCount = 0;
	prepareFailure: McpPrepareResult | undefined;
	deferPrepare = false;
	private generationIndex = 0;
	private disposePromise: Promise<void> | undefined;
	private readonly runtimes = new Map<string, FakeCodexRuntimeHandle>();
	private readonly retirements = new Map<McpSessionRuntime, Promise<void>>();
	private readonly connections = new Map<string, McpConnectionDescriptor>();
	private readonly pending = new Map<string, {
		readonly resolve: (result: McpPrepareResult) => void;
	}>();

	prepareSession(
		sessionId: string,
		taskLease?: TaskToolLease,
	): Promise<McpPrepareResult> {
		this.prepareCalls.push(sessionId);
		this.taskLeases.push(taskLease);
		if (this.prepareFailure !== undefined) {
			this.createRuntime(sessionId, 'stopped');
			return Promise.resolve(this.prepareFailure);
		}
		if (!this.deferPrepare) {
			return Promise.resolve(this.createSuccess(sessionId));
		}
		this.createRuntime(sessionId);
		return new Promise((resolve) => {
			this.pending.set(sessionId, { resolve });
		});
	}

	completePrepare(sessionId: string): void {
		const pending = this.pending.get(sessionId);
		assert.ok(pending !== undefined);
		this.pending.delete(sessionId);
		pending.resolve(this.createSuccess(sessionId));
	}

	getSessionRuntime(sessionId: string): FakeCodexRuntimeHandle | undefined {
		return this.runtimes.get(sessionId);
	}

	retireExactRuntime(runtime: McpSessionRuntime): Promise<void> {
		const existing = this.retirements.get(runtime);
		if (existing !== undefined) {
			return existing;
		}
		if (this.runtimes.get(runtime.sessionId) !== runtime) {
			return Promise.resolve();
		}

		let resolveRetirement!: () => void;
		const retirement = new Promise<void>((resolve) => {
			resolveRetirement = resolve;
		});
		this.retirements.set(runtime, retirement);
		this.stopCalls.push(runtime.sessionId);
		this.connections.get(runtime.sessionId)?.invalidate();
		this.connections.delete(runtime.sessionId);
		(runtime as FakeCodexRuntimeHandle).lifecycle = 'stopped';
		this.runtimes.delete(runtime.sessionId);
		resolveRetirement();
		void retirement.then(() => {
			if (this.retirements.get(runtime) === retirement) {
				this.retirements.delete(runtime);
			}
		});
		return retirement;
	}

	dispose(): Promise<void> {
		if (this.disposePromise !== undefined) {
			return this.disposePromise;
		}
		this.disposeCallCount += 1;
		this.disposePromise = Promise.all(
			[...this.runtimes.values()].map(
				(runtime) => this.retireExactRuntime(runtime),
			),
		).then(() => undefined);
		return this.disposePromise;
	}

	crash(sessionId: string): SupervisorRuntimeEvent {
		const runtime = this.runtimes.get(sessionId);
		assert.ok(runtime !== undefined);
		runtime.lifecycle = 'crashed';
		this.connections.get(sessionId)?.invalidate();
		const event: McpSessionRuntimeEvent = {
			type: 'runtime.failure',
			generation: runtime.generation,
			sessionId,
			failure: { reason: 'adapter_exited', retryable: true },
			providerStarted: runtime.markProviderStartedCount > 0,
			providerAction: runtime.markProviderStartedCount > 0
				? 'keep_running'
				: 'continue_without_mcp',
		};
		return { sourceRuntime: runtime, event };
	}

	activity(sessionId: string): SupervisorRuntimeEvent {
		const runtime = this.runtimes.get(sessionId);
		assert.ok(runtime !== undefined);
		const event: McpSessionRuntimeEvent = {
			type: 'session.mcpActivityObserved',
			generation: runtime.generation,
			sessionId,
		};
		return { sourceRuntime: runtime, event };
	}

	private createSuccess(sessionId: string): McpPrepareResult {
		const runtime = this.runtimes.get(sessionId)
			?? this.createRuntime(sessionId);
		const generation = runtime.generation;
		const route = Buffer.alloc(24, this.generationIndex).toString('base64url');
		const credential = Buffer.alloc(32, this.generationIndex + 16)
			.toString('base64url');
		const connection = new McpConnectionDescriptor(
			generation,
			sessionId,
			`http://127.0.0.1:${44000 + this.generationIndex}/mcp/${route}`,
			credential,
		);
		this.connections.set(sessionId, connection);
		return { ok: true, connection };
	}

	private createRuntime(
		sessionId: string,
		lifecycle: McpRuntimeLifecycle = 'running',
	): FakeCodexRuntimeHandle {
		this.generationIndex += 1;
		const runtime = new FakeCodexRuntime(
			sessionId,
			`generation-${this.generationIndex}`,
		) as unknown as FakeCodexRuntimeHandle;
		runtime.lifecycle = lifecycle;
		this.runtimes.set(
			sessionId,
			runtime,
		);
		return runtime;
	}
}

function createFixture(options: {
	readonly fakePid?: number;
	readonly supervisor?: FakeCodexSupervisor;
	readonly configStyle?: 'keyed-filters' | 'legacy-exclude' | null;
	readonly buildPlan?: ConstructorParameters<typeof TerminalHost>[0][
		'buildCodexMcpLaunchPlan'
	];
	readonly processTreeController?: ProcessTreeController;
	readonly workspaceResolver?: ConstructorParameters<typeof TerminalHost>[0][
		'workspaceResolver'
	];
	readonly readWorkspaceTrust?: ConstructorParameters<typeof TerminalHost>[0][
		'readWorkspaceTrust'
	];
	readonly onWorkspaceTrustRevoked?: ConstructorParameters<typeof TerminalHost>[0][
		'onWorkspaceTrustRevoked'
	];
	readonly prepareCodexLaunch?: ConstructorParameters<typeof TerminalHost>[0][
		'prepareCodexLaunch'
	];
	readonly onTaskSessionEvent?: (event: TaskTerminalSessionEvent) => void;
	readonly taskTurnReminderScheduler?: ConstructorParameters<typeof TerminalHost>[0][
		'taskTurnReminderScheduler'
	];
} = {}): {
	readonly host: TerminalHost;
	readonly adapter: FakePtyAdapter;
	readonly supervisor: FakeCodexSupervisor;
	readonly messages: HostToWebviewMessage[];
} {
	const adapter = new FakePtyAdapter(options.fakePid ?? 7201);
	const supervisor = options.supervisor ?? new FakeCodexSupervisor();
	const messages: HostToWebviewMessage[] = [];
	const host = new TerminalHost({
		ptyAdapter: adapter,
		prepareLaunch: successfulShellPrepare,
		workspaceResolver: options.workspaceResolver
			?? (() => ({ ok: true, root: workspaceRoot })),
		readWorkspaceTrust: options.readWorkspaceTrust ?? (() => true),
		onWorkspaceTrustRevoked: options.onWorkspaceTrustRevoked,
		resolveAgentAutoRunInput: async (providerId) =>
			providerId === 'claude' ? 'claude\r' : 'codex\r',
		prepareCodexLaunch: options.prepareCodexLaunch ?? (async () => ({
			ok: true,
			preparation: {
				executable: {
					executable: '/resolved/codex',
					launcherKind: 'direct',
				},
				cwd: '/trusted/workspace',
				environment: {
					PATH: '/bin',
					crispy_mcp_token: 'stale',
					Electron_Run_As_Node: '1',
				},
				platform: 'linux',
				...(options.configStyle === null
					? {}
					: {
						shellEnvironmentPolicyStyle:
							options.configStyle ?? 'keyed-filters',
					}),
			},
		})),
		/** Cross-provider cancellation tests use a direct, credential-free Claude. */
		prepareClaudeLaunch: async () => ({
			ok: true,
			preparation: {
				executable: {
					executable: '/resolved/claude',
					launcherKind: 'direct',
				},
				cwd: '/trusted/workspace',
				environment: { PATH: '/bin' },
				platform: 'linux',
				mcpCompatible: false,
			},
		}),
		mcpSupervisor: supervisor,
		processTreeController: options.processTreeController
			?? createCaptureFailureProcessTreeController(),
		onTaskSessionEvent: options.onTaskSessionEvent,
		taskTurnReminderScheduler: options.taskTurnReminderScheduler,
		...(options.buildPlan === undefined
			? {}
			: { buildCodexMcpLaunchPlan: options.buildPlan }),
		emitMessage: (message) => messages.push(message),
	});
	return { host, adapter, supervisor, messages };
}

async function beginCodex(
	host: TerminalHost,
	tabId: string,
): Promise<void> {
	host.createTab(tabId);
	await host.handleTerminalReady(tabId, 100, 30);
	return host.switchAgent(tabId, 'codex', WORKSPACE_ROOT_ID, 1);
}

function createDeferredCodexPreparationCleanup(): {
	readonly prepareCodexLaunch: NonNullable<ConstructorParameters<
		typeof TerminalHost
	>[0]['prepareCodexLaunch']>;
	readonly started: Promise<void>;
	readonly releaseCleanup: () => void;
	readonly wasAborted: () => boolean;
} {
	let markStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	let releaseCleanup!: () => void;
	const cleanup = new Promise<void>((resolve) => {
		releaseCleanup = resolve;
	});
	let aborted = false;
	const prepareCodexLaunch: NonNullable<ConstructorParameters<
		typeof TerminalHost
	>[0]['prepareCodexLaunch']> = (
		_tabId,
		_sessionId,
		_workspaceRootId,
		signal,
	) => new Promise((resolve) => {
		markStarted();
		const finish = (): void => {
			aborted = true;
			void cleanup.then(() => resolve({
				ok: true,
				preparation: {
					executable: {
						executable: '/resolved/codex',
						launcherKind: 'direct',
					},
					cwd: '/trusted/workspace',
					environment: { PATH: '/bin' },
					platform: 'linux',
					shellEnvironmentPolicyStyle: 'keyed-filters',
				},
			}));
		};
		if (signal?.aborted) {
			finish();
			return;
		}
		signal?.addEventListener('abort', finish, { once: true });
	});
	return {
		prepareCodexLaunch,
		started,
		releaseCleanup,
		wasAborted: () => aborted,
	};
}

suite('Codex direct PTY and MCP transaction', () => {
	test('Task Work는 소유 workspace cwd의 ordinary tab transaction에 scope policy·prompt·MCP lease를 고정한다', async () => {
		const events: TaskTerminalSessionEvent[] = [];
		const ownerRootId = 'workspace-root:file:///trusted/owner-workspace' as const;
		const ownerWorkspaceRoot = {
			id: ownerRootId,
			scheme: 'file',
			fsPath: '/trusted/owner-workspace',
			workspaceFolder: {
				name: 'owner-workspace',
				index: 1,
				uri: { toString: () => 'file:///trusted/owner-workspace' },
			},
		} as unknown as import('../../agent/host/workspace/types').ValidatedWorkspaceRoot;
		const resolvedRootIds: string[] = [];
		const fixture = createFixture({
			onTaskSessionEvent: (event) => events.push(event),
			workspaceResolver: (workspaceRootId) => {
				resolvedRootIds.push(workspaceRootId);
				return workspaceRootId === ownerRootId
					? { ok: true, root: ownerWorkspaceRoot }
					: { ok: false, code: 'workspace_root_unavailable' };
			},
		});
		const descriptor = {
			executionId: 'execution-terminal-task',
			workNodeId: 'work-terminal-task',
			prompt: [
				'Task: Implement feature',
				'Reference areas (read-only):',
				'- /trusted/workspace/docs',
				'Work areas (read/write):',
				'- /trusted/workspace/src',
			].join('\n'),
			scope: [
				{ path: '/trusted/workspace/docs', kind: 'folder' as const, access: 'read' as const },
				{ path: '/trusted/workspace/src', kind: 'folder' as const, access: 'read-write' as const },
			],
		};

		await fixture.host.createTaskSession(
			'tab-task-work',
			'codex',
			ownerRootId,
			1,
			descriptor,
		);
		await fixture.host.handleTerminalReady('tab-task-work', 100, 30);

		const session = fixture.host.getActiveSession('tab-task-work');
		assert.ok(session);
		assert.deepStrictEqual(fixture.supervisor.taskLeases, [{
			executionId: descriptor.executionId,
			workNodeId: descriptor.workNodeId,
		}]);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		const spawn = fixture.adapter.spawnCalls[0];
		assert.strictEqual(spawn.cwd, ownerWorkspaceRoot.fsPath);
		assert.ok(resolvedRootIds.length >= 2);
		assert.ok(resolvedRootIds.every((rootId) => rootId === ownerRootId));
		assert.deepStrictEqual((spawn.args as string[]).slice(0, 7), [
			'--strict-config',
			'--ask-for-approval',
			'on-request',
			'--config',
			'default_permissions="crispy-task"',
			'--config',
			'permissions.crispy-task.filesystem={":minimal"="read","/trusted/workspace/docs"="read","/trusted/workspace/src"="write","/resolved/codex"="read"}',
		]);
		assert.ok((spawn.args as string[]).includes(
			'tui.notifications=["agent-turn-complete"]',
		));
		assert.ok((spawn.args as string[]).includes(
			'tui.notification_method="osc9"',
		));
		assert.ok((spawn.args as string[]).includes(
			'tui.notification_condition="always"',
		));
		assert.ok((spawn.args as string[]).some((argument) =>
			/^mcp_servers\.crispy_canvas_[a-f0-9]{32}\.enabled_tools=\["crispy_ping","crispy_task_complete","crispy_task_scope_request","crispy_task_scope_result"\]$/u.test(argument)
		));
		assert.strictEqual((spawn.args as string[]).at(-2), '--');
		assert.strictEqual((spawn.args as string[]).at(-1), descriptor.prompt);
		assert.doesNotMatch(
			(spawn.args as string[]).at(-1) ?? '',
			/Task completion requirement|crispy_task_complete/u,
		);
		const developerInstructions = (spawn.args as string[]).find(
			(argument) => argument.startsWith('developer_instructions='),
		) ?? '';
		assert.match(
			developerInstructions,
			/REQUIRED FOR CRISPY TASK SCHEDULING/u,
		);
		assert.match(developerInstructions, /crispy_task_complete/u);
		assert.deepStrictEqual(events.map(({ type }) => type), ['started']);

		// Task 소유 중 일반 reset/provider switch는 기존 session을 바꾸지 않는다.
		fixture.host.resetAgent('tab-task-work');
		await fixture.host.switchAgent(
			'tab-task-work', 'claude', ownerRootId, 2,
		);
		assert.strictEqual(fixture.host.getActiveSession('tab-task-work'), session);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);

		const runtime = fixture.supervisor.getSessionRuntime(session.sessionId);
		assert.ok(runtime);
		fixture.host.handleMcpRuntimeEvent({
			sourceRuntime: runtime,
			event: {
				type: 'session.taskToolRequested',
				sessionId: session.sessionId,
				generation: runtime.generation,
				executionId: descriptor.executionId,
				workNodeId: descriptor.workNodeId,
				operation: 'complete',
				status: 'completed',
				summary: 'Done',
			},
		});
		assert.deepStrictEqual(events.map(({ type }) => type), ['started', 'tool']);

		assert.strictEqual(await fixture.host.stopTaskSession(
			descriptor.executionId,
			descriptor.workNodeId,
		), true);
		assert.strictEqual(fixture.host.getActiveSession('tab-task-work'), undefined);
		assert.strictEqual(await fixture.host.stopTaskSession(
			descriptor.executionId,
			descriptor.workNodeId,
		), false);
	});

	test('Task Codex는 turn 완료마다 completion Tool 후속 입력을 두 번만 보내고 누락을 실패 처리한다', async () => {
		const events: TaskTerminalSessionEvent[] = [];
		const scheduled = new Map<number, () => void>();
		let nextTimer = 0;
		const fixture = createFixture({
			onTaskSessionEvent: (event) => events.push(event),
			taskTurnReminderScheduler: {
				setTimeout: (callback) => {
					nextTimer += 1;
					scheduled.set(nextTimer, callback);
					return nextTimer;
				},
				clearTimeout: (handle) => {
					scheduled.delete(Number(handle));
				},
			},
		});
		const descriptor = {
			executionId: 'execution-codex-turn',
			workNodeId: 'work-codex-turn',
			prompt: 'Task: report completion',
			scope: [],
		};
		await fixture.host.createTaskSession(
			'tab-codex-turn', 'codex', WORKSPACE_ROOT_ID, 1, descriptor,
		);
		await fixture.host.handleTerminalReady('tab-codex-turn', 100, 30);
		const handle = fixture.adapter.handles[0];
		const runReminder = (): void => {
			const entry = scheduled.entries().next().value as [number, () => void] | undefined;
			assert.ok(entry);
			scheduled.delete(entry[0]);
			entry[1]();
		};

		for (let turn = 0; turn < 2; turn += 1) {
			handle.emitData('\u001b]9;Codex turn complete\u0007');
			await Promise.resolve();
			assert.strictEqual(scheduled.size, 1);
			runReminder();
			assert.match(handle.writes.at(-1) ?? '', /crispy_task_complete/u);
			assert.ok((handle.writes.at(-1) ?? '').endsWith('\r'));
		}
		handle.emitData('\u001b]9;Codex turn complete\u001b\\');
		await Promise.resolve();
		runReminder();

		assert.strictEqual(handle.writes.length, 2);
		assert.deepStrictEqual(events.map(({ type }) => type), [
			'started', 'failed',
		]);
		assert.strictEqual(await fixture.host.stopTaskSession(
			descriptor.executionId,
			descriptor.workNodeId,
		), true);
	});

	test('Task Codex completion IPC가 grace 안에 오면 예약한 후속 입력을 취소한다', async () => {
		const events: TaskTerminalSessionEvent[] = [];
		const scheduled = new Map<number, () => void>();
		let nextTimer = 0;
		const fixture = createFixture({
			onTaskSessionEvent: (event) => events.push(event),
			taskTurnReminderScheduler: {
				setTimeout: (callback) => {
					nextTimer += 1;
					scheduled.set(nextTimer, callback);
					return nextTimer;
				},
				clearTimeout: (handle) => {
					scheduled.delete(Number(handle));
				},
			},
		});
		const descriptor = {
			executionId: 'execution-codex-turn-race',
			workNodeId: 'work-codex-turn-race',
			prompt: 'Task: report completion',
			scope: [],
		};
		await fixture.host.createTaskSession(
			'tab-codex-turn-race', 'codex', WORKSPACE_ROOT_ID, 1, descriptor,
		);
		await fixture.host.handleTerminalReady('tab-codex-turn-race', 100, 30);
		const session = fixture.host.getActiveSession('tab-codex-turn-race');
		assert.ok(session);
		const handle = fixture.adapter.handles[0];
		handle.emitData('\u001b]9;Codex turn complete\u0007');
		await Promise.resolve();
		assert.strictEqual(scheduled.size, 1);

		const runtime = fixture.supervisor.getSessionRuntime(session.sessionId);
		assert.ok(runtime);
		fixture.host.handleMcpRuntimeEvent({
			sourceRuntime: runtime,
			event: {
				type: 'session.taskToolRequested',
				sessionId: session.sessionId,
				generation: runtime.generation,
				executionId: descriptor.executionId,
				workNodeId: descriptor.workNodeId,
				operation: 'complete',
				status: 'completed',
				summary: 'Done',
			},
		});

		assert.strictEqual(scheduled.size, 0);
		assert.deepStrictEqual(handle.writes, []);
		assert.deepStrictEqual(events.map(({ type }) => type), ['started', 'tool']);
		assert.strictEqual(await fixture.host.stopTaskSession(
			descriptor.executionId,
			descriptor.workNodeId,
		), true);
	});

	test('provider switch는 이전 preparation cleanup 완료 전 새 native spawn을 차단한다', async () => {
		const deferred = createDeferredCodexPreparationCleanup();
		const fixture = createFixture({
			prepareCodexLaunch: deferred.prepareCodexLaunch,
		});
		const firstStart = beginCodex(fixture.host, 'tab-preparation-switch');
		await deferred.started;

		const switching = fixture.host.switchAgent(
			'tab-preparation-switch',
			'claude',
			WORKSPACE_ROOT_ID,
			2,
		);
		await Promise.resolve();

		assert.strictEqual(deferred.wasAborted(), true);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 0);

		deferred.releaseCleanup();
		await Promise.all([firstStart, switching]);

		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(
			fixture.adapter.spawnCalls[0].executable,
			'/resolved/claude',
		);
		assert.deepStrictEqual(fixture.adapter.handles[0].writes, []);
		assert.strictEqual(
			fixture.host.getTabProvider('tab-preparation-switch'),
			'claude',
		);
		assert.strictEqual(
			fixture.host.getActiveSession('tab-preparation-switch')?.state.kind,
			'running',
		);
	});

	test('Reset 후 switch는 이전 preparation cleanup 완료 전 새 native spawn을 차단한다', async () => {
		const deferred = createDeferredCodexPreparationCleanup();
		const fixture = createFixture({
			prepareCodexLaunch: deferred.prepareCodexLaunch,
		});
		const firstStart = beginCodex(fixture.host, 'tab-preparation-reset');
		await deferred.started;

		fixture.host.resetAgent('tab-preparation-reset');
		const switching = fixture.host.switchAgent(
			'tab-preparation-reset',
			'claude',
			WORKSPACE_ROOT_ID,
			2,
		);
		const ready = fixture.host.handleTerminalReady(
			'tab-preparation-reset',
			100,
			30,
		);
		await Promise.resolve();

		assert.strictEqual(deferred.wasAborted(), true);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 0);

		deferred.releaseCleanup();
		await Promise.all([firstStart, switching, ready]);

		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(
			fixture.adapter.spawnCalls[0].executable,
			'/resolved/claude',
		);
		assert.deepStrictEqual(fixture.adapter.handles[0].writes, []);
		assert.strictEqual(
			fixture.host.getTabProvider('tab-preparation-reset'),
			'claude',
		);
		assert.strictEqual(
			fixture.host.getActiveSession('tab-preparation-reset')?.state.kind,
			'running',
		);
	});

	test('Trust revoke는 in-flight provider preparation을 취소하고 cleanup 완료를 기다린다', async () => {
		let trusted = true;
		let preparationStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			preparationStarted = resolve;
		});
		let preparationAborted = false;
		const fixture = createFixture({
			workspaceResolver: () => trusted
				? { ok: true, root: workspaceRoot }
				: { ok: false, code: 'workspace_untrusted' },
			readWorkspaceTrust: () => trusted,
			prepareCodexLaunch: (_tabId, _sessionId, _workspaceRootId, signal) =>
				new Promise((resolve) => {
					preparationStarted();
					const finish = (): void => {
						preparationAborted = true;
						resolve({
							ok: true,
							preparation: {
								executable: {
									executable: '/resolved/codex',
									launcherKind: 'direct',
								},
								cwd: '/trusted/workspace',
								environment: { PATH: '/bin' },
								platform: 'linux',
								shellEnvironmentPolicyStyle: 'keyed-filters',
							},
						});
					};
					if (signal?.aborted) {
						finish();
						return;
					}
					signal?.addEventListener('abort', finish, { once: true });
				}),
		});
		fixture.host.createTab('tab-preparation-trust-revoke');
		await fixture.host.handleTerminalReady(
			'tab-preparation-trust-revoke',
			100,
			30,
		);
		const starting = fixture.host.switchAgent(
			'tab-preparation-trust-revoke',
			'codex',
			WORKSPACE_ROOT_ID,
			1,
		);
		await started;
		const session = fixture.host.getActiveSession(
			'tab-preparation-trust-revoke',
		);
		assert.ok(session !== undefined);

		trusted = false;
		await fixture.host.switchAgent(
			'tab-preparation-trust-revoke',
			'codex',
			WORKSPACE_ROOT_ID,
			2,
		);
		await starting;

		assert.strictEqual(preparationAborted, true);
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_untrusted',
		});
		assert.strictEqual(
			fixture.host.getActiveSession(session.tabId),
			session,
		);
		assert.deepStrictEqual(fixture.supervisor.prepareCalls, []);
		assert.deepStrictEqual(fixture.adapter.spawnCalls, []);
	});

	test('MCP spawn 경계의 Trust revoke는 adapter와 Agent spawn을 모두 차단한다', async () => {
		let refreshCalls = 0;
		const fixture = createFixture({
			readWorkspaceTrust: () => false,
			onWorkspaceTrustRevoked: () => refreshCalls += 1,
		});

		await beginCodex(fixture.host, 'tab-mcp-spawn-trust-revoke');

		const session = fixture.host.getActiveSession('tab-mcp-spawn-trust-revoke');
		assert.ok(session !== undefined);
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_untrusted',
		});
		assert.strictEqual(refreshCalls, 1);
		assert.deepStrictEqual(fixture.supervisor.prepareCalls, []);
		assert.deepStrictEqual(fixture.adapter.spawnCalls, []);
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'terminal.error',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'workspace_untrusted',
			message: '작업공간을 신뢰한 후 다시 시도하세요.',
			canRestart: true,
		});
	});

	test('final Workspace 실패는 MCP를 정리하고 bare fallback 없이 retry session을 남긴다', async () => {
		let workspaceCalls = 0;
		const fixture = createFixture({
			workspaceResolver: () => {
				workspaceCalls += 1;
				return workspaceCalls === 1
					? { ok: true, root: workspaceRoot }
					: { ok: false, code: 'workspace_root_unavailable' };
			},
		});

		await beginCodex(fixture.host, 'tab-final-workspace-failure');

		const session = fixture.host.getActiveSession('tab-final-workspace-failure');
		assert.ok(session !== undefined);
		assert.strictEqual(workspaceCalls, 2);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 0);
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_root_unavailable',
		});
		assert.deepStrictEqual(fixture.supervisor.prepareCalls, [session.sessionId]);
		assert.strictEqual(
			fixture.supervisor.stopCalls.includes(session.sessionId),
			true,
		);
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'terminal.error',
			tabId: 'tab-final-workspace-failure',
			sessionId: session.sessionId,
			code: 'workspace_root_unavailable',
			message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
			canRestart: true,
		});
	});

	test('authenticated activity 전에는 표시하지 않고 current activity 뒤 초록을 한 번만 보낸다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-status-connected');
		const session = fixture.host.getActiveSession('tab-status-connected');
		assert.ok(session !== undefined);

		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusChanged',
		), false);
		const activity = fixture.supervisor.activity(session.sessionId);
		fixture.host.handleMcpRuntimeEvent(activity);
		fixture.host.handleMcpRuntimeEvent(activity);

		assert.deepStrictEqual(fixture.messages.filter(
			(message) => message.type === 'mcp.statusChanged',
		), [{
			type: 'mcp.statusChanged',
			tabId: 'tab-status-connected',
			sessionId: session.sessionId,
			status: 'connected',
		}]);
	});

	test('version 호환성을 확인하지 못하면 adapter 없이 bare Codex를 한 번만 실행한다', async () => {
		const fixture = createFixture({ configStyle: null });

		await beginCodex(fixture.host, 'tab-version-fail-open');

		assert.strictEqual(fixture.supervisor.prepareCalls.length, 0);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(fixture.adapter.spawnCalls[0].args, []);
		assert.strictEqual(Object.keys(fixture.adapter.spawnCalls[0].env).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), false);
	});

	test('구버전 style은 legacy exclude config로 authenticated Codex를 실행한다', async () => {
		const fixture = createFixture({ configStyle: 'legacy-exclude' });

		await beginCodex(fixture.host, 'tab-legacy-config');

		assert.strictEqual(fixture.supervisor.prepareCalls.length, 1);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		const args = fixture.adapter.spawnCalls[0].args;
		assert.strictEqual(Array.isArray(args), true);
		if (!Array.isArray(args)) {
			return;
		}
		assert.strictEqual(args.includes(
			'shell_environment_policy.exclude=["CRISPY_MCP_TOKEN"]',
		), true);
		assert.strictEqual(args.some(
			(argument) => argument.includes('shell_environment_policy.filters'),
		), false);
	});

	test('registered 결과 전에는 spawn하지 않고 Codex를 PTY root로 정확히 한 번 시작한다', async () => {
		const supervisor = new FakeCodexSupervisor();
		supervisor.deferPrepare = true;
		const fixture = createFixture({ supervisor });
		const switching = beginCodex(fixture.host, 'tab-ordered');
		await waitUntil(() => supervisor.prepareCalls.length === 1);

		assert.strictEqual(fixture.adapter.spawnCalls.length, 0);
		const sessionId = supervisor.prepareCalls[0];
		supervisor.completePrepare(sessionId);
		await switching;

		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		const spawn = fixture.adapter.spawnCalls[0];
		assert.strictEqual(spawn.executable, '/resolved/codex');
		assert.strictEqual(spawn.cwd, '/trusted/workspace');
		assert.strictEqual(spawn.args.includes('--config'), true);
		assert.strictEqual(spawn.args.includes(
			'features.shell_snapshot=false',
		), true);
		assert.strictEqual(spawn.env.ELECTRON_RUN_AS_NODE, undefined);
		assert.strictEqual(spawn.env.crispy_mcp_token, undefined);
		assert.strictEqual(typeof spawn.env.CRISPY_MCP_TOKEN, 'string');
		assert.deepStrictEqual(fixture.adapter.handles[0].writes, []);
		assert.strictEqual(
			supervisor.getSessionRuntime(sessionId)?.markProviderStartedCount,
			1,
		);
	});

	test('structured Codex는 preparation cwd 대신 final preflight의 latest cwd를 사용한다', async () => {
		let workspaceCalls = 0;
		const fixture = createFixture({
			workspaceResolver: () => {
				workspaceCalls += 1;
				return {
					ok: true,
					root: {
						...workspaceRoot,
						fsPath: (workspaceCalls === 1
							? '/switch/preflight'
							: '/structured/final') as ValidatedWorkspaceFsPath,
					},
				};
			},
		});

		await beginCodex(fixture.host, 'tab-structured-final-cwd');

		assert.strictEqual(workspaceCalls, 2);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.spawnCalls[0].cwd, '/structured/final');
		assert.strictEqual(fixture.adapter.spawnCalls[0].args.includes('--config'), true);
	});

	test('MCP prepare 실패는 정리 후 credential 없는 bare Codex를 한 번 시작한다', async () => {
		const supervisor = new FakeCodexSupervisor();
		supervisor.prepareFailure = {
			ok: false,
			failure: { reason: 'adapter_ready_timeout', retryable: true },
			providerAction: 'continue_without_mcp',
		};
		const fixture = createFixture({ supervisor });
		await beginCodex(fixture.host, 'tab-fail-open');

		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		const spawn = fixture.adapter.spawnCalls[0];
		assert.strictEqual(spawn.executable, '/resolved/codex');
		assert.deepStrictEqual(spawn.args, []);
		assert.strictEqual(Object.keys(spawn.env).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), false);
		assert.strictEqual(Object.keys(spawn.env).some(
			(name) => name.toUpperCase() === 'ELECTRON_RUN_AS_NODE',
		), false);
		assert.strictEqual(supervisor.stopCalls.length >= 1, true);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusChanged'
				&& message.status === 'failed'
				&& message.reason === 'adapter_ready_timeout'
				&& message.retryable,
		), true);
	});

	test('authenticated PTY spawn 실패는 credential 폐기 후 bare Codex를 최대 한 번 재시도한다', async () => {
		const fixture = createFixture();
		fixture.adapter.spawnFailuresRemaining = 1;

		await beginCodex(fixture.host, 'tab-authenticated-spawn-fallback');

		const sessionId = fixture.supervisor.prepareCalls[0];
		assert.strictEqual(fixture.adapter.spawnCalls.length, 2);
		assert.strictEqual(fixture.adapter.spawnCalls[0].args.includes('--config'), true);
		assert.strictEqual(
			typeof fixture.adapter.spawnCalls[0].env.CRISPY_MCP_TOKEN,
			'string',
		);
		assert.deepStrictEqual(fixture.adapter.spawnCalls[1].args, []);
		assert.strictEqual(Object.keys(fixture.adapter.spawnCalls[1].env).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), false);
		assert.strictEqual(fixture.adapter.handles.length, 1);
		assert.strictEqual(fixture.supervisor.stopCalls.includes(sessionId), true);
		assert.strictEqual(fixture.supervisor.getSessionRuntime(sessionId), undefined);
		assert.strictEqual(fixture.messages.filter(
			(message) => message.type === 'terminal.started',
		).length, 1);
	});

	test('authenticated spawn fallback은 bare spawn 직전 fresh Workspace cwd를 다시 적용한다', async () => {
		let workspaceCalls = 0;
		const fixture = createFixture({
			workspaceResolver: () => {
				workspaceCalls += 1;
				return {
					ok: true,
					root: {
						...workspaceRoot,
						fsPath: (workspaceCalls === 3
							? '/bare/fresh-final'
							: `/workspace/preflight-${workspaceCalls}`) as ValidatedWorkspaceFsPath,
					},
				};
			},
		});
		fixture.adapter.spawnFailuresRemaining = 1;

		await beginCodex(fixture.host, 'tab-bare-final-cwd');

		assert.strictEqual(workspaceCalls, 3);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 2);
		assert.strictEqual(fixture.adapter.spawnCalls[0].cwd, '/workspace/preflight-2');
		assert.strictEqual(fixture.adapter.spawnCalls[1].cwd, '/bare/fresh-final');
		assert.deepStrictEqual(fixture.adapter.spawnCalls[1].args, []);
	});

	test('authenticated spawn 뒤 Workspace 실패는 bare fallback spawn으로 진입하지 않는다', async () => {
		let workspaceCalls = 0;
		const fixture = createFixture({
			workspaceResolver: () => {
				workspaceCalls += 1;
				return workspaceCalls < 3
					? { ok: true, root: workspaceRoot }
					: { ok: false, code: 'workspace_untrusted' };
			},
		});
		fixture.adapter.spawnFailuresRemaining = 1;

		await beginCodex(fixture.host, 'tab-workspace-blocks-bare-fallback');

		const session = fixture.host.getActiveSession(
			'tab-workspace-blocks-bare-fallback',
		);
		assert.ok(session !== undefined);
		assert.strictEqual(workspaceCalls, 3);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_untrusted',
		});
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'terminal.error',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'workspace_untrusted',
			message: '작업공간을 신뢰한 후 다시 시도하세요.',
			canRestart: true,
		});
	});

	test('authenticated와 bare PTY spawn이 모두 실패해도 세 번째 spawn을 시도하지 않는다', async () => {
		const fixture = createFixture();
		fixture.adapter.spawnFailuresRemaining = 2;

		await beginCodex(fixture.host, 'tab-spawn-fallback-bounded');

		assert.strictEqual(fixture.adapter.spawnCalls.length, 2);
		assert.strictEqual(fixture.adapter.handles.length, 0);
		assert.strictEqual(fixture.supervisor.stopCalls.length >= 1, true);
		assert.strictEqual(fixture.messages.filter(
			(message) => message.type === 'terminal.error'
				&& message.code === 'start_failed',
		).length, 1);
	});

	test('delayed PID가 running이 된 뒤에만 provider started를 표시한다', async () => {
		const fixture = createFixture({ fakePid: 0 });
		const switching = beginCodex(fixture.host, 'tab-delayed');
		await waitUntil(() => fixture.adapter.spawnCalls.length === 1);
		const sessionId = fixture.supervisor.prepareCalls[0];

		assert.strictEqual(
			fixture.supervisor.getSessionRuntime(sessionId)?.markProviderStartedCount,
			0,
		);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'terminal.started',
		), false);

		fixture.adapter.handles[0].setReadyPid(7202);
		await switching;

		assert.strictEqual(
			fixture.supervisor.getSessionRuntime(sessionId)?.markProviderStartedCount,
			1,
		);
		assert.strictEqual(fixture.messages.filter(
			(message) => message.type === 'terminal.started',
		).length, 1);
	});

	test('PTY 전 plan await 중 adapter crash는 bare 실행으로 한 번만 전환한다', async () => {
		let releasePlan!: () => void;
		const planGate = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		const fixture = createFixture({
			buildPlan: async (options) => {
				await planGate;
				return buildCodexMcpLaunchPlan(options);
			},
		});
		const switching = beginCodex(fixture.host, 'tab-pre-spawn-crash');
		await waitUntil(() => fixture.supervisor.prepareCalls.length === 1);
		await Promise.resolve();
		const sessionId = fixture.supervisor.prepareCalls[0];
		fixture.host.handleMcpRuntimeEvent(fixture.supervisor.crash(sessionId));
		releasePlan();
		await switching;

		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(fixture.adapter.spawnCalls[0].args, []);
		assert.strictEqual(Object.keys(fixture.adapter.spawnCalls[0].env).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), false);
	});
});

suite('Codex stale attempt and cleanup', () => {
	test('MCP status 경계의 Trust revoke는 Agent와 adapter를 종료하고 retry session을 보존한다', async () => {
		let trusted = true;
		let refreshCalls = 0;
		const controller = new FakeProcessTreeController();
		const fixture = createFixture({
			fakePid: 7311,
			readWorkspaceTrust: () => trusted,
			onWorkspaceTrustRevoked: () => refreshCalls += 1,
			processTreeController: controller,
		});
		await beginCodex(fixture.host, 'tab-mcp-trust-revoke');
		const session = fixture.host.getActiveSession('tab-mcp-trust-revoke');
		const assignment = fixture.host.getTabAssignment('tab-mcp-trust-revoke');
		assert.ok(session !== undefined);
		assert.ok(assignment !== undefined);
		const activity = fixture.supervisor.activity(session.sessionId);

		trusted = false;
		fixture.host.handleMcpRuntimeEvent(activity);
		fixture.host.handleMcpRuntimeEvent(activity);

		assert.strictEqual(fixture.host.getActiveSession(session.tabId), session);
		assert.strictEqual(fixture.host.getTabAssignment(session.tabId), assignment);
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_untrusted',
		});
		assert.strictEqual(refreshCalls, 1);
		assert.strictEqual(
			fixture.supervisor.stopCalls.filter(
				(sessionId) => sessionId === session.sessionId,
			).length,
			1,
		);
		assert.strictEqual(fixture.adapter.handles[0].dataListenerCount, 0);
		assert.strictEqual(fixture.adapter.handles[0].exitListenerCount, 0);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusChanged',
		), false);
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'terminal.error',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'workspace_untrusted',
			message: '작업공간을 신뢰한 후 다시 시도하세요.',
			canRestart: true,
		});
		await waitUntil(() => controller.calls.includes('terminate:7311'));
	});

	test('두 Codex 탭의 session, token, config와 cleanup을 end-to-end 격리한다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-isolated-a');
		await beginCodex(fixture.host, 'tab-isolated-b');
		const sessionA = fixture.host.getActiveSession('tab-isolated-a');
		const sessionB = fixture.host.getActiveSession('tab-isolated-b');
		assert.ok(sessionA !== undefined);
		assert.ok(sessionB !== undefined);
		const spawnA = fixture.adapter.spawnCalls[0];
		const spawnB = fixture.adapter.spawnCalls[1];

		assert.notStrictEqual(sessionA.sessionId, sessionB.sessionId);
		assert.notStrictEqual(
			fixture.supervisor.getSessionRuntime(sessionA.sessionId)?.generation,
			fixture.supervisor.getSessionRuntime(sessionB.sessionId)?.generation,
		);
		assert.notStrictEqual(
			spawnA.env.CRISPY_MCP_TOKEN,
			spawnB.env.CRISPY_MCP_TOKEN,
		);
		assert.notDeepStrictEqual(spawnA.args, spawnB.args);

		fixture.host.closeTab('tab-isolated-a');
		await Promise.resolve();
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 1);
		assert.strictEqual(fixture.adapter.handles[1].killCallCount, 0);
		assert.strictEqual(
			fixture.supervisor.stopCalls.includes(sessionA.sessionId),
			true,
		);
		assert.strictEqual(
			fixture.supervisor.stopCalls.includes(sessionB.sessionId),
			false,
		);
		assert.ok(fixture.supervisor.getSessionRuntime(sessionB.sessionId) !== undefined);

		fixture.host.routeInput({
			type: 'terminal.input',
			tabId: sessionB.tabId,
			sessionId: sessionB.sessionId,
			data: 'tab-b-input',
		});
		fixture.adapter.handles[1].emitData('tab-b-output');
		await Promise.resolve();
		assert.deepStrictEqual(fixture.adapter.handles[1].writes, ['tab-b-input']);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'terminal.output'
				&& message.tabId === sessionB.tabId
				&& message.sessionId === sessionB.sessionId
				&& message.data === 'tab-b-output',
		), true);
	});

	test('adapter wait 중 provider 변경은 old Codex spawn과 message를 만들지 않는다', async () => {
		const supervisor = new FakeCodexSupervisor();
		supervisor.deferPrepare = true;
		const fixture = createFixture({ supervisor });
		const codexSwitch = beginCodex(fixture.host, 'tab-reselect');
		await waitUntil(() => supervisor.prepareCalls.length === 1);
		const oldSessionId = supervisor.prepareCalls[0];

		await fixture.host.switchAgent(
			'tab-reselect',
			'claude',
			WORKSPACE_ROOT_ID,
			2,
		);
		supervisor.completePrepare(oldSessionId);
		await codexSwitch;

		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.spawnCalls[0].executable, '/resolved/claude');
		assert.deepStrictEqual(fixture.adapter.handles[0].writes, []);
		assert.strictEqual(fixture.messages.filter(
			(message) => message.type === 'terminal.started',
		).length, 1);
	});

	test('PTY 시작 후 adapter crash에도 Codex 입출력과 resize를 유지하고 재실행하지 않는다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-keep-running');
		const session = fixture.host.getActiveSession('tab-keep-running');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);

		fixture.host.routeInput({
			type: 'terminal.input',
			tabId: session.tabId,
			sessionId: session.sessionId,
			data: 'input-after-crash',
		});
		fixture.host.routeResize({
			type: 'terminal.resize',
			tabId: session.tabId,
			sessionId: session.sessionId,
			cols: 120,
			rows: 40,
		});
		fixture.adapter.handles[0].emitData('output-after-crash');
		await Promise.resolve();

		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 0);
		assert.deepStrictEqual(fixture.adapter.handles[0].writes, ['input-after-crash']);
		assert.deepStrictEqual(fixture.adapter.handles[0].resizes, [
			{ cols: 120, rows: 40 },
		]);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'terminal.output'
				&& message.data === 'output-after-crash',
		), true);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusChanged'
				&& message.sessionId === session.sessionId
				&& message.status === 'failed'
				&& message.reason === 'adapter_exited'
				&& message.retryable,
		), true);
	});

	test('retryable failure의 명시적 restart는 old tree 정리 후 fresh 전체 session을 만든다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-mcp-restart');
		const first = fixture.host.getActiveSession('tab-mcp-restart');
		assert.ok(first !== undefined);
		const firstRuntime = fixture.supervisor.getSessionRuntime(first.sessionId);
		assert.ok(firstRuntime !== undefined);
		const firstGeneration = firstRuntime.generation;
		const firstArgs = fixture.adapter.spawnCalls[0].args;
		const firstToken = fixture.adapter.spawnCalls[0].env.CRISPY_MCP_TOKEN;
		const oldActivity = fixture.supervisor.activity(first.sessionId);
		const oldFailure = fixture.supervisor.crash(first.sessionId);
		fixture.host.handleMcpRuntimeEvent(oldFailure);

		const restart = fixture.host.restartMcpSession(first.tabId, first.sessionId);
		const mismatched = fixture.host.restartMcpSession(
			first.tabId,
			'session-stale-restart',
		);
		const duplicate = fixture.host.restartMcpSession(first.tabId, first.sessionId);
		assert.strictEqual(duplicate, restart);
		await Promise.all([restart, mismatched]);

		const second = fixture.host.getActiveSession('tab-mcp-restart');
		assert.ok(second !== undefined);
		assert.notStrictEqual(second.sessionId, first.sessionId);
		assert.notStrictEqual(
			fixture.supervisor.getSessionRuntime(second.sessionId)?.generation,
			firstGeneration,
		);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 2);
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 1);
		assert.notDeepStrictEqual(fixture.adapter.spawnCalls[1].args, firstArgs);
		assert.notStrictEqual(
			fixture.adapter.spawnCalls[1].env.CRISPY_MCP_TOKEN,
			firstToken,
		);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusCleared'
				&& message.sessionId === first.sessionId,
		), true);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusChanged'
				&& message.sessionId === second.sessionId,
		), false);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.restartRejected'
				&& message.tabId === first.tabId
				&& message.sessionId === 'session-stale-restart'
				&& message.code === 'invalid_session_state',
		), true);
		fixture.host.handleMcpRuntimeEvent(oldActivity);
		fixture.host.handleMcpRuntimeEvent(oldFailure);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusChanged'
				&& message.sessionId === second.sessionId,
		), false);

		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.activity(second.sessionId),
		);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusChanged'
				&& message.sessionId === second.sessionId
				&& message.status === 'connected',
		), true);
	});

	test('MCP restart 최초 Workspace preflight 실패는 CLI/MCP/status를 그대로 보존한다', async () => {
		let workspaceAvailable = true;
		const fixture = createFixture({
			workspaceResolver: () => workspaceAvailable
				? { ok: true, root: workspaceRoot }
				: { ok: false, code: 'workspace_root_unavailable' },
		});
		await beginCodex(fixture.host, 'tab-mcp-preflight-rejected');
		const session = fixture.host.getActiveSession('tab-mcp-preflight-rejected');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);
		const stopCount = fixture.supervisor.stopCalls.length;
		workspaceAvailable = false;

		await fixture.host.restartMcpSession(session.tabId, session.sessionId);

		assert.strictEqual(
			fixture.host.getActiveSession('tab-mcp-preflight-rejected'),
			session,
		);
		assert.strictEqual(session.state.kind, 'running');
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 0);
		assert.strictEqual(fixture.supervisor.stopCalls.length, stopCount);
		assert.strictEqual(fixture.host.getMcpStatus(session.sessionId)?.status, 'failed');
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'workspace_root_unavailable',
			message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
		});
	});

	test('MCP restart 두 번째 Workspace preflight 실패도 CLI와 failed status를 유지하고 거부한다', async () => {
		let workspaceCalls = 0;
		const fixture = createFixture({
			workspaceResolver: () => {
				workspaceCalls += 1;
				return workspaceCalls === 4
					? { ok: false, code: 'workspace_path_invalid' }
					: { ok: true, root: workspaceRoot };
			},
		});
		await beginCodex(fixture.host, 'tab-mcp-post-cleanup-rejected');
		const session = fixture.host.getActiveSession('tab-mcp-post-cleanup-rejected');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);

		await fixture.host.restartMcpSession(
			session.tabId,
			session.sessionId,
		);

		assert.strictEqual(workspaceCalls, 4);
		assert.strictEqual(
			fixture.host.getActiveSession('tab-mcp-post-cleanup-rejected'),
			session,
		);
		assert.strictEqual(session.state.kind, 'running');
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 0);
		assert.strictEqual(fixture.host.getMcpStatus(session.sessionId)?.status, 'failed');
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'workspace_path_invalid',
			message: '유효한 로컬 작업공간 폴더를 연 후 다시 시도하세요.',
		});
	});

	test('MCP restart 최초 Workspace 조회 예외는 workspace rejection으로 live CLI를 보존한다', async () => {
		let throwWorkspaceError = false;
		const fixture = createFixture({
			workspaceResolver: () => {
				if (throwWorkspaceError) {
					throw new Error('workspace read failed');
				}
				return { ok: true, root: workspaceRoot };
			},
		});
		await beginCodex(fixture.host, 'tab-mcp-preflight-exception');
		const session = fixture.host.getActiveSession('tab-mcp-preflight-exception');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);
		const stopCount = fixture.supervisor.stopCalls.length;
		throwWorkspaceError = true;

		await fixture.host.restartMcpSession(session.tabId, session.sessionId);

		assert.strictEqual(session.state.kind, 'running');
		assert.strictEqual(fixture.host.getActiveSession(session.tabId), session);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 0);
		assert.strictEqual(fixture.supervisor.stopCalls.length, stopCount);
		assert.strictEqual(fixture.host.getMcpStatus(session.sessionId)?.status, 'failed');
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'workspace_root_unavailable',
			message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
		});
	});

	test('MCP restart 두 번째 Workspace 조회 예외도 workspace rejection으로 live CLI를 보존한다', async () => {
		let workspaceCalls = 0;
		const fixture = createFixture({
			workspaceResolver: () => {
				workspaceCalls += 1;
				if (workspaceCalls === 4) {
					throw new Error('workspace read failed');
				}
				return { ok: true, root: workspaceRoot };
			},
		});
		await beginCodex(fixture.host, 'tab-mcp-post-cleanup-exception');
		const session = fixture.host.getActiveSession('tab-mcp-post-cleanup-exception');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);
		const stopCount = fixture.supervisor.stopCalls.length;

		await fixture.host.restartMcpSession(session.tabId, session.sessionId);

		assert.strictEqual(workspaceCalls, 4);
		assert.strictEqual(session.state.kind, 'running');
		assert.strictEqual(fixture.host.getActiveSession(session.tabId), session);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 0);
		assert.strictEqual(fixture.supervisor.stopCalls.length, stopCount);
		assert.strictEqual(fixture.host.getMcpStatus(session.sessionId)?.status, 'failed');
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'workspace_root_unavailable',
			message: '선택한 작업공간 폴더를 다시 연 후 시도하세요.',
		});
	});

	test('MCP restart rejection은 teardown하지 않고 이후 Host terminate가 detached CLI tree 종료를 기다린다', async () => {
		let releaseTermination!: () => void;
		const terminationGate = new Promise<void>((resolve) => {
			releaseTermination = resolve;
		});
		const controller = new FakeProcessTreeController({
			beforeTerminate: () => terminationGate,
		});
		let throwWorkspaceError = false;
		const fixture = createFixture({
			processTreeController: controller,
			workspaceResolver: () => {
				if (throwWorkspaceError) {
					throw new Error('workspace read failed');
				}
				return { ok: true, root: workspaceRoot };
			},
		});
		await beginCodex(fixture.host, 'tab-mcp-exception-terminate');
		const session = fixture.host.getActiveSession('tab-mcp-exception-terminate');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);
		throwWorkspaceError = true;

		await fixture.host.restartMcpSession(
			session.tabId,
			session.sessionId,
		);
		assert.deepStrictEqual(controller.calls, []);
		assert.strictEqual(session.state.kind, 'running');
		fixture.host.detach();
		let terminationSettled = false;
		const terminating = fixture.host.terminate().then(() => {
			terminationSettled = true;
		});
		await waitUntil(() => controller.calls.includes('terminate:7201'));
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.strictEqual(terminationSettled, false);
		releaseTermination();
		await terminating;
		assert.strictEqual(terminationSettled, true);
	});

	test('restart cleanup 중 tab close는 fresh child와 PTY spawn을 취소한다', async () => {
		let releaseCleanup!: () => void;
		const cleanupGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		const controller = new FakeProcessTreeController({
			beforeTerminate: () => cleanupGate,
		});
		const fixture = createFixture({ processTreeController: controller });
		await beginCodex(fixture.host, 'tab-close-during-restart');
		const session = fixture.host.getActiveSession('tab-close-during-restart');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(fixture.supervisor.crash(session.sessionId));

		const restart = fixture.host.restartMcpSession(session.tabId, session.sessionId);
		await waitUntil(() => controller.calls.includes('terminate:7201'));
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		fixture.host.closeTab(session.tabId);
		releaseCleanup();
		await restart;

		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.host.getActiveSession(session.tabId), undefined);
		assert.strictEqual(fixture.host.hasTab(session.tabId), false);
	});

	test('두 탭의 MCP restart transaction은 서로 다른 fresh session으로 독립 실행된다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-concurrent-a');
		await beginCodex(fixture.host, 'tab-concurrent-b');
		const firstA = fixture.host.getActiveSession('tab-concurrent-a');
		const firstB = fixture.host.getActiveSession('tab-concurrent-b');
		assert.ok(firstA !== undefined);
		assert.ok(firstB !== undefined);
		fixture.host.handleMcpRuntimeEvent(fixture.supervisor.crash(firstA.sessionId));
		fixture.host.handleMcpRuntimeEvent(fixture.supervisor.crash(firstB.sessionId));

		await Promise.all([
			fixture.host.restartMcpSession(firstA.tabId, firstA.sessionId),
			fixture.host.restartMcpSession(firstB.tabId, firstB.sessionId),
		]);
		const secondA = fixture.host.getActiveSession('tab-concurrent-a');
		const secondB = fixture.host.getActiveSession('tab-concurrent-b');
		assert.ok(secondA !== undefined);
		assert.ok(secondB !== undefined);
		assert.notStrictEqual(secondA.sessionId, firstA.sessionId);
		assert.notStrictEqual(secondB.sessionId, firstB.sessionId);
		assert.notStrictEqual(secondA.sessionId, secondB.sessionId);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 4);
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 1);
		assert.strictEqual(fixture.adapter.handles[1].killCallCount, 1);
		assert.strictEqual(fixture.adapter.handles[2].killCallCount, 0);
		assert.strictEqual(fixture.adapter.handles[3].killCallCount, 0);
	});

	test('non-retryable session의 mcp.restart는 CLI를 보존하고 거부한다', async () => {
		const supervisor = new FakeCodexSupervisor();
		supervisor.prepareFailure = {
			ok: false,
			failure: { reason: 'unsupported_runtime', retryable: false },
			providerAction: 'continue_without_mcp',
		};
		const fixture = createFixture({ supervisor });
		await beginCodex(fixture.host, 'tab-no-mcp-restart');
		const session = fixture.host.getActiveSession('tab-no-mcp-restart');
		assert.ok(session !== undefined);

		await fixture.host.restartMcpSession(session.tabId, session.sessionId);
		assert.strictEqual(fixture.host.getActiveSession(session.tabId), session);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 0);
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'invalid_session_state',
			message: 'MCP restart is no longer valid for the current session.',
		});
	});

	test('connected session의 mcp.restart도 CLI와 status를 보존하고 거부한다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-connected-mcp-restart');
		const session = fixture.host.getActiveSession('tab-connected-mcp-restart');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.activity(session.sessionId),
		);

		await fixture.host.restartMcpSession(session.tabId, session.sessionId);

		assert.strictEqual(fixture.host.getActiveSession(session.tabId), session);
		assert.strictEqual(fixture.host.getMcpStatus(session.sessionId)?.status, 'connected');
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 0);
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'invalid_session_state',
			message: 'MCP restart is no longer valid for the current session.',
		});
	});

	test('session exit 직후 도착한 stale mcp.restart도 명시적으로 거부한다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-stale-mcp-exit');
		const session = fixture.host.getActiveSession('tab-stale-mcp-exit');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);
		fixture.adapter.handles[0].emitExit({ exitCode: 0 });

		await fixture.host.restartMcpSession(session.tabId, session.sessionId);

		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'invalid_session_state',
			message: 'MCP restart is no longer valid for the current session.',
		});
	});

	test('Reset 직후 도착한 stale mcp.restart도 명시적으로 거부한다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-stale-mcp-reset');
		const session = fixture.host.getActiveSession('tab-stale-mcp-reset');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);
		fixture.host.resetAgent(session.tabId);

		await fixture.host.restartMcpSession(session.tabId, session.sessionId);

		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'invalid_session_state',
			message: 'MCP restart is no longer valid for the current session.',
		});
	});

	test('mcp.restart queue 뒤 Reset되면 perform 진입 gate가 요청을 거부한다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-queued-mcp-reset');
		const session = fixture.host.getActiveSession('tab-queued-mcp-reset');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);

		const restarting = fixture.host.restartMcpSession(
			session.tabId,
			session.sessionId,
		);
		fixture.host.resetAgent(session.tabId);
		await restarting;

		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'invalid_session_state',
			message: 'MCP restart is no longer valid for the current session.',
		});
	});

	test('Trust revoke 직후 도착한 stale mcp.restart도 명시적으로 거부한다', async () => {
		let trusted = true;
		const fixture = createFixture({ readWorkspaceTrust: () => trusted });
		await beginCodex(fixture.host, 'tab-stale-mcp-trust');
		const session = fixture.host.getActiveSession('tab-stale-mcp-trust');
		assert.ok(session !== undefined);
		const staleActivity = fixture.supervisor.activity(session.sessionId);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);
		trusted = false;
		fixture.host.handleMcpRuntimeEvent(staleActivity);
		assert.strictEqual(session.state.kind, 'running');
		fixture.host.routeInput({
			type: 'terminal.input',
			tabId: session.tabId,
			sessionId: session.sessionId,
			data: 'trigger-trust-revoke',
		});
		await Promise.resolve();
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_untrusted',
		});

		await fixture.host.restartMcpSession(session.tabId, session.sessionId);

		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'invalid_session_state',
			message: 'MCP restart is no longer valid for the current session.',
		});
	});

	test('MCP preflight의 reentrant Reset도 identity gate가 stale 요청을 거부한다', async () => {
		let resetDuringRestartPreflight = false;
		let fixture!: ReturnType<typeof createFixture>;
		fixture = createFixture({
			workspaceResolver: () => {
				if (resetDuringRestartPreflight) {
					resetDuringRestartPreflight = false;
					fixture.host.resetAgent('tab-mcp-preflight-reset');
				}
				return { ok: true, root: workspaceRoot };
			},
		});
		await beginCodex(fixture.host, 'tab-mcp-preflight-reset');
		const session = fixture.host.getActiveSession('tab-mcp-preflight-reset');
		assert.ok(session !== undefined);
		fixture.host.handleMcpRuntimeEvent(
			fixture.supervisor.crash(session.sessionId),
		);
		resetDuringRestartPreflight = true;

		await fixture.host.restartMcpSession(session.tabId, session.sessionId);

		assert.strictEqual(fixture.host.getActiveSession(session.tabId), undefined);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(fixture.messages.at(-1), {
			type: 'mcp.restartRejected',
			tabId: session.tabId,
			sessionId: session.sessionId,
			code: 'invalid_session_state',
			message: 'MCP restart is no longer valid for the current session.',
		});
	});

	test('normal exit, tab close와 Panel dispose가 해당 MCP와 PTY를 멱등 정리한다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-exit');
		const exited = fixture.host.getActiveSession('tab-exit');
		assert.ok(exited !== undefined);
		fixture.adapter.handles[0].emitExit({ exitCode: 0 });
		await Promise.resolve();
		assert.strictEqual(fixture.supervisor.stopCalls.includes(exited.sessionId), true);

		await beginCodex(fixture.host, 'tab-survivor');
		const survivor = fixture.host.getActiveSession('tab-survivor');
		assert.ok(survivor !== undefined);
		fixture.host.closeTab('tab-exit');
		assert.strictEqual(fixture.adapter.handles[1].killCallCount, 0);

		fixture.host.dispose();
		fixture.host.dispose();
		await Promise.resolve();
		assert.strictEqual(fixture.adapter.handles[1].killCallCount, 1);
		assert.strictEqual(fixture.supervisor.disposeCallCount, 1);
		assert.strictEqual(fixture.host.getActiveSession('tab-survivor'), undefined);
	});

	test('normal exit 뒤 restart는 fresh session, generation, config와 PTY를 만든다', async () => {
		const fixture = createFixture();
		await beginCodex(fixture.host, 'tab-restart');
		const first = fixture.host.getActiveSession('tab-restart');
		assert.ok(first !== undefined);
		const firstGeneration = fixture.supervisor.getSessionRuntime(
			first.sessionId,
		)?.generation;
		const firstArgs = fixture.adapter.spawnCalls[0].args;

		fixture.adapter.handles[0].emitExit({ exitCode: 0 });
		await fixture.host.restartSession('tab-restart', first.sessionId);
		const second = fixture.host.getActiveSession('tab-restart');
		assert.ok(second !== undefined);

		assert.notStrictEqual(second.sessionId, first.sessionId);
		assert.notStrictEqual(
			fixture.supervisor.getSessionRuntime(second.sessionId)?.generation,
			firstGeneration,
		);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 2);
		assert.notDeepStrictEqual(fixture.adapter.spawnCalls[1].args, firstArgs);
		assert.strictEqual(fixture.adapter.handles[0].killCallCount, 1);
		assert.strictEqual(fixture.adapter.handles[1].killCallCount, 0);
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
