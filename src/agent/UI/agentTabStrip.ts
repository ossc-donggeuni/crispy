import type {
	AgentTabId,
	AgentTabModelSnapshot,
	AgentTabSnapshot,
} from './agentTabModel';
import {
	AGENT_PROVIDER_LABELS,
	AGENT_PROVIDER_TAB_COLORS,
} from './agentProviders';
import { createAgentTabContextMenu } from './agentTabContextMenu';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

export const AGENT_TAB_CLOSE_LABEL = '×';

export function formatTabCloseTitle(tabLabel: string): string {
	return `Close ${tabLabel}`;
}

/** provider와 위치 고정 상태를 색상 없이도 전달하는 탭 접근성 이름이다. */
export function formatAgentTabAccessibleName(tab: AgentTabSnapshot): string {
	const providerLabel = tab.providerId === undefined
		? 'provider 미선택'
		: AGENT_PROVIDER_LABELS[tab.providerId];
	const workspace = tab.workspaceDescription === undefined
		? ''
		: `, Workspace ${tab.workspaceDescription}`;
	return `${providerLabel}, ${tab.displayName}${workspace}${tab.isPinned ? ', 고정됨' : ''}`;
}

/** 짧은 visible label은 유지하되 hover title에서는 중복 Workspace 이름을 구별한다. */
export function formatAgentTabTitle(tab: AgentTabSnapshot): string {
	return tab.workspaceDescription === undefined
		? tab.displayName
		: `${tab.displayName} — ${tab.workspaceDescription}`;
}

export interface AgentTabStripCallbacks {
	onSelectTab(tabId: AgentTabId): void;
	onRequestCloseTab(tabId: AgentTabId): void;
	onRequestRenameTab(tabId: AgentTabId): void;
	onTogglePinned(tabId: AgentTabId, pinned: boolean): void;
}

export interface AgentTabStripView {
	render(snapshot: AgentTabModelSnapshot): void;
	focusTab(tabId: AgentTabId): void;
	dispose(): void;
}

/** 탭 strip, 마우스/키보드 context menu와 접근성 상태를 함께 관리한다. */
export function initializeAgentTabStrip(
	container: HTMLElement,
	menuHost: HTMLElement,
	callbacks: AgentTabStripCallbacks,
	dependencies: AgentUiDependencies = defaultAgentUiDependencies,
): AgentTabStripView {
	container.setAttribute('role', 'tablist');
	let tabButtons = new Map<AgentTabId, HTMLButtonElement>();
	let focusAfterRenderTabId: AgentTabId | undefined;

	const focusTab = (tabId: AgentTabId): void => {
		try {
			tabButtons.get(tabId)?.focus();
		} catch {
			/** 위치 변경 뒤 focus 복귀 실패가 탭 상태를 바꾸지 않게 한다. */
		}
	};

	const contextMenu = createAgentTabContextMenu(
		menuHost,
		{
			onRename(tabId): void {
				callbacks.onRequestRenameTab(tabId);
			},
			onTogglePinned(tabId, pinned): void {
				focusAfterRenderTabId = tabId;
				callbacks.onTogglePinned(tabId, pinned);
				focusTab(tabId);
			},
			onClosed: () => undefined,
		},
		dependencies,
	);
	const closeMenuOnStripScroll = (): void => contextMenu.close();
	container.addEventListener('scroll', closeMenuOnStripScroll);

	return {
		render(snapshot): void {
			contextMenu.syncTabs(snapshot.tabs);
			const nextTabButtons = new Map<AgentTabId, HTMLButtonElement>();
			const hasPinnedTabs = snapshot.tabs.some((tab) => tab.isPinned);
			const firstUnpinnedIndex = hasPinnedTabs
				? snapshot.tabs.findIndex((tab) => !tab.isPinned)
				: -1;

			const tabElements = snapshot.tabs.map((tab, index) => {
				const tabElement = dependencies.createElement('div');
				tabElement.className = 'agent-tab';
				tabElement.dataset.tabId = tab.id;
				if (tab.providerId !== undefined) {
					tabElement.dataset.provider = tab.providerId;
					const providerColor = AGENT_PROVIDER_TAB_COLORS[tab.providerId];
					if (providerColor !== undefined) {
						tabElement.style.setProperty('--agent-tab-provider-color', providerColor);
					}
				}
				if (tab.isPinned) {
					tabElement.dataset.pinned = 'true';
				}
				if (index === firstUnpinnedIndex) {
					tabElement.dataset.pinnedBoundary = 'true';
				}

				const isActive = tab.id === snapshot.activeTabId;
				if (isActive) {
					tabElement.dataset.active = 'true';
				}

				const selectButton = dependencies.createElement('button');
				selectButton.type = 'button';
				selectButton.className = 'agent-tab-select';
				selectButton.textContent = tab.displayName;
				selectButton.title = formatAgentTabTitle(tab);
				selectButton.setAttribute('role', 'tab');
				selectButton.setAttribute('aria-selected', isActive ? 'true' : 'false');
				selectButton.setAttribute('aria-label', formatAgentTabAccessibleName(tab));
				selectButton.addEventListener('click', (event) => {
					const mouseEvent = event as MouseEvent;
					if (mouseEvent.ctrlKey) {
						mouseEvent.preventDefault();
						contextMenu.open(tab, selectButton, {
							x: mouseEvent.clientX,
							y: mouseEvent.clientY,
						});
						return;
					}
					callbacks.onSelectTab(tab.id);
				});
				selectButton.addEventListener('keydown', (event) => {
					const keyboardEvent = event as KeyboardEvent;
					if (
						keyboardEvent.key === 'ContextMenu'
						|| (keyboardEvent.shiftKey && keyboardEvent.key === 'F10')
					) {
						keyboardEvent.preventDefault();
						contextMenu.open(tab, selectButton);
					}
				});

				const closeButton = dependencies.createElement('button');
				closeButton.type = 'button';
				closeButton.className = 'agent-tab-close';
				closeButton.textContent = AGENT_TAB_CLOSE_LABEL;
				closeButton.title = formatTabCloseTitle(tab.displayName);
				closeButton.setAttribute(
					'aria-label',
					formatTabCloseTitle(tab.displayName),
				);
				closeButton.addEventListener('click', () => {
					callbacks.onRequestCloseTab(tab.id);
				});

				tabElement.addEventListener('contextmenu', (event) => {
					const mouseEvent = event as MouseEvent;
					mouseEvent.preventDefault();
					contextMenu.open(tab, selectButton, {
						x: mouseEvent.clientX,
						y: mouseEvent.clientY,
					});
				});
				tabElement.append(
					selectButton,
					closeButton,
				);
				nextTabButtons.set(tab.id, selectButton);
				return tabElement;
			});

			tabButtons = nextTabButtons;
			container.replaceChildren(...tabElements);
			if (focusAfterRenderTabId !== undefined) {
				const tabId = focusAfterRenderTabId;
				focusAfterRenderTabId = undefined;
				focusTab(tabId);
			}
		},

		focusTab,

		dispose(): void {
			container.removeEventListener('scroll', closeMenuOnStripScroll);
			contextMenu.dispose();
			tabButtons.clear();
			container.replaceChildren();
			container.removeAttribute('role');
		},
	};
}
