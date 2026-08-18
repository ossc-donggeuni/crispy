import * as vscode from 'vscode';
import type { WorkspaceRoot, WorkspaceSnapshot } from './workspaceModel';

type WorkspaceFoldersSource = Pick<typeof vscode.workspace, 'workspaceFolders'>;

/**
 * 현재 열린 모든 VS Code Workspace Root를 빈 Tree로 수집한다.
 *
 * @param workspaceFoldersSource Workspace Folder 목록을 제공하는 VS Code Workspace
 * @returns 이후 Folder/File 탐색 결과를 채울 수 있는 Workspace Snapshot
 */
export function createWorkspaceSnapshot(
	workspaceFoldersSource: WorkspaceFoldersSource = vscode.workspace,
): WorkspaceSnapshot {
	return {
		roots: (workspaceFoldersSource.workspaceFolders ?? []).map(createWorkspaceRoot),
	};
}

/** VS Code Workspace Folder를 안정적인 URI 기반 Root 모델로 변환한다. */
function createWorkspaceRoot(workspaceFolder: vscode.WorkspaceFolder): WorkspaceRoot {
	return {
		id: `workspace-root:${workspaceFolder.uri.toString()}`,
		name: workspaceFolder.name,
		uri: workspaceFolder.uri,
		children: [],
	};
}
