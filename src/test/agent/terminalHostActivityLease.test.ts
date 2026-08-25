import * as assert from 'node:assert/strict';
import type { AgentActivityRequested } from '../../mcp/agentActivityProtocol';
import type { SupervisorRuntimeEvent } from '../../mcp/adapterSupervisor';
import { spawnAgentPty } from '../../mcp/agentPtyLaunch';
import { buildCodexMcpLaunchPlan } from '../../mcp/codexLaunchPlan';
import { CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION } from '../../mcp/claudeDiagnostic';
import {
	McpConnectionDescriptor,
	type McpPrepareResult,
	type McpRuntimeLifecycle,
	type McpSessionRuntime,
} from '../../mcp/sessionRuntime';
import type { HostToWebviewMessage } from '../../agent/protocol/messages';
import type { AgentAssignment } from '../../agent/protocol/messages';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';
import type { PrepareTerminalLaunch } from '../../agent/host/terminal/prepareTerminalLaunch';
import {
	TerminalHost,
	type ActivityLease,
	type AgentPtySpawner,
	type HostAgentActivityRequest,
	type McpSupervisor,
} from '../../agent/host/terminal/terminalHost';
import type { TerminalSession } from '../../agent/host/terminal/terminalSession';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
} from '../../agent/host/workspace/types';
import { FakePtyAdapter } from './support/fakePtyAdapter';
import { createCaptureFailureProcessTreeController } from './support/fakeProcessTreeController';

const WORKSPACE_ROOT_URI = 'file:///trusted/activity-workspace';
const WORKSPACE_ROOT_ID = `workspace-root:${WORKSPACE_ROOT_URI}` as const;
const WORKSPACE_ROOT_FS_PATH = '/trusted/activity-workspace';
const workspaceRoot = {
	id: WORKSPACE_ROOT_ID,
	scheme: 'file',
	fsPath: WORKSPACE_ROOT_FS_PATH as ValidatedWorkspaceFsPath,
	workspaceFolder: {
		name: 'activity-workspace',
		index: 0,
		uri: { toString: () => WORKSPACE_ROOT_URI },
	},
} as unknown as ValidatedWorkspaceRoot;

const shellPolicy: ShellLaunchPolicy = {
	executable: '/host/shell',
	args: [],
	cwd: WORKSPACE_ROOT_FS_PATH,
	env: { PATH: '/bin' },
};

const prepareShell: PrepareTerminalLaunch = async () => ({
	ok: true,
	policy: shellPolicy,
});

class FakeActivityRuntime {
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

type FakeActivityRuntimeHandle = FakeActivityRuntime & McpSessionRuntime;

class FakeActivitySupervisor implements McpSupervisor {
	readonly retireCalls: McpSessionRuntime[] = [];
	readonly sequence: string[] = [];
	private generationIndex = 0;
	private readonly current = new Map<string, FakeActivityRuntimeHandle>();
	private readonly live = new Set<McpSessionRuntime>();
	private readonly retirementByRuntime = new Map<McpSessionRuntime, Promise<void>>();
	private disposePromise: Promise<void> | undefined;
	beforeRetire: ((runtime: McpSessionRuntime) => void) | undefined;

	prepareSession(sessionId: string): Promise<McpPrepareResult> {
		const runtime = this.createRuntime(sessionId);
		const route = Buffer.alloc(24, this.generationIndex).toString('base64url');
		const token = Buffer.alloc(32, this.generationIndex + 32)
			.toString('base64url');
		return Promise.resolve({
			ok: true,
			connection: new McpConnectionDescriptor(
				runtime.generation,
				sessionId,
				`http://127.0.0.1:43000/mcp/${route}`,
				token,
			),
		});
	}

	getSessionRuntime(sessionId: string): McpSessionRuntime | undefined {
		return this.current.get(sessionId);
	}

	replace(sessionId: string): FakeActivityRuntimeHandle {
		return this.createRuntime(sessionId);
	}

