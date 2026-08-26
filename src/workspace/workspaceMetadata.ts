import {
	isWorkAgentProviderId,
	TASK_BLUEPRINT_VERSION,
	type TaskBlueprint,
	type TaskEdge,
	type TaskGraphTargets,
	type TaskNode,
	type TaskNodePosition,
} from '../task/taskModel';
import {
	createWorkspaceTaskRecordSnapshot,
	type WorkspaceTaskRecord,
} from '../task/workspaceTaskState';
import { validateTaskBlueprint } from '../task/taskValidation';
import {
	parseDetachedRootNodeIds,
	parseFileGroupPages,
	parseHiddenNodeIds,
	parseNodePositions,
	parseOpenedFolders,
	type GraphNodePosition,
} from '../webview/graph/graphState';

/** 현재 해석할 수 있는 Workspace Persistent State 형식 버전이다. */
export const WORKSPACE_PERSISTENT_STATE_VERSION = 2;

/** Workspace Root의 `.crispy/state.json`에 저장할 Graph와 Task 상태다. */
export interface WorkspacePersistentState {
	version: typeof WORKSPACE_PERSISTENT_STATE_VERSION;
	nodePositions: Record<string, GraphNodePosition>;
	fileGroupPages: Record<string, number>;
	openedFolders: Record<string, true>;
	detachedRootNodeIds: Record<string, true>;
	hiddenNodeIds: Record<string, true>;
	tasks: readonly WorkspaceTaskRecord[];
	/** owner 이동을 여러 Root 파일에 crash-safe하게 반영하기 위한 source journal이다. */
	taskRelocations: readonly WorkspaceTaskRelocation[];
	/** owner Root가 해당 Task revision을 한 번 이상 저장했다는 영속 receipt다. */
	taskStorageReceipts: readonly WorkspaceTaskStorageReceipt[];
}

/** source Root가 destination 저장을 완료할 때까지 보존하는 완전한 Task 이동 record다. */
export interface WorkspaceTaskRelocation {
	readonly sourceRootId: string;
	readonly record: WorkspaceTaskRecord;
}

/** Task 삭제 뒤에도 남아 오래된 이동 journal의 부활을 막는 owner별 revision이다. */
export interface WorkspaceTaskStorageReceipt {
	readonly ownerRootId: string;
	readonly taskId: string;
	readonly storageRevision: number;
}

/** 외부 객체와 참조를 공유하지 않는 기본 Workspace Persistent State를 생성한다. */
export function createDefaultWorkspacePersistentState(): WorkspacePersistentState {
	return {
		version: WORKSPACE_PERSISTENT_STATE_VERSION,
		nodePositions: {},
		fileGroupPages: {},
		openedFolders: {},
		detachedRootNodeIds: {},
		hiddenNodeIds: {},
		tasks: [],
		taskRelocations: [],
		taskStorageReceipts: [],
	};
}

/**
 * 현재 version을 검증하고 독립적인 객체로 복사한다.
 * version 1 Graph 상태는 빈 Task 목록을 가진 version 2로 승격한다.
 */
export function parseWorkspacePersistentState(
	value: unknown,
): WorkspacePersistentState | undefined {
	if (!isObject(value)) {
		return undefined;
	}

	const candidate = value;

	if (candidate.version !== 1
		&& candidate.version !== WORKSPACE_PERSISTENT_STATE_VERSION) {
		return undefined;
	}

	const nodePositions = parseNodePositions(candidate.nodePositions);
	const fileGroupPages = parseFileGroupPages(candidate.fileGroupPages);
	const openedFolders = parseOpenedFolders(candidate.openedFolders);
	const detachedRootNodeIds = parseDetachedRootNodeIds(
		candidate.detachedRootNodeIds,
	);
	const hiddenNodeIds = parseHiddenNodeIds(candidate.hiddenNodeIds);
	const tasks = candidate.version === 1
		? []
		: parseWorkspaceTaskRecords(candidate.tasks);
	const taskRelocations = candidate.version === 1
		? []
		: parseWorkspaceTaskRelocations(candidate.taskRelocations);
	const parsedTaskStorageReceipts = candidate.version === 1
		? []
		: parseWorkspaceTaskStorageReceipts(candidate.taskStorageReceipts);

	if (
		!nodePositions
		|| !fileGroupPages
		|| !openedFolders
		|| !detachedRootNodeIds
		|| !hiddenNodeIds
		|| !tasks
		|| !taskRelocations
		|| !parsedTaskStorageReceipts
	) {
		return undefined;
	}
	const explicitReceiptByKey = new Map(parsedTaskStorageReceipts.map((receipt) => [
		createTaskStorageReceiptKey(receipt),
		receipt,
	]));
	const currentTasks = tasks.filter((record) => {
		const receipt = explicitReceiptByKey.get(createTaskStorageReceiptKey({
			ownerRootId: record.ownerRootId,
			taskId: record.task.id,
		}));

		return !receipt || receipt.storageRevision <= record.storageRevision;
	});
	const taskStorageReceipts = normalizeTaskStorageReceipts(
		parsedTaskStorageReceipts,
		currentTasks,
	);

	return {
		version: WORKSPACE_PERSISTENT_STATE_VERSION,
		nodePositions,
		fileGroupPages,
		openedFolders,
		detachedRootNodeIds,
		hiddenNodeIds,
		tasks: currentTasks,
		taskRelocations,
		taskStorageReceipts,
	};
}

