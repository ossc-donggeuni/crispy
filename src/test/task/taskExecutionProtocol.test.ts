import * as assert from 'assert';
import {
	parseTaskExecutionToHostMessage,
	parseTaskExecutionToWebviewMessage,
	TASK_EXECUTION_SUMMARY_MAX_BYTES,
} from '../../task';

suite('Task Execution Protocol', () => {
	test('Start와 Task session create 명령을 exact-key로 파싱한다', () => {
		const start = {
			type: 'task.execution.start',
			taskId: 'task:one',
			storageRevision: 3,
		} as const;
		const create = {
			type: 'task.session.create',
			executionId: 'task-execution:one',
			workNodeId: 'task-node:work',
			tabId: 'agent-tab:task',
			switchAttemptId: 7,
		} as const;

		assert.deepStrictEqual(parseTaskExecutionToHostMessage(start), start);
		assert.deepStrictEqual(parseTaskExecutionToHostMessage(create), create);
		assert.strictEqual(parseTaskExecutionToHostMessage({ ...start, extra: true }), undefined);
		assert.strictEqual(parseTaskExecutionToHostMessage({ ...start, storageRevision: -1 }), undefined);
		assert.strictEqual(parseTaskExecutionToHostMessage({ ...create, switchAttemptId: 0 }), undefined);
	});

	test('Host의 탭 생성 요청과 Start 거절을 검증한다', () => {
		const createRequested = {
			type: 'task.session.createRequested',
			executionId: 'task-execution:one',
			taskId: 'task:one',
			workNodeId: 'task-node:work',
			providerId: 'codex',
			workspaceRootId: 'workspace-root:file:///workspace/app',
		} as const;
		const rejected = {
			type: 'task.execution.startRejected',
			taskId: 'task:one',
			storageRevision: 3,
			reason: 'stale',
		} as const;

		assert.deepStrictEqual(
			parseTaskExecutionToWebviewMessage(createRequested),
			createRequested,
		);
		assert.deepStrictEqual(parseTaskExecutionToWebviewMessage(rejected), rejected);
		assert.strictEqual(parseTaskExecutionToWebviewMessage({
			...createRequested,
			providerId: 'other',
		}), undefined);
		assert.strictEqual(parseTaskExecutionToWebviewMessage({
			...rejected,
			reason: 'secret-provider-error',
		}), undefined);
	});

	test('실행 snapshot을 상태 allowlist, Work 고유성, summary byte cap으로 제한한다', () => {
		const message = {
			type: 'task.execution.updated',
			snapshot: {
				executionId: 'task-execution:one',
				taskId: 'task:one',
				storageRevision: 3,
				state: 'running',
				startNodeId: 'task-node:start',
				endNodeId: 'task-node:end',
				works: [{ nodeId: 'task-node:work', state: 'running' }],
			},
		} as const;

		assert.deepStrictEqual(parseTaskExecutionToWebviewMessage(message), message);
		assert.strictEqual(parseTaskExecutionToWebviewMessage({
			...message,
			snapshot: { ...message.snapshot, state: 'paused' },
		}), undefined);
		assert.strictEqual(parseTaskExecutionToWebviewMessage({
			...message,
			snapshot: {
				...message.snapshot,
				works: [
					...message.snapshot.works,
					...message.snapshot.works,
				],
			},
		}), undefined);
		assert.strictEqual(parseTaskExecutionToWebviewMessage({
			...message,
			snapshot: {
				...message.snapshot,
				works: [{
					nodeId: 'task-node:work',
					state: 'completed',
					summary: '가'.repeat(TASK_EXECUTION_SUMMARY_MAX_BYTES),
				}],
			},
		}), undefined);
	});

	test('enumerable 여부와 symbol을 포함해 부가 own key를 거부한다', () => {
		const message: Record<PropertyKey, unknown> = {
			type: 'task.execution.start',
			taskId: 'task:one',
			storageRevision: 1,
		};
		Object.defineProperty(message, 'hidden', { value: true, enumerable: false });
		assert.strictEqual(parseTaskExecutionToHostMessage(message), undefined);

		const withSymbol = {
			type: 'task.execution.start',
			taskId: 'task:one',
			storageRevision: 1,
			[Symbol('hidden')]: true,
		};
		assert.strictEqual(parseTaskExecutionToHostMessage(withSymbol), undefined);
	});
});
