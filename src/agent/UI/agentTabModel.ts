import { type ProviderId, type SessionId } from '../protocol';
import type { McpFailureReason } from '../../mcp/failureReason';
import {
	UNSELECTED_TAB_LABEL,
	formatAgentTabLabel,
} from './agentProviders';

/**
 * 탭 strip이 사용하는 UI 전용 탭 식별자다.
 * Phase 2에서 Host 세션과 연결할 때 protocol의 `TabId`와 대응시킨다.
 */
export type AgentTabId = string;

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

/** 탭 하나의 표시 상태이며 외부에서 변경할 수 없는 snapshot이다. */
export interface AgentTabSnapshot {
	/** 탭을 구분하는 UI 식별자다. */
	readonly id: AgentTabId;

	/** 배정된 provider이며 미선택 상태에서는 `undefined`다. */
	readonly providerId?: ProviderId;

	/** 같은 provider 안에서 순차 증가하는 번호이며 미선택 상태에서는 `undefined`다. */
	readonly sequence?: number;

	/** 탭 strip에 표시할 라벨이다. */
	readonly label: string;

	/** Host가 알린 현재 Terminal session이며 MCP status ownership 검증에만 사용한다. */
	readonly sessionId?: SessionId;

	/** token, route, generation을 포함하지 않는 현재 탭 전용 MCP 표시 상태다. */
	readonly mcpStatus: VisibleMcpStatus;

	/** 확인 또는 Host 요청이 진행 중인 같은 탭의 MCP restart 연타 방어다. */
	readonly mcpRestartPending: boolean;
}

/** 탭 목록과 활성 탭을 함께 담는 UI 상태 snapshot이다. */
export interface AgentTabModelSnapshot {
	readonly tabs: readonly AgentTabSnapshot[];
	readonly activeTabId?: AgentTabId;
}

/** 상태 변경을 전달받는 구독자다. */
export type AgentTabModelListener = (snapshot: AgentTabModelSnapshot) => void;

/** 상단 bar와 탭 strip이 공유하는 탭 상태 관리 경계다. */
export interface AgentTabModel {
	/** 현재 탭 목록과 활성 탭을 담은 immutable snapshot을 반환한다. */
	getSnapshot(): AgentTabModelSnapshot;

	/** 상태 변경을 구독하고 해제 함수를 반환한다. */
	subscribe(listener: AgentTabModelListener): () => void;

	/** provider 미선택 상태의 새 탭을 만들고 활성 탭으로 전환한다. */
	createTab(): AgentTabId;

	/** 주어진 탭을 활성 탭으로 전환한다. 없는 탭이면 아무 것도 하지 않는다. */
	selectTab(tabId: AgentTabId): void;

	/**
	 * 탭에 provider를 배정하고 해당 provider의 다음 번호를 부여한다.
	 * 이미 같은 provider가 배정된 탭이면 번호를 다시 매기지 않는다.
	 */
	assignProvider(tabId: AgentTabId, providerId: ProviderId): void;

	/** 탭을 유지한 채 provider 배정을 지워 다시 선택할 수 있는 상태로 되돌린다. */
	clearProvider(tabId: AgentTabId): void;

	/** Host가 시작한 fresh Terminal session을 탭에 연결하고 이전 MCP 표시를 지운다. */
	setSession(tabId: AgentTabId, sessionId: SessionId): void;

	/** 정확한 current session의 표시 상태만 갱신한다. */
	setMcpStatus(
		tabId: AgentTabId,
		sessionId: SessionId,
		status: VisibleMcpStatus,
	): void;

	/** 정확한 current session의 indicator와 restart pending을 제거한다. */
	clearMcpStatus(tabId: AgentTabId, sessionId: SessionId): void;

	/** 정확한 current session의 MCP restart pending guard를 갱신한다. */
	setMcpRestartPending(
		tabId: AgentTabId,
		sessionId: SessionId,
		pending: boolean,
	): void;

	/** 정상 종료된 current session의 ownership과 표시 상태를 함께 지운다. */
	clearSession(tabId: AgentTabId, sessionId: SessionId): void;

	/** 탭을 닫고 필요하면 이웃 탭으로 활성 탭을 옮긴다. */
	closeTab(tabId: AgentTabId): void;
}

/** 탭 식별자를 만드는 기본 구현이며 테스트에서는 결정적인 구현으로 대체한다. */
function createDefaultTabId(): AgentTabId {
	return `agent-tab-${globalThis.crypto.randomUUID()}`;
}

/** 내부에서만 변경하는 탭 상태다. */
interface MutableAgentTab {
	readonly id: AgentTabId;
	providerId?: ProviderId;
	sequence?: number;
	sessionId?: SessionId;
	mcpStatus: VisibleMcpStatus;
	mcpRestartPending: boolean;
}

