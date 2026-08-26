import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
	WorkspaceGitFileStatus,
	WorkspaceGitStatusEntry,
} from '../messages';
import { matchesWorkspaceFilterRule } from './workspaceFilter';
import type { WorkspaceRootFilter } from './workspaceFilterPersistence';
import { createWorkspaceRootId } from './workspaceRootId';

/** VS Code built-in Git extension API의 public Status 숫자 계약이다. */
export const VSCODE_GIT_STATUS = {
	INDEX_MODIFIED: 0,
	INDEX_ADDED: 1,
	INDEX_DELETED: 2,
	INDEX_RENAMED: 3,
	INDEX_COPIED: 4,
	MODIFIED: 5,
	DELETED: 6,
	UNTRACKED: 7,
	IGNORED: 8,
	INTENT_TO_ADD: 9,
	INTENT_TO_RENAME: 10,
	TYPE_CHANGED: 11,
	ADDED_BY_US: 12,
	ADDED_BY_THEM: 13,
	DELETED_BY_US: 14,
	DELETED_BY_THEM: 15,
	BOTH_ADDED: 16,
	BOTH_DELETED: 17,
	BOTH_MODIFIED: 18,
} as const;

/** 외부 Git API 객체를 최소한의 읽기 전용 경계로 축소한다. */
export interface WorkspaceGitChange {
	readonly uri: vscode.Uri;
	readonly originalUri?: vscode.Uri;
	readonly renameUri?: vscode.Uri;
	readonly status: number;
}

export interface WorkspaceGitRepositoryState {
	readonly indexChanges: readonly WorkspaceGitChange[];
	readonly workingTreeChanges: readonly WorkspaceGitChange[];
	readonly untrackedChanges: readonly WorkspaceGitChange[];
	readonly mergeChanges: readonly WorkspaceGitChange[];
}

export interface WorkspaceGitRepositorySnapshot {
	readonly rootUri: vscode.Uri;
	readonly state: WorkspaceGitRepositoryState;
}

/** 상세 뷰에서 HEAD 원본을 조회할 때 쓰는 현재 file 상태다. */
export interface WorkspaceGitFileState {
	readonly nodeId: string;
	readonly uri: vscode.Uri;
	readonly originalUri?: vscode.Uri;
	readonly repositoryRootUri: vscode.Uri;
	readonly status: WorkspaceGitFileStatus;
}

export interface WorkspaceGitProjection {
	readonly entries: readonly WorkspaceGitStatusEntry[];
	readonly fileStates: ReadonlyMap<string, WorkspaceGitFileState>;
}

interface NormalizedChange {
	readonly status: WorkspaceGitFileStatus;
	readonly uri: vscode.Uri;
	readonly originalUri?: vscode.Uri;
	readonly repositoryRootUri: vscode.Uri;
}

const STATUS_PRIORITY: Readonly<Record<WorkspaceGitFileStatus, number>> = {
	untracked: 0,
	added: 1,
	modified: 2,
	renamed: 3,
	deleted: 4,
	conflict: 5,
};

/**
 * Git repository state를 Graph와 독립적인 전체 교체 snapshot으로 투영한다.
 * 파일만 direct 상태를 가지며 folder/project는 ancestor ID 집계 대상으로만 남는다.
 */
export function createWorkspaceGitProjection(
	repositories: readonly WorkspaceGitRepositorySnapshot[],
	workspaceFolders: readonly vscode.WorkspaceFolder[],
	rootFilters: readonly WorkspaceRootFilter[] = [],
): WorkspaceGitProjection {
	const filtersByRoot = new Map(rootFilters.map(({ rootUri, filter }) => [
		rootUri.toString(),
		filter,
	]));
	const changes = new Map<string, NormalizedChange>();
	const orderedRepositories = [...repositories].sort(
		(left, right) => right.rootUri.path.length - left.rootUri.path.length,
	);

	for (const repository of orderedRepositories) {
		for (const change of collectRepositoryChanges(repository.state)) {
			const status = normalizeWorkspaceGitStatus(change.status);

			if (!status) {
				continue;
			}
			// Public Git API는 rename 여부와 관계없이 current resource에 `uri`를
			// 사용하도록 보장한다. renameUri는 이전 API 객체 검증/진단용으로만 둔다.
			const uri = change.uri;
			const key = uri.toString();
			const existing = changes.get(key);

			if (!existing || STATUS_PRIORITY[status] > STATUS_PRIORITY[existing.status]) {
				changes.set(key, {
					status,
					uri,
					...(change.originalUri
						&& change.originalUri.toString() !== uri.toString()
						? { originalUri: change.originalUri }
						: {}),
					repositoryRootUri: repository.rootUri,
				});
			}
		}
	}

	const entries: WorkspaceGitStatusEntry[] = [];
	const fileStates = new Map<string, WorkspaceGitFileState>();

	for (const change of changes.values()) {
		const workspaceFolder = findOwningWorkspaceFolder(
			change.uri,
			workspaceFolders,
		) ?? (change.originalUri
			? findOwningWorkspaceFolder(change.originalUri, workspaceFolders)
			: undefined);

		if (!workspaceFolder) {
			continue;
		}
		const filter = filtersByRoot.get(workspaceFolder.uri.toString());
		const currentVisible = isWorkspacePathVisible(
			workspaceFolder.uri,
			change.uri,
			filter,
		);
		const originalVisible = change.originalUri
			? isWorkspacePathVisible(workspaceFolder.uri, change.originalUri, filter)
			: false;

		if (!currentVisible && !originalVisible) {
			continue;
		}
		const ancestorNodeIds = uniqueStrings([
			...(currentVisible
				? createWorkspaceAncestorNodeIds(workspaceFolder.uri, change.uri)
				: []),
			...(originalVisible && change.originalUri
				? createWorkspaceAncestorNodeIds(workspaceFolder.uri, change.originalUri)
				: []),
		]);
		const hasDirectNode = change.status !== 'deleted' && currentVisible;
		const nodeId = hasDirectNode ? `file:${change.uri.toString()}` : undefined;

		entries.push({
			status: change.status,
			...(nodeId ? { nodeId } : {}),
			ancestorNodeIds,
		});
		if (nodeId) {
			fileStates.set(nodeId, {
				nodeId,
				uri: change.uri,
				...(change.originalUri ? { originalUri: change.originalUri } : {}),
				repositoryRootUri: change.repositoryRootUri,
				status: change.status,
			});
		}
	}

	entries.sort(compareWorkspaceGitEntries);

	return { entries, fileStates };
}

