import {
	validateWorkspacePolicy as validateWorkspaceRootPolicy,
} from '../../../workspace/workspacePolicy';
import type { WorkspaceContextSnapshot } from './workspaceContext';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
	WorkspaceValidationErrorCode,
	WorkspaceValidationFailure,
	WorkspaceValidationResult,
} from './types';

/** 경로나 URI를 포함하지 않는 workspace 정책 실패 결과를 만든다. */
function validationFailure(
	code: WorkspaceValidationErrorCode,
): WorkspaceValidationFailure {
	return { ok: false, code };
}

/**
 * Host가 수집한 workspace snapshot을 고정된 순서로 검증한다.
 * VS Code API나 filesystem I/O를 사용하지 않으며 입력 snapshot을 변경하지 않는다.
 *
 * @param snapshot Extension Host가 독점 수집한 workspace context snapshot이다.
 * @returns 정책을 통과한 root 또는 식별 정보가 없는 고정 오류 code다.
 */
export function validateWorkspacePolicy(
	snapshot: WorkspaceContextSnapshot,
	platform: NodeJS.Platform = process.platform,
): WorkspaceValidationResult {
	if (!snapshot.isTrusted) {
		return validationFailure('workspace_untrusted');
	}

	if (snapshot.workspaceFolders.length === 0) {
		return validationFailure('workspace_not_found');
	}

	if (snapshot.workspaceFolders.length > 1) {
		return validationFailure('workspace_multi_root_unsupported');
	}

	const folder = snapshot.workspaceFolders[0];
	const rootPolicy = validateWorkspaceRootPolicy({
		uriScheme: folder.scheme,
		fsPath: folder.fsPath,
		platform,
	});
	if (!rootPolicy.ok) {
		return validationFailure(rootPolicy.code);
	}

	const root = {
		scheme: 'file',
		fsPath: rootPolicy.fsPath as ValidatedWorkspaceFsPath,
	} as ValidatedWorkspaceRoot;

	return { ok: true, root };
}
