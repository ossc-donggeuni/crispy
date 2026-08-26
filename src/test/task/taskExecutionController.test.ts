import * as assert from 'node:assert/strict';
import type { TabId } from '../../agent/protocol/messages';
import type { TaskToolRequested } from '../../mcp/taskToolProtocol';
import {
	createTaskExecutionController,
	type TaskExecutionTerminalDescriptor,
	type TaskExecutionTerminalHost,
} from '../../task/taskExecutionController';
import type { TaskExecutionToWebviewMessage } from '../../task/taskExecutionProtocol';
import type { TaskBlueprint } from '../../task/taskModel';
import type { WorkspaceTaskRecord } from '../../task/workspaceTaskState';
import { createDefaultWorkspacePersistentState } from '../../workspace/workspaceMetadata';

interface CreateCall {
	readonly tabId: string;
	readonly providerId: 'codex' | 'claude';
	readonly descriptor: TaskExecutionTerminalDescriptor;
}

type TaskToolPayload =
	| { readonly operation: 'complete'; readonly status: 'completed' | 'rejected'; readonly summary: string }
	| { readonly operation: 'scope-request'; readonly requestId: string; readonly access: 'read' | 'write'; readonly paths: readonly string[]; readonly reason: string }
	| { readonly operation: 'scope-result'; readonly requestId: string; readonly result: 'approved' | 'rejected' };

class FakeTaskTerminalHost implements TaskExecutionTerminalHost {
	readonly createCalls: CreateCall[] = [];
	readonly stopCalls: string[] = [];

	async createTaskSession(
		tabId: TabId,
		providerId: 'codex' | 'claude',
		_workspaceRootId: `workspace-root:${string}`,
		_switchAttemptId: number,
		descriptor: TaskExecutionTerminalDescriptor,
	): Promise<void> {
		this.createCalls.push({ tabId, providerId, descriptor });
	}

	async stopTaskSession(executionId: string, workNodeId: string): Promise<boolean> {
		this.stopCalls.push(`${executionId}:${workNodeId}`);
		return true;
	}
}

