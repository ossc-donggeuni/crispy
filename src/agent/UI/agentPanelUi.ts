import {
	createAgentConfirmDialog,
	formatMcpRestartConfirmMessage,
	formatSessionRestartConfirmMessage,
	formatTabCloseConfirmMessage,
	AGENT_RESTART_ACCEPT_LABEL,
	MCP_RESTART_ACCEPT_LABEL,
	type AgentConfirmDialog,
} from './agentConfirmDialog';
import type {
	AgentAssignment,
	HostToWebviewMessage,
	ProviderId,
	SessionId,
	SwitchAttemptId,
	WorkspaceRootId,
} from '../protocol';
import type { WorkspaceRootCatalogEntry } from '../../workspace/workspaceRootCatalog';
import { messageByMcpFailureReason } from '../../mcp/failureReason';
import {
	createAgentTabModel,
	type AgentTabId,
	type AgentTabModel,
	type AgentTabModelSnapshot,
} from './agentTabModel';
import {
	initializeAgentProviderPicker,
	type AgentProviderPickerState,
} from './agentProviderPicker';
import { initializeAgentTabStrip } from './agentTabStrip';
import { createAgentTabRenameDialog } from './agentTabRenameDialog';
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
	/** 탭 우클릭/키보드 메뉴를 Panel 경계 안에 표시하는 host다. */
	readonly tabMenuHost: HTMLElement;

	/** provider 미선택 탭에서 xterm 중앙 선택기를 표시할 host다. */
	readonly providerPicker: HTMLElement;

	/** 탭 닫기 확인 다이얼로그를 표시하는 컨테이너다. */
	readonly dialogHost: HTMLElement;
	/** 수동 이름 변경 dialog를 표시하는 별도 컨테이너다. */
	readonly renameDialogHost: HTMLElement;
}

/**
 * UI 요청과 확정된 동작을 상위 계층으로 전달하는 callback 경계다.
 *
 * 이 단계에서는 어떤 콜백도 실제 세션을 시작하거나 종료하지 않는다.
 * Phase 2에서 각 콜백을 대응하는 Host 메시지로 연결한다.
 */
export interface AgentPanelUiCallbacks {
	/** 새 탭이 provider 미선택 상태로 만들어졌다. */
	onTabCreated?(tabId: AgentTabId): void;

	/** 활성 탭이 다른 탭으로 바뀌었다. */
	onTabActivated?(tabId: AgentTabId): void;

	/** 중앙 선택기의 provider 요청을 상위 계층이 수락했는지 반환한다. */
	onProviderSelected?(
		tabId: AgentTabId,
		providerId: ProviderId,
		workspaceRootId: WorkspaceRootId,
	): SwitchAttemptId | boolean | void;

	/**
	 * 재시작 버튼으로 현재 CLI를 종료하고 provider 재선택을 요청했다.
	 */
	onAgentReselectionRequested?(tabId: AgentTabId): boolean | number | void;

	/** retryable MCP failure 확인 뒤 current tab/session의 명시적 재시작을 요청한다. */
	onMcpRestartRequested?(tabId: AgentTabId, sessionId: SessionId): boolean | void;

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

	/** 탭별 Workspace/provider assignment lifecycle을 immutable snapshot으로 반환한다. */
	getAssignmentState(tabId: AgentTabId): AgentTabAssignmentState | undefined;

	/** atomic Workspace refresh의 새 Catalog 전체를 picker에 한 번에 적용한다. */
	updateWorkspaceRootCatalog(
		catalog: readonly WorkspaceRootCatalogEntry[],
	): void;

	/**
	 * 검증된 Host lifecycle/status를 tab과 session identity에 맞을 때만 반영한다.
	 *
	 * @returns 현재 Webview lifecycle에 유효해 Terminal 표면에도 전달할 메시지인지 여부
	 */
	handleHostMessage(message: HostToWebviewMessage): boolean;

	/** 각 bar, 탭 strip과 확인 다이얼로그를 정리한다. */
	dispose(): void;
}

export interface PendingSwitch {
	readonly providerId: ProviderId;
	readonly workspaceRootId: WorkspaceRootId;
	readonly switchAttemptId: SwitchAttemptId;
}