/** Task storage receipt를 검증하고 owner/Task별 가장 높은 revision으로 정규화한다. */
function parseWorkspaceTaskStorageReceipts(
	value: unknown,
): readonly WorkspaceTaskStorageReceipt[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	const receipts = new Map<string, WorkspaceTaskStorageReceipt>();

	for (const entry of value) {
		if (
			!isObjectWithExactKeys(entry, [
				'ownerRootId',
				'taskId',
				'storageRevision',
			])
			|| !isWorkspaceRootId(entry.ownerRootId)
			|| !isNonEmptyString(entry.taskId)
			|| !isStorageRevision(entry.storageRevision)
		) {
			continue;
		}
		mergeTaskStorageReceipt({
			ownerRootId: entry.ownerRootId,
			taskId: entry.taskId,
			storageRevision: entry.storageRevision,
		}, receipts);
	}
	return [...receipts.values()];
}

/** 명시된 receipt와 live Task의 revision을 owner/Task별 단조 증가시킨다. */
function normalizeTaskStorageReceipts(
	receipts: readonly WorkspaceTaskStorageReceipt[],
	tasks: readonly WorkspaceTaskRecord[],
): readonly WorkspaceTaskStorageReceipt[] {
	const byKey = new Map<string, WorkspaceTaskStorageReceipt>();

	for (const receipt of receipts) {
		mergeTaskStorageReceipt(receipt, byKey);
	}
	for (const record of tasks) {
		mergeTaskStorageReceipt({
			ownerRootId: record.ownerRootId,
			taskId: record.task.id,
			storageRevision: record.storageRevision,
		}, byKey);
	}
	return [...byKey.values()];
}

function mergeTaskStorageReceipt(
	receipt: WorkspaceTaskStorageReceipt,
	target: Map<string, WorkspaceTaskStorageReceipt>,
): void {
	const key = createTaskStorageReceiptKey(receipt);
	const current = target.get(key);

	if (!current || receipt.storageRevision > current.storageRevision) {
		target.set(key, receipt);
	}
}

function createTaskStorageReceiptKey(receipt: {
	readonly ownerRootId: string;
	readonly taskId: string;
}): string {
	return JSON.stringify([receipt.ownerRootId, receipt.taskId]);
}

/** 이동 journal 배열 자체를 검증하고 잘못된 개별 entry만 격리한다. */
function parseWorkspaceTaskRelocations(
	value: unknown,
): readonly WorkspaceTaskRelocation[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		return undefined;
	}

	return value.flatMap((entry) => {
		if (!isObjectWithExactKeys(entry, ['sourceRootId', 'record'])) {
			return [];
		}
		const record = parseWorkspaceTaskRecord(entry.record);

		return isWorkspaceRootId(entry.sourceRootId)
			&& record
			&& entry.sourceRootId !== record.ownerRootId
			? [{ sourceRootId: entry.sourceRootId, record }]
			: [];
	});
}

