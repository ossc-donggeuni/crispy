import {
	type ProviderId,
	type SessionId,
	type WorkspaceRootId,
} from '../protocol';
import type { McpFailureReason } from '../../mcp/failureReason';
import {
	resolveAgentSessionColor,
	type AgentSessionColorResolver,
} from '../agentSessionColor';
import {
	UNSELECTED_TAB_LABEL,
	formatAgentTabLabel,
} from './agentProviders';
import {
	AGENT_TAB_TITLE_MAX_CODE_POINTS,
	AGENT_TAB_TITLE_MAX_CANDIDATES,
	countUnicodeCodePoints,
	createAgentTabNameKey,
	createDisambiguatedAutomaticAgentTabTitle,
	normalizeManualAgentTabName,
	type ManualTabNameError,
} from './agentTabTitle';

/** 탭 strip과 Host session routing이 공유하는 Webview 탭 식별자다. */
export type AgentTabId = string;

/** 탭 제목이 만들어진 출처다. */
export type AgentTabTitleSource = 'default' | 'automatic' | 'manual';

/** 탭 UI가 보관하는 credential-free MCP 표시 상태다. */
export type VisibleMcpStatus =
	| { readonly kind: 'none' }
	| { readonly kind: 'connected' }
	| {
		readonly kind: 'failed';
		readonly reason: McpFailureReason;
		readonly message: string;
		readonly retryable: boolean;
	};

const NO_VISIBLE_MCP_STATUS: VisibleMcpStatus = Object.freeze({ kind: 'none' });

/** 수동 이름 저장 결과다. */
export type RenameAgentTabResult =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly error: ManualTabNameError | 'duplicate' };

/** 탭 하나의 표시 상태이며 외부에서 변경할 수 없는 snapshot이다. */
export interface AgentTabSnapshot {
	readonly id: AgentTabId;
	readonly providerId?: ProviderId;
	/** Host가 commit한 Workspace assignment의 root 식별자다. */
	readonly workspaceRootId?: WorkspaceRootId;
	/** 탭 title과 접근성 이름에 사용하는 마지막 정상 Catalog metadata다. */
	readonly workspaceName?: string;
	readonly workspaceDescription?: string;
	readonly assignmentRevision?: number;
	readonly sequence?: number;
	readonly baseLabel?: string;
	readonly displayName: string;
	/** 기존 UI 소비자와의 호환을 유지하는 displayName alias다. */
	readonly label: string;
	readonly titleSource: AgentTabTitleSource;
	readonly autoTitleAttempted: boolean;
	readonly hasStartedSession: boolean;
	readonly isPinned: boolean;
	readonly sessionId?: SessionId;
	/** 현재 또는 가장 최근 세션에 배정된 탭/Graph 공통 표시 색상이다. */
	readonly sessionColor?: string;
	readonly mcpStatus: VisibleMcpStatus;
	readonly mcpRestartPending: boolean;
}

/** 탭 목록과 활성 탭을 함께 담는 UI 상태 snapshot이다. */
export interface AgentTabModelSnapshot {
	readonly tabs: readonly AgentTabSnapshot[];
	readonly activeTabId?: AgentTabId;
}

export type AgentTabModelListener = (snapshot: AgentTabModelSnapshot) => void;

