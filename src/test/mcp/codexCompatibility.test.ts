import * as assert from 'node:assert/strict';
import {
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

	test('version process를 시작할 수 없으면 undefined로 fail-open한다', async () => {
		const style = await resolveCodexConfigStyle({
			executable: {
				executable: '/definitely/missing/crispy-codex',
				launcherKind: 'direct',
			},
			cwd: process.cwd(),
			platform: process.platform,
			environment: process.env,
		});

		assert.strictEqual(style, undefined);
	});
});