/** Task 목록 자체가 유효하면 잘못된 개별 record만 격리해 건너뛴다. */
function parseWorkspaceTaskRecords(
	value: unknown,
): readonly WorkspaceTaskRecord[] | undefined {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		return undefined;
	}

	return value.flatMap((record) => {
		const parsed = parseWorkspaceTaskRecord(record);

		return parsed ? [parsed] : [];
	});
}

/** Workspace Task record와 Task DAG 전체를 검증하고 깊은 snapshot으로 복사한다. */
function parseWorkspaceTaskRecord(
	value: unknown,
): WorkspaceTaskRecord | undefined {
	if (!isObjectWithExactKeys(value, [
		'ownerRootId',
		'storageRevision',
		'task',
		'targetOrigins',
	])) {
		return undefined;
	}
	if (
		!isWorkspaceRootId(value.ownerRootId)
		|| !isStorageRevision(value.storageRevision)
	) {
		return undefined;
	}

	const task = parseTaskBlueprint(value.task);
	const targetOrigins = parseTaskTargetOrigins(value.targetOrigins);
	if (!task || !targetOrigins) {
		return undefined;
	}

	try {
		return createWorkspaceTaskRecordSnapshot({
			ownerRootId: value.ownerRootId,
			storageRevision: value.storageRevision,
			task,
			targetOrigins,
		});
	} catch {
		return undefined;
	}
}

/** Task Blueprint의 현재 형식을 구조적으로 파싱한 뒤 DAG 불변 조건을 확인한다. */
function parseTaskBlueprint(value: unknown): TaskBlueprint | undefined {
	if (!isObjectWithExactKeys(value, [
		'version',
		'id',
		'title',
		'description',
		'defaultGraphTargets',
		'origin',
		'nodePositions',
		'nodes',
		'edges',
	])) {
		return undefined;
	}
	if (
		value.version !== TASK_BLUEPRINT_VERSION
		|| !isNonEmptyString(value.id)
		|| typeof value.title !== 'string'
		|| typeof value.description !== 'string'
	) {
		return undefined;
	}

	const defaultGraphTargets = parseTaskGraphTargets(value.defaultGraphTargets);
	const origin = parsePosition(value.origin);
	const nodePositions = parseTaskNodePositions(value.nodePositions);
	const nodes = parseTaskNodes(value.nodes);
	const edges = parseTaskEdges(value.edges);
	if (!defaultGraphTargets || !origin || !nodePositions || !nodes || !edges) {
		return undefined;
	}

	const task: TaskBlueprint = {
		version: TASK_BLUEPRINT_VERSION,
		id: value.id,
		title: value.title,
		description: value.description,
		defaultGraphTargets,
		origin,
		nodePositions,
		nodes,
		edges,
	};

	try {
		return validateTaskBlueprint(task).length === 0 ? task : undefined;
	} catch {
		return undefined;
	}
}

/** reference/work Source ID 배열을 현재 Task Graph Target으로 복사한다. */
function parseTaskGraphTargets(value: unknown): TaskGraphTargets | undefined {
	if (!isObjectWithExactKeys(value, ['reference', 'work'])) {
		return undefined;
	}

	const reference = parseNonEmptyStringArray(value.reference);
	const work = parseNonEmptyStringArray(value.work);

	return reference && work ? { reference, work } : undefined;
}

/** Task origin과 local position의 유한 좌표를 복사한다. */
function parsePosition(value: unknown): TaskNodePosition | undefined {
	if (
		!isObjectWithExactKeys(value, ['x', 'y'])
		|| !isFiniteNumber(value.x)
		|| !isFiniteNumber(value.y)
	) {
		return undefined;
	}

	return { x: value.x, y: value.y };
}

/** Node ID별 task-local position record를 검증하고 복사한다. */
function parseTaskNodePositions(
	value: unknown,
): Readonly<Record<string, TaskNodePosition>> | undefined {
	if (!isObject(value)) {
		return undefined;
	}

	const positions: Array<[string, TaskNodePosition]> = [];
	for (const [nodeId, position] of Object.entries(value)) {
		const parsed = parsePosition(position);
		if (!nodeId || !parsed) {
			return undefined;
		}
		positions.push([nodeId, parsed]);
	}

	return Object.fromEntries(positions);
}

/** kind별 허용 필드를 확인하며 Task Node 배열을 복사한다. */
function parseTaskNodes(value: unknown): readonly TaskNode[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const nodes: TaskNode[] = [];
	for (const entry of value) {
		const node = parseTaskNode(entry);
		if (!node) {
			return undefined;
		}
		nodes.push(node);
	}

	return nodes;
}