/**
 * 탭 하나를 외부에 노출할 immutable snapshot으로 변환한다.
 *
 * @param tab 내부 탭 상태
 * @returns 라벨이 계산된 frozen 탭 snapshot
 */
function toTabSnapshot(tab: MutableAgentTab): AgentTabSnapshot {
	if (tab.providerId === undefined || tab.sequence === undefined) {
		return Object.freeze({
			id: tab.id,
			label: UNSELECTED_TAB_LABEL,
			mcpStatus: tab.mcpStatus,
			mcpRestartPending: tab.mcpRestartPending,
			...(tab.sessionId === undefined ? {} : { sessionId: tab.sessionId }),
		});
	}

	return Object.freeze({
		id: tab.id,
		providerId: tab.providerId,
		sequence: tab.sequence,
		label: formatAgentTabLabel(tab.providerId, tab.sequence),
		mcpStatus: tab.mcpStatus,
		mcpRestartPending: tab.mcpRestartPending,
		...(tab.sessionId === undefined ? {} : { sessionId: tab.sessionId }),
	});
}

/**
 * 상단 bar와 탭 strip이 공유하는 탭 상태를 만든다.
 *
 * 이 단계에서는 실제 세션을 만들지 않으므로 상태 전이는 UI 안에서만 일어난다.
 * provider 번호는 provider별로 단조 증가하며 탭을 닫아도 재사용하지 않는다.
 * 이미 표시 중인 탭 라벨이 뒤늦게 바뀌지 않게 하기 위한 선택이다.
 *
 * @param createTabId 새 탭 식별자를 만드는 함수
 * @returns 탭 생성, 전환, provider 배정과 닫기를 제공하는 상태 객체
 */
export function createAgentTabModel(
	createTabId: () => AgentTabId = createDefaultTabId,
): AgentTabModel {
	const tabs: MutableAgentTab[] = [];
	const sequenceCounters = new Map<ProviderId, number>();
	const listeners = new Set<AgentTabModelListener>();
	let activeTabId: AgentTabId | undefined;

	/**
	 * 현재 상태를 frozen snapshot으로 만든다.
	 *
	 * @returns 외부 변경으로부터 분리된 상태 snapshot
	 */
	const buildSnapshot = (): AgentTabModelSnapshot => Object.freeze({
		tabs: Object.freeze(tabs.map(toTabSnapshot)),
		...(activeTabId === undefined ? {} : { activeTabId }),
	});

	/**
	 * 구독자에게 현재 snapshot을 전달한다.
	 * 한 구독자의 실패가 나머지 구독자나 상태 전이를 막지 않게 한다.
	 */
	const notify = (): void => {
		const snapshot = buildSnapshot();
		for (const listener of [...listeners]) {
			try {
				listener(snapshot);
			} catch {
				/** 구독자 렌더링 실패가 다른 Webview 기능으로 전파되지 않게 한다. */
			}
		}
	};

	/**
	 * 식별자로 내부 탭을 찾는다.
	 *
	 * @param tabId 찾을 탭 식별자
	 * @returns 일치하는 탭이며 없으면 `undefined`
	 */
	const findTab = (tabId: AgentTabId): MutableAgentTab | undefined =>
		tabs.find((tab) => tab.id === tabId);

	return {
		getSnapshot: buildSnapshot,

		subscribe(listener): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		createTab(): AgentTabId {
			const tab: MutableAgentTab = {
				id: createTabId(),
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

		assignProvider(tabId, providerId): void {
			const tab = findTab(tabId);
			if (tab === undefined || tab.providerId === providerId) {
				return;
			}

			const nextSequence = (sequenceCounters.get(providerId) ?? 0) + 1;
			sequenceCounters.set(providerId, nextSequence);
			tab.providerId = providerId;
			tab.sequence = nextSequence;
			delete tab.sessionId;
			tab.mcpStatus = NO_VISIBLE_MCP_STATUS;
			tab.mcpRestartPending = false;
			notify();
		},

		clearProvider(tabId): void {
			const tab = findTab(tabId);
			if (tab === undefined || tab.providerId === undefined) {
				return;
			}

			delete tab.providerId;
			delete tab.sequence;
			delete tab.sessionId;
			tab.mcpStatus = NO_VISIBLE_MCP_STATUS;
			tab.mcpRestartPending = false;
			notify();
		},

		setSession(tabId, sessionId): void {
			const tab = findTab(tabId);
			if (tab === undefined || tab.sessionId === sessionId) {
				return;
			}
			tab.sessionId = sessionId;
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
				/** 닫은 위치의 다음 탭을 우선 활성화하고 없으면 이전 탭으로 되돌린다. */
				activeTabId = (tabs[index] ?? tabs[index - 1])?.id;
			}
			notify();
		},
	};
}
