import * as assert from 'node:assert/strict';
import {
	createMcpHandler,
	type CallToolResult,
	type McpHttpHandler,
	type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { AGENT_ACTIVITY_KINDS } from '../../mcp/agentActivityProtocol';
import { createCrispyMcpInstructions } from '../../mcp/agentActivityInstructions';
import {
	ACTIVITY_TOOL_ERROR_CODES,
	createActivityToolErrorResult,
	createActivityToolSuccessResult,
	createCrispyToolServer,
	CRISPY_CLEAR_AGENT_ACTIVITY_INPUT_SCHEMA,
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_PING_INPUT_SCHEMA,
	CRISPY_PING_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_INPUT_SCHEMA,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
	isCrispyToolValidationFailure,
	normalizeCrispyToolCallArguments,
	type AgentActivityToolOperation,
} from '../../mcp/toolServer';

const PING_ANNOTATIONS = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
const ACTIVITY_ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};
const OMIT_ARGUMENTS = Symbol('omit arguments');
const PING_SUCCESS: CallToolResult = {
	content: [{
		type: 'text',
		text: '{"ok":true,"server":"crispy","mode":"observation-only"}',
	}],
};

interface SinkCall {
	readonly operation: AgentActivityToolOperation;
	readonly input: unknown;
}

interface McpExchange {
	readonly response: Response;
	readonly text: string;
	readonly messages: readonly unknown[];
}

