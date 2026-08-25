import * as assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
	request as httpRequest,
	type ClientRequest,
} from 'node:http';
import net, { type Socket } from 'node:net';
import {
	Client,
	StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
	ACTIVITY_IPC_MAX_UTF8_BYTES,
	createSetAgentActivityRequested,
	PATH_MAX_UTF8_BYTES,
	type AgentActivityRequested,
} from '../../mcp/agentActivityProtocol';
import {
	MCP_AUTHENTICATED_IN_FLIGHT_PER_REGISTRATION,
	MCP_HTTP_MAX_CONNECTIONS,
	MCP_REQUEST_BODY_MAX_BYTES,
	MCP_TOO_MANY_REQUESTS_BODY,
} from '../../mcp/httpPolicy';
import {
	CrispyMcpProtocolServer,
	type AgentActivityIpcTransport,
	type McpPingObservedEvent,
} from '../../mcp/protocolServer';
import { createMcpSessionCredentials } from '../../mcp/sessionCredentials';
import {
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_PING_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
} from '../../mcp/toolServer';

interface ProtocolFixture {
	readonly server: CrispyMcpProtocolServer;
	readonly url: string;
	readonly token: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly transport: FakeActivityTransport;
	readonly ping: McpPingObservedEvent[];
}

interface JsonRpcResponse {
	readonly id?: string | number | null;
	readonly result?: {
		readonly isError?: boolean;
		readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
	};
	readonly error?: { readonly code?: number; readonly message?: string };
}

class FakeActivityTransport implements AgentActivityIpcTransport {
	connected = true;
	mode: 'true' | 'false' | 'throw' = 'true';
	readonly events: AgentActivityRequested[] = [];
	readonly callbacks: Array<(error: Error | null) => void> = [];

	isConnected(): boolean {
		return this.connected;
	}

	send(
		event: AgentActivityRequested,
		callback: (error: Error | null) => void,
	): boolean {
		if (this.mode === 'throw') {
			throw new Error('sensitive transport failure');
		}
		this.events.push(event);
		this.callbacks.push(callback);
		return this.mode === 'true';
	}
}

const runningServers = new Set<CrispyMcpProtocolServer>();

