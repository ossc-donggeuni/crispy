import * as assert from 'node:assert/strict';
import type { HostToWebviewMessage } from '../../agent/protocol/messages';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';
import type { PrepareTerminalLaunch } from '../../agent/host/terminal/prepareTerminalLaunch';
import {
	TerminalHost,
	type McpSupervisor,
} from '../../agent/host/terminal/terminalHost';
import type { ProcessTreeController } from '../../agent/host/terminal/processTreeController';
import { buildClaudeMcpLaunchPlan } from '../../mcp/claudeLaunchPlan';
import { CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION } from '../../mcp/claudeDiagnostic';
import { McpConnectionDescriptor } from '../../mcp/sessionRuntime';
import type {
	McpPrepareResult,
	McpRuntimeLifecycle,
	McpSessionRuntimeEvent,
} from '../../mcp/sessionRuntime';
import { createCaptureFailureProcessTreeController } from './support/fakeProcessTreeController';
import { FakePtyAdapter } from './support/fakePtyAdapter';

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

class FakeClaudeRuntime {
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

class FakeClaudeSupervisor implements McpSupervisor {
	readonly prepareCalls: string[] = [];
	readonly stopCalls: string[] = [];
	disposeCallCount = 0;
	prepareFailure: McpPrepareResult | undefined;
	private generationIndex = 0;
	private readonly runtimes = new Map<string, FakeClaudeRuntime>();
	private readonly connections = new Map<string, McpConnectionDescriptor>();

	prepareSession(sessionId: string): Promise<McpPrepareResult> {
		this.prepareCalls.push(sessionId);
		if (this.prepareFailure !== undefined) {
			return Promise.resolve(this.prepareFailure);
		}
		this.generationIndex += 1;
		const generation = `claude-generation-${this.generationIndex}`;
		const route = Buffer.alloc(24, this.generationIndex).toString('base64url');
		const token = Buffer.alloc(32, this.generationIndex + 32).toString('base64url');
		const connection = new McpConnectionDescriptor(
			generation,
			sessionId,
			`http://127.0.0.1:${45000 + this.generationIndex}/mcp/${route}`,
			token,
		);
		this.connections.set(sessionId, connection);
		this.runtimes.set(sessionId, new FakeClaudeRuntime(generation));
		return Promise.resolve({ ok: true, connection });
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

	getSessionRuntime(sessionId: string): FakeClaudeRuntime | undefined {
		return this.runtimes.get(sessionId);
	}

	dispose(): Promise<void> {
		this.disposeCallCount += 1;
		for (const connection of this.connections.values()) {
			connection.invalidate();
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
}

function createFixture(options: {
	readonly mcpCompatible?: boolean;
	readonly fakePid?: number;
	readonly prepareClaudeLaunch?: ConstructorParameters<typeof TerminalHost>[0][
		'prepareClaudeLaunch'
	];
	readonly buildPlan?: ConstructorParameters<typeof TerminalHost>[0][
		'buildClaudeMcpLaunchPlan'
	];
	readonly processTreeController?: ProcessTreeController;
} = {}): {
	readonly host: TerminalHost;
	readonly adapter: FakePtyAdapter;
	readonly supervisor: FakeClaudeSupervisor;
	readonly messages: HostToWebviewMessage[];
} {
	const adapter = new FakePtyAdapter(options.fakePid ?? 8201);
	const supervisor = new FakeClaudeSupervisor();
	const messages: HostToWebviewMessage[] = [];
	const host = new TerminalHost({
		ptyAdapter: adapter,
		prepareLaunch: successfulShellPrepare,
		resolveAgentAutoRunInput: async (providerId) =>
			providerId === 'antigravity' ? 'agy\r' : 'claude\r',
		prepareClaudeLaunch: options.prepareClaudeLaunch ?? (async () => ({
			ok: true,
			preparation: {
				executable: {
					executable: '/resolved/claude',
					launcherKind: 'direct',
				},
				cwd: '/trusted/workspace',
				environment: {
					PATH: '/bin',
					crispy_mcp_token: 'stale',
					Electron_Run_As_Node: '1',
				},
				platform: 'linux',
				mcpCompatible: options.mcpCompatible ?? true,
			},
		})),
		mcpSupervisor: supervisor,
		processTreeController: options.processTreeController
			?? createCaptureFailureProcessTreeController(),
		...(options.buildPlan === undefined
			? {}
			: { buildClaudeMcpLaunchPlan: options.buildPlan }),
		emitMessage: (message) => messages.push(message),
	});
	return { host, adapter, supervisor, messages };
}

async function beginClaude(host: TerminalHost, tabId: string): Promise<void> {
	host.createTab(tabId);
	await host.handleTerminalReady(tabId, 100, 30);
	return host.switchAgent(tabId, 'claude');
}

suite('Claude direct PTY and MCP transaction', () => {
	test('minimum 미만 또는 probe 실패 결과는 MCP 준비 없이 bare Claude를 실행한다', async () => {
		const fixture = createFixture({ mcpCompatible: false });

		await beginClaude(fixture.host, 'tab-version-fail-open');

		assert.strictEqual(fixture.supervisor.prepareCalls.length, 0);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.spawnCalls[0].executable, '/resolved/claude');
		assert.deepStrictEqual(fixture.adapter.spawnCalls[0].args, []);
		assert.strictEqual(Object.keys(fixture.adapter.spawnCalls[0].env).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), false);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusChanged'
				|| (
					message.type === 'terminal.error'
					&& message.message.includes('update')
				),
		), false);
	});

