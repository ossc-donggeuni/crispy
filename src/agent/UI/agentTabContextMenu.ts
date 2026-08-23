import type { AgentTabId, AgentTabSnapshot } from './agentTabModel';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

export const AGENT_TAB_RENAME_MENU_LABEL = '이름 변경';
export const AGENT_TAB_PIN_MENU_LABEL = '고정';
export const AGENT_TAB_UNPIN_MENU_LABEL = '고정 해제';

export interface AgentTabContextMenuCallbacks {
	onRename(tabId: AgentTabId): void;
	onTogglePinned(tabId: AgentTabId, pinned: boolean): void;
	onClosed(tabId: AgentTabId): void;
}

export interface AgentTabContextMenu {
	open(
		tab: AgentTabSnapshot,
		returnFocus: HTMLElement,
		anchor?: { readonly x: number; readonly y: number },
	): void;
	syncTabs(tabs: readonly AgentTabSnapshot[]): void;
	close(restoreFocus?: boolean): void;
	dispose(): void;
}

/** Webview viewport와 Agent Panel 표시 영역의 교집합 안으로 메뉴를 보정한다. */
function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/** 탭 우클릭 및 키보드 메뉴를 Webview 안에서 표시한다. */
export function createAgentTabContextMenu(
	host: HTMLElement,
	callbacks: AgentTabContextMenuCallbacks,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentTabContextMenu {
	let targetTabId: AgentTabId | undefined;
	let returnFocusElement: HTMLElement | undefined;
	let menuElement: HTMLElement | undefined;
	let menuItems: HTMLElement[] = [];
	let requestedPosition: { x: number; y: number } | undefined;
	let disposed = false;

	const positionMenu = (): boolean => {
		if (menuElement === undefined || requestedPosition === undefined) {
			return false;
		}

		try {
			const viewport = dependencies.getViewportSize();
			const panelElement = host.parentElement ?? host;
			const panel = dependencies.getElementRect(panelElement);
			const menu = dependencies.getElementRect(menuElement);
			const leftBoundary = Math.max(0, panel.left);
			const topBoundary = Math.max(0, panel.top);
			const rightBoundary = Math.min(viewport.width, panel.right);
			const bottomBoundary = Math.min(viewport.height, panel.bottom);
			const width = menu.width > 0 ? menu.width : 140;
			const height = menu.height > 0 ? menu.height : 64;
			if (rightBoundary <= leftBoundary || bottomBoundary <= topBoundary) {
				return false;
			}

			menuElement.style.left = `${clamp(
				requestedPosition.x,
				leftBoundary,
				rightBoundary - width,
			)}px`;
			menuElement.style.top = `${clamp(
				requestedPosition.y,
				topBoundary,
				bottomBoundary - height,
			)}px`;
			return true;
		} catch {
			return false;
		}
	};

	const close = (restoreFocus = true): void => {
		const closedTabId = targetTabId;
		const focusTarget = returnFocusElement;
		targetTabId = undefined;
		returnFocusElement = undefined;
		menuElement = undefined;
		menuItems = [];
		requestedPosition = undefined;
		try {
			host.hidden = true;
			host.replaceChildren();
		} catch {
			/** 메뉴 제거 실패가 탭 상태로 전파되지 않게 한다. */
		}
		if (restoreFocus) {
			try {
				focusTarget?.focus();
			} catch {
				/** focus 복귀 실패는 메뉴 상태 정리를 막지 않는다. */
			}
		}
		if (closedTabId !== undefined) {
			callbacks.onClosed(closedTabId);
		}
	};

	const removePointerListener = dependencies.addDocumentListener(
		'pointerdown',
		(event) => {
			if (
				targetTabId !== undefined
				&& !host.contains(event.target as Node | null)
			) {
				close();
			}
		},
	);
	const removeScrollListener = dependencies.addDocumentListener('scroll', () => {
		if (targetTabId !== undefined) {
			close();
		}
	});
	const removeResizeListener = dependencies.addWindowListener('resize', () => {
		if (targetTabId !== undefined && !positionMenu()) {
			close();
		}
	});

	return {
		open(tab, returnFocus, anchor): void {
			if (disposed) {
				return;
			}
			if (targetTabId !== undefined) {
				close(false);
			}

			targetTabId = tab.id;
			returnFocusElement = returnFocus;

			const menu = dependencies.createElement('div');
			menu.className = 'agent-tab-context-menu';
			menu.setAttribute('role', 'menu');
			menu.setAttribute('aria-label', `${tab.displayName} 탭 메뉴`);

			const renameItem = dependencies.createElement('button');
			renameItem.type = 'button';
			renameItem.className = 'agent-tab-context-menu-item';
			renameItem.textContent = AGENT_TAB_RENAME_MENU_LABEL;
			renameItem.setAttribute('role', 'menuitem');

			const pinItem = dependencies.createElement('button');
			pinItem.type = 'button';
			pinItem.className = 'agent-tab-context-menu-item';
			pinItem.textContent = tab.isPinned
				? AGENT_TAB_UNPIN_MENU_LABEL
				: AGENT_TAB_PIN_MENU_LABEL;
			pinItem.setAttribute('role', 'menuitem');

			renameItem.addEventListener('click', () => {
				const tabId = targetTabId;
				if (tabId === undefined) {
					return;
				}
				close(false);
				callbacks.onRename(tabId);
			});
			pinItem.addEventListener('click', () => {
				const tabId = targetTabId;
				if (tabId === undefined) {
					return;
				}
				close(false);
				callbacks.onTogglePinned(tabId, !tab.isPinned);
			});

			menuItems = [renameItem, pinItem];
			menu.addEventListener('keydown', (event) => {
				const keyboardEvent = event as KeyboardEvent;
				const currentIndex = Math.max(
					0,
					menuItems.indexOf(dependencies.getActiveElement() as HTMLElement),
				);
				let nextIndex: number | undefined;
				switch (keyboardEvent.key) {
					case 'ArrowDown':
						nextIndex = (currentIndex + 1) % menuItems.length;
						break;
					case 'ArrowUp':
						nextIndex = (currentIndex - 1 + menuItems.length) % menuItems.length;
						break;
					case 'Home':
						nextIndex = 0;
						break;
					case 'End':
						nextIndex = menuItems.length - 1;
						break;
					case 'Escape':
					case 'Tab':
						keyboardEvent.preventDefault();
						close();
						return;
					case 'Enter':
					case ' ':
						keyboardEvent.preventDefault();
						menuItems[currentIndex]?.click();
						return;
					default:
						return;
				}

				keyboardEvent.preventDefault();
				menuItems[nextIndex]?.focus();
			});

			menu.append(renameItem, pinItem);
			menuElement = menu;
			try {
				const focusRect = dependencies.getElementRect(returnFocus);
				requestedPosition = anchor ?? { x: focusRect.left, y: focusRect.bottom };
				host.replaceChildren(menu);
				host.hidden = false;
				if (!positionMenu()) {
					close();
					return;
				}
				renameItem.focus();
			} catch {
				close();
			}
		},

		syncTabs(tabs): void {
			if (
				targetTabId !== undefined
				&& !tabs.some((tab) => tab.id === targetTabId)
			) {
				close(false);
			}
		},

		close,

		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			close(false);
			removePointerListener();
			removeScrollListener();
			removeResizeListener();
		},
	};
}