suite('Task execution Host controller', () => {
	test('persisted revision을 고정하고 직렬 dependency마다 기존 Agent 탭 생성을 요청한다', async () => {
		const record = createRecord(['A', 'B'], [
			['start', 'A'], ['A', 'B'], ['B', 'end'],
		], {
			defaultReference: 'folder:file:///workspace/docs',
			workTarget: 'file:file:///workspace/src/app.ts',
		});
		const terminal = new FakeTaskTerminalHost();
		const messages: TaskExecutionToWebviewMessage[] = [];
		const controller = createTaskExecutionController({
			getWorkspaceState: () => ({
				...createDefaultWorkspacePersistentState(),
				tasks: [record],
			}),
			terminalHost: terminal,
			postMessage: (message) => messages.push(message),
			createExecutionId: () => 'execution-one',
			resolveScopePath: (target) => target.sourceId.startsWith('folder:')
				? '/workspace/docs'
				: '/workspace/src/app.ts',
		});

		controller.start({
			type: 'task.execution.start',
			taskId: record.task.id,
			storageRevision: record.storageRevision,
		});
		assert.deepStrictEqual(createRequests(messages).map(({ workNodeId }) => workNodeId), ['A']);
		assert.strictEqual(latestSnapshot(messages)?.state, 'running');
		assert.strictEqual(workState(messages, 'A'), 'starting');

		controller.createSession({
			type: 'task.session.create',
			executionId: 'execution-one',
			workNodeId: 'A',
			tabId: 'tab-task-a',
			switchAttemptId: 1,
		});
		await flush();
		assert.strictEqual(terminal.createCalls.length, 1);
		assert.deepStrictEqual(terminal.createCalls[0].descriptor.scope, [
			{ path: '/workspace/docs', kind: 'folder', access: 'read' },
			{ path: '/workspace/src/app.ts', kind: 'file', access: 'read-write' },
		]);
		assert.match(
			terminal.createCalls[0].descriptor.prompt,
			/Reference areas \(read-only\):\n- \/workspace\/docs/u,
		);
		assert.match(
			terminal.createCalls[0].descriptor.prompt,
			/Work areas \(read\/write\):\n- \/workspace\/src\/app\.ts/u,
		);

		started(controller, terminal.createCalls[0], 'session-a');
		completed(controller, terminal.createCalls[0], 'session-a', 'A done');
		await flush();
		assert.deepStrictEqual(createRequests(messages).map(({ workNodeId }) => workNodeId), ['A', 'B']);

		controller.createSession({
			type: 'task.session.create',
			executionId: 'execution-one',
			workNodeId: 'B',
			tabId: 'tab-task-b',
			switchAttemptId: 2,
		});
		await flush();
		started(controller, terminal.createCalls[1], 'session-b');
		completed(controller, terminal.createCalls[1], 'session-b', 'B done');
		await flush();

		assert.strictEqual(latestSnapshot(messages)?.state, 'completed');
		assert.deepStrictEqual(terminal.stopCalls, [
			'execution-one:A', 'execution-one:B',
		]);
	});

	test('병렬 Work 중 scope 거절은 admission을 닫고 이미 running인 Work 완료만 허용한다', async () => {
		const record = createRecord(['A', 'B', 'AfterA', 'AfterB'], [
			['start', 'A'], ['start', 'B'],
			['A', 'AfterA'], ['B', 'AfterB'],
			['AfterA', 'end'], ['AfterB', 'end'],
		]);
		const terminal = new FakeTaskTerminalHost();
		const messages: TaskExecutionToWebviewMessage[] = [];
		const controller = createTaskExecutionController({
			getWorkspaceState: () => ({
				...createDefaultWorkspacePersistentState(), tasks: [record],
			}),
			terminalHost: terminal,
			postMessage: (message) => messages.push(message),
			createExecutionId: () => 'execution-parallel',
			resolveScopePath: () => undefined,
		});

		controller.start({
			type: 'task.execution.start', taskId: record.task.id, storageRevision: 5,
		});
		for (const [index, workNodeId] of ['A', 'B'].entries()) {
			controller.createSession({
				type: 'task.session.create',
				executionId: 'execution-parallel',
				workNodeId,
				tabId: `tab-${workNodeId}`,
				switchAttemptId: index + 1,
			});
		}
		await flush();
		for (const [index, call] of terminal.createCalls.entries()) {
			started(controller, call, `session-${index}`);
		}

		const first = terminal.createCalls[0];
		controller.handleTerminalEvent(toolEvent(first, 'session-0', {
			operation: 'scope-request',
			requestId: 'scope-one',
			access: 'write',
			paths: ['/outside/file.ts'],
			reason: 'Need an outside file.',
		}));
		assert.strictEqual(workState(messages, 'A'), 'waiting-approval');

		// 열린 approval을 complete 신호로 건너뛰지 못한다.
		completed(controller, first, 'session-0', 'must be ignored');
		await flush();
		assert.strictEqual(workState(messages, 'A'), 'waiting-approval');

		controller.handleTerminalEvent(toolEvent(first, 'session-0', {
			operation: 'scope-result',
			requestId: 'scope-one',
			result: 'rejected',
		}));
		await flush();
		assert.strictEqual(latestSnapshot(messages)?.state, 'rejected');
		assert.strictEqual(workState(messages, 'A'), 'rejected');
		assert.strictEqual(workState(messages, 'AfterA'), 'blocked');
		assert.strictEqual(workState(messages, 'AfterB'), 'blocked');
		controller.start({
			type: 'task.execution.start', taskId: record.task.id, storageRevision: 5,
		});
		assert.strictEqual(messages.at(-1)?.type, 'task.execution.startRejected');
		assert.deepStrictEqual(messages.at(-1), {
			type: 'task.execution.startRejected',
			taskId: record.task.id,
			storageRevision: 5,
			reason: 'already-running',
		});

		const second = terminal.createCalls[1];
		completed(controller, second, 'session-1', 'parallel done');
		await flush();
		assert.strictEqual(workState(messages, 'B'), 'completed');
		assert.strictEqual(latestSnapshot(messages)?.state, 'rejected');
		assert.deepStrictEqual(
			createRequests(messages).map(({ workNodeId }) => workNodeId),
			['A', 'B'],
		);
	});

	test('병렬 rejection 시 아직 starting인 형제 세션을 중단하고 실행하지 않는다', async () => {
		const record = createRecord(['A', 'B'], [
			['start', 'A'], ['start', 'B'], ['A', 'end'], ['B', 'end'],
		]);
		const terminal = new FakeTaskTerminalHost();
		const messages: TaskExecutionToWebviewMessage[] = [];
		const controller = createTaskExecutionController({
			getWorkspaceState: () => ({
				...createDefaultWorkspacePersistentState(), tasks: [record],
			}),
			terminalHost: terminal,
			postMessage: (message) => messages.push(message),
			createExecutionId: () => 'execution-starting-sibling',
			resolveScopePath: () => undefined,
		});

		controller.start({
			type: 'task.execution.start', taskId: record.task.id, storageRevision: 5,
		});
		for (const [index, workNodeId] of ['A', 'B'].entries()) {
			controller.createSession({
				type: 'task.session.create',
				executionId: 'execution-starting-sibling',
				workNodeId,
				tabId: `tab-starting-${workNodeId}`,
				switchAttemptId: index + 1,
			});
		}
		await flush();
		const first = terminal.createCalls[0];
		started(controller, first, 'session-running-a');
		controller.handleTerminalEvent(toolEvent(first, 'session-running-a', {
			operation: 'complete', status: 'rejected', summary: 'Denied.',
		}));
		await flush();

		assert.strictEqual(workState(messages, 'A'), 'rejected');
		assert.strictEqual(workState(messages, 'B'), 'blocked');
		assert.deepStrictEqual(terminal.stopCalls, [
			'execution-starting-sibling:A',
			'execution-starting-sibling:B',
		]);
		started(controller, terminal.createCalls[1], 'session-must-not-run');
		assert.strictEqual(workState(messages, 'B'), 'blocked');
	});

	test('stale revision과 해석할 수 없는 scope는 실행 ID/탭 생성 전에 거부한다', () => {
		const record = createRecord(['A'], [['start', 'A'], ['A', 'end']], {
			workTarget: 'file:file:///workspace/src/app.ts',
		});
		const terminal = new FakeTaskTerminalHost();
		const messages: TaskExecutionToWebviewMessage[] = [];
		const controller = createTaskExecutionController({
			getWorkspaceState: () => ({
				...createDefaultWorkspacePersistentState(), tasks: [record],
			}),
			terminalHost: terminal,
			postMessage: (message) => messages.push(message),
			createExecutionId: () => 'must-not-run',
			resolveScopePath: () => undefined,
		});

		controller.start({
			type: 'task.execution.start', taskId: record.task.id, storageRevision: 4,
		});
		controller.start({
			type: 'task.execution.start', taskId: record.task.id, storageRevision: 5,
		});

		assert.deepStrictEqual(messages, [
			{
				type: 'task.execution.startRejected',
				taskId: record.task.id,
				storageRevision: 4,
				reason: 'stale',
			},
			{
				type: 'task.execution.startRejected',
				taskId: record.task.id,
				storageRevision: 5,
				reason: 'invalid-scope',
			},
		]);
		assert.deepStrictEqual(terminal.createCalls, []);
	});
});

