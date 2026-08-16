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

/** Codex 탭이 시작될 때 Host가 Shell에 보내는 자동 실행 입력이다. */
const codexAutoRunInput = resolveAgentAutoRunInput('codex');

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
	test('Codex 자동 실행은 Windows에서 codex.cmd를 선택해 PowerShell policy를 요구하지 않는다', () => {
		assert.strictEqual(resolveAgentAutoRunInput('codex', 'win32'), 'codex.cmd\r');
		assert.strictEqual(resolveAgentAutoRunInput('codex', 'darwin'), 'codex\r');
		assert.strictEqual(resolveAgentAutoRunInput('codex', 'linux'), 'codex\r');
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

	test('Codex를 선택하면 세션을 시작하고 Codex CLI를 자동으로 실행한다', async () => {
		const { host, ptyAdapter, messages } = createRoutingHost();

		await openTab(host, 'tab-codex', 'codex');

		assert.strictEqual(ptyAdapter.spawnCalls.length, 1);
		assert.strictEqual(messagesOfType(messages, 'terminal.started').length, 1);
		const handle = latestHandle(ptyAdapter);
		assert.strictEqual(handle.writes.length, 1);
		assert.strictEqual(handle.writes[0] === codexAutoRunInput, true);
	});

	test('Windows delayed PID 동안 started와 Codex 입력을 보류한다', async () => {
		const { host, ptyAdapter, messages } = createRoutingHost(0);
		host.createTab('tab-delayed-codex');
		await host.handleTerminalReady('tab-delayed-codex', 80, 24);

		const switching = host.switchAgent('tab-delayed-codex', 'codex');
		await Promise.resolve();
		const handle = latestHandle(ptyAdapter);
		assert.deepStrictEqual(
			host.getActiveSession('tab-delayed-codex')?.state,
			{ kind: 'starting' },
		);
		assert.strictEqual(messagesOfType(messages, 'terminal.started').length, 0);
		assert.deepStrictEqual(handle.writes, []);

		handle.setReadyPid(4301);
		await switching;

		assert.deepStrictEqual(
			host.getActiveSession('tab-delayed-codex')?.state,
			{ kind: 'running', pid: 4301 },
		);
		assert.strictEqual(messagesOfType(messages, 'terminal.started').length, 1);
		assert.deepStrictEqual(handle.writes, [codexAutoRunInput]);
	});

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

	test('실행 중 탭에서 Codex를 다시 고르면 기존 세션을 종료하고 다시 자동 실행한다', async () => {
		const { host, ptyAdapter, messages } = createRoutingHost();

		await openTab(host, 'tab-restart-codex', 'codex');
		const firstHandle = latestHandle(ptyAdapter);
		const firstSessionId = host.getActiveSession('tab-restart-codex')?.sessionId;

		await host.switchAgent('tab-restart-codex', 'codex');

		assert.strictEqual(firstHandle.killCallCount, 1);
		assert.strictEqual(firstHandle.dataListenerCount, 0);
		assert.strictEqual(firstHandle.exitListenerCount, 0);
		assert.strictEqual(ptyAdapter.spawnCalls.length, 2);

		const secondSessionId = host.getActiveSession('tab-restart-codex')?.sessionId;
		assert.strictEqual(typeof secondSessionId, 'string');
		assert.strictEqual(secondSessionId === firstSessionId, false);
		assert.strictEqual(latestHandle(ptyAdapter).writes.length, 1);
		assert.strictEqual(
			latestHandle(ptyAdapter).writes[0] === codexAutoRunInput,
			true,
		);
		assert.strictEqual(messagesOfType(messages, 'terminal.started').length, 2);
	});

	test('덮개 재시작 요청도 같은 provider의 자동 실행 상태로 되돌린다', async () => {
		const { host, ptyAdapter } = createRoutingHost();

		await openTab(host, 'tab-overlay-restart', 'codex');
		const session = host.getActiveSession('tab-overlay-restart');
		assert.ok(session !== undefined);
		latestHandle(ptyAdapter).emitExit({ exitCode: 0 });

		await host.restartSession('tab-overlay-restart', session.sessionId);

		assert.strictEqual(ptyAdapter.spawnCalls.length, 2);
		assert.strictEqual(
			latestHandle(ptyAdapter).writes[0] === codexAutoRunInput,
			true,
		);
	});

	test('Claude와 Antigravity는 세션만 시작하고 CLI를 자동 실행하지 않는다', async () => {
		for (const providerId of ['claude', 'antigravity'] as const) {
			const { host, ptyAdapter } = createRoutingHost();

			await openTab(host, `tab-${providerId}`, providerId);

			assert.strictEqual(ptyAdapter.spawnCalls.length, 1);
			assert.strictEqual(latestHandle(ptyAdapter).writes.length, 0);
		}
	});

	test('여러 탭의 세션이 독립적으로 유지되고 입출력이 섞이지 않는다', async () => {
		const { host, ptyAdapter, messages } = createRoutingHost();

		await openTab(host, 'tab-one', 'codex');
		const firstSession = host.getActiveSession('tab-one');
		const firstHandle = latestHandle(ptyAdapter);

		await openTab(host, 'tab-two', 'claude');
		const secondSession = host.getActiveSession('tab-two');
		const secondHandle = latestHandle(ptyAdapter);

		assert.ok(firstSession !== undefined && secondSession !== undefined);
		assert.strictEqual(firstSession === secondSession, false);
		assert.strictEqual(firstSession.state.kind, 'running');
		assert.strictEqual(secondSession.state.kind, 'running');

		host.routeInput({
			type: 'terminal.input',
			tabId: 'tab-two',
			sessionId: secondSession.sessionId,
			data: 'x',
		});

		/* 첫 탭에는 자동 실행 입력만 남고 두 번째 탭 입력이 섞이지 않아야 한다. */
		assert.strictEqual(firstHandle.writes.length, 1);
		assert.strictEqual(secondHandle.writes.length, 1);

		messages.length = 0;
		secondHandle.emitData('output');
		await Promise.resolve();

		const outputs = messagesOfType(messages, 'terminal.output');
		assert.strictEqual(outputs.length, 1);
		assert.strictEqual(outputs[0].tabId, 'tab-two');
		assert.strictEqual(outputs[0].sessionId, secondSession.sessionId);
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
