import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
	parseHostToMcpChildMessage,
	parseMcpChildToHostMessage,
	type HostToMcpChildMessage,
	type McpChildToHostMessage,
	type McpIpcParseResult,
} from '../../mcp/ipcProtocol';

const generation = 'generation-ipc-test';
const sessionId = 'session-ipc-test';
const requestId = 'request-ipc-test';
const routeId = randomBytes(24).toString('base64url');
const token = randomBytes(32).toString('base64url');

suite('MCP strict IPC validator', () => {
	test('모든 Host→Child 메시지를 exact schema로 새 객체에 복사한다', () => {
		const messages: HostToMcpChildMessage[] = [{
			type: 'auth.register',
			requestId,
			generation,
			sessionId,
			routeId,
			token,
		}, {
			type: 'auth.revoke',
			requestId,
			generation,
			sessionId,
		}, {
			type: 'server.shutdown',
			requestId,
			generation,
		}];

		for (const message of messages) {
			const result = parseHostToMcpChildMessage(message);
			assertSuccess(result);
			assert.deepStrictEqual(result.value, message);
			assert.notStrictEqual(result.value, message);
		}
	});

	test('모든 Child→Host 메시지와 optional failure identity를 검증한다', () => {
		const messages: McpChildToHostMessage[] = [{
			type: 'server.ready', generation, port: 41_001,
		}, {
			type: 'auth.registered', requestId, generation, sessionId,
		}, {
			type: 'auth.revoked', requestId, generation, sessionId,
		}, {
			type: 'session.mcpActivityObserved', generation, sessionId,
		}, {
			type: 'session.crispyPingObserved', generation, sessionId,
		}, {
			type: 'operation.failed',
			requestId,
			generation,
			sessionId,
			reason: 'auth_registration_failed',
		}, {
			type: 'operation.failed',
			generation,
			reason: 'server_start_failed',
		}];

		for (const message of messages) {
			const result = parseMcpChildToHostMessage(message);
			assertSuccess(result);
			assert.deepStrictEqual(result.value, message);
		}
	});

	test('null, array, primitive, unknown type와 누락 필드를 양방향에서 거부한다', () => {
		for (const parser of [parseHostToMcpChildMessage, parseMcpChildToHostMessage]) {
			for (const value of [null, [], 'message', 7, true, undefined]) {
				assertFailure(parser(value), 'invalid_message');
			}
			assertFailure(parser({}), 'missing_field', 'type');
			assertFailure(parser({ type: 42 }), 'invalid_field', 'type');
			assertFailure(parser({ type: 'unknown.message' }), 'unknown_type', 'type');
		}
		assertFailure(parseHostToMcpChildMessage({
			type: 'auth.register', requestId, generation, sessionId, routeId,
		}), 'missing_field', 'token');
		assertFailure(parseMcpChildToHostMessage({
			type: 'server.ready', generation,
		}), 'missing_field', 'port');
	});

	test('unknown field와 잘못된 port, identity, route, token, reason을 거부한다', () => {
		assertFailure(parseHostToMcpChildMessage({
			type: 'server.shutdown', requestId, generation, token,
		}), 'unexpected_field', 'token');
		for (const port of [0, 65_536, 1.5, Number.NaN, '41000']) {
			assertFailure(parseMcpChildToHostMessage({
				type: 'server.ready', generation, port,
			}), 'invalid_field', 'port');
		}
		for (const invalidId of ['', 'space is invalid', 'x'.repeat(129)]) {
			assertFailure(parseHostToMcpChildMessage({
				type: 'server.shutdown', requestId: invalidId, generation,
			}), 'invalid_field', 'requestId');
		}
		assertFailure(parseHostToMcpChildMessage({
			type: 'auth.register',
			requestId,
			generation,
			sessionId,
			routeId: 'short-route',
			token,
		}), 'invalid_field', 'routeId');
		assertFailure(parseHostToMcpChildMessage({
			type: 'auth.register',
			requestId,
			generation,
			sessionId,
			routeId,
			token: 'short-token',
		}), 'invalid_field', 'token');
		assertFailure(parseMcpChildToHostMessage({
			type: 'operation.failed',
			generation,
			reason: 'raw exception text',
		}), 'invalid_field', 'reason');
	});

	test('validation error는 malformed credential이나 원본 message를 반사하지 않는다', () => {
		const badRoute = `${routeId}!sensitive-route-tail`;
		const badToken = `${token}!sensitive-token-tail`;
		const result = parseHostToMcpChildMessage({
			type: 'auth.register',
			requestId,
			generation,
			sessionId,
			routeId: badRoute,
			token: badToken,
		});
		assertFailure(result, 'invalid_field', 'routeId');
		const serialized = JSON.stringify(result);
		assert.ok(!serialized.includes(badRoute));
		assert.ok(!serialized.includes(badToken));
		assert.deepStrictEqual(Object.keys(result.error).sort(), ['code', 'field']);
	});
});

function assertSuccess<Message>(
	result: McpIpcParseResult<Message>,
): asserts result is { readonly ok: true; readonly value: Message } {
	assert.strictEqual(result.ok, true);
}

function assertFailure(
	result: McpIpcParseResult<unknown>,
	code: string,
	field?: string,
): asserts result is { readonly ok: false; readonly error: { readonly code: never } } {
	assert.strictEqual(result.ok, false);
	assert.strictEqual(result.error.code, code);
	assert.strictEqual(result.error.field, field);
}