suite('Crispy MCP Agent Activity protocol boundary', () => {
	teardown(async () => {
		await Promise.all([...runningServers].map((server) => server.shutdown()));
		runningServers.clear();
	});

	test('compatible registration advertises three Tools and sends exact per-call events', async () => {
		const fixture = await startFixture(true);
		const listed = await postJson(fixture, toolsListRequest(1));
		const listResponse = singleResponse(await listed.text());
		const tools = (listResponse.result as unknown as {
			readonly tools: ReadonlyArray<{ readonly name: string }>;
		}).tools;
		assert.deepStrictEqual(tools.map((tool) => tool.name), [
			CRISPY_PING_TOOL_NAME,
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
		]);

		const set = await callTool(fixture, 2, CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME, {
			path: 'src//./feature.ts',
			targetKind: 'file',
			activity: 'editing',
		});
		const clear = await callTool(fixture, 3, CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME, {
			path: 'src\\feature.ts',
			targetKind: 'file',
		});
		assertFixedToolResult(set, { ok: true, accepted: true });
		assertFixedToolResult(clear, { ok: true, accepted: true });
		assert.strictEqual(fixture.transport.events.length, 2);
		assert.notStrictEqual(
			fixture.transport.events[0],
			fixture.transport.events[1],
		);
		assert.deepStrictEqual(fixture.transport.events, [{
			type: 'session.agentActivityRequested',
			sessionId: fixture.sessionId,
			generation: fixture.generation,
			operation: 'set',
			path: 'src/feature.ts',
			targetKind: 'file',
			activity: 'editing',
		}, {
			type: 'session.agentActivityRequested',
			sessionId: fixture.sessionId,
			generation: fixture.generation,
			operation: 'clear',
			path: 'src/feature.ts',
			targetKind: 'file',
		}]);
		assert.deepStrictEqual(Object.keys(fixture.transport.events[0]), [
			'type', 'sessionId', 'generation', 'operation', 'path', 'targetKind', 'activity',
		]);
		assert.deepStrictEqual(Object.keys(fixture.transport.events[1]), [
			'type', 'sessionId', 'generation', 'operation', 'path', 'targetKind',
		]);
	});

	test('incompatible registration is ping-only and preserves fixed SDK error boundaries', async () => {
		const fixture = await startFixture(false);
		const listed = singleResponse(await (await postJson(
			fixture,
			toolsListRequest(10),
		)).text());
		const tools = (listed.result as unknown as {
			readonly tools: ReadonlyArray<{ readonly name: string }>;
		}).tools;
		assert.deepStrictEqual(tools.map((tool) => tool.name), [CRISPY_PING_TOOL_NAME]);

		const plain = await callTool(
			fixture,
			11,
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			{},
		);
		assert.strictEqual(plain.error?.code, -32602);
		assert.strictEqual(
			plain.error?.message,
			`Tool ${CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME} not found`,
		);
		assert.strictEqual(plain.result, undefined);
		const omittedClear = await callTool(
			fixture,
			14,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			undefined,
		);
		assert.strictEqual(omittedClear.error?.code, -32602);
		assert.strictEqual(
			omittedClear.error?.message,
			`Tool ${CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME} not found`,
		);
		const foreign = await callTool(
			fixture,
			15,
			'foreign-sensitive-tool-name',
			{},
		);
		assert.strictEqual(foreign.error?.code, -32602);
		assert.strictEqual(foreign.error?.message, 'Tool not found');
		assert.doesNotMatch(JSON.stringify(foreign), /foreign-sensitive-tool-name/);

		const batch = await postJson(fixture, [{
			jsonrpc: '2.0',
			id: 12,
			method: 'tools/call',
			params: {
				name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				arguments: null,
			},
		}, {
			jsonrpc: '2.0',
			id: 13,
			method: 'tools/call',
			params: { name: CRISPY_PING_TOOL_NAME, arguments: {} },
		}]);
		const responses = allResponses(await batch.text());
		assert.deepStrictEqual(responses.map((response) => response.id), [12, 13]);
		assert.strictEqual(responses[0].error?.code, -32602);
		assert.strictEqual(responses[0].error?.message, 'Invalid params');
		assert.ok(responses[1].result !== undefined);
		assert.deepStrictEqual(fixture.transport.events, []);
		assert.deepStrictEqual(fixture.ping, []);
		assert.doesNotMatch(JSON.stringify(responses), /expected|received|null|invalid_type|params.*arguments/i);
	});

	test('invalid compatible calls consume rate tokens before validation while ping stays independent', async () => {
		const fixture = await startFixture(true, () => 1_000);
		for (let index = 0; index < 128; index += 1) {
			const response = await callTool(
				fixture,
				100 + index,
				CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				{ path: 'file.ts', targetKind: 'file', activity: 'unknown' },
			);
			assertFixedToolResult(response, {
				ok: false,
				accepted: false,
				error: 'invalid_input',
			});
		}
		const busy = await callTool(
			fixture,
			300,
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			{ path: 'file.ts', targetKind: 'file', activity: 'unknown' },
		);
		assertFixedToolResult(busy, {
			ok: false,
			accepted: false,
			error: 'busy',
		});
		const ping = await callTool(fixture, 301, CRISPY_PING_TOOL_NAME, {});
		assertFixedToolResult(ping, {
			ok: true,
			server: 'crispy',
			mode: 'observation-only',
		});
		assert.deepStrictEqual(fixture.transport.events, []);
	});

	test('held callbacks enforce 64 pending events and release exactly once', async () => {
		const fixture = await startFixture(true, () => 1_000);
		for (let index = 0; index < 64; index += 1) {
			const response = await callTool(
				fixture,
				400 + index,
				CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				{ path: `file-${index}.ts`, targetKind: 'file', activity: 'active' },
			);
			assertFixedToolResult(response, { ok: true, accepted: true });
		}
		const full = await callTool(
			fixture,
			500,
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			{ path: 'full.ts', targetKind: 'file', activity: 'active' },
		);
		assertFixedToolResult(full, {
			ok: false,
			accepted: false,
			error: 'busy',
		});

		fixture.transport.callbacks[0](new Error('callback failure'));
		fixture.transport.callbacks[0](null);
		const afterRelease = await callTool(
			fixture,
			501,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			{ path: 'file-0.ts', targetKind: 'file' },
		);
		assertFixedToolResult(afterRelease, { ok: true, accepted: true });
		assert.strictEqual(fixture.transport.events.length, 65);

		assert.strictEqual(
			fixture.server.revokeSession(fixture.generation, fixture.sessionId),
			true,
		);
		for (const callback of fixture.transport.callbacks) {
			callback(null);
		}
	});

	test('send false is accepted, throw is internal, and known disconnect is inactive', async () => {
		const fixture = await startFixture(true);
		fixture.transport.mode = 'false';
		const sendFalse = await callTool(
			fixture,
			600,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			{ path: 'a.ts', targetKind: 'file' },
		);
		assertFixedToolResult(sendFalse, { ok: true, accepted: true });
		fixture.transport.callbacks[0](new Error('late failure'));

		fixture.transport.mode = 'throw';
		const throwing = await callTool(
			fixture,
			601,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			{ path: 'b.ts', targetKind: 'file' },
		);
		assertFixedToolResult(throwing, {
			ok: false,
			accepted: false,
			error: 'internal_error',
		});
		assert.doesNotMatch(JSON.stringify(throwing), /sensitive transport failure/);

		fixture.transport.mode = 'true';
		fixture.transport.connected = false;
		const disconnected = await callTool(
			fixture,
			602,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			{ path: 'c.ts', targetKind: 'file' },
		);
		assertFixedToolResult(disconnected, {
			ok: false,
			accepted: false,
			error: 'registration_inactive',
		});
	});

	test('transport connectivity reentry cannot send after the captured registration is revoked', async () => {
		const fixture = await startFixture(true);
		fixture.transport.isConnected = (): boolean => {
			fixture.server.revokeSession(fixture.generation, fixture.sessionId);
			return true;
		};
		const response = await callTool(
			fixture,
			610,
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			{ path: 'reentrant.ts', targetKind: 'file', activity: 'editing' },
		);
		assertFixedToolResult(response, {
			ok: false, accepted: false, error: 'registration_inactive',
		});
		assert.deepStrictEqual(fixture.transport.events, []);
	});

	test('request captured before revoke settles as inactive without IPC', async () => {
		const fixture = await startFixture(true);
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 700,
			method: 'tools/call',
			params: {
				name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				arguments: {
					path: 'captured.ts',
					targetKind: 'file',
					activity: 'editing',
				},
			},
		});
		const split = await openSplitBody(fixture, body.slice(0, 20));
		assert.strictEqual(
			fixture.server.revokeSession(fixture.generation, fixture.sessionId),
			true,
		);
		split.request.end(body.slice(20));
		const response = singleResponse((await split.response).body);
		assertFixedToolResult(response, {
			ok: false,
			accepted: false,
			error: 'registration_inactive',
		});
		assert.deepStrictEqual(fixture.transport.events, []);
	});

	test('request-local registrations stay isolated across concurrent servers and revoke', async () => {
		const first = await startFixture(true);
		const second = await startFixture(true);
		const firstBody = JSON.stringify({
			jsonrpc: '2.0',
			id: 710,
			method: 'tools/call',
			params: {
				name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				arguments: {
					path: 'first.ts', targetKind: 'file', activity: 'editing',
				},
			},
		});
		const split = await openSplitBody(first, firstBody.slice(0, 20));
		assert.strictEqual(
			first.server.revokeSession(first.generation, first.sessionId),
			true,
		);
		split.request.end(firstBody.slice(20));
		const [firstResponse, secondResponse] = await Promise.all([
			split.response.then((response) => singleResponse(response.body)),
			callTool(second, 711, CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME, {
				path: 'second.ts', targetKind: 'file', activity: 'active',
			}),
		]);
		assertFixedToolResult(firstResponse, {
			ok: false, accepted: false, error: 'registration_inactive',
		});
		assertFixedToolResult(secondResponse, { ok: true, accepted: true });
		assert.deepStrictEqual(first.transport.events, []);
		assert.deepStrictEqual(second.transport.events, [{
			type: 'session.agentActivityRequested',
			sessionId: second.sessionId,
			generation: second.generation,
			operation: 'set',
			path: 'second.ts',
			targetKind: 'file',
			activity: 'active',
		}]);
	});

	test('root canonical path accepts folder only', async () => {
		const fixture = await startFixture(true);
		const folder = await callTool(
			fixture,
			720,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			{ path: '.', targetKind: 'folder' },
		);
		const file = await callTool(
			fixture,
			721,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			{ path: '.', targetKind: 'file' },
		);
		assertFixedToolResult(folder, { ok: true, accepted: true });
		assertFixedToolResult(file, {
			ok: false, accepted: false, error: 'invalid_path',
		});
		assert.strictEqual(fixture.transport.events.length, 1);
	});

	test('outbound event enforces serialized IPC 8192/8193 on the exact sent object', async () => {
		const fixture = await startFixture(true);
		const eventWithEmptyPath = createSetAgentActivityRequested({
			sessionId: fixture.sessionId,
			generation: fixture.generation,
			path: '',
			targetKind: 'folder',
			activity: 'completed',
		});
		const fixedBytes = Buffer.byteLength(JSON.stringify(eventWithEmptyPath), 'utf8');
		const quoteCountAtLimit = ACTIVITY_IPC_MAX_UTF8_BYTES
			- fixedBytes
			- PATH_MAX_UTF8_BYTES;
		assert.ok(quoteCountAtLimit > 0);
		assert.ok(quoteCountAtLimit < PATH_MAX_UTF8_BYTES);
		const atLimitPath = `${'"'.repeat(quoteCountAtLimit)}${
			'a'.repeat(PATH_MAX_UTF8_BYTES - quoteCountAtLimit)
		}`;
		const overLimitPath = `${'"'.repeat(quoteCountAtLimit + 1)}${
			'a'.repeat(PATH_MAX_UTF8_BYTES - quoteCountAtLimit - 1)
		}`;

		const accepted = await callTool(
			fixture,
			725,
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			{ path: atLimitPath, targetKind: 'folder', activity: 'completed' },
		);
		const rejected = await callTool(
			fixture,
			726,
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			{ path: overLimitPath, targetKind: 'folder', activity: 'completed' },
		);
		assertFixedToolResult(accepted, { ok: true, accepted: true });
		assertFixedToolResult(rejected, {
			ok: false, accepted: false, error: 'payload_too_large',
		});
		assert.strictEqual(fixture.transport.events.length, 1);
		assert.strictEqual(
			Buffer.byteLength(JSON.stringify(fixture.transport.events[0]), 'utf8'),
			ACTIVITY_IPC_MAX_UTF8_BYTES,
		);
	});

	test('authenticated slot 64/65 returns exact 429 and abort releases slots', async () => {
		const fixture = await startFixture(false);
		const uploads: ClientRequest[] = [];
		for (let index = 0; index < MCP_AUTHENTICATED_IN_FLIGHT_PER_REGISTRATION; index += 1) {
			uploads.push(await openSlowUpload(fixture));
		}
		const rejected = await rawPost(fixture, '{}');
		assert.strictEqual(rejected.status, 429);
		assert.strictEqual(rejected.body, MCP_TOO_MANY_REQUESTS_BODY);
		assert.strictEqual(rejected.headers['content-type'], 'application/json; charset=utf-8');
		assert.strictEqual(
			rejected.headers['content-length'],
			String(Buffer.byteLength(MCP_TOO_MANY_REQUESTS_BODY, 'utf8')),
		);
		assert.strictEqual(rejected.headers.connection, 'close');

		for (const upload of uploads) {
			upload.destroy();
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
		const recovered = await postJson(fixture, toolsListRequest(701));
		assert.strictEqual(recovered.status, 200);
	});

	test('415/400/413 terminal gates release slots and body cap is exact N/N+1', async () => {
		const fixture = await startFixture(false);
		const atLimit = `"${'a'.repeat(MCP_REQUEST_BODY_MAX_BYTES - 2)}"`;
		const overLimit = `${atLimit}a`;
		assert.strictEqual(Buffer.byteLength(atLimit, 'utf8'), MCP_REQUEST_BODY_MAX_BYTES);
		assert.strictEqual(
			Buffer.byteLength(overLimit, 'utf8'),
			MCP_REQUEST_BODY_MAX_BYTES + 1,
		);

		const exact = await rawPost(fixture, atLimit);
		assert.strictEqual(exact.status, 400);
		assert.doesNotMatch(exact.body, /a{32}/);
		const oversized = await rawPost(fixture, overLimit);
		assert.strictEqual(oversized.status, 413);
		assert.strictEqual(oversized.headers.connection, 'close');

		for (let index = 0; index <= MCP_AUTHENTICATED_IN_FLIGHT_PER_REGISTRATION; index += 1) {
			const unsupported = await rawPost(fixture, '{}', 'text/plain');
			assert.strictEqual(unsupported.status, 415);
			const malformed = await rawPost(fixture, '{');
			assert.strictEqual(malformed.status, 400);
			const tooLarge = await rawPost(fixture, overLimit);
			assert.strictEqual(tooLarge.status, 413);
		}
		const recovered = await postJson(fixture, toolsListRequest(730));
		assert.strictEqual(recovered.status, 200);
	});

	test('shutdown terminalizes held authenticated uploads without double-release hangs', async () => {
		const fixture = await startFixture(false);
		const uploads: ClientRequest[] = [];
		for (let index = 0; index < MCP_AUTHENTICATED_IN_FLIGHT_PER_REGISTRATION; index += 1) {
			uploads.push(await openSlowUpload(fixture));
		}
		await Promise.race([
			fixture.server.shutdown(),
			new Promise<never>((_resolve, reject) => setTimeout(
				() => reject(new Error('shutdown did not terminalize held uploads.')),
				1_000,
			)),
		]);
		for (const upload of uploads) {
			upload.destroy();
		}
		await fixture.server.shutdown();
	});

	test('listener enforces 96 connections and the exact socket request 256/257 boundary', async () => {
		const fixture = await startFixture(false);
		const port = Number(new URL(fixture.url).port);
		const heldSockets: Socket[] = [];
		try {
			for (let index = 0; index < MCP_HTTP_MAX_CONNECTIONS; index += 1) {
				heldSockets.push(await connectSocket(port));
			}
			const overflow = net.createConnection({ host: '127.0.0.1', port });
			const overflowClosed = new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error('97th connection stayed open.')),
					1_000,
				);
				overflow.once('close', () => {
					clearTimeout(timer);
					resolve();
				});
				overflow.once('error', () => undefined);
			});
			await overflowClosed;
		} finally {
			for (const socket of heldSockets) {
				socket.destroy();
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 10));
		const firstSocket = await connectSocket(port);
		try {
			for (let index = 1; index < 256; index += 1) {
				const result = await postMalformedJsonOnSocket(firstSocket, fixture);
				assert.strictEqual(result.status, 400);
				assert.notStrictEqual(result.connection, 'close');
			}
			const request256 = await postMalformedJsonOnSocket(firstSocket, fixture);
			assert.strictEqual(request256.status, 400);
			assert.strictEqual(request256.connection, 'close');
			const request257 = await postMalformedJsonOnSocket(firstSocket, fixture);
			assert.strictEqual(request257.status, 503);
			assert.strictEqual(request257.connection, 'close');
			await waitForSocketClose(firstSocket);
			const secondSocket = await connectSocket(port);
			try {
				const request258 = await postMalformedJsonOnSocket(secondSocket, fixture);
				assert.strictEqual(request258.status, 400);
				assert.notStrictEqual(request258.connection, 'close');
			} finally {
				secondSocket.destroy();
			}
		} finally {
			firstSocket.destroy();
		}
	});

	test('64 open modern subscriptions keep full-body SDK work fail-closed until settlement', async () => {
		const fixture = await startFixture(false);
		const client = new Client(
			{ name: 'crispy-slot-test', version: '1.0.0' },
			{ versionNegotiation: { mode: 'auto' } },
		);
		const transport = new StreamableHTTPClientTransport(new URL(fixture.url), {
			requestInit: {
				headers: { Authorization: `Bearer ${fixture.token}` },
			},
		});
		const subscriptions: Array<{ close(): Promise<void> }> = [];
		try {
			await client.connect(transport);
			for (let index = 0; index < MCP_AUTHENTICATED_IN_FLIGHT_PER_REGISTRATION; index += 1) {
				subscriptions.push(await client.listen({ toolsListChanged: true }));
			}
			const rejected = await rawPost(fixture, JSON.stringify(toolsListRequest(1_100)));
			assert.strictEqual(rejected.status, 429);
			assert.strictEqual(rejected.body, MCP_TOO_MANY_REQUESTS_BODY);

			await subscriptions.shift()?.close();
			await new Promise((resolve) => setTimeout(resolve, 20));
			const recovered = await postJson(fixture, toolsListRequest(1_101));
			assert.strictEqual(recovered.status, 200);
		} finally {
			await Promise.allSettled(subscriptions.map((subscription) => subscription.close()));
			await client.close().catch(() => undefined);
		}
	});
});

