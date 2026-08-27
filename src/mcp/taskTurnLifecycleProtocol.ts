import { randomUUID } from 'node:crypto';
import { MCP_LOOPBACK_HOST } from './httpPolicy';
import {
	isValidMcpOpaqueId,
	isValidMcpRouteId,
} from './sessionCredentials';

export const TASK_TURN_REMINDER_LIMIT = 2;
export const TASK_TURN_LIFECYCLE_PATH_PREFIX = '/task-turn-lifecycle/';
export const TASK_TURN_LIFECYCLE_TOOL_NAME_MAX_LENGTH = 64;
export const TASK_TURN_LIFECYCLE_MESSAGE_MAX_UTF8_BYTES = 8 * 1024;

export type TaskTurnLifecycleOutcome =
	| 'completion-observed'
	| 'scope-pending'
	| 'reminder-injected'
	| 'reminders-exhausted'
	| 'provider-failed';

/** Session child가 Host에 알리는 Task 전용 provider turn 결과다. */
export interface TaskTurnLifecycleObserved {
	readonly type: 'session.taskTurnLifecycleObserved';
	readonly sessionId: string;
	readonly generation: string;
	readonly executionId: string;
	readonly workNodeId: string;
	readonly providerId: 'claude';
	readonly turnId: string;
	readonly outcome: TaskTurnLifecycleOutcome;
}

export type ClaudeTaskTurnHookInput =
	| {
		readonly event: 'Stop';
		readonly providerSessionId: string;
		readonly stopHookActive: boolean;
	}
	| {
		readonly event: 'StopFailure';
		readonly providerSessionId: string;
	};

export interface ClaudeTaskTurnLifecycleRoute {
	readonly routeId: string;
	readonly completionToolName: string;
}

/** Claude HTTP Stop hook만 접근하는 bearer-authenticated sibling route를 만든다. */
export function createClaudeTaskTurnLifecycleUrl(
	mcpUrl: string,
	completionToolName: string,
): string {
	const parsed = parseMcpUrl(mcpUrl);
	if (!isValidTaskCompletionToolName(completionToolName)) {
		throw new Error('Task completion Tool name is invalid.');
	}
	parsed.url.pathname = `${TASK_TURN_LIFECYCLE_PATH_PREFIX}${parsed.routeId}/${
		encodeURIComponent(completionToolName)
	}`;
	return parsed.url.toString();
}

/** 등록된 route와 일치하는 Claude lifecycle path만 수락한다. */
export function parseClaudeTaskTurnLifecyclePath(
	requestUrl: string | undefined,
	expectedRouteId: string,
): ClaudeTaskTurnLifecycleRoute | undefined {
	if (requestUrl === undefined || !isValidMcpRouteId(expectedRouteId)) {
		return undefined;
	}
	const match = new RegExp(
		`^${TASK_TURN_LIFECYCLE_PATH_PREFIX.replaceAll('/', '\\/')}([^/]+)/([^/?#]+)$`,
		'u',
	).exec(requestUrl);
	if (match === null || match[1] !== expectedRouteId) {
		return undefined;
	}
	let completionToolName: string;
	try {
		completionToolName = decodeURIComponent(match[2]);
	} catch {
		return undefined;
	}
	return isValidTaskCompletionToolName(completionToolName)
		? Object.freeze({ routeId: match[1], completionToolName })
		: undefined;
}

/** Claude hook payload의 필요한 provider-owned 필드만 bounded clone으로 읽는다. */
export function parseClaudeTaskTurnHookInput(
	value: unknown,
): ClaudeTaskTurnHookInput | undefined {
	if (!isRecord(value) || !isLimitedString(value.session_id)) {
		return undefined;
	}
	if (value.hook_event_name === 'Stop') {
		return typeof value.stop_hook_active === 'boolean'
			? Object.freeze({
				event: value.hook_event_name,
				providerSessionId: value.session_id,
				stopHookActive: value.stop_hook_active,
			})
			: undefined;
	}
	if (value.hook_event_name === 'StopFailure') {
		return Object.freeze({
			event: value.hook_event_name,
			providerSessionId: value.session_id,
		});
	}
	return undefined;
}

export function createTaskTurnLifecycleObserved(options: {
	readonly sessionId: string;
	readonly generation: string;
	readonly executionId: string;
	readonly workNodeId: string;
	readonly outcome: TaskTurnLifecycleOutcome;
	readonly turnId?: string;
}): TaskTurnLifecycleObserved {
	const event = {
		type: 'session.taskTurnLifecycleObserved' as const,
		sessionId: options.sessionId,
		generation: options.generation,
		executionId: options.executionId,
		workNodeId: options.workNodeId,
		providerId: 'claude' as const,
		turnId: options.turnId ?? `task-turn-${randomUUID()}`,
		outcome: options.outcome,
	};
	const parsed = parseTaskTurnLifecycleObserved(event);
	if (parsed === undefined) {
		throw new Error('Task turn lifecycle event is invalid.');
	}
	return parsed;
}

