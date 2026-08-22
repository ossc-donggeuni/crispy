import * as assert from 'node:assert/strict';
import type {
	CleanupResult,
	ProcessTreeCaptureResult,
	ProcessTreeController,
	ProcessTreeSnapshot,
} from '../../agent/host/terminal/processTreeController';
import {
	probeCodexConfigStyle,
	resolveCodexConfigStyle,
	selectCodexConfigStyleFromVersionOutput,
} from '../../mcp/codexCompatibility';

suite('Codex config compatibility', () => {
	test('보수적 baseline 전은 legacy이고 baseline과 이후 semver는 keyed filter다', () => {
		assert.strictEqual(
			selectCodexConfigStyleFromVersionOutput('codex-cli 0.148.9'),
			'legacy-exclude',
		);
		assert.strictEqual(
			selectCodexConfigStyleFromVersionOutput('codex-cli 0.149.0'),
			'keyed-filters',
		);
		assert.strictEqual(
			selectCodexConfigStyleFromVersionOutput('warning\ncodex-cli 1.0.0'),
			'keyed-filters',
		);
	});

	test('인식할 수 없는 version은 MCP config를 추측하지 않는다', () => {
		assert.strictEqual(
			selectCodexConfigStyleFromVersionOutput('codex development build'),
			undefined,
		);
	});

	test('version process를 시작할 수 없으면 safe reason과 undefined로 fail-open한다', async () => {
		const options = {
			executable: {
				executable: '/definitely/missing/crispy-codex',
				launcherKind: 'direct' as const,
			},
			cwd: process.cwd(),
			platform: process.platform,
			environment: process.env,
		};
		const result = await probeCodexConfigStyle(options);
		const style = await resolveCodexConfigStyle(options);

		assert.deepStrictEqual(result, { ok: false, reason: 'spawn_error' });
		assert.strictEqual(style, undefined);
	});

	test('지원하지 않는 launcher request는 process 실행 전 구분한다', async () => {
		const result = await probeCodexConfigStyle({
			executable: {
				executable: '/tmp/codex.cmd',
				launcherKind: 'cmd-one-shot',
			},
			cwd: process.cwd(),
			platform: 'linux',
			environment: process.env,
		});

		assert.deepStrictEqual(result, { ok: false, reason: 'request_invalid' });
	});

	test('version probe timeout은 결과를 반환하기 전에 process tree 정리를 기다린다', async () => {
		class RecordingController implements ProcessTreeController {
			readonly calls: string[] = [];

			async capture(rootPid: number): Promise<ProcessTreeCaptureResult> {
				this.calls.push(`capture:${rootPid}`);
				return {
					status: 'captured',
					snapshot: { rootPid, descendants: [] },
				};
			}

			async terminate(
				snapshot: ProcessTreeSnapshot,
			): Promise<CleanupResult> {
				this.calls.push(`terminate:${snapshot.rootPid}`);
				return { outcome: 'force_terminated' };
			}
		}
		const controller = new RecordingController();
		const result = await probeCodexConfigStyle({
			executable: {
				executable: process.execPath,
				launcherKind: 'direct',
			},
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
