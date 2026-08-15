import {
	createAgentConfirmDialog,
	formatTabCloseConfirmMessage,
	type AgentConfirmDialog,
} from './agentConfirmDialog';
import type { ProviderId } from '../protocol';
import {
	createAgentTabModel,
	type AgentTabId,
	type AgentTabModel,
	type AgentTabModelSnapshot,
} from './agentTabModel';
import { initializeAgentProviderBar } from './agentProviderBar';
import { initializeAgentTabStrip } from './agentTabStrip';
import { initializeAgentTopBar } from './agentTopBar';
import {
	defaultAgentUiDependencies,
	type AgentUiDependencies,
} from './agentUiDom';

/** Agent UI를 구성하는 각 bar와 확인 다이얼로그가 사용하는 컨테이너들이다. */
export interface AgentPanelUiElements {
	/** 새 탭과 재시작 버튼을 담는 상단 bar다. */
	readonly topBar: HTMLElement;

	/** 탭 목록을 담는 strip이다. */
	readonly tabStrip: HTMLElement;

	/** 활성 탭의 provider 드롭다운을 담는 하단 bar다. */
	readonly providerBar: HTMLElement;

	/** 탭 닫기 확인 다이얼로그를 표시하는 컨테이너다. */
	readonly dialogHost: HTMLElement;
}

/**
 * UI 동작이 확정된 뒤 상위 계층으로 전달되는 알림이다.
 *
 * 이 단계에서는 어떤 콜백도 실제 세션을 시작하거나 종료하지 않는다.
 * Phase 2에서 각 콜백을 대응하는 Host 메시지로 연결한다.
 */
export interface AgentPanelUiCallbacks {
	/** 새 탭이 provider 미선택 상태로 만들어졌다. */
	onTabCreated?(tabId: AgentTabId): void;

	/** 활성 탭이 다른 탭으로 바뀌었다. */
	onTabActivated?(tabId: AgentTabId): void;

	/** 드롭다운으로 탭의 provider가 정해졌다. */
	onProviderSelected?(tabId: AgentTabId, providerId: ProviderId): void;

	/**
	 * 재시작 버튼으로 활성 탭의 세션 재시작을 요청했다.
	 * provider는 그대로 유지되므로 provider 전환 경로와 구분된다.
	 */
	onSessionRestartRequested?(
		tabId: AgentTabId,
		providerId: ProviderId,
	): void;

	/** 확인 다이얼로그에서 사용자가 닫기를 확정해 탭이 제거되었다. */
	onTabClosed?(tabId: AgentTabId): void;

	/** 탭 목록이나 활성 탭이 바뀌어 Agent 영역 layout이 달라질 수 있다. */
	onLayoutChange?(): void;
}

/** Agent UI 뼈대를 다루는 최소 제어 경계다. */
export interface AgentPanelUiController {
	/** 각 bar와 탭 strip이 공유하는 탭 상태다. */
	readonly model: AgentTabModel;

	/** 현재 탭 상태 snapshot을 반환한다. */
	getSnapshot(): AgentTabModelSnapshot;

	/** 각 bar, 탭 strip과 확인 다이얼로그를 정리한다. */
	dispose(): void;
}

/** 확인 다이얼로그 생성을 테스트에서 대체하기 위한 의존성 경계다. */
export interface AgentPanelUiDependencies extends AgentUiDependencies {
	createConfirmDialog(
		host: HTMLElement,
		dependencies: AgentUiDependencies,
	): AgentConfirmDialog;
}

const defaultPanelDependencies: AgentPanelUiDependencies = {
	...defaultAgentUiDependencies,
	createConfirmDialog: (host, dependencies) =>
		createAgentConfirmDialog(host, dependencies),
};

/**
 * Agent 영역에 상단 bar, 탭 strip과 하단 provider bar를 얹고 탭 상태와 연결한다.
 *
 * 탭을 다루는 동작은 위쪽에, 활성 탭의 provider 선택은 아래쪽에 둔다.
 * 이 단계는 UI 뼈대만 다루므로 상태 전이는 Webview 안에서만 일어나고
 * 기존 xterm 영역의 DOM 구조나 Terminal 세션 동작에는 관여하지 않는다.
 * 콜백 실패는 이 경계 안에서 격리하여 Graph, Dock, Layout으로 전파하지 않는다.
 *
 * @param elements 각 bar와 확인 다이얼로그가 사용할 컨테이너
 * @param callbacks 확정된 UI 동작을 전달받는 콜백
 * @param dependencies DOM 생성과 확인 다이얼로그 생성 의존성
 * @returns 탭 상태와 정리를 노출하는 제어 객체
 */
