import * as vscode from 'vscode';
import type { WorkspaceTaskRecord } from '../task/workspaceTaskState';
import {
	createDefaultWorkspacePersistentState,
	parseWorkspacePersistentState,
	type WorkspacePersistentState,
	type WorkspaceTaskRelocation,
	type WorkspaceTaskStorageReceipt,
} from './workspaceMetadata';
import {
	createWorkspaceRootId,
	WORKSPACE_ROOT_ID_PREFIX,
} from './workspaceRootId';
import { collectWorkspaceNodeStateCanonicalIds } from './workspaceNodeStateId';

type WorkspacePersistenceFileSystem = Pick<
	typeof vscode.workspace.fs,
	'createDirectory' | 'readFile' | 'writeFile'
>;

type WorkspaceTrustReader = () => boolean;

/** Disk write가 완료됐는지 Trust 복구 후 재시도가 필요한지 구분한다. */
export type WorkspacePersistenceWriteOutcome =
	| 'written'
	| 'deferred-untrusted';

/** Root URI와 해당 Root가 소유하는 Persistent State를 함께 유지한다. */
export interface WorkspaceRootPersistentState {
	readonly rootUri: vscode.Uri;
	readonly state: WorkspacePersistentState;
}

const CRISPY_DIRECTORY_NAME = '.crispy';
const WORKSPACE_STATE_FILE_NAME = 'state.json';
const writeChains = new Map<string, Promise<WorkspacePersistenceWriteOutcome>>();
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * Workspace Root의 `.crispy/state.json`을 읽고 현재 metadata 형식으로 검증한다.
 * 파일이 없을 때만 새 기본 상태를 반환하고, 읽기 또는 검증 실패는 호출자에게 전파한다.
 */
export async function readWorkspacePersistentState(
	rootUri: vscode.Uri,
	fileSystem: WorkspacePersistenceFileSystem = vscode.workspace.fs,
): Promise<WorkspacePersistentState> {
	let content: Uint8Array;

	try {
		content = await fileSystem.readFile(getWorkspaceStateUri(rootUri));
	} catch (error) {
		if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
			return createDefaultWorkspacePersistentState();
		}
		throw error;
	}
	let value: unknown;

	try {
		value = JSON.parse(textDecoder.decode(content)) as unknown;
	} catch {
		throw new Error('Workspace persistent state JSON is invalid.');
	}
	const state = parseWorkspacePersistentState(value);

	if (!state) {
		throw new Error('Workspace persistent state schema is invalid.');
	}
	return state;
}

/**
 * Workspace Root의 `.crispy/state.json` write를 같은 Root의 호출 순서대로 실행한다.
 * 현재 write 실패는 호출자에게 전파하되 다음 write chain을 막지 않는다.
 */
export function writeWorkspacePersistentState(
	rootUri: vscode.Uri,
	state: WorkspacePersistentState,
	fileSystem: WorkspacePersistenceFileSystem = vscode.workspace.fs,
	readWorkspaceTrust: WorkspaceTrustReader = () => vscode.workspace.isTrusted,
): Promise<WorkspacePersistenceWriteOutcome> {
	const snapshot = parseWorkspacePersistentState(state);

	if (!snapshot) {
		return Promise.reject(new Error('Workspace persistent state is invalid.'));
	}

	const rootKey = rootUri.toString();
	const previousWrite = writeChains.get(rootKey)
		?? Promise.resolve('written' as const);
	const currentWrite = previousWrite.then(
		() => persistWorkspaceState(
			rootUri,
			snapshot,
			fileSystem,
			readWorkspaceTrust,
		),
		() => persistWorkspaceState(
			rootUri,
			snapshot,
			fileSystem,
			readWorkspaceTrust,
		),
	);

	writeChains.set(rootKey, currentWrite);
	void currentWrite.then(
		() => removeCompletedWrite(rootKey, currentWrite),
		() => removeCompletedWrite(rootKey, currentWrite),
	);

	return currentWrite;
}

