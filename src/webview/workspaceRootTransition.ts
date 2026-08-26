import {
	WORKSPACE_PERSISTENT_STATE_VERSION,
	type WorkspacePersistentState,
	type WorkspaceTaskRelocation,
} from '../workspace/workspaceMetadata';
import type { WorkspaceTaskRecord } from '../task';
import { resolveTaskGraphTargetSourceRootId } from './task/taskGraphTargetLayout';

export type WorkspacePersistentGraphState = Pick<
	WorkspacePersistentState,
	| 'nodePositions'
	| 'fileGroupPages'
	| 'openedFolders'
	| 'detachedRootNodeIds'
	| 'hiddenNodeIds'
>;

export type WorkspacePersistentTaskState = Pick<
	WorkspacePersistentState,
	'tasks' | 'taskRelocations'
>;

export function haveSameWorkspaceRoots(
	left: readonly string[],
	right: readonly string[],
): boolean {
	const sortedLeft = [...left].sort();
	const sortedRight = [...right].sort();

	return sortedLeft.length === sortedRight.length
		&& sortedLeft.every((rootId, index) => rootId === sortedRight[index]);
}

/**
 * Root 전환 중에는 소유 Root가 계속 유지된 entry만 Webview 값을 택한다.
 * 새로 추가됐거나 nested ownership이 바뀐 entry는 Host canonical 값을 택한다.
 */
export function mergeWorkspaceStateForRootTransition(
	current: WorkspacePersistentState,
	incoming: WorkspacePersistentState,
	previousRootIds: readonly string[],
	nextRootIds: readonly string[],
): WorkspacePersistentState {
	const retainedRootIds = new Set(previousRootIds.filter(
		(rootId) => nextRootIds.includes(rootId),
	));
	const addedRootIds = new Set(nextRootIds.filter(
		(rootId) => !previousRootIds.includes(rootId),
	));
	const mergeEntries = <Value>(
		currentEntries: Readonly<Record<string, Value>>,
		incomingEntries: Readonly<Record<string, Value>>,
		fileGroupEntry = false,
	): Record<string, Value> => {
		const merged: Record<string, Value> = {};
		const ids = new Set([
			...Object.keys(currentEntries),
			...Object.keys(incomingEntries),
		]);

		for (const id of ids) {
			const previousOwnerRootId = resolveWorkspaceGraphEntryRootId(
				id,
				previousRootIds,
				fileGroupEntry,
			);
			const nextOwnerRootId = resolveWorkspaceGraphEntryRootId(
				id,
				nextRootIds,
				fileGroupEntry,
			);
			const ownershipUnchanged = previousOwnerRootId === nextOwnerRootId
				&& retainedRootIds.has(nextOwnerRootId);

			if (ownershipUnchanged) {
				if (Object.hasOwn(currentEntries, id)) {
					merged[id] = currentEntries[id] as Value;
				}
			} else if (
				nextRootIds.includes(nextOwnerRootId)
				&& Object.hasOwn(incomingEntries, id)
			) {
				merged[id] = incomingEntries[id] as Value;
			}
		}
		return merged;
	};
	const activeNextRootIds = new Set(nextRootIds);
	const currentTaskIds = new Set(current.tasks.map((record) => record.task.id));
	const canApplyIncomingRelocation = (
		relocation: WorkspaceTaskRelocation,
	): boolean => (
		!activeNextRootIds.has(relocation.record.ownerRootId)
		|| addedRootIds.has(relocation.sourceRootId)
		|| addedRootIds.has(relocation.record.ownerRootId)
		|| currentTaskIds.has(relocation.record.task.id)
	);
	const tasksById = new Map<string, WorkspaceTaskRecord>();
	const mergeTask = (record: WorkspaceTaskRecord): void => {
		const existing = tasksById.get(record.task.id);

		if (!existing || isPreferredTaskRecord(record, existing)) {
			tasksById.set(record.task.id, record);
		}
	};

	for (const record of incoming.tasks) {
		if (
			addedRootIds.has(record.ownerRootId)
			|| incoming.taskRelocations.some((relocation) => (
				canApplyIncomingRelocation(relocation)
				&& relocation.record.task.id === record.task.id
				&& relocation.record.ownerRootId === record.ownerRootId
				&& relocation.record.storageRevision <= record.storageRevision
			))
		) {
			mergeTask(record);
		}
	}

	for (const record of current.tasks) {
		if (!retainedRootIds.has(record.ownerRootId)) {
			continue;
		}
		mergeTask(record);
	}
	for (const relocation of incoming.taskRelocations) {
		// inactive destination도 전역 winner 후보로 삼아 연쇄 이동의 이전 active
		// owner가 retained Webview record에서 부활하지 않게 한다.
		if (canApplyIncomingRelocation(relocation)) {
			mergeTask(relocation.record);
		}
	}

	return {
		version: WORKSPACE_PERSISTENT_STATE_VERSION,
		nodePositions: mergeEntries(
			current.nodePositions,
			incoming.nodePositions,
			true,
		),
		fileGroupPages: mergeEntries(
			current.fileGroupPages,
			incoming.fileGroupPages,
			true,
		),
		openedFolders: mergeEntries(current.openedFolders, incoming.openedFolders),
		detachedRootNodeIds: mergeEntries(
			current.detachedRootNodeIds,
			incoming.detachedRootNodeIds,
		),
		hiddenNodeIds: mergeEntries(current.hiddenNodeIds, incoming.hiddenNodeIds),
		tasks: [...tasksById.values()].filter((record) => (
			activeNextRootIds.has(record.ownerRootId)
		)),
		taskRelocations: [],
		taskStorageReceipts: incoming.taskStorageReceipts,
	};
}

