import * as vscode from 'vscode';
import type { WorkspaceMutableNodeKind } from '../messages';
import type { TaskBlueprint, WorkspaceTaskRecord } from '../task';
import {
	createGraphLayoutNodeId,
	getGraphLayoutRootId,
	getGraphLayoutSourceId,
} from '../webview/graph/graphLayout';
import {
	createDetachedRootId,
	getDetachedRootNodeId,
	getDetachedRootOrdinal,
	getDetachedRootOriginId,
	isDetachedRootId,
} from '../webview/graph/graphRootPromotion';
import {
	WORKSPACE_PERSISTENT_STATE_VERSION,
	type WorkspacePersistentState,
} from './workspaceMetadata';

export type { WorkspaceMutableNodeKind } from '../messages';

/** URI 기반 Graph ID를 이름 변경 전후로 변환하는 순수 경계다. */
export interface WorkspaceNodeIdRebaser {
	rebase(id: string): string;
	matches(id: string): boolean;
}

const FILE_ID_PREFIX = 'file:';
const FOLDER_ID_PREFIX = 'folder:';
const FILE_GROUP_SUFFIX = ':files';

/**
 * 선택한 파일 또는 폴더 subtree의 canonical/Detached/occurrence ID를 새 URI로 옮긴다.
 * 폴더 rename은 하위 URI 전체를 같은 상대 경로로 재구성한다.
 */
export function createWorkspaceNodeIdRebaser(
	oldUri: vscode.Uri,
	newUri: vscode.Uri,
	kind: WorkspaceMutableNodeKind,
): WorkspaceNodeIdRebaser {
	const rebaseCanonicalId = (id: string): string => {
		const fileGroup = id.endsWith(FILE_GROUP_SUFFIX);
		const sourceId = fileGroup ? id.slice(0, -FILE_GROUP_SUFFIX.length) : id;
		const parsed = parseCanonicalNodeId(sourceId);

		if (!parsed) {
			return id;
		}
		const rebasedUri = rebaseNodeUri(parsed.uri, oldUri, newUri, kind);

		if (!rebasedUri) {
			return id;
		}
		const rebased = `${parsed.prefix}${rebasedUri.toString()}`;

		return fileGroup ? `${rebased}${FILE_GROUP_SUFFIX}` : rebased;
	};
	const rebaseDetachedRootId = (rootId: string): string => {
		if (!isDetachedRootId(rootId)) {
			return rootId;
		}
		const nodeId = getDetachedRootNodeId(rootId);
		const ordinal = getDetachedRootOrdinal(rootId);

		if (!nodeId || !ordinal) {
			return rootId;
		}
		const originRootId = getDetachedRootOriginId(rootId);

		return createDetachedRootId(
			rebaseCanonicalId(nodeId),
			ordinal,
			originRootId ? rebaseDetachedRootId(originRootId) : undefined,
		);
	};
	const rebase = (id: string): string => {
		const rootId = getGraphLayoutRootId(id);

		if (rootId) {
			return createGraphLayoutNodeId(
				rebaseDetachedRootId(rootId),
				rebaseCanonicalId(getGraphLayoutSourceId(id)),
			);
		}
		if (isDetachedRootId(id)) {
			return rebaseDetachedRootId(id);
		}
		return rebaseCanonicalId(id);
	};

	return {
		rebase,
		matches: (id) => rebase(id) !== id,
	};
}

/** 모든 Graph 상태 key와 Task target/provenance를 새 URI 기반 ID로 옮긴다. */
export function rebaseWorkspaceNodeState(
	state: WorkspacePersistentState,
	rebaser: WorkspaceNodeIdRebaser,
): WorkspacePersistentState {
	return {
		version: WORKSPACE_PERSISTENT_STATE_VERSION,
		nodePositions: rebaseRecordKeys(state.nodePositions, rebaser),
		fileGroupPages: rebaseRecordKeys(state.fileGroupPages, rebaser),
		openedFolders: rebaseRecordKeys(state.openedFolders, rebaser),
		detachedRootNodeIds: rebaseRecordKeys(
			state.detachedRootNodeIds,
			rebaser,
		),
		hiddenNodeIds: rebaseRecordKeys(state.hiddenNodeIds, rebaser),
		tasks: state.tasks.map((record) => rebaseTaskRecord(record, rebaser)),
		taskRelocations: state.taskRelocations.map((relocation) => ({
			...relocation,
			record: rebaseTaskRecord(relocation.record, rebaser),
		})),
		taskStorageReceipts: state.taskStorageReceipts,
	};
}

