import type { Uri } from 'vscode';

/** Workspace root ID가 사용하는 공용 protocol prefix다. */
export const WORKSPACE_ROOT_ID_PREFIX = 'workspace-root:';

/** Graph, Catalog와 Host execution lookup이 공유하는 URI 기반 Workspace root ID다. */
export type WorkspaceRootId =
	`${typeof WORKSPACE_ROOT_ID_PREFIX}${string}`;

/** Workspace root ID 문법 검증 실패를 구분하는 안정적인 오류 code다. */
export type WorkspaceRootIdValidationErrorCode =
	| 'invalid_type'
	| 'invalid_prefix'
	| 'empty_payload';

/** Workspace root ID 문법 검증 성공 결과다. */
export interface WorkspaceRootIdValidationSuccess {
	readonly ok: true;
	readonly value: WorkspaceRootId;
}

/** 원본 값을 반사하지 않는 Workspace root ID 문법 검증 실패 결과다. */
export interface WorkspaceRootIdValidationFailure {
	readonly ok: false;
	readonly code: WorkspaceRootIdValidationErrorCode;
}

/** Workspace root ID 문법 검증의 discriminated union 결과다. */
export type WorkspaceRootIdValidationResult =
	| WorkspaceRootIdValidationSuccess
	| WorkspaceRootIdValidationFailure;

/** VS Code Workspace folder URI를 공용 Workspace root ID로 변환한다. */
export function createWorkspaceRootId(uri: Uri): WorkspaceRootId {
	return `${WORKSPACE_ROOT_ID_PREFIX}${uri.toString()}`;
}

/**
 * 외부 값을 길이 제한 없이 Workspace root ID 문법으로 검증한다.
 * URI payload의 해석이나 실행 권한 판단은 이 leaf module의 책임이 아니다.
 */
export function validateWorkspaceRootId(
	value: unknown,
): WorkspaceRootIdValidationResult {
	if (typeof value !== 'string') {
		return { ok: false, code: 'invalid_type' };
	}

	if (!value.startsWith(WORKSPACE_ROOT_ID_PREFIX)) {
		return { ok: false, code: 'invalid_prefix' };
	}

	if (value.length === WORKSPACE_ROOT_ID_PREFIX.length) {
		return { ok: false, code: 'empty_payload' };
	}

	return { ok: true, value: value as WorkspaceRootId };
}