	retireExactRuntime(runtime: McpSessionRuntime): Promise<void> {
		const existing = this.retirementByRuntime.get(runtime);
		if (existing !== undefined) {
			return existing;
		}
		if (!this.live.has(runtime)) {
			return Promise.resolve();
		}

		this.sequence.push('retire');
		this.retireCalls.push(runtime);
		this.beforeRetire?.(runtime);
		this.live.delete(runtime);
		if (this.current.get(runtime.sessionId) === runtime) {
			this.current.delete(runtime.sessionId);
		}
		(runtime as FakeActivityRuntimeHandle).lifecycle = 'stopped';
		const retirement = Promise.resolve();
		this.retirementByRuntime.set(runtime, retirement);
		void retirement.then(() => {
			this.retirementByRuntime.delete(runtime);
		});
		return retirement;
	}

	dispose(): Promise<void> {
		this.disposePromise ??= Promise.all(
			[...this.live].map((runtime) => this.retireExactRuntime(runtime)),
		).then(() => undefined);
		return this.disposePromise;
	}

	private createRuntime(sessionId: string): FakeActivityRuntimeHandle {
		this.generationIndex += 1;
		const runtime = new FakeActivityRuntime(
			sessionId,
			`activity-generation-${this.generationIndex}`,
		) as unknown as FakeActivityRuntimeHandle;
		this.current.set(sessionId, runtime);
		this.live.add(runtime);
		return runtime;
	}
}

interface ActivityFixtureOptions {
	readonly compatible?: boolean;
	readonly readWorkspaceTrust?: () => boolean;
	readonly workspaceResolver?: () =>
		| { readonly ok: true; readonly root: ValidatedWorkspaceRoot }
		| { readonly ok: false; readonly code: 'workspace_root_unavailable' };
	readonly onSpawn?: (
		host: TerminalHost,
		supervisor: FakeActivitySupervisor,
		session: TerminalSession,
	) => void;
	readonly spawnAgentPty?: AgentPtySpawner;
	readonly buildCodexMcpLaunchPlan?: ConstructorParameters<
		typeof TerminalHost
	>[0]['buildCodexMcpLaunchPlan'];
	readonly onLeaseRevoked?: (
		lease: ActivityLease,
		adapter: FakePtyAdapter,
	) => void;
}

function createActivityFixture(options: ActivityFixtureOptions = {}): {
	readonly host: TerminalHost;
	readonly adapter: FakePtyAdapter;
	readonly supervisor: FakeActivitySupervisor;
	readonly messages: HostToWebviewMessage[];
	readonly requests: HostAgentActivityRequest[];
	readonly revoked: ActivityLease[];
} {
	const adapter = new FakePtyAdapter(8811);
	const supervisor = new FakeActivitySupervisor();
	const messages: HostToWebviewMessage[] = [];
	const requests: HostAgentActivityRequest[] = [];
	const revoked: ActivityLease[] = [];
	let host!: TerminalHost;
	const wrappedSpawner: AgentPtySpawner = (session, request, cols, rows) => {
		options.onSpawn?.(host, supervisor, session);
		if (options.spawnAgentPty !== undefined) {
			return options.spawnAgentPty(session, request, cols, rows);
		}
		return spawnAgentPty(session, request, cols, rows);
	};

	host = new TerminalHost({
		ptyAdapter: adapter,
		prepareLaunch: prepareShell,
		prepareCodexLaunch: async () => ({
			ok: true,
			preparation: {
				executable: {
					executable: '/resolved/codex',
					launcherKind: 'direct',
				},
				cwd: WORKSPACE_ROOT_FS_PATH,
				environment: { PATH: '/bin' },
				platform: 'linux',
				shellEnvironmentPolicyStyle: 'keyed-filters',
			},
		}),
		mcpSupervisor: supervisor,
		agentActivityCompatible: options.compatible,
		onAgentActivityRequest: (request) => requests.push(request),
		onActivityLeaseRevoked: (lease) => {
			supervisor.sequence.push('revoke');
			revoked.push(lease);
			options.onLeaseRevoked?.(lease, adapter);
		},
		spawnAgentPty: wrappedSpawner,
		buildCodexMcpLaunchPlan: options.buildCodexMcpLaunchPlan,
		resolveAgentAutoRunInput: async () => undefined,
		workspaceResolver: options.workspaceResolver
			?? (() => ({ ok: true, root: workspaceRoot })),
		readWorkspaceTrust: options.readWorkspaceTrust ?? (() => true),
		processTreeController: createCaptureFailureProcessTreeController(),
		sessionIdNonce: 'activity-panel',
		emitMessage: (message) => messages.push(message),
	});
	return { host, adapter, supervisor, messages, requests, revoked };
}

function activityEnvelope(
	runtime: McpSessionRuntime,
	overrides: Partial<AgentActivityRequested> = {},
): SupervisorRuntimeEvent {
	const event = Object.freeze({
		type: 'session.agentActivityRequested',
		sessionId: runtime.sessionId,
		generation: runtime.generation,
		operation: 'set',
		path: 'src/index.ts',
		targetKind: 'file',
		activity: 'editing',
		...overrides,
	} as AgentActivityRequested);
	return Object.freeze({ sourceRuntime: runtime, event });
}

function failureEnvelope(runtime: McpSessionRuntime): SupervisorRuntimeEvent {
	return Object.freeze({
		sourceRuntime: runtime,
		event: Object.freeze({
			type: 'runtime.failure',
			sessionId: runtime.sessionId,
			generation: runtime.generation,
			failure: Object.freeze({ reason: 'adapter_exited', retryable: true }),
			providerStarted: true,
			providerAction: 'keep_running',
		}),
	});
}

async function beginCodex(
	host: TerminalHost,
	tabId: string,
): Promise<TerminalSession> {
	host.createTab(tabId);
	await host.handleTerminalReady(tabId, 100, 30);
	await host.switchAgent(tabId, 'codex', WORKSPACE_ROOT_ID, 1);
	const session = host.getActiveSession(tabId);
	assert.ok(session !== undefined);
	return session;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('ActivityLease test condition timed out.');
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

suite('TerminalHost ActivityLease ownership', () => {
	test('gate=false는 native spawn 전후 Activity lease와 revoke state를 만들지 않는다', async () => {
		const fixture = createActivityFixture({
			compatible: false,
			onSpawn: (host, supervisor, session) => {
				const runtime = supervisor.getSessionRuntime(session.sessionId);
				assert.ok(runtime !== undefined);
				host.handleMcpRuntimeEvent(activityEnvelope(runtime));
			},
		});
		const session = await beginCodex(fixture.host, 'tab-gate-false');
		const runtime = fixture.supervisor.getSessionRuntime(session.sessionId);
		assert.ok(runtime !== undefined);

		fixture.host.handleMcpRuntimeEvent(activityEnvelope(runtime));
		fixture.host.closeTab(session.tabId);

		const internals = fixture.host as unknown as {
			activityLeaseStateBySession: unknown;
			onAgentActivityRequest: unknown;
			onActivityLeaseRevoked: unknown;
		};
		assert.strictEqual(internals.activityLeaseStateBySession, undefined);
		assert.strictEqual(internals.onAgentActivityRequest, undefined);
		assert.strictEqual(internals.onActivityLeaseRevoked, undefined);
		assert.deepStrictEqual(fixture.requests, []);
		assert.deepStrictEqual(fixture.revoked, []);
	});

	test('final root와 exact ownership lease를 install한 뒤 같은 turn의 starting spawn callback을 허용한다', async () => {
		let stateDuringSpawn: string | undefined;
		const fixture = createActivityFixture({
			compatible: true,
			onSpawn: (host, supervisor, session) => {
				stateDuringSpawn = session.state.kind;
				const runtime = supervisor.getSessionRuntime(session.sessionId);
				assert.ok(runtime !== undefined);
				host.handleMcpRuntimeEvent(activityEnvelope(runtime));
			},
		});
		const session = await beginCodex(fixture.host, 'tab-no-yield');

		assert.strictEqual(stateDuringSpawn, 'starting');
		assert.strictEqual(fixture.requests.length, 1);
		const request = fixture.requests[0];
		const assignment = fixture.host.getTabAssignment(session.tabId);
		assert.ok(assignment !== undefined);
		assert.strictEqual(request.lease.session, session);
		assert.strictEqual(request.lease.assignment, assignment);
		assert.strictEqual(request.lease.runtime, request.sourceRuntime);
		assert.strictEqual(request.lease.providerId, 'codex');
		assert.strictEqual(request.lease.workspaceRootId, WORKSPACE_ROOT_ID);
		assert.strictEqual(request.lease.launchRootUri, WORKSPACE_ROOT_URI);
		assert.strictEqual(
			request.lease.launchRootFsPath,
			WORKSPACE_ROOT_FS_PATH,
		);
		assert.strictEqual(request.lease.epoch, 1);
		assert.strictEqual(request.lease.revoked, false);
		assert.strictEqual(Object.isFrozen(request), true);
		assert.strictEqual(Object.isSealed(request.lease), true);
		assert.strictEqual(Object.isFrozen(request.lease), false);
		assert.strictEqual(
			Object.prototype.hasOwnProperty.call(request.lease, 'assignmentRevision'),
			false,
		);
		assert.deepStrictEqual(Object.keys(request.lease), [
			'session',
			'assignment',
			'providerId',
			'workspaceRootId',
			'runtime',
			'generation',
			'launchRootUri',
			'launchRootFsPath',
			'epoch',
			'revoked',
		]);
		assert.strictEqual(
			Object.getOwnPropertyDescriptor(request.lease, 'runtime')?.writable,
			false,
		);
		assert.strictEqual(
			Object.getOwnPropertyDescriptor(request.lease, 'revoked')?.writable,
			true,
		);
		assert.strictEqual(
			Reflect.set(request.lease, 'providerId', 'claude'),
			false,
		);
		assert.deepStrictEqual(fixture.revoked, []);
	});

	test('assignmentRevision은 무관하지만 same-value 새 assignment object는 old lease를 stale 처리한다', async () => {
		const fixture = createActivityFixture({ compatible: true });
		const session = await beginCodex(fixture.host, 'tab-assignment-identity');
		const runtime = fixture.supervisor.getSessionRuntime(session.sessionId);
		const assignment = fixture.host.getTabAssignment(session.tabId);
		assert.ok(runtime !== undefined);
		assert.ok(assignment !== undefined);
		const internals = fixture.host as unknown as {
			assignmentByTab: Map<string, AgentAssignment>;
			assignmentBySession: Map<string, AgentAssignment>;
			assignmentRevisionByTab: Map<string, number>;
		};

		internals.assignmentRevisionByTab.set(session.tabId, Number.MAX_SAFE_INTEGER);
		fixture.host.handleMcpRuntimeEvent(activityEnvelope(runtime));
		assert.strictEqual(fixture.requests.length, 1);

		const sameValueNewAssignment = Object.freeze({
			providerId: assignment.providerId,
			workspaceRootId: assignment.workspaceRootId,
		}) satisfies AgentAssignment;
		assert.notStrictEqual(sameValueNewAssignment, assignment);
		internals.assignmentByTab.set(session.tabId, sameValueNewAssignment);
		internals.assignmentBySession.set(
			session.sessionId,
			sameValueNewAssignment,
		);
		fixture.host.handleMcpRuntimeEvent(activityEnvelope(runtime));

		assert.strictEqual(fixture.requests.length, 1);
		assert.deepStrictEqual(fixture.revoked, []);
	});

	test('Host lexical revalidation과 exact Supervisor source gate가 stale/noncanonical Activity를 drop한다', async () => {
		const fixture = createActivityFixture({ compatible: true });
		const session = await beginCodex(fixture.host, 'tab-stale-activity');
		const oldRuntime = fixture.supervisor.getSessionRuntime(session.sessionId);
		assert.ok(oldRuntime !== undefined);

		fixture.host.handleMcpRuntimeEvent(activityEnvelope(oldRuntime, {
			path: 'src//index.ts',
		}));
		const replacement = fixture.supervisor.replace(session.sessionId);
		fixture.host.handleMcpRuntimeEvent(activityEnvelope(oldRuntime));
		fixture.host.handleMcpRuntimeEvent(activityEnvelope(replacement));

		assert.deepStrictEqual(fixture.requests, []);
		assert.deepStrictEqual(fixture.revoked, []);
	});

	test('authenticated plan await 중 current runtime replacement는 old attempt만 retire하고 spawn/status를 변경하지 않는다', async () => {
		let markPlanEntered!: () => void;
		const planEntered = new Promise<void>((resolve) => {
			markPlanEntered = resolve;
		});
		let releasePlan!: () => void;
		const planGate = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		const fixture = createActivityFixture({
			compatible: true,
			buildCodexMcpLaunchPlan: async (options) => {
				markPlanEntered();
				await planGate;
				return buildCodexMcpLaunchPlan(options);
			},
		});
		const starting = beginCodex(fixture.host, 'tab-plan-runtime-replacement');
		await planEntered;
		const session = fixture.host.getActiveSession('tab-plan-runtime-replacement');
		assert.ok(session !== undefined);
		const oldRuntime = fixture.supervisor.getSessionRuntime(session.sessionId);
		assert.ok(oldRuntime !== undefined);
		const statusBeforeReplacement = fixture.host.getMcpStatus(session.sessionId);
		const replacement = fixture.supervisor.replace(session.sessionId);

		releasePlan();
		await starting;

		assert.strictEqual(
			fixture.supervisor.getSessionRuntime(session.sessionId),
			replacement,
		);
		assert.deepStrictEqual(fixture.supervisor.retireCalls, [oldRuntime]);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 0);
		assert.strictEqual(session.state.kind, 'starting');
		assert.deepStrictEqual(
			fixture.host.getMcpStatus(session.sessionId),
			statusBeforeReplacement,
		);
		assert.deepStrictEqual(fixture.requests, []);
		assert.deepStrictEqual(fixture.revoked, []);
		assert.ok(!fixture.messages.some((message) =>
			message.type === 'terminal.error'
		));
	});

	test('keep_running runtime failure는 lease를 retire보다 먼저 한 번 revoke하고 CLI를 유지한다', async () => {
		const fixture = createActivityFixture({ compatible: true });
		const session = await beginCodex(fixture.host, 'tab-runtime-failure');
		const runtime = fixture.supervisor.getSessionRuntime(session.sessionId);
		assert.ok(runtime !== undefined);
		fixture.host.handleMcpRuntimeEvent(activityEnvelope(runtime));
		const lease = fixture.requests[0].lease;

		fixture.host.handleMcpRuntimeEvent(failureEnvelope(runtime));
		fixture.host.handleMcpRuntimeEvent(failureEnvelope(runtime));
		await Promise.resolve();

		assert.deepStrictEqual(fixture.supervisor.sequence, ['revoke', 'retire']);
		assert.deepStrictEqual(fixture.revoked, [lease]);
		assert.strictEqual(lease.revoked, true);
		assert.strictEqual(session.state.kind, 'running');
		assert.strictEqual(fixture.host.getActiveSession(session.tabId), session);
		assert.ok(fixture.messages.some((message) =>
			message.type === 'mcp.statusChanged'
			&& message.sessionId === session.sessionId
			&& message.status === 'failed'
		));
	});

	test('PTY exit는 public exit와 exact runtime teardown 전에 lease를 revoke한다', async () => {
		const fixture = createActivityFixture({ compatible: true });
		const session = await beginCodex(fixture.host, 'tab-pty-exit');
		const runtime = fixture.supervisor.getSessionRuntime(session.sessionId);
		assert.ok(runtime !== undefined);
		fixture.host.handleMcpRuntimeEvent(activityEnvelope(runtime));
		const lease = fixture.requests[0].lease;

		fixture.adapter.handles[0].emitExit({ exitCode: 9 });
		await Promise.resolve();

		assert.deepStrictEqual(fixture.supervisor.sequence, ['revoke', 'retire']);
		assert.deepStrictEqual(fixture.revoked, [lease]);
		assert.strictEqual(lease.revoked, true);
		assert.deepStrictEqual(session.state, {
			kind: 'exited',
			exitCode: 9,
			signal: null,
		});
		assert.ok(fixture.messages.some((message) =>
			message.type === 'terminal.exited'
			&& message.sessionId === session.sessionId
		));
	});

	test('Trust revoke는 process ownership teardown 전에 exact lease를 revoke한다', async () => {
		let trusted = true;
		let listenersDuringRevoke: readonly number[] | undefined;
		const fixture = createActivityFixture({
			compatible: true,
			readWorkspaceTrust: () => trusted,
			onLeaseRevoked: (_lease, adapter) => {
				listenersDuringRevoke = [
					adapter.handles[0].dataListenerCount,
					adapter.handles[0].exitListenerCount,
				];
			},
		});
		const session = await beginCodex(fixture.host, 'tab-trust-revoke');
		const runtime = fixture.supervisor.getSessionRuntime(session.sessionId);
		assert.ok(runtime !== undefined);
		fixture.host.handleMcpRuntimeEvent(activityEnvelope(runtime));
		const lease = fixture.requests[0].lease;
		trusted = false;

		fixture.host.routeInput({
			type: 'terminal.input',
			tabId: session.tabId,
			sessionId: session.sessionId,
			data: 'ignored',
		});
		await Promise.resolve();

		assert.deepStrictEqual(fixture.supervisor.sequence, ['revoke', 'retire']);
		assert.deepStrictEqual(fixture.revoked, [lease]);
		assert.strictEqual(lease.revoked, true);
		assert.deepStrictEqual(listenersDuringRevoke, [1, 1]);
		assert.strictEqual(fixture.adapter.handles[0].dataListenerCount, 0);
		assert.strictEqual(fixture.adapter.handles[0].exitListenerCount, 0);
		assert.deepStrictEqual(session.state, {
			kind: 'error',
			code: 'workspace_untrusted',
		});
	});

	test('synchronous authenticated spawn throw는 revoke/retire 뒤 credential-free bare spawn을 한 번만 재시도한다', async () => {
		let spawnCalls = 0;
		const fixture = createActivityFixture({
			compatible: true,
			spawnAgentPty: (session, request, cols, rows) => {
				spawnCalls += 1;
				if (spawnCalls === 1) {
					throw new Error('synchronous fake spawn failure');
				}
				return spawnAgentPty(session, request, cols, rows);
			},
		});

		const session = await beginCodex(fixture.host, 'tab-sync-spawn-throw');

		assert.strictEqual(spawnCalls, 2);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(session.state.kind, 'running');
		assert.deepStrictEqual(fixture.supervisor.sequence, ['revoke', 'retire']);
		assert.strictEqual(fixture.revoked.length, 1);
		assert.strictEqual(fixture.revoked[0].revoked, true);
		assert.ok(!fixture.messages.some((message) =>
			message.type === 'terminal.error'
		));
	});

	test('asynchronous authenticated spawn rejection은 old lease를 먼저 revoke하고 concurrent replacement를 보존한다', async () => {
		let replacement: McpSessionRuntime | undefined;
		const fixture = createActivityFixture({
			compatible: true,
			spawnAgentPty: async () => {
				throw new Error('asynchronous fake spawn rejection');
			},
		});
		fixture.supervisor.beforeRetire = (runtime) => {
			replacement ??= fixture.supervisor.replace(runtime.sessionId);
		};

		const session = await beginCodex(
			fixture.host,
			'tab-spawn-replacement-race',
		);

		assert.ok(replacement !== undefined);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime(session.sessionId),
			replacement,
		);
		assert.deepStrictEqual(fixture.supervisor.sequence, ['revoke', 'retire']);
		assert.strictEqual(fixture.revoked.length, 1);
		assert.strictEqual(fixture.revoked[0].revoked, true);
		assert.strictEqual(fixture.supervisor.retireCalls.length, 1);
		assert.notStrictEqual(fixture.supervisor.retireCalls[0], replacement);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 0);
		assert.ok(!fixture.messages.some((message) =>
			message.type === 'terminal.error'
		));
	});