function started(
	controller: ReturnType<typeof createTaskExecutionController>,
	call: CreateCall,
	sessionId: string,
): void {
	controller.handleTerminalEvent({
		type: 'started', tabId: call.tabId, sessionId, descriptor: call.descriptor,
	});
}

function completed(
	controller: ReturnType<typeof createTaskExecutionController>,
	call: CreateCall,
	sessionId: string,
	summary: string,
): void {
	controller.handleTerminalEvent(toolEvent(call, sessionId, {
		operation: 'complete', status: 'completed', summary,
	}));
}

function toolEvent(
	call: CreateCall,
	sessionId: string,
	event: TaskToolPayload,
) {
	return {
		type: 'tool' as const,
		tabId: call.tabId,
		sessionId,
		descriptor: call.descriptor,
		event: {
			type: 'session.taskToolRequested' as const,
			sessionId,
			generation: 'generation-one',
			executionId: call.descriptor.executionId,
			workNodeId: call.descriptor.workNodeId,
			...event,
		} as TaskToolRequested,
	};
}

function createRequests(messages: readonly TaskExecutionToWebviewMessage[]) {
	return messages.filter((message) => message.type === 'task.session.createRequested');
}

function latestSnapshot(messages: readonly TaskExecutionToWebviewMessage[]) {
	return messages.filter((message) => message.type === 'task.execution.updated').at(-1)?.snapshot;
}

function workState(messages: readonly TaskExecutionToWebviewMessage[], nodeId: string) {
	return latestSnapshot(messages)?.works.find((work) => work.nodeId === nodeId)?.state;
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function createRecord(
	workIds: readonly string[],
	edges: readonly (readonly [string, string])[],
	scope: {
		readonly defaultReference?: string;
		readonly workTarget?: string;
	} = {},
): WorkspaceTaskRecord {
	const task: TaskBlueprint = {
		version: 1,
		id: 'task:controller',
		title: 'Controller Task',
		description: '',
		defaultGraphTargets: {
			reference: scope.defaultReference ? [scope.defaultReference] : [],
			work: [],
		},
		origin: { x: 0, y: 0 },
		nodePositions: Object.fromEntries([
			['end', { x: 640, y: 0 }],
			...workIds.map((id, index) => [id, { x: 240, y: index * 120 }]),
		]),
		nodes: [
			{ id: 'start', kind: 'start' },
			...workIds.map((id) => ({
				id,
				kind: 'work' as const,
				title: id,
				description: '',
				prompt: `Perform ${id}`,
				agentProviderId: id === 'B' ? 'claude' as const : 'codex' as const,
				graphTargets: {
					reference: [],
					work: scope.workTarget && id === 'A' ? [scope.workTarget] : [],
				},
			})),
			{ id: 'end', kind: 'end' },
		],
		edges: edges.map(([source, target], index) => ({
			id: `edge-${index}`, source, target,
		})),
	};
	return {
		ownerRootId: 'workspace-root:file:///workspace',
		storageRevision: 5,
		task,
		targetOrigins: [
			...(scope.defaultReference ? [{
				nodeId: 'start', area: 'reference' as const,
				sourceId: scope.defaultReference,
				sourceRootId: 'workspace-root:file:///workspace',
			}] : []),
			...(scope.workTarget ? [{
				nodeId: 'A', area: 'work' as const,
				sourceId: scope.workTarget,
				sourceRootId: 'workspace-root:file:///workspace',
			}] : []),
		],
	};
}