/**
 * 오래된 Webview snapshot은 old/current topology에서 owner가 바뀌지 않고 모든
 * 중간 epoch에 계속 존재한 Root의 entry만 덮어쓴다. ownership이 이동한 entry는
 * 현재 Host canonical 값을 유지해 nested Root 제거/추가 중 상태를 잃지 않는다.
 */
export function mergeContinuouslyRetainedWorkspaceGraphState(
	current: WorkspacePersistentGraphState,
	previous: WorkspacePersistentGraphState,
	previousRootIds: readonly string[],
	currentRootIds: readonly string[],
	continuouslyRetainedRootIds: ReadonlySet<string>,
): WorkspacePersistentGraphState {
	const activeCurrentRootIds = new Set(currentRootIds);
	const mergeEntries = <Value>(
		currentEntries: Readonly<Record<string, Value>>,
		previousEntries: Readonly<Record<string, Value>>,
		fileGroupEntry = false,
	): Record<string, Value> => {
		const merged: Record<string, Value> = {};
		const ids = new Set([
			...Object.keys(currentEntries),
			...Object.keys(previousEntries),
		]);

		for (const id of ids) {
			const previousOwnerRootId = resolveWorkspaceGraphEntryRootId(
				id,
				previousRootIds,
				fileGroupEntry,
			);
			const currentOwnerRootId = resolveWorkspaceGraphEntryRootId(
				id,
				currentRootIds,
				fileGroupEntry,
			);
			const canOverlayPrevious = previousOwnerRootId === currentOwnerRootId
				&& continuouslyRetainedRootIds.has(currentOwnerRootId);

			if (canOverlayPrevious) {
				if (Object.hasOwn(previousEntries, id)) {
					merged[id] = previousEntries[id] as Value;
				}
			} else if (
				activeCurrentRootIds.has(currentOwnerRootId)
				&& Object.hasOwn(currentEntries, id)
			) {
				merged[id] = currentEntries[id] as Value;
			}
		}
		return merged;
	};

	return {
		nodePositions: mergeEntries(
			current.nodePositions,
			previous.nodePositions,
			true,
		),
		fileGroupPages: mergeEntries(
			current.fileGroupPages,
			previous.fileGroupPages,
			true,
		),
		openedFolders: mergeEntries(current.openedFolders, previous.openedFolders),
		detachedRootNodeIds: mergeEntries(
			current.detachedRootNodeIds,
			previous.detachedRootNodeIds,
		),
		hiddenNodeIds: mergeEntries(current.hiddenNodeIds, previous.hiddenNodeIds),
	};
}

/** File Group 합성 suffix를 제외해 disk partition과 같은 Root를 계산한다. */
function resolveWorkspaceGraphEntryRootId(
	id: string,
	rootIds: readonly string[],
	fileGroupEntry: boolean,
): string {
	const sourceId = fileGroupEntry && id.endsWith(':files')
		? id.slice(0, -':files'.length)
		: id;

	return resolveTaskGraphTargetSourceRootId(sourceId, '', rootIds);
}

/**
 * 오래된 Webview의 미반영 Task 편집과 현재 Host의 복구 상태를 revision으로 병합한다.
 * 이전 context record는 owner/source Root가 모든 중간 epoch에 계속 유지된 경우에만
 * 후보가 되며, 동률은 disk merge와 같은 canonical JSON 순서로 결정한다.
 */