export function initializeAgentPanelUi(
	elements: AgentPanelUiElements,
	callbacks: AgentPanelUiCallbacks = {},
	dependencies: AgentPanelUiDependencies = defaultPanelDependencies,
): AgentPanelUiController {
	const model = createAgentTabModel();
	const confirmDialog = dependencies.createConfirmDialog(
		elements.dialogHost,
		dependencies,
	);
	let disposed = false;

	/**
	 * 상위 계층 콜백을 호출하고 실패를 UI 경계 안에 격리한다.
	 *
	 * @param invoke 실행할 콜백 호출
	 */
	const notify = (invoke: () => void): void => {
		try {
			invoke();
		} catch {
			// 상위 계층 콜백 실패가 나머지 Webview 기능으로 전파되지 않게 한다.
		}
	};

	/**
	 * 활성 탭 snapshot을 찾는다.
	 *
	 * @returns 활성 탭이며 없으면 `undefined`
	 */
	const getActiveTab = () => {
		const snapshot = model.getSnapshot();
		return snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
	};

	const providerBar = initializeAgentProviderBar(
		elements.providerBar,
		{
			onProviderSelect(providerId): void {
				const activeTab = getActiveTab();
				if (activeTab === undefined) {
					return;
				}

				model.assignProvider(activeTab.id, providerId);
				notify(() => callbacks.onProviderSelected?.(activeTab.id, providerId));
			},
		},
		dependencies,
	);

	const topBar = initializeAgentTopBar(
		elements.topBar,
		{
			onCreateTab(): void {
				const tabId = model.createTab();
				notify(() => callbacks.onTabCreated?.(tabId));
			},

			onRestartActiveTab(): void {
				/* provider 전환과 달리 현재 provider를 유지한 채 세션만 다시 시작한다. */
				const activeTab = getActiveTab();
				const providerId = activeTab?.providerId;
				if (activeTab === undefined || providerId === undefined) {
					return;
				}

				notify(() => callbacks.onSessionRestartRequested?.(
					activeTab.id,
					providerId,
				));
			},
		},
		dependencies,
	);

	const tabStrip = initializeAgentTabStrip(
		elements.tabStrip,
		{
			onSelectTab(tabId): void {
				if (model.getSnapshot().activeTabId === tabId) {
					return;
				}

				model.selectTab(tabId);
				notify(() => callbacks.onTabActivated?.(tabId));
			},

			onRequestCloseTab(tabId): void {
				const tab = model.getSnapshot().tabs.find((entry) => entry.id === tabId);
				if (tab === undefined) {
					return;
				}

				/* 실제 프로세스 실행 여부를 알 수 없으므로 항상 확인을 받는다. */
				void confirmDialog
					.confirm(formatTabCloseConfirmMessage(tab.label))
					.then((confirmed) => {
						if (!confirmed || disposed) {
							return;
						}

						model.closeTab(tabId);
						notify(() => callbacks.onTabClosed?.(tabId));
					})
					.catch(() => {
						// 확인 다이얼로그 실패는 탭을 닫지 않은 상태로 그대로 둔다.
					});
			},
		},
		dependencies,
	);

	const unsubscribe = model.subscribe((snapshot) => {
		topBar.render(snapshot);
		tabStrip.render(snapshot);
		providerBar.render(snapshot);
		notify(() => callbacks.onLayoutChange?.());
	});

	/* 첫 탭은 provider 미선택 상태로 시작하며 기존 Terminal 영역과 나란히 표시된다. */
	const initialTabId = model.createTab();
	notify(() => callbacks.onTabCreated?.(initialTabId));

	return {
		model,
		getSnapshot: () => model.getSnapshot(),
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			const cleanupActions = [
				() => unsubscribe(),
				() => confirmDialog.dispose(),
				() => topBar.dispose(),
				() => tabStrip.dispose(),
				() => providerBar.dispose(),
			];
			for (const cleanup of cleanupActions) {
				try {
					cleanup();
				} catch {
					// 한 정리 실패가 나머지 Agent UI 정리를 막지 않게 한다.
				}
			}
		},
	};
}
