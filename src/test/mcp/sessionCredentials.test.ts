import * as assert from 'assert';
import {
	assertValidMcpSessionCredentials,
	createMcpSessionCredentials,
	MCP_ROUTE_RANDOM_BYTES,
	MCP_TOKEN_RANDOM_BYTES,
} from '../../mcp/sessionCredentials';

suite('MCP session credentials', () => {
	test('session별 최소 256-bit token과 추측 불가능한 route를 생성한다', () => {
		const first = createMcpSessionCredentials('generation-1', 'session-1');
		const second = createMcpSessionCredentials('generation-1', 'session-2');

		assert.ok(Buffer.from(first.token, 'base64url').byteLength >= MCP_TOKEN_RANDOM_BYTES);
		assert.ok(Buffer.from(first.routeId, 'base64url').byteLength >= MCP_ROUTE_RANDOM_BYTES);
		assert.notStrictEqual(first.token, second.token);
		assert.notStrictEqual(first.routeId, second.routeId);
		assert.doesNotThrow(() => assertValidMcpSessionCredentials(first));
		assert.strictEqual(Object.isFrozen(first), true);
	});

	test('부족한 entropy와 잘못된 identity를 값 반사 없이 거부한다', () => {
		const weakToken = Buffer.alloc(8, 1).toString('base64url');
		const weakRoute = Buffer.alloc(8, 2).toString('base64url');
		const credentials = {
			generation: 'generation-secret-marker',
			sessionId: 'session-secret-marker',
			routeId: weakRoute,
			token: weakToken,
		};

		assert.throws(
			() => assertValidMcpSessionCredentials(credentials),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.doesNotMatch(error.message, /secret-marker/);
				assert.doesNotMatch(error.message, new RegExp(weakToken));
				assert.doesNotMatch(error.message, new RegExp(weakRoute));
				return true;
			},
		);
	});

	test('주입 random source가 계약 byte 수를 지키지 않으면 credential을 반환하지 않는다', () => {
		assert.throws(
			() => createMcpSessionCredentials(
				'generation-1',
				'session-1',
				() => Buffer.alloc(1),
			),
			/MCP credential generation failed/,
		);
	});
});