	test('pending spawn 중 runtime failure로 old ownership이 사라져도 reject 후 bare fallback으로 수렴한다', async () => {
		let markAuthenticatedSpawn!: () => void;
		const authenticatedSpawnEntered = new Promise<void>((resolve) => {
			markAuthenticatedSpawn = resolve;
		});
		let rejectAuthenticatedSpawn!: (error: Error) => void;
		let spawnCalls = 0;
		const fixture = createActivityFixture({
			compatible: true,
			spawnAgentPty: (session, request, cols, rows) => {
				spawnCalls += 1;
				if (spawnCalls === 1) {
					markAuthenticatedSpawn();
					return new Promise<void>((_resolve, reject) => {
						rejectAuthenticatedSpawn = reject;
					});
				}
				return spawnAgentPty(session, request, cols, rows);
			},
		});
		const starting = beginCodex(fixture.host, 'tab-runtime-failure-before-reject');
		await authenticatedSpawnEntered;
		const session = fixture.host.getActiveSession(
			'tab-runtime-failure-before-reject',
		);
		assert.ok(session !== undefined);
		const runtime = fixture.supervisor.getSessionRuntime(session.sessionId);
		assert.ok(runtime !== undefined);
		fixture.host.handleMcpRuntimeEvent(activityEnvelope(runtime));
		const lease = fixture.requests[0].lease;

		fixture.host.handleMcpRuntimeEvent(failureEnvelope(runtime));
		rejectAuthenticatedSpawn(new Error('deferred authenticated rejection'));
		await starting;

		assert.strictEqual(spawnCalls, 2);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(session.state.kind, 'running');
		assert.deepStrictEqual(fixture.revoked, [lease]);
		assert.strictEqual(lease.revoked, true);
		assert.deepStrictEqual(fixture.supervisor.retireCalls, [runtime]);
		assert.ok(!fixture.messages.some((message) =>
			message.type === 'terminal.error'
		));
	});