/** 상단 bar, 탭 strip과 Terminal 제목 collector가 공유하는 탭 상태 경계다. */
export interface AgentTabModel {
	getSnapshot(): AgentTabModelSnapshot;
	subscribe(listener: AgentTabModelListener): () => void;
	createTab(): AgentTabId;
	selectTab(tabId: AgentTabId): void;
	assignProvider(
		tabId: AgentTabId,
		providerId: ProviderId,
		workspace?: Readonly<{
			readonly id: WorkspaceRootId;
			readonly name: string;
			readonly description: string;
			readonly assignmentRevision: number;
		}>,
	): void;
	updateWorkspaceMetadata(
		tabId: AgentTabId,
		workspace: Readonly<{
			readonly id: WorkspaceRootId;
			readonly name: string;
			readonly description: string;
			readonly assignmentRevision: number;
		}>,
	): void;
	clearProvider(tabId: AgentTabId): void;
	setSession(tabId: AgentTabId, sessionId: SessionId): void;
	setMcpStatus(
		tabId: AgentTabId,
		sessionId: SessionId,
		status: VisibleMcpStatus,
	): void;
	clearMcpStatus(tabId: AgentTabId, sessionId: SessionId): void;
	setMcpRestartPending(
		tabId: AgentTabId,
		sessionId: SessionId,
		pending: boolean,
	): void;
	clearSession(tabId: AgentTabId, sessionId: SessionId): void;
	closeTab(tabId: AgentTabId): void;
	renameTab(tabId: AgentTabId, value: string): RenameAgentTabResult;
	canAttemptAutomaticTitle(tabId: AgentTabId, sessionId: SessionId): boolean;
	applyAutomaticTitleCandidates(
		tabId: AgentTabId,
		sessionId: SessionId,
		candidates: readonly string[],
	): boolean;
	setPinned(tabId: AgentTabId, pinned: boolean): void;
}

function createDefaultTabId(): AgentTabId {
	return `agent-tab-${globalThis.crypto.randomUUID()}`;
}

interface MutableAgentTab {
	readonly id: AgentTabId;
	providerId?: ProviderId;
	workspaceRootId?: WorkspaceRootId;
	workspaceName?: string;
	workspaceDescription?: string;
	assignmentRevision?: number;
	sequence?: number;
	baseLabel?: string;
	displayName: string;
	titleSource: AgentTabTitleSource;
	autoTitleAttempted: boolean;
	hasStartedSession: boolean;
	isPinned: boolean;
	sessionId?: SessionId;
	sessionColor?: string;
	readonly seenSessionIds: Set<SessionId>;
	mcpStatus: VisibleMcpStatus;
	mcpRestartPending: boolean;
}

/** 내부 상태를 깊이가 제한된 frozen 탭 snapshot으로 복사한다. */
function toTabSnapshot(tab: MutableAgentTab): AgentTabSnapshot {
	return Object.freeze({
		id: tab.id,
		...(tab.providerId === undefined ? {} : { providerId: tab.providerId }),
		...(tab.workspaceRootId === undefined
			? {}
			: { workspaceRootId: tab.workspaceRootId }),
		...(tab.workspaceName === undefined
			? {}
			: { workspaceName: tab.workspaceName }),
		...(tab.workspaceDescription === undefined
			? {}
			: { workspaceDescription: tab.workspaceDescription }),
		...(tab.assignmentRevision === undefined
			? {}
			: { assignmentRevision: tab.assignmentRevision }),
		...(tab.sequence === undefined ? {} : { sequence: tab.sequence }),
		...(tab.baseLabel === undefined ? {} : { baseLabel: tab.baseLabel }),
		displayName: tab.displayName,
		label: tab.displayName,
		titleSource: tab.titleSource,
		autoTitleAttempted: tab.autoTitleAttempted,
		hasStartedSession: tab.hasStartedSession,
		isPinned: tab.isPinned,
		...(tab.sessionId === undefined ? {} : { sessionId: tab.sessionId }),
		...(tab.sessionColor === undefined ? {} : { sessionColor: tab.sessionColor }),
		mcpStatus: tab.mcpStatus,
		mcpRestartPending: tab.mcpRestartPending,
	});
}

/** 자동 callback 경계에서 후보 형식과 길이를 다시 확인한다. */
function isValidAutomaticCandidate(candidate: string): boolean {
	const normalized = normalizeManualAgentTabName(candidate);
	return normalized.ok
		&& normalized.value === candidate
		&& countUnicodeCodePoints(candidate) <= AGENT_TAB_TITLE_MAX_CODE_POINTS
		&& /[\p{L}\p{N}]/u.test(candidate);
}

/**
 * Webview 수명 동안 탭 제목, session ownership, MCP 표시와 고정 순서를 관리한다.
 * provider 번호는 단조 증가하고 열린 탭의 표시/예약 이름과 충돌하는 번호를 건너뛴다.
 */
