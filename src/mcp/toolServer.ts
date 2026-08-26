import {
	isJSONRPCRequest,
	McpServer,
	type CallToolResult,
	type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
	AGENT_ACTIVITY_KINDS,
	AGENT_ACTIVITY_TARGET_KINDS,
} from './agentActivityProtocol';

export const CRISPY_MCP_SERVER_NAME = 'crispy';
export const CRISPY_MCP_SERVER_VERSION = '0.0.1';
export const CRISPY_PING_TOOL_NAME = 'crispy_ping';
export const CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME = 'crispy_set_agent_activity';
export const CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME = 'crispy_clear_agent_activity';

export const ACTIVITY_TOOL_ERROR_CODES = Object.freeze([
	'invalid_input',
	'invalid_path',
	'payload_too_large',
	'registration_inactive',
	'busy',
	'internal_error',
] as const);

export type ActivityToolErrorCode = typeof ACTIVITY_TOOL_ERROR_CODES[number];
export type AgentActivityToolOperation = 'set' | 'clear';

export const CRISPY_PING_INPUT_SCHEMA = z.object({}).strict();
export const CRISPY_SET_AGENT_ACTIVITY_INPUT_SCHEMA = z.object({
	path: z.string().min(1),
	targetKind: z.enum(AGENT_ACTIVITY_TARGET_KINDS),
	activity: z.enum(AGENT_ACTIVITY_KINDS),
}).strict();
export const CRISPY_CLEAR_AGENT_ACTIVITY_INPUT_SCHEMA = z.object({
	path: z.string().min(1),
	targetKind: z.enum(AGENT_ACTIVITY_TARGET_KINDS),
}).strict();

export interface CrispyToolServerOptions {
	readonly agentActivityCompatible: boolean;
	readonly handleAgentActivity: (
		operation: AgentActivityToolOperation,
		input: unknown,
	) => CallToolResult;
}

const VALIDATION_FAILURE = Symbol('crispy.tool.validationFailure');
const VALIDATION_FAILURE_RESULT = Object.freeze({ value: VALIDATION_FAILURE });
const INVALID_ARGUMENTS_MARKER = Object.freeze({
	__crispy_invalid_tool_arguments__: true,
});

const PING_INPUT_SCHEMA = createNonReflectingSchema(CRISPY_PING_INPUT_SCHEMA);
const SET_ACTIVITY_INPUT_SCHEMA = createNonReflectingSchema(
	CRISPY_SET_AGENT_ACTIVITY_INPUT_SCHEMA,
);
const CLEAR_ACTIVITY_INPUT_SCHEMA = createNonReflectingSchema(
	CRISPY_CLEAR_AGENT_ACTIVITY_INPUT_SCHEMA,
);

const PING_ANNOTATIONS = Object.freeze({
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
});

const ACTIVITY_ANNOTATIONS = Object.freeze({
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
});

/** Every stateless request receives a fresh server bound to one request owner. */
export function createCrispyToolServer(options: CrispyToolServerOptions): McpServer {
	const server = new McpServer({
		name: CRISPY_MCP_SERVER_NAME,
		version: CRISPY_MCP_SERVER_VERSION,
	});

	server.registerTool(
		CRISPY_PING_TOOL_NAME,
		{
			description: 'Reports that the Crispy observation-only MCP adapter is reachable.',
			inputSchema: PING_INPUT_SCHEMA,
			annotations: PING_ANNOTATIONS,
		},
		(input): CallToolResult => isCrispyToolValidationFailure(input)
			? createActivityToolErrorResult('invalid_input')
			: createPingSuccessResult(),
	);

	if (!options.agentActivityCompatible) {
		return server;
	}

	server.registerTool(
		CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
		{
			description: 'Records an explicit agent activity for a workspace-relative path.',
			inputSchema: SET_ACTIVITY_INPUT_SCHEMA,
			annotations: ACTIVITY_ANNOTATIONS,
		},
		(input): CallToolResult => options.handleAgentActivity('set', input),
	);
	server.registerTool(
		CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
		{
			description: 'Clears explicit agent activity for a workspace-relative path.',
			inputSchema: CLEAR_ACTIVITY_INPUT_SCHEMA,
			annotations: ACTIVITY_ANNOTATIONS,
		},
		(input): CallToolResult => options.handleAgentActivity('clear', input),
	);

	return server;
}

