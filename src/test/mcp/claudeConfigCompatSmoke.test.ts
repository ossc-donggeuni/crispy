import * as assert from 'node:assert/strict';
import type { AgentExecutableResolver } from '../../mcp/agentExecutableResolver';
import {
	hasClaudeSessionMcpConfigSurface,
	runClaudeConfigCompatSmoke,
} from '../../mcp/claudeConfigCompatSmoke';
import type {
	ClaudeMcpCompatibilityProbeResult,
	ClaudeSemanticVersion,
} from '../../mcp/claudeCompatibility';

suite('Claude config compatibility smoke', () => {
	const executable = Object.freeze({
		executable: '/opt/bin/claude',
		launcherKind: 'direct' as const,
	});
	const resolveExecutable: AgentExecutableResolver = async () => Object.freeze({
		ok: true,
		executable,
	});

	test('minimum 이상의 실제 version과 session config CLI surface를 승인한다', async () => {
		const result = await runClaudeConfigCompatSmoke({
			cwd: '/workspace',
			environment: {},
			platform: 'linux',
			resolveExecutable,
			probeCompatibility: async () => compatibleVersion({
				major: 2,
				minor: 1,
				patch: 239,
			}),
			readHelpOutput: () => [
				'--mcp-config <configs...>',
				'--strict-mcp-config',
			].join('\n'),
		});

		assert.deepStrictEqual(result, {
			ok: true,
			version: { major: 2, minor: 1, patch: 239 },
		});
	});

	test('minimum 미만은 help probe 전에 safe failure로 거부한다', async () => {
		let helpRead = false;
		const result = await runClaudeConfigCompatSmoke({
			cwd: '/workspace',
			environment: {},
			resolveExecutable,
			probeCompatibility: async () => Object.freeze({
				ok: true,
				compatibility: Object.freeze({
					version: Object.freeze({ major: 2, minor: 1, patch: 120 }),
					compatible: false,
				}),
			}),
			readHelpOutput: () => {
				helpRead = true;
				return '';
			},
		});

		assert.deepStrictEqual(result, {
			ok: false,
			reason: 'version_incompatible',
		});
		assert.strictEqual(helpRead, false);
	});

	test('probe failure와 CLI surface 누락을 credential 없는 reason으로 구분한다', async () => {
		const versionFailure = await runClaudeConfigCompatSmoke({
			cwd: '/workspace',
			environment: {},
			resolveExecutable,
			probeCompatibility: async () => Object.freeze({
				ok: false,
				reason: 'unparsable_version',
			}),
		});
		const surfaceFailure = await runClaudeConfigCompatSmoke({
			cwd: '/workspace',
			environment: {},
			resolveExecutable,
			probeCompatibility: async () => compatibleVersion({
				major: 9,
				minor: 0,
				patch: 0,
			}),
			readHelpOutput: () => '--mcp-config <configs...>',
		});

		assert.deepStrictEqual(versionFailure, {
			ok: false,
			reason: 'version_probe_failed',
		});
		assert.deepStrictEqual(surfaceFailure, {
			ok: false,
			reason: 'session_config_surface_unavailable',
		});
	});

	test('두 공식 flag를 token이나 inline config parsing 없이 찾는다', () => {
		assert.strictEqual(hasClaudeSessionMcpConfigSurface(
			'  --mcp-config <configs...>\n  --strict-mcp-config\n',
		), true);
		assert.strictEqual(hasClaudeSessionMcpConfigSurface(
			'--strict-mcp-config',
		), false);
		assert.strictEqual(hasClaudeSessionMcpConfigSurface(
			'--mcp-config-file --strict-mcp-config-extra',
		), false);
	});
});

function compatibleVersion(
	version: ClaudeSemanticVersion,
): ClaudeMcpCompatibilityProbeResult {
	return Object.freeze({
		ok: true,
		compatibility: Object.freeze({
			version: Object.freeze(version),
			compatible: true,
		}),
	});
}
