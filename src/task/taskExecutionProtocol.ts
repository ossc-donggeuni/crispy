import type { ProviderId } from '../agent/protocol';
import { ID_MAX_LENGTH, ID_PATTERN } from '../agent/protocol/limits';
import {
	validateWorkspaceRootId,
	type WorkspaceRootId,
} from '../workspace/workspaceRootId';
import {
	isWorkAgentProviderId,
	type WorkAgentProviderId,
} from './taskModel';
import type {
	TaskExecutionSnapshot,
	TaskExecutionState,
	TaskWorkExecutionSnapshot,
	TaskWorkExecutionState,
} from './taskExecution';
import { TASK_TRANSFER_LIMITS } from './taskTransfer';

export const TASK_EXECUTION_SUMMARY_MAX_BYTES = 64 * 1024;

/** Start 버튼이 현재 persisted revision의 Task 실행을 Host에 요청한다. */
export interface TaskExecutionStartMessage {
	readonly type: 'task.execution.start';
	readonly taskId: string;
	readonly storageRevision: number;
}

/** Host 요청에 따라 Webview가 기존 Agent 탭 ID를 할당해 돌려준다. */
export interface TaskSessionCreateMessage {
	readonly type: 'task.session.create';
	readonly executionId: string;
	readonly workNodeId: string;
	readonly tabId: string;
	readonly switchAttemptId: number;
}

export type TaskExecutionToHostMessage =
	| TaskExecutionStartMessage
	| TaskSessionCreateMessage;

/** Host가 ready Work를 기존 Agent 탭 UI에 materialize하도록 요청한다. */
export interface TaskSessionCreateRequestedMessage {
	readonly type: 'task.session.createRequested';
	readonly executionId: string;
	readonly taskId: string;
	readonly workNodeId: string;
	readonly providerId: WorkAgentProviderId;
	readonly workspaceRootId: WorkspaceRootId;
}

/** Blueprint와 분리된 Host 실행 상태 전체를 Webview가 교체 적용한다. */
export interface TaskExecutionUpdatedMessage {
	readonly type: 'task.execution.updated';
	readonly snapshot: TaskExecutionSnapshot;
}

export type TaskExecutionStartRejectionReason =
	| 'already-running'
	| 'not-found'
	| 'stale'
	| 'not-ready'
	| 'invalid-scope'
	| 'workspace-unavailable'
	| 'provider-unsupported'
	| 'internal-error';

/** 실행 ID 생성 전에 거절된 Start 요청의 credential-free 결과다. */
export interface TaskExecutionStartRejectedMessage {
	readonly type: 'task.execution.startRejected';
	readonly taskId: string;
	readonly storageRevision: number;
	readonly reason: TaskExecutionStartRejectionReason;
}

export type TaskExecutionToWebviewMessage =
	| TaskSessionCreateRequestedMessage
	| TaskExecutionUpdatedMessage
	| TaskExecutionStartRejectedMessage;

const EXECUTION_STATES: readonly TaskExecutionState[] = [
	'running',
	'completed',
	'rejected',
	'failed',
];
const WORK_STATES: readonly TaskWorkExecutionState[] = [
	'pending',
	'starting',
	'running',
	'waiting-approval',
	'completed',
	'rejected',
	'failed',
	'blocked',
];
const START_REJECTION_REASONS: readonly TaskExecutionStartRejectionReason[] = [
	'already-running',
	'not-found',
	'stale',
	'not-ready',
	'invalid-scope',
	'workspace-unavailable',
	'provider-unsupported',
	'internal-error',
];

/** unknown Webview payload에서 Task 실행 명령만 exact-key로 파싱한다. */
export function parseTaskExecutionToHostMessage(
	value: unknown,
): TaskExecutionToHostMessage | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.type === 'task.execution.start') {
		return hasExactOwnKeys(value, ['type', 'taskId', 'storageRevision'])
			&& isExecutionId(value.taskId)
			&& isNonnegativeRevision(value.storageRevision)
			? {
				type: value.type,
				taskId: value.taskId,
				storageRevision: value.storageRevision,
			}
			: undefined;
	}
	if (value.type === 'task.session.create') {
		return hasExactOwnKeys(value, [
			'type', 'executionId', 'workNodeId', 'tabId', 'switchAttemptId',
		])
			&& isExecutionId(value.executionId)
			&& isExecutionId(value.workNodeId)
			&& isExecutionId(value.tabId)
			&& isPositiveRevision(value.switchAttemptId)
			? {
				type: value.type,
				executionId: value.executionId,
				workNodeId: value.workNodeId,
				tabId: value.tabId,
				switchAttemptId: value.switchAttemptId,
			}
			: undefined;
	}
	return undefined;
}