	test('auth 등록과 final sanitizer 뒤 Claude를 PTY root로 한 번 시작한다', async () => {
		const fixture = createFixture();

		await beginClaude(fixture.host, 'tab-authenticated');

		assert.strictEqual(fixture.supervisor.prepareCalls.length, 1);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		const spawn = fixture.adapter.spawnCalls[0];
		assert.strictEqual(spawn.executable, '/resolved/claude');
		assert.strictEqual(spawn.env.ELECTRON_RUN_AS_NODE, undefined);
		assert.strictEqual(spawn.env.crispy_mcp_token, undefined);
		assert.strictEqual(typeof spawn.env.CRISPY_MCP_TOKEN, 'string');
		assert.strictEqual(Array.isArray(spawn.args), true);
		const args = spawn.args as readonly string[];
		assert.strictEqual(args[0], '--mcp-config');
		assert.strictEqual(args[1].includes('${CRISPY_MCP_TOKEN}'), true);
		assert.strictEqual(args[1].includes(spawn.env.CRISPY_MCP_TOKEN!), false);
		const session = fixture.host.getActiveSession('tab-authenticated');
		assert.ok(session !== undefined);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime(session.sessionId)
				?.markProviderStartedCount,
			1,
		);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusChanged',
		), false);
	});

	test('authenticated spawn 실패는 bare를 한 번만 재시도하고 credential을 폐기한다', async () => {
		const fixture = createFixture();
		fixture.adapter.spawnFailuresRemaining = 1;

		await beginClaude(fixture.host, 'tab-spawn-fail-open');

		assert.strictEqual(fixture.adapter.spawnCalls.length, 2);
		assert.strictEqual(Object.keys(fixture.adapter.spawnCalls[0].env).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), true);
		assert.deepStrictEqual(fixture.adapter.spawnCalls[1].args, []);
		assert.strictEqual(Object.keys(fixture.adapter.spawnCalls[1].env).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), false);
		assert.strictEqual(fixture.supervisor.stopCalls.length >= 1, true);
	});

	test('MCP ready/auth 준비 실패도 credential 없는 bare Claude로 연다', async () => {
		const fixture = createFixture();
		fixture.supervisor.prepareFailure = {
			ok: false,
			failure: { reason: 'auth_registration_failed', retryable: true },
			providerAction: 'continue_without_mcp',
		};

		await beginClaude(fixture.host, 'tab-prepare-fail-open');

		assert.strictEqual(fixture.supervisor.prepareCalls.length, 1);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(fixture.adapter.spawnCalls[0].args, []);
		assert.strictEqual(Object.keys(fixture.adapter.spawnCalls[0].env).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), false);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'mcp.statusChanged',
		), false);
	});

	test('authenticated와 bare spawn이 모두 실패하면 세 번째 시도 없이 start_failed다', async () => {
		const fixture = createFixture();
		fixture.adapter.spawnFailuresRemaining = 2;

		await beginClaude(fixture.host, 'tab-double-spawn-failure');

		assert.strictEqual(fixture.adapter.spawnCalls.length, 2);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'terminal.error'
				&& message.code === 'start_failed',
		), true);
	});

	test('PID 준비 전 login/network exit은 bare로 오판하지 않고 start_failed로 끝낸다', async () => {
		const fixture = createFixture({ fakePid: 0 });
		const starting = beginClaude(fixture.host, 'tab-pre-ready-network-exit');
		await waitUntil(() => fixture.adapter.handles.length === 1);
		const authenticated = fixture.host.getActiveSession(
			'tab-pre-ready-network-exit',
		);
		assert.ok(authenticated !== undefined);

		fixture.adapter.handles[0].emitData(
			'Authentication failed while contacting the API.\r\n',
		);
		fixture.adapter.handles[0].emitExit({ exitCode: 1 });
		await starting;

		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.supervisor.stopCalls.includes(
			authenticated.sessionId,
		), true);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'terminal.error'
				&& message.sessionId === authenticated.sessionId
				&& message.code === 'start_failed',
		), true);
	});

	test('version probe 중 provider 변경은 stale Claude MCP와 PTY를 만들지 않는다', async () => {
		let release!: (result: Awaited<ReturnType<NonNullable<
			ConstructorParameters<typeof TerminalHost>[0]['prepareClaudeLaunch']
		>>>) => void;
		const deferred = new Promise<Awaited<ReturnType<NonNullable<
			ConstructorParameters<typeof TerminalHost>[0]['prepareClaudeLaunch']
		>>>>((resolve) => {
			release = resolve;
		});
		const fixture = createFixture({
			prepareClaudeLaunch: () => deferred,
		});
		fixture.host.createTab('tab-stale-probe');
		await fixture.host.handleTerminalReady('tab-stale-probe', 100, 30);
		const claudeStart = fixture.host.switchAgent('tab-stale-probe', 'claude');
		await Promise.resolve();

		await fixture.host.switchAgent('tab-stale-probe', 'antigravity');
		release({
			ok: true,
			preparation: {
				executable: { executable: '/resolved/claude', launcherKind: 'direct' },
				cwd: '/trusted/workspace',
				environment: { PATH: '/bin' },
				platform: 'linux',
				mcpCompatible: true,
			},
		});
		await claudeStart;

		assert.strictEqual(fixture.supervisor.prepareCalls.length, 0);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
		assert.strictEqual(fixture.adapter.spawnCalls[0].executable, '/host/shell');
		assert.deepStrictEqual(fixture.adapter.handles[0].writes, ['agy\r']);
	});

	test('PTY 전 adapter crash는 bare로 전환하고 PTY 후 crash는 Claude를 유지한다', async () => {
		let releasePlan!: () => void;
		const planGate = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		const beforeSpawn = createFixture({
			buildPlan: async (options) => {
				await planGate;
				return buildClaudeMcpLaunchPlan(options);
			},
		});
		const starting = beginClaude(beforeSpawn.host, 'tab-pre-spawn-crash');
		await waitUntil(() => beforeSpawn.supervisor.prepareCalls.length === 1);
		const firstSessionId = beforeSpawn.supervisor.prepareCalls[0];
		beforeSpawn.host.handleMcpRuntimeEvent(
			beforeSpawn.supervisor.crash(firstSessionId),
		);
		releasePlan();
		await starting;
		assert.strictEqual(beforeSpawn.adapter.spawnCalls.length, 1);
		assert.deepStrictEqual(beforeSpawn.adapter.spawnCalls[0].args, []);

		const afterSpawn = createFixture();
		await beginClaude(afterSpawn.host, 'tab-post-spawn-crash');
		const session = afterSpawn.host.getActiveSession('tab-post-spawn-crash');
		assert.ok(session !== undefined);
		afterSpawn.host.handleMcpRuntimeEvent(
			afterSpawn.supervisor.crash(session.sessionId),
		);
		afterSpawn.host.routeInput({
			type: 'terminal.input',
			tabId: session.tabId,
			sessionId: session.sessionId,
			data: 'input-after-crash',
		});
		afterSpawn.adapter.handles[0].emitData('output-after-crash');
		await Promise.resolve();

		assert.strictEqual(afterSpawn.adapter.spawnCalls.length, 1);
		assert.strictEqual(afterSpawn.adapter.handles[0].killCallCount, 0);
		assert.deepStrictEqual(afterSpawn.adapter.handles[0].writes, ['input-after-crash']);
		assert.strictEqual(afterSpawn.messages.some(
			(message) => message.type === 'terminal.output'
				&& message.data === 'output-after-crash',
		), true);
		assert.strictEqual(afterSpawn.messages.some(
			(message) => message.type === 'mcp.statusChanged',
		), false);
	});
});

