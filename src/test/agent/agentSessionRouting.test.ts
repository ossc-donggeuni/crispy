import * as assert from 'assert';
import { resolveAgentAutoRunInput } from '../../agent/host/agent/agentProviderLaunch';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';
import type { PrepareTerminalLaunch } from '../../agent/host/terminal/prepareTerminalLaunch';
import { TerminalHost } from '../../agent/host/terminal/terminalHost';
import type { HostToWebviewMessage } from '../../agent/protocol/messages';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
} from '../../agent/host/workspace/types';
import { FakePtyAdapter, FakePtyProcessHandle } from './support/fakePtyAdapter';
import { createCaptureFailureProcessTreeController } from './support/fakeProcessTreeController';

const root = {
	scheme: 'file',
	fsPath: '/validated/workspace' as ValidatedWorkspaceFsPath,
} as ValidatedWorkspaceRoot;

const launchPolicy: ShellLaunchPolicy = {
	executable: '/host/selected/shell',
	args: [],
	cwd: root.fsPath,
	env: {},
};

const successfulPrepare: PrepareTerminalLaunch = async () => ({
	ok: true,
	policy: launchPolicy,
});

/** 같은 Terminal lifecycle에서 CLI를 자동 실행하는 provider 목록이다. */
const autoRunProviderIds = ['codex', 'claude', 'antigravity'] as const;

/**
 * FakePtyAdapter와 성공 준비 경계를 가진 Host 및 메시지 기록을 만든다.
 *
 * @returns Host, PTY adapter와 발행된 Host 메시지 기록
 */
function createRoutingHost(fakePid: number = 4242): {
	readonly host: TerminalHost;
	readonly ptyAdapter: FakePtyAdapter;
	readonly messages: HostToWebviewMessage[];
} {
	const ptyAdapter = new FakePtyAdapter(fakePid);
	const messages: HostToWebviewMessage[] = [];
	const host = new TerminalHost({
		ptyAdapter,
		prepareLaunch: successfulPrepare,
		emitMessage: (message) => messages.push(message),
		processTreeController: createCaptureFailureProcessTreeController(),
		resolveAgentAutoRunInput: async (providerId) =>
			resolveAgentAutoRunInput(providerId),
	});

	return { host, ptyAdapter, messages };
}

/**
 * 발행된 메시지에서 특정 type만 골라낸다.
 *
 * @param messages 기록된 Host 메시지 목록
 * @param type 골라낼 메시지 type
 * @returns 해당 type의 메시지 목록
 */
function messagesOfType<Type extends HostToWebviewMessage['type']>(
	messages: readonly HostToWebviewMessage[],
	type: Type,
): Array<Extract<HostToWebviewMessage, { type: Type }>> {
	return messages.filter(
		(message): message is Extract<HostToWebviewMessage, { type: Type }> =>
			message.type === type,
	);
}

/**
 * 탭을 등록하고 표면 준비까지 마친 뒤 provider를 지정해 세션을 시작한다.
 *
 * @param host 대상 Host
 * @param tabId 등록할 탭 식별자
 * @param providerId 배정할 provider 식별자
 */
async function openTab(
	host: TerminalHost,
	tabId: string,
	providerId: 'codex' | 'claude' | 'antigravity',
): Promise<void> {
	host.createTab(tabId);
	await host.handleTerminalReady(tabId, 80, 24);
	await host.switchAgent(tabId, providerId);
}

/**
 * 마지막으로 생성된 PTY handle을 반환한다.
 *
 * @param ptyAdapter 기록을 보유한 PTY adapter
 * @returns 가장 최근에 생성된 handle
 */
function latestHandle(ptyAdapter: FakePtyAdapter): FakePtyProcessHandle {
	const handle = ptyAdapter.handles[ptyAdapter.handles.length - 1];
	assert.ok(handle !== undefined);
	return handle;
}