	test('final resolver의 root ID/URI 불일치는 lease나 native spawn 없이 workspace error로 끝난다', async () => {
		let resolveCalls = 0;
		const inconsistentRoot = {
			...workspaceRoot,
			workspaceFolder: {
				...workspaceRoot.workspaceFolder,
				uri: { toString: () => 'file:///different-root' },
			},
		} as unknown as ValidatedWorkspaceRoot;
		const fixture = createActivityFixture({
			compatible: true,
			workspaceResolver: () => {
				resolveCalls += 1;
				return {
					ok: true,
					root: resolveCalls < 2 ? workspaceRoot : inconsistentRoot,
				};
			},
		});

		const session = await beginCodex(fixture.host, 'tab-root-mismatch');

		assert.strictEqual(session.state.kind, 'error');
		assert.strictEqual(fixture.adapter.spawnCalls.length, 0);
		assert.deepStrictEqual(fixture.requests, []);
		assert.deepStrictEqual(fixture.revoked, []);
		assert.ok(fixture.messages.some((message) =>
			message.type === 'terminal.error'
			&& message.sessionId === session.sessionId
			&& message.code === 'workspace_root_unavailable'
		));
	});

	test('final workspace failure의 exact retirement 중 생긴 replacement는 session/process/public state를 변경하지 않는다', async () => {
		let resolveCalls = 0;
		let replacement: McpSessionRuntime | undefined;
		const fixture = createActivityFixture({
			compatible: true,
			workspaceResolver: () => {
				resolveCalls += 1;
				return resolveCalls < 2
					? { ok: true, root: workspaceRoot }
					: { ok: false, code: 'workspace_root_unavailable' };
			},
		});
		fixture.supervisor.beforeRetire = (runtime) => {
			replacement ??= fixture.supervisor.replace(runtime.sessionId);
		};

		const session = await beginCodex(
			fixture.host,
			'tab-workspace-retire-replacement',
		);

		assert.ok(replacement !== undefined);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime(session.sessionId),
			replacement,
		);
		assert.strictEqual(session.state.kind, 'starting');
		assert.strictEqual(fixture.host.getActiveSession(session.tabId), session);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 0);
		assert.deepStrictEqual(fixture.requests, []);
		assert.deepStrictEqual(fixture.revoked, []);
		assert.ok(!fixture.messages.some((message) =>
			message.type === 'terminal.error'
		));
	});

	test('regular, MCP restart, terminal restart와 reset/switch가 panel allocator counter 하나를 공유한다', async () => {
		const fixture = createActivityFixture();

		fixture.host.createTab('tab-regular-allocation');
		await fixture.host.startSession('tab-regular-allocation', 80, 24);
		const regular = fixture.host.getActiveSession('tab-regular-allocation');
		assert.ok(regular !== undefined);
		assert.strictEqual(regular.sessionId, 'session-activity-panel-1');
		fixture.host.closeTab('tab-regular-allocation');

		const first = await beginCodex(fixture.host, 'tab-allocation-paths');
		assert.strictEqual(first.sessionId, 'session-activity-panel-2');
		const firstRuntime = fixture.supervisor.getSessionRuntime(first.sessionId);
		assert.ok(firstRuntime !== undefined);
		fixture.host.handleMcpRuntimeEvent(failureEnvelope(firstRuntime));

		await fixture.host.restartMcpSession(first.tabId, first.sessionId);
		const afterMcpRestart = fixture.host.getActiveSession(first.tabId);
		assert.ok(afterMcpRestart !== undefined);
		assert.strictEqual(
			afterMcpRestart.sessionId,
			'session-activity-panel-3',
		);

		fixture.adapter.handles.at(-1)?.emitExit({ exitCode: 0 });
		assert.strictEqual(afterMcpRestart.state.kind, 'exited');
		await fixture.host.restartSession(
			afterMcpRestart.tabId,
			afterMcpRestart.sessionId,
		);
		const afterTerminalRestart = fixture.host.getActiveSession(first.tabId);
		assert.ok(afterTerminalRestart !== undefined);
		assert.strictEqual(
			afterTerminalRestart.sessionId,
			'session-activity-panel-4',
		);

		fixture.host.resetAgent(first.tabId);
		await fixture.host.handleTerminalReady(first.tabId, 100, 30);
		await fixture.host.switchAgent(
			first.tabId,
			'codex',
			WORKSPACE_ROOT_ID,
			2,
		);
		const afterResetSwitch = fixture.host.getActiveSession(first.tabId);
		assert.ok(afterResetSwitch !== undefined);
		assert.strictEqual(
			afterResetSwitch.sessionId,
			'session-activity-panel-5',
		);
	});

	test('post-ready Claude diagnostic fallback은 exact retirement 중 replacement를 보존하고 observed exit를 finalize한다', async () => {
		const adapter = new FakePtyAdapter(9911);
		const supervisor = new FakeActivitySupervisor();
		const messages: HostToWebviewMessage[] = [];
		const host = new TerminalHost({
			ptyAdapter: adapter,
			prepareLaunch: prepareShell,
			prepareClaudeLaunch: async () => ({
				ok: true,
				preparation: {
					executable: {
						executable: '/resolved/claude',
						launcherKind: 'direct',
					},
					cwd: WORKSPACE_ROOT_FS_PATH,
					environment: { PATH: '/bin' },
					platform: 'linux',
					mcpCompatible: true,
				},
			}),
			mcpSupervisor: supervisor,
			resolveAgentAutoRunInput: async () => undefined,
			workspaceResolver: () => ({ ok: true, root: workspaceRoot }),
			readWorkspaceTrust: () => true,
			processTreeController: createCaptureFailureProcessTreeController(),
			sessionIdNonce: 'claude-fallback-panel',
			emitMessage: (message) => messages.push(message),
		});
		host.createTab('tab-claude-replacement');
		await host.handleTerminalReady('tab-claude-replacement', 100, 30);
		await host.switchAgent(
			'tab-claude-replacement',
			'claude',
			WORKSPACE_ROOT_ID,
			1,
		);
		const session = host.getActiveSession('tab-claude-replacement');
		assert.ok(session !== undefined);
		let replacement: McpSessionRuntime | undefined;
		supervisor.beforeRetire = (runtime) => {
			replacement ??= supervisor.replace(runtime.sessionId);
		};

		adapter.handles[0].emitData(
			`Error: ${CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION}\r\n`,
		);
		adapter.handles[0].emitExit({ exitCode: 1 });
		await waitUntil(() => replacement !== undefined && messages.some((message) =>
			message.type === 'terminal.exited'
			&& message.sessionId === session.sessionId
		));

		assert.ok(replacement !== undefined);
		assert.strictEqual(
			supervisor.getSessionRuntime(session.sessionId),
			replacement,
		);
		assert.strictEqual(host.getActiveSession(session.tabId), session);
		assert.deepStrictEqual(session.state, {
			kind: 'exited',
			exitCode: 1,
			signal: null,
		});
		assert.strictEqual(adapter.spawnCalls.length, 1);
		assert.strictEqual(
			host.getSession('session-claude-fallback-panel-2'),
			undefined,
		);
	});
});