/** unknown Host payload에서 Task 실행 표시/탭 요청만 exact-key로 파싱한다. */
export function parseTaskExecutionToWebviewMessage(
	value: unknown,
): TaskExecutionToWebviewMessage | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.type === 'task.session.createRequested') {
		if (!hasExactOwnKeys(value, [
			'type',
			'executionId',
			'taskId',
			'workNodeId',
			'providerId',
			'workspaceRootId',
		])) {
			return undefined;
		}
		const workspaceRoot = validateWorkspaceRootId(value.workspaceRootId);
		if (
			!isExecutionId(value.executionId)
			|| !isExecutionId(value.taskId)
			|| !isExecutionId(value.workNodeId)
			|| !isProviderId(value.providerId)
			|| !workspaceRoot.ok
		) {
			return undefined;
		}
		return {
			type: value.type,
			executionId: value.executionId,
			taskId: value.taskId,
			workNodeId: value.workNodeId,
			providerId: value.providerId,
			workspaceRootId: workspaceRoot.value,
		};
	}
	if (value.type === 'task.execution.updated') {
		if (!hasExactOwnKeys(value, ['type', 'snapshot'])) {
			return undefined;
		}
		const snapshot = parseTaskExecutionSnapshot(value.snapshot);
		return snapshot ? { type: value.type, snapshot } : undefined;
	}
	if (value.type === 'task.execution.startRejected') {
		return hasExactOwnKeys(value, [
			'type', 'taskId', 'storageRevision', 'reason',
		])
			&& isExecutionId(value.taskId)
			&& isNonnegativeRevision(value.storageRevision)
			&& isStartRejectionReason(value.reason)
			? {
				type: value.type,
				taskId: value.taskId,
				storageRevision: value.storageRevision,
				reason: value.reason,
			}
			: undefined;
	}
	return undefined;
}

function parseTaskExecutionSnapshot(
	value: unknown,
): TaskExecutionSnapshot | undefined {
	if (
		!isRecord(value)
		|| !hasExactOwnKeys(value, [
			'executionId',
			'taskId',
			'storageRevision',
			'state',
			'startNodeId',
			'endNodeId',
			'works',
		])
		|| !isExecutionId(value.executionId)
		|| !isExecutionId(value.taskId)
		|| !isNonnegativeRevision(value.storageRevision)
		|| !isExecutionState(value.state)
		|| !isExecutionId(value.startNodeId)
		|| !isExecutionId(value.endNodeId)
		|| !Array.isArray(value.works)
		|| value.works.length > TASK_TRANSFER_LIMITS.maxNodes
	) {
		return undefined;
	}
	const works: TaskWorkExecutionSnapshot[] = [];
	const seenWorkNodeIds = new Set<string>();
	for (const candidate of value.works) {
		const work = parseTaskWorkExecutionSnapshot(candidate);
		if (!work || seenWorkNodeIds.has(work.nodeId)) {
			return undefined;
		}
		seenWorkNodeIds.add(work.nodeId);
		works.push(work);
	}
	return Object.freeze({
		executionId: value.executionId,
		taskId: value.taskId,
		storageRevision: value.storageRevision,
		state: value.state,
		startNodeId: value.startNodeId,
		endNodeId: value.endNodeId,
		works: Object.freeze(works),
	});
}

function parseTaskWorkExecutionSnapshot(
	value: unknown,
): TaskWorkExecutionSnapshot | undefined {
	if (!isRecord(value) || !hasOnlyOwnKeys(value, ['nodeId', 'state', 'summary'])) {
		return undefined;
	}
	const expectedKeyCount = value.summary === undefined ? 2 : 3;
	if (
		Reflect.ownKeys(value).length !== expectedKeyCount
		|| !isExecutionId(value.nodeId)
		|| !isWorkExecutionState(value.state)
		|| (
			value.summary !== undefined
			&& !isLimitedUtf8String(value.summary, TASK_EXECUTION_SUMMARY_MAX_BYTES)
		)
	) {
		return undefined;
	}
	return Object.freeze({
		nodeId: value.nodeId,
		state: value.state,
		...(value.summary === undefined ? {} : { summary: value.summary }),
	});
}

function isExecutionId(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= ID_MAX_LENGTH
		&& ID_PATTERN.test(value);
}

function isProviderId(value: unknown): value is WorkAgentProviderId & ProviderId {
	return isWorkAgentProviderId(value);
}

function isNonnegativeRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0;
}

function isExecutionState(value: unknown): value is TaskExecutionState {
	return (EXECUTION_STATES as readonly unknown[]).includes(value);
}

function isWorkExecutionState(value: unknown): value is TaskWorkExecutionState {
	return (WORK_STATES as readonly unknown[]).includes(value);
}

function isStartRejectionReason(
	value: unknown,
): value is TaskExecutionStartRejectionReason {
	return (START_REJECTION_REASONS as readonly unknown[]).includes(value);
}

function isLimitedUtf8String(value: unknown, maxBytes: number): value is string {
	return typeof value === 'string'
		&& new TextEncoder().encode(value).byteLength <= maxBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactOwnKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	return Reflect.ownKeys(value).length === keys.length
		&& hasOnlyOwnKeys(value, keys);
}

function hasOnlyOwnKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	const allowed = new Set(keys);
	return Reflect.ownKeys(value).every((key) => (
		typeof key === 'string' && allowed.has(key)
	));
}