suite('Crispy MCP Tool / SDK activity boundary', () => {
	test('gate false/true advertises exact names, annotations and original strict schemas', async () => {
		for (const compatible of [false, true]) {
			const calls: SinkCall[] = [];
			const handler = toolHandler(compatible, calls);
			try {
				const initialized = await dispatch(handler, initializeRequest('init'));
				assert.strictEqual(initialized.response.status, 200);
				assert.strictEqual(
					asRecord(asRecord(onlyMessage(initialized)).result).instructions,
					createCrispyMcpInstructions(compatible),
				);

				const exchange = await dispatch(handler, listRequest(1));
				assert.strictEqual(exchange.response.status, 200);
				assert.strictEqual(
					exchange.response.headers.get('content-type'),
					'text/event-stream',
				);
				const tools = listedTools(onlyMessage(exchange));
				assert.deepStrictEqual(tools.map((tool) => tool.name), compatible
					? [
						CRISPY_PING_TOOL_NAME,
						CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
						CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
					]
					: [CRISPY_PING_TOOL_NAME]);
				assertTool(
					tools,
					CRISPY_PING_TOOL_NAME,
					PING_ANNOTATIONS,
					CRISPY_PING_INPUT_SCHEMA,
				);
				assert.match(
					String(findTool(tools, CRISPY_PING_TOOL_NAME).description),
					/startup, restart, or connection diagnostics/u,
				);
				if (compatible) {
					assertTool(
						tools,
						CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
						ACTIVITY_ANNOTATIONS,
						CRISPY_SET_AGENT_ACTIVITY_INPUT_SCHEMA,
					);
					assertTool(
						tools,
						CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
						ACTIVITY_ANNOTATIONS,
						CRISPY_CLEAR_AGENT_ACTIVITY_INPUT_SCHEMA,
					);
					const setDescription = String(findTool(
						tools,
						CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
					).description);
					for (const required of [
						'[REQUIRED FOR USER-VISIBLE GRAPH]',
						'user-selected Crispy Canvas activity graph',
						'without changing workspace content or scope',
						'planned on the completion anchor before workspace work',
						"user-facing request awaits the user's response",
						'each meaningful target active',
						'clearing child targets with crispy_caa',
						'anchor with completed as the final Activity call',
					]) {
						assert.strictEqual(setDescription.includes(required), true, required);
					}
					const clearDescription = String(findTool(
						tools,
						CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
					).description);
					for (const required of [
						'[REQUIRED FOR USER-VISIBLE GRAPH]',
						'user-selected Crispy Canvas activity graph',
						'without changing workspace content',
						'Before a successful final response',
						'every non-anchor target',
						'deepest-first',
						'crispy_saa once',
						'final Activity call',
						'Do not clear the final completed anchor',
					]) {
						assert.strictEqual(clearDescription.includes(required), true, required);
					}
					assert.doesNotMatch(
						`${setDescription} ${clearDescription}`,
						/NON-NEGOTIABLE|protocol violation/iu,
					);
					assert.ok(setDescription.length <= 600);
					assert.ok(clearDescription.length <= 600);
				}
				assert.doesNotMatch(
					JSON.stringify(tools),
					/__crispy|validationFailure|"default"|"const"|"examples"/,
				);
				assert.deepStrictEqual(calls, []);
			} finally {
				await handler.close();
			}
		}
	});

	test('legacy ping success stays exact and invalid ping is fixed/non-reflecting', async () => {
		const calls: SinkCall[] = [];
		const handler = toolHandler(false, calls);
		try {
			const success = await dispatch(handler, callRequest(
				'ping-ok', CRISPY_PING_TOOL_NAME, {},
			));
			const expectedWire = {
				result: PING_SUCCESS,
				jsonrpc: '2.0',
				id: 'ping-ok',
			};
			assert.deepStrictEqual(onlyMessage(success), expectedWire);
			assert.strictEqual(
				success.text,
				`event: message\ndata: ${JSON.stringify(expectedWire)}\n\n`,
			);

			const invalid = await dispatch(handler, callRequest(
				'ping-invalid',
				CRISPY_PING_TOOL_NAME,
				{ extra: 'raw-ping-marker' },
			));
			assert.deepStrictEqual(
				responseResult(onlyMessage(invalid)),
				createActivityToolErrorResult('invalid_input'),
			);
			assert.doesNotMatch(
				invalid.text,
				/raw-ping-marker|Input validation|expected|received|invalid_type|Zod|issues/,
			);
			assert.deepStrictEqual(calls, []);
		} finally {
			await handler.close();
		}
	});

	test('six set activities and strict clear reach the parsed sink', async () => {
		const calls: SinkCall[] = [];
		const handler = toolHandler(true, calls);
		try {
			let id = 10;
			for (const activity of AGENT_ACTIVITY_KINDS) {
				const input = {
					path: `src/${activity}.ts`,
					targetKind: 'file',
					activity,
				};
				const exchange = await dispatch(handler, callRequest(
					id, CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME, input,
				));
				assert.deepStrictEqual(
					responseResult(onlyMessage(exchange)),
					createActivityToolSuccessResult(),
				);
				id += 1;
			}
			const clearInput = { path: '.', targetKind: 'folder' };
			const clear = await dispatch(handler, callRequest(
				id, CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME, clearInput,
			));
			assert.deepStrictEqual(
				responseResult(onlyMessage(clear)),
				createActivityToolSuccessResult(),
			);
			assert.deepStrictEqual(calls, [
				...AGENT_ACTIVITY_KINDS.map((activity) => ({
					operation: 'set' as const,
					input: {
						path: `src/${activity}.ts`,
						targetKind: 'file',
						activity,
					},
				})),
				{ operation: 'clear', input: clearInput },
			]);
		} finally {
			await handler.close();
		}
	});

	test('missing/extra/enum/clear activity failures are fixed invalid_input', async () => {
		const calls: SinkCall[] = [];
		const handler = toolHandler(true, calls);
		const cases = [{
			name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			input: { targetKind: 'file', activity: 'active' },
		}, {
			name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			input: { path: 'raw-missing', targetKind: 'file' },
		}, {
			name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			input: { path: 'raw-enum', targetKind: 'file', activity: 'working' },
		}, {
			name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			input: {
				path: 'raw-extra', targetKind: 'file', activity: 'active', extra: 'secret',
			},
		}, {
			name: CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			input: { path: '', targetKind: 'file', activity: 'active' },
		}, {
			name: CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			input: { path: 'raw-clear', targetKind: 'file', activity: 'active' },
		}];
		try {
			const texts: string[] = [];
			for (let index = 0; index < cases.length; index += 1) {
				const item = cases[index];
				const exchange = await dispatch(handler, callRequest(
					100 + index, item.name, item.input,
				));
				texts.push(exchange.text);
				assert.deepStrictEqual(
					responseResult(onlyMessage(exchange)),
					createActivityToolErrorResult('invalid_input'),
				);
			}
			assert.strictEqual(calls.length, cases.length);
			assert.ok(calls.every((call) => isCrispyToolValidationFailure(call.input)));
			assert.doesNotMatch(
				texts.join('\n'),
				/raw-|working|secret|Input validation|expected|received|invalid_type|Zod/,
			);
		} finally {
			await handler.close();
		}
	});

	test('fixed constructors expose only the exact success and six error shapes', () => {
		assert.deepStrictEqual(createActivityToolSuccessResult(), {
			content: [{ type: 'text', text: '{"ok":true,"accepted":true}' }],
		});
		assert.deepStrictEqual(ACTIVITY_TOOL_ERROR_CODES, [
			'invalid_input',
			'invalid_path',
			'payload_too_large',
			'registration_inactive',
			'busy',
			'internal_error',
		]);
		for (const code of ACTIVITY_TOOL_ERROR_CODES) {
			assert.deepStrictEqual(createActivityToolErrorResult(code), {
				isError: true,
				content: [{
					type: 'text',
					text: `{"ok":false,"accepted":false,"error":"${code}"}`,
				}],
			});
		}
	});

	test('single normalization clones only recognized invalid containers without mutation', async () => {
		const schemas = [
			CRISPY_PING_INPUT_SCHEMA,
			CRISPY_SET_AGENT_ACTIVITY_INPUT_SCHEMA,
			CRISPY_CLEAR_AGENT_ACTIVITY_INPUT_SCHEMA,
		];
		for (const name of [
			CRISPY_PING_TOOL_NAME,
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
		]) {
			for (const invalid of [null, [], 'raw-scalar', 42, true]) {
				const params = { name, arguments: invalid };
				const request = {
					jsonrpc: '2.0', id: 200, method: 'tools/call', params,
				};
				const normalized = normalizeCrispyToolCallArguments(request, true);
				assert.notStrictEqual(normalized, request);
				assert.strictEqual(request.params, params);
				assert.strictEqual(params.arguments, invalid);
				const normalizedParams = asRecord(asRecord(normalized).params);
				assert.notStrictEqual(normalizedParams, params);
				const marker = asRecord(normalizedParams.arguments);
				assert.ok(Object.isFrozen(marker));
				assert.strictEqual(Object.keys(marker).length, 1);
				assert.strictEqual(Object.values(marker)[0], true);
				for (const schema of schemas) {
					const validation = await schema['~standard'].validate({ ...marker });
					assert.ok('issues' in validation);
				}
			}
			const omitted = callRequest(201, name);
			const plain = callRequest(202, name, { arbitrary: 'schema-owned' });
			assert.strictEqual(normalizeCrispyToolCallArguments(omitted, true), omitted);
			assert.strictEqual(normalizeCrispyToolCallArguments(plain, true), plain);
		}
	});

	test('batch normalization clones changed elements only and preserves all original identities', () => {
		const changedParams = { name: CRISPY_PING_TOOL_NAME, arguments: null };
		const changed = {
			jsonrpc: '2.0', id: 301, method: 'tools/call', params: changedParams,
		};
		const unchanged = callRequest(302, CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME, {
			path: 'src/a.ts', targetKind: 'file', activity: 'active',
		});
		const foreign = callRequest(303, 'foreign_tool', null);
		const malformed = {
			jsonrpc: '1.0',
			id: 304,
			method: 'tools/call',
			params: { name: CRISPY_PING_TOOL_NAME, arguments: null },
		};
		const original = [changed, unchanged, foreign, malformed, 7];
		const snapshot = JSON.stringify(original);
		const normalized = normalizeCrispyToolCallArguments(original, true);
		assert.ok(Array.isArray(normalized));
		assert.notStrictEqual(normalized, original);
		assert.notStrictEqual(normalized[0], changed);
		assert.notStrictEqual(asRecord(normalized[0]).params, changedParams);
		assert.strictEqual(normalized[1], unchanged);
		assert.strictEqual(normalized[2], foreign);
		assert.strictEqual(normalized[3], malformed);
		assert.strictEqual(normalized[4], original[4]);
		assert.strictEqual(changed.params, changedParams);
		assert.strictEqual(JSON.stringify(original), snapshot);

		const noChanges = [unchanged, foreign, malformed, null];
		assert.strictEqual(normalizeCrispyToolCallArguments(noChanges, true), noChanges);
	});

	test('normalized scalar containers reach each strict wrapper as fixed invalid_input', async () => {
		const calls: SinkCall[] = [];
		const handler = toolHandler(true, calls);
		try {
			const texts: string[] = [];
			let id = 400;
			for (const name of [
				CRISPY_PING_TOOL_NAME,
				CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
				CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			]) {
				for (const invalid of [null, [], 'raw-wire-scalar', 7]) {
					const raw = callRequest(id, name, invalid);
					const exchange = await dispatch(
						handler,
						normalizeCrispyToolCallArguments(raw, true),
					);
					texts.push(exchange.text);
					assert.deepStrictEqual(
						responseResult(onlyMessage(exchange)),
						createActivityToolErrorResult('invalid_input'),
					);
					id += 1;
				}
			}
			assert.doesNotMatch(
				texts.join('\n'),
				/raw-wire-scalar|expected|received|invalid_type|Input validation|Zod/,
			);
			assert.strictEqual(calls.length, 8);
			assert.ok(calls.every((call) => isCrispyToolValidationFailure(call.input)));
		} finally {
			await handler.close();
		}
	});

	test('gate false Activity and malformed/unrecognized messages keep identity and SDK category', async () => {
		const invalid = callRequest(501, CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME, null);
		const plain = callRequest(502, CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME, {});
		assert.strictEqual(normalizeCrispyToolCallArguments(invalid, false), invalid);
		assert.strictEqual(normalizeCrispyToolCallArguments(plain, false), plain);
		const unchanged: readonly unknown[] = [{
			jsonrpc: '1.0', id: 503, method: 'tools/call',
			params: { name: CRISPY_PING_TOOL_NAME, arguments: null },
		}, {
			jsonrpc: '2.0', id: {}, method: 'tools/call',
			params: { name: CRISPY_PING_TOOL_NAME, arguments: null },
		}, {
			jsonrpc: '2.0', id: 504, method: 'tools/call', params: null,
		}, callRequest(505, 'foreign_tool', null), null, 9];
		for (const value of unchanged) {
			assert.strictEqual(normalizeCrispyToolCallArguments(value, true), value);
		}
		const unchangedBatch = [...unchanged];
		assert.strictEqual(
			normalizeCrispyToolCallArguments(unchangedBatch, true),
			unchangedBatch,
		);

		const calls: SinkCall[] = [];
		const handler = toolHandler(false, calls);
		try {
			const protocolError = responseError(onlyMessage(await dispatch(handler, invalid)));
			assert.strictEqual(protocolError.code, -32602);
			assert.match(String(protocolError.message), /^Invalid tools\/call request:/);
			assert.strictEqual(Object.hasOwn(protocolError, 'data'), false);
			assert.deepStrictEqual(
				responseError(onlyMessage(await dispatch(handler, plain))),
				{
					code: -32602,
					message: `Tool ${CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME} not found`,
				},
			);
			assert.deepStrictEqual(calls, []);
		} finally {
			await handler.close();
		}
	});
});