/** built-in Git Status 값을 UI가 이해하는 단일 상태로 축약한다. */
export function normalizeWorkspaceGitStatus(
	status: number,
): WorkspaceGitFileStatus | undefined {
	switch (status) {
		case VSCODE_GIT_STATUS.UNTRACKED:
			return 'untracked';
		case VSCODE_GIT_STATUS.INDEX_ADDED:
		case VSCODE_GIT_STATUS.INTENT_TO_ADD:
			return 'added';
		case VSCODE_GIT_STATUS.INDEX_MODIFIED:
		case VSCODE_GIT_STATUS.MODIFIED:
		case VSCODE_GIT_STATUS.TYPE_CHANGED:
			return 'modified';
		case VSCODE_GIT_STATUS.INDEX_RENAMED:
		case VSCODE_GIT_STATUS.INDEX_COPIED:
		case VSCODE_GIT_STATUS.INTENT_TO_RENAME:
			return 'renamed';
		case VSCODE_GIT_STATUS.INDEX_DELETED:
		case VSCODE_GIT_STATUS.DELETED:
			return 'deleted';
		case VSCODE_GIT_STATUS.ADDED_BY_US:
		case VSCODE_GIT_STATUS.ADDED_BY_THEM:
		case VSCODE_GIT_STATUS.DELETED_BY_US:
		case VSCODE_GIT_STATUS.DELETED_BY_THEM:
		case VSCODE_GIT_STATUS.BOTH_ADDED:
		case VSCODE_GIT_STATUS.BOTH_DELETED:
		case VSCODE_GIT_STATUS.BOTH_MODIFIED:
			return 'conflict';
		default:
			return undefined;
	}
}

function collectRepositoryChanges(
	state: WorkspaceGitRepositoryState,
): readonly WorkspaceGitChange[] {
	return [
		...state.indexChanges,
		...state.workingTreeChanges,
		...state.untrackedChanges,
		...state.mergeChanges,
	];
}

function findOwningWorkspaceFolder(
	uri: vscode.Uri,
	workspaceFolders: readonly vscode.WorkspaceFolder[],
): vscode.WorkspaceFolder | undefined {
	return [...workspaceFolders]
		.sort((left, right) => right.uri.path.length - left.uri.path.length)
		.find(({ uri: rootUri }) => isUriWithin(rootUri, uri));
}

function isWorkspacePathVisible(
	rootUri: vscode.Uri,
	uri: vscode.Uri,
	filter: WorkspaceRootFilter['filter'],
): boolean {
	const relativePath = getRelativeUriPath(rootUri, uri);

	if (relativePath === undefined || relativePath.length === 0) {
		return false;
	}
	const segments = relativePath.split('/');

	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index];

		if (segment === '.crispy' || filter?.rules.some(
			(rule) => matchesWorkspaceFilterRule(rule, 'folder', segment),
		)) {
			return false;
		}
	}
	const basename = segments.at(-1);

	return basename !== undefined
		&& !(filter?.rules.some(
			(rule) => matchesWorkspaceFilterRule(rule, 'file', basename),
		) ?? false);
}

function createWorkspaceAncestorNodeIds(
	rootUri: vscode.Uri,
	fileUri: vscode.Uri,
): readonly string[] {
	if (!isUriWithin(rootUri, fileUri)) {
		return [];
	}
	const ids: string[] = [];
	let currentPath = path.posix.dirname(fileUri.path);

	while (currentPath !== rootUri.path) {
		if (currentPath === '.' || currentPath === '/' || currentPath.length === 0) {
			return [];
		}
		ids.push(`folder:${fileUri.with({ path: currentPath }).toString()}`);
		const parentPath = path.posix.dirname(currentPath);

		if (parentPath === currentPath) {
			return [];
		}
		currentPath = parentPath;
	}
	ids.push(createWorkspaceRootId(rootUri));

	return ids;
}

function isUriWithin(rootUri: vscode.Uri, uri: vscode.Uri): boolean {
	return rootUri.scheme === uri.scheme
		&& rootUri.authority === uri.authority
		&& getRelativeUriPath(rootUri, uri) !== undefined;
}

function getRelativeUriPath(
	rootUri: vscode.Uri,
	uri: vscode.Uri,
): string | undefined {
	const relativePath = path.posix.relative(rootUri.path, uri.path);

	return relativePath === '..'
		|| relativePath.startsWith('../')
		|| path.posix.isAbsolute(relativePath)
		? undefined
		: relativePath;
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function compareWorkspaceGitEntries(
	left: WorkspaceGitStatusEntry,
	right: WorkspaceGitStatusEntry,
): number {
	const leftKey = left.nodeId ?? left.ancestorNodeIds.join('\0');
	const rightKey = right.nodeId ?? right.ancestorNodeIds.join('\0');

	return leftKey.localeCompare(rightKey) || left.status.localeCompare(right.status);
}