/** Runtime Persistent State를 URI ownership에 따라 Workspace Root별로 분배한다. */
export function partitionWorkspacePersistentStateByRoot(
	state: WorkspacePersistentState,
	rootUris: readonly vscode.Uri[],
): WorkspaceRootPersistentState[] {
	const source = parseWorkspacePersistentState(state)
		?? createDefaultWorkspacePersistentState();
	const rootStates = rootUris.map((rootUri) => ({
		rootUri,
		state: createDefaultWorkspacePersistentState(),
	}));

	partitionRecord(source.nodePositions, rootStates, rootUris, 'nodePositions');
	partitionRecord(source.fileGroupPages, rootStates, rootUris, 'fileGroupPages');
	partitionRecord(source.openedFolders, rootStates, rootUris, 'openedFolders');
	partitionRecord(
		source.detachedRootNodeIds,
		rootStates,
		rootUris,
		'detachedRootNodeIds',
	);
	partitionRecord(source.hiddenNodeIds, rootStates, rootUris, 'hiddenNodeIds');
	partitionTasks(source.tasks, rootStates);
	partitionTaskRelocations(source.taskRelocations, rootStates);
	partitionTaskStorageReceipts(source.taskStorageReceipts, rootStates);

	return rootStates;
}

/** Root별 metadata를 ownership을 다시 확인해 하나의 Runtime 상태로 병합한다. */
export function mergeWorkspacePersistentStates(
	rootStates: readonly WorkspaceRootPersistentState[],
): WorkspacePersistentState {
	const merged = createDefaultWorkspacePersistentState();
	const rootUris = rootStates.map(({ rootUri }) => rootUri);
	const liveTasksById = new Map<string, WorkspaceTaskRecord>();
	const liveTasksByOwnerKey = new Map<string, WorkspaceTaskRecord>();
	const relocationsByKey = new Map<string, WorkspaceTaskRelocation>();
	const receiptsByKey = new Map<string, WorkspaceTaskStorageReceipt>();

	for (const { rootUri, state } of rootStates) {
		const source = parseWorkspacePersistentState(state);

		if (!source) {
			continue;
		}

		mergeOwnedRecord(
			source.nodePositions,
			merged.nodePositions,
			rootUri,
			rootUris,
		);
		mergeOwnedRecord(
			source.fileGroupPages,
			merged.fileGroupPages,
			rootUri,
			rootUris,
		);
		mergeOwnedRecord(
			source.openedFolders,
			merged.openedFolders,
			rootUri,
			rootUris,
		);
		mergeOwnedRecord(
			source.detachedRootNodeIds,
			merged.detachedRootNodeIds,
			rootUri,
			rootUris,
		);
		mergeOwnedRecord(
			source.hiddenNodeIds,
			merged.hiddenNodeIds,
			rootUri,
			rootUris,
		);
		mergeOwnedTasks(
			source.tasks,
			liveTasksById,
			liveTasksByOwnerKey,
			rootUri,
		);
		mergeOwnedTaskRelocations(
			source.taskRelocations,
			relocationsByKey,
			rootUri,
		);
		mergeOwnedTaskStorageReceipts(
			source.taskStorageReceipts,
			receiptsByKey,
			rootUri,
		);
	}
	const activeRootIds = new Set<string>(rootUris.map(createWorkspaceRootId));
	const resolvedTasks = resolveWorkspaceTaskRecords(
		liveTasksById,
		liveTasksByOwnerKey,
		relocationsByKey.values(),
		receiptsByKey.values(),
	).filter((record) => (
		activeRootIds.has(record.ownerRootId)
	));

	// 실제 active owner에 복구된 record만 receipt를 전진시킨다. 비활성
	// destination journal은 아직 저장되지 않았으므로 receipt를 만들지 않는다.
	for (const record of resolvedTasks) {
		mergeTaskStorageReceipt({
			ownerRootId: record.ownerRootId,
			taskId: record.task.id,
			storageRevision: record.storageRevision,
		}, receiptsByKey);
	}
	merged.tasks = resolvedTasks;
	merged.taskRelocations = [...relocationsByKey.values()];
	merged.taskStorageReceipts = [...receiptsByKey.values()];

	return merged;
}