async function startFixture(
	agentActivityCompatible: boolean,
	clock: () => number = () => 1_000,
): Promise<ProtocolFixture> {
	const generation = `generation-${randomBytes(8).toString('hex')}`;
	const sessionId = `session-${randomBytes(8).toString('hex')}`;
	const transport = new FakeActivityTransport();
	const ping: McpPingObservedEvent[] = [];
	const server = new CrispyMcpProtocolServer({
		generation,
		monotonicClock: clock,
		agentActivityTransport: transport,
		onPingObserved: (event) => ping.push(event),
	});
	runningServers.add(server);
	await server.start();
	const credentials = createMcpSessionCredentials(generation, sessionId);
	const registration = server.registerSession(credentials, agentActivityCompatible);
	return {
		server,
		url: registration.url,
		token: credentials.token,
		generation,
		sessionId,
		transport,
		ping,
	};
}

function toolsListRequest(id: number): Record<string, unknown> {
	return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

async function callTool(
	fixture: ProtocolFixture,
	id: number,
	name: string,
	args: unknown,
): Promise<JsonRpcResponse> {
	const response = await postJson(fixture, {
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name, arguments: args },
	});
	assert.strictEqual(response.status, 200);
	return singleResponse(await response.text());
}

function postJson(fixture: ProtocolFixture, body: unknown): Promise<Response> {
	return fetch(fixture.url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${fixture.token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify(body),
	});
}

