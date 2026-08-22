import * as vscode from 'vscode';
import { readDefaultWorkspaceFilter } from './workspaceDefaultFilter';
import {
	parseWorkspaceFilterJson,
	type WorkspaceFilter,
} from './workspaceFilter';

type WorkspaceFilterFileSystem = Pick<
	typeof vscode.workspace.fs,
	'createDirectory' | 'readFile' | 'writeFile'
>;

/** Root URI와 해당 Root에서 로드된 Workspace Filter를 함께 유지한다. */
export interface WorkspaceRootFilter {
	readonly rootUri: vscode.Uri;
	readonly filter: WorkspaceFilter | undefined;
}

const CRISPY_DIRECTORY_NAME = '.crispy';
const WORKSPACE_FILTER_FILE_NAME = 'filter.json';
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * Workspace Root의 `.crispy/filter.json`을 읽고, 파일이 없을 때만 기본
 * Workspace Filter로 최초 생성한다. 기존 파일의 read 또는 검증 실패와
 * 초기화 실패는 기존 파일을 덮어쓰지 않고 undefined로 격리한다.
 */
export async function loadOrCreateWorkspaceFilter(
	rootUri: vscode.Uri,
	extensionUri: vscode.Uri,
	fileSystem: WorkspaceFilterFileSystem = vscode.workspace.fs,
): Promise<WorkspaceFilter | undefined> {
	const filterUri = getWorkspaceFilterUri(rootUri);

	try {
		const content = await fileSystem.readFile(filterUri);

		return parseWorkspaceFilterJson(textDecoder.decode(content));
	} catch (error) {
		if (!isFileNotFoundError(error)) {
			return undefined;
		}
	}

	const defaultFilter = await readDefaultWorkspaceFilter(
		extensionUri,
		fileSystem,
	);

	if (!defaultFilter) {
		return undefined;
	}

	try {
		await fileSystem.createDirectory(getCrispyDirectoryUri(rootUri));
		await fileSystem.writeFile(
			filterUri,
			textEncoder.encode(JSON.stringify(defaultFilter)),
		);

		return defaultFilter;
	} catch {
		return undefined;
	}
}

/** 모든 Workspace Root의 Filter 로드와 최초 생성을 Root별로 독립 수행한다. */
export async function loadOrCreateWorkspaceFilters(
	rootUris: readonly vscode.Uri[],
	extensionUri: vscode.Uri,
	fileSystem: WorkspaceFilterFileSystem = vscode.workspace.fs,
): Promise<WorkspaceRootFilter[]> {
	return Promise.all(rootUris.map(async (rootUri) => ({
		rootUri,
		filter: await loadOrCreateWorkspaceFilter(
			rootUri,
			extensionUri,
			fileSystem,
		),
	})));
}

/** Workspace Root의 Crispy metadata Directory URI를 계산한다. */
function getCrispyDirectoryUri(rootUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(rootUri, CRISPY_DIRECTORY_NAME);
}

/** Workspace Root의 `.crispy/filter.json` URI를 계산한다. */
function getWorkspaceFilterUri(rootUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(
		getCrispyDirectoryUri(rootUri),
		WORKSPACE_FILTER_FILE_NAME,
	);
}

/** VS Code FileSystem의 missing-file 오류만 최초 생성 조건으로 구분한다. */
function isFileNotFoundError(error: unknown): boolean {
	return error instanceof vscode.FileSystemError
		&& error.code === 'FileNotFound';
}
