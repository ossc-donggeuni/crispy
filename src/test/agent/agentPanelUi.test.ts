import * as assert from 'assert';
import type { AgentConfirmDialog } from '../../agent/UI/agentConfirmDialog';
import {
	initializeAgentPanelUi,
	type AgentPanelUiCallbacks,
	type AgentPanelUiController,
	type AgentPanelUiDependencies,
} from '../../agent/UI/agentPanelUi';
import {
	UNSELECTED_PROVIDER_LABEL,
	UNSELECTED_TAB_LABEL,
} from '../../agent/UI/agentProviders';
import { PROVIDER_IDS } from '../../agent/protocol';
import {
	FakeAgentElement,
	FakeDocumentEvents,
	createFakeAgentUiDependencies,
	flushMicrotasks,
} from './support/fakeAgentUiDom';

/** 확인 요청을 기록하고 응답 시점을 테스트가 정하는 확인 다이얼로그 대역이다. */
class FakeConfirmDialog implements AgentConfirmDialog {
	readonly messages: string[] = [];
	disposeCount = 0;

	private pending: ((confirmed: boolean) => void) | undefined;

	confirm(message: string): Promise<boolean> {
		this.messages.push(message);
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
	readonly providerBar: FakeAgentElement;
	readonly dialogHost: FakeAgentElement;
	readonly dialog: FakeConfirmDialog;
	readonly documentEvents: FakeDocumentEvents;
	readonly controller: AgentPanelUiController;
}

/**
 * Agent UI 뼈대를 DOM 대역 위에서 초기화한다.
 *
 * @param callbacks 검증할 상위 계층 콜백
 * @returns 컨테이너와 제어 객체를 담은 fixture
 */
function createFixture(callbacks: AgentPanelUiCallbacks = {}): PanelFixture {
	const topBar = new FakeAgentElement();
	const tabStrip = new FakeAgentElement();
	const providerBar = new FakeAgentElement();
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
			providerBar: providerBar.asHtmlElement(),
			dialogHost: dialogHost.asHtmlElement(),
		},
		callbacks,
		dependencies,
	);

	return {
		topBar,
		tabStrip,
		providerBar,
		dialogHost,
		dialog,
		documentEvents,
		controller,
	};
}

/**
 * 지정한 class를 가진 요소를 찾는다. 없으면 테스트를 실패시킨다.
 *
 * @param root 탐색을 시작할 요소
 * @param className 찾을 class 이름
 * @returns 일치하는 첫 요소
 */
function requireElement(
	root: FakeAgentElement,
	className: string,
): FakeAgentElement {
	const element = root.find(className);
	assert.strictEqual(element !== undefined, true);
	return element as FakeAgentElement;
}

/**
 * 드롭다운을 열고 provider를 고르는 사용자 동작을 재현한다.
 *
 * @param providerBar 하단 provider bar 컨테이너
 * @param providerId 선택할 provider 식별자
 */
function selectProvider(providerBar: FakeAgentElement, providerId: string): void {
	requireElement(providerBar, 'agent-provider-select').click();

	const option = providerBar
		.findAll('agent-provider-option')
		.find((element) => element.dataset.providerId === providerId);
	assert.strictEqual(option !== undefined, true);
	option?.click();
}

/**
 * 하단 bar에 표시된 provider 이름을 읽는다.
 *
 * @param providerBar 하단 provider bar 컨테이너
 * @returns 드롭다운 버튼에 표시 중인 문구
 */
function readProviderLabel(providerBar: FakeAgentElement): string {
	return requireElement(providerBar, 'agent-provider-value').textContent;
}

/**
 * 현재 탭 strip에 표시된 라벨 목록을 읽는다.
 *
 * @param tabStrip 탭 strip 컨테이너
 * @returns 표시 순서대로의 탭 라벨
 */
function readTabLabels(tabStrip: FakeAgentElement): string[] {
	return tabStrip
		.findAll('agent-tab-select')
		.map((element) => element.textContent);
}