function singleResponse(body: string): JsonRpcResponse {
	const responses = allResponses(body);
	assert.strictEqual(responses.length, 1);
	return responses[0];
}

function allResponses(body: string): JsonRpcResponse[] {
	const data = body
		.split(/\r?\n/u)
		.filter((line) => line.startsWith('data:'))
		.map((line) => JSON.parse(line.slice('data:'.length).trimStart()) as JsonRpcResponse);
	if (data.length > 0) {
		return data;
	}
	const parsed = JSON.parse(body) as JsonRpcResponse | JsonRpcResponse[];
	return Array.isArray(parsed) ? parsed : [parsed];
}

function assertFixedToolResult(
	response: JsonRpcResponse,
	expected: Readonly<Record<string, unknown>>,
): void {
	assert.strictEqual(response.error, undefined);
	assert.strictEqual(response.result?.content?.length, 1);
	assert.deepStrictEqual(
		JSON.parse(response.result?.content?.[0]?.text ?? 'null'),
		expected,
	);
}

function rawPost(
	fixture: ProtocolFixture,
	body: string,
	contentType = 'application/json',
): Promise<{
	readonly status: number;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	readonly body: string;
}> {
	const target = new URL(fixture.url);
	return new Promise((resolve, reject) => {
		const request = httpRequest({
			host: target.hostname,
			port: Number(target.port),
			path: target.pathname,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				'Content-Type': contentType,
				Accept: 'application/json, text/event-stream',
			},
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
			response.once('error', reject);
			response.once('end', () => resolve({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: Buffer.concat(chunks).toString('utf8'),
			}));
		});
		request.once('error', reject);
		request.end(body);
	});
}

