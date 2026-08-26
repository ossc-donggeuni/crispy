import * as vscode from 'vscode';
import type { WorkspaceMutableNodeKind } from '../messages';
import type { TaskBlueprint, WorkspaceTaskRecord } from '../task';
import {
	WORKSPACE_PERSISTENT_STATE_VERSION,
	type WorkspacePersistentState,
} from './workspaceMetadata';
import { mapWorkspaceNodeStateId } from './workspaceNodeStateId';

export type { WorkspaceMutableNodeKind } from '../messages';

/** URI 기반 Graph ID를 이름 변경 전후로 변환하는 순수 경계다. */
export interface WorkspaceNodeIdRebaser {
	rebase(id: string): string;
	matches(id: string): boolean;
}

const FILE_ID_PREFIX = 'file:';
const FOLDER_ID_PREFIX = 'folder:';

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
		const parsed = parseCanonicalNodeId(id);

		if (!parsed) {
			return id;
		}
		const rebasedUri = rebaseNodeUri(parsed.uri, oldUri, newUri, kind);

		if (!rebasedUri) {
			return id;
		}
		return `${parsed.prefix}${rebasedUri.toString()}`;
	};
	const rebase = (id: string): string => mapWorkspaceNodeStateId(
		id,
		rebaseCanonicalId,
	);

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

/** rename transaction에서 사용하는 모든 persistent source/state ID 변경표를 만든다. */
export function createWorkspaceNodeStateIdChanges(
	state: WorkspacePersistentState,
	rebaser: WorkspaceNodeIdRebaser,
): Record<string, string> {
	const ids = new Set<string>();

	for (const record of [
		state.nodePositions,
		state.fileGroupPages,
		state.openedFolders,
		state.detachedRootNodeIds,
		state.hiddenNodeIds,
	]) {
		for (const id of Object.keys(record)) {
			ids.add(id);
		}
	}
	for (const record of [
		...state.tasks,
		...state.taskRelocations.map((relocation) => relocation.record),
	]) {
		for (const id of collectTaskTargetIds(record)) {
			ids.add(id);
		}
	}
	const changes: Record<string, string> = {};

	for (const id of ids) {
		const nextId = rebaser.rebase(id);

		if (nextId !== id) {
			changes[id] = nextId;
		}
	}
	return changes;
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
		const parsed = parseCanonicalNodeId(id);

		return parsed
			? isNodeUriInMutationScope(parsed.uri, targetUri, kind)
			: false;
	};

	return (id) => {
		let matches = false;

		mapWorkspaceNodeStateId(id, (canonicalId) => {
			matches ||= matchesCanonicalId(canonicalId);
			return canonicalId;
		});
		return matches;
	};
}

function rebaseRecordKeys<Value>(
	record: Readonly<Record<string, Value>>,
	rebaser: WorkspaceNodeIdRebaser,
): Record<string, Value> {
	const rebased: Record<string, Value> = {};
	const changed: [string, Value][] = [];

	for (const [id, value] of Object.entries(record)) {
		const nextId = rebaser.rebase(id);

		if (nextId === id) {
			rebased[id] = value;
		} else {
			changed.push([nextId, value]);
		}
	}
	// 이전 rename의 잔여 key가 있어도 현재 물리 node에서 옮긴 값이 우선한다.
	for (const [id, value] of changed) {
		rebased[id] = value;
	}
	return rebased;
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

function collectTaskTargetIds(record: WorkspaceTaskRecord): Set<string> {
	const ids = new Set(record.targetOrigins.map(({ sourceId }) => sourceId));
	const collect = (targets: TaskBlueprint['defaultGraphTargets']): void => {
		for (const id of [...targets.reference, ...targets.work]) {
			ids.add(id);
		}
	};

	collect(record.task.defaultGraphTargets);
	for (const node of record.task.nodes) {
		if (node.kind === 'work') {
			collect(node.graphTargets);
		}
	}
	return ids;
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