export function createAgentTabModel(
	createTabId: () => AgentTabId = createDefaultTabId,
	resolveSessionColor: AgentSessionColorResolver = resolveAgentSessionColor,
): AgentTabModel {
	const tabs: MutableAgentTab[] = [];
	const sequenceCounters = new Map<ProviderId, number>();
	const listeners = new Set<AgentTabModelListener>();
	let activeTabId: AgentTabId | undefined;

	const buildSnapshot = (): AgentTabModelSnapshot => Object.freeze({
		tabs: Object.freeze(tabs.map(toTabSnapshot)),
		...(activeTabId === undefined ? {} : { activeTabId }),
	});

	const notify = (): void => {
		const snapshot = buildSnapshot();
		for (const listener of [...listeners]) {
			try {
				listener(snapshot);
			} catch {
				/** 구독자 하나의 실패가 다른 Webview 상태 전이를 막지 않게 한다. */
			}
		}
	};

	const findTab = (tabId: AgentTabId): MutableAgentTab | undefined =>
		tabs.find((tab) => tab.id === tabId);

	/** 시스템 기본 New tab을 제외한 다른 열린 탭의 표시/예약 이름과 비교한다. */
	const isNameAvailable = (
		name: string,
		owner?: MutableAgentTab,
	): boolean => {
		const key = createAgentTabNameKey(name);
		for (const tab of tabs) {
			if (tab === owner) {
				continue;
			}

			const isSystemNewTab = tab.providerId === undefined
				&& tab.titleSource === 'default'
				&& tab.displayName === UNSELECTED_TAB_LABEL;
			if (
				(!isSystemNewTab && createAgentTabNameKey(tab.displayName) === key)
				|| (
					tab.baseLabel !== undefined
					&& createAgentTabNameKey(tab.baseLabel) === key
				)
			) {
				return false;
			}
		}

		return true;
	};

	/** 현재 tab의 기존 이름도 충돌로 세어 새 baseLabel에 쓸 번호를 찾는다. */
	const isBaseLabelAvailable = (name: string): boolean => {
		const key = createAgentTabNameKey(name);
		return tabs.every((tab) => {
			const isSystemNewTab = tab.providerId === undefined
				&& tab.titleSource === 'default'
				&& tab.displayName === UNSELECTED_TAB_LABEL;
			return (isSystemNewTab || createAgentTabNameKey(tab.displayName) !== key)
				&& (
					tab.baseLabel === undefined
					|| createAgentTabNameKey(tab.baseLabel) !== key
				);
		});
	};

	return {
		getSnapshot: buildSnapshot,

		subscribe(listener): () => void {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		createTab(): AgentTabId {
			const tab: MutableAgentTab = {
				id: createTabId(),
				displayName: UNSELECTED_TAB_LABEL,
				titleSource: 'default',
				autoTitleAttempted: false,
				hasStartedSession: false,
				isPinned: false,
				seenSessionIds: new Set<SessionId>(),
				mcpStatus: NO_VISIBLE_MCP_STATUS,
				mcpRestartPending: false,
			};
			tabs.push(tab);
			activeTabId = tab.id;
			notify();
			return tab.id;
		},

		selectTab(tabId): void {
			if (activeTabId === tabId || findTab(tabId) === undefined) {
				return;
			}
			activeTabId = tabId;
			notify();
		},

		assignProvider(tabId, providerId, workspace): void {
			const tab = findTab(tabId);
			if (tab === undefined) {
				return;
			}
			if (tab.providerId === providerId) {
				if (workspace !== undefined) {
					tab.workspaceRootId = workspace.id;
					tab.workspaceName = workspace.name;
					tab.workspaceDescription = workspace.description;
					tab.assignmentRevision = workspace.assignmentRevision;
					delete tab.sessionId;
					delete tab.sessionColor;
					tab.hasStartedSession = false;
					tab.autoTitleAttempted = false;
					if (tab.titleSource !== 'manual') {
						tab.displayName = tab.baseLabel ?? UNSELECTED_TAB_LABEL;
						tab.titleSource = 'default';
					}
					tab.mcpStatus = NO_VISIBLE_MCP_STATUS;
					tab.mcpRestartPending = false;
					notify();
				}
				return;
			}

			let nextSequence = sequenceCounters.get(providerId) ?? 0;
			let baseLabel = '';
			do {
				nextSequence += 1;
				baseLabel = formatAgentTabLabel(providerId, nextSequence);
			} while (!isBaseLabelAvailable(baseLabel));
			sequenceCounters.set(providerId, nextSequence);

			tab.providerId = providerId;
			if (workspace !== undefined) {
				tab.workspaceRootId = workspace.id;
				tab.workspaceName = workspace.name;
				tab.workspaceDescription = workspace.description;
				tab.assignmentRevision = workspace.assignmentRevision;
			}
			tab.sequence = nextSequence;
			tab.baseLabel = baseLabel;
			if (tab.titleSource !== 'manual') {
				tab.displayName = baseLabel;
				tab.titleSource = 'default';
			}
			delete tab.sessionId;
			delete tab.sessionColor;
			tab.seenSessionIds.clear();
			tab.hasStartedSession = false;
			tab.autoTitleAttempted = false;
			tab.mcpStatus = NO_VISIBLE_MCP_STATUS;
			tab.mcpRestartPending = false;
			notify();
		},

		updateWorkspaceMetadata(tabId, workspace): void {
			const tab = findTab(tabId);
			if (
				tab === undefined
				|| tab.providerId === undefined
				|| tab.workspaceRootId !== workspace.id
			) {
				return;
			}
			tab.workspaceName = workspace.name;
			tab.workspaceDescription = workspace.description;
			tab.assignmentRevision = workspace.assignmentRevision;
			notify();
		},

		clearProvider(tabId): void {
			const tab = findTab(tabId);
			if (tab === undefined || tab.providerId === undefined) {
				return;
			}

			delete tab.providerId;
			delete tab.workspaceRootId;
			delete tab.workspaceName;
			delete tab.workspaceDescription;
			delete tab.assignmentRevision;
			delete tab.sequence;
			delete tab.baseLabel;
			delete tab.sessionId;
			delete tab.sessionColor;
			tab.displayName = UNSELECTED_TAB_LABEL;
			tab.titleSource = 'default';
			tab.autoTitleAttempted = false;
			tab.hasStartedSession = false;
			tab.seenSessionIds.clear();
			tab.mcpStatus = NO_VISIBLE_MCP_STATUS;
			tab.mcpRestartPending = false;
			notify();
		},

		setSession(tabId, sessionId): void {
			const tab = findTab(tabId);
			if (
				tab === undefined
				|| tab.sessionId === sessionId
				|| tab.seenSessionIds.has(sessionId)
			) {
				return;
			}

			if (tab.hasStartedSession) {
				tab.displayName = tab.baseLabel ?? UNSELECTED_TAB_LABEL;
				tab.titleSource = 'default';
				tab.autoTitleAttempted = false;
			} else if (tab.titleSource !== 'manual') {
				tab.displayName = tab.baseLabel ?? UNSELECTED_TAB_LABEL;
				tab.titleSource = 'default';
				tab.autoTitleAttempted = false;
			}

			tab.sessionId = sessionId;
			tab.sessionColor = resolveSessionColor(sessionId);
			tab.seenSessionIds.add(sessionId);
			tab.hasStartedSession = true;
			tab.mcpStatus = NO_VISIBLE_MCP_STATUS;
			tab.mcpRestartPending = false;
			notify();
		},

		setMcpStatus(tabId, sessionId, status): void {
			const tab = findTab(tabId);
			if (tab === undefined || tab.sessionId !== sessionId) {
				return;
			}
			tab.mcpStatus = Object.freeze({ ...status }) as VisibleMcpStatus;
			if (status.kind !== 'failed' || !status.retryable) {
				tab.mcpRestartPending = false;
			}
			notify();
		},

		clearMcpStatus(tabId, sessionId): void {
			const tab = findTab(tabId);
			if (tab === undefined || tab.sessionId !== sessionId) {
				return;
			}
			tab.mcpStatus = NO_VISIBLE_MCP_STATUS;
			tab.mcpRestartPending = false;
			notify();
		},

		setMcpRestartPending(tabId, sessionId, pending): void {
			const tab = findTab(tabId);
			if (
				tab === undefined
				|| tab.sessionId !== sessionId
				|| tab.mcpStatus.kind !== 'failed'
				|| !tab.mcpStatus.retryable
				|| tab.mcpRestartPending === pending
			) {
				return;
			}
			tab.mcpRestartPending = pending;
			notify();
		},

		clearSession(tabId, sessionId): void {
			const tab = findTab(tabId);
			if (tab === undefined || tab.sessionId !== sessionId) {
				return;
			}
			delete tab.sessionId;
			tab.mcpStatus = NO_VISIBLE_MCP_STATUS;
			tab.mcpRestartPending = false;
			notify();
		},

		closeTab(tabId): void {
			const index = tabs.findIndex((tab) => tab.id === tabId);
			if (index < 0) {
				return;
			}

			tabs.splice(index, 1);
			if (activeTabId === tabId) {
				activeTabId = (tabs[index] ?? tabs[index - 1])?.id;
			}
			notify();
		},

		renameTab(tabId, value): RenameAgentTabResult {
			const tab = findTab(tabId);
			const normalized = normalizeManualAgentTabName(value);
			if (!normalized.ok) {
				return normalized;
			}
			if (tab === undefined || !isNameAvailable(normalized.value, tab)) {
				return { ok: false, error: 'duplicate' };
			}

			tab.displayName = normalized.value;
			tab.titleSource = 'manual';
			notify();
			return normalized;
		},

		canAttemptAutomaticTitle(tabId, sessionId): boolean {
			const tab = findTab(tabId);
			return tab !== undefined
				&& tab.sessionId === sessionId
				&& (tab.providerId === 'codex' || tab.providerId === 'claude')
				&& tab.titleSource !== 'manual'
				&& !tab.autoTitleAttempted;
		},

		applyAutomaticTitleCandidates(tabId, sessionId, candidates): boolean {
			const tab = findTab(tabId);
			if (
				tab === undefined
				|| tab.sessionId !== sessionId
				|| (tab.providerId !== 'codex' && tab.providerId !== 'claude')
				|| tab.titleSource === 'manual'
				|| tab.autoTitleAttempted
			) {
				return false;
			}

			tab.autoTitleAttempted = true;
			for (const candidate of candidates.slice(0, AGENT_TAB_TITLE_MAX_CANDIDATES)) {
				if (!isValidAutomaticCandidate(candidate)) {
					continue;
				}

				let availableCandidate = isNameAvailable(candidate, tab)
					? candidate
					: undefined;
				for (
					let ordinal = 2;
					availableCandidate === undefined && ordinal <= tabs.length + 1;
					ordinal += 1
				) {
					const disambiguated = createDisambiguatedAutomaticAgentTabTitle(
						candidate,
						ordinal,
					);
					if (
						disambiguated !== undefined
						&& isValidAutomaticCandidate(disambiguated)
						&& isNameAvailable(disambiguated, tab)
					) {
						availableCandidate = disambiguated;
					}
				}

				if (availableCandidate !== undefined) {
					tab.displayName = availableCandidate;
					tab.titleSource = 'automatic';
					notify();
					return true;
				}
			}

			notify();
			return false;
		},

		setPinned(tabId, pinned): void {
			const index = tabs.findIndex((tab) => tab.id === tabId);
			const tab = tabs[index];
			if (tab === undefined || tab.isPinned === pinned) {
				return;
			}

			tabs.splice(index, 1);
			tab.isPinned = pinned;
			if (pinned) {
				const firstUnpinnedIndex = tabs.findIndex((entry) => !entry.isPinned);
				tabs.splice(
					firstUnpinnedIndex < 0 ? tabs.length : firstUnpinnedIndex,
					0,
					tab,
				);
			} else {
				tabs.push(tab);
			}
			notify();
		},
	};
}
