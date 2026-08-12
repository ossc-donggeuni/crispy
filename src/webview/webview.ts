import { initializePanelDock, type PanelLayoutState } from './panelDock';
import { initializePanelResize } from './panelResize';

/**
 * CSS 선택자에 해당하는 필수 DOM 요소를 조회한다.
 * 요소가 없으면 Webview 마크업 구성이 잘못된 것으로 간주하고 오류를 발생시킨다.
 *
 * @param selector 조회할 DOM 요소의 CSS 선택자
 * @returns 선택자와 일치하는 DOM 요소
 */
function getRequiredElement<T extends HTMLElement>(selector: string): T {
	const element = document.querySelector<T>(selector);

	if (!element) {
		throw new Error(`Missing Webview element: ${selector}`);
	}

	return element;
}

const layout = getRequiredElement<HTMLElement>('.crispy-layout');
const dragHandle = getRequiredElement<HTMLButtonElement>('#chat-drag-handle');
const resizeHandle = getRequiredElement<HTMLElement>('#panel-resize-handle');
const dockPreview = getRequiredElement<HTMLElement>('#dock-preview');

// 기본 Panel size, status 설정
const state: PanelLayoutState = {
	preferredDock: 'right',
	effectiveDock: 'right',
	sideSize: 360,
	verticalSize: 300,
};

// Dock 초기화
const refreshDock = initializePanelDock(layout, dragHandle, dockPreview, state);
// Resize 초기화
initializePanelResize(layout, resizeHandle, state, refreshDock);
