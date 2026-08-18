import * as vscode from 'vscode';
import type {
	File,
	Folder,
	WorkspaceDirectoryStatus,
	WorkspaceEntry,
	WorkspaceRoot,
	WorkspaceSnapshot,
} from './workspaceModel';

type WorkspaceFoldersSource = Pick<typeof vscode.workspace, 'workspaceFolders'>;
type WorkspaceFileSystem = Pick<typeof vscode.workspace.fs, 'readDirectory'>;
type WorkspaceLogger = Pick<Console, 'warn'>;

interface WorkspaceDirectoryResult {
	readonly status: WorkspaceDirectoryStatus;
	readonly children: readonly WorkspaceEntry[];
}

/**
 * 현재 열린 모든 VS Code Workspace Root와 각 Root의 전체 Tree를 수집한다.
 *
 * @param workspaceFoldersSource Workspace Folder 목록을 제공하는 VS Code Workspace
 * @param fileSystem Directory 항목을 읽는 최소 Workspace FileSystem 의존성
 * @param logger Directory 탐색 실패 warning을 기록할 Extension Host logger
 * @returns 재귀 탐색을 완료한 Workspace Snapshot
 */
export async function createWorkspaceSnapshot(
	workspaceFoldersSource: WorkspaceFoldersSource = vscode.workspace,
	fileSystem: WorkspaceFileSystem = vscode.workspace.fs,
	logger: WorkspaceLogger = console,
): Promise<WorkspaceSnapshot> {
	return {
		roots: await Promise.all(
			(workspaceFoldersSource.workspaceFolders ?? []).map(
				(workspaceFolder) => createWorkspaceRoot(
					workspaceFolder,
					fileSystem,
					logger,
				),
			),
		),
	};
}

/** VS Code Workspace Folder와 전체 하위 Tree를 Root 모델로 변환한다. */
async function createWorkspaceRoot(
	workspaceFolder: vscode.WorkspaceFolder,
	fileSystem: WorkspaceFileSystem,
	logger: WorkspaceLogger,
): Promise<WorkspaceRoot> {
	return {
		id: `workspace-root:${workspaceFolder.uri.toString()}`,
		name: workspaceFolder.name,
		uri: workspaceFolder.uri,
		...(await readWorkspaceDirectory(workspaceFolder.uri, fileSystem, logger)),
	};
}

/** Directory의 직계 항목을 읽고 하위 Directory를 재귀적으로 탐색한다. */
async function readWorkspaceDirectory(
	parentUri: vscode.Uri,
	fileSystem: WorkspaceFileSystem,
	logger: WorkspaceLogger,
): Promise<WorkspaceDirectoryResult> {
	let directoryEntries: [string, vscode.FileType][];

	try {
		directoryEntries = await fileSystem.readDirectory(parentUri);
	} catch (error) {
		logger.warn(
			`[Crispy] Failed to read Workspace Directory: ${parentUri.toString()}`,
			error,
		);
		return { status: 'unreadable', children: [] };
	}

	const workspaceEntries = await Promise.all(
		directoryEntries.map(async ([name, fileType]): Promise<WorkspaceEntry | undefined> => {
			const uri = vscode.Uri.joinPath(parentUri, name);

			if (fileType === vscode.FileType.Directory) {
				return createFolder(name, uri, fileSystem, logger);
			}

			if (fileType === vscode.FileType.File) {
				return createFile(name, uri);
			}

			return undefined;
		}),
	);

	return {
		status: 'loaded',
		children: workspaceEntries.filter(
			(entry): entry is WorkspaceEntry => entry !== undefined,
		),
	};
}

/** Directory를 전체 children이 채워진 Folder 모델로 변환한다. */
async function createFolder(
	name: string,
	uri: vscode.Uri,
	fileSystem: WorkspaceFileSystem,
	logger: WorkspaceLogger,
): Promise<Folder> {
	return {
		kind: 'folder',
		id: `folder:${uri.toString()}`,
		name,
		uri,
		...(await readWorkspaceDirectory(uri, fileSystem, logger)),
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