export function mergeContinuouslyRetainedWorkspaceTaskState(
	current: WorkspacePersistentTaskState,
	previous: WorkspacePersistentTaskState,
	previousRootIds: readonly string[],
	currentRootIds: readonly string[],
	continuouslyRetainedRootIds: ReadonlySet<string>,
): WorkspacePersistentTaskState {
	const activePreviousRootIds = new Set(previousRootIds);
	const activeCurrentRootIds = new Set(currentRootIds);
	const tasksById = new Map<string, WorkspaceTaskRecord>();
	const relocationsByKey = new Map<string, WorkspaceTaskRelocation>();
	const eligiblePreviousTaskIds = new Set(previous.tasks.filter((record) => (
		activePreviousRootIds.has(record.ownerRootId)
		&& activeCurrentRootIds.has(record.ownerRootId)
		&& continuouslyRetainedRootIds.has(record.ownerRootId)
	)).map((record) => record.task.id));
	const canApplyCurrentRelocation = (
		relocation: WorkspaceTaskRelocation,
	): boolean => (
		activeCurrentRootIds.has(relocation.sourceRootId)
		&& (
			!activeCurrentRootIds.has(relocation.record.ownerRootId)
			|| !continuouslyRetainedRootIds.has(relocation.sourceRootId)
			|| !continuouslyRetainedRootIds.has(relocation.record.ownerRootId)
			|| eligiblePreviousTaskIds.has(relocation.record.task.id)
		)
	);
	const isRecoveredCurrentTask = (record: WorkspaceTaskRecord): boolean => (
		current.taskRelocations.some((relocation) => (
			canApplyCurrentRelocation(relocation)
			&& relocation.record.task.id === record.task.id
			&& relocation.record.ownerRootId === record.ownerRootId
			&& relocation.record.storageRevision <= record.storageRevision
		))
	);
	const mergeTask = (record: WorkspaceTaskRecord): void => {
		const existing = tasksById.get(record.task.id);

		if (!existing || isPreferredTaskRecord(record, existing)) {
			tasksById.set(record.task.id, record);
		}
	};
	const mergeRelocation = (relocation: WorkspaceTaskRelocation): void => {
		const key = JSON.stringify([
			relocation.sourceRootId,
			relocation.record.task.id,
		]);
		const existing = relocationsByKey.get(key);

		if (
			!existing
			|| isPreferredTaskRecord(relocation.record, existing.record)
		) {
			relocationsByKey.set(key, relocation);
		}
	};

	for (const record of current.tasks) {
		if (
			activeCurrentRootIds.has(record.ownerRootId)
			&& (
				!activePreviousRootIds.has(record.ownerRootId)
				|| !continuouslyRetainedRootIds.has(record.ownerRootId)
				|| eligiblePreviousTaskIds.has(record.task.id)
				|| isRecoveredCurrentTask(record)
			)
		) {
			mergeTask(record);
		}
	}
	for (const record of previous.tasks) {
		if (
			activePreviousRootIds.has(record.ownerRootId)
			&& activeCurrentRootIds.has(record.ownerRootId)
			&& continuouslyRetainedRootIds.has(record.ownerRootId)
		) {
			mergeTask(record);
		}
	}
	for (const relocation of current.taskRelocations) {
		if (canApplyCurrentRelocation(relocation)) {
			mergeRelocation(relocation);
		}
	}
	for (const relocation of previous.taskRelocations) {
		if (
			activePreviousRootIds.has(relocation.sourceRootId)
			&& activeCurrentRootIds.has(relocation.sourceRootId)
			&& continuouslyRetainedRootIds.has(relocation.sourceRootId)
		) {
			mergeRelocation(relocation);
		}
	}

	for (const relocation of relocationsByKey.values()) {
		// active 여부를 보기 전에 live와 모든 journal의 전역 winner를 고른다.
		// 연쇄 이동의 최신 destination이 비활성이면 이전 active owner가 부활하면 안 된다.
		mergeTask(relocation.record);
	}

	return {
		tasks: [...tasksById.values()].filter((record) => (
			activeCurrentRootIds.has(record.ownerRootId)
		)),
		taskRelocations: [...relocationsByKey.values()],
	};
}

/** revision과 key-order independent canonical JSON으로 Task winner를 고른다. */
function isPreferredTaskRecord(
	candidate: WorkspaceTaskRecord,
	current: WorkspaceTaskRecord,
): boolean {
	if (candidate.storageRevision !== current.storageRevision) {
		return candidate.storageRevision > current.storageRevision;
	}

	return createCanonicalJson(candidate) < createCanonicalJson(current);
}

function createCanonicalJson(value: unknown): string {
	return JSON.stringify(sortJsonObjectKeys(value));
}

function sortJsonObjectKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortJsonObjectKeys);
	}
	if (!value || typeof value !== 'object') {
		return value;
	}

	return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (
		left < right ? -1 : left > right ? 1 : 0
	)).map(([key, entry]) => [key, sortJsonObjectKeys(entry)]));
}
