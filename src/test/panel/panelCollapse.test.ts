import * as assert from 'assert';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
	initializePanelCollapse,
	PANEL_COLLAPSE_TRACKING_MAX_MS,
	type PanelCollapseAnimationFrameScheduler,
	type PanelCollapseController,
} from '../../webview/panel/panelCollapse';
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

	test('하나의 Toggle만 두 상태에서 같은 규격을 유지하고 Panel 경계와 Dock 가장자리를 오간다', () => {
		const webviewCss = readFileSync(resolve(
			__dirname,
			'../../../src/webview/webview.css',
		), 'utf8');
		const extensionSource = readFileSync(resolve(
			__dirname,
			'../../../src/extension.ts',
		), 'utf8');

		assert.strictEqual(
			extensionSource.match(/id="chat-panel-toggle"/g)?.length,
			1,
		);
		assert.ok(!extensionSource.includes('id="chat-collapse-toggle"'));
		assert.ok(!extensionSource.includes('id="chat-sticker-opener"'));
		assert.match(
			webviewCss,
			/#chat-panel-toggle\[data-dock='left'\],[\s\S]*?width: 18px;[\s\S]*?height: 48px;/,
		);
		assert.match(
			webviewCss,
			/#chat-panel-toggle\[data-dock='top'\],[\s\S]*?width: 48px;[\s\S]*?height: 18px;/,
		);
		const collapsedInsets: Readonly<Record<DockPosition, string>> = {
			left: 'left',
			right: 'right',
			top: 'top',
			bottom: 'bottom',
		};

		for (const [dock, inset] of Object.entries(collapsedInsets)) {
			const selector = `#chat-panel-toggle[data-dock='${dock}'][data-collapse-state='collapsed']`;
			const ruleStart = webviewCss.indexOf(selector);
			const ruleEnd = webviewCss.indexOf('}', ruleStart);

			assert.ok(ruleStart >= 0);
			assert.ok(ruleEnd > ruleStart);
			assert.ok(webviewCss.slice(ruleStart, ruleEnd).includes(`${inset}: 0;`));
			assert.ok(!webviewCss.slice(ruleStart, ruleEnd).includes('transform'));
			assert.ok(!webviewCss.slice(ruleStart, ruleEnd).includes(
				dock === 'left' || dock === 'right'
					? 'var(--chat-side-display)'
					: 'var(--chat-vertical-display)',
			));
		}
	});

	test('펼침 상태에서 Chat Panel, Resize Handle과 단일 Toggle을 표시한다', () => {
		const fixture = createCollapseFixture('right');

		assert.strictEqual(fixture.chatPanel.hidden, false);
		assert.strictEqual(fixture.resizeHandle.hidden, false);
		assert.strictEqual(fixture.toggleButton.hidden, false);
		assert.strictEqual(fixture.chatPanel.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.resizeHandle.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.toggleButton.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.toggleButton.dataset.panelIcon, 'panel-right.svg');
		assert.strictEqual(fixture.toggleButton.getAttribute('aria-expanded'), 'true');
		assert.strictEqual(fixture.chatPanel.inert, false);
		assert.strictEqual(fixture.state.collapsed, false);
	});

	test('단일 Toggle은 Chat Panel과 함께 Dock 가장자리로 Slide하고 열기 동작으로 바뀐다', () => {
		const fixture = createCollapseFixture('right');

		fixture.toggleButton.click();

		assert.strictEqual(fixture.state.collapsed, true);
		assert.strictEqual(fixture.chatPanel.hidden, false);
		assert.strictEqual(fixture.resizeHandle.hidden, false);
		assert.strictEqual(fixture.chatPanel.dataset.collapseState, 'collapsed');
		assert.strictEqual(fixture.resizeHandle.dataset.collapseState, 'collapsed');
		assert.strictEqual(fixture.chatPanel.dataset.collapseMotion, 'slide');
		assert.strictEqual(fixture.resizeHandle.dataset.collapseMotion, 'slide');
		assert.strictEqual(fixture.toggleButton.dataset.collapseMotion, 'slide');
		assert.strictEqual(fixture.toggleButton.dataset.collapseState, 'collapsed');
		assert.strictEqual(fixture.chatPanel.inert, true);
		assert.strictEqual(fixture.toggleButton.hidden, false);
		assert.strictEqual(fixture.toggleButton.dataset.panelIcon, 'panel-left.svg');
		assert.strictEqual(fixture.toggleButton.getAttribute('aria-expanded'), 'false');
		assert.strictEqual(fixture.getCollapsedChangeCount(), 1);
		assert.strictEqual(fixture.getExpandCount(), 0);
	});

	test('단일 Toggle은 Dock과 접힘 상태에 맞는 아이콘을 사용한다', () => {
		const openerIcons: Record<DockPosition, string> = {
			left: 'panel-right.svg',
			right: 'panel-left.svg',
			top: 'panel-down.svg',
			bottom: 'panel-up.svg',
		};

		for (const dock of ['left', 'right', 'top', 'bottom'] as const) {
			const fixture = createCollapseFixture(dock);

			fixture.toggleButton.click();

			assert.strictEqual(fixture.toggleButton.hidden, false);
			assert.strictEqual(fixture.toggleButton.dataset.dock, dock);
			assert.strictEqual(
				fixture.toggleButton.dataset.panelIcon,
				openerIcons[dock],
			);
		}
	});

	test('접힌 상태에서도 저장된 Panel 크기를 그대로 둔다', () => {
		const fixture = createCollapseFixture('bottom', 520, 340);

		fixture.toggleButton.click();

		assert.strictEqual(fixture.state.sideSize, 520);
		assert.strictEqual(fixture.state.verticalSize, 340);
		assert.strictEqual(fixture.state.preferredDock, 'bottom');
	});

	test('같은 Toggle을 다시 누르면 같은 Dock과 크기로 Chat Panel을 복원한다', () => {
		const fixture = createCollapseFixture('left', 520, 340);

		fixture.toggleButton.click();
		fixture.toggleButton.click();

		assert.strictEqual(fixture.state.collapsed, false);
		assert.strictEqual(fixture.state.preferredDock, 'left');
		assert.strictEqual(fixture.state.sideSize, 520);
		assert.strictEqual(fixture.state.verticalSize, 340);
		assert.strictEqual(fixture.chatPanel.hidden, false);
		assert.strictEqual(fixture.resizeHandle.hidden, false);
		assert.strictEqual(fixture.chatPanel.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.resizeHandle.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.chatPanel.inert, false);
		assert.strictEqual(fixture.toggleButton.hidden, false);
		assert.strictEqual(fixture.toggleButton.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.toggleButton.dataset.panelIcon, 'panel-left.svg');
		assert.strictEqual(fixture.getCollapsedChangeCount(), 2);
		assert.strictEqual(fixture.getExpandCount(), 1);
	});

	test('외부 이벤트도 제어 경계를 통해 접힌 Panel을 같은 동작으로 펼친다', () => {
		const fixture = createCollapseFixture(
			'bottom',
			INITIAL_SIDE_SIZE,
			INITIAL_VERTICAL_SIZE,
			true,
		);

		fixture.refreshCollapse.expand();

		assert.strictEqual(fixture.state.collapsed, false);
		assert.strictEqual(fixture.chatPanel.dataset.collapseMotion, 'slide');
		assert.strictEqual(fixture.chatPanel.dataset.collapseState, 'expanded');
		assert.strictEqual(fixture.getCollapsedChangeCount(), 1);
		assert.strictEqual(fixture.getExpandCount(), 1);
	});

	test('Chat transform의 실제 frame마다 Overlay 갱신을 전달하고 종료 시 정리한다', () => {
		const fixture = createCollapseFixture('right');

		fixture.toggleButton.click();
		assert.strictEqual(fixture.getTransitionFrameCount(), 1);
		assert.strictEqual(fixture.scheduler.pendingCount, 1);

		fixture.scheduler.runNext(0);
		fixture.scheduler.runNext(120);
		assert.strictEqual(fixture.getTransitionFrameCount(), 3);

		fixture.chatPanel.dispatchTransitionEnd('visibility');
		assert.strictEqual(fixture.getTransitionFrameCount(), 3);
		assert.strictEqual(fixture.scheduler.pendingCount, 1);

		fixture.chatPanel.dispatchTransitionEnd('transform');
		assert.strictEqual(fixture.getTransitionFrameCount(), 4);
		assert.strictEqual(fixture.scheduler.pendingCount, 0);
	});

	test('transitionend가 없어도 추적 상한 뒤 frame 예약을 종료한다', () => {
		const fixture = createCollapseFixture('bottom');

		fixture.toggleButton.click();
		fixture.scheduler.runNext(10);
		fixture.scheduler.runNext(10 + PANEL_COLLAPSE_TRACKING_MAX_MS);

		assert.strictEqual(fixture.getTransitionFrameCount(), 3);
		assert.strictEqual(fixture.scheduler.pendingCount, 0);
	});

	test('접힌 상태로 복원하면 처음부터 Toggle을 Dock 가장자리 상태로 표시한다', () => {
		const fixture = createCollapseFixture('top', INITIAL_SIDE_SIZE, 340, true);

		assert.strictEqual(fixture.chatPanel.hidden, false);
		assert.strictEqual(fixture.resizeHandle.hidden, false);
		assert.strictEqual(fixture.chatPanel.dataset.collapseState, 'collapsed');
		assert.strictEqual(fixture.resizeHandle.dataset.collapseState, 'collapsed');
		assert.strictEqual(fixture.chatPanel.dataset.collapseMotion, undefined);
		assert.strictEqual(fixture.chatPanel.inert, true);
		assert.strictEqual(fixture.toggleButton.hidden, false);
		assert.strictEqual(fixture.toggleButton.dataset.dock, 'top');
		assert.strictEqual(fixture.toggleButton.dataset.collapseState, 'collapsed');
		assert.strictEqual(fixture.toggleButton.dataset.panelIcon, 'panel-down.svg');
		assert.strictEqual(fixture.getCollapsedChangeCount(), 0);
	});

	test('같은 상태를 다시 요청하면 저장 콜백을 호출하지 않는다', () => {
		const fixture = createCollapseFixture('right');

		fixture.refreshCollapse.expand();
		assert.strictEqual(fixture.getCollapsedChangeCount(), 0);

		fixture.refreshCollapse.collapse();
		fixture.refreshCollapse.collapse();

		assert.strictEqual(fixture.state.collapsed, true);
		assert.strictEqual(fixture.getCollapsedChangeCount(), 1);
	});

	test('Dock과 접힘 상태가 바뀌면 단일 Toggle의 위치 상태와 아이콘을 다시 맞춘다', () => {
		const fixture = createCollapseFixture('right');

		assert.strictEqual(
			fixture.toggleButton.dataset.panelIcon,
			'panel-right.svg',
		);

		fixture.state.preferredDock = 'bottom';
		fixture.refreshCollapse();

		assert.strictEqual(
			fixture.toggleButton.dataset.panelIcon,
			'panel-down.svg',
		);
		assert.strictEqual(fixture.toggleButton.dataset.dock, 'bottom');

		fixture.toggleButton.click();

		assert.strictEqual(
			fixture.toggleButton.dataset.panelIcon,
			'panel-up.svg',
		);
	});
});