/** 실제 write 시점에만 `.crispy`를 만들고 검증된 snapshot을 기록한다. */
async function persistWorkspaceState(
	rootUri: vscode.Uri,
	state: WorkspacePersistentState,
	fileSystem: WorkspacePersistenceFileSystem,
	readWorkspaceTrust: WorkspaceTrustReader,
): Promise<WorkspacePersistenceWriteOutcome> {
	if (!isWorkspaceTrusted(readWorkspaceTrust)) {
		return 'deferred-untrusted';
	}
	const crispyDirectoryUri = vscode.Uri.joinPath(
		rootUri,
		CRISPY_DIRECTORY_NAME,
	);

	await fileSystem.createDirectory(crispyDirectoryUri);
	if (!isWorkspaceTrusted(readWorkspaceTrust)) {
		return 'deferred-untrusted';
	}
	await fileSystem.writeFile(
		vscode.Uri.joinPath(crispyDirectoryUri, WORKSPACE_STATE_FILE_NAME),
		textEncoder.encode(JSON.stringify(state)),
	);
	return 'written';
}

/** Trust 판독 실패를 Workspace write 허용으로 해석하지 않는다. */
function isWorkspaceTrusted(readWorkspaceTrust: WorkspaceTrustReader): boolean {
	try {
		return readWorkspaceTrust() === true;
	} catch {
		return false;
	}
}

/** 완료된 write가 아직 Root의 최신 chain일 때만 Map에서 제거한다. */
function removeCompletedWrite(
	rootKey: string,
	write: Promise<WorkspacePersistenceWriteOutcome>,
): void {
	if (writeChains.get(rootKey) === write) {
		writeChains.delete(rootKey);
	}
}

/** Workspace Root 아래 metadata 파일 URI를 계산한다. */
function getWorkspaceStateUri(rootUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(
		rootUri,
		CRISPY_DIRECTORY_NAME,
		WORKSPACE_STATE_FILE_NAME,
	);
}

/** 상태 Map의 각 entry를 가장 구체적인 소유 Root 결과에 복사한다. */
function partitionRecord<
	Key extends keyof Pick<
		WorkspacePersistentState,
		| 'nodePositions'
		| 'fileGroupPages'
		| 'openedFolders'
		| 'detachedRootNodeIds'
		| 'hiddenNodeIds'
	>,
>(
	source: WorkspacePersistentState[Key],
	rootStates: WorkspaceRootPersistentState[],
	rootUris: readonly vscode.Uri[],
	key: Key,
): void {
	for (const [id, value] of Object.entries(source)) {
		const rootIndex = findOwningRootIndex(id, rootUris);

		if (rootIndex < 0) {
			continue;
		}

		const rootState = rootStates[rootIndex];

		if (rootState) {
			(rootState.state[key] as Record<string, unknown>)[id] = value;
		}
	}
}

/** metadata Map에서 현재 Root가 실제로 소유하는 entry만 Runtime Map에 병합한다. */
function mergeOwnedRecord<T>(
	source: Readonly<Record<string, T>>,
	target: Record<string, T>,
	rootUri: vscode.Uri,
	rootUris: readonly vscode.Uri[],
): void {
	for (const [id, value] of Object.entries(source)) {
		const rootIndex = findOwningRootIndex(id, rootUris);
		const owner = rootIndex < 0 ? undefined : rootUris[rootIndex];

		if (owner?.toString() === rootUri.toString()) {
			target[id] = value;
		}
	}
}

/** Task를 명시된 ownerRootId와 정확히 일치하는 Root state에만 분배한다. */
function partitionTasks(
	tasks: readonly WorkspaceTaskRecord[],
	rootStates: WorkspaceRootPersistentState[],
): void {
	const rootIndexes = new Map<string, number>();
	for (const [index, { rootUri }] of rootStates.entries()) {
		const rootId = createWorkspaceRootId(rootUri);

		if (!rootIndexes.has(rootId)) {
			rootIndexes.set(rootId, index);
		}
	}

	for (const task of tasks) {
		const rootIndex = rootIndexes.get(task.ownerRootId);
		const rootState = rootIndex === undefined
			? undefined
			: rootStates[rootIndex];

		if (rootState) {
			(rootState.state.tasks as WorkspaceTaskRecord[]).push(task);
		}
	}
}

