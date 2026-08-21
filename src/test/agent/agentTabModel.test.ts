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
		assert.deepStrictEqual(snapshot.tabs[0].mcpStatus, { kind: 'none' });
		assert.strictEqual(snapshot.tabs[0].mcpRestartPending, false);
	});

	test('MCP status는 정확한 current tab/session에만 적용되고 clear가 pending도 제거한다', () => {
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
	});

	test('번호는 같은 provider 안에서만 순차 증가한다', () => {
		const model = createModel();
		const first = model.createTab();
		const second = model.createTab();
		const third = model.createTab();

		model.assignProvider(first, 'codex');
		model.assignProvider(second, 'antigravity');
		model.assignProvider(third, 'codex');

		const labels = model.getSnapshot().tabs.map((tab) => tab.label);
		assert.deepStrictEqual(labels, ['Codex #1', 'Antigravity #1', 'Codex #2']);
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
