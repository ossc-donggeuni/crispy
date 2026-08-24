import * as assert from 'node:assert/strict';
import type { HostToWebviewMessage } from '../../agent/protocol/messages';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';
import type { PrepareTerminalLaunch } from '../../agent/host/terminal/prepareTerminalLaunch';
import {
	TerminalHost,
	type CodexMcpSupervisor,
} from '../../agent/host/terminal/terminalHost';
import { buildCodexMcpLaunchPlan } from '../../mcp/codexLaunchPlan';
import { McpConnectionDescriptor } from '../../mcp/sessionRuntime';
import type {
	McpPrepareResult,
	McpRuntimeLifecycle,
	McpSessionRuntimeEvent,
} from '../../mcp/sessionRuntime';
import { FakePtyAdapter } from './support/fakePtyAdapter';
import { createCaptureFailureProcessTreeController } from './support/fakeProcessTreeController';
import { FakeProcessTreeController } from './support/fakeProcessTreeController';
import type { ProcessTreeController } from '../../agent/host/terminal/processTreeController';

const shellPolicy: ShellLaunchPolicy = {
	executable: '/host/shell',
	args: [],
	cwd: '/trusted/workspace',
	env: { PATH: '/bin' },
};
const WORKSPACE_ROOT_ID = 'workspace-root:file:///trusted/workspace';
const workspaceRoot = {
	scheme: 'file',
	fsPath: '/trusted/workspace',
} as import('../../agent/host/workspace/types').ValidatedWorkspaceRoot;

const successfulShellPrepare: PrepareTerminalLaunch = async () => ({
	ok: true,
	policy: shellPolicy,
});

class FakeCodexRuntime {
	lifecycle: McpRuntimeLifecycle = 'running';
	markProviderStartedCount = 0;

	constructor(readonly generation: string) {}

	markProviderStarted(): boolean {
		if (this.lifecycle !== 'running') {
			return false;
		}
		this.markProviderStartedCount += 1;
		return true;
	}
}

class FakeCodexSupervisor implements CodexMcpSupervisor {
	readonly prepareCalls: string[] = [];
	readonly stopCalls: string[] = [];
	disposeCallCount = 0;
	prepareFailure: McpPrepareResult | undefined;
	deferPrepare = false;
	private generationIndex = 0;
	private readonly runtimes = new Map<string, FakeCodexRuntime>();
	private readonly connections = new Map<string, McpConnectionDescriptor>();
	private readonly pending = new Map<string, {
		readonly resolve: (result: McpPrepareResult) => void;
	}>();

	prepareSession(sessionId: string): Promise<McpPrepareResult> {
		this.prepareCalls.push(sessionId);
		if (this.prepareFailure !== undefined) {
			return Promise.resolve(this.prepareFailure);
		}
		if (!this.deferPrepare) {
			return Promise.resolve(this.createSuccess(sessionId));
		}
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

	stopSession(sessionId: string): Promise<void> {
		this.stopCalls.push(sessionId);
		this.connections.get(sessionId)?.invalidate();
		this.connections.delete(sessionId);
		const runtime = this.runtimes.get(sessionId);
		if (runtime !== undefined) {
			runtime.lifecycle = 'stopped';
		}
		this.runtimes.delete(sessionId);
		return Promise.resolve();
	}

	getSessionRuntime(sessionId: string): FakeCodexRuntime | undefined {
		return this.runtimes.get(sessionId);
	}

	dispose(): Promise<void> {
		this.disposeCallCount += 1;
		for (const connection of this.connections.values()) {
			connection.invalidate();
		}
		for (const runtime of this.runtimes.values()) {
			runtime.lifecycle = 'stopped';
		}
		this.connections.clear();
		this.runtimes.clear();
		return Promise.resolve();
	}

	crash(sessionId: string): McpSessionRuntimeEvent {
		const runtime = this.runtimes.get(sessionId);
		assert.ok(runtime !== undefined);
		runtime.lifecycle = 'crashed';
		this.connections.get(sessionId)?.invalidate();
		return {
			type: 'runtime.failure',
			generation: runtime.generation,
			sessionId,
			failure: { reason: 'adapter_exited', retryable: true },
			providerStarted: runtime.markProviderStartedCount > 0,
			providerAction: runtime.markProviderStartedCount > 0
				? 'keep_running'
				: 'continue_without_mcp',
		};
	}

	activity(sessionId: string): McpSessionRuntimeEvent {
		const runtime = this.runtimes.get(sessionId);
		assert.ok(runtime !== undefined);
		return {
			type: 'session.mcpActivityObserved',
			generation: runtime.generation,
			sessionId,
		};
	}

	private createSuccess(sessionId: string): McpPrepareResult {
		this.generationIndex += 1;
		const generation = `generation-${this.generationIndex}`;
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
		this.runtimes.set(sessionId, new FakeCodexRuntime(generation));
		return { ok: true, connection };
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
		resolveAgentAutoRunInput: async (providerId) =>
			providerId === 'claude' ? 'claude\r' : 'agy\r',
		prepareCodexLaunch: async () => ({
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
		}),
		mcpSupervisor: supervisor,
		processTreeController: options.processTreeController
			?? createCaptureFailureProcessTreeController(),
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

suite('Codex direct PTY and MCP transaction', () => {
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
		assert.strictEqual(fixture.adapter.spawnCalls[0].executable, '/host/shell');
		assert.deepStrictEqual(fixture.adapter.handles[0].writes, ['claude\r']);
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
		const duplicate = fixture.host.restartMcpSession(first.tabId, first.sessionId);
		assert.strictEqual(duplicate, restart);
		await restart;

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

	test('non-retryable 또는 connected session의 mcp.restart는 CLI를 종료하지 않는다', async () => {
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