function openSlowUpload(fixture: ProtocolFixture): Promise<ClientRequest> {
	const target = new URL(fixture.url);
	return new Promise((resolve, reject) => {
		let opened = false;
		const request = httpRequest({
			host: target.hostname,
			port: Number(target.port),
			path: target.pathname,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				Expect: '100-continue',
			},
		}, (response) => response.resume());
		request.on('error', (error) => {
			if (!opened) {
				reject(error);
			}
		});
		request.once('continue', () => {
			request.write('{"jsonrpc":"2.0",');
			opened = true;
			resolve(request);
		});
		request.flushHeaders();
	});
}

function openSplitBody(
	fixture: ProtocolFixture,
	firstChunk: string,
): Promise<{
	readonly request: ClientRequest;
	readonly response: Promise<{ readonly body: string }>;
}> {
	const target = new URL(fixture.url);
	return new Promise((resolve, reject) => {
		let responseResolve: ((value: { readonly body: string }) => void) | undefined;
		const responsePromise = new Promise<{ readonly body: string }>((innerResolve) => {
			responseResolve = innerResolve;
		});
		const request = httpRequest({
			host: target.hostname,
			port: Number(target.port),
			path: target.pathname,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				Expect: '100-continue',
			},
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
			response.once('error', reject);
			response.once('end', () => responseResolve?.({
				body: Buffer.concat(chunks).toString('utf8'),
			}));
		});
		request.once('error', reject);
		request.once('continue', () => {
			request.write(firstChunk);
			resolve({ request, response: responsePromise });
		});
		request.flushHeaders();
	});
}