/** 삭제한 파일 또는 폴더 subtree에 속한 Graph 상태와 Task 참조를 함께 제거한다. */
export function removeWorkspaceNodeState(
	state: WorkspacePersistentState,
	targetUri: vscode.Uri,
	kind: WorkspaceMutableNodeKind,
): WorkspacePersistentState {
	const matcher = createWorkspaceNodeMatcher(targetUri, kind);

	return {
		version: WORKSPACE_PERSISTENT_STATE_VERSION,
		nodePositions: filterRecordKeys(state.nodePositions, matcher),
		fileGroupPages: filterRecordKeys(state.fileGroupPages, matcher),
		openedFolders: filterRecordKeys(state.openedFolders, matcher),
		detachedRootNodeIds: filterRecordKeys(
			state.detachedRootNodeIds,
			matcher,
		),
		hiddenNodeIds: filterRecordKeys(state.hiddenNodeIds, matcher),
		tasks: state.tasks.map((record) => removeTaskRecordTargets(record, matcher)),
		taskRelocations: state.taskRelocations.map((relocation) => ({
			...relocation,
			record: removeTaskRecordTargets(relocation.record, matcher),
		})),
		taskStorageReceipts: state.taskStorageReceipts,
	};
}

function createWorkspaceNodeMatcher(
	targetUri: vscode.Uri,
	kind: WorkspaceMutableNodeKind,
): (id: string) => boolean {
	const matchesCanonicalId = (id: string): boolean => {
		const sourceId = id.endsWith(FILE_GROUP_SUFFIX)
			? id.slice(0, -FILE_GROUP_SUFFIX.length)
			: id;
		const parsed = parseCanonicalNodeId(sourceId);

		return parsed
			? isNodeUriInMutationScope(parsed.uri, targetUri, kind)
			: false;
	};

	return (id) => {
		const rootId = getGraphLayoutRootId(id);

		if (rootId) {
			return matchesCanonicalId(getGraphLayoutSourceId(id))
				|| matchesDetachedRoot(rootId, matchesCanonicalId);
		}
		return isDetachedRootId(id)
			? matchesDetachedRoot(id, matchesCanonicalId)
			: matchesCanonicalId(id);
	};
}

function matchesDetachedRoot(
	rootId: string,
	matchesCanonicalId: (id: string) => boolean,
): boolean {
	const nodeId = getDetachedRootNodeId(rootId);

	if (nodeId && matchesCanonicalId(nodeId)) {
		return true;
	}
	const originRootId = getDetachedRootOriginId(rootId);

	return originRootId
		? matchesDetachedRoot(originRootId, matchesCanonicalId)
		: false;
}

function rebaseRecordKeys<Value>(
	record: Readonly<Record<string, Value>>,
	rebaser: WorkspaceNodeIdRebaser,
): Record<string, Value> {
	return Object.fromEntries(Object.entries(record).map(([id, value]) => [
		rebaser.rebase(id),
		value,
	]));
}

function filterRecordKeys<Value>(
	record: Readonly<Record<string, Value>>,
	matches: (id: string) => boolean,
): Record<string, Value> {
	return Object.fromEntries(Object.entries(record).filter(([id]) => !matches(id)));
}

function rebaseTaskRecord(
	record: WorkspaceTaskRecord,
	rebaser: WorkspaceNodeIdRebaser,
): WorkspaceTaskRecord {
	const task = mapTaskTargets(record.task, (sourceId) => rebaser.rebase(sourceId));
	const targetOrigins = record.targetOrigins.map((origin) => ({
		...origin,
		sourceId: rebaser.rebase(origin.sourceId),
	}));
	const changed = task !== record.task || targetOrigins.some((origin, index) => (
		origin.sourceId !== record.targetOrigins[index]?.sourceId
	));

	return changed
		? {
			...record,
			storageRevision: nextStorageRevision(record.storageRevision),
			task,
			targetOrigins,
		}
		: record;
}

