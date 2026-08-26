import { randomUUID } from 'node:crypto';
import type { ProviderId } from '../agent/protocol/providers';
import type { SwitchAttemptId, TabId } from '../agent/protocol/messages';
import type { TaskToolRequested } from '../mcp/taskToolProtocol';
import type { WorkspacePersistentState } from '../workspace/workspaceMetadata';
import type { WorkspaceRootId } from '../workspace/workspaceRootId';
import {
	createTaskExecutionScheduler,
	createTaskWorkExecutionPlan,
	isTaskExecutionActive,
	type TaskExecutionScheduler,
	type TaskExecutionScopeTarget,
	type TaskWorkExecutionPlan,
} from './taskExecution';
import type {
	TaskExecutionStartMessage,
	TaskExecutionStartRejectionReason,
	TaskExecutionToWebviewMessage,
	TaskSessionCreateMessage,
} from './taskExecutionProtocol';

export const TASK_SESSION_CREATE_TIMEOUT_MS = 15_000;

export interface TaskExecutionTerminalDescriptor {
	readonly executionId: string;
	readonly workNodeId: string;
	readonly prompt: string;
	readonly scope: readonly TaskExecutionTerminalScope[];
}

export interface TaskExecutionTerminalScope {
	readonly path: string;
	readonly kind: 'file' | 'folder';
	readonly access: 'read' | 'read-write';
}

export interface TaskExecutionTerminalHost {
	createTaskSession(
		tabId: TabId,
		providerId: ProviderId,
		workspaceRootId: WorkspaceRootId,
		switchAttemptId: SwitchAttemptId,
		descriptor: TaskExecutionTerminalDescriptor,
	): Promise<void>;
	stopTaskSession(executionId: string, workNodeId: string): Promise<boolean>;
}

export type TaskExecutionTerminalEvent =
	| {
		readonly type: 'started' | 'failed';
		readonly tabId: string;
		readonly sessionId?: string;
		readonly descriptor: TaskExecutionTerminalDescriptor;
	}
	| {
		readonly type: 'exited';
		readonly tabId: string;
		readonly sessionId: string;
		readonly descriptor: TaskExecutionTerminalDescriptor;
		readonly exitCode: number;
		readonly signal: number | null;
		readonly expected: boolean;
	}
	| {
		readonly type: 'tool';
		readonly tabId: string;
		readonly sessionId: string;
		readonly descriptor: TaskExecutionTerminalDescriptor;
		readonly event: TaskToolRequested;
	};

export interface TaskExecutionControllerOptions {
	readonly getWorkspaceState: () => WorkspacePersistentState;
	readonly terminalHost: TaskExecutionTerminalHost;
	readonly postMessage: (message: TaskExecutionToWebviewMessage) => unknown;
	/** Canonical Graph source를 현재 local absolute path로 fresh하게 해석한다. */
	readonly resolveScopePath: (
		target: TaskExecutionScopeTarget,
	) => string | undefined;
	readonly createExecutionId?: () => string;
	/** Webview tab allocation 응답 유실을 fail-closed하는 Host timer 주입점이다. */
	readonly scheduleSessionCreateTimeout?: (
		callback: () => void,
	) => () => void;
}

export interface TaskExecutionController {
	start(message: TaskExecutionStartMessage): void;
	createSession(message: TaskSessionCreateMessage): void;
	handleTerminalEvent(event: TaskExecutionTerminalEvent): void;
	dispose(): void;
}

interface ActiveExecution {
	readonly scheduler: TaskExecutionScheduler;
	readonly plans: ReadonlyMap<string, TaskWorkExecutionPlan>;
	readonly descriptors: ReadonlyMap<string, TaskExecutionTerminalDescriptor>;
	readonly tabByWorkNodeId: Map<string, string>;
	readonly pendingScopeRequestByWorkNodeId: Map<string, string>;
	readonly sessionCreateTimeoutByWorkNodeId: Map<string, SessionCreateTimeout>;
	disposed: boolean;
}

interface SessionCreateTimeout {
	readonly token: symbol;
	readonly cancel: () => void;
}

