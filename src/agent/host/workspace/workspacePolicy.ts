import { isAbsolute } from 'node:path';
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

/** 현재 Extension Host에서 terminal cwd로 전달할 수 있는 최소 경로 조건을 검사한다. */
function isUsableTerminalCwd(fsPath: string): boolean {
	return fsPath.length > 0
		&& !fsPath.includes('\0')
		&& isAbsolute(fsPath);
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
	if (folder.scheme !== 'file') {
		return validationFailure('workspace_virtual_unsupported');
	}

	if (!isUsableTerminalCwd(folder.fsPath)) {
		return validationFailure('workspace_path_invalid');
	}

	const root = {
		scheme: 'file',
		fsPath: folder.fsPath as ValidatedWorkspaceFsPath,
	} as ValidatedWorkspaceRoot;

	return { ok: true, root };
}