function toolHandler(compatible: boolean, calls: SinkCall[]): McpHttpHandler {
	return createMcpHandler(() => createCrispyToolServer({
		agentActivityCompatible: compatible,
		handleAgentActivity: (operation, input) => {
			calls.push({ operation, input });
			return isCrispyToolValidationFailure(input)
				? createActivityToolErrorResult('invalid_input')
				: createActivityToolSuccessResult();
		},
	}), { legacy: 'stateless', onerror: () => undefined });
}

async function dispatch(handler: McpHttpHandler, body: unknown): Promise<McpExchange> {
	const request = new Request('http://127.0.0.1/mcp', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify(body),
	});
	const response = await handler.fetch(request, { parsedBody: body });
	const text = await response.text();
	return { response, text, messages: parseResponse(response, text) };
}

function parseResponse(response: Response, body: string): unknown[] {
	if (response.headers.get('content-type')?.startsWith('application/json')) {
		const value = JSON.parse(body) as unknown;
		return Array.isArray(value) ? value : [value];
	}
	assert.strictEqual(response.headers.get('content-type'), 'text/event-stream');
	return body.split(/\r?\n\r?\n/).map((event) => event
		.split(/\r?\n/)
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trimStart())
		.join('\n'))
		.filter((data) => data.length > 0)
		.map((data) => JSON.parse(data) as unknown);
}

