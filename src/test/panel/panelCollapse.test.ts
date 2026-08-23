import * as assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { initializePanelCollapse } from '../../webview/panel/panelCollapse';
import {
	INITIAL_SIDE_SIZE,
	INITIAL_VERTICAL_SIZE,
	type DockPosition,
	type PanelLayoutState,
} from '../../webview/panel/panelState';

suite('Panel Collapse', () => {
	test('좌우는 가로, 상하는 세로 방향으로 Panel 전체를 Slide한다', () => {
		const webviewCss = readFileSync(resolve(
			__dirname,
			'../../../src/webview/webview.css',
		), 'utf8');
		const translations: Readonly<Record<DockPosition, string>> = {
			left: 'translateX(calc(-100% - var(--chat-floating-margin)))',
			right: 'translateX(calc(100% + var(--chat-floating-margin)))',
			top: 'translateY(calc(-100% - var(--chat-floating-margin)))',
			bottom: 'translateY(calc(100% + var(--chat-floating-margin)))',
		};

		for (const dock of ['left', 'right', 'top', 'bottom'] as const) {
			const selector = `.crispy-layout[data-dock='${dock}'] #agent-chat-area[data-collapse-state='collapsed']`;
			const ruleStart = webviewCss.indexOf(selector);
			const ruleEnd = webviewCss.indexOf('}', ruleStart);

			assert.ok(ruleStart >= 0);
			assert.ok(ruleEnd > ruleStart);
			assert.ok(webviewCss.slice(ruleStart, ruleEnd).includes(
				`transform: ${translations[dock]};`,
			));
		}
	});

	test('펼침 상태에서는 Chat Panel과 Resize Handle을 표시하고 Sticker를 숨긴다', () => {
		const fixture = createCollapseFixture('right');

		assert.strictEqual(fixture.chatPanel.hidden, false);
		assert.strictEqual(fixture.resizeHandle.hidden, false);
		assert.strictEqual(fixture.stickerOpener.hidden, true);
		assert.strictEqual(fixture.chatPanel.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.resizeHandle.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.chatPanel.inert, false);
		assert.strictEqual(fixture.state.collapsed, false);
	});

	test('접기 버튼은 Chat Panel 전체와 Resize Handle의 Slide 상태를 적용하고 Sticker를 표시한다', () => {
		const fixture = createCollapseFixture('right');

		fixture.collapseButton.click();

		assert.strictEqual(fixture.state.collapsed, true);
		assert.strictEqual(fixture.chatPanel.hidden, false);
		assert.strictEqual(fixture.resizeHandle.hidden, false);
		assert.strictEqual(fixture.chatPanel.dataset.collapseState, 'collapsed');
		assert.strictEqual(fixture.resizeHandle.dataset.collapseState, 'collapsed');
		assert.strictEqual(fixture.chatPanel.dataset.collapseMotion, 'slide');
		assert.strictEqual(fixture.resizeHandle.dataset.collapseMotion, 'slide');
		assert.strictEqual(fixture.chatPanel.inert, true);
		assert.strictEqual(fixture.stickerOpener.hidden, false);
		assert.strictEqual(fixture.getCollapsedChangeCount(), 1);
		assert.strictEqual(fixture.getExpandCount(), 0);
	});

	test('Sticker를 현재 Dock 방향에 맞춰 표시한다', () => {
		const stickerIcons: Record<DockPosition, string> = {
			left: 'panel-right.svg',
			right: 'panel-left.svg',
			top: 'panel-down.svg',
			bottom: 'panel-up.svg',
		};

		for (const dock of ['left', 'right', 'top', 'bottom'] as const) {
			const fixture = createCollapseFixture(dock);

			fixture.collapseButton.click();

			assert.strictEqual(fixture.stickerOpener.hidden, false);
			assert.strictEqual(fixture.stickerOpener.dataset.dock, dock);
			assert.strictEqual(
				fixture.stickerOpener.dataset.panelIcon,
				stickerIcons[dock],
			);
		}
	});

	test('접힌 상태에서도 저장된 Panel 크기를 그대로 둔다', () => {
		const fixture = createCollapseFixture('bottom', 520, 340);

		fixture.collapseButton.click();

		assert.strictEqual(fixture.state.sideSize, 520);
		assert.strictEqual(fixture.state.verticalSize, 340);
		assert.strictEqual(fixture.state.preferredDock, 'bottom');
	});

	test('Sticker를 누르면 같은 Dock과 크기로 Chat Panel을 복원한다', () => {
		const fixture = createCollapseFixture('left', 520, 340);

		fixture.collapseButton.click();
		fixture.stickerOpener.click();

		assert.strictEqual(fixture.state.collapsed, false);
		assert.strictEqual(fixture.state.preferredDock, 'left');
		assert.strictEqual(fixture.state.sideSize, 520);
		assert.strictEqual(fixture.state.verticalSize, 340);
		assert.strictEqual(fixture.chatPanel.hidden, false);
		assert.strictEqual(fixture.resizeHandle.hidden, false);
		assert.strictEqual(fixture.chatPanel.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.resizeHandle.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.chatPanel.inert, false);
		assert.strictEqual(fixture.stickerOpener.hidden, true);
		assert.strictEqual(fixture.getCollapsedChangeCount(), 2);
		assert.strictEqual(fixture.getExpandCount(), 1);
	});

	test('접힌 상태로 복원하면 처음부터 Sticker만 표시한다', () => {
		const fixture = createCollapseFixture('top', INITIAL_SIDE_SIZE, 340, true);

		assert.strictEqual(fixture.chatPanel.hidden, false);
		assert.strictEqual(fixture.resizeHandle.hidden, false);
		assert.strictEqual(fixture.chatPanel.dataset.collapseState, 'collapsed');
		assert.strictEqual(fixture.resizeHandle.dataset.collapseState, 'collapsed');
		assert.strictEqual(fixture.chatPanel.dataset.collapseMotion, undefined);
		assert.strictEqual(fixture.chatPanel.inert, true);
		assert.strictEqual(fixture.stickerOpener.hidden, false);
		assert.strictEqual(fixture.stickerOpener.dataset.dock, 'top');
		assert.strictEqual(fixture.getCollapsedChangeCount(), 0);
	});

	test('같은 상태를 다시 요청하면 저장 콜백을 호출하지 않는다', () => {
		const fixture = createCollapseFixture('right');

		fixture.stickerOpener.click();
		assert.strictEqual(fixture.getCollapsedChangeCount(), 0);

		fixture.collapseButton.click();
		fixture.collapseButton.click();

		assert.strictEqual(fixture.state.collapsed, true);
		assert.strictEqual(fixture.getCollapsedChangeCount(), 1);
	});

	test('Dock이 바뀌면 Sticker와 접기 버튼 아이콘을 다시 맞춘다', () => {
		const fixture = createCollapseFixture('right');

		assert.strictEqual(
			fixture.collapseButton.dataset.panelIcon,
			'panel-right.svg',
		);

		fixture.state.preferredDock = 'bottom';
		fixture.refreshCollapse();

		assert.strictEqual(
			fixture.collapseButton.dataset.panelIcon,
			'panel-down.svg',
		);
		assert.strictEqual(fixture.stickerOpener.dataset.dock, 'bottom');
		assert.strictEqual(
			fixture.stickerOpener.dataset.panelIcon,
			'panel-up.svg',
		);
	});
});

