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
	readonly providerPicker: FakeAgentElement;
	readonly dialogHost: FakeAgentElement;
	readonly dialog: FakeConfirmDialog;
	readonly documentEvents: FakeDocumentEvents;
	readonly controller: AgentPanelUiController;
}

/** Agent UI를 DOM 대역 위에서 초기화한다. */
function createFixture(callbacks: AgentPanelUiCallbacks = {}): PanelFixture {
	const topBar = new FakeAgentElement();
	const tabStrip = new FakeAgentElement();
	const providerPicker = new FakeAgentElement();
	const dialogHost = new FakeAgentElement();
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
			providerPicker: providerPicker.asHtmlElement(),
			dialogHost: dialogHost.asHtmlElement(),
		},
		callbacks,
		dependencies,
	);

	return {
		topBar,
		tabStrip,
		providerPicker,
		dialogHost,
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
	});

	test('방향키로 목록 포커스를 순환한다', () => {
		const fixture = createFixture();
		const list = requireElement(fixture.providerPicker, 'agent-provider-list');
		const options = fixture.providerPicker.findAll('agent-provider-option');
		let prevented = false;

		assert.strictEqual(options[0].dataset.focused, 'true');
		list.dispatch('keydown', {
			key: 'ArrowDown',
			preventDefault: () => prevented = true,
		});

		assert.strictEqual(prevented, true);
		assert.strictEqual(options[0].dataset.focused, undefined);
		assert.strictEqual(options[1].dataset.focused, 'true');
		assert.strictEqual(options[1].focusCount, 1);

		list.dispatch('keydown', { key: 'ArrowUp', preventDefault: () => undefined });
		assert.strictEqual(options[0].dataset.focused, 'true');
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

	test('재시작은 확인 후에만 현재 provider 세션을 다시 요청한다', async () => {
		const restarts: Array<{ tabId: string; providerId: string }> = [];
		const providerSelections: string[] = [];
		const fixture = createFixture({
			onProviderSelected: (_tabId, providerId) =>
				providerSelections.push(providerId),
			onSessionRestartRequested: (tabId, providerId) =>
				restarts.push({ tabId, providerId }),
		});

		selectProvider(fixture.providerPicker, 'codex');
		requireElement(fixture.topBar, 'agent-restart-session').click();

		const tab = fixture.controller.getSnapshot().tabs[0];
		assert.deepStrictEqual(fixture.dialog.requests, [{
			message: 'Restart Codex #1? The current CLI session will be terminated.',
			acceptLabel: 'Restart',
		}]);
		assert.deepStrictEqual(restarts, []);

		fixture.dialog.answer(true);
		await flushMicrotasks();

		assert.deepStrictEqual(restarts, [{ tabId: tab.id, providerId: 'codex' }]);
		assert.deepStrictEqual(providerSelections, ['codex']);
	});

	test('재시작 확인을 취소하면 현재 세션을 유지한다', async () => {
		const restarts: string[] = [];
		const fixture = createFixture({
			onSessionRestartRequested: (tabId) => restarts.push(tabId),
		});

		selectProvider(fixture.providerPicker, 'antigravity');
		requireElement(fixture.topBar, 'agent-restart-session').click();
		fixture.dialog.answer(false);
		await flushMicrotasks();

		assert.deepStrictEqual(restarts, []);
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
	});
});
