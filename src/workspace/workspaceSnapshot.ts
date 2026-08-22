import * as vscode from 'vscode';
import type {
	File,
	Folder,
	WorkspaceDirectoryStatus,
	WorkspaceEntry,
	WorkspaceRoot,
	WorkspaceSnapshot,
} from './workspaceModel';
import {
	matchesWorkspaceFilterRule,
	type WorkspaceFilter,
} from './workspaceFilter';
import type { WorkspaceRootFilter } from './workspaceFilterPersistence';

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
 * @param rootFilters Workspace Root URI별로 적용할 검증된 Filter 목록
 * @returns 재귀 탐색을 완료한 Workspace Snapshot
 */
export async function createWorkspaceSnapshot(
	workspaceFoldersSource: WorkspaceFoldersSource = vscode.workspace,
	fileSystem: WorkspaceFileSystem = vscode.workspace.fs,
	logger: WorkspaceLogger = console,
	rootFilters: readonly WorkspaceRootFilter[] = [],
): Promise<WorkspaceSnapshot> {
	const filtersByRootUri = new Map(rootFilters.map(({ rootUri, filter }) => [
		rootUri.toString(),
		filter,
	]));

	return {
		roots: await Promise.all(
			(workspaceFoldersSource.workspaceFolders ?? []).map(
				(workspaceFolder) => createWorkspaceRoot(
					workspaceFolder,
					fileSystem,
					logger,
					filtersByRootUri.get(workspaceFolder.uri.toString()),
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
	filter: WorkspaceFilter | undefined,
): Promise<WorkspaceRoot> {
	return {
		id: `workspace-root:${workspaceFolder.uri.toString()}`,
		name: workspaceFolder.name,
		uri: workspaceFolder.uri,
		...(await readWorkspaceDirectory(
			workspaceFolder.uri,
			fileSystem,
			logger,
			filter,
		)),
	};
}

/** Directory의 직계 항목을 읽고 하위 Directory를 재귀적으로 탐색한다. */
async function readWorkspaceDirectory(
	parentUri: vscode.Uri,
	fileSystem: WorkspaceFileSystem,
	logger: WorkspaceLogger,
	filter: WorkspaceFilter | undefined,
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
			if (name === '.crispy' && fileType === vscode.FileType.Directory) {
				return undefined;
			}

			if (fileType === vscode.FileType.Directory) {
				if (isFiltered(filter, 'folder', name)) {
					return undefined;
				}

				return createFolder(
					name,
					vscode.Uri.joinPath(parentUri, name),
					fileSystem,
					logger,
					filter,
				);
			}

			if (fileType === vscode.FileType.File) {
				return isFiltered(filter, 'file', name)
					? undefined
					: createFile(name, vscode.Uri.joinPath(parentUri, name));
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
	filter: WorkspaceFilter | undefined,
): Promise<Folder> {
	return {
		kind: 'folder',
		id: `folder:${uri.toString()}`,
		name,
		uri,
		...(await readWorkspaceDirectory(uri, fileSystem, logger, filter)),
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

/** 검증된 Root Filter가 대상 종류와 basename을 제외하는지 확인한다. */
function isFiltered(
	filter: WorkspaceFilter | undefined,
	kind: 'folder' | 'file',
	basename: string,
): boolean {
	return filter?.rules.some(
		(rule) => matchesWorkspaceFilterRule(rule, kind, basename),
	) ?? false;
}