/** 이동 journal은 destination이 아니라 명시된 source Root에만 저장한다. */
function partitionTaskRelocations(
	relocations: readonly WorkspaceTaskRelocation[],
	rootStates: WorkspaceRootPersistentState[],
): void {
	const rootIndexes = new Map<string, number>(rootStates.map(({ rootUri }, index) => [
		createWorkspaceRootId(rootUri),
		index,
	]));

	for (const relocation of relocations) {
		const rootIndex = rootIndexes.get(relocation.sourceRootId);
		const rootState = rootIndex === undefined
			? undefined
			: rootStates[rootIndex];

		if (rootState) {
			(rootState.state.taskRelocations as WorkspaceTaskRelocation[]).push(
				relocation,
			);
		}
	}
}

/** Task storage receipt를 명시된 owner Root state에만 분배한다. */
function partitionTaskStorageReceipts(
	receipts: readonly WorkspaceTaskStorageReceipt[],
	rootStates: WorkspaceRootPersistentState[],
): void {
	const rootIndexes = new Map<string, number>(rootStates.map(({ rootUri }, index) => [
		createWorkspaceRootId(rootUri),
		index,
	]));

	for (const receipt of receipts) {
		const rootIndex = rootIndexes.get(receipt.ownerRootId);
		const rootState = rootIndex === undefined
			? undefined
			: rootStates[rootIndex];

		if (rootState) {
			(rootState.state.taskStorageReceipts as WorkspaceTaskStorageReceipt[]).push(
				receipt,
			);
		}
	}
}

/**
 * 물리 Root와 persisted owner가 일치하는 Task만 병합한다.
 * 같은 Task ID는 높은 revision을, 동률이면 canonical record가 앞선 값을 택한다.
 */
function mergeOwnedTasks(
	tasks: readonly WorkspaceTaskRecord[],
	byTaskId: Map<string, WorkspaceTaskRecord>,
	byOwnerKey: Map<string, WorkspaceTaskRecord>,
	rootUri: vscode.Uri,
): void {
	const rootId = createWorkspaceRootId(rootUri);

	for (const candidate of tasks) {
		if (candidate.ownerRootId !== rootId) {
			continue;
		}
		mergePreferredTaskRecord(candidate, byTaskId);
		const ownerKey = createTaskStorageKey(
			candidate.ownerRootId,
			candidate.task.id,
		);
		const current = byOwnerKey.get(ownerKey);

		if (!current || isPreferredTaskRecord(candidate, current)) {
			byOwnerKey.set(ownerKey, candidate);
		}
	}
}

/** 물리 source와 일치하는 이동 journal만 병합하고 중복은 높은 revision을 택한다. */
function mergeOwnedTaskRelocations(
	relocations: readonly WorkspaceTaskRelocation[],
	target: Map<string, WorkspaceTaskRelocation>,
	rootUri: vscode.Uri,
): void {
	const sourceRootId = createWorkspaceRootId(rootUri);

	for (const relocation of relocations) {
		if (relocation.sourceRootId !== sourceRootId) {
			continue;
		}
		const key = JSON.stringify([sourceRootId, relocation.record.task.id]);
		const current = target.get(key);

		if (
			!current
			|| isPreferredTaskRecord(relocation.record, current.record)
		) {
			target.set(key, relocation);
		}
	}
}

/** 물리 Root와 owner가 일치하는 receipt만 병합하고 revision을 단조 증가시킨다. */
function mergeOwnedTaskStorageReceipts(
	receipts: readonly WorkspaceTaskStorageReceipt[],
	target: Map<string, WorkspaceTaskStorageReceipt>,
	rootUri: vscode.Uri,
): void {
	const ownerRootId = createWorkspaceRootId(rootUri);

	for (const receipt of receipts) {
		if (receipt.ownerRootId === ownerRootId) {
			mergeTaskStorageReceipt(receipt, target);
		}
	}
}

/**
 * live record, 아직 destination이 수락하지 않은 journal과 deletion receipt의
 * 전역 revision winner를 고른다. receipt와 같은 revision의 live record는 같은
 * owner에 실제로 존재할 때만 유지해 이미 삭제된 Task를 되살리지 않는다.
 */
