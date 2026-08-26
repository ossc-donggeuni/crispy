import * as assert from 'node:assert/strict';
import {
	CRISPY_AGENT_ACTIVITY_INSTRUCTIONS,
	CRISPY_PING_ONLY_INSTRUCTIONS,
	createCrispyMcpInstructions,
} from '../../mcp/agentActivityInstructions';
import {
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_PING_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
} from '../../mcp/toolServer';

suite('Crispy provider runtime instructions', () => {
	test('unsupported Host instructions are strictly ping-only', () => {
		const instructions = createCrispyMcpInstructions(false);

		assert.strictEqual(instructions, CRISPY_PING_ONLY_INSTRUCTIONS);
		assert.match(instructions, new RegExp(CRISPY_PING_TOOL_NAME, 'u'));
		assert.strictEqual(
			instructions.includes(CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME),
			false,
		);
		assert.strictEqual(
			instructions.includes(CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME),
			false,
		);
		assert.doesNotMatch(instructions, /targetKind|planned|editing|session|token/u);
	});

	test('qualified Host instructions contain the complete bounded contract', () => {
		const instructions = createCrispyMcpInstructions(true);

		assert.strictEqual(instructions, CRISPY_AGENT_ACTIVITY_INSTRUCTIONS);
		for (const required of [
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			'assigned workspace root',
			'"."',
			'file, folder',
			'planned, active, editing, completed, mentioned, rejected',
			'terminal output',
			'filesystem changes',
			'not that it was delivered',
			'root, session, URI, token, runtime, or internal identity',
		]) {
			assert.strictEqual(instructions.includes(required), true, required);
		}
	});
});