/** 단일 Task Node를 kind별 현재 형식으로 파싱한다. */
function parseTaskNode(value: unknown): TaskNode | undefined {
	if (!isObject(value) || !isNonEmptyString(value.id)) {
		return undefined;
	}
	if (value.kind === 'start' || value.kind === 'end') {
		return hasExactKeys(value, ['id', 'kind'])
			? { id: value.id, kind: value.kind }
			: undefined;
	}
	if (
		value.kind !== 'work'
		|| !hasExactKeys(value, [
			'id',
			'kind',
			'title',
			'description',
			'prompt',
			'agentProviderId',
			'graphTargets',
		])
		|| typeof value.title !== 'string'
		|| typeof value.description !== 'string'
		|| typeof value.prompt !== 'string'
		|| !isWorkAgentProviderId(value.agentProviderId)
	) {
		return undefined;
	}

	const graphTargets = parseTaskGraphTargets(value.graphTargets);

	return graphTargets
		? {
			id: value.id,
			kind: 'work',
			title: value.title,
			description: value.description,
			prompt: value.prompt,
			agentProviderId: value.agentProviderId,
			graphTargets,
		}
		: undefined;
}

/** Task Edge 배열을 구조 검증하며 복사한다. */
function parseTaskEdges(value: unknown): readonly TaskEdge[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const edges: TaskEdge[] = [];
	for (const entry of value) {
		if (
			!isObjectWithExactKeys(entry, ['id', 'source', 'target'])
			|| !isNonEmptyString(entry.id)
			|| !isNonEmptyString(entry.source)
			|| !isNonEmptyString(entry.target)
		) {
			return undefined;
		}
		edges.push({
			id: entry.id,
			source: entry.source,
			target: entry.target,
		});
	}

	return edges;
}

/** persisted Target origin 목록을 검증하고 복사한다. */
function parseTaskTargetOrigins(
	value: unknown,
): WorkspaceTaskRecord['targetOrigins'] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const origins: Array<WorkspaceTaskRecord['targetOrigins'][number]> = [];
	for (const entry of value) {
		if (
			!isObjectWithExactKeys(entry, [
				'nodeId',
				'area',
				'sourceId',
				'sourceRootId',
			])
			|| !isNonEmptyString(entry.nodeId)
			|| (entry.area !== 'reference' && entry.area !== 'work')
			|| !isNonEmptyString(entry.sourceId)
			|| !isWorkspaceRootId(entry.sourceRootId)
		) {
			return undefined;
		}
		origins.push({
			nodeId: entry.nodeId,
			area: entry.area,
			sourceId: entry.sourceId,
			sourceRootId: entry.sourceRootId,
		});
	}

	return origins;
}

/** JSON object 여부를 판별한다. */
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 허용한 자체 key만 모두 포함하는 JSON object인지 판별한다. */
function isObjectWithExactKeys(
	value: unknown,
	keys: readonly string[],
): value is Record<string, unknown> {
	return isObject(value) && hasExactKeys(value, keys);
}

/** object 자체 key 집합이 지정된 key 집합과 일치하는지 판별한다. */
function hasExactKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	const actualKeys = Object.keys(value);

	return actualKeys.length === keys.length
		&& keys.every((key) => Object.hasOwn(value, key));
}

/** 비어 있지 않은 문자열인지 판별한다. */
function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

/** Workspace Root semantic ID인지 판별한다. */
function isWorkspaceRootId(value: unknown): value is string {
	return isNonEmptyString(value) && value.startsWith('workspace-root:');
}

/** 증가 가능한 persisted storage revision인지 판별한다. */
function isStorageRevision(value: unknown): value is number {
	return typeof value === 'number'
		&& Number.isSafeInteger(value)
		&& value >= 0;
}

/** JSON으로 왕복 가능한 유한 좌표인지 판별한다. */
function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

/** 모든 원소가 비어 있지 않은 문자열인 배열을 복사한다. */
function parseNonEmptyStringArray(value: unknown): readonly string[] | undefined {
	return Array.isArray(value) && value.every(isNonEmptyString)
		? [...value]
		: undefined;
}
