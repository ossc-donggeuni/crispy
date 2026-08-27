import * as assert from 'node:assert/strict';
import {
	CodexTaskTurnNotificationParser,
	createClaudeTaskTurnLifecycleUrl,
	createTaskCompletionFollowup,
	createTaskTurnLifecycleObserved,
	parseClaudeTaskTurnHookInput,
	parseClaudeTaskTurnLifecyclePath,
	parseTaskTurnLifecycleObserved,
} from '../../mcp/taskTurnLifecycleProtocol';

const routeId = Buffer.alloc(24, 0x24).toString('base64url');
const mcpUrl = `http://127.0.0.1:43123/mcp/${routeId}`;
const completionToolName = 'mcp__crispy_0123456789abcdef01234567__crispy_task_complete';

suite('Task provider turn lifecycle protocol', () => {
	test('Claude lifecycle URL은 MCP route sibling이며 credential을 포함하지 않는다', () => {
		const url = createClaudeTaskTurnLifecycleUrl(mcpUrl, completionToolName);

		assert.strictEqual(
			url,
			`http://127.0.0.1:43123/task-turn-lifecycle/${routeId}/${completionToolName}`,
		);
		assert.deepStrictEqual(
			parseClaudeTaskTurnLifecyclePath(new URL(url).pathname, routeId),
			{ routeId, completionToolName },
		);
		assert.strictEqual(
			parseClaudeTaskTurnLifecyclePath(`${new URL(url).pathname}?x=1`, routeId),
			undefined,
		);
		assert.throws(
			() => createClaudeTaskTurnLifecycleUrl('https://example.com/mcp/value', completionToolName),
			/lifecycle MCP URL is invalid/u,
		);
	});

	test('Claude Stop과 StopFailure의 필요한 bounded 필드만 읽는다', () => {
		assert.deepStrictEqual(parseClaudeTaskTurnHookInput({
			session_id: 'claude-session-one',
			hook_event_name: 'Stop',
			stop_hook_active: false,
			last_assistant_message: 'done',
		}), {
			event: 'Stop',
			providerSessionId: 'claude-session-one',
			stopHookActive: false,
		});
		assert.deepStrictEqual(parseClaudeTaskTurnHookInput({
			session_id: 'claude-session-one',
			hook_event_name: 'StopFailure',
			error: 'rate_limit',
		}), {
			event: 'StopFailure',
			providerSessionId: 'claude-session-one',
		});
		assert.strictEqual(parseClaudeTaskTurnHookInput({
			session_id: 'claude-session-one',
			hook_event_name: 'Stop',
		}), undefined);
	});

	test('Child lifecycle event는 exact frozen identity로 parsing한다', () => {
		const event = createTaskTurnLifecycleObserved({
			sessionId: 'session-one',
			generation: 'generation-one',
			executionId: 'execution-one',
			workNodeId: 'work-one',
			turnId: 'turn-one',
			outcome: 'reminder-injected',
		});

		assert.strictEqual(Object.isFrozen(event), true);
		assert.deepStrictEqual(parseTaskTurnLifecycleObserved(event), event);
		assert.strictEqual(parseTaskTurnLifecycleObserved({
			...event,
			providerId: 'codex',
		}), undefined);
		assert.strictEqual(parseTaskTurnLifecycleObserved({
			...event,
			extra: true,
		}), undefined);
	});

	test('Codex OSC 9 parser는 BEL/ST와 split chunk를 한 번씩 검출한다', () => {
		const parser = new CodexTaskTurnNotificationParser();

		assert.strictEqual(parser.push('before\u001b]'), 0);
		assert.strictEqual(parser.push('9;turn complete\u0007after'), 1);
		assert.strictEqual(parser.push('\u001b]9;second\u001b\\tail'), 1);
		assert.strictEqual(parser.push('\u001b]8;not-a-turn\u0007'), 0);
	});

	test('후속 메시지는 exact Tool과 completed/rejected terminal 상태만 요구한다', () => {
		const followup = createTaskCompletionFollowup(completionToolName);

		assert.match(followup, new RegExp(completionToolName, 'u'));
		assert.match(followup, /status completed/u);
		assert.match(followup, /status rejected/u);
		assert.match(followup, /prose-only/u);
	});
});
