import * as assert from 'assert';
import type { AgentConfirmDialog } from '../../agent/UI/agentConfirmDialog';
import {
	initializeAgentPanelUi,
	type AgentPanelUiCallbacks,
	type AgentPanelUiController,
	type AgentPanelUiDependencies,
} from '../../agent/UI/agentPanelUi';
import { UNSELECTED_TAB_LABEL } from '../../agent/UI/agentProviders';
import { PROVIDER_IDS } from '../../agent/protocol';
import {
	FakeAgentElement,
	FakeDocumentEvents,
	createFakeAgentUiDependencies,
	flushMicrotasks,
} from './support/fakeAgentUiDom';

/** 확인 요청을 기록하고 응답 시점을 테스트가 정하는 확인 다이얼로그 대역이다. */
class FakeConfirmDialog implements AgentConfirmDialog {
	readonly requests: Array<{ message: string; acceptLabel?: string }> = [];
	disposeCount = 0;

	private pending: ((confirmed: boolean) => void) | undefined;

	confirm(message: string, acceptLabel?: string): Promise<boolean> {
		this.requests.push({ message, acceptLabel });
		return new Promise<boolean>((resolve) => {
			this.pending = resolve;
		});
	}

	dispose(): void {
		this.disposeCount += 1;
		this.pending?.(false);
		this.pending = undefined;
	}

	/** 대기 중인 확인 요청에 사용자의 선택을 전달한다. */
	answer(confirmed: boolean): void {
		const resolve = this.pending;
		this.pending = undefined;
		resolve?.(confirmed);
	}
}

interface PanelFixture {
	readonly topBar: FakeAgentElement;
	readonly tabStrip: FakeAgentElement;
	readonly tabMenuHost: FakeAgentElement;
	readonly providerPicker: FakeAgentElement;
	readonly dialogHost: FakeAgentElement;
	readonly renameDialogHost: FakeAgentElement;
	readonly dialog: FakeConfirmDialog;
	readonly documentEvents: FakeDocumentEvents;
	readonly controller: AgentPanelUiController;
}

/** Agent UI를 DOM 대역 위에서 초기화한다. */
function createFixture(callbacks: AgentPanelUiCallbacks = {}): PanelFixture {
	const topBar = new FakeAgentElement();
	const tabStrip = new FakeAgentElement();
	const tabMenuHost = new FakeAgentElement();
	const providerPicker = new FakeAgentElement();
	const dialogHost = new FakeAgentElement();
	const renameDialogHost = new FakeAgentElement();
	const dialog = new FakeConfirmDialog();
	const documentEvents = new FakeDocumentEvents();
	const dependencies: AgentPanelUiDependencies = {
		...createFakeAgentUiDependencies(documentEvents),
		createConfirmDialog: () => dialog,
	};

	const controller = initializeAgentPanelUi(
		{
			topBar: topBar.asHtmlElement(),
			tabStrip: tabStrip.asHtmlElement(),
			tabMenuHost: tabMenuHost.asHtmlElement(),
			providerPicker: providerPicker.asHtmlElement(),
			dialogHost: dialogHost.asHtmlElement(),
			renameDialogHost: renameDialogHost.asHtmlElement(),
		},
		callbacks,
		dependencies,
	);

	return {
		topBar,
		tabStrip,
		tabMenuHost,
		providerPicker,
		dialogHost,
		renameDialogHost,
		dialog,
		documentEvents,
		controller,
	};
}

/** 지정한 class를 가진 요소를 찾고 없으면 테스트를 실패시킨다. */
function requireElement(
	root: FakeAgentElement,
	className: string,
): FakeAgentElement {
	const element = root.find(className);
	assert.strictEqual(element !== undefined, true);
	return element as FakeAgentElement;
}

/** 중앙 목록에서 provider 하나를 고른다. */
function selectProvider(
	providerPicker: FakeAgentElement,
	providerId: string,
): void {
	const option = providerPicker
		.findAll('agent-provider-option')
		.find((element) => element.dataset.providerId === providerId);
	assert.strictEqual(option !== undefined, true);
	option?.click();
}