function resolveWorkspaceTaskRecords(
	liveTasksById: ReadonlyMap<string, WorkspaceTaskRecord>,
	liveTasksByOwnerKey: ReadonlyMap<string, WorkspaceTaskRecord>,
	relocations: Iterable<WorkspaceTaskRelocation>,
	receipts: Iterable<WorkspaceTaskStorageReceipt>,
): WorkspaceTaskRecord[] {
	const candidateById = new Map(liveTasksById);
	const receiptsByTaskId = new Map<string, WorkspaceTaskStorageReceipt[]>();

	for (const relocation of relocations) {
		mergePreferredTaskRecord(relocation.record, candidateById);
	}
	for (const receipt of receipts) {
		const taskReceipts = receiptsByTaskId.get(receipt.taskId) ?? [];

		taskReceipts.push(receipt);
		receiptsByTaskId.set(receipt.taskId, taskReceipts);
	}

	return [...candidateById.values()].flatMap((candidate) => {
		const live = liveTasksById.get(candidate.task.id);
		const receipt = selectLatestTaskStorageReceipt(
			receiptsByTaskId.get(candidate.task.id) ?? [],
			liveTasksByOwnerKey,
			live,
		);

		if (!receipt || candidate.storageRevision > receipt.storageRevision) {
			return [candidate];
		}
		if (candidate.storageRevision < receipt.storageRevision) {
			return [];
		}

		const matchingLive = liveTasksByOwnerKey.get(createTaskStorageKey(
			receipt.ownerRootId,
			receipt.taskId,
		));

		return matchingLive
			&& matchingLive.storageRevision >= receipt.storageRevision
			? [matchingLive]
			: [];
	});
}

/** 같은 revision이면 실제 live와 일치하지 않는 tombstone receipt를 우선한다. */
function selectLatestTaskStorageReceipt(
	receipts: readonly WorkspaceTaskStorageReceipt[],
	liveTasksByOwnerKey: ReadonlyMap<string, WorkspaceTaskRecord>,
	preferredLive: WorkspaceTaskRecord | undefined,
): WorkspaceTaskStorageReceipt | undefined {
	let selected: WorkspaceTaskStorageReceipt | undefined;

	for (const candidate of receipts) {
		if (!selected || candidate.storageRevision > selected.storageRevision) {
			selected = candidate;
			continue;
		}
		if (candidate.storageRevision < selected.storageRevision) {
			continue;
		}
		const candidateIsTombstone = !hasMatchingLiveTask(
			candidate,
			liveTasksByOwnerKey,
		);
		const selectedIsTombstone = !hasMatchingLiveTask(
			selected,
			liveTasksByOwnerKey,
		);
		const candidateMatchesPreferred = preferredLive?.ownerRootId
			=== candidate.ownerRootId;
		const selectedMatchesPreferred = preferredLive?.ownerRootId
			=== selected.ownerRootId;

		if (
			(candidateIsTombstone && !selectedIsTombstone)
			|| (
				candidateIsTombstone === selectedIsTombstone
				&& candidateMatchesPreferred
				&& !selectedMatchesPreferred
			)
			|| (
				candidateIsTombstone === selectedIsTombstone
				&& candidateMatchesPreferred === selectedMatchesPreferred
				&& candidate.ownerRootId < selected.ownerRootId
			)
		) {
			selected = candidate;
		}
	}
	return selected;
}

function hasMatchingLiveTask(
	receipt: WorkspaceTaskStorageReceipt,
	liveTasksByOwnerKey: ReadonlyMap<string, WorkspaceTaskRecord>,
): boolean {
	const live = liveTasksByOwnerKey.get(createTaskStorageKey(
		receipt.ownerRootId,
		receipt.taskId,
	));

	return !!live && live.storageRevision >= receipt.storageRevision;
}

function mergeTaskStorageReceipt(
	receipt: WorkspaceTaskStorageReceipt,
	target: Map<string, WorkspaceTaskStorageReceipt>,
): void {
	const key = createTaskStorageKey(receipt.ownerRootId, receipt.taskId);
	const current = target.get(key);

	if (!current || receipt.storageRevision > current.storageRevision) {
		target.set(key, receipt);
	}
}