interface CollapseFixture {
	chatPanel: FakeElement;
	resizeHandle: FakeElement;
	collapseButton: FakeElement;
	stickerOpener: FakeElement;
	state: PanelLayoutState;
	refreshCollapse(): void;
	getCollapsedChangeCount(): number;
	getExpandCount(): number;
}

function createCollapseFixture(
	preferredDock: DockPosition,
	sideSize = INITIAL_SIDE_SIZE,
	verticalSize = INITIAL_VERTICAL_SIZE,
	collapsed = false,
): CollapseFixture {
	const chatPanel = new FakeElement();
	const resizeHandle = new FakeElement();
	const collapseButton = new FakeElement();
	const stickerOpener = new FakeElement();
	const state: PanelLayoutState = {
		preferredDock,
		sideSize,
		verticalSize,
		collapsed,
	};
	let collapsedChangeCount = 0;
	let expandCount = 0;

	const refreshCollapse = initializePanelCollapse(
		{
			chatPanel: chatPanel.asHtmlElement(),
			resizeHandle: resizeHandle.asHtmlElement(),
			collapseButton: collapseButton.asHtmlElement(),
			stickerOpener: stickerOpener.asHtmlElement(),
		},
		state,
		() => collapsedChangeCount++,
		() => expandCount++,
	);

	return {
		chatPanel,
		resizeHandle,
		collapseButton,
		stickerOpener,
		state,
		refreshCollapse,
		getCollapsedChangeCount: () => collapsedChangeCount,
		getExpandCount: () => expandCount,
	};
}

class FakeElement {
	readonly dataset = {} as DOMStringMap;
	hidden = false;
	inert = false;
	private readonly listeners = new Map<string, () => void>();

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, listener);
	}

	click(): void {
		this.listeners.get('click')?.();
	}
}
