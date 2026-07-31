import * as assert from 'node:assert';

import type { AgentEvent } from '../agentTypes';
import { classifyCodexTool, CodexEventParser } from '../codexEventParser';
import { createValidPlan, VALID_PLAN_USER_PROMPT } from './testFixtures';

suite('CodexEventParser', () => {
	test('chunk 경계와 마지막 미개행 줄을 보존해 JSONL을 처리한다', () => {
		const plan = createValidPlan();
		const line = agentMessageLine(plan);
		const parser = createParser();

		parser.push(line.slice(0, 17));
		parser.push(line.slice(17));
		const result = parser.finish();

		assert.strictEqual(result.parseFailureCount, 0);
		assert.deepStrictEqual(result.plan, plan);
	});

	test('깨진 JSONL만 세고 다음 이벤트의 Plan 처리를 계속한다', () => {
		const parser = createParser();
		parser.push(`not-json\n${agentMessageLine(createValidPlan())}\n`);

		const result = parser.finish();
		assert.strictEqual(result.parseFailureCount, 1);
		assert.ok(result.plan);
	});

	test('마지막 agent_message가 잘못되어도 마지막 유효 Plan을 유지한다', () => {
		const firstPlan = createValidPlan('첫 번째 유효 계획');
		const parser = createParser();
		parser.push(`${agentMessageLine(firstPlan)}\n`);
		parser.push(`${JSON.stringify({
			type: 'item.completed',
			item: { type: 'agent_message', text: '마지막 설명 메시지' },
		})}\n`);

		const result = parser.finish();
		assert.strictEqual(result.agentMessageCount, 2);
		assert.strictEqual(result.parseFailureCount, 0);
		assert.strictEqual(result.plan?.title, '첫 번째 유효 계획');
	});

	test('여러 유효 Plan 중 마지막 후보를 선택하고 Plan JSON을 message로 노출하지 않는다', () => {
		const events: AgentEvent[] = [];
		const parser = createParser((event) => events.push(event));
		parser.push(`${agentMessageLine(createValidPlan('계획 1'))}\n`);
		parser.push(`${agentMessageLine(createValidPlan('계획 2'))}\n`);

		const result = parser.finish();
		assert.strictEqual(result.plan?.title, '계획 2');
		assert.strictEqual(events.filter((event) => event.type === 'message').length, 0);
	});

	test('도구 이벤트를 의미 이름으로 변환하고 같은 item ID는 한 번만 전달한다', () => {
		const events: AgentEvent[] = [];
		const parser = createParser((event) => events.push(event));
		const item = { id: 'tool-1', type: 'command_execution', command: 'sed -n 1,20p src/existing.ts' };
		parser.push(`${JSON.stringify({ type: 'item.started', item })}\n`);
		parser.push(`${JSON.stringify({ type: 'item.completed', item })}\n`);
		parser.finish();

		const toolEvents = events.filter((event) => event.type === 'tool');
		assert.deepStrictEqual(toolEvents, [{ type: 'tool', name: 'read_file', target: 'src/existing.ts' }]);
		assert.strictEqual(classifyCodexTool('rg --files src'), 'list_files');
		assert.strictEqual(classifyCodexTool('rg "symbol" src'), 'search_code');
		assert.strictEqual(classifyCodexTool('pnpm test'), 'run_command');
	});

	test('onEvent 예외가 이후 파싱과 Plan 결과를 중단하지 않는다', () => {
		const parser = createParser(() => {
			throw new Error('UI callback failure');
		});
		parser.push(`${JSON.stringify({ type: 'thread.started' })}\n`);
		parser.push(agentMessageLine(createValidPlan()));

		assert.ok(parser.finish().plan);
	});
});

function createParser(onEvent?: (event: AgentEvent) => void): CodexEventParser {
	return new CodexEventParser({
		userPrompt: VALID_PLAN_USER_PROMPT,
		workspaceRoot: process.cwd(),
		onEvent,
	});
}

function agentMessageLine(plan: unknown): string {
	return JSON.stringify({
		type: 'item.completed',
		item: { id: 'message', type: 'agent_message', text: JSON.stringify(plan) },
	});
}
