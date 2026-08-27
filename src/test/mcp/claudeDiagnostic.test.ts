import * as assert from 'node:assert/strict';
import {
	CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION,
	classifyClaudeStartupDiagnostic,
} from '../../mcp/claudeDiagnostic';

suite('Claude startup diagnostic classifier', () => {
	const serverName = `${'crispy_'}${'ab'.repeat(12)}`;

	test('공식 managed MCP workstation startup rejection만 분류한다', () => {
		assert.strictEqual(classifyClaudeStartupDiagnostic({
			exitCode: 1,
			signal: null,
			reachedInteractivePrompt: false,
			stderr: `\u001b[31mError: ${CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION}\u001b[0m\n`,
		}), 'provider_policy_blocked');
	});

	test('current session server의 exact schema rejection만 config rejected로 분류한다', () => {
		assert.strictEqual(classifyClaudeStartupDiagnostic({
			exitCode: 1,
			signal: null,
			reachedInteractivePrompt: false,
			expectedMcpServerName: serverName,
			stderr: [
				'Error: Invalid MCP configuration:',
				`mcpServers.${serverName}: Does not adhere to MCP server configuration schema`,
			].join('\n'),
		}), 'provider_config_rejected');

		for (const expectedMcpServerName of [undefined, `${serverName}0`]) {
			assert.strictEqual(classifyClaudeStartupDiagnostic({
				exitCode: 1,
				signal: null,
				reachedInteractivePrompt: false,
				expectedMcpServerName,
				stderr: [
					'Error: Invalid MCP configuration:',
					`mcpServers.${serverName}: Does not adhere to MCP server configuration schema`,
				].join('\n'),
			}), undefined);
		}
	});

	test('정상 종료, prompt 도달, signal, login/network/config generic 오류는 분류하지 않는다', () => {
		for (const input of [
			{
				exitCode: 0,
				signal: null,
				reachedInteractivePrompt: false,
				stderr: CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION,
			},
			{
				exitCode: 1,
				signal: null,
				reachedInteractivePrompt: true,
				stderr: CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION,
			},
			{
				exitCode: null,
				signal: 'SIGTERM' as const,
				reachedInteractivePrompt: false,
				stderr: CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION,
			},
			{
				exitCode: 1,
				signal: null,
				reachedInteractivePrompt: false,
				stderr: 'Authentication failed while contacting the API.',
			},
		]) {
			assert.strictEqual(classifyClaudeStartupDiagnostic(input), undefined);
		}
	});

	test('raw stderr나 credential fragment를 failure reason에 반사하지 않는다', () => {
		const token = Buffer.alloc(32, 0x77).toString('base64url');
		const result = classifyClaudeStartupDiagnostic({
			exitCode: 1,
			signal: null,
			reachedInteractivePrompt: false,
			stderr: `${CLAUDE_MANAGED_MCP_DYNAMIC_CONFIG_REJECTION}\n${token}`,
		});

		assert.strictEqual(result, 'provider_policy_blocked');
		assert.strictEqual(String(result).includes(token), false);
	});
});
