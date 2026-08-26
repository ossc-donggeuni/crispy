import * as assert from 'assert';
import {
	AGENT_SESSION_COLOR_PALETTE,
	createAgentSessionColorRegistry,
	resolveAgentSessionColor,
} from '../../agent/agentSessionColor';

suite('Agent Session Color', () => {
	test('Webview registry는 팔레트 범위의 세션에 중복 없는 안정적인 색을 배정한다', () => {
		const registry = createAgentSessionColorRegistry();
		const sessionIds = AGENT_SESSION_COLOR_PALETTE.map(
			(_color, index) => `session-${index}`,
		);
		const colors = sessionIds.map(registry.resolve);

		assert.deepStrictEqual(colors, AGENT_SESSION_COLOR_PALETTE);
		assert.strictEqual(new Set(colors).size, sessionIds.length);
		assert.strictEqual(registry.resolve(sessionIds[3]), colors[3]);
	});

	test('독립 fallback도 같은 session ID에 안정적인 팔레트 색을 반환한다', () => {
		const first = resolveAgentSessionColor('session-stable');

		assert.strictEqual(resolveAgentSessionColor('session-stable'), first);
		assert.strictEqual(
			AGENT_SESSION_COLOR_PALETTE.some((color) => color === first),
			true,
		);
	});
});