function listRequest(id: string | number): Record<string, unknown> {
	return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

function initializeRequest(id: string | number): Record<string, unknown> {
	return {
		jsonrpc: '2.0',
		id,
		method: 'initialize',
		params: {
			protocolVersion: '2025-11-25',
			capabilities: {},
			clientInfo: { name: 'crispy-tool-test', version: '1.0.0' },
		},
	};
}

function callRequest(
	id: string | number,
	name: string,
	args: unknown | typeof OMIT_ARGUMENTS = OMIT_ARGUMENTS,
): Record<string, unknown> {
	return {
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name, ...(args === OMIT_ARGUMENTS ? {} : { arguments: args }) },
	};
}

function onlyMessage(exchange: McpExchange): unknown {
	assert.strictEqual(exchange.messages.length, 1);
	return exchange.messages[0];
}

function listedTools(value: unknown): Array<Record<string, unknown>> {
	const result = asRecord(asRecord(value).result);
	assert.ok(Array.isArray(result.tools));
	return result.tools.map(asRecord);
}

function assertTool(
	tools: ReadonlyArray<Record<string, unknown>>,
	name: string,
	annotations: Record<string, boolean>,
	schema: StandardSchemaWithJSON,
): void {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool !== undefined);
	assert.deepStrictEqual(tool.annotations, annotations);
	assert.deepStrictEqual(
		tool.inputSchema,
		schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
	);
}

function findTool(
	tools: ReadonlyArray<Record<string, unknown>>,
	name: string,
): Record<string, unknown> {
	const tool = tools.find((candidate) => candidate.name === name);
	assert.ok(tool !== undefined);
	return tool;
}

function responseResult(value: unknown): unknown {
	return asRecord(value).result;
}

function responseError(value: unknown): Record<string, unknown> {
	return asRecord(asRecord(value).error);
}

function asRecord(value: unknown): Record<string, unknown> {
	assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
	return value as Record<string, unknown>;
}
