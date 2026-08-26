import { randomUUID } from 'node:crypto';
import { isValidMcpOpaqueId } from './sessionCredentials';

export const TASK_TOOL_SUMMARY_MAX_UTF8_BYTES = 64 * 1024;
export const TASK_TOOL_REASON_MAX_UTF8_BYTES = 8 * 1024;
export const TASK_TOOL_PATH_MAX_UTF8_BYTES = 4 * 1024;
export const TASK_TOOL_PATH_MAX_COUNT = 16;
export const TASK_TOOL_IPC_MAX_UTF8_BYTES = 128 * 1024;

/** Host가 특정 authenticated MCP session에만 부여하는 Task 실행 lease다. */
export interface TaskToolLease {
	readonly executionId: string;
	readonly workNodeId: string;
}

export type TaskToolRequested =
	| {
		readonly type: 'session.taskToolRequested';
		readonly sessionId: string;
		readonly generation: string;
		readonly executionId: string;
		readonly workNodeId: string;
		readonly operation: 'complete';
		readonly status: 'completed' | 'rejected';
		readonly summary: string;
	}
	| {
		readonly type: 'session.taskToolRequested';
		readonly sessionId: string;
		readonly generation: string;
		readonly executionId: string;
		readonly workNodeId: string;
		readonly operation: 'scope-request';
		readonly requestId: string;
		readonly access: 'read' | 'write';
		readonly paths: readonly string[];
		readonly reason: string;
	}
	| {
		readonly type: 'session.taskToolRequested';
		readonly sessionId: string;
		readonly generation: string;
		readonly executionId: string;
		readonly workNodeId: string;
		readonly operation: 'scope-result';
		readonly requestId: string;
		readonly result: 'approved' | 'rejected';
	};

/** Child가 반환할 scope correlation ID를 process-local 난수로 만든다. */
export function createTaskScopeRequestId(): string {
	return `scope-${randomUUID()}`;
}

export function isValidTaskToolLease(value: unknown): value is TaskToolLease {
	return isRecord(value)
		&& hasExactOwnKeys(value, ['executionId', 'workNodeId'])
		&& isValidMcpOpaqueId(value.executionId)
		&& isValidMcpOpaqueId(value.workNodeId);
}

/** Child→Host IPC에서 Task tool event를 exact-key와 UTF-8 cap으로 검증한다. */
export function parseTaskToolRequested(
	value: unknown,
): TaskToolRequested | undefined {
	if (
		!isRecord(value)
		|| value.type !== 'session.taskToolRequested'
		|| !isBaseTaskToolRequest(value)
	) {
		return undefined;
	}
	let event: TaskToolRequested | undefined;
	if (value.operation === 'complete') {
		if (
			hasExactOwnKeys(value, [
				'type',
				'sessionId',
				'generation',
				'executionId',
				'workNodeId',
				'operation',
				'status',
				'summary',
			])
			&& (value.status === 'completed' || value.status === 'rejected')
			&& isLimitedString(value.summary, TASK_TOOL_SUMMARY_MAX_UTF8_BYTES)
		) {
			event = Object.freeze({
				type: value.type,
				sessionId: value.sessionId as string,
				generation: value.generation as string,
				executionId: value.executionId as string,
				workNodeId: value.workNodeId as string,
				operation: value.operation,
				status: value.status,
				summary: value.summary,
			});
		}
	} else if (value.operation === 'scope-request') {
		if (
			hasExactOwnKeys(value, [
				'type',
				'sessionId',
				'generation',
				'executionId',
				'workNodeId',
				'operation',
				'requestId',
				'access',
				'paths',
				'reason',
			])
			&& isValidMcpOpaqueId(value.requestId)
			&& (value.access === 'read' || value.access === 'write')
			&& isTaskScopePaths(value.paths)
			&& isLimitedString(value.reason, TASK_TOOL_REASON_MAX_UTF8_BYTES)
		) {
			event = Object.freeze({
				type: value.type,
				sessionId: value.sessionId as string,
				generation: value.generation as string,
				executionId: value.executionId as string,
				workNodeId: value.workNodeId as string,
				operation: value.operation,
				requestId: value.requestId,
				access: value.access,
				paths: Object.freeze([...value.paths]),
				reason: value.reason,
			});
		}
	} else if (value.operation === 'scope-result') {
		if (
			hasExactOwnKeys(value, [
				'type',
				'sessionId',
				'generation',
				'executionId',
				'workNodeId',
				'operation',
				'requestId',
				'result',
			])
			&& isValidMcpOpaqueId(value.requestId)
			&& (value.result === 'approved' || value.result === 'rejected')
		) {
			event = Object.freeze({
				type: value.type,
				sessionId: value.sessionId as string,
				generation: value.generation as string,
				executionId: value.executionId as string,
				workNodeId: value.workNodeId as string,
				operation: value.operation,
				requestId: value.requestId,
				result: value.result,
			});
		}
	}

	return event && Buffer.byteLength(JSON.stringify(event), 'utf8')
		<= TASK_TOOL_IPC_MAX_UTF8_BYTES
		? event
		: undefined;
}

function isBaseTaskToolRequest(value: Record<string, unknown>): boolean {
	return isValidMcpOpaqueId(value.sessionId)
		&& isValidMcpOpaqueId(value.generation)
		&& isValidMcpOpaqueId(value.executionId)
		&& isValidMcpOpaqueId(value.workNodeId);
}

function isTaskScopePaths(value: unknown): value is string[] {
	return Array.isArray(value)
		&& value.length > 0
		&& value.length <= TASK_TOOL_PATH_MAX_COUNT
		&& new Set(value).size === value.length
		&& value.every((entry) => (
			isLimitedString(entry, TASK_TOOL_PATH_MAX_UTF8_BYTES)
			&& entry.length > 0
			&& !entry.includes('\0')
		));
}

function isLimitedString(value: unknown, maxBytes: number): value is string {
	return typeof value === 'string'
		&& Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactOwnKeys(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	const allowed = new Set(keys);
	const ownKeys = Reflect.ownKeys(value);
	return ownKeys.length === keys.length
		&& ownKeys.every((key) => typeof key === 'string' && allowed.has(key));
}
