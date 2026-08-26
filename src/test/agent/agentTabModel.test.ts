import * as assert from 'assert';
import { UNSELECTED_TAB_LABEL } from '../../agent/UI/agentProviders';
import {
	createAgentTabModel,
	type AgentTabModel,
	type AgentTabModelSnapshot,
} from '../../agent/UI/agentTabModel';

/**
 * 결정적인 식별자를 부여하는 탭 상태를 만든다.
 *
 * @returns 순번 기반 식별자를 사용하는 탭 상태
 */
function createModel(): AgentTabModel {
	let counter = 0;
	return createAgentTabModel(() => `tab-${++counter}`);
}

suite('Agent Tab Model', () => {
	test('새 탭은 provider 미선택 상태로 만들어지고 활성 탭이 된다', () => {
		const model = createModel();

		const firstTabId = model.createTab();
		const secondTabId = model.createTab();

		const snapshot = model.getSnapshot();
		assert.strictEqual(snapshot.tabs.length, 2);
		assert.strictEqual(snapshot.activeTabId, secondTabId);
		assert.strictEqual(snapshot.tabs[0].id, firstTabId);
		assert.strictEqual(snapshot.tabs[0].providerId, undefined);
		assert.strictEqual(snapshot.tabs[0].sequence, undefined);
		assert.strictEqual(snapshot.tabs[0].label, UNSELECTED_TAB_LABEL);
		assert.strictEqual(snapshot.tabs[0].displayName, UNSELECTED_TAB_LABEL);
		assert.strictEqual(snapshot.tabs[0].baseLabel, undefined);
		assert.strictEqual(snapshot.tabs[0].titleSource, 'default');
		assert.strictEqual(snapshot.tabs[0].autoTitleAttempted, false);
		assert.strictEqual(snapshot.tabs[0].hasStartedSession, false);
		assert.strictEqual(snapshot.tabs[0].isPinned, false);
		assert.deepStrictEqual(snapshot.tabs[0].mcpStatus, { kind: 'none' });
		assert.strictEqual(snapshot.tabs[0].mcpRestartPending, false);
	});

	test('MCP status는 current session에만 적용되고 connected/clear가 pending을 제거한다', () => {
		const model = createModel();
		const first = model.createTab();
		const second = model.createTab();
		model.assignProvider(first, 'codex');
		model.assignProvider(second, 'codex');
		model.setSession(first, 'session-first');
		model.setSession(second, 'session-second');

		model.setMcpStatus(first, 'session-old', { kind: 'connected' });
		model.setMcpStatus(first, 'session-first', {
			kind: 'failed',
			reason: 'adapter_exited',
			message: 'safe failure',
			retryable: true,
		});
		model.setMcpRestartPending(first, 'session-first', true);

		let snapshot = model.getSnapshot();
		assert.deepStrictEqual(snapshot.tabs[0].mcpStatus, {
			kind: 'failed',
			reason: 'adapter_exited',
			message: 'safe failure',
			retryable: true,
		});
		assert.strictEqual(snapshot.tabs[0].mcpRestartPending, true);
		assert.deepStrictEqual(snapshot.tabs[1].mcpStatus, { kind: 'none' });

		model.clearMcpStatus(first, 'session-old');
		assert.strictEqual(model.getSnapshot().tabs[0].mcpRestartPending, true);
		model.setMcpStatus(first, 'session-first', { kind: 'connected' });
		assert.deepStrictEqual(
			model.getSnapshot().tabs[0].mcpStatus,
			{ kind: 'connected' },
		);
		assert.strictEqual(model.getSnapshot().tabs[0].mcpRestartPending, false);

		model.setMcpStatus(first, 'session-first', {
			kind: 'failed',
			reason: 'adapter_exited',
			message: 'safe failure',
			retryable: true,
		});
		model.setMcpRestartPending(first, 'session-first', true);
		model.clearMcpStatus(first, 'session-first');
		snapshot = model.getSnapshot();
		assert.deepStrictEqual(snapshot.tabs[0].mcpStatus, { kind: 'none' });
		assert.strictEqual(snapshot.tabs[0].mcpRestartPending, false);
	});

	test('fresh session과 normal exit는 이전 session 표시를 격리한다', () => {
		const model = createModel();
		const tabId = model.createTab();
		model.assignProvider(tabId, 'codex');
		model.setSession(tabId, 'session-old');
		model.setMcpStatus(tabId, 'session-old', { kind: 'connected' });

		model.setSession(tabId, 'session-new');
		model.clearSession(tabId, 'session-old');
		assert.strictEqual(model.getSnapshot().tabs[0].sessionId, 'session-new');
		assert.deepStrictEqual(model.getSnapshot().tabs[0].mcpStatus, { kind: 'none' });

		model.clearSession(tabId, 'session-new');
		assert.strictEqual(model.getSnapshot().tabs[0].sessionId, undefined);
	});

	test('provider를 배정하면 라벨이 Provider #번호 형식이 된다', () => {
		const model = createModel();
		const tabId = model.createTab();

		model.assignProvider(tabId, 'claude');

		const tab = model.getSnapshot().tabs[0];
		assert.strictEqual(tab.providerId, 'claude');
		assert.strictEqual(tab.sequence, 1);
		assert.strictEqual(tab.label, 'Claude Code #1');
		assert.strictEqual(tab.baseLabel, 'Claude Code #1');
		assert.strictEqual(tab.displayName, 'Claude Code #1');
	});

	test('첫 session 전 수동 이름은 유지하고 두 번째 fresh session에서 baseLabel로 초기화한다', () => {
		const model = createModel();
		const tabId = model.createTab();
		assert.deepStrictEqual(model.renameTab(tabId, '  사전 조사  '), {
			ok: true,
			value: '사전 조사',
		});
		model.assignProvider(tabId, 'codex');

		model.setSession(tabId, 'session-first');
		let tab = model.getSnapshot().tabs[0];
		assert.strictEqual(tab.displayName, '사전 조사');
		assert.strictEqual(tab.titleSource, 'manual');
		assert.strictEqual(tab.hasStartedSession, true);
		assert.strictEqual(
			model.canAttemptAutomaticTitle(tabId, 'session-first'),
			false,
		);

		model.setSession(tabId, 'session-second');
		tab = model.getSnapshot().tabs[0];
		assert.strictEqual(tab.displayName, 'Codex #1');
		assert.strictEqual(tab.titleSource, 'default');
		assert.strictEqual(tab.autoTitleAttempted, false);
	});

	test('자동 제목과 종료 상태는 유지하고 다른 fresh session에서 다시 초기화한다', () => {
		const model = createModel();
		const tabId = model.createTab();
		model.assignProvider(tabId, 'claude');
		model.setSession(tabId, 'session-first');
		assert.strictEqual(model.applyAutomaticTitleCandidates(
			tabId,
			'session-first',
			['fix-auth-timeout'],
		), true);
		model.clearSession(tabId, 'session-first');

		let tab = model.getSnapshot().tabs[0];
		assert.strictEqual(tab.displayName, 'fix-auth-timeout');
		assert.strictEqual(tab.titleSource, 'automatic');
		assert.strictEqual(tab.sessionId, undefined);

		model.setSession(tabId, 'session-first');
		assert.strictEqual(
			model.getSnapshot().tabs[0].displayName,
			'fix-auth-timeout',
			'이미 처리한 stale started는 fresh session이 아니다.',
		);
		model.setSession(tabId, 'session-second');
		tab = model.getSnapshot().tabs[0];
		assert.strictEqual(tab.displayName, 'Claude Code #1');
		assert.strictEqual(tab.titleSource, 'default');
		assert.strictEqual(tab.autoTitleAttempted, false);
	});

	test('자동 제목은 current Codex/Claude session에서 한 번만 시도한다', () => {
		const model = createModel();
		const codex = model.createTab();
		model.assignProvider(codex, 'codex');
		model.setSession(codex, 'session-codex');

		assert.strictEqual(model.applyAutomaticTitleCandidates(
			codex,
			'session-stale',
			['stale-title'],
		), false);
		assert.strictEqual(model.applyAutomaticTitleCandidates(
			codex,
			'session-codex',
			[],
		), false);
		assert.strictEqual(model.getSnapshot().tabs[0].autoTitleAttempted, true);
		assert.strictEqual(model.applyAutomaticTitleCandidates(
			codex,
			'session-codex',
			['later-title'],
		), false);
	});

	test('수동 이름은 공백, 대소문자, NFC 및 숨겨진 baseLabel 중복을 거부한다', () => {
		const model = createModel();
		const first = model.createTab();
		const second = model.createTab();
		model.assignProvider(first, 'codex');
		assert.deepStrictEqual(model.renameTab(first, 'Cafe\u0301  Build'), {
			ok: true,
			value: 'Café Build',
		});

		assert.deepStrictEqual(model.renameTab(second, ' café   build '), {
			ok: false,
			error: 'duplicate',
		});
		assert.deepStrictEqual(model.renameTab(second, 'CODEX #1'), {
			ok: false,
			error: 'duplicate',
		});
		assert.deepStrictEqual(model.renameTab(first, 'codex #1'), {
			ok: true,
			value: 'codex #1',
		});
	});

	test('미리 사용한 표시 이름과 충돌하는 provider 번호를 건너뛴다', () => {
		const model = createModel();
		const reservedByDisplay = model.createTab();
		model.renameTab(reservedByDisplay, 'Codex #3');

		const first = model.createTab();
		const second = model.createTab();
		const third = model.createTab();
		model.assignProvider(first, 'codex');
		model.assignProvider(second, 'codex');
		model.assignProvider(third, 'codex');

		assert.deepStrictEqual(
			model.getSnapshot().tabs.slice(1).map((tab) => tab.baseLabel),
			['Codex #1', 'Codex #2', 'Codex #4'],
		);
	});

	test('중복 자동 제목은 12자 suffix로 구분하고 잘못된 후보는 baseLabel을 유지한다', () => {
		const model = createModel();
		const first = model.createTab();
		model.renameTab(first, 'fix-auth-timeout');
		const second = model.createTab();
		model.assignProvider(second, 'codex');
		model.setSession(second, 'session');

		assert.strictEqual(model.applyAutomaticTitleCandidates(
			second,
			'session',
			['fix-auth-timeout', 'fix-auth-task'],
		), true);
		assert.strictEqual(model.getSnapshot().tabs[1].displayName, 'fix-auth-…·2');
		assert.strictEqual(model.getSnapshot().tabs[1].autoTitleAttempted, true);

		model.setSession(second, 'session-fresh');
		assert.strictEqual(model.applyAutomaticTitleCandidates(
			second,
			'session-fresh',
			['a'.repeat(41)],
		), false);
		assert.strictEqual(model.getSnapshot().tabs[1].displayName, 'Codex #1');
		assert.strictEqual(model.getSnapshot().tabs[1].autoTitleAttempted, true);
	});

	test('고정과 해제는 그룹 끝으로 이동하고 활성 탭을 바꾸지 않는다', () => {
		const model = createModel();
		const first = model.createTab();
		const second = model.createTab();
		const third = model.createTab();
		model.selectTab(second);

		model.setPinned(third, true);
		model.setPinned(first, true);
		assert.deepStrictEqual(
			model.getSnapshot().tabs.map((tab) => tab.id),
			[third, first, second],
		);
		assert.strictEqual(model.getSnapshot().activeTabId, second);

		model.setPinned(third, false);
		assert.deepStrictEqual(
			model.getSnapshot().tabs.map((tab) => tab.id),
			[first, second, third],
		);
		assert.strictEqual(model.getSnapshot().activeTabId, second);
	});

	test('provider 초기화와 fresh session에서도 고정 상태를 유지한다', () => {
		const model = createModel();
		const tabId = model.createTab();
		model.assignProvider(tabId, 'codex');
		model.setPinned(tabId, true);
		model.setSession(tabId, 'session');
		model.clearProvider(tabId);

		let tab = model.getSnapshot().tabs[0];
		assert.strictEqual(tab.displayName, UNSELECTED_TAB_LABEL);
		assert.strictEqual(tab.hasStartedSession, false);
		assert.strictEqual(tab.isPinned, true);
		model.assignProvider(tabId, 'codex');
		tab = model.getSnapshot().tabs[0];
		assert.strictEqual(tab.baseLabel, 'Codex #2');
		assert.strictEqual(tab.isPinned, true);
	});

	test('번호는 같은 provider 안에서만 순차 증가한다', () => {
		const model = createModel();
		const first = model.createTab();
		const second = model.createTab();
		const third = model.createTab();

		model.assignProvider(first, 'codex');
		model.assignProvider(second, 'claude');
		model.assignProvider(third, 'codex');

		const labels = model.getSnapshot().tabs.map((tab) => tab.label);
		assert.deepStrictEqual(labels, ['Codex #1', 'Claude Code #1', 'Codex #2']);
	});

	test('같은 provider를 다시 배정해도 번호를 다시 매기지 않는다', () => {
		const model = createModel();
		const tabId = model.createTab();

		model.assignProvider(tabId, 'codex');
		model.assignProvider(tabId, 'codex');
		const secondTabId = model.createTab();
		model.assignProvider(secondTabId, 'codex');

		const labels = model.getSnapshot().tabs.map((tab) => tab.label);
		assert.deepStrictEqual(labels, ['Codex #1', 'Codex #2']);
	});

	test('provider 배정을 지우면 같은 탭이 미선택 상태로 돌아간다', () => {
		const model = createModel();
		const tabId = model.createTab();

		model.assignProvider(tabId, 'codex');
		model.clearProvider(tabId);

		const tab = model.getSnapshot().tabs[0];
		assert.strictEqual(tab.id, tabId);
		assert.strictEqual(tab.providerId, undefined);
		assert.strictEqual(tab.sequence, undefined);
		assert.strictEqual(tab.label, UNSELECTED_TAB_LABEL);
	});

	test('탭을 닫아도 이미 사용한 번호를 재사용하지 않는다', () => {
		const model = createModel();
		const first = model.createTab();
		model.assignProvider(first, 'codex');

		model.closeTab(first);
		const second = model.createTab();
		model.assignProvider(second, 'codex');

		assert.strictEqual(model.getSnapshot().tabs[0].label, 'Codex #2');
	});

	test('탭 전환은 존재하는 탭에 대해서만 활성 탭을 바꾼다', () => {
		const model = createModel();
		const first = model.createTab();
		model.createTab();

		model.selectTab(first);
		assert.strictEqual(model.getSnapshot().activeTabId, first);

		model.selectTab('tab-does-not-exist');
		assert.strictEqual(model.getSnapshot().activeTabId, first);
	});

	test('활성 탭을 닫으면 다음 탭이, 마지막 탭이면 이전 탭이 활성화된다', () => {
		const model = createModel();
		const first = model.createTab();
		const second = model.createTab();
		const third = model.createTab();

		model.selectTab(second);
		model.closeTab(second);
		assert.strictEqual(model.getSnapshot().activeTabId, third);

		model.closeTab(third);
		assert.strictEqual(model.getSnapshot().activeTabId, first);

		model.closeTab(first);
		assert.strictEqual(model.getSnapshot().activeTabId, undefined);
		assert.strictEqual(model.getSnapshot().tabs.length, 0);
	});

	test('활성이 아닌 탭을 닫아도 활성 탭은 유지된다', () => {
		const model = createModel();
		const first = model.createTab();
		const second = model.createTab();

		model.closeTab(first);

		assert.strictEqual(model.getSnapshot().activeTabId, second);
		assert.strictEqual(model.getSnapshot().tabs.length, 1);
	});

	test('snapshot은 frozen이며 구독자는 해제 이후 호출되지 않는다', () => {
		const model = createModel();
		const received: AgentTabModelSnapshot[] = [];
		const unsubscribe = model.subscribe((snapshot) => {
			received.push(snapshot);
		});

		model.createTab();
		assert.strictEqual(received.length, 1);
		assert.strictEqual(Object.isFrozen(received[0]), true);
		assert.strictEqual(Object.isFrozen(received[0].tabs), true);

		unsubscribe();
		model.createTab();
		assert.strictEqual(received.length, 1);
	});

	test('한 구독자의 실패가 다른 구독자 통지를 막지 않는다', () => {
		const model = createModel();
		let notifiedCount = 0;

		model.subscribe(() => {
			throw new Error('subscriber failure');
		});
		model.subscribe(() => {
			notifiedCount += 1;
		});

		model.createTab();

		assert.strictEqual(notifiedCount, 1);
	});
});