suite('Agent Panel UI', () => {
	test('하단 bar는 미선택 placeholder와 세 개의 provider option을 제공한다', () => {
		const fixture = createFixture();
		const options = fixture.providerBar.findAll('agent-provider-option');

		assert.strictEqual(readProviderLabel(fixture.providerBar), UNSELECTED_PROVIDER_LABEL);
		assert.deepStrictEqual(
			options.map((option) => option.dataset.providerId),
			[...PROVIDER_IDS],
		);
		assert.deepStrictEqual(
			options.map((option) => option.textContent),
			['Codex', 'Claude', 'Antigravity'],
		);
	});

	test('드롭다운 목록은 기본으로 닫혀 있고 버튼으로 열고 닫는다', () => {
		const fixture = createFixture();
		const trigger = requireElement(fixture.providerBar, 'agent-provider-select');
		const menu = requireElement(fixture.providerBar, 'agent-provider-menu');

		assert.strictEqual(menu.hidden, true);
		assert.strictEqual(trigger.getAttribute('aria-expanded'), 'false');

		trigger.click();
		assert.strictEqual(menu.hidden, false);
		assert.strictEqual(trigger.getAttribute('aria-expanded'), 'true');

		trigger.click();
		assert.strictEqual(menu.hidden, true);
	});

	test('드롭다운 목록은 바깥 클릭과 Escape로 닫히고 안쪽 클릭은 유지한다', () => {
		const fixture = createFixture();
		const trigger = requireElement(fixture.providerBar, 'agent-provider-select');
		const picker = requireElement(fixture.providerBar, 'agent-provider-picker');
		const menu = requireElement(fixture.providerBar, 'agent-provider-menu');

		trigger.click();
		fixture.documentEvents.dispatch('pointerdown', { target: menu });
		assert.strictEqual(menu.hidden, false);

		fixture.documentEvents.dispatch('pointerdown', { target: new FakeAgentElement() });
		assert.strictEqual(menu.hidden, true);

		trigger.click();
		fixture.documentEvents.dispatch('keydown', { key: 'Escape' });
		assert.strictEqual(menu.hidden, true);
		assert.strictEqual(picker.dataset.open, undefined);
	});

	test('선택한 provider는 드롭다운 버튼과 option 선택 표시에 반영된다', () => {
		const fixture = createFixture();

		selectProvider(fixture.providerBar, 'claude');

		assert.strictEqual(readProviderLabel(fixture.providerBar), 'Claude');
		assert.strictEqual(
			requireElement(fixture.providerBar, 'agent-provider-menu').hidden,
			true,
		);

		const selectedIds = fixture.providerBar
			.findAll('agent-provider-option')
			.filter((option) => option.getAttribute('aria-selected') === 'true')
			.map((option) => option.dataset.providerId);
		assert.deepStrictEqual(selectedIds, ['claude']);
	});

	test('초기 탭은 provider 미선택 상태로 표시된다', () => {
		const fixture = createFixture();

		assert.deepStrictEqual(readTabLabels(fixture.tabStrip), [UNSELECTED_TAB_LABEL]);
		assert.strictEqual(
			fixture.controller.getSnapshot().tabs[0].providerId,
			undefined,
		);
	});

	test('+ 버튼은 provider 미선택 상태의 새 탭을 추가한다', () => {
		const createdTabIds: string[] = [];
		const fixture = createFixture({
			onTabCreated: (tabId) => createdTabIds.push(tabId),
		});

		requireElement(fixture.topBar, 'agent-create-tab').click();

		const snapshot = fixture.controller.getSnapshot();
		assert.strictEqual(snapshot.tabs.length, 2);
		assert.strictEqual(snapshot.tabs[1].providerId, undefined);
		assert.strictEqual(snapshot.activeTabId, snapshot.tabs[1].id);
		assert.deepStrictEqual(readTabLabels(fixture.tabStrip), [
			UNSELECTED_TAB_LABEL,
			UNSELECTED_TAB_LABEL,
		]);
		assert.strictEqual(createdTabIds.length, 2);
	});

	test('드롭다운 선택은 활성 탭에 provider와 번호를 배정한다', () => {
		const selections: Array<{ tabId: string; providerId: string }> = [];
		const fixture = createFixture({
			onProviderSelected: (tabId, providerId) =>
				selections.push({ tabId, providerId }),
		});

		selectProvider(fixture.providerBar, 'claude');

		assert.deepStrictEqual(readTabLabels(fixture.tabStrip), ['Claude #1']);
		assert.strictEqual(selections.length, 1);
		assert.strictEqual(selections[0].providerId, 'claude');
		assert.strictEqual(
			selections[0].tabId,
			fixture.controller.getSnapshot().tabs[0].id,
		);
	});

	test('재시작 버튼은 provider를 바꾸지 않고 별도의 재시작 콜백만 호출한다', () => {
		const restarts: Array<{ tabId: string; providerId: string }> = [];
		const providerSelections: string[] = [];
		const fixture = createFixture({
			onProviderSelected: (_tabId, providerId) =>
				providerSelections.push(providerId),
			onSessionRestartRequested: (tabId, providerId) =>
				restarts.push({ tabId, providerId }),
		});

		selectProvider(fixture.providerBar, 'codex');
		requireElement(fixture.topBar, 'agent-restart-session').click();

		const tab = fixture.controller.getSnapshot().tabs[0];
		assert.deepStrictEqual(restarts, [{ tabId: tab.id, providerId: 'codex' }]);
		/* 재시작은 provider 전환 경로를 다시 실행하지 않는다. */
		assert.deepStrictEqual(providerSelections, ['codex']);
		assert.strictEqual(tab.label, 'Codex #1');
	});

	test('provider 미선택 탭에서는 재시작 버튼이 비활성이다', () => {
		const restarts: string[] = [];
		const fixture = createFixture({
			onSessionRestartRequested: (tabId) => restarts.push(tabId),
		});

		const restartButton = requireElement(fixture.topBar, 'agent-restart-session');
		assert.strictEqual(restartButton.disabled, true);

		restartButton.click();
		assert.strictEqual(restarts.length, 0);
	});

	test('탭을 클릭하면 활성 탭과 드롭다운 표시가 함께 전환된다', () => {
		const activated: string[] = [];
		const fixture = createFixture({
			onTabActivated: (tabId) => activated.push(tabId),
		});

		selectProvider(fixture.providerBar, 'codex');
		requireElement(fixture.topBar, 'agent-create-tab').click();
		selectProvider(fixture.providerBar, 'claude');

		const [firstTab, secondTab] = fixture.controller.getSnapshot().tabs;
		assert.deepStrictEqual(readTabLabels(fixture.tabStrip), [
			'Codex #1',
			'Claude #1',
		]);

		const firstTabButton = fixture.tabStrip.findAll('agent-tab-select')[0];
		firstTabButton.click();

		assert.deepStrictEqual(activated, [firstTab.id]);
		assert.strictEqual(fixture.controller.getSnapshot().activeTabId, firstTab.id);
		assert.strictEqual(readProviderLabel(fixture.providerBar), 'Codex');

		const tabElements = fixture.tabStrip.findAll('agent-tab');
		assert.strictEqual(tabElements[0].dataset.active, 'true');
		assert.strictEqual(tabElements[1].dataset.active, undefined);
		assert.strictEqual(secondTab.label, 'Claude #1');
	});

	test('탭 닫기는 항상 확인을 요청하고 취소하면 탭을 유지한다', async () => {
		const closed: string[] = [];
		const fixture = createFixture({ onTabClosed: (tabId) => closed.push(tabId) });

		selectProvider(fixture.providerBar, 'codex');
		requireElement(fixture.tabStrip, 'agent-tab-close').click();
		fixture.dialog.answer(false);
		await flushMicrotasks();

		assert.deepStrictEqual(fixture.dialog.messages, ['Close Codex #1?']);
		assert.strictEqual(fixture.controller.getSnapshot().tabs.length, 1);
		assert.strictEqual(closed.length, 0);
	});

	test('확인을 수락하면 탭이 닫히고 닫힘 콜백이 호출된다', async () => {
		const closed: string[] = [];
		const fixture = createFixture({ onTabClosed: (tabId) => closed.push(tabId) });

		selectProvider(fixture.providerBar, 'codex');
		requireElement(fixture.topBar, 'agent-create-tab').click();
		const [firstTab] = fixture.controller.getSnapshot().tabs;

		fixture.tabStrip.findAll('agent-tab-close')[0].click();
		fixture.dialog.answer(true);
		await flushMicrotasks();

		assert.deepStrictEqual(closed, [firstTab.id]);
		assert.deepStrictEqual(readTabLabels(fixture.tabStrip), [UNSELECTED_TAB_LABEL]);
		assert.strictEqual(fixture.dialog.messages.length, 1);
	});

	test('마지막 탭을 닫으면 드롭다운과 재시작 버튼이 비활성이 된다', async () => {
		const fixture = createFixture();

		requireElement(fixture.tabStrip, 'agent-tab-close').click();
		fixture.dialog.answer(true);
		await flushMicrotasks();

		assert.deepStrictEqual(readTabLabels(fixture.tabStrip), []);
		assert.strictEqual(
			requireElement(fixture.providerBar, 'agent-provider-select').disabled,
			true,
		);
		assert.strictEqual(readProviderLabel(fixture.providerBar), UNSELECTED_PROVIDER_LABEL);
		assert.strictEqual(
			requireElement(fixture.topBar, 'agent-restart-session').disabled,
			true,
		);
	});

	test('layout 변경 콜백은 탭 상태가 바뀔 때마다 호출된다', () => {
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

	test('dispose는 각 bar, 탭 strip과 확인 다이얼로그를 함께 정리한다', () => {
		const fixture = createFixture();

		fixture.controller.dispose();

		assert.strictEqual(fixture.topBar.children.length, 0);
		assert.strictEqual(fixture.tabStrip.children.length, 0);
		assert.strictEqual(fixture.providerBar.children.length, 0);
		assert.strictEqual(fixture.dialog.disposeCount, 1);
		assert.strictEqual(fixture.documentEvents.countListeners('pointerdown'), 0);
		assert.strictEqual(fixture.documentEvents.countListeners('keydown'), 0);
	});
});
