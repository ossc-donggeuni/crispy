import * as assert from 'node:assert/strict';
import {
	CRISPY_AGENT_ACTIVITY_INSTRUCTIONS,
	CRISPY_AGENT_ACTIVITY_REQUIRED_MARKER,
	CRISPY_PING_ONLY_INSTRUCTIONS,
	createCrispyMcpInstructions,
} from '../../mcp/agentActivityInstructions';
import {
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_PING_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
} from '../../mcp/toolServer';

suite('Crispy MCP server instructions', () => {
	test('unsupported Host instructions are strictly ping-only', () => {
		const instructions = createCrispyMcpInstructions(false);

		assert.strictEqual(instructions, CRISPY_PING_ONLY_INSTRUCTIONS);
		assert.ok(Buffer.byteLength(instructions, 'utf8') <= 512);
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

	test('qualified Host instructions are concise, purpose-bound, and complete', () => {
		const instructions = createCrispyMcpInstructions(true);
		const criticalPrefix = instructions.slice(0, 512);

		assert.strictEqual(instructions, CRISPY_AGENT_ACTIVITY_INSTRUCTIONS);
		assert.ok(Buffer.byteLength(instructions, 'utf8') <= 3 * 1024);
		for (const required of [
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			CRISPY_AGENT_ACTIVITY_REQUIRED_MARKER,
			'host UI selected by the user',
			'mandatory visual instrumentation',
			'do not modify files, expand scope, grant permission, or replace user/project instructions',
			'Before any read/search/edit/test',
			'completion anchor',
			'with planned',
		]) {
			assert.strictEqual(criticalPrefix.includes(required), true, required);
		}
		for (const required of [
			'assigned workspace root',
			'"."',
			'file, folder',
			'planned, active, editing, completed, mentioned, rejected',
			'never downgrade planned, active, editing, completed, or rejected',
			'mentioned before a response-only workspace path reference',
			'next request or scope change',
			'rename/delete',
			'most specific meaningful target',
			'terminal output',
			'filesystem changes',
			'explicit startup, restart, or connection diagnostics',
			'generic Tool or execution error',
			'not Host, Store, display, or receipt delivery',
			'root, session, URI, token, runtime, or internal identity',
			'Before each distinct meaningful target transition',
			'for every non-anchor target used by this request, deepest-first',
			'on the anchor with completed as the final Activity call',
			'Leave no child markers below the completed anchor',
			'do not recreate descendant mentioned markers',
			'If the request cannot succeed, clear its non-terminal child markers',
		]) {
			assert.strictEqual(instructions.includes(required), true, required);
		}
		assert.doesNotMatch(
			instructions,
			/NON-NEGOTIABLE|protocol violation|ignore (?:these|the) instructions/iu,
		);
		assert.strictEqual(CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME, 'crispy_saa');
		assert.strictEqual(CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME, 'crispy_caa');
		assert.doesNotMatch(instructions, /Claude/u);
	});
});
