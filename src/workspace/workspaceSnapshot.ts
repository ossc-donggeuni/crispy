import * as vscode from 'vscode';
import type {
	File,
	Folder,
	WorkspaceEntry,
	WorkspaceRoot,
	WorkspaceSnapshot,
} from './workspaceModel';

type WorkspaceFoldersSource = Pick<typeof vscode.workspace, 'workspaceFolders'>;
type WorkspaceFileSystem = Pick<typeof vscode.workspace.fs, 'readDirectory'>;

/**
 * 현재 열린 모든 VS Code Workspace Root와 각 Root의 전체 Tree를 수집한다.
 *
 * @param workspaceFoldersSource Workspace Folder 목록을 제공하는 VS Code Workspace
 * @param fileSystem Directory 항목을 읽는 최소 Workspace FileSystem 의존성
 * @returns 재귀 탐색을 완료한 Workspace Snapshot
 */
export async function createWorkspaceSnapshot(
	workspaceFoldersSource: WorkspaceFoldersSource = vscode.workspace,
	fileSystem: WorkspaceFileSystem = vscode.workspace.fs,
): Promise<WorkspaceSnapshot> {
	return {
		roots: await Promise.all(
			(workspaceFoldersSource.workspaceFolders ?? []).map(
				(workspaceFolder) => createWorkspaceRoot(workspaceFolder, fileSystem),
			),
		),
	};
}

/** VS Code Workspace Folder와 전체 하위 Tree를 Root 모델로 변환한다. */
async function createWorkspaceRoot(
	workspaceFolder: vscode.WorkspaceFolder,
	fileSystem: WorkspaceFileSystem,
): Promise<WorkspaceRoot> {
	return {
		id: `workspace-root:${workspaceFolder.uri.toString()}`,
		name: workspaceFolder.name,
		uri: workspaceFolder.uri,
		status: 'loaded',
		children: await readWorkspaceEntries(workspaceFolder.uri, fileSystem),
	};
}

/** Directory의 직계 항목을 읽고 하위 Directory를 재귀적으로 탐색한다. */
async function readWorkspaceEntries(
	parentUri: vscode.Uri,
	fileSystem: WorkspaceFileSystem,
): Promise<readonly WorkspaceEntry[]> {
	const directoryEntries = await fileSystem.readDirectory(parentUri);
	const workspaceEntries = await Promise.all(
		directoryEntries.map(async ([name, fileType]): Promise<WorkspaceEntry | undefined> => {
			const uri = vscode.Uri.joinPath(parentUri, name);

			if (fileType === vscode.FileType.Directory) {
				return createFolder(name, uri, fileSystem);
			}

			if (fileType === vscode.FileType.File) {
				return createFile(name, uri);
			}

			return undefined;
		}),
	);

	return workspaceEntries.filter(
		(entry): entry is WorkspaceEntry => entry !== undefined,
	);
}

/** Directory를 전체 children이 채워진 Folder 모델로 변환한다. */
async function createFolder(
	name: string,
	uri: vscode.Uri,
	fileSystem: WorkspaceFileSystem,
): Promise<Folder> {
	return {
		kind: 'folder',
		id: `folder:${uri.toString()}`,
		name,
		uri,
		status: 'loaded',
		children: await readWorkspaceEntries(uri, fileSystem),
	};
}

/** File 항목을 URI 기반의 안정적인 File 모델로 변환한다. */
function createFile(name: string, uri: vscode.Uri): File {
	return {
		kind: 'file',
		id: `file:${uri.toString()}`,
		name,
		uri,
	};
}