export function isCrispyToolValidationFailure(value: unknown): boolean {
	return value === VALIDATION_FAILURE;
}

export function createActivityToolSuccessResult(): CallToolResult {
	return {
		content: [{
			type: 'text',
			text: JSON.stringify({ ok: true, accepted: true }),
		}],
	};
}

export function createActivityToolErrorResult(
	error: ActivityToolErrorCode,
): CallToolResult {
	return {
		isError: true,
		content: [{
			type: 'text',
			text: JSON.stringify({ ok: false, accepted: false, error }),
		}],
	};
}

/**
 * Normalize only SDK-recognizable Tool records. Invalid argument containers
 * become a private strict-schema failure without mutating the parsed body.
 */
export function normalizeCrispyToolCallArguments(
	parsedBody: unknown,
	agentActivityCompatible: boolean,
): unknown {
	if (!Array.isArray(parsedBody)) {
		return normalizeRequestElement(parsedBody, agentActivityCompatible);
	}

	let normalizedBatch: unknown[] | undefined;
	for (let index = 0; index < parsedBody.length; index += 1) {
		const original = parsedBody[index];
		const normalized = normalizeRequestElement(
			original,
			agentActivityCompatible,
		);
		if (normalized !== original) {
			normalizedBatch ??= [...parsedBody];
			normalizedBatch[index] = normalized;
		}
	}
	return normalizedBatch ?? parsedBody;
}

function createPingSuccessResult(): CallToolResult {
	return {
		content: [{
			type: 'text',
			text: JSON.stringify({
				ok: true,
				server: CRISPY_MCP_SERVER_NAME,
				mode: 'observation-only',
			}),
		}],
	};
}

function createNonReflectingSchema<Input, Output>(
	schema: StandardSchemaWithJSON<Input, Output>,
): StandardSchemaWithJSON<Input, Output | typeof VALIDATION_FAILURE> {
	const original = schema['~standard'];
	return Object.freeze({
		'~standard': Object.freeze({
			version: original.version,
			vendor: original.vendor,
			validate: async (
				value: unknown,
				validationOptions?: Parameters<typeof original.validate>[1],
			) => {
				try {
					const result = await original.validate(value, validationOptions);
					return 'issues' in result
						? VALIDATION_FAILURE_RESULT
						: result;
				} catch {
					return VALIDATION_FAILURE_RESULT;
				}
			},
			jsonSchema: Object.freeze({
				input: (
					jsonOptions: Parameters<typeof original.jsonSchema.input>[0],
				) => original.jsonSchema.input(jsonOptions),
				output: (
					jsonOptions: Parameters<typeof original.jsonSchema.output>[0],
				) => original.jsonSchema.output(jsonOptions),
			}),
		}),
	});
}

function normalizeRequestElement(
	value: unknown,
	agentActivityCompatible: boolean,
): unknown {
	if (!isJSONRPCRequest(value) || value.method !== 'tools/call') {
		return value;
	}
	const params = value.params;
	if (!isPlainRecord(params)) {
		return value;
	}
	const name = params.name;
	if (!isRecognizedToolName(name, agentActivityCompatible)) {
		return value;
	}
	const argumentsValue = params.arguments;
	if (argumentsValue === undefined || isPlainRecord(argumentsValue)) {
		return value;
	}
	return {
		...value,
		params: {
			...params,
			arguments: INVALID_ARGUMENTS_MARKER,
		},
	};
}

function isRecognizedToolName(
	value: unknown,
	agentActivityCompatible: boolean,
): boolean {
	return value === CRISPY_PING_TOOL_NAME
		|| (
			agentActivityCompatible
			&& (
				value === CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME
				|| value === CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME
			)
		);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