function connectSocket(port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: '127.0.0.1', port });
		socket.once('connect', () => resolve(socket));
		socket.once('error', reject);
	});
}

function postMalformedJsonOnSocket(
	socket: Socket,
	fixture: ProtocolFixture,
): Promise<{
	readonly status: number;
	readonly connection: string | string[] | undefined;
}> {
	const target = new URL(fixture.url);
	return new Promise((resolve, reject) => {
		let responseBytes = Buffer.alloc(0);
		let parsedStatus: number | undefined;
		let parsedConnection: string | undefined;
		const cleanup = (): void => {
			socket.off('data', onData);
			socket.off('error', onError);
			socket.off('close', onClose);
		};
		const onError = (): void => {
			cleanup();
			reject(new Error('raw HTTP socket failed.'));
		};
		const onClose = (): void => {
			cleanup();
			if (parsedStatus !== undefined) {
				resolve({ status: parsedStatus, connection: parsedConnection });
				return;
			}
			reject(new Error('raw HTTP socket closed before its response completed.'));
		};
		const onData = (chunk: Buffer): void => {
			responseBytes = Buffer.concat([responseBytes, chunk]);
			const headerEnd = responseBytes.indexOf('\r\n\r\n');
			if (headerEnd < 0) {
				return;
			}
			const headerText = responseBytes.subarray(0, headerEnd).toString('latin1');
			const lines = headerText.split('\r\n');
			const statusMatch = /^HTTP\/1\.1 (\d{3})(?: |$)/.exec(lines[0]);
			const headers = new Map<string, string>();
			for (const line of lines.slice(1)) {
				const separator = line.indexOf(':');
				if (separator > 0) {
					headers.set(
						line.slice(0, separator).toLowerCase(),
						line.slice(separator + 1).trim(),
					);
				}
			}
			parsedStatus = statusMatch === null ? undefined : Number(statusMatch[1]);
			parsedConnection = headers.get('connection');
			const rawContentLength = headers.get('content-length');
			const contentLength = Number(rawContentLength);
			if (
				parsedStatus === undefined
				|| rawContentLength === undefined
				|| !Number.isSafeInteger(contentLength)
				|| contentLength < 0
				|| responseBytes.length < headerEnd + 4 + contentLength
			) {
				return;
			}
			cleanup();
			resolve({
				status: parsedStatus,
				connection: parsedConnection,
			});
		};
		socket.on('data', onData);
		socket.once('error', onError);
		socket.once('close', onClose);
		socket.write(
			`POST ${target.pathname} HTTP/1.1\r\n`
			+ `Host: ${target.host}\r\n`
			+ `Authorization: Bearer ${fixture.token}\r\n`
			+ 'Content-Type: application/json\r\n'
			+ 'Content-Length: 1\r\n'
			+ 'Accept: application/json, text/event-stream\r\n'
			+ 'Connection: keep-alive\r\n\r\n{',
		);
	});
}

function waitForSocketClose(socket: Socket): Promise<void> {
	if (socket.destroyed) {
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error('raw HTTP socket did not close.')),
			1_000,
		);
		socket.once('close', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