suite('Claude narrow startup rejection fallback', () => {
	test('PID 준비 전 exact policy rejection도 fresh bare session으로 한 번만 전환한다', async () => {
		const fixture = createFixture({ fakePid: 0 });
		const starting = beginClaude(fixture.host, 'tab-pre-ready-policy-fallback');
		await waitUntil(() => fixture.adapter.handles.length === 1);
		const authenticated = fixture.host.getActiveSession(
			'tab-pre-ready-policy-fallback',
		);
		assert.ok(authenticated !== undefined);

		fixture.adapter.handles[0].emitData(
			`Error: ${CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION}\r\n`,
		);
		fixture.adapter.handles[0].emitExit({ exitCode: 1 });
		await starting;
		await waitUntil(() => fixture.adapter.spawnCalls.length === 2);

		assert.deepStrictEqual(fixture.adapter.spawnCalls[1].args, []);
		assert.strictEqual(Object.keys(fixture.adapter.spawnCalls[1].env).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), false);
		fixture.adapter.handles[1].setReadyPid(8202);
		await waitUntil(() => fixture.messages.some(
			(message) => message.type === 'terminal.started'
				&& message.sessionId !== authenticated.sessionId,
		));
		assert.strictEqual(fixture.adapter.spawnCalls.length, 2);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'terminal.error',
		), false);
	});

	test('공식 managed-policy startup rejection만 fresh bare session으로 한 번 relaunch한다', async () => {
		const fixture = createFixture();
		await beginClaude(fixture.host, 'tab-policy-fallback');
		const authenticated = fixture.host.getActiveSession('tab-policy-fallback');
		assert.ok(authenticated !== undefined);

		fixture.adapter.handles[0].emitData(
			`Error: ${CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION}\r\n`,
		);
		fixture.adapter.handles[0].emitExit({ exitCode: 1 });
		await waitUntil(() => fixture.adapter.spawnCalls.length === 2);

		const bare = fixture.host.getActiveSession('tab-policy-fallback');
		assert.ok(bare !== undefined);
		assert.notStrictEqual(bare.sessionId, authenticated.sessionId);
		assert.deepStrictEqual(fixture.adapter.spawnCalls[1].args, []);
		assert.strictEqual(Object.keys(fixture.adapter.spawnCalls[1].env).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), false);
		assert.strictEqual(fixture.supervisor.stopCalls.includes(
			authenticated.sessionId,
		), true);
		assert.strictEqual(fixture.messages.filter(
			(message) => message.type === 'terminal.started',
		).length, 2);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'terminal.exited'
				&& message.sessionId === authenticated.sessionId,
		), false);
	});

	test('network/login-like 오류와 interactive input 뒤 오류는 자동 relaunch하지 않는다', async () => {
		const network = createFixture();
		await beginClaude(network.host, 'tab-network-exit');
		network.adapter.handles[0].emitData('Authentication failed while contacting the API.\r\n');
		network.adapter.handles[0].emitExit({ exitCode: 1 });
		await Promise.resolve();
		assert.strictEqual(network.adapter.spawnCalls.length, 1);
		assert.strictEqual(network.messages.some(
			(message) => message.type === 'terminal.exited',
		), true);

		const interactive = createFixture();
		await beginClaude(interactive.host, 'tab-interactive-exit');
		const session = interactive.host.getActiveSession('tab-interactive-exit');
		assert.ok(session !== undefined);
		interactive.host.routeInput({
			type: 'terminal.input',
			tabId: session.tabId,
			sessionId: session.sessionId,
			data: 'user-input',
		});
		interactive.adapter.handles[0].emitData(
			`Error: ${CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION}\r\n`,
		);
		interactive.adapter.handles[0].emitExit({ exitCode: 1 });
		await Promise.resolve();
		assert.strictEqual(interactive.adapter.spawnCalls.length, 1);
	});

	test('normal Claude exit은 token과 adapter를 정리하고 기존 exit를 전달한다', async () => {
		const fixture = createFixture();
		await beginClaude(fixture.host, 'tab-normal-exit');
		const session = fixture.host.getActiveSession('tab-normal-exit');
		assert.ok(session !== undefined);

		fixture.adapter.handles[0].emitExit({ exitCode: 0 });
		await Promise.resolve();

		assert.strictEqual(fixture.supervisor.stopCalls.includes(session.sessionId), true);
		assert.strictEqual(fixture.messages.some(
			(message) => message.type === 'terminal.exited'
				&& message.sessionId === session.sessionId
				&& message.exitCode === 0,
		), true);
		assert.strictEqual(fixture.adapter.spawnCalls.length, 1);
	});
});

async function waitUntil(
	predicate: () => boolean,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for test condition.');
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