/** 현재 탭 strip에 표시된 라벨 목록을 반환한다. */
function readTabLabels(tabStrip: FakeAgentElement): string[] {
	return tabStrip
		.findAll('agent-tab-select')
		.map((element) => element.textContent);
}

suite('Agent Panel UI', () => {
	test('미선택 탭은 xterm 중앙에 세 provider를 세로 목록으로 표시한다', () => {
		const fixture = createFixture();
		const options = fixture.providerPicker.findAll('agent-provider-option');

		assert.strictEqual(fixture.providerPicker.hidden, false);
		assert.strictEqual(
			requireElement(fixture.providerPicker, 'agent-provider-picker-title').textContent,
			'Choose an agent',
		);
		assert.strictEqual(
			requireElement(
				fixture.providerPicker,
				'agent-provider-picker-description',
			).textContent,
			'Select a CLI to start this terminal',
		);
		assert.deepStrictEqual(
			options.map((option) => option.dataset.providerId),
			[...PROVIDER_IDS],
		);
		assert.deepStrictEqual(
			fixture.providerPicker
				.findAll('agent-provider-option-label')
				.map((label) => label.textContent),
			['Codex', 'Claude Code', 'Antigravity'],
		);
		assert.deepStrictEqual(
			fixture.providerPicker
				.findAll('agent-provider-mark')
				.map((mark) => mark.textContent),
			['>_', '>_', '>_'],
		);
		assert.strictEqual(
			fixture.providerPicker.find('agent-provider-picker-hints'),
			undefined,
		);
	});

	test('provider는 초기 포커스와 방향키 탐색 없이 직접 선택한다', () => {
		const fixture = createFixture();
		const list = requireElement(fixture.providerPicker, 'agent-provider-list');
		const options = fixture.providerPicker.findAll('agent-provider-option');
		let prevented = false;

		list.dispatch('keydown', {
			key: 'ArrowDown',
			preventDefault: () => prevented = true,
		});

		assert.strictEqual(prevented, false);
		assert.deepStrictEqual(options.map((option) => option.dataset.focused), [
			undefined,
			undefined,
			undefined,
		]);
		assert.deepStrictEqual(options.map((option) => option.focusCount), [0, 0, 0]);
	});

	test('provider 선택은 탭에 배정한 뒤 중앙 선택기를 숨긴다', () => {
		const selections: Array<{ tabId: string; providerId: string }> = [];
		const fixture = createFixture({
			onProviderSelected: (tabId, providerId) =>
				selections.push({ tabId, providerId }),
		});

		selectProvider(fixture.providerPicker, 'claude');

		const tab = fixture.controller.getSnapshot().tabs[0];
		assert.strictEqual(fixture.providerPicker.hidden, true);
		assert.strictEqual(tab.providerId, 'claude');
		assert.strictEqual(tab.label, 'Claude Code #1');
		assert.deepStrictEqual(selections, [{ tabId: tab.id, providerId: 'claude' }]);
	});

	test('+ 버튼은 미선택 탭과 선택기를 다시 표시한다', () => {
		const createdTabIds: string[] = [];
		const fixture = createFixture({
			onTabCreated: (tabId) => createdTabIds.push(tabId),
		});

		selectProvider(fixture.providerPicker, 'codex');
		requireElement(fixture.topBar, 'agent-create-tab').click();

		const snapshot = fixture.controller.getSnapshot();
		assert.strictEqual(snapshot.tabs.length, 2);
		assert.strictEqual(snapshot.tabs[1].providerId, undefined);
		assert.strictEqual(snapshot.activeTabId, snapshot.tabs[1].id);
		assert.strictEqual(fixture.providerPicker.hidden, false);
		assert.deepStrictEqual(readTabLabels(fixture.tabStrip), [
			'Codex #1',
			UNSELECTED_TAB_LABEL,
		]);
		assert.strictEqual(createdTabIds.length, 2);
	});

	test('탭 전환은 활성 탭의 미선택 상태에 맞게 선택기를 바꾼다', () => {
		const fixture = createFixture();

		selectProvider(fixture.providerPicker, 'codex');
		requireElement(fixture.topBar, 'agent-create-tab').click();
		assert.strictEqual(fixture.providerPicker.hidden, false);

		fixture.tabStrip.findAll('agent-tab-select')[0].click();
		assert.strictEqual(fixture.providerPicker.hidden, true);

		fixture.tabStrip.findAll('agent-tab-select')[1].click();
		assert.strictEqual(fixture.providerPicker.hidden, false);
	});

	test('재시작은 확인 후 현재 CLI를 정리하고 Agent 선택 화면으로 돌아간다', async () => {
		const reselections: string[] = [];
		const providerSelections: string[] = [];
		const fixture = createFixture({
			onProviderSelected: (_tabId, providerId) =>
				providerSelections.push(providerId),
			onAgentReselectionRequested: (tabId) => reselections.push(tabId),
		});

		selectProvider(fixture.providerPicker, 'codex');
		requireElement(fixture.topBar, 'agent-restart-session').click();

		const tab = fixture.controller.getSnapshot().tabs[0];
		assert.deepStrictEqual(fixture.dialog.requests, [{
			message: "Restart Codex #1? The current CLI session will be terminated and you'll return to agent selection.",
			acceptLabel: 'Restart',
		}]);
		assert.deepStrictEqual(reselections, []);

		fixture.dialog.answer(true);
		await flushMicrotasks();

		assert.deepStrictEqual(reselections, [tab.id]);
		assert.deepStrictEqual(providerSelections, ['codex']);
		assert.strictEqual(fixture.providerPicker.hidden, false);
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, undefined);
		assert.strictEqual(
			fixture.controller.getSnapshot().tabs[0].label,
			UNSELECTED_TAB_LABEL,
		);
	});

	test('재시작 확인을 취소하면 현재 세션을 유지한다', async () => {
		const restarts: string[] = [];
		const fixture = createFixture({
			onAgentReselectionRequested: (tabId) => restarts.push(tabId),
		});

		selectProvider(fixture.providerPicker, 'antigravity');
		requireElement(fixture.topBar, 'agent-restart-session').click();
		fixture.dialog.answer(false);
		await flushMicrotasks();

		assert.deepStrictEqual(restarts, []);
		assert.strictEqual(fixture.providerPicker.hidden, true);
		assert.strictEqual(
			fixture.controller.getSnapshot().tabs[0].providerId,
			'antigravity',
		);
	});

	test('provider 미선택 탭에서는 재시작 버튼이 비활성이다', () => {
		const fixture = createFixture();
		const restartButton = requireElement(fixture.topBar, 'agent-restart-session');

		assert.strictEqual(restartButton.disabled, true);
		restartButton.click();
		assert.deepStrictEqual(fixture.dialog.requests, []);
	});

	test('탭 닫기는 확인을 요청하고 취소하면 탭을 유지한다', async () => {
		const closed: string[] = [];
		const fixture = createFixture({ onTabClosed: (tabId) => closed.push(tabId) });

		selectProvider(fixture.providerPicker, 'codex');
		requireElement(fixture.tabStrip, 'agent-tab-close').click();
		fixture.dialog.answer(false);
		await flushMicrotasks();

		assert.deepStrictEqual(fixture.dialog.requests, [{
			message: 'Close Codex #1?',
			acceptLabel: undefined,
		}]);
		assert.strictEqual(fixture.controller.getSnapshot().tabs.length, 1);
		assert.deepStrictEqual(closed, []);
	});

	test('확인을 수락하면 탭을 닫고 다음 미선택 탭의 선택기를 표시한다', async () => {
		const closed: string[] = [];
		const fixture = createFixture({ onTabClosed: (tabId) => closed.push(tabId) });

		selectProvider(fixture.providerPicker, 'codex');
		const [firstTab] = fixture.controller.getSnapshot().tabs;
		requireElement(fixture.topBar, 'agent-create-tab').click();

		fixture.tabStrip.findAll('agent-tab-close')[0].click();
		fixture.dialog.answer(true);
		await flushMicrotasks();

		assert.deepStrictEqual(closed, [firstTab.id]);
		assert.deepStrictEqual(readTabLabels(fixture.tabStrip), [UNSELECTED_TAB_LABEL]);
		assert.strictEqual(fixture.providerPicker.hidden, false);
	});

	test('마지막 탭을 닫으면 선택기를 숨기고 재시작을 비활성화한다', async () => {
		const fixture = createFixture();

		requireElement(fixture.tabStrip, 'agent-tab-close').click();
		fixture.dialog.answer(true);
		await flushMicrotasks();

		assert.deepStrictEqual(readTabLabels(fixture.tabStrip), []);
		assert.strictEqual(fixture.providerPicker.hidden, true);
		assert.strictEqual(
			requireElement(fixture.topBar, 'agent-restart-session').disabled,
			true,
		);
	});

	test('MCP status는 current tab 우측 점으로 표시하고 retryable failure에만 재시작을 제공한다', () => {
		const fixture = createFixture();
		selectProvider(fixture.providerPicker, 'codex');
		const tabId = fixture.controller.getSnapshot().tabs[0].id;
		const failureDetail = requireElement(fixture.topBar, 'agent-mcp-status');
		const restart = requireElement(fixture.topBar, 'agent-mcp-restart');

		assert.strictEqual(failureDetail.hidden, true);
		assert.deepStrictEqual(fixture.tabStrip.findAll('agent-tab-mcp-indicator'), []);
		fixture.controller.handleHostMessage({
			type: 'terminal.started', tabId, sessionId: 'session-current',
		});
		fixture.controller.handleHostMessage({
			type: 'mcp.statusChanged',
			tabId,
			sessionId: 'session-stale',
			status: 'connected',
		});
		assert.deepStrictEqual(fixture.tabStrip.findAll('agent-tab-mcp-indicator'), []);

		fixture.controller.handleHostMessage({
			type: 'mcp.statusChanged',
			tabId,
			sessionId: 'session-current',
			status: 'connected',
		});
		const connected = requireElement(fixture.tabStrip, 'agent-tab-mcp-indicator');
		assert.strictEqual(connected.dataset.kind, 'connected');
		assert.strictEqual(connected.textContent, '');
		assert.strictEqual(connected.getAttribute('aria-label'), 'MCP 연결됨');
		assert.strictEqual(failureDetail.hidden, true);
		assert.strictEqual(restart.hidden, true);

		fixture.controller.handleHostMessage({
			type: 'mcp.statusChanged',
			tabId,
			sessionId: 'session-current',
			status: 'failed',
			reason: 'provider_config_rejected',
			retryable: false,
		});
		assert.strictEqual(
			requireElement(fixture.tabStrip, 'agent-tab-mcp-indicator').dataset.kind,
			'failed',
		);
		assert.strictEqual(failureDetail.hidden, false);
		assert.strictEqual(failureDetail.dataset.kind, 'failed');
		assert.strictEqual(failureDetail.getAttribute('role'), 'alert');
		assert.strictEqual(restart.hidden, true);

		fixture.controller.handleHostMessage({
			type: 'mcp.statusChanged',
			tabId,
			sessionId: 'session-current',
			status: 'failed',
			reason: 'adapter_exited',
			retryable: true,
		});
		assert.strictEqual(restart.hidden, false);
	});

	test('MCP restart 확인, Webview 연타 방어, 취소와 clear pending을 보장한다', async () => {
		const requests: Array<{ tabId: string; sessionId: string }> = [];
		const fixture = createFixture({
			onMcpRestartRequested: (tabId, sessionId) => {
				requests.push({ tabId, sessionId });
			},
		});
		selectProvider(fixture.providerPicker, 'codex');
		const tabId = fixture.controller.getSnapshot().tabs[0].id;
		fixture.controller.handleHostMessage({
			type: 'terminal.started', tabId, sessionId: 'session-retry',
		});
		fixture.controller.handleHostMessage({
			type: 'mcp.statusChanged',
			tabId,
			sessionId: 'session-retry',
			status: 'failed',
			reason: 'adapter_exited',
			retryable: true,
		});
		const restart = requireElement(fixture.topBar, 'agent-mcp-restart');

		restart.click();
		restart.click();
		assert.strictEqual(restart.disabled, true);
		assert.strictEqual(fixture.dialog.requests.length, 1);
		assert.deepStrictEqual(fixture.dialog.requests[0], {
			message: 'MCP와 Agent를 다시 시작하면 이 탭에서 실행 중인 Agent와 현재 CLI 대화가 종료됩니다. 새 MCP 연결과 새 Agent 세션으로 다시 시작하시겠습니까?',
			acceptLabel: 'MCP와 Agent 다시 시작',
		});

		fixture.dialog.answer(false);
		await flushMicrotasks();
		assert.strictEqual(restart.disabled, false);
		assert.deepStrictEqual(requests, []);

		restart.click();
		fixture.dialog.answer(true);
		await flushMicrotasks();
		assert.deepStrictEqual(requests, [{ tabId, sessionId: 'session-retry' }]);
		assert.strictEqual(restart.disabled, true);

		fixture.controller.handleHostMessage({
			type: 'mcp.statusCleared', tabId, sessionId: 'session-retry',
		});
		assert.strictEqual(
			requireElement(fixture.topBar, 'agent-mcp-status').hidden,
			true,
		);
		assert.deepStrictEqual(fixture.tabStrip.findAll('agent-tab-mcp-indicator'), []);
		assert.strictEqual(
			fixture.controller.getSnapshot().tabs[0].mcpRestartPending,
			false,
		);
	});

	test('여러 탭의 우측 점을 동시에 표시하고 old clear는 fresh session status를 바꾸지 않는다', () => {
		const fixture = createFixture();
		selectProvider(fixture.providerPicker, 'codex');
		const first = fixture.controller.getSnapshot().tabs[0].id;
		fixture.controller.handleHostMessage({
			type: 'terminal.started', tabId: first, sessionId: 'session-first',
		});
		fixture.controller.handleHostMessage({
			type: 'mcp.statusChanged',
			tabId: first,
			sessionId: 'session-first',
			status: 'connected',
		});

		requireElement(fixture.topBar, 'agent-create-tab').click();
		selectProvider(fixture.providerPicker, 'claude');
		const second = fixture.controller.getSnapshot().tabs[1].id;
		fixture.controller.handleHostMessage({
			type: 'terminal.started', tabId: second, sessionId: 'session-second',
		});
		fixture.controller.handleHostMessage({
			type: 'mcp.statusChanged',
			tabId: second,
			sessionId: 'session-second',
			status: 'connected',
		});
		assert.deepStrictEqual(
			fixture.tabStrip.findAll('agent-tab-mcp-indicator').map(
				(indicator) => indicator.parent?.dataset.tabId,
			),
			[first, second],
		);
		assert.strictEqual(requireElement(fixture.topBar, 'agent-mcp-status').hidden, true);
		fixture.tabStrip.findAll('agent-tab-select')[0].click();
		assert.strictEqual(requireElement(fixture.topBar, 'agent-mcp-status').hidden, true);

		fixture.controller.handleHostMessage({
			type: 'terminal.started', tabId: first, sessionId: 'session-fresh',
		});
		fixture.controller.handleHostMessage({
			type: 'mcp.statusChanged',
			tabId: first,
			sessionId: 'session-fresh',
			status: 'connected',
		});
		fixture.controller.handleHostMessage({
			type: 'mcp.statusCleared', tabId: first, sessionId: 'session-first',
		});
		assert.strictEqual(fixture.tabStrip.findAll('agent-tab-mcp-indicator').length, 2);
	});

	test('비활성 탭 우클릭은 활성 탭을 바꾸지 않고 접근 가능한 메뉴를 연다', () => {
		const fixture = createFixture();
		selectProvider(fixture.providerPicker, 'codex');
		const first = fixture.controller.getSnapshot().tabs[0].id;
		requireElement(fixture.topBar, 'agent-create-tab').click();
		const second = fixture.controller.getSnapshot().tabs[1].id;
		let prevented = false;

		fixture.tabStrip.findAll('agent-tab')[0].dispatch('contextmenu', {
			clientX: 20,
			clientY: 18,
			preventDefault: () => prevented = true,
		});

		assert.strictEqual(prevented, true);
		assert.strictEqual(fixture.controller.getSnapshot().activeTabId, second);
		assert.strictEqual(fixture.tabMenuHost.hidden, false);
		const menu = requireElement(fixture.tabMenuHost, 'agent-tab-context-menu');
		assert.strictEqual(menu.getAttribute('role'), 'menu');
		assert.strictEqual(menu.getAttribute('aria-label'), 'Codex #1 탭 메뉴');
		assert.deepStrictEqual(
			fixture.tabMenuHost.findAll('agent-tab-context-menu-item').map(
				(item) => item.textContent,
			),
			['이름 변경', '고정'],
		);
		assert.strictEqual(first === second, false);
	});

	test('Shift+F10 메뉴의 방향키와 Escape는 focus를 이동하고 원래 탭으로 복귀한다', () => {
		const fixture = createFixture();
		const tabButton = requireElement(fixture.tabStrip, 'agent-tab-select');
		let prevented = 0;
		tabButton.dispatch('keydown', {
			key: 'F10',
			shiftKey: true,
			preventDefault: () => prevented += 1,
		});

		const menu = requireElement(fixture.tabMenuHost, 'agent-tab-context-menu');
		const items = fixture.tabMenuHost.findAll('agent-tab-context-menu-item');
		assert.strictEqual(items[0].focusCount, 1);
		menu.dispatch('keydown', {
			key: 'ArrowDown',
			preventDefault: () => prevented += 1,
		});
		assert.strictEqual(items[1].focusCount, 1);
		menu.dispatch('keydown', {
			key: 'Escape',
			preventDefault: () => prevented += 1,
		});
		assert.strictEqual(fixture.tabMenuHost.hidden, true);
		assert.strictEqual(tabButton.focusCount, 1);
		assert.strictEqual(prevented, 3);
	});

	test('메뉴에서 수동 이름을 저장하고 검증 오류에서는 dialog와 입력을 유지한다', () => {
		const fixture = createFixture();
		selectProvider(fixture.providerPicker, 'codex');
		const tab = requireElement(fixture.tabStrip, 'agent-tab');
		tab.dispatch('contextmenu', {
			clientX: 10,
			clientY: 10,
			preventDefault: () => undefined,
		});
		fixture.tabMenuHost.findAll('agent-tab-context-menu-item')[0].click();

		assert.strictEqual(fixture.renameDialogHost.hidden, false);
		assert.strictEqual(fixture.renameDialogHost.getAttribute('role'), 'dialog');
		const input = requireElement(fixture.renameDialogHost, 'agent-tab-rename-input');
		assert.strictEqual(input.value, 'Codex #1');
		assert.strictEqual(input.focusCount, 1);
		assert.strictEqual(input.selectCount, 1);

		input.value = '   ';
		requireElement(fixture.renameDialogHost, 'agent-tab-rename-save').click();
		assert.strictEqual(fixture.renameDialogHost.hidden, false);
		assert.strictEqual(
			requireElement(fixture.renameDialogHost, 'agent-tab-rename-error').textContent,
			'이름을 입력해주세요.',
		);

		input.value = '인증 오류 조사';
		requireElement(fixture.renameDialogHost, 'agent-tab-rename-save').click();
		assert.strictEqual(fixture.renameDialogHost.hidden, true);
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].displayName, '인증 오류 조사');
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].titleSource, 'manual');
		assert.deepStrictEqual(readTabLabels(fixture.tabStrip), ['인증 오류 조사']);
	});

	test('고정과 고정 해제는 그룹 끝으로 이동하며 활성 탭과 접근성 이름을 유지한다', () => {
		const fixture = createFixture();
		selectProvider(fixture.providerPicker, 'codex');
		const first = fixture.controller.getSnapshot().tabs[0].id;
		requireElement(fixture.topBar, 'agent-create-tab').click();
		selectProvider(fixture.providerPicker, 'claude');
		const second = fixture.controller.getSnapshot().tabs[1].id;

		const firstButton = fixture.tabStrip.findAll('agent-tab-select')[0];
		firstButton.dispatch('keydown', {
			key: 'ContextMenu',
			preventDefault: () => undefined,
		});
		fixture.tabMenuHost.findAll('agent-tab-context-menu-item')[1].click();

		let snapshot = fixture.controller.getSnapshot();
		assert.deepStrictEqual(snapshot.tabs.map((tab) => tab.id), [first, second]);
		assert.strictEqual(snapshot.tabs[0].isPinned, true);
		assert.strictEqual(snapshot.activeTabId, second);
		assert.strictEqual(
			fixture.tabStrip.findAll('agent-tab-select')[0].getAttribute('aria-label'),
			'Codex, Codex #1, 고정됨',
		);
		assert.strictEqual(
			fixture.tabStrip.findAll('agent-tab')[1].dataset.pinnedBoundary,
			'true',
		);

		fixture.tabStrip.findAll('agent-tab')[0].dispatch('contextmenu', {
			clientX: 5,
			clientY: 5,
			preventDefault: () => undefined,
		});
		assert.strictEqual(
			fixture.tabMenuHost.findAll('agent-tab-context-menu-item')[1].textContent,
			'고정 해제',
		);
		fixture.tabMenuHost.findAll('agent-tab-context-menu-item')[1].click();
		snapshot = fixture.controller.getSnapshot();
		assert.deepStrictEqual(snapshot.tabs.map((tab) => tab.id), [second, first]);
		assert.strictEqual(snapshot.activeTabId, second);
	});

	test('layout 변경 콜백은 탭 상태가 바뀐 때마다 호출된다', () => {
		let layoutChangeCount = 0;
		const fixture = createFixture({
			onLayoutChange: () => layoutChangeCount += 1,
		});

		assert.strictEqual(layoutChangeCount, 1);
		requireElement(fixture.topBar, 'agent-create-tab').click();
		assert.strictEqual(layoutChangeCount, 2);
	});

	test('상위 계층 콜백 실패는 UI 상태 전이를 막지 않는다', () => {
		const fixture = createFixture({
			onTabCreated: () => {
				throw new Error('callback failure');
			},
		});

		requireElement(fixture.topBar, 'agent-create-tab').click();
		assert.strictEqual(fixture.controller.getSnapshot().tabs.length, 2);
	});

	test('dispose는 각 UI와 확인 다이얼로그를 함께 정리한다', () => {
		const fixture = createFixture();

		fixture.controller.dispose();

		assert.strictEqual(fixture.topBar.children.length, 0);
		assert.strictEqual(fixture.tabStrip.children.length, 0);
		assert.strictEqual(fixture.providerPicker.children.length, 0);
		assert.strictEqual(fixture.dialog.disposeCount, 1);
		assert.strictEqual(fixture.documentEvents.countListeners('pointerdown'), 0);
		assert.strictEqual(fixture.documentEvents.countListeners('keydown'), 0);
		assert.strictEqual(fixture.documentEvents.countListeners('scroll'), 0);
		assert.strictEqual(fixture.documentEvents.countListeners('focusin'), 0);
		assert.strictEqual(fixture.documentEvents.countListeners('window:resize'), 0);
	});

	test('dispose 뒤 MCP 확인 Promise continuation은 restart callback을 호출하지 않는다', async () => {
		let restartCount = 0;
		const fixture = createFixture({
			onMcpRestartRequested: () => {
				restartCount += 1;
			},
		});
		selectProvider(fixture.providerPicker, 'codex');
		const tabId = fixture.controller.getSnapshot().tabs[0].id;
		fixture.controller.handleHostMessage({
			type: 'terminal.started', tabId, sessionId: 'session-dispose',
		});
		fixture.controller.handleHostMessage({
			type: 'mcp.statusChanged',
			tabId,
			sessionId: 'session-dispose',
			status: 'failed',
			reason: 'adapter_exited',
			retryable: true,
		});
		requireElement(fixture.topBar, 'agent-mcp-restart').click();
		fixture.controller.dispose();
		await flushMicrotasks();

		assert.strictEqual(restartCount, 0);
	});
});
