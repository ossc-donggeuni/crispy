import * as assert from 'assert';
import {
	AGENT_SESSION_COLOR_PALETTE,
	createAgentSessionColorRegistry,
	resolveAgentSessionColor,
} from '../../agent/agentSessionColor';

suite('Agent Session Color', () => {
	test('Webview registry는 seed로 섞은 색을 팔레트 범위에서 중복 없이 배정한다', () => {
		const registry = createAgentSessionColorRegistry(0x1234abcd);
		const sessionIds = AGENT_SESSION_COLOR_PALETTE.map(
			(_color, index) => `session-${index}`,
		);
		const colors = sessionIds.map(registry.resolve);

		assert.notDeepStrictEqual(colors, AGENT_SESSION_COLOR_PALETTE);
		assert.deepStrictEqual(
			new Set(colors),
			new Set(AGENT_SESSION_COLOR_PALETTE),
		);
		assert.strictEqual(new Set(colors).size, sessionIds.length);
		assert.strictEqual(registry.resolve(sessionIds[3]), colors[3]);
	});

	test('같은 seed는 같은 순서를 만들고 다른 seed는 다른 순서를 만든다', () => {
		const sessionIds = ['session-A', 'session-B', 'session-C', 'session-D'];
		const resolveColors = (seed: number): readonly string[] => {
			const registry = createAgentSessionColorRegistry(seed);
			return sessionIds.map(registry.resolve);
		};

		assert.deepStrictEqual(resolveColors(123), resolveColors(123));
		assert.notDeepStrictEqual(resolveColors(123), resolveColors(456));
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