/**
 * Persisted Task revision을 한 번 고정한 뒤 DAG admission, tab 생성, MCP 완료를
 * Host에서만 조정한다. Webview는 표시와 ordinary tab ID 할당만 담당한다.
 */
export function createTaskExecutionController(
	options: TaskExecutionControllerOptions,
): TaskExecutionController {
	const executions = new Map<string, ActiveExecution>();
	const executionIdByTaskId = new Map<string, string>();
	let disposed = false;
	const scheduleSessionCreateTimeout = options.scheduleSessionCreateTimeout
		?? ((callback: () => void): (() => void) => {
			const timer = setTimeout(callback, TASK_SESSION_CREATE_TIMEOUT_MS);
			timer.unref();
			return () => clearTimeout(timer);
		});

	const clearSessionCreateTimeout = (
		active: ActiveExecution,
		workNodeId: string,
	): void => {
		const timeout = active.sessionCreateTimeoutByWorkNodeId.get(workNodeId);
		if (!timeout) {
			return;
		}
		active.sessionCreateTimeoutByWorkNodeId.delete(workNodeId);
		timeout.cancel();
	};

	const post = (message: TaskExecutionToWebviewMessage): void => {
		if (disposed) {
			return;
		}
		try {
			void options.postMessage(message);
		} catch {
			/** Webview delivery failure never widens or advances execution. */
		}
	};

	const rejectStart = (
		message: TaskExecutionStartMessage,
		reason: TaskExecutionStartRejectionReason,
	): void => post({
		type: 'task.execution.startRejected',
		taskId: message.taskId,
		storageRevision: message.storageRevision,
		reason,
	});

	const scheduleReady = (executionId: string): void => {
		const active = executions.get(executionId);
		if (!active || active.disposed) {
			return;
		}
		for (const workNodeId of active.scheduler.getReadyWorkNodeIds()) {
			const plan = active.plans.get(workNodeId);
			if (!plan || !active.scheduler.markWorkStarting(workNodeId)) {
				continue;
			}
			const token = Symbol(workNodeId);
			const cancel = scheduleSessionCreateTimeout(() => {
				const current = active.sessionCreateTimeoutByWorkNodeId.get(workNodeId);
				if (current?.token !== token) {
					return;
				}
				active.sessionCreateTimeoutByWorkNodeId.delete(workNodeId);
				void finishWork(
					executionId,
					workNodeId,
					'failed',
					'Agent tab creation timed out.',
				);
			});
			active.sessionCreateTimeoutByWorkNodeId.set(workNodeId, { token, cancel });
			post({
				type: 'task.session.createRequested',
				executionId,
				taskId: plan.taskId,
				workNodeId,
				providerId: plan.providerId,
				workspaceRootId: plan.workspaceRootId as WorkspaceRootId,
			});
		}
	};

	const settleTerminalExecution = (executionId: string): void => {
		const active = executions.get(executionId);
		if (!active || isTaskExecutionActive(active.scheduler.getSnapshot())) {
			return;
		}
		const taskId = active.scheduler.getSnapshot().taskId;
		if (executionIdByTaskId.get(taskId) === executionId) {
			executionIdByTaskId.delete(taskId);
		}
		active.disposed = true;
		executions.delete(executionId);
	};

	const finishWork = async (
		executionId: string,
		workNodeId: string,
		status: 'completed' | 'rejected' | 'failed',
		summary?: string,
	): Promise<void> => {
		const active = executions.get(executionId);
		if (!active || active.disposed) {
			return;
		}
		clearSessionCreateTimeout(active, workNodeId);
		active.pendingScopeRequestByWorkNodeId.delete(workNodeId);
		const changed = status === 'completed'
			? active.scheduler.completeWork(workNodeId, summary)
			: status === 'rejected'
				? active.scheduler.rejectWork(workNodeId, summary)
				: active.scheduler.failWork(workNodeId, summary);
		if (!changed) {
			return;
		}
		const stopWorkNodeIds = [workNodeId];
		if (status !== 'completed') {
			for (const work of active.scheduler.getSnapshot().works) {
				if (work.state === 'blocked') {
					clearSessionCreateTimeout(active, work.nodeId);
				}
				if (
					work.state === 'blocked'
					&& active.tabByWorkNodeId.has(work.nodeId)
				) {
					stopWorkNodeIds.push(work.nodeId);
				}
			}
		}
		scheduleReady(executionId);
		settleTerminalExecution(executionId);
		await Promise.allSettled(stopWorkNodeIds.map((nodeId) => (
			options.terminalHost.stopTaskSession(executionId, nodeId)
		)));
	};

	return {
		start(message): void {
			if (disposed) {
				return;
			}
			const existingId = executionIdByTaskId.get(message.taskId);
			const existing = existingId === undefined
				? undefined
				: executions.get(existingId);
			if (
				existing !== undefined
				&& isTaskExecutionActive(existing.scheduler.getSnapshot())
			) {
				rejectStart(message, 'already-running');
				return;
			}
			let state: WorkspacePersistentState;
			try {
				state = options.getWorkspaceState();
			} catch {
				rejectStart(message, 'internal-error');
				return;
			}
			const record = state.tasks.find(({ task }) => task.id === message.taskId);
			if (!record) {
				rejectStart(message, 'not-found');
				return;
			}
			if (record.storageRevision !== message.storageRevision) {
				rejectStart(message, 'stale');
				return;
			}

			const executionId = options.createExecutionId?.()
				?? `task-execution-${randomUUID()}`;
			let scheduler: TaskExecutionScheduler;
			const plans = new Map<string, TaskWorkExecutionPlan>();
			const descriptors = new Map<string, TaskExecutionTerminalDescriptor>();
			try {
				scheduler = createTaskExecutionScheduler(
					record.task,
					executionId,
					record.storageRevision,
				);
				for (const { nodeId } of scheduler.getSnapshot().works) {
					const plan = createTaskWorkExecutionPlan(record, nodeId);
					if (!plan) {
						throw new Error('Task Work plan is unavailable.');
					}
					plans.set(nodeId, plan);
					const scope = plan.scope.map((target): TaskExecutionTerminalScope => {
						const path = options.resolveScopePath(target);
						if (!path) {
							throw new Error('Task scope path cannot be resolved.');
						}
						return Object.freeze({
							path,
							kind: target.sourceId.startsWith('file:') ? 'file' : 'folder',
							access: target.access,
						});
					});
					if (new Set(scope.map(({ path }) => path)).size !== scope.length) {
						throw new Error('Task scope contains canonical path aliases.');
					}
					let promptScopeIndex = 0;
					descriptors.set(nodeId, Object.freeze({
						executionId,
						workNodeId: nodeId,
						prompt: createTaskWorkAgentPrompt(plan, () => {
							const entry = scope[promptScopeIndex];
							promptScopeIndex += 1;
							if (!entry) {
								throw new Error('Task scope order is invalid.');
							}
							return entry.path;
						}),
						scope: Object.freeze([...scope]),
					}));
				}
			} catch {
				rejectStart(message, 'invalid-scope');
				return;
			}

			const active: ActiveExecution = {
				scheduler,
				plans,
				descriptors,
				tabByWorkNodeId: new Map(),
				pendingScopeRequestByWorkNodeId: new Map(),
				sessionCreateTimeoutByWorkNodeId: new Map(),
				disposed: false,
			};
			executions.set(executionId, active);
			executionIdByTaskId.set(message.taskId, executionId);
			scheduler.subscribe((snapshot) => post({
				type: 'task.execution.updated',
				snapshot,
			}));
			post({ type: 'task.execution.updated', snapshot: scheduler.getSnapshot() });
			scheduleReady(executionId);
		},

		createSession(message): void {
			const active = executions.get(message.executionId);
			const plan = active?.plans.get(message.workNodeId);
			const descriptor = active?.descriptors.get(message.workNodeId);
			const work = active?.scheduler.getSnapshot().works.find(
				({ nodeId }) => nodeId === message.workNodeId,
			);
			if (
				disposed
				|| !active
				|| active.disposed
				|| !plan
				|| !descriptor
				|| work?.state !== 'starting'
				|| active.tabByWorkNodeId.has(message.workNodeId)
			) {
				return;
			}
			clearSessionCreateTimeout(active, message.workNodeId);
			active.tabByWorkNodeId.set(message.workNodeId, message.tabId);
			void options.terminalHost.createTaskSession(
				message.tabId,
				plan.providerId,
				plan.workspaceRootId as WorkspaceRootId,
				message.switchAttemptId,
				descriptor,
			).catch(() => {
				void finishWork(
					message.executionId,
					message.workNodeId,
					'failed',
					'Agent session creation failed.',
				);
			});
		},

		handleTerminalEvent(event): void {
			if (disposed) {
				return;
			}
			const { executionId, workNodeId } = event.descriptor;
			const active = executions.get(executionId);
			if (
				!active
				|| active.disposed
				|| active.tabByWorkNodeId.get(workNodeId) !== event.tabId
			) {
				return;
			}
			if (event.type === 'started') {
				active.scheduler.markWorkRunning(workNodeId);
				return;
			}
			if (event.type === 'failed' || (event.type === 'exited' && !event.expected)) {
				void finishWork(
					executionId,
					workNodeId,
					'failed',
					'Agent session ended before Task completion.',
				);
				return;
			}
			if (event.type !== 'tool') {
				return;
			}
			const tool = event.event;
			if (tool.operation === 'complete') {
				// 추가 영역 요청이 열린 동안에는 완료로 우회할 수 없다. 같은
				// requestId의 scope-result가 먼저 도착해야 Work가 다시 running 된다.
				if (active.pendingScopeRequestByWorkNodeId.has(workNodeId)) {
					return;
				}
				void finishWork(
					executionId,
					workNodeId,
					tool.status,
					tool.summary,
				);
				return;
			}
			if (tool.operation === 'scope-request') {
				if (
					active.pendingScopeRequestByWorkNodeId.has(workNodeId)
					|| !active.scheduler.markWorkWaitingForApproval(workNodeId)
				) {
					return;
				}
				active.pendingScopeRequestByWorkNodeId.set(workNodeId, tool.requestId);
				return;
			}
			if (
				active.pendingScopeRequestByWorkNodeId.get(workNodeId)
				!== tool.requestId
			) {
				return;
			}
			active.pendingScopeRequestByWorkNodeId.delete(workNodeId);
			if (tool.result === 'approved') {
				active.scheduler.resumeWork(workNodeId);
			} else {
				void finishWork(
					executionId,
					workNodeId,
					'rejected',
					'Additional scope access was rejected.',
				);
			}
		},

		dispose(): void {
			disposed = true;
			for (const active of executions.values()) {
				for (const timeout of active.sessionCreateTimeoutByWorkNodeId.values()) {
					timeout.cancel();
				}
				active.sessionCreateTimeoutByWorkNodeId.clear();
				active.disposed = true;
			}
			executions.clear();
			executionIdByTaskId.clear();
		},
	};
}

/** Agent에게 scope provenance를 숨기지 않고 read/write 경계를 명시한다. */
export function createTaskWorkAgentPrompt(
	plan: TaskWorkExecutionPlan,
	resolveScopePath: (target: TaskExecutionScopeTarget) => string | undefined,
): string {
	const references: string[] = [];
	const workAreas: string[] = [];
	for (const target of plan.scope) {
		const path = resolveScopePath(target);
		if (!path) {
			throw new Error('Task scope path cannot be resolved.');
		}
		(target.access === 'read' ? references : workAreas).push(path);
	}
	return [
		`Task: ${plan.title}`,
		'',
		plan.prompt,
		'',
		'Reference areas (read-only):',
		...(references.length === 0 ? ['- none'] : references.map((path) => `- ${path}`)),
		'',
		'Work areas (read/write):',
		...(workAreas.length === 0 ? ['- none'] : workAreas.map((path) => `- ${path}`)),
	].join('\n');
}
