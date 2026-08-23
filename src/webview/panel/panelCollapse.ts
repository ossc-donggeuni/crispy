import type { DockPosition, PanelLayoutState } from './panelState';

/** Chat 접기와 Sticker 열기가 함께 다루는 요소 모음이다. */
export interface PanelCollapseElements {
	/** 접기 상태에 따라 숨기는 Floating Chat Panel 요소다. */
	readonly chatPanel: HTMLElement;

	/** Chat Panel과 함께 숨기는 Resize Handle 요소다. */
	readonly resizeHandle: HTMLElement;

	/** Chat Header에서 Panel을 접는 버튼이다. */
	readonly collapseButton: HTMLElement;

	/** 접힘 상태에서 현재 Dock 가장자리에 표시하는 Sticker 열기 버튼이다. */
	readonly stickerOpener: HTMLElement;
}

/** Dock 방향별 접기 버튼 SVG이며 Panel이 접히는 방향을 가리킨다. */
const COLLAPSE_ICON_ASSETS: Readonly<Record<DockPosition, string>> = {
	left: 'panel-left.svg',
	right: 'panel-right.svg',
	top: 'panel-up.svg',
	bottom: 'panel-down.svg',
};

/** Dock 방향별 Sticker SVG이며 Panel이 다시 열리는 방향을 가리킨다. */
const OPENER_ICON_ASSETS: Readonly<Record<DockPosition, string>> = {
	left: 'panel-right.svg',
	right: 'panel-left.svg',
	top: 'panel-down.svg',
	bottom: 'panel-up.svg',
};

/**
 * Chat Header의 접기 버튼과 Dock 가장자리의 Sticker 열기 버튼을 초기화한다.
 *
 * 접어도 저장된 Panel 크기는 그대로 두므로 다시 열면 접기 전 크기를 사용하며,
 * Graph는 접힘 여부와 무관하게 전체 Webview 영역을 계속 사용한다.
 *
 * @param elements 접기 상태를 반영할 Chat Panel, Resize Handle과 두 버튼
 * @param state 현재 Dock 위치와 접힘 여부를 담는 Layout 상태
 * @param onCollapsedChange 접힘 여부가 바뀐 뒤 상태를 저장하는 콜백
 * @param onExpand 다시 펼친 뒤 layout 의존 기능을 갱신하는 콜백
 * @returns Dock 위치가 바뀐 뒤 접힘 UI를 다시 반영하는 함수
 */
export function initializePanelCollapse(
	elements: PanelCollapseElements,
	state: PanelLayoutState,
	onCollapsedChange: () => void,
	onExpand: () => void = () => undefined,
): () => void {
	/**
	 * 첫 렌더에서는 저장된 상태를 즉시 반영하고, 사용자 동작부터 Slide transition을 사용한다.
	 * 접힌 상태로 복원할 때 펼친 Panel이 잠깐 보이는 현상도 함께 막는다.
	 */
	const enableSlideMotion = () => {
		elements.chatPanel.dataset.collapseMotion = 'slide';
		elements.resizeHandle.dataset.collapseMotion = 'slide';
	};

	/**
	 * 현재 접힘 여부와 Dock 방향을 Chat Panel, Resize Handle과 두 버튼에 반영한다.
	 */
	const refreshCollapse = () => {
		const dock = state.preferredDock;
		const collapseState = state.collapsed ? 'collapsed' : 'expanded';

		/**
		 * hidden은 transition을 즉시 끊으므로 Panel과 Handle은 Layout에 유지하고,
		 * CSS의 transform / visibility로 전체 영역을 Dock 바깥까지 이동시킨다.
		 */
		elements.chatPanel.hidden = false;
		elements.resizeHandle.hidden = false;
		elements.chatPanel.inert = state.collapsed;
		elements.chatPanel.dataset.collapseState = collapseState;
		elements.resizeHandle.dataset.collapseState = collapseState;
		elements.stickerOpener.hidden = !state.collapsed;
		elements.stickerOpener.dataset.dock = dock;
		elements.stickerOpener.dataset.panelIcon = OPENER_ICON_ASSETS[dock];
		elements.collapseButton.dataset.panelIcon = COLLAPSE_ICON_ASSETS[dock];
	};

	/**
	 * Chat Panel과 Resize Handle을 숨기고 현재 Dock의 Sticker만 남긴다.
	 */
	const handleCollapse = () => {
		if (state.collapsed) {
			return;
		}

		enableSlideMotion();
		state.collapsed = true;
		refreshCollapse();
		onCollapsedChange();
	};

	/**
	 * 접기 전 Dock 방향과 크기를 그대로 사용해 Chat Panel을 다시 표시한다.
	 */
	const handleExpand = () => {
		if (!state.collapsed) {
			return;
		}

		enableSlideMotion();
		state.collapsed = false;
		refreshCollapse();
		onCollapsedChange();
		onExpand();
	};

	elements.collapseButton.addEventListener('click', handleCollapse);
	elements.stickerOpener.addEventListener('click', handleExpand);
	refreshCollapse();

	return refreshCollapse;
}
