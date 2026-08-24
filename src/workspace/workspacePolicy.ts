import { posix, win32 } from 'node:path';

/** Catalog와 Host execution resolver가 공유하는 순수 Workspace root 정책 입력이다. */
export interface WorkspacePolicyInput {
	readonly uriScheme: string;
	readonly fsPath: string;
	readonly platform: NodeJS.Platform;
}

/** Workspace root 자체의 실행 가능성 검사에서 사용하는 안정적인 오류 code다. */
export type WorkspacePolicyErrorCode =
	| 'workspace_virtual_unsupported'
	| 'workspace_path_invalid';

/** Workspace root 정책 검증 성공 결과다. */
export interface WorkspacePolicySuccess {
	readonly ok: true;
	readonly fsPath: string;
}

/** 경로나 URI를 노출하지 않는 Workspace root 정책 검증 실패 결과다. */
export interface WorkspacePolicyFailure {
	readonly ok: false;
	readonly code: WorkspacePolicyErrorCode;
}

/** Catalog와 Host execution resolver가 공유하는 순수 Workspace root 정책 결과다. */
export type WorkspacePolicyResult =
	| WorkspacePolicySuccess
	| WorkspacePolicyFailure;

/**
 * Workspace root의 URI scheme과 filesystem path만 순수하게 검증한다.
 * Trust, root lookup과 filesystem 존재 여부는 호출 경계의 별도 책임이다.
 */
export function validateWorkspacePolicy(
	input: WorkspacePolicyInput,
): WorkspacePolicyResult {
	if (input.uriScheme !== 'file') {
		return { ok: false, code: 'workspace_virtual_unsupported' };
	}

	const pathImplementation = input.platform === 'win32' ? win32 : posix;
	if (
		input.fsPath.length === 0
		|| input.fsPath.includes('\0')
		|| !pathImplementation.isAbsolute(input.fsPath)
	) {
		return { ok: false, code: 'workspace_path_invalid' };
	}

	return { ok: true, fsPath: input.fsPath };
}
