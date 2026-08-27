import * as assert from 'node:assert/strict';
import {
	isValidTaskToolLease,
	parseTaskToolRequested,
	TASK_TOOL_PATH_MAX_COUNT,
	TASK_TOOL_SUMMARY_MAX_UTF8_BYTES,
} from '../../mcp/taskToolProtocol';

suite('Task MCP tool protocol', () => {
	const base = {
		type: 'session.taskToolRequested',
		sessionId: 'session-one',
		generation: 'generation-one',
		executionId: 'execution-one',
		workNodeId: 'work-one',
	} as const;

	test('lease와 complete event를 exact-key/byte cap으로 검증한다', () => {
		assert.strictEqual(isValidTaskToolLease({
			executionId: 'execution-one',
			workNodeId: 'work-one',
		}), true);
		assert.strictEqual(isValidTaskToolLease({
			executionId: 'execution-one',
			workNodeId: 'work-one',
			extra: true,
		}), false);

		const event = {
			...base,
			operation: 'complete',
			status: 'completed',
			summary: 'done',
		} as const;
		assert.deepStrictEqual(parseTaskToolRequested(event), event);
		assert.strictEqual(parseTaskToolRequested({ ...event, extra: true }), undefined);
		assert.strictEqual(parseTaskToolRequested({
			...event,
			summary: '가'.repeat(TASK_TOOL_SUMMARY_MAX_UTF8_BYTES),
		}), undefined);
	});

	test('scope request/result는 requestId, path uniqueness와 count를 제한한다', () => {
		const request = {
			...base,
			operation: 'scope-request',
			requestId: 'scope-one',
			access: 'write',
			paths: ['/outside/a.ts', '/outside/b.ts'],
			reason: 'Need to update generated metadata.',
		} as const;
		const parsed = parseTaskToolRequested(request);
		assert.deepStrictEqual(parsed, request);
		assert.ok(parsed && Object.isFrozen(parsed));
		assert.ok(parsed?.operation === 'scope-request' && Object.isFrozen(parsed.paths));
		assert.strictEqual(parseTaskToolRequested({
			...request,
			paths: ['/outside/a.ts', '/outside/a.ts'],
		}), undefined);
		assert.strictEqual(parseTaskToolRequested({
			...request,
			paths: Array.from(
				{ length: TASK_TOOL_PATH_MAX_COUNT + 1 },
				(_, index) => `/outside/${index}`,
			),
		}), undefined);

		const result = {
			...base,
			operation: 'scope-result',
			requestId: 'scope-one',
			result: 'rejected',
		} as const;
		assert.deepStrictEqual(parseTaskToolRequested(result), result);
		assert.strictEqual(parseTaskToolRequested({
			...result,
			requestId: '',
		}), undefined);
	});
});
