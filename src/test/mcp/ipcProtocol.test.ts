import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
	ACTIVITY_IPC_MAX_UTF8_BYTES,
	AGENT_ACTIVITY_KINDS,
	createClearAgentActivityRequested,
	createSetAgentActivityRequested,
} from '../../mcp/agentActivityProtocol';
import {
	parseHostToMcpChildMessage,
	parseMcpChildToHostMessage,
	type HostToMcpChildMessage,
	type McpChildControlMessage,
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
			agentActivityCompatible: false,
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

	test('auth.register capability는 required boolean이며 parsed clone에 exact 보존된다', () => {
		for (const agentActivityCompatible of [false, true]) {
			const message: HostToMcpChildMessage = {
				type: 'auth.register',
				requestId,
				generation,
				sessionId,
				routeId,
				token,
				agentActivityCompatible,
			};
			const result = parseHostToMcpChildMessage(message);
			assertSuccess(result);
			assert.notStrictEqual(result.value, message);
			assert.deepStrictEqual(result.value, message);
			assert.strictEqual(Object.isFrozen(result.value), true);
		}

		assertFailure(parseHostToMcpChildMessage({
			type: 'auth.register', requestId, generation, sessionId, routeId, token,
		}), 'missing_field', 'agentActivityCompatible');
		assertFailure(parseHostToMcpChildMessage({
			type: 'auth.register',
			requestId,
			generation,
			sessionId,
			routeId,
			token,
			agentActivityCompatible: 'true',
		}), 'invalid_field', 'agentActivityCompatible');
	});

	test('모든 Child→Host 메시지와 optional failure identity를 검증한다', () => {
		const messages: McpChildControlMessage[] = [{
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

	test('Agent Activity outbound set/clear는 exact frozen wire이며 inbound parser는 Phase 3까지 격리한다', () => {
		const setEvent = createSetAgentActivityRequested({
			sessionId,
			generation,
			path: 'src/mcp/toolServer.ts',
			targetKind: 'file',
			activity: 'editing',
		});
		const clearEvent = createClearAgentActivityRequested({
			sessionId,
			generation,
			path: 'src/mcp',
			targetKind: 'folder',
		});

		assert.deepStrictEqual(Object.keys(setEvent), [
			'type', 'sessionId', 'generation', 'operation', 'path', 'targetKind', 'activity',
		]);
		assert.deepStrictEqual(Object.keys(clearEvent), [
			'type', 'sessionId', 'generation', 'operation', 'path', 'targetKind',
		]);
		assert.strictEqual(Object.isFrozen(setEvent), true);
		assert.strictEqual(Object.isFrozen(clearEvent), true);
		assertFailure(
			parseMcpChildToHostMessage(setEvent),
			'unknown_type',
			'type',
		);
		assertFailure(
			parseMcpChildToHostMessage(clearEvent),
			'unknown_type',
			'type',
		);

		for (const activity of AGENT_ACTIVITY_KINDS) {
			const event = createSetAgentActivityRequested({
				sessionId,
				generation,
				path: 'src/file.ts',
				targetKind: 'file',
				activity,
			});
			assert.strictEqual(event.operation, 'set');
			assert.strictEqual(event.activity, activity);
			assert.deepStrictEqual(Object.keys(event), [
				'type', 'sessionId', 'generation', 'operation', 'path', 'targetKind', 'activity',
			]);
		}
	});

	test('Agent Activity outbound serialized IPC UTF-8 fixture는 8192/8193 exact다', () => {
		const maxSessionId = 's'.repeat(128);
		const maxGeneration = 'g'.repeat(128);
		const atLimitPath = `${'"'.repeat(3_695)}${'a'.repeat(401)}`;
		const overLimitPath = `${'"'.repeat(3_696)}${'a'.repeat(400)}`;
		const atLimit = createSetAgentActivityRequested({
			sessionId: maxSessionId,
			generation: maxGeneration,
			path: atLimitPath,
			targetKind: 'folder',
			activity: 'completed',
		});
		const overLimit = createSetAgentActivityRequested({
			sessionId: maxSessionId,
			generation: maxGeneration,
			path: overLimitPath,
			targetKind: 'folder',
			activity: 'completed',
		});

		assert.strictEqual(Buffer.byteLength(atLimitPath, 'utf8'), 4_096);
		assert.strictEqual(Buffer.byteLength(overLimitPath, 'utf8'), 4_096);
		assert.strictEqual(
			Buffer.byteLength(JSON.stringify(atLimit), 'utf8'),
			ACTIVITY_IPC_MAX_UTF8_BYTES,
		);
		assert.strictEqual(
			Buffer.byteLength(JSON.stringify(overLimit), 'utf8'),
			ACTIVITY_IPC_MAX_UTF8_BYTES + 1,
		);

		assertFailure(parseMcpChildToHostMessage(atLimit), 'unknown_type', 'type');
		assertFailure(parseMcpChildToHostMessage(overLimit), 'unknown_type', 'type');
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
			agentActivityCompatible: false,
		}), 'invalid_field', 'routeId');
		assertFailure(parseHostToMcpChildMessage({
			type: 'auth.register',
			requestId,
			generation,
			sessionId,
			routeId,
			token: 'short-token',
			agentActivityCompatible: false,
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
			agentActivityCompatible: false,
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
