import * as assert from 'node:assert/strict';
import type {
	CleanupResult,
	ProcessTreeCaptureResult,
	ProcessTreeController,
	ProcessTreeSnapshot,
} from '../../agent/host/terminal/processTreeController';
import {
	CLAUDE_MCP_MINIMUM_COMPATIBLE_VERSION,
	compareClaudeVersions,
	parseClaudeVersionOutput,
	probeClaudeMcpCompatibility,
	resolveClaudeMcpCompatibility,
} from '../../mcp/claudeCompatibility';

suite('Claude MCP version compatibility', () => {
	test('2.1.121을 inclusive minimum으로 사용하고 future version에 상한을 두지 않는다', () => {
		const before = parseClaudeVersionOutput('2.1.120 (Claude Code)');
		const minimum = parseClaudeVersionOutput('2.1.121 (Claude Code)');
		const current = parseClaudeVersionOutput('2.1.234 (Claude Code)');
		const future = parseClaudeVersionOutput('Claude Code v9.4.7');

		assert.ok(before !== undefined);
		assert.ok(minimum !== undefined);
		assert.ok(current !== undefined);
		assert.ok(future !== undefined);
		assert.ok(compareClaudeVersions(
			before,
			CLAUDE_MCP_MINIMUM_COMPATIBLE_VERSION,
		) < 0);
		assert.strictEqual(compareClaudeVersions(
			minimum,
			CLAUDE_MCP_MINIMUM_COMPATIBLE_VERSION,
		), 0);
		assert.ok(compareClaudeVersions(
			current,
			CLAUDE_MCP_MINIMUM_COMPATIBLE_VERSION,
		) > 0);
		assert.ok(compareClaudeVersions(
			future,
			CLAUDE_MCP_MINIMUM_COMPATIBLE_VERSION,
		) > 0);
	});

	test('warning line은 허용하지만 prerelease와 unrelated output은 추측하지 않는다', () => {
		assert.deepStrictEqual(
			parseClaudeVersionOutput('notice\n2.1.234 (Claude Code)\n'),
			{ major: 2, minor: 1, patch: 234 },
		);
		assert.strictEqual(parseClaudeVersionOutput('2.1.234-beta.1'), undefined);
		assert.strictEqual(parseClaudeVersionOutput('Claude development build'), undefined);
	});

	test('version process를 시작할 수 없으면 safe failure와 undefined로 fail-open한다', async () => {
		const options = {
			executable: {
				executable: '/definitely/missing/crispy-claude',
				launcherKind: 'direct' as const,
			},
			cwd: process.cwd(),
			platform: process.platform,
			environment: process.env,
		};
		const result = await probeClaudeMcpCompatibility(options);
		const compatibility = await resolveClaudeMcpCompatibility(options);

		assert.deepStrictEqual(result, { ok: false, reason: 'spawn_error' });
		assert.strictEqual(compatibility, undefined);
	});

	test('지원하지 않는 launcher request는 process 실행 전에 구분한다', async () => {
		const result = await probeClaudeMcpCompatibility({
			executable: {
				executable: '/tmp/claude.cmd',
				launcherKind: 'cmd-one-shot',
			},
			cwd: process.cwd(),
			platform: 'linux',
			environment: process.env,
		});

		assert.deepStrictEqual(result, { ok: false, reason: 'request_invalid' });
	});

	test('version probe timeout은 result 전에 process tree cleanup을 기다린다', async () => {
		class RecordingController implements ProcessTreeController {
			readonly calls: string[] = [];

			async capture(rootPid: number): Promise<ProcessTreeCaptureResult> {
				this.calls.push(`capture:${rootPid}`);
				return {
					status: 'captured',
					snapshot: { rootPid, descendants: [] },
				};
			}

			async terminate(snapshot: ProcessTreeSnapshot): Promise<CleanupResult> {
				this.calls.push(`terminate:${snapshot.rootPid}`);
				return { outcome: 'force_terminated' };
			}
		}
		const controller = new RecordingController();
		const result = await probeClaudeMcpCompatibility({
			executable: { executable: process.execPath, launcherKind: 'direct' },
			cwd: process.cwd(),
			platform: process.platform,
			environment: process.env,
			processTreeController: controller,
			versionProbeTimeoutMs: 0,
		});

		assert.deepStrictEqual(result, { ok: false, reason: 'timeout' });
		assert.strictEqual(controller.calls.length, 2);
		assert.match(controller.calls[0], /^capture:\d+$/u);
		assert.strictEqual(
			controller.calls[1],
			controller.calls[0].replace('capture:', 'terminate:'),
		);
	});
});