/** Phase 8 Webview가 탭마다 유지하는 명시적인 assignment 상태다. */
export type AgentTabAssignmentState =
	| {
		readonly kind: 'unassigned';
		readonly selectedWorkspaceRootId: WorkspaceRootId | null;
		readonly pendingSwitch: PendingSwitch | null;
	}
	| {
		readonly kind: 'assigned';
		readonly assignment: AgentAssignment;
		readonly assignmentRevision: number;
		readonly pendingSwitch: PendingSwitch | null;
	}
	| {
		readonly kind: 'resetting';
		readonly previousAssignment: AgentAssignment | null;
		readonly resetBarrierAttemptId: SwitchAttemptId;
	};

export interface AgentPanelUiOptions {
	readonly initialWorkspaceRootCatalog?: readonly WorkspaceRootCatalogEntry[];
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
 * Agent 영역에 상단 bar, 탭 strip과 중앙 provider 선택기를 얹고 탭 상태와 연결한다.
 *
 * 탭을 다루는 동작은 위쪽에, 활성 탭의 provider 선택은 xterm 중앙에 둔다.
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
	options: AgentPanelUiOptions = {},
): AgentPanelUiController {
	const model = createAgentTabModel();
	const confirmDialog = dependencies.createConfirmDialog(
		elements.dialogHost,
		dependencies,
	);
	const renameDialog = createAgentTabRenameDialog(
		elements.renameDialogHost,
		dependencies,
	);
	const assignmentStateByTab = new Map<AgentTabId, AgentTabAssignmentState>();
	const lastIssuedSwitchAttemptByTab = new Map<AgentTabId, SwitchAttemptId>();
	const lastAppliedAssignmentRevisionByTab = new Map<AgentTabId, number>();
	const resetBarrierAttemptByTab = new Map<AgentTabId, SwitchAttemptId>();
	const providerPickerOpenTabs = new Set<AgentTabId>();
	const lastKnownCatalogEntryById = new Map<WorkspaceRootId, WorkspaceRootCatalogEntry>();
	let workspaceRootCatalog = Object.freeze([
		...(options.initialWorkspaceRootCatalog ?? []),
	]) as readonly WorkspaceRootCatalogEntry[];
	let disposed = false;
	let renderViews = (): void => undefined;

	const rememberCatalog = (
		catalog: readonly WorkspaceRootCatalogEntry[],
	): void => {
		for (const entry of catalog) {
			lastKnownCatalogEntryById.set(entry.id, entry);
		}
	};
	rememberCatalog(workspaceRootCatalog);

	const selectWorkspaceForUnassignedTab = (
		selectedWorkspaceRootId: WorkspaceRootId | null,
	): WorkspaceRootId | null => {
		const current = workspaceRootCatalog.find(
			(entry) => entry.id === selectedWorkspaceRootId && entry.selectable,
		);
		if (current !== undefined) {
			return current.id;
		}

		const selectable = workspaceRootCatalog.filter((entry) => entry.selectable);
		return selectable.length === 1 ? selectable[0]!.id : null;
	};

	const createUnassignedState = (
		selectedWorkspaceRootId: WorkspaceRootId | null = null,
	): AgentTabAssignmentState => Object.freeze({
		kind: 'unassigned',
		selectedWorkspaceRootId,
		pendingSwitch: null,
	});

	const getEffectiveCatalog = (
		tabId: AgentTabId | undefined,
	): readonly WorkspaceRootCatalogEntry[] => {
		if (tabId === undefined) {
			return workspaceRootCatalog;
		}
		const state = assignmentStateByTab.get(tabId);
		const assignment = state?.kind === 'assigned'
			? state.assignment
			: state?.kind === 'resetting'
				? state.previousAssignment
				: null;
		if (
			assignment === null
			|| workspaceRootCatalog.some((entry) => entry.id === assignment.workspaceRootId)
		) {
			return workspaceRootCatalog;
		}

		const lastKnown = lastKnownCatalogEntryById.get(assignment.workspaceRootId);
		const tab = model.getSnapshot().tabs.find((entry) => entry.id === tabId);
		const synthetic: WorkspaceRootCatalogEntry = Object.freeze({
			id: assignment.workspaceRootId,
			name: lastKnown?.name ?? tab?.workspaceName ?? 'Unavailable workspace',
			description: lastKnown?.description
				?? tab?.workspaceDescription
				?? assignment.workspaceRootId,
			selectable: false,
			reason: 'workspace_root_unavailable',
		});
		return Object.freeze([...workspaceRootCatalog, synthetic]);
	};

	const workspacePickerStateFor = (tabId: AgentTabId | undefined) => {
		if (tabId === undefined) {
			return undefined;
		}
		const state = assignmentStateByTab.get(tabId);
		if (state === undefined) {
			return undefined;
		}
		if (state.kind === 'unassigned') {
			return {
				selectedWorkspaceRootId: state.selectedWorkspaceRootId,
				locked: false,
				pending: state.pendingSwitch !== null,
				resetting: false,
			};
		}
		if (state.kind === 'assigned') {
			return {
				selectedWorkspaceRootId: state.assignment.workspaceRootId,
				locked: true,
				pending: state.pendingSwitch !== null,
				resetting: false,
			};
		}
		return {
			selectedWorkspaceRootId: state.previousAssignment?.workspaceRootId ?? null,
			locked: true,
			pending: false,
			resetting: true,
		};
	};

	const providerPickerStateFor = (
		tabId: AgentTabId | undefined,
	): AgentProviderPickerState | undefined => {
		if (tabId === undefined) {
			return undefined;
		}
		const state = assignmentStateByTab.get(tabId);
		const workspaceState = workspacePickerStateFor(tabId);
		if (state === undefined || workspaceState === undefined) {
			return undefined;
		}
		return {
			...workspaceState,
			workspaceSelected: state.kind === 'unassigned'
				? state.selectedWorkspaceRootId !== null
				: state.kind === 'assigned'
					? workspaceRootCatalog.some((entry) => (
						entry.id === state.assignment.workspaceRootId
						&& entry.selectable
					))
					: false,
			forceShow: providerPickerOpenTabs.has(tabId),
		};
	};

	/**
	 * 상위 계층 콜백을 호출하고 실패를 UI 경계 안에 격리한다.
	 *
	 * @param invoke 실행할 콜백 호출
	 */
	const notify = (invoke: () => void): void => {
		try {
			invoke();
		} catch {
			/** 상위 계층 콜백 실패가 나머지 Webview 기능으로 전파되지 않게 한다. */
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

	const providerPicker = initializeAgentProviderPicker(
		elements.providerPicker,
		{
			onWorkspaceSelect(workspaceRootId): void {
				const activeTab = getActiveTab();
				if (activeTab === undefined) {
					return;
				}
				const state = assignmentStateByTab.get(activeTab.id);
				const entry = workspaceRootCatalog.find(
					(candidate) => candidate.id === workspaceRootId,
				);
				if (
					state?.kind !== 'unassigned'
					|| state.pendingSwitch !== null
					|| entry?.selectable !== true
				) {
					return;
				}
				assignmentStateByTab.set(activeTab.id, Object.freeze({
					...state,
					selectedWorkspaceRootId: workspaceRootId,
				}));
				renderViews();
			},

			onProviderSelect(providerId): void {
				const activeTab = getActiveTab();
				const assignmentState = activeTab === undefined
					? undefined
					: assignmentStateByTab.get(activeTab.id);
				if (
					activeTab === undefined
					|| assignmentState === undefined
					|| assignmentState.kind === 'resetting'
					|| assignmentState.pendingSwitch !== null
				) {
					return;
				}
				const workspaceRootId = assignmentState.kind === 'assigned'
					? assignmentState.assignment.workspaceRootId
					: assignmentState.selectedWorkspaceRootId;
				if (
					workspaceRootId === null
					|| (
						assignmentState.kind === 'assigned'
						&& !providerPickerOpenTabs.has(activeTab.id)
					)
				) {
					return;
				}
				const selectedEntry = workspaceRootCatalog.find(
					(entry) => entry.id === workspaceRootId,
				);
				if (selectedEntry?.selectable !== true) {
					return;
				}

				let result: SwitchAttemptId | boolean | void;
				try {
					result = callbacks.onProviderSelected?.(
						activeTab.id,
						providerId,
						workspaceRootId,
					);
				} catch {
					result = false;
				}
				if (result === false) {
					return;
				}
				if (
					typeof result === 'number'
					&& Number.isSafeInteger(result)
					&& result > 0
				) {
					const pendingSwitch = Object.freeze({
						providerId,
						workspaceRootId,
						switchAttemptId: result,
					});
					assignmentStateByTab.set(activeTab.id, Object.freeze({
						...assignmentState,
						pendingSwitch,
					}));
					lastIssuedSwitchAttemptByTab.set(activeTab.id, result);
					renderViews();
					return;
				}

				/** 콜백 없는 독립 UI 소비자는 기존 즉시 commit 동작을 유지한다. */
				const assignmentRevision = (
					lastAppliedAssignmentRevisionByTab.get(activeTab.id) ?? 0
				) + 1;
				assignmentStateByTab.set(activeTab.id, Object.freeze({
					kind: 'assigned',
					assignment: Object.freeze({
						providerId,
						workspaceRootId,
					}),
					assignmentRevision,
					pendingSwitch: null,
				}));
				lastAppliedAssignmentRevisionByTab.set(activeTab.id, assignmentRevision);
				model.assignProvider(activeTab.id, providerId, {
					id: selectedEntry.id,
					name: selectedEntry.name,
					description: selectedEntry.description,
					assignmentRevision,
				});
			},
		},
		dependencies,
	);

	const topBar = initializeAgentTopBar(
		elements.topBar,
		{
			onChangeProvider(): void {
				const activeTab = getActiveTab();
				if (activeTab === undefined) {
					return;
				}
				const state = assignmentStateByTab.get(activeTab.id);
				if (state?.kind !== 'assigned' || state.pendingSwitch !== null) {
					return;
				}
				if (providerPickerOpenTabs.has(activeTab.id)) {
					providerPickerOpenTabs.delete(activeTab.id);
				} else {
					providerPickerOpenTabs.add(activeTab.id);
				}
				renderViews();
			},

			onCreateTab(): void {
				const tabId = model.createTab();
				assignmentStateByTab.set(
					tabId,
					createUnassignedState(selectWorkspaceForUnassignedTab(null)),
				);
				renderViews();
				notify(() => callbacks.onTabCreated?.(tabId));
			},

			onRestartActiveTab(): void {
				/** 확인 뒤 현재 탭은 유지하면서 CLI와 provider 배정만 초기화한다. */
				const activeTab = getActiveTab();
				const assignmentState = activeTab === undefined
					? undefined
					: assignmentStateByTab.get(activeTab.id);
				if (
					activeTab === undefined
					|| assignmentState === undefined
					|| assignmentState.kind === 'resetting'
					|| (
						activeTab.providerId === undefined
						&& assignmentState.pendingSwitch === null
					)
				) {
					return;
				}

				void confirmDialog.confirm(
					formatSessionRestartConfirmMessage(activeTab.label),
					AGENT_RESTART_ACCEPT_LABEL,
				).then((confirmed) => {
					if (!confirmed || disposed) {
						return;
					}

					let result: boolean | number | void;
					try {
						result = callbacks.onAgentReselectionRequested?.(activeTab.id);
					} catch {
						result = false;
					}
					if (result === false) {
						return;
					}
					if (result === true) {
						const resetBarrierAttemptId =
							lastIssuedSwitchAttemptByTab.get(activeTab.id) ?? 0;
						resetBarrierAttemptByTab.set(activeTab.id, resetBarrierAttemptId);
						providerPickerOpenTabs.delete(activeTab.id);
						assignmentStateByTab.set(activeTab.id, Object.freeze({
							kind: 'resetting',
							previousAssignment: assignmentState.kind === 'assigned'
								? assignmentState.assignment
								: null,
							resetBarrierAttemptId,
						}));
						renderViews();
						return;
					}

					/** 콜백 없는 독립 UI 소비자는 기존 즉시 Reset 동작을 유지한다. */
					providerPickerOpenTabs.delete(activeTab.id);
					assignmentStateByTab.set(activeTab.id, createUnassignedState());
					model.clearProvider(activeTab.id);
				}).catch(() => {
					/** 확인 다이얼로그 실패 시 현재 세션을 유지한다. */
				});
			},

			onRestartMcpActiveTab(): void {
				const activeTab = getActiveTab();
				if (
					activeTab?.sessionId === undefined
					|| activeTab.mcpStatus.kind !== 'failed'
					|| !activeTab.mcpStatus.retryable
					|| activeTab.mcpRestartPending
				) {
					return;
				}

				const { id: tabId, sessionId } = activeTab;
				model.setMcpRestartPending(tabId, sessionId, true);
				void confirmDialog.confirm(
					formatMcpRestartConfirmMessage(),
					MCP_RESTART_ACCEPT_LABEL,
				).then((confirmed) => {
					if (disposed) {
						return;
					}
					if (!confirmed) {
						model.setMcpRestartPending(tabId, sessionId, false);
						return;
					}

					try {
						if (callbacks.onMcpRestartRequested?.(tabId, sessionId) === false) {
							model.setMcpRestartPending(tabId, sessionId, false);
						}
					} catch {
						model.setMcpRestartPending(tabId, sessionId, false);
					}
				}).catch(() => {
					if (!disposed) {
						model.setMcpRestartPending(tabId, sessionId, false);
					}
				});
			},
		},
		dependencies,
	);

	const tabStrip = initializeAgentTabStrip(
		elements.tabStrip,
		elements.tabMenuHost,
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

				/** 실제 프로세스 실행 여부를 알 수 없으므로 항상 확인을 받는다. */
				void confirmDialog
					.confirm(formatTabCloseConfirmMessage(tab.label))
					.then((confirmed) => {
						if (!confirmed || disposed) {
							return;
						}

						model.closeTab(tabId);
						assignmentStateByTab.delete(tabId);
						providerPickerOpenTabs.delete(tabId);
						lastIssuedSwitchAttemptByTab.delete(tabId);
						lastAppliedAssignmentRevisionByTab.delete(tabId);
						resetBarrierAttemptByTab.delete(tabId);
						notify(() => callbacks.onTabClosed?.(tabId));
					})
					.catch(() => {
						/** 확인 다이얼로그 실패는 탭을 닫지 않은 상태로 그대로 둔다. */
					});
			},

			onRequestRenameTab(tabId): void {
				const tab = model.getSnapshot().tabs.find((entry) => entry.id === tabId);
				if (tab === undefined) {
					return;
				}

				renameDialog.open(
					tabId,
					tab.displayName,
					(value) => model.renameTab(tabId, value),
					() => tabStrip.focusTab(tabId),
				);
			},

			onTogglePinned(tabId, pinned): void {
				model.setPinned(tabId, pinned);
			},
		},
		dependencies,
	);

	const unsubscribe = model.subscribe((snapshot) => {
		const effectiveCatalog = getEffectiveCatalog(snapshot.activeTabId);
		const workspaceState = workspacePickerStateFor(snapshot.activeTabId);
		renameDialog.syncTabs(snapshot.tabs.map((tab) => tab.id));
		topBar.render(snapshot, workspaceState);
		tabStrip.render(snapshot);
		providerPicker.render(
			snapshot,
			effectiveCatalog,
			providerPickerStateFor(snapshot.activeTabId),
		);
		notify(() => callbacks.onLayoutChange?.());
	});
	renderViews = () => {
		const snapshot = model.getSnapshot();
		const workspaceState = workspacePickerStateFor(snapshot.activeTabId);
		topBar.render(snapshot, workspaceState);
		providerPicker.render(
			snapshot,
			getEffectiveCatalog(snapshot.activeTabId),
			providerPickerStateFor(snapshot.activeTabId),
		);
	};

	/** 첫 탭은 provider 미선택 상태로 시작하며 xterm 중앙 선택기를 표시한다. */
	const initialTabId = model.createTab();
	assignmentStateByTab.set(
		initialTabId,
		createUnassignedState(selectWorkspaceForUnassignedTab(null)),
	);
	renderViews();
	notify(() => callbacks.onTabCreated?.(initialTabId));

	return {
		model,
		getSnapshot: () => model.getSnapshot(),
		getAssignmentState: (tabId) => assignmentStateByTab.get(tabId),
		updateWorkspaceRootCatalog(catalog): void {
			if (disposed) {
				return;
			}
			workspaceRootCatalog = Object.freeze([...catalog]);
			rememberCatalog(workspaceRootCatalog);
			for (const [tabId, state] of assignmentStateByTab) {
				if (state.kind === 'unassigned' && state.pendingSwitch === null) {
					assignmentStateByTab.set(tabId, createUnassignedState(
						selectWorkspaceForUnassignedTab(state.selectedWorkspaceRootId),
					));
					continue;
				}
				if (state.kind === 'assigned') {
					const entry = workspaceRootCatalog.find(
						(candidate) => candidate.id === state.assignment.workspaceRootId,
					);
					if (entry !== undefined) {
						model.updateWorkspaceMetadata(tabId, {
							id: entry.id,
							name: entry.name,
							description: entry.description,
							assignmentRevision: state.assignmentRevision,
						});
					}
				}
			}
			renderViews();
		},
		handleHostMessage(message): boolean {
			if (disposed) {
				return false;
			}
			switch (message.type) {
			case 'agent.switchAccepted': {
					const state = assignmentStateByTab.get(message.tabId);
					const pending = state?.kind === 'unassigned'
						|| state?.kind === 'assigned'
						? state.pendingSwitch
						: null;
					const resetBarrier = resetBarrierAttemptByTab.get(message.tabId) ?? 0;
					const lastRevision = lastAppliedAssignmentRevisionByTab.get(
						message.tabId,
					) ?? 0;
					if (
						state?.kind === 'resetting'
						|| message.switchAttemptId <= resetBarrier
						|| message.assignmentRevision <= lastRevision
						|| pending?.switchAttemptId !== message.switchAttemptId
						|| pending.providerId !== message.providerId
						|| pending.workspaceRootId !== message.workspaceRootId
					) {
						return false;
					}
					lastAppliedAssignmentRevisionByTab.set(
						message.tabId,
						message.assignmentRevision,
					);
					providerPickerOpenTabs.delete(message.tabId);
					const assignment = Object.freeze({
						providerId: message.providerId,
						workspaceRootId: message.workspaceRootId,
					});
					assignmentStateByTab.set(message.tabId, Object.freeze({
						kind: 'assigned',
						assignment,
						assignmentRevision: message.assignmentRevision,
						pendingSwitch: null,
					}));
					const entry = lastKnownCatalogEntryById.get(message.workspaceRootId);
					model.assignProvider(message.tabId, message.providerId, {
						id: message.workspaceRootId,
						name: entry?.name ?? 'Unavailable workspace',
						description: entry?.description ?? message.workspaceRootId,
						assignmentRevision: message.assignmentRevision,
					});
					return true;
				}
				case 'agent.resetCompleted': {
					const lastRevision = lastAppliedAssignmentRevisionByTab.get(
						message.tabId,
					) ?? 0;
					if (message.assignmentRevision <= lastRevision) {
						return false;
					}
					lastAppliedAssignmentRevisionByTab.set(
						message.tabId,
						message.assignmentRevision,
					);
					providerPickerOpenTabs.delete(message.tabId);
					assignmentStateByTab.set(message.tabId, createUnassignedState());
					model.clearProvider(message.tabId);
					return true;
				}
				case 'terminal.error': {
					if (message.switchAttemptId === undefined) {
						if (message.sessionId !== null) {
							model.setMcpRestartPending(
								message.tabId,
								message.sessionId,
								false,
							);
						}
						return true;
					}
					const resetBarrier = resetBarrierAttemptByTab.get(message.tabId) ?? 0;
					const state = assignmentStateByTab.get(message.tabId);
					const pending = state?.kind === 'unassigned'
						|| state?.kind === 'assigned'
						? state.pendingSwitch
						: null;
					if (
						message.switchAttemptId > resetBarrier
						&& pending?.switchAttemptId === message.switchAttemptId
						&& state !== undefined
						&& state.kind !== 'resetting'
					) {
						assignmentStateByTab.set(message.tabId, Object.freeze({
							...state,
							pendingSwitch: null,
						}));
						providerPickerOpenTabs.delete(message.tabId);
						renderViews();
						return true;
					}
					return false;
				}
				case 'terminal.started':
					model.setSession(message.tabId, message.sessionId);
					return true;
				case 'terminal.exited':
					model.clearSession(message.tabId, message.sessionId);
					return true;
				case 'mcp.statusChanged':
					model.setMcpStatus(
						message.tabId,
						message.sessionId,
						message.status === 'connected'
							? { kind: 'connected' }
							: {
								kind: 'failed',
								reason: message.reason,
								message: messageByMcpFailureReason[message.reason],
								retryable: message.retryable,
							},
					);
					return true;
				case 'mcp.statusCleared':
					model.clearMcpStatus(message.tabId, message.sessionId);
					return true;
				case 'mcp.restartRejected':
					/** Host가 기존 CLI/MCP를 보존했으므로 failed 표시만 유지하고 pending을 끝낸다. */
					model.setMcpRestartPending(
						message.tabId,
						message.sessionId,
						false,
					);
					return true;
				default:
					return true;
			}
		},
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			assignmentStateByTab.clear();
			providerPickerOpenTabs.clear();
			lastIssuedSwitchAttemptByTab.clear();
			lastAppliedAssignmentRevisionByTab.clear();
			resetBarrierAttemptByTab.clear();
			lastKnownCatalogEntryById.clear();
			const cleanupActions = [
				() => unsubscribe(),
				() => confirmDialog.dispose(),
				() => renameDialog.dispose(),
				() => topBar.dispose(),
				() => tabStrip.dispose(),
				() => providerPicker.dispose(),
			];
			for (const cleanup of cleanupActions) {
				try {
					cleanup();
				} catch {
					/** 한 정리 실패가 나머지 Agent UI 정리를 막지 않게 한다. */
				}
			}
		},
	};
}
