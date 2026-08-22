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

const shellPolicy: ShellLaunchPolicy = {
	executable: '/host/shell',
	args: [],
	cwd: '/trusted/workspace',
	env: { PATH: '/bin' },
};

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
		processTreeController: createCaptureFailureProcessTreeController(),
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
	return host.switchAgent(tabId, 'codex');
}

suite('Codex direct PTY and MCP transaction', () => {
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

		await fixture.host.switchAgent('tab-reselect', 'claude');
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