/** Child→Host IPC에서 exact identity와 enum만 허용한다. */
export function parseTaskTurnLifecycleObserved(
	value: unknown,
): TaskTurnLifecycleObserved | undefined {
	if (
		!isRecord(value)
		|| !hasExactOwnKeys(value, [
			'type',
			'sessionId',
			'generation',
			'executionId',
			'workNodeId',
			'providerId',
			'turnId',
			'outcome',
		])
		|| value.type !== 'session.taskTurnLifecycleObserved'
		|| value.providerId !== 'claude'
		|| !isValidMcpOpaqueId(value.sessionId)
		|| !isValidMcpOpaqueId(value.generation)
		|| !isValidMcpOpaqueId(value.executionId)
		|| !isValidMcpOpaqueId(value.workNodeId)
		|| !isValidMcpOpaqueId(value.turnId)
		|| !isTaskTurnLifecycleOutcome(value.outcome)
	) {
		return undefined;
	}
	return Object.freeze({
		type: value.type,
		sessionId: value.sessionId,
		generation: value.generation,
		executionId: value.executionId,
		workNodeId: value.workNodeId,
		providerId: value.providerId,
		turnId: value.turnId,
		outcome: value.outcome,
	});
}

/** Stop hook feedback는 실제 qualified Tool 이름을 포함해 prose-only 반복을 막는다. */
export function createTaskCompletionFollowup(
	completionToolName: string,
): string {
	if (!isValidTaskCompletionToolName(completionToolName)) {
		throw new Error('Task completion Tool name is invalid.');
	}
	return [
		'This response ended without reporting a terminal state to the Crispy Task Host.',
		`If the assigned work and verification are complete, call ${completionToolName} now with status completed and a concise summary.`,
		`If the Work intentionally stopped because required scope or user approval was denied, call ${completionToolName} with status rejected.`,
		'Do not return another prose-only completion message.',
	].join(' ');
}

/** Task Codex config가 요청한 OSC 9 알림을 PTY chunk 경계와 무관하게 검출한다. */
export class CodexTaskTurnNotificationParser {
	private pending = '';

	push(data: string): number {
		let buffer = `${this.pending}${data}`;
		this.pending = '';
		let observed = 0;
		let cursor = 0;
		for (;;) {
			const start = buffer.indexOf('\u001b]9;', cursor);
			if (start < 0) {
				this.pending = suffixThatCanStartOsc9(buffer.slice(cursor));
				break;
			}
			const bel = buffer.indexOf('\u0007', start + 4);
			const stringTerminator = buffer.indexOf('\u001b\\', start + 4);
			const end = bel < 0
				? stringTerminator
				: stringTerminator < 0
					? bel
					: Math.min(bel, stringTerminator);
			if (end < 0) {
				this.pending = buffer.slice(start, start + 8 * 1024);
				break;
			}
			observed += 1;
			cursor = end + (end === stringTerminator ? 2 : 1);
			if (cursor >= buffer.length) {
				break;
			}
		}
		return observed;
	}

	reset(): void {
		this.pending = '';
	}
}

function parseMcpUrl(value: string): { url: URL; routeId: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Task lifecycle MCP URL is invalid.');
	}
	const route = /^\/mcp\/([^/]+)$/u.exec(url.pathname);
	if (
		url.protocol !== 'http:'
		|| url.hostname !== MCP_LOOPBACK_HOST
		|| url.port === ''
		|| url.username !== ''
		|| url.password !== ''
		|| url.search !== ''
		|| url.hash !== ''
		|| route === null
		|| !isValidMcpRouteId(route[1])
	) {
		throw new Error('Task lifecycle MCP URL is invalid.');
	}
	return { url, routeId: route[1] };
}

function suffixThatCanStartOsc9(value: string): string {
	const prefix = '\u001b]9;';
	for (let length = Math.min(prefix.length - 1, value.length); length > 0; length -= 1) {
		if (value.endsWith(prefix.slice(0, length))) {
			return value.slice(-length);
		}
	}
	return '';
}

function isValidTaskCompletionToolName(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= TASK_TURN_LIFECYCLE_TOOL_NAME_MAX_LENGTH
		&& /^[A-Za-z0-9_-]+$/u.test(value);
}

function isLimitedString(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& Buffer.byteLength(value, 'utf8') <= TASK_TURN_LIFECYCLE_MESSAGE_MAX_UTF8_BYTES;
}

function isTaskTurnLifecycleOutcome(
	value: unknown,
): value is TaskTurnLifecycleOutcome {
	return value === 'completion-observed'
		|| value === 'scope-pending'
		|| value === 'reminder-injected'
		|| value === 'reminders-exhausted'
		|| value === 'provider-failed';
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
