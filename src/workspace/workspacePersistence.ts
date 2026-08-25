import * as vscode from 'vscode';
import type { WorkspaceTaskRecord } from '../task/workspaceTaskState';
import {
	createDefaultWorkspacePersistentState,
	parseWorkspacePersistentState,
	type WorkspaceTaskRelocation,
	type WorkspacePersistentState,
} from './workspaceMetadata';

type WorkspacePersistenceFileSystem = Pick<
	typeof vscode.workspace.fs,
	'createDirectory' | 'readFile' | 'writeFile'
>;

/** Root URI와 해당 Root가 소유하는 Persistent State를 함께 유지한다. */
export interface WorkspaceRootPersistentState {
	readonly rootUri: vscode.Uri;
	readonly state: WorkspacePersistentState;
}

const CRISPY_DIRECTORY_NAME = '.crispy';
const WORKSPACE_STATE_FILE_NAME = 'state.json';
const writeChains = new Map<string, Promise<void>>();
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * Workspace Root의 `.crispy/state.json`을 읽고 현재 metadata 형식으로 검증한다.
 * 파일이 없거나 읽기, JSON 또는 schema 검증이 실패하면 새 기본 상태를 반환한다.
 */
export async function readWorkspacePersistentState(
	rootUri: vscode.Uri,
	fileSystem: WorkspacePersistenceFileSystem = vscode.workspace.fs,
): Promise<WorkspacePersistentState> {
	try {
		const content = await fileSystem.readFile(getWorkspaceStateUri(rootUri));
		const value = JSON.parse(textDecoder.decode(content)) as unknown;

		return parseWorkspacePersistentState(value)
			?? createDefaultWorkspacePersistentState();
	} catch {
		return createDefaultWorkspacePersistentState();
	}
}

/**
 * Workspace Root의 `.crispy/state.json` write를 같은 Root의 호출 순서대로 실행한다.
 * 현재 write 실패는 호출자에게 전파하되 다음 write chain을 막지 않는다.
 */
export function writeWorkspacePersistentState(
	rootUri: vscode.Uri,
	state: WorkspacePersistentState,
	fileSystem: WorkspacePersistenceFileSystem = vscode.workspace.fs,
): Promise<void> {
	const snapshot = parseWorkspacePersistentState(state);

	if (!snapshot) {
		return Promise.resolve();
	}

	const rootKey = rootUri.toString();
	const previousWrite = writeChains.get(rootKey) ?? Promise.resolve();
	const currentWrite = previousWrite.then(
		() => persistWorkspaceState(rootUri, snapshot, fileSystem),
		() => persistWorkspaceState(rootUri, snapshot, fileSystem),
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

	return rootStates;
}

/** Root별 metadata를 ownership을 다시 확인해 하나의 Runtime 상태로 병합한다. */
export function mergeWorkspacePersistentStates(
	rootStates: readonly WorkspaceRootPersistentState[],
): WorkspacePersistentState {
	const merged = createDefaultWorkspacePersistentState();
	const rootUris = rootStates.map(({ rootUri }) => rootUri);
	const tasksById = new Map<string, WorkspaceTaskRecord>();
	const relocationsByKey = new Map<string, WorkspaceTaskRelocation>();

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
		mergeOwnedTasks(source.tasks, tasksById, rootUri);
		mergeOwnedTaskRelocations(
			source.taskRelocations,
			relocationsByKey,
			rootUri,
		);
	}
	const activeRootIds = new Set(rootUris.map(createWorkspaceRootId));

	for (const relocation of relocationsByKey.values()) {
		// destination이 현재 비활성이어도 먼저 모든 journal과 live record 중
		// 전역 winner를 결정한다. 연쇄 이동의 이전 journal이 활성 Root를
		// 가리키더라도 더 최신 journal의 비활성 owner를 덮어쓰면 안 된다.
		mergePreferredTaskRecord(relocation.record, tasksById);
	}
	merged.tasks = [...tasksById.values()].filter((record) => (
		activeRootIds.has(record.ownerRootId)
	));
	merged.taskRelocations = [...relocationsByKey.values()];

	return merged;
}

/** 실제 write 시점에만 `.crispy`를 만들고 검증된 snapshot을 기록한다. */
async function persistWorkspaceState(
	rootUri: vscode.Uri,
	state: WorkspacePersistentState,
	fileSystem: WorkspacePersistenceFileSystem,
): Promise<void> {
	const crispyDirectoryUri = vscode.Uri.joinPath(
		rootUri,
		CRISPY_DIRECTORY_NAME,
	);

	await fileSystem.createDirectory(crispyDirectoryUri);
	await fileSystem.writeFile(
		vscode.Uri.joinPath(crispyDirectoryUri, WORKSPACE_STATE_FILE_NAME),
		textEncoder.encode(JSON.stringify(state)),
	);
}

/** 완료된 write가 아직 Root의 최신 chain일 때만 Map에서 제거한다. */
function removeCompletedWrite(rootKey: string, write: Promise<void>): void {
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
	const rootIndexes = new Map(rootStates.map(({ rootUri }, index) => [
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

/**
 * 물리 Root와 persisted owner가 일치하는 Task만 병합한다.
 * 같은 Task ID는 높은 revision을, 동률이면 canonical record가 앞선 값을 택한다.
 */
function mergeOwnedTasks(
	tasks: readonly WorkspaceTaskRecord[],
	target: Map<string, WorkspaceTaskRecord>,
	rootUri: vscode.Uri,
): void {
	const rootId = createWorkspaceRootId(rootUri);

	for (const candidate of tasks) {
		if (candidate.ownerRootId !== rootId) {
			continue;
		}
		mergePreferredTaskRecord(candidate, target);
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

/** Workspace Root URI의 Task ownership semantic ID를 만든다. */
function createWorkspaceRootId(rootUri: vscode.Uri): string {
	return `workspace-root:${rootUri.toString()}`;
}

/** Node ID가 나타내는 URI를 포함하는 가장 구체적인 Workspace Root index를 찾는다. */
function findOwningRootIndex(
	id: string,
	rootUris: readonly vscode.Uri[],
): number {
	if (id.endsWith(':files')) {
		const parentUri = parseNodeUri(id.slice(0, -':files'.length));

		if (parentUri) {
			return findMostSpecificRootIndex(parentUri, rootUris);
		}
	}

	const directUri = parseNodeUri(id);

	return directUri
		? findMostSpecificRootIndex(directUri, rootUris)
		: -1;
}

/** 알려진 Workspace/Graph Node ID prefix 뒤의 URI를 복원한다. */
function parseNodeUri(id: string): vscode.Uri | undefined {
	const prefixes = ['workspace-root:', 'folder:', 'file:'] as const;
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
