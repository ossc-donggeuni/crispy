/** VS Code WorkspaceFolder에서 terminal 검증에 필요한 최소 URI 형태다. */
export interface WorkspaceFolderLike {
	uri: {
		scheme: string;
		fsPath: string;
	};
}

/** terminal workspace 검증의 성공 또는 사용자 표시 오류 결과다. */
export type WorkspaceResolution =
	| { ok: true; rootPath: string }
	| { ok: false; message: string };

/**
 * Graph와 terminal이 공유할 하나의 trusted file workspace root를 확정한다.
 *
 * @param isTrusted 현재 VS Code workspace의 trust 상태
 * @param folders 현재 열린 workspace folder 목록
 * @returns 사용할 로컬 root path 또는 명확한 미지원 사유
 */
export function resolveTerminalWorkspace(
	isTrusted: boolean,
	folders: readonly WorkspaceFolderLike[] | undefined,
): WorkspaceResolution {
	if (!isTrusted) {
		return { ok: false, message: '신뢰되지 않은 workspace에서는 terminal을 실행할 수 없습니다.' };
	}

	if (!folders || folders.length !== 1) {
		return { ok: false, message: 'Crispy Terminal은 단일 workspace folder만 지원합니다.' };
	}

	const [folder] = folders;
	if (!folder || folder.uri.scheme !== 'file') {
		return { ok: false, message: 'Crispy Terminal은 로컬 file workspace만 지원합니다.' };
	}

	return { ok: true, rootPath: folder.uri.fsPath };
}