interface CollapseFixture {
	chatPanel: FakeElement;
	resizeHandle: FakeElement;
	toggleButton: FakeElement;
	state: PanelLayoutState;
	refreshCollapse: PanelCollapseController;
	getCollapsedChangeCount(): number;
	getExpandCount(): number;
	getTransitionFrameCount(): number;
	readonly scheduler: FakeAnimationFrameScheduler;
}

function createCollapseFixture(
	preferredDock: DockPosition,
	sideSize = INITIAL_SIDE_SIZE,
	verticalSize = INITIAL_VERTICAL_SIZE,
	collapsed = false,
): CollapseFixture {
	const chatPanel = new FakeElement();
	const resizeHandle = new FakeElement();
	const toggleButton = new FakeElement();
	const scheduler = new FakeAnimationFrameScheduler();
	const state: PanelLayoutState = {
		preferredDock,
		sideSize,
		verticalSize,
		collapsed,
	};
	let collapsedChangeCount = 0;
	let expandCount = 0;
	let transitionFrameCount = 0;

	const refreshCollapse = initializePanelCollapse(
		{
			chatPanel: chatPanel.asHtmlElement(),
			resizeHandle: resizeHandle.asHtmlElement(),
			toggleButton: toggleButton.asHtmlElement(),
		},
		state,
		() => collapsedChangeCount++,
		() => expandCount++,
		() => transitionFrameCount++,
		scheduler,
	);

	return {
		chatPanel,
		resizeHandle,
		toggleButton,
		state,
		refreshCollapse,
		getCollapsedChangeCount: () => collapsedChangeCount,
		getExpandCount: () => expandCount,
		getTransitionFrameCount: () => transitionFrameCount,
		scheduler,
	};
}

