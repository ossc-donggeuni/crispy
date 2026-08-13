import type {
	OutputSequence,
	SessionId,
	TabId,
} from './messages';
import type { ProviderId } from './providers';

/** Extension Host가 관리하는 terminal session의 전체 lifecycle 상태다. */
export type TerminalSessionState =
	| 'starting'
	| 'running'
	| 'stopping'
	| 'exited'
	| 'error'
	| 'disposed';

/** Webview 소유 tab과 Host 소유 현재 session의 연결 상태다. */
export interface TerminalTabStateSnapshot {
	readonly tabId: TabId;
	readonly currentSessionId: SessionId | null;
}

/** 상태 validator와 이후 session/output manager가 공유하는 session 조회 정보다. */
export interface TerminalSessionStateSnapshot {
	readonly tabId: TabId;
	readonly sessionId: SessionId;
	readonly providerId: ProviderId;
	readonly state: TerminalSessionState;
	readonly inFlightOutputSequence: OutputSequence | null;
	readonly disposed: boolean;
}

/**
 * 미래 session manager가 한 검증 시점의 상태를 readonly 값으로 제공하는 계약이다.
 * Validator는 이 배열이나 배열 안의 항목을 변경하지 않는다.
 */
export interface TerminalStateValidationSnapshot {
	readonly tabs: readonly TerminalTabStateSnapshot[];
	readonly sessions: readonly TerminalSessionStateSnapshot[];
}