function createTaskStorageKey(ownerRootId: string, taskId: string): string {
	return JSON.stringify([ownerRootId, taskId]);
}

function mergePreferredTaskRecord(
	candidate: WorkspaceTaskRecord,
	target: Map<string, WorkspaceTaskRecord>,
): void {
	const current = target.get(candidate.task.id);

	if (!current || isPreferredTaskRecord(candidate, current)) {
		target.set(candidate.task.id, candidate);
	}
}

/** revision과 canonical JSON 순서로 Task ID 충돌 winner를 결정한다. */
function isPreferredTaskRecord(
	candidate: WorkspaceTaskRecord,
	current: WorkspaceTaskRecord,
): boolean {
	if (candidate.storageRevision !== current.storageRevision) {
		return candidate.storageRevision > current.storageRevision;
	}

	return createCanonicalJson(candidate) < createCanonicalJson(current);
}

/** object key 순서를 제거한 JSON 문자열로 동률 비교를 입력 순서와 분리한다. */
function createCanonicalJson(value: unknown): string {
	return JSON.stringify(sortJsonObjectKeys(value));
}

/** JSON value의 모든 object key를 재귀적으로 정렬한다. */
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

/** Node ID가 나타내는 URI를 포함하는 가장 구체적인 Workspace Root index를 찾는다. */
function findOwningRootIndex(
	id: string,
	rootUris: readonly vscode.Uri[],
): number {
	let ownerIndex = -1;
	let ownerPathLength = -1;

	for (const sourceId of collectWorkspaceNodeStateCanonicalIds(id)) {
		const uri = parseNodeUri(sourceId);

		if (!uri) {
			continue;
		}
		const candidateIndex = findMostSpecificRootIndex(uri, rootUris);
		const candidateRoot = candidateIndex < 0
			? undefined
			: rootUris[candidateIndex];

		if (
			candidateRoot
			&& normalizeUriPath(candidateRoot.path).length > ownerPathLength
		) {
			ownerIndex = candidateIndex;
			ownerPathLength = normalizeUriPath(candidateRoot.path).length;
		}
	}
	return ownerIndex;
}

/** 알려진 Workspace/Graph Node ID prefix 뒤의 URI를 복원한다. */
function parseNodeUri(id: string): vscode.Uri | undefined {
	const prefixes = [WORKSPACE_ROOT_ID_PREFIX, 'folder:', 'file:'] as const;
	const prefix = prefixes.find((candidate) => id.startsWith(candidate));

	if (!prefix) {
		return undefined;
	}

	try {
		return vscode.Uri.parse(id.slice(prefix.length), true);
	} catch {
		return undefined;
	}
}

/** URI 경계를 만족하는 Root 중 path가 가장 긴 Root를 선택한다. */
function findMostSpecificRootIndex(
	uri: vscode.Uri,
	rootUris: readonly vscode.Uri[],
): number {
	let ownerIndex = -1;
	let ownerPathLength = -1;

	for (const [index, rootUri] of rootUris.entries()) {
		if (
			isUriWithinRoot(uri, rootUri)
			&& normalizeUriPath(rootUri.path).length > ownerPathLength
		) {
			ownerIndex = index;
			ownerPathLength = normalizeUriPath(rootUri.path).length;
		}
	}

	return ownerIndex;
}

/** scheme, authority와 slash 경계를 보존해 URI가 Root 또는 하위인지 확인한다. */
function isUriWithinRoot(uri: vscode.Uri, rootUri: vscode.Uri): boolean {
	if (uri.scheme !== rootUri.scheme || uri.authority !== rootUri.authority) {
		return false;
	}

	const rootPath = normalizeUriPath(rootUri.path);
	const candidatePath = normalizeUriPath(uri.path);

	return candidatePath === rootPath
		|| rootPath === '/'
		|| candidatePath.startsWith(`${rootPath}/`);
}

/** URI Root 경계 비교를 위해 `/` 이외 path의 trailing slash를 제거한다. */
function normalizeUriPath(path: string): string {
	return path.length > 1 && path.endsWith('/')
		? path.replace(/\/+$/, '')
		: path;
}