suite('Agent 탭 provider 선택과 세션 routing', () => {
	test('provider와 platform별 Host auto-run 입력을 결정한다', () => {
		assert.strictEqual(resolveAgentAutoRunInput('codex', 'darwin'), 'codex\r');
		assert.strictEqual(resolveAgentAutoRunInput('codex', 'linux'), 'codex\r');
		assert.strictEqual(resolveAgentAutoRunInput('codex', 'win32'), 'codex\r');

		assert.strictEqual(resolveAgentAutoRunInput('claude', 'darwin'), 'claude\r');
		assert.strictEqual(resolveAgentAutoRunInput('claude', 'linux'), 'claude\r');
		assert.strictEqual(resolveAgentAutoRunInput('claude', 'win32'), 'claude\r');

		assert.strictEqual(resolveAgentAutoRunInput('antigravity', 'darwin'), 'agy\r');
		assert.strictEqual(resolveAgentAutoRunInput('antigravity', 'linux'), 'agy\r');
		assert.strictEqual(resolveAgentAutoRunInput('antigravity', 'win32'), 'agy\r');
	});

	test('탭만 만들면 provider가 없으므로 세션을 시작하지 않는다', async () => {
		const { host, ptyAdapter, messages } = createRoutingHost();

		host.createTab('tab-created');
		await host.handleTerminalReady('tab-created', 120, 40);

		assert.strictEqual(ptyAdapter.spawnCalls.length, 0);
		assert.strictEqual(host.getActiveSession('tab-created'), undefined);
		assert.strictEqual(messages.length, 0);
		assert.strictEqual(host.hasTab('tab-created'), true);
		assert.strictEqual(host.getTabProvider('tab-created'), undefined);
	});

	for (const providerId of autoRunProviderIds) {
		test(`${providerId} 선택, 재선택과 overlay restart가 공통 auto-run lifecycle을 재사용한다`, async () => {
			const { host, ptyAdapter, messages } = createRoutingHost();
			const tabId = `tab-lifecycle-${providerId}`;
			const expected = resolveAgentAutoRunInput(providerId);
			assert.ok(expected !== undefined);

			await openTab(host, tabId, providerId);
			const firstSession = host.getActiveSession(tabId);
			const firstHandle = latestHandle(ptyAdapter);
			assert.ok(firstSession !== undefined);
			assert.strictEqual(firstSession.state.kind, 'running');
			assert.deepStrictEqual(firstHandle.writes, [expected]);

			await host.switchAgent(tabId, providerId);
			const secondSession = host.getActiveSession(tabId);
			const secondHandle = latestHandle(ptyAdapter);
			assert.ok(secondSession !== undefined);
			assert.strictEqual(secondSession.state.kind, 'running');
			assert.strictEqual(firstHandle.killCallCount, 1);
			assert.strictEqual(firstHandle.dataListenerCount, 0);
			assert.strictEqual(firstHandle.exitListenerCount, 0);
			assert.notStrictEqual(secondSession.sessionId, firstSession.sessionId);
			assert.deepStrictEqual(secondHandle.writes, [expected]);

			secondHandle.emitExit({ exitCode: 0 });
			await host.restartSession(tabId, secondSession.sessionId);
			const thirdSession = host.getActiveSession(tabId);
			assert.ok(thirdSession !== undefined);
			assert.strictEqual(secondHandle.killCallCount, 1);
			assert.strictEqual(secondHandle.dataListenerCount, 0);
			assert.strictEqual(secondHandle.exitListenerCount, 0);
			assert.strictEqual(host.getTabProvider(tabId), providerId);
			assert.notStrictEqual(thirdSession.sessionId, secondSession.sessionId);
			assert.strictEqual(thirdSession.state.kind, 'running');
			assert.deepStrictEqual(latestHandle(ptyAdapter).writes, [expected]);
			assert.strictEqual(ptyAdapter.spawnCalls.length, 3);
			assert.strictEqual(
				messagesOfType(messages, 'terminal.started').length,
				3,
			);
		});

		test(`${providerId} delayed PID 동안 running과 auto-run 입력을 보류한다`, async () => {
			const { host, ptyAdapter, messages } = createRoutingHost(0);
			const tabId = `tab-delayed-${providerId}`;
			const expected = resolveAgentAutoRunInput(providerId);
			assert.ok(expected !== undefined);
			host.createTab(tabId);
			await host.handleTerminalReady(tabId, 80, 24);

			const switching = host.switchAgent(tabId, providerId);
			/** launch 준비 뒤 provider CLI resolver가 완료되는 microtask까지 기다린다. */
			await Promise.resolve();
			await Promise.resolve();
			const handle = latestHandle(ptyAdapter);
			assert.deepStrictEqual(
				host.getActiveSession(tabId)?.state,
				{ kind: 'starting' },
			);
			assert.strictEqual(
				messagesOfType(messages, 'terminal.started').length,
				0,
			);
			assert.deepStrictEqual(handle.writes, []);

			handle.setReadyPid(4301);
			await switching;

			assert.deepStrictEqual(
				host.getActiveSession(tabId)?.state,
				{ kind: 'running', pid: 4301 },
			);
			assert.strictEqual(
				messagesOfType(messages, 'terminal.started').length,
				1,
			);
			assert.deepStrictEqual(handle.writes, [expected]);
		});
	}

	test('provider 선택이 표면 준비보다 먼저 도착해도 준비 뒤에 시작한다', async () => {
		const { host, ptyAdapter } = createRoutingHost();

		host.createTab('tab-early-provider');
		await host.switchAgent('tab-early-provider', 'codex');
		assert.strictEqual(ptyAdapter.spawnCalls.length, 0);

		await host.handleTerminalReady('tab-early-provider', 100, 30);

		assert.strictEqual(ptyAdapter.spawnCalls.length, 1);
		assert.strictEqual(ptyAdapter.spawnCalls[0].cols, 100);
		assert.strictEqual(ptyAdapter.spawnCalls[0].rows, 30);
		assert.strictEqual(latestHandle(ptyAdapter).writes.length, 1);
	});

	test('Antigravity와 Codex 탭의 세션과 입출력이 섞이지 않는다', async () => {
		const { host, ptyAdapter, messages } = createRoutingHost();
		const antigravityExpected = resolveAgentAutoRunInput('antigravity');
		const codexExpected = resolveAgentAutoRunInput('codex');
		assert.ok(
			antigravityExpected !== undefined && codexExpected !== undefined,
		);

		await openTab(host, 'tab-antigravity', 'antigravity');
		const antigravitySession = host.getActiveSession('tab-antigravity');
		const antigravityHandle = latestHandle(ptyAdapter);

		await openTab(host, 'tab-codex', 'codex');
		const codexSession = host.getActiveSession('tab-codex');
		const codexHandle = latestHandle(ptyAdapter);

		assert.ok(
			antigravitySession !== undefined && codexSession !== undefined,
		);
		assert.notStrictEqual(
			antigravitySession.sessionId,
			codexSession.sessionId,
		);
		assert.notStrictEqual(antigravityHandle, codexHandle);
		assert.deepStrictEqual(antigravityHandle.writes, [antigravityExpected]);
		assert.deepStrictEqual(codexHandle.writes, [codexExpected]);

		host.routeInput({
			type: 'terminal.input',
			tabId: 'tab-antigravity',
			sessionId: antigravitySession.sessionId,
			data: 'x',
		});

		assert.deepStrictEqual(
			antigravityHandle.writes,
			[antigravityExpected, 'x'],
		);
		assert.deepStrictEqual(codexHandle.writes, [codexExpected]);

		messages.length = 0;
		antigravityHandle.emitData('antigravity output');
		codexHandle.emitData('codex output');
		await Promise.resolve();

		const outputs = messagesOfType(messages, 'terminal.output');
		assert.deepStrictEqual(
			outputs.map(({ tabId, sessionId, data }) => ({ tabId, sessionId, data })),
			[
				{
					tabId: 'tab-antigravity',
					sessionId: antigravitySession.sessionId,
					data: 'antigravity output',
				},
				{
					tabId: 'tab-codex',
					sessionId: codexSession.sessionId,
					data: 'codex output',
				},
			],
		);

		host.closeTab('tab-antigravity');
		await Promise.resolve();
		assert.strictEqual(antigravityHandle.killCallCount, 1);
		assert.strictEqual(codexHandle.killCallCount, 0);
		assert.strictEqual(host.getActiveSession('tab-codex'), codexSession);
		assert.strictEqual(codexSession.state.kind, 'running');
	});

	test('다른 provider 탭 종료가 Antigravity 세션에 영향을 주지 않는다', async () => {
		const { host, ptyAdapter } = createRoutingHost();

		await openTab(host, 'tab-antigravity-survivor', 'antigravity');
		const antigravitySession = host.getActiveSession(
			'tab-antigravity-survivor',
		);
		const antigravityHandle = latestHandle(ptyAdapter);
		await openTab(host, 'tab-claude-closing', 'claude');
		const claudeHandle = latestHandle(ptyAdapter);
		assert.ok(antigravitySession !== undefined);

		host.closeTab('tab-claude-closing');
		await Promise.resolve();

		assert.strictEqual(claudeHandle.killCallCount, 1);
		assert.strictEqual(antigravityHandle.killCallCount, 0);
		assert.strictEqual(
			host.getActiveSession('tab-antigravity-survivor'),
			antigravitySession,
		);
		assert.strictEqual(antigravitySession.state.kind, 'running');
		assert.deepStrictEqual(antigravityHandle.writes, ['agy\r']);
	});

	test('다른 탭이나 종료된 세션의 input, resize와 restart를 거부한다', async () => {
		const { host, ptyAdapter, messages } = createRoutingHost();

		await openTab(host, 'tab-owner', 'codex');
		await openTab(host, 'tab-other', 'codex');
		const ownerSession = host.getActiveSession('tab-owner');
		assert.ok(ownerSession !== undefined);
		const ownerHandle = ptyAdapter.handles[0];
		const writesBefore = ownerHandle.writes.length;

		/* 다른 탭이 소유 세션 식별자를 지정해도 PTY에 전달하지 않는다. */
		host.routeInput({
			type: 'terminal.input',
			tabId: 'tab-other',
			sessionId: ownerSession.sessionId,
			data: 'x',
		});
		host.routeResize({
			type: 'terminal.resize',
			tabId: 'tab-other',
			sessionId: ownerSession.sessionId,
			cols: 10,
			rows: 10,
		});

		assert.strictEqual(ownerHandle.writes.length, writesBefore);
		assert.strictEqual(ownerHandle.resizes.length, 0);

		host.closeTab('tab-owner');
		messages.length = 0;
		host.routeInput({
			type: 'terminal.input',
			tabId: 'tab-owner',
			sessionId: ownerSession.sessionId,
			data: 'x',
		});
		await host.restartSession('tab-owner', ownerSession.sessionId);

		assert.strictEqual(ownerHandle.writes.length, writesBefore);
		const errors = messagesOfType(messages, 'terminal.error');
		assert.strictEqual(errors.length, 1);
		assert.strictEqual(errors[0].code, 'session_not_found');
	});

	test('등록되지 않은 탭의 준비와 provider 지정을 거부한다', async () => {
		const { host, ptyAdapter, messages } = createRoutingHost();

		await host.handleTerminalReady('tab-unregistered', 80, 24);
		await host.switchAgent('tab-unregistered', 'codex');

		assert.strictEqual(ptyAdapter.spawnCalls.length, 0);
		const errors = messagesOfType(messages, 'terminal.error');
		assert.strictEqual(errors.length, 2);
		assert.strictEqual(
			errors.every((error) => error.code === 'session_not_found'),
			true,
		);
	});

	test('탭을 닫으면 기존 정리 경로로 세션과 탭 등록을 함께 해제한다', async () => {
		const { host, ptyAdapter } = createRoutingHost();

		await openTab(host, 'tab-closing', 'codex');
		const handle = latestHandle(ptyAdapter);
		const session = host.getActiveSession('tab-closing');
		assert.ok(session !== undefined);

		host.closeTab('tab-closing');
		await Promise.resolve();

		assert.strictEqual(handle.killCallCount, 1);
		assert.strictEqual(handle.dataListenerCount, 0);
		assert.strictEqual(handle.exitListenerCount, 0);
		assert.strictEqual(session.state.kind, 'disposed');
		assert.strictEqual(host.hasTab('tab-closing'), false);
		assert.strictEqual(host.getTabProvider('tab-closing'), undefined);
		assert.strictEqual(host.getActiveSession('tab-closing'), undefined);

		/* 이미 닫힌 탭에 대한 반복 호출도 안전해야 한다. */
		host.closeTab('tab-closing');
		assert.strictEqual(handle.killCallCount, 1);
	});

	test('Host dispose는 열려 있는 모든 탭의 세션을 함께 정리한다', async () => {
		const { host, ptyAdapter } = createRoutingHost();

		await openTab(host, 'tab-dispose-one', 'codex');
		await openTab(host, 'tab-dispose-two', 'claude');

		host.dispose();

		assert.strictEqual(ptyAdapter.handles.length, 2);
		for (const handle of ptyAdapter.handles) {
			assert.strictEqual(handle.killCallCount, 1);
			assert.strictEqual(handle.dataListenerCount, 0);
			assert.strictEqual(handle.exitListenerCount, 0);
		}
		assert.strictEqual(host.hasTab('tab-dispose-one'), false);
		assert.strictEqual(host.getActiveSession('tab-dispose-two'), undefined);
		assert.strictEqual(host.getActiveTabId(), undefined);
	});
});