class FakeAnimationFrameScheduler
	implements PanelCollapseAnimationFrameScheduler {
	private nextRequestId = 1;
	private readonly callbacks = new Map<number, FrameRequestCallback>();

	get pendingCount(): number {
		return this.callbacks.size;
	}

	request(callback: FrameRequestCallback): number {
		const requestId = this.nextRequestId;

		this.nextRequestId += 1;
		this.callbacks.set(requestId, callback);
		return requestId;
	}

	cancel(requestId: number): void {
		this.callbacks.delete(requestId);
	}

	runNext(timestamp: number): void {
		const next = this.callbacks.entries().next().value as
			| [number, FrameRequestCallback]
			| undefined;

		assert.ok(next);
		this.callbacks.delete(next[0]);
		next[1](timestamp);
	}
}

class FakeElement {
	readonly dataset = {} as DOMStringMap;
	hidden = false;
	inert = false;
	private readonly attributes = new Map<string, string>();
	private readonly listeners = new Map<string, (event?: Event) => void>();

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}

	addEventListener(type: string, listener: (event?: Event) => void): void {
		this.listeners.set(type, listener);
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}

	click(): void {
		this.listeners.get('click')?.();
	}

	dispatchTransitionEnd(propertyName: string): void {
		this.listeners.get('transitionend')?.({
			target: this,
			propertyName,
		} as unknown as TransitionEvent);
	}
}
