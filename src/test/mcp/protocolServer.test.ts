import * as assert from 'assert';
import { request as httpRequest, type ClientRequest } from 'node:http';
import {
	Client,
	StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
	CrispyMcpProtocolServer,
	type McpActivityObservedEvent,
} from '../../mcp/protocolServer';
import {
	MCP_REQUEST_BODY_MAX_BYTES,
} from '../../mcp/httpPolicy';
import { createMcpSessionCredentials } from '../../mcp/sessionCredentials';
import { CRISPY_PING_TOOL_NAME } from '../../mcp/toolServer';

interface StartedFixture {
	readonly server: CrispyMcpProtocolServer;
	readonly url: string;
	readonly token: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly activity: McpActivityObservedEvent[];
}

interface RawHttpResponse {
	readonly status: number;
	readonly headers: Readonly<Record<string, string | string[] | undefined>>;
	readonly body: string;
}

const runningServers = new Set<CrispyMcpProtocolServer>();

suite('Crispy MCP protocol server', () => {
	teardown(async () => {
		await Promise.all([...runningServers].map((server) => server.shutdown()));
		runningServers.clear();
	});

	test('OS가 고른 random port를 127.0.0.1에만 bind하고 exact route를 등록한다', async () => {
		const fixture = await startFixture();
		const parsed = new URL(fixture.url);

		assert.strictEqual(parsed.hostname, '127.0.0.1');
		assert.ok(Number(parsed.port) > 0);
		assert.match(parsed.pathname, /^\/mcp\/[A-Za-z0-9_-]+$/);
		assert.strictEqual(parsed.search, '');
		assert.strictEqual(parsed.hash, '');
		assert.strictEqual(fixture.url.includes(fixture.token), false);
	});

	test('동시 start 호출은 하나의 Promise와 listener를 공유한다', async () => {
		const server = new CrispyMcpProtocolServer({
			generation: 'generation-concurrent-start',
		});
		runningServers.add(server);

		const first = server.start();
		const second = server.start();
		assert.strictEqual(first, second);

		const [firstReady, secondReady] = await Promise.all([first, second]);
		assert.strictEqual(firstReady, secondReady);
		assert.strictEqual(await server.start(), firstReady);
	});

	test('start 진행 중 shutdown은 listener가 running으로 되살아나지 않게 한다', async () => {
		const server = new CrispyMcpProtocolServer({
			generation: 'generation-start-shutdown',
		});
		runningServers.add(server);

		const pendingStart = server.start();
		const startRejected = assert.rejects(
			pendingStart,
			/MCP server failed to start/,
		);
		await Promise.all([server.shutdown(), startRejected]);
		runningServers.delete(server);

		await assert.rejects(
			server.start(),
			/MCP server cannot be started/,
		);
	});

	test('missing/wrong token을 401로 거부하고 credential을 응답에 반사하지 않는다', async () => {
		const fixture = await startFixture();
		const requestBody = toolsListRequest(1);
		const missing = await postJson(fixture.url, undefined, requestBody);
		const wrong = await postJson(fixture.url, 'wrong-token-marker', requestBody);
		const responseBodies = await Promise.all([missing.text(), wrong.text()]);

		assert.strictEqual(missing.status, 401);
		assert.strictEqual(wrong.status, 401);
		assert.strictEqual(missing.headers.get('www-authenticate'), 'Bearer');
		assert.doesNotMatch(responseBodies.join(''), new RegExp(fixture.token));
		assert.doesNotMatch(responseBodies.join(''), /wrong-token-marker/);
		assert.deepStrictEqual(fixture.activity, []);
	});

	test('query, trailing slash, 다른 route와 GET/DELETE를 정확히 거부한다', async () => {
		const fixture = await startFixture();
		for (const suffix of ['?query=1', '/', '-other']) {
			const response = await postJson(
				`${fixture.url}${suffix}`,
				fixture.token,
				toolsListRequest(1),
			);
			assert.strictEqual(response.status, 404);
		}
		for (const method of ['GET', 'DELETE']) {
			const response = await fetch(fixture.url, {
				method,
				headers: { Authorization: `Bearer ${fixture.token}` },
			});
			assert.strictEqual(response.status, 405);
			assert.strictEqual(response.headers.get('allow'), 'POST');
		}
		assert.deepStrictEqual(fixture.activity, []);
	});

	test('browser Origin과 non-loopback Host를 공식 validation helper로 거부한다', async () => {
		const fixture = await startFixture();
		const originRejected = await postJson(
			fixture.url,
			fixture.token,
			toolsListRequest(1),
			{ Origin: 'https://example.invalid' },
		);
		const hostRejected = await rawRequest(fixture.url, {
			Host: 'example.invalid',
			Authorization: `Bearer ${fixture.token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		}, JSON.stringify(toolsListRequest(1)));

		assert.strictEqual(originRejected.status, 403);
		assert.strictEqual(hostRejected.status, 403);
		assert.strictEqual(originRejected.headers.get('access-control-allow-origin'), null);
		assert.strictEqual(hostRejected.headers['access-control-allow-origin'], undefined);
		assert.deepStrictEqual(fixture.activity, []);
	});

	test('content type, body size, UTF-8과 malformed JSON을 SDK dispatch 전에 거부한다', async () => {
		const fixture = await startFixture();
		const wrongType = await rawRequest(fixture.url, {
			Authorization: `Bearer ${fixture.token}`,
			'Content-Type': 'text/plain',
		}, '{}');
		const wrongCharset = await rawRequest(fixture.url, {
			Authorization: `Bearer ${fixture.token}`,
			'Content-Type': 'application/json; charset=euc-kr',
		}, '{}');
		const malformed = await rawRequest(fixture.url, {
			Authorization: `Bearer ${fixture.token}`,
			'Content-Type': 'application/json; charset="utf-8"',
		}, '{not-json');
		const oversized = await rawRequest(fixture.url, {
			Authorization: `Bearer ${fixture.token}`,
			'Content-Type': 'application/json',
		}, JSON.stringify({ value: 'x'.repeat(MCP_REQUEST_BODY_MAX_BYTES) }));
		const malformedUtf8 = await rawRequest(fixture.url, {
			Authorization: `Bearer ${fixture.token}`,
			'Content-Type': 'application/json; charset=utf-8',
			Accept: 'application/json, text/event-stream',
		}, malformedUtf8InitializeBody());

		assert.strictEqual(wrongType.status, 415);
		assert.strictEqual(wrongCharset.status, 415);
		assert.strictEqual(malformed.status, 400);
		assert.strictEqual(oversized.status, 413);
		assert.strictEqual(malformedUtf8.status, 400);
		assert.deepStrictEqual(fixture.activity, []);
	});

	test('chunked body가 상한을 넘으면 client end를 기다리지 않고 413으로 연결을 닫는다', async () => {
		const fixture = await startFixture();
		const oversized = await settlesWithin(
			postOversizedChunkedWithoutEnding(fixture),
			1_000,
		);

		assert.strictEqual(oversized.status, 413);
		assert.strictEqual(oversized.headers.connection, 'close');
		assert.doesNotMatch(oversized.body, new RegExp(fixture.token));
		assert.deepStrictEqual(fixture.activity, []);
	});

	test('legacy initialize가 최초 성공 요청이면 activity를 한 번만 관찰한다', async () => {
		const fixture = await startFixture();
		const initialized = await postJson(fixture.url, fixture.token, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'crispy-c1-test', version: '1.0.0' },
			},
		});
		const listed = await postJson(
			fixture.url,
			fixture.token,
			toolsListRequest(2),
		);

		assert.strictEqual(initialized.status, 200);
		assert.strictEqual(listed.status, 200);
		await waitForActivityCount(fixture.activity, 1);
		assert.deepStrictEqual(fixture.activity, [{
			type: 'session.mcpActivityObserved',
			generation: fixture.generation,
			sessionId: fixture.sessionId,
		}]);
	});

	test('tools/list 또는 tools/call이 최초 요청이어도 activity를 관찰한다', async () => {
		for (const [index, firstRequest] of [
			toolsListRequest(10),
			{
				jsonrpc: '2.0',
				id: 11,
				method: 'tools/call',
				params: { name: CRISPY_PING_TOOL_NAME, arguments: {} },
			},
		].entries()) {
			const fixture = await startFixture(`generation-first-${index}`, `session-first-${index}`);
			const response = await postJson(fixture.url, fixture.token, firstRequest);

			assert.strictEqual(response.status, 200);
			await waitForActivityCount(fixture.activity, 1);
			assert.strictEqual(fixture.activity.length, 1);
			await fixture.server.shutdown();
			runningServers.delete(fixture.server);
		}
	});

	test('동시 성공 요청도 session activity를 정확히 한 번만 관찰한다', async () => {
		const fixture = await startFixture();
		const responses = await Promise.all([
			postJson(fixture.url, fixture.token, toolsListRequest(12)),
			postJson(fixture.url, fixture.token, toolsListRequest(13)),
		]);

		assert.deepStrictEqual(responses.map((response) => response.status), [200, 200]);
		await waitForActivityCount(fixture.activity, 1);
		await settleActivityObservers();
		assert.strictEqual(fixture.activity.length, 1);
	});

	test('activity 관찰 뒤 후속 MCP response는 observation clone을 만들지 않는다', async () => {
		const fixture = await startFixture();
		const originalClone = Response.prototype.clone;
		let cloneCount = 0;
		Response.prototype.clone = function cloneForObservationTest(): Response {
			cloneCount += 1;
			return originalClone.call(this);
		};

		try {
			const first = await postJson(fixture.url, fixture.token, toolsListRequest(14));
			await first.text();
			await waitForActivityCount(fixture.activity, 1);
			const cloneCountAfterActivity = cloneCount;

			const followUp = await postJson(fixture.url, fixture.token, toolsListRequest(15));
			await followUp.text();
			await settleActivityObservers();

			assert.strictEqual(cloneCount, cloneCountAfterActivity);
			assert.strictEqual(fixture.activity.length, 1);
		} finally {
			Response.prototype.clone = originalClone;
		}
	});

	test('notification, invalid JSON-RPC와 unsupported method는 activity가 아니다', async () => {
		const fixture = await startFixture();
		const notification = await postJson(fixture.url, fixture.token, {
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		});
		const invalid = await postJson(fixture.url, fixture.token, {
			jsonrpc: '1.0',
			id: 19,
			method: 'tools/list',
			params: {},
		});
		const unsupported = await postJson(fixture.url, fixture.token, {
			jsonrpc: '2.0',
			id: 20,
			method: 'crispy/mutate',
			params: {},
		});
		await Promise.all([invalid.text(), unsupported.text()]);
		await settleActivityObservers();

		assert.strictEqual(notification.status, 202);
		assert.ok([200, 400].includes(invalid.status));
		assert.ok([200, 400].includes(unsupported.status));
		assert.deepStrictEqual(fixture.activity, []);
	});

	test('strict tool input 실패가 SDK의 isError result이면 activity로 센다', async () => {
		const fixture = await startFixture();
		const invalidInput = await postJson(fixture.url, fixture.token, {
			jsonrpc: '2.0',
			id: 21,
			method: 'tools/call',
			params: { name: CRISPY_PING_TOOL_NAME, arguments: { extra: true } },
		});
		const responseBody = parseMcpResponseBody(await invalidInput.text());

		assert.strictEqual(invalidInput.status, 200);
		assert.strictEqual(responseBody.result?.isError, true);
		await waitForActivityCount(fixture.activity, 1);
		assert.deepStrictEqual(fixture.activity, [{
			type: 'session.mcpActivityObserved',
			generation: fixture.generation,
			sessionId: fixture.sessionId,
		}]);
	});

	test('SDK가 허용한 mixed batch는 qualifying result가 있을 때 activity를 한 번 관찰한다', async () => {
		const fixture = await startFixture();
		const batch = await postJson(fixture.url, fixture.token, [
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 22, method: 'crispy/mutate', params: {} },
			toolsListRequest(23),
		]);

		assert.strictEqual(batch.status, 200);
		await waitForActivityCount(fixture.activity, 1);
		assert.deepStrictEqual(fixture.activity, [{
			type: 'session.mcpActivityObserved',
			generation: fixture.generation,
			sessionId: fixture.sessionId,
		}]);
	});

	test('batch의 notification과 error item만으로는 activity가 아니다', async () => {
		const fixture = await startFixture();
		const batch = await postJson(fixture.url, fixture.token, [
			{ jsonrpc: '2.0', method: 'notifications/initialized' },
			{ jsonrpc: '2.0', id: 24, method: 'crispy/mutate', params: {} },
		]);
		await batch.text();
		await settleActivityObservers();

		assert.ok([200, 400].includes(batch.status));
		assert.deepStrictEqual(fixture.activity, []);
	});

	test('revoke 이후 이전 token과 in-flight stale generation은 activity가 아니다', async () => {
		const fixture = await startFixture();
		assert.strictEqual(fixture.server.revokeSession('stale-generation', fixture.sessionId), false);
		assert.strictEqual(
			fixture.server.revokeSession(fixture.generation, fixture.sessionId),
			true,
		);
		assert.strictEqual(
			fixture.server.revokeSession(fixture.generation, fixture.sessionId),
			false,
		);

		const response = await postJson(
			fixture.url,
			fixture.token,
			toolsListRequest(1),
		);
		assert.strictEqual(response.status, 401);
		assert.deepStrictEqual(fixture.activity, []);
	});

	test('한 generation의 중복 registration을 secret 반사 없이 거부한다', async () => {
		const fixture = await startFixture();
		const duplicate = createMcpSessionCredentials(
			fixture.generation,
			'session-duplicate',
		);

		assert.throws(
			() => fixture.server.registerSession(duplicate),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.doesNotMatch(error.message, new RegExp(duplicate.token));
				assert.doesNotMatch(error.message, new RegExp(duplicate.routeId));
				return true;
			},
		);
	});

	test('official v2 client가 modern discover 후 ping만 목록·호출하고 activity는 한 번이다', async () => {
		const fixture = await startFixture();
		const client = new Client(
			{ name: 'crispy-c1-official-client', version: '1.0.0' },
			{ versionNegotiation: { mode: 'auto' } },
		);
		const transport = new StreamableHTTPClientTransport(
			new URL(fixture.url),
			{
				requestInit: {
					headers: { Authorization: `Bearer ${fixture.token}` },
				},
			},
		);

		try {
			await client.connect(transport);
			const listed = await client.listTools();
			assert.deepStrictEqual(listed.tools.map((tool) => tool.name), [
				CRISPY_PING_TOOL_NAME,
			]);
			assert.deepStrictEqual(listed.tools[0].annotations, {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			});
			assert.strictEqual(listed.tools[0].inputSchema.additionalProperties, false);

			const result = await client.callTool({
				name: CRISPY_PING_TOOL_NAME,
				arguments: {},
			});
			assert.deepStrictEqual(result.content, [{
				type: 'text',
				text: JSON.stringify({
					ok: true,
					server: 'crispy',
					mode: 'observation-only',
				}),
			}]);
			await waitForActivityCount(fixture.activity, 1);
			assert.strictEqual(fixture.activity.length, 1);
		} finally {
			await client.close();
		}
	});

	test('shutdown은 반복 호출을 공유하고 listener port를 닫는다', async () => {
		const fixture = await startFixture();
		const first = fixture.server.shutdown();
		const second = fixture.server.shutdown();
		assert.strictEqual(first, second);
		await first;
		runningServers.delete(fixture.server);

		await assert.rejects(
			fetch(fixture.url, { signal: AbortSignal.timeout(500) }),
		);
	});

	test('slow chunked upload가 active여도 shutdown을 지연하지 않는다', async () => {
		const fixture = await startFixture();
		const slowRequest = await openSlowUpload(fixture);

		try {
			await settlesWithin(fixture.server.shutdown(), 1_000);
			runningServers.delete(fixture.server);
			assert.deepStrictEqual(fixture.activity, []);
		} finally {
			slowRequest.destroy();
		}
	});
});

async function startFixture(
	generation = 'generation-c1',
	sessionId = 'session-c1',
): Promise<StartedFixture> {
	const activity: McpActivityObservedEvent[] = [];
	const server = new CrispyMcpProtocolServer({
		generation,
		onActivityObserved: (event) => activity.push(event),
	});
	runningServers.add(server);
	await server.start();
	const credentials = createMcpSessionCredentials(generation, sessionId);
	const registered = server.registerSession(credentials);
	return {
		server,
		url: registered.url,
		token: credentials.token,
		generation,
		sessionId,
		activity,
	};
}

function toolsListRequest(id: number): Record<string, unknown> {
	return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

function malformedUtf8InitializeBody(): Buffer {
	return Buffer.concat([
		Buffer.from(
			'{"jsonrpc":"2.0","id":30,"method":"initialize","params":'
			+ '{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":'
			+ '{"name":"',
		),
		Buffer.from([0xc3, 0x28]),
		Buffer.from('","version":"1.0.0"}}}'),
	]);
}

function parseMcpResponseBody(body: string): {
	readonly result?: { readonly isError?: unknown };
} {
	const dataLine = body
		.split(/\r?\n/u)
		.find((line) => line.startsWith('data:'));
	return JSON.parse(dataLine?.slice('data:'.length).trimStart() ?? body) as {
		readonly result?: { readonly isError?: unknown };
	};
}

async function waitForActivityCount(
	activity: readonly McpActivityObservedEvent[],
	expectedCount: number,
): Promise<void> {
	for (let attempt = 0; attempt < 50 && activity.length < expectedCount; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	assert.strictEqual(activity.length, expectedCount);
}

async function settleActivityObservers(): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function postJson(
	url: string,
	token: string | undefined,
	body: unknown,
	extraHeaders?: Readonly<Record<string, string>>,
): Promise<Response> {
	return fetch(url, {
		method: 'POST',
		headers: {
			...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...extraHeaders,
		},
		body: JSON.stringify(body),
	});
}

function rawRequest(
	url: string,
	headers: Readonly<Record<string, string>>,
	body: string | Uint8Array,
): Promise<RawHttpResponse> {
	const target = new URL(url);
	return new Promise((resolve, reject) => {
		const request = httpRequest({
			hostname: target.hostname,
			port: Number(target.port),
			path: `${target.pathname}${target.search}`,
			method: 'POST',
			headers,
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

function postOversizedChunkedWithoutEnding(
	fixture: StartedFixture,
): Promise<RawHttpResponse> {
	const target = new URL(fixture.url);
	return new Promise((resolve, reject) => {
		let responseStarted = false;
		const request = httpRequest({
			hostname: target.hostname,
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
			responseStarted = true;
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
			response.once('error', reject);
			response.once('end', () => resolve({
				status: response.statusCode ?? 0,
				headers: response.headers,
				body: Buffer.concat(chunks).toString('utf8'),
			}));
		});
		request.on('error', (error) => {
			if (!responseStarted) {
				reject(error);
			}
		});
		request.once('continue', () => {
			request.write(Buffer.alloc(MCP_REQUEST_BODY_MAX_BYTES + 1, 0x20));
		});
		request.flushHeaders();
	});
}

function openSlowUpload(fixture: StartedFixture): Promise<ClientRequest> {
	const target = new URL(fixture.url);
	return new Promise((resolve, reject) => {
		let connected = false;
		const request = httpRequest({
			hostname: target.hostname,
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
			if (!connected) {
				reject(error);
			}
		});
		request.once('continue', () => {
			request.write('{"jsonrpc":"2.0",');
			setImmediate(() => {
				connected = true;
				resolve(request);
			});
		});
		request.flushHeaders();
	});
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new Error('Operation exceeded its deadline.')),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) {
			clearTimeout(timeout);
		}
	}
}
