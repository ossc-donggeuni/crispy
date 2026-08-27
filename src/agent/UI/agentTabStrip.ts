import type {
	AgentTabId,
	AgentTabModelSnapshot,
	AgentTabSnapshot,
} from './agentTabModel';
import { AGENT_PROVIDER_LABELS } from './agentProviders';
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

const TAB_STRIP_DRAG_THRESHOLD_PX = 4;
const WHEEL_LINE_HEIGHT_PX = 16;

interface TabStripDragState {
	readonly pointerId: number;
	readonly startClientX: number;
	readonly startScrollLeft: number;
	moved: boolean;
}

/**
 * 가로 overflow를 Windows 마우스 휠, 터치패드 가로 제스처와 grab drag로 탐색한다.
 * deltaX가 있는 터치패드 입력은 그대로 유지하고, 세로 휠만 deltaY를 가로축에 쓴다.
 */
function initializeAgentTabStripNavigation(
	container: HTMLElement,
	onNavigate: () => void,
): () => void {
	let dragState: TabStripDragState | undefined;
	let suppressNextClick = false;
	let clickSuppressionTimeout: ReturnType<typeof setTimeout> | undefined;

	const getMaxScrollLeft = (): number => Math.max(
		0,
		container.scrollWidth - container.clientWidth,
	);
	const clampScrollLeft = (scrollLeft: number): number => Math.min(
		getMaxScrollLeft(),
		Math.max(0, scrollLeft),
	);

	const handleWheel = (event: WheelEvent): void => {
		/** Ctrl+wheel은 Webview 확대/축소 입력으로 남겨 둔다. */
		if (event.ctrlKey) {
			return;
		}

		const rawDelta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
		if (rawDelta === 0) {
			return;
		}

		const deltaScale = event.deltaMode === 1
			? WHEEL_LINE_HEIGHT_PX
			: event.deltaMode === 2
				? Math.max(1, container.clientWidth)
				: 1;
		const nextScrollLeft = clampScrollLeft(
			container.scrollLeft + rawDelta * deltaScale,
		);
		if (nextScrollLeft === container.scrollLeft) {
			return;
		}

		container.scrollLeft = nextScrollLeft;
		event.preventDefault();
		onNavigate();
	};

	const releaseDrag = (pointerId: number, releaseCapture: boolean): void => {
		if (dragState?.pointerId !== pointerId) {
			return;
		}

		dragState = undefined;
		delete container.dataset.scrollDragging;
		if (!releaseCapture) {
			return;
		}

		try {
			if (container.hasPointerCapture(pointerId)) {
				container.releasePointerCapture(pointerId);
			}
		} catch {
			/** Webview가 capture를 먼저 잃어도 drag 종료 상태는 유지한다. */
		}
	};

	const handlePointerDown = (event: PointerEvent): void => {
		if (
			event.button !== 0
			|| event.isPrimary === false
			|| getMaxScrollLeft() === 0
		) {
			return;
		}

		dragState = {
			pointerId: event.pointerId,
			startClientX: event.clientX,
			startScrollLeft: container.scrollLeft,
			moved: false,
		};
	};

	const handlePointerMove = (event: PointerEvent): void => {
		const currentDrag = dragState;
		if (currentDrag === undefined || currentDrag.pointerId !== event.pointerId) {
			return;
		}

		const distance = event.clientX - currentDrag.startClientX;
		if (!currentDrag.moved && Math.abs(distance) < TAB_STRIP_DRAG_THRESHOLD_PX) {
			return;
		}

		if (!currentDrag.moved) {
			currentDrag.moved = true;
			container.dataset.scrollDragging = 'true';
			try {
				/** 짧은 click의 target을 보존하도록 실제 drag가 시작된 뒤에만 capture한다. */
				container.setPointerCapture(event.pointerId);
			} catch {
				/** capture 미지원 환경에서도 container 안의 drag는 계속 처리한다. */
			}
			onNavigate();
		}
		container.scrollLeft = clampScrollLeft(
			currentDrag.startScrollLeft - distance,
		);
		event.preventDefault();
	};

	const handlePointerUp = (event: PointerEvent): void => {
		const currentDrag = dragState;
		if (currentDrag === undefined || currentDrag.pointerId !== event.pointerId) {
			return;
		}

		if (currentDrag.moved) {
			suppressNextClick = true;
			if (clickSuppressionTimeout !== undefined) {
				clearTimeout(clickSuppressionTimeout);
			}
			clickSuppressionTimeout = setTimeout(() => {
				suppressNextClick = false;
				clickSuppressionTimeout = undefined;
			}, 0);
			event.preventDefault();
		}
		releaseDrag(event.pointerId, true);
	};

	const handlePointerCancel = (event: PointerEvent): void => {
		releaseDrag(event.pointerId, true);
	};
	const handleLostPointerCapture = (event: PointerEvent): void => {
		releaseDrag(event.pointerId, false);
	};
	const handleClickCapture = (event: MouseEvent): void => {
		if (!suppressNextClick) {
			return;
		}

		suppressNextClick = false;
		if (clickSuppressionTimeout !== undefined) {
			clearTimeout(clickSuppressionTimeout);
			clickSuppressionTimeout = undefined;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	container.addEventListener('wheel', handleWheel, { passive: false });
	container.addEventListener('pointerdown', handlePointerDown);
	container.addEventListener('pointermove', handlePointerMove);
	container.addEventListener('pointerup', handlePointerUp);
	container.addEventListener('pointercancel', handlePointerCancel);
	container.addEventListener('lostpointercapture', handleLostPointerCapture);
	container.addEventListener('click', handleClickCapture, true);

	return () => {
		container.removeEventListener('wheel', handleWheel);
		container.removeEventListener('pointerdown', handlePointerDown);
		container.removeEventListener('pointermove', handlePointerMove);
		container.removeEventListener('pointerup', handlePointerUp);
		container.removeEventListener('pointercancel', handlePointerCancel);
		container.removeEventListener('lostpointercapture', handleLostPointerCapture);
		container.removeEventListener('click', handleClickCapture, true);
		if (clickSuppressionTimeout !== undefined) {
			clearTimeout(clickSuppressionTimeout);
		}
		if (dragState !== undefined) {
			releaseDrag(dragState.pointerId, true);
		}
	};
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
	const disposeNavigation = initializeAgentTabStripNavigation(
		container,
		closeMenuOnStripScroll,
	);

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
				if (tab.sessionColor !== undefined) {
					tabElement.style.setProperty('--agent-tab-session-color', tab.sessionColor);
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
			disposeNavigation();
			container.removeEventListener('scroll', closeMenuOnStripScroll);
			contextMenu.dispose();
			tabButtons.clear();
			container.replaceChildren();
			container.removeAttribute('role');
		},
	};
}
