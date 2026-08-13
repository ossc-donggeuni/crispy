import type { SessionId, TabId } from '../../protocol/messages';
import {
	mapWorkspaceFailureToTerminalError,
	type WorkspaceTerminalErrorMessage,
} from './workspaceErrorMessage';
import {
	resolveCurrentWorkspace,
	type WorkspaceResolver,
} from './workspaceResolver';
import type { WorkspaceValidationSuccess } from './types';

/** Workspace 정책을 통과하지 못해 실행을 중단해야 하는 preflight 결과다. */
export interface WorkspacePreflightFailure {
	readonly ok: false;
	readonly error: WorkspaceTerminalErrorMessage;
}

/** 성공 root는 Host에만 두고 실패만 안전한 protocol 오류로 노출하는 결과다. */
export type WorkspacePreflightResult =
	| WorkspaceValidationSuccess
	| WorkspacePreflightFailure;

/** start와 restart가 공유하는 Workspace 실행 전 검증 함수다. */
export type WorkspacePreflight = (
	tabId: TabId,
	sessionId: SessionId | null,
) => WorkspacePreflightResult;

/**
 * canonical resolver를 사용하는 Workspace preflight를 만든다.
 * 반환 함수는 호출할 때마다 resolver를 다시 실행하며 이전 root를 저장하지 않는다.
 *
 * @param resolveWorkspace 매 호출마다 현재 Workspace를 다시 검증하는 resolver다.
 * @returns 성공 시 Host 전용 root, 실패 시 안전한 terminal.error를 반환하는 함수다.
 */
export function createWorkspacePreflight(
	resolveWorkspace: WorkspaceResolver,
): WorkspacePreflight {
	return function runPreflight(
		tabId: TabId,
		sessionId: SessionId | null,
	): WorkspacePreflightResult {
		const result = resolveWorkspace();
		if (result.ok) {
			return result;
		}

		return {
			ok: false,
			error: mapWorkspaceFailureToTerminalError(result, tabId, sessionId),
		};
	};
}

/** start와 restart handler가 공유할 Host 전용 canonical Workspace preflight다. */
export const runWorkspacePreflight = createWorkspacePreflight(
	resolveCurrentWorkspace,
);