function removeTaskRecordTargets(
	record: WorkspaceTaskRecord,
	matches: (id: string) => boolean,
): WorkspaceTaskRecord {
	const task = filterTaskTargets(record.task, matches);
	const targetOrigins = record.targetOrigins.filter(
		(origin) => !matches(origin.sourceId),
	);
	const changed = task !== record.task
		|| targetOrigins.length !== record.targetOrigins.length;

	return changed
		? {
			...record,
			storageRevision: nextStorageRevision(record.storageRevision),
			task,
			targetOrigins,
		}
		: record;
}

function mapTaskTargets(
	task: TaskBlueprint,
	mapSourceId: (sourceId: string) => string,
): TaskBlueprint {
	const defaultGraphTargets = mapGraphTargets(task.defaultGraphTargets, mapSourceId);
	let changed = defaultGraphTargets !== task.defaultGraphTargets;
	const nodes = task.nodes.map((node) => {
		if (node.kind !== 'work') {
			return node;
		}
		const graphTargets = mapGraphTargets(node.graphTargets, mapSourceId);

		if (graphTargets === node.graphTargets) {
			return node;
		}
		changed = true;
		return { ...node, graphTargets };
	});

	return changed ? { ...task, defaultGraphTargets, nodes } : task;
}

function filterTaskTargets(
	task: TaskBlueprint,
	matches: (sourceId: string) => boolean,
): TaskBlueprint {
	return mapTaskTargets(task, (sourceId) => matches(sourceId) ? '' : sourceId);
}

function mapGraphTargets(
	targets: TaskBlueprint['defaultGraphTargets'],
	mapSourceId: (sourceId: string) => string,
): TaskBlueprint['defaultGraphTargets'] {
	const reference = mapUniqueTargets(targets.reference, mapSourceId);
	const work = mapUniqueTargets(targets.work, mapSourceId);

	return haveSameStrings(reference, targets.reference)
		&& haveSameStrings(work, targets.work)
		? targets
		: { reference, work };
}

function mapUniqueTargets(
	targets: readonly string[],
	mapSourceId: (sourceId: string) => string,
): string[] {
	return [...new Set(targets.map(mapSourceId).filter(Boolean))];
}

function haveSameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length
		&& left.every((value, index) => value === right[index]);
}

function nextStorageRevision(revision: number): number {
	return revision < Number.MAX_SAFE_INTEGER ? revision + 1 : revision;
}

function parseCanonicalNodeId(
	id: string,
): { readonly prefix: typeof FILE_ID_PREFIX | typeof FOLDER_ID_PREFIX; readonly uri: vscode.Uri } | undefined {
	const prefix = id.startsWith(FILE_ID_PREFIX)
		? FILE_ID_PREFIX
		: id.startsWith(FOLDER_ID_PREFIX) ? FOLDER_ID_PREFIX : undefined;

	if (!prefix) {
		return undefined;
	}
	try {
		return { prefix, uri: vscode.Uri.parse(id.slice(prefix.length), true) };
	} catch {
		return undefined;
	}
}

function rebaseNodeUri(
	candidate: vscode.Uri,
	oldUri: vscode.Uri,
	newUri: vscode.Uri,
	kind: WorkspaceMutableNodeKind,
): vscode.Uri | undefined {
	if (!isNodeUriInMutationScope(candidate, oldUri, kind)) {
		return undefined;
	}
	const suffix = kind === 'folder'
		? normalizeUriPath(candidate.path).slice(normalizeUriPath(oldUri.path).length)
		: '';

	return newUri.with({ path: `${normalizeUriPath(newUri.path)}${suffix}` });
}

function isNodeUriInMutationScope(
	candidate: vscode.Uri,
	target: vscode.Uri,
	kind: WorkspaceMutableNodeKind,
): boolean {
	if (candidate.scheme !== target.scheme || candidate.authority !== target.authority) {
		return false;
	}
	const candidatePath = normalizeUriPath(candidate.path);
	const targetPath = normalizeUriPath(target.path);

	return candidatePath === targetPath
		|| (kind === 'folder' && candidatePath.startsWith(`${targetPath}/`));
}

function normalizeUriPath(path: string): string {
	const normalized = path.replace(/\\/g, '/').replace(/\/+$/g, '');

	return normalized || '/';
}
