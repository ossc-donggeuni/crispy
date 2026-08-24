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
import type { WorkspaceRootCatalogEntry } from '../../workspace/workspaceRootCatalog';
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
	readonly workspaceStatusBar: FakeAgentElement;
	readonly dialogHost: FakeAgentElement;
	readonly renameDialogHost: FakeAgentElement;
	readonly dialog: FakeConfirmDialog;
	readonly documentEvents: FakeDocumentEvents;
	readonly controller: AgentPanelUiController;
}

/** Agent UI를 DOM 대역 위에서 초기화한다. */
const DEFAULT_WORKSPACE_CATALOG: readonly WorkspaceRootCatalogEntry[] = [{
	id: 'workspace-root:file:///workspace',
	name: 'workspace',
	description: 'file:///workspace',
	selectable: true,
}];

function createFixture(
	callbacks: AgentPanelUiCallbacks = {},
	workspaceRootCatalog: readonly WorkspaceRootCatalogEntry[] =
		DEFAULT_WORKSPACE_CATALOG,
): PanelFixture {
	const topBar = new FakeAgentElement();
	const tabStrip = new FakeAgentElement();
	const tabMenuHost = new FakeAgentElement();
	const providerPicker = new FakeAgentElement();
	const workspaceStatusBar = new FakeAgentElement();
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
			workspaceStatusBar: workspaceStatusBar.asHtmlElement(),
			dialogHost: dialogHost.asHtmlElement(),
			renameDialogHost: renameDialogHost.asHtmlElement(),
		},
		callbacks,
		dependencies,
		{ initialWorkspaceRootCatalog: workspaceRootCatalog },
	);

	return {
		topBar,
		tabStrip,
		tabMenuHost,
		providerPicker,
		workspaceStatusBar,
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

/** Agent 선택 card의 Workspace Picker에서 root 하나를 명시적으로 고른다. */
function selectWorkspace(
	providerPicker: FakeAgentElement,
	workspaceRootId: string,
): void {
	const picker = requireElement(providerPicker, 'agent-workspace-picker');
	const option = providerPicker
		.findAll('agent-workspace-picker-option')
		.find((entry) => entry.dataset.workspaceRootId === workspaceRootId);
	assert.strictEqual(option !== undefined, true);
	picker.click();
	option?.click();
}

/** 현재 탭 strip에 표시된 라벨 목록을 반환한다. */
function readTabLabels(tabStrip: FakeAgentElement): string[] {
	return tabStrip
		.findAll('agent-tab-select')
		.map((element) => element.textContent);
}

suite('Agent Panel UI', () => {
	test('우측 toolbar action은 font glyph 없이 접근 가능한 icon button으로 렌더링한다', () => {
		const fixture = createFixture();
		const actions = [
			['agent-create-tab', 'New agent tab'],
			['agent-change-provider', 'Choose another agent'],
			['agent-restart-session', 'Restart and choose an agent'],
		] as const;

		for (const [className, accessibleName] of actions) {
			const button = requireElement(fixture.topBar, className);
			assert.strictEqual(button.textContent, '');
			assert.strictEqual(button.getAttribute('aria-label'), accessibleName);
			assert.strictEqual(button.title, accessibleName);
		}
	});

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
		assert.strictEqual(fixture.topBar.find('agent-workspace-picker'), undefined);
		const workspacePicker = requireElement(
			fixture.providerPicker,
			'agent-workspace-picker',
		);
		const workspaceOption = requireElement(
			fixture.providerPicker,
			'agent-workspace-picker-option',
		);
		assert.strictEqual(workspacePicker.tagName, 'button');
		assert.strictEqual(workspacePicker.getAttribute('role'), 'combobox');
		assert.strictEqual(
			requireElement(
				workspaceOption,
				'agent-workspace-picker-option-name',
			).textContent,
			'workspace',
		);
		assert.strictEqual(
			requireElement(
				workspaceOption,
				'agent-workspace-picker-option-description',
			).textContent,
			'file:///workspace',
		);
		assert.strictEqual(workspaceOption?.title, 'file:///workspace');
		assert.strictEqual(
			workspaceOption?.getAttribute('aria-label'),
			'workspace, file:///workspace',
		);
	});

	test('Workspace combobox는 카드 내부 listbox와 키보드·바깥 클릭 닫기를 제공한다', () => {
		const fixture = createFixture({}, [
			{
				id: 'workspace-root:file:///repo/unavailable',
				name: 'unavailable',
				description: 'file:///repo/unavailable',
				selectable: false,
				reason: 'workspace_untrusted',
			},
			{
				id: 'workspace-root:file:///repo/alpha',
				name: 'alpha',
				description: 'file:///repo/alpha',
				selectable: true,
			},
			{
				id: 'workspace-root:file:///repo/beta',
				name: 'beta',
				description: 'file:///repo/beta',
				selectable: true,
			},
		]);
		const picker = requireElement(fixture.providerPicker, 'agent-workspace-picker');
		const listbox = requireElement(
			fixture.providerPicker,
			'agent-workspace-picker-listbox',
		);

		picker.click();
		assert.strictEqual(listbox.hidden, false);
		assert.strictEqual(picker.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(
			picker.getAttribute('aria-controls'),
			listbox.getAttribute('id'),
		);
		assert.strictEqual(
			fixture.providerPicker
				.findAll('agent-workspace-picker-option')[1]
				.dataset.active,
			'true',
			'열 때 첫 selectable root가 활성화된다.',
		);

		let prevented = false;
		picker.dispatch('keydown', {
			key: 'ArrowDown',
			preventDefault: () => prevented = true,
		});
		assert.strictEqual(prevented, true);
		picker.dispatch('keydown', {
			key: 'Enter',
			preventDefault: () => undefined,
		});
		assert.strictEqual(picker.value, 'workspace-root:file:///repo/beta');
		assert.strictEqual(listbox.hidden, true);
		assert.strictEqual(picker.getAttribute('aria-expanded'), 'false');

		picker.click();
		picker.dispatch('keydown', {
			key: 'Home',
			preventDefault: () => undefined,
		});
		assert.strictEqual(
			fixture.providerPicker
				.findAll('agent-workspace-picker-option')[1]
				.dataset.active,
			'true',
		);
		picker.dispatch('keydown', {
			key: 'End',
			preventDefault: () => undefined,
		});
		assert.strictEqual(
			fixture.providerPicker
				.findAll('agent-workspace-picker-option')[2]
				.dataset.active,
			'true',
		);
		assert.strictEqual(
			picker.getAttribute('aria-activedescendant'),
			fixture.providerPicker
				.findAll('agent-workspace-picker-option')[2]
				.getAttribute('id'),
		);
		picker.dispatch('keydown', {
			key: 'Escape',
			preventDefault: () => undefined,
		});
		assert.strictEqual(listbox.hidden, true);
		picker.click();
		picker.dispatch('keydown', { key: 'Tab' });
		assert.strictEqual(listbox.hidden, true);

		picker.click();
		fixture.documentEvents.dispatch('pointerdown', {
			target: new FakeAgentElement().asHtmlElement(),
		});
		assert.strictEqual(listbox.hidden, true);
		assert.strictEqual(picker.getAttribute('aria-expanded'), 'false');
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

	test('Workspace Picker는 다중 root를 명시 선택하고 pending 동안 provider와 root를 잠근다', () => {
		const selections: Array<{
			tabId: string;
			providerId: string;
			workspaceRootId: string;
		}> = [];
		const catalog: readonly WorkspaceRootCatalogEntry[] = [
			{
				id: 'workspace-root:file:///repo/alpha',
				name: 'repo',
				description: 'file:///repo/alpha',
				selectable: true,
			},
			{
				id: 'workspace-root:file:///repo/beta',
				name: 'repo',
				description: 'file:///repo/beta',
				selectable: true,
			},
		];
		const fixture = createFixture({
			onProviderSelected: (tabId, providerId, workspaceRootId) => {
				selections.push({ tabId, providerId, workspaceRootId });
				return 9;
			},
		}, catalog);
		const tabId = fixture.controller.getSnapshot().tabs[0].id;
		const picker = requireElement(fixture.providerPicker, 'agent-workspace-picker');
		const providerOptions = fixture.providerPicker.findAll('agent-provider-option');

		assert.strictEqual(picker.value, '');
		assert.strictEqual(picker.disabled, false);
		assert.deepStrictEqual(
			fixture.providerPicker
				.findAll('agent-workspace-picker-option')
				.map((option) => option.dataset.label),
			['repo — file:///repo/alpha', 'repo — file:///repo/beta'],
		);
		assert.deepStrictEqual(providerOptions.map((option) => option.disabled), [
			true,
			true,
			true,
		]);

		selectWorkspace(fixture.providerPicker, 'workspace-root:file:///repo/beta');
		assert.deepStrictEqual(providerOptions.map((option) => option.disabled), [
			false,
			false,
			false,
		]);
		selectProvider(fixture.providerPicker, 'claude');

		assert.deepStrictEqual(selections, [{
			tabId,
			providerId: 'claude',
			workspaceRootId: 'workspace-root:file:///repo/beta',
		}]);
		assert.strictEqual(picker.disabled, true);
		assert.deepStrictEqual(fixture.controller.getAssignmentState(tabId), {
			kind: 'unassigned',
			selectedWorkspaceRootId: 'workspace-root:file:///repo/beta',
			pendingSwitch: {
				providerId: 'claude',
				workspaceRootId: 'workspace-root:file:///repo/beta',
				switchAttemptId: 9,
			},
		});
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'claude',
			workspaceRootId: 'workspace-root:file:///repo/alpha',
			switchAttemptId: 9,
			assignmentRevision: 1,
		}), false);
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'claude',
			workspaceRootId: 'workspace-root:file:///repo/beta',
			switchAttemptId: 9,
			assignmentRevision: 1,
		}), true);
		assert.deepStrictEqual(fixture.controller.getAssignmentState(tabId), {
			kind: 'assigned',
			assignment: {
				providerId: 'claude',
				workspaceRootId: 'workspace-root:file:///repo/beta',
			},
			assignmentRevision: 1,
			pendingSwitch: null,
		});
		assert.strictEqual(picker.disabled, true, 'assigned root는 Reset 전까지 잠긴다.');
		const tabButton = requireElement(fixture.tabStrip, 'agent-tab-select');
		assert.strictEqual(tabButton.title, 'Claude Code #1 — file:///repo/beta');
		assert.strictEqual(
			tabButton.getAttribute('aria-label'),
			'Claude Code, Claude Code #1, Workspace file:///repo/beta',
		);
	});

	test('하단 bar는 활성 세션별 Workspace root 이름만 표시하고 Reset 완료 후 숨긴다', async () => {
		let switchAttemptId = 0;
		const fixture = createFixture({
			onProviderSelected: () => {
				switchAttemptId += 1;
				return switchAttemptId;
			},
			onAgentReselectionRequested: () => true,
		}, [
			{
				id: 'workspace-root:file:///repo/crispy-scenarios',
				name: 'crispy-scenarios',
				description: 'file:///repo/crispy-scenarios',
				selectable: true,
			},
			{
				id: 'workspace-root:file:///repo/crispy-extension',
				name: 'crispy-extension',
				description: 'file:///repo/crispy-extension',
				selectable: true,
			},
		]);
		const firstTabId = fixture.controller.getSnapshot().tabs[0].id;
		assert.strictEqual(fixture.workspaceStatusBar.hidden, true);

		selectWorkspace(
			fixture.providerPicker,
			'workspace-root:file:///repo/crispy-scenarios',
		);
		selectProvider(fixture.providerPicker, 'codex');
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId: firstTabId,
			providerId: 'codex',
			workspaceRootId: 'workspace-root:file:///repo/crispy-scenarios',
			switchAttemptId: 1,
			assignmentRevision: 1,
		}), true);
		assert.strictEqual(fixture.workspaceStatusBar.hidden, false);
		assert.strictEqual(
			requireElement(
				fixture.workspaceStatusBar,
				'agent-workspace-status-name',
			).textContent,
			'crispy-scenarios',
		);
		assert.strictEqual(
			fixture.workspaceStatusBar.find('agent-workspace-status-bar')?.title,
			'',
			'경로나 URI tooltip을 만들지 않는다.',
		);

		requireElement(fixture.topBar, 'agent-create-tab').click();
		const secondTabId = fixture.controller.getSnapshot().activeTabId;
		assert.ok(secondTabId);
		assert.strictEqual(fixture.workspaceStatusBar.hidden, true);
		selectWorkspace(
			fixture.providerPicker,
			'workspace-root:file:///repo/crispy-extension',
		);
		selectProvider(fixture.providerPicker, 'claude');
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId: secondTabId as string,
			providerId: 'claude',
			workspaceRootId: 'workspace-root:file:///repo/crispy-extension',
			switchAttemptId: 2,
			assignmentRevision: 1,
		}), true);
		assert.strictEqual(
			requireElement(
				fixture.workspaceStatusBar,
				'agent-workspace-status-name',
			).textContent,
			'crispy-extension',
		);

		fixture.tabStrip.findAll('agent-tab-select')[0].click();
		assert.strictEqual(
			requireElement(
				fixture.workspaceStatusBar,
				'agent-workspace-status-name',
			).textContent,
			'crispy-scenarios',
		);
		requireElement(fixture.topBar, 'agent-restart-session').click();
		fixture.dialog.answer(true);
		await flushMicrotasks();
		assert.strictEqual(fixture.workspaceStatusBar.hidden, false);
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.resetCompleted',
			tabId: firstTabId,
			assignmentRevision: 2,
		}), true);
		assert.strictEqual(fixture.workspaceStatusBar.hidden, true);
	});

	test('Catalog refresh는 unassigned 단일 root만 자동 선택하고 missing assignment는 synthetic entry로 유지한다', () => {
		const fixture = createFixture({ onProviderSelected: () => 4 }, [
			{
				id: 'workspace-root:file:///repo/a',
				name: 'repo-a',
				description: 'file:///repo/a',
				selectable: true,
			},
			{
				id: 'workspace-root:file:///repo/b',
				name: 'repo-b',
				description: 'file:///repo/b',
				selectable: true,
			},
		]);
		const tabId = fixture.controller.getSnapshot().tabs[0].id;
		let assignmentState = fixture.controller.getAssignmentState(tabId);
		assert.strictEqual(
			assignmentState?.kind === 'unassigned'
				? assignmentState.selectedWorkspaceRootId
				: undefined,
			null,
		);

		fixture.controller.updateWorkspaceRootCatalog([{
			id: 'workspace-root:file:///repo/b',
			name: 'repo-b',
			description: 'file:///repo/b',
			selectable: true,
		}]);
		assignmentState = fixture.controller.getAssignmentState(tabId);
		assert.strictEqual(
			assignmentState?.kind === 'unassigned'
				? assignmentState.selectedWorkspaceRootId
				: undefined,
			'workspace-root:file:///repo/b',
		);
		selectProvider(fixture.providerPicker, 'codex');
		fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'codex',
			workspaceRootId: 'workspace-root:file:///repo/b',
			switchAttemptId: 4,
			assignmentRevision: 1,
		});

		fixture.controller.updateWorkspaceRootCatalog([]);
		const synthetic = fixture.providerPicker
			.findAll('agent-workspace-picker-option').find(
			(option) => option.dataset.reason === 'workspace_root_unavailable',
		);
		assert.strictEqual(
			synthetic?.dataset.workspaceRootId,
			'workspace-root:file:///repo/b',
		);
		assert.strictEqual(synthetic?.getAttribute('aria-disabled'), 'true');
		assert.strictEqual(
			requireElement(
				synthetic as FakeAgentElement,
				'agent-workspace-picker-option-name',
			).textContent,
			'repo-b (Workspace is no longer available)',
		);
		assert.strictEqual(
			requireElement(
				synthetic as FakeAgentElement,
				'agent-workspace-picker-option-description',
			).textContent,
			'file:///repo/b',
		);
		assert.strictEqual(synthetic?.title, 'file:///repo/b');
		assert.strictEqual(
			synthetic?.getAttribute('aria-label'),
			'repo-b, file:///repo/b, Workspace is no longer available',
		);
		assert.deepStrictEqual(fixture.controller.getAssignmentState(tabId), {
			kind: 'assigned',
			assignment: {
				providerId: 'codex',
				workspaceRootId: 'workspace-root:file:///repo/b',
			},
			assignmentRevision: 1,
			pendingSwitch: null,
		});
	});

	test('provider만 바꿀 때 committed Workspace를 유지하고 실패하면 기존 assignment를 복원한다', () => {
		let attempt = 0;
		const selections: Array<{ providerId: string; workspaceRootId: string }> = [];
		const fixture = createFixture({
			onProviderSelected: (_tabId, providerId, workspaceRootId) => {
				selections.push({ providerId, workspaceRootId });
				attempt += 1;
				return attempt;
			},
		});
		const tabId = fixture.controller.getSnapshot().tabs[0].id;
		selectProvider(fixture.providerPicker, 'codex');
		fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'codex',
			workspaceRootId: 'workspace-root:file:///workspace',
			switchAttemptId: 1,
			assignmentRevision: 1,
		});

		requireElement(fixture.topBar, 'agent-change-provider').click();
		assert.strictEqual(fixture.providerPicker.hidden, false);
		assert.strictEqual(
			requireElement(fixture.providerPicker, 'agent-workspace-picker').disabled,
			true,
		);
		selectProvider(fixture.providerPicker, 'claude');
		assert.deepStrictEqual(fixture.controller.getAssignmentState(tabId), {
			kind: 'assigned',
			assignment: {
				providerId: 'codex',
				workspaceRootId: 'workspace-root:file:///workspace',
			},
			assignmentRevision: 1,
			pendingSwitch: {
				providerId: 'claude',
				workspaceRootId: 'workspace-root:file:///workspace',
				switchAttemptId: 2,
			},
		});

		fixture.controller.handleHostMessage({
			type: 'terminal.error',
			tabId,
			sessionId: null,
			code: 'workspace_untrusted',
			message: 'Workspace unavailable',
			canRestart: false,
			switchAttemptId: 2,
		});
		assert.strictEqual(fixture.providerPicker.hidden, true);
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, 'codex');

		requireElement(fixture.topBar, 'agent-change-provider').click();
		selectProvider(fixture.providerPicker, 'claude');
		fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'claude',
			workspaceRootId: 'workspace-root:file:///workspace',
			switchAttemptId: 3,
			assignmentRevision: 2,
		});
		assert.deepStrictEqual(selections, [
			{ providerId: 'codex', workspaceRootId: 'workspace-root:file:///workspace' },
			{ providerId: 'claude', workspaceRootId: 'workspace-root:file:///workspace' },
			{ providerId: 'claude', workspaceRootId: 'workspace-root:file:///workspace' },
		]);
		assert.deepStrictEqual(fixture.controller.getAssignmentState(tabId), {
			kind: 'assigned',
			assignment: {
				providerId: 'claude',
				workspaceRootId: 'workspace-root:file:///workspace',
			},
			assignmentRevision: 2,
			pendingSwitch: null,
		});
	});

	test('provider 요청이 수락되면 탭에 배정하고 중앙 선택기를 숨긴다', () => {
		const selections: Array<{ tabId: string; providerId: string }> = [];
		const fixture = createFixture({
			onProviderSelected: (tabId, providerId) => {
				selections.push({ tabId, providerId });
			},
		});

		selectProvider(fixture.providerPicker, 'claude');

		const tab = fixture.controller.getSnapshot().tabs[0];
		assert.strictEqual(fixture.providerPicker.hidden, true);
		assert.strictEqual(tab.providerId, 'claude');
		assert.strictEqual(tab.label, 'Claude Code #1');
		assert.deepStrictEqual(selections, [{ tabId: tab.id, providerId: 'claude' }]);
	});

	test('provider 요청 거부 또는 실패 시 미선택 상태와 picker를 유지한다', () => {
		for (const onProviderSelected of [
			() => false,
			() => {
				throw new Error('selection transport failed');
			},
		]) {
			const fixture = createFixture({ onProviderSelected });

			selectProvider(fixture.providerPicker, 'codex');

			const tab = fixture.controller.getSnapshot().tabs[0];
			assert.strictEqual(tab.providerId, undefined);
			assert.strictEqual(tab.label, UNSELECTED_TAB_LABEL);
			assert.strictEqual(fixture.providerPicker.hidden, false);
		}
	});

	test('Host switchAccepted 전에는 provider를 commit하지 않고 attempt/revision 순서만 적용한다', () => {
		const fixture = createFixture({
			onProviderSelected: () => 7,
		});
		selectProvider(fixture.providerPicker, 'claude');
		const tabId = fixture.controller.getSnapshot().tabs[0].id;

		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, undefined);
		fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'claude',
			workspaceRootId: 'workspace-root:file:///workspace',
			switchAttemptId: 6,
			assignmentRevision: 1,
		});
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, undefined);

		fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'claude',
			workspaceRootId: 'workspace-root:file:///workspace',
			switchAttemptId: 7,
			assignmentRevision: 1,
		});
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, 'claude');
		assert.strictEqual(fixture.providerPicker.hidden, true);

		fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'codex',
			workspaceRootId: 'workspace-root:file:///workspace',
			switchAttemptId: 7,
			assignmentRevision: 1,
		});
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, 'claude');
	});

	test('correlated pre-assignment 오류는 pending switch만 해제하고 picker 선택을 복구한다', () => {
		let attempt = 0;
		const fixture = createFixture({
			onProviderSelected: () => {
				attempt += 1;
				return attempt;
			},
		});
		selectProvider(fixture.providerPicker, 'codex');
		const tabId = fixture.controller.getSnapshot().tabs[0].id;

		fixture.controller.handleHostMessage({
			type: 'terminal.error',
			tabId,
			sessionId: null,
			code: 'workspace_untrusted',
			message: '작업공간을 신뢰한 후 다시 시도하세요.',
			canRestart: false,
			switchAttemptId: 1,
		});

		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, undefined);
		assert.strictEqual(fixture.providerPicker.hidden, false);
		selectProvider(fixture.providerPicker, 'claude');
		assert.strictEqual(attempt, 2);
	});

	test('pending switch를 Reset하면 barrier 이전 accepted와 correlated error를 모두 무시한다', async () => {
		const resets: string[] = [];
		const fixture = createFixture({
			onProviderSelected: () => 12,
			onAgentReselectionRequested: (tabId) => {
				resets.push(tabId);
				return true;
			},
		});
		const tabId = fixture.controller.getSnapshot().tabs[0].id;
		selectProvider(fixture.providerPicker, 'codex');
		const reset = requireElement(fixture.topBar, 'agent-restart-session');
		assert.strictEqual(reset.disabled, false);

		reset.click();
		fixture.dialog.answer(true);
		await flushMicrotasks();
		assert.deepStrictEqual(resets, [tabId]);
		assert.deepStrictEqual(fixture.controller.getAssignmentState(tabId), {
			kind: 'resetting',
			previousAssignment: null,
			resetBarrierAttemptId: 12,
		});
		assert.strictEqual(reset.disabled, true);
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'codex',
			workspaceRootId: 'workspace-root:file:///workspace',
			switchAttemptId: 12,
			assignmentRevision: 1,
		}), false);
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'terminal.error',
			tabId,
			sessionId: null,
			code: 'workspace_untrusted',
			message: 'stale failure',
			canRestart: false,
			switchAttemptId: 12,
		}), false);
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.resetCompleted',
			tabId,
			assignmentRevision: 2,
		}), true);
		assert.deepStrictEqual(fixture.controller.getAssignmentState(tabId), {
			kind: 'unassigned',
			selectedWorkspaceRootId: null,
			pendingSwitch: null,
		});
	});

	test('Reset barrier는 늦은 accepted/error의 Terminal 전달과 provider 부활을 차단한다', async () => {
		const resets: string[] = [];
		let switchAttemptId = 2;
		const fixture = createFixture({
			onProviderSelected: () => {
				switchAttemptId += 1;
				return switchAttemptId;
			},
			onAgentReselectionRequested: (tabId) => {
				resets.push(tabId);
				return true;
			},
		});
		selectProvider(fixture.providerPicker, 'codex');
		const tabId = fixture.controller.getSnapshot().tabs[0].id;
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'codex',
			workspaceRootId: 'workspace-root:file:///workspace',
			switchAttemptId: 3,
			assignmentRevision: 1,
		}), true);

		requireElement(fixture.topBar, 'agent-restart-session').click();
		fixture.dialog.answer(true);
		await flushMicrotasks();
		assert.deepStrictEqual(resets, [tabId]);
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, 'codex');

		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'codex',
			workspaceRootId: 'workspace-root:file:///workspace',
			switchAttemptId: 3,
			assignmentRevision: 1,
		}), false);
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, 'codex');

		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.resetCompleted',
			tabId,
			assignmentRevision: 2,
		}), true);
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, undefined);
		assert.strictEqual(fixture.providerPicker.hidden, false);

		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.resetCompleted',
			tabId,
			assignmentRevision: 1,
		}), false);

		selectWorkspace(fixture.providerPicker, 'workspace-root:file:///workspace');
		selectProvider(fixture.providerPicker, 'claude');
		assert.strictEqual(switchAttemptId, 4);
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'terminal.error',
			tabId,
			sessionId: null,
			code: 'workspace_untrusted',
			message: 'stale error',
			canRestart: false,
			switchAttemptId: 3,
		}), false);
		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'claude',
			workspaceRootId: 'workspace-root:file:///workspace',
			switchAttemptId: 4,
			assignmentRevision: 3,
		}), true);

		assert.strictEqual(fixture.controller.handleHostMessage({
			type: 'agent.switchAccepted',
			tabId,
			providerId: 'codex',
			workspaceRootId: 'workspace-root:file:///workspace',
			switchAttemptId: 3,
			assignmentRevision: 1,
		}), false);
		assert.strictEqual(fixture.controller.getSnapshot().tabs[0].providerId, 'claude');
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
			onProviderSelected: (_tabId, providerId) => {
				providerSelections.push(providerId);
			},
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

	test('mcp.restartRejected는 failed 표시를 유지하고 restart pending만 끝낸다', async () => {
		const fixture = createFixture({
			onMcpRestartRequested: () => undefined,
		});
		selectProvider(fixture.providerPicker, 'codex');
		const tabId = fixture.controller.getSnapshot().tabs[0].id;
		fixture.controller.handleHostMessage({
			type: 'terminal.started', tabId, sessionId: 'session-rejected',
		});
		fixture.controller.handleHostMessage({
			type: 'mcp.statusChanged',
			tabId,
			sessionId: 'session-rejected',
			status: 'failed',
			reason: 'adapter_exited',
			retryable: true,
		});
		const restart = requireElement(fixture.topBar, 'agent-mcp-restart');
		restart.click();
		fixture.dialog.answer(true);
		await flushMicrotasks();
		assert.strictEqual(
			fixture.controller.getSnapshot().tabs[0].mcpRestartPending,
			true,
		);

		fixture.controller.handleHostMessage({
			type: 'mcp.restartRejected',
			tabId,
			sessionId: 'session-rejected',
			code: 'workspace_untrusted',
			message: '작업공간을 신뢰한 후 다시 시도하세요.',
		});

		const tab = fixture.controller.getSnapshot().tabs[0];
		assert.strictEqual(tab.mcpRestartPending, false);
		assert.strictEqual(tab.mcpStatus.kind, 'failed');
		assert.strictEqual(restart.disabled, false);
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
			'Codex, Codex #1, Workspace file:///workspace, 고정됨',
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
		assert.strictEqual(fixture.workspaceStatusBar.children.length, 0);
		assert.strictEqual(fixture.workspaceStatusBar.hidden, true);
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
