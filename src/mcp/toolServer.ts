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
import {
	CRISPY_AGENT_ACTIVITY_REQUIRED_MARKER,
	createCrispyMcpInstructions,
} from './agentActivityInstructions';
import {
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_PING_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_TASK_COMPLETE_TOOL_NAME,
	CRISPY_TASK_SCOPE_REQUEST_TOOL_NAME,
	CRISPY_TASK_SCOPE_RESULT_TOOL_NAME,
} from './toolNames';
import {
	TASK_TOOL_PATH_MAX_COUNT,
	TASK_TOOL_PATH_MAX_UTF8_BYTES,
	TASK_TOOL_REASON_MAX_UTF8_BYTES,
	TASK_TOOL_SUMMARY_MAX_UTF8_BYTES,
	type TaskToolLease,
} from './taskToolProtocol';

export {
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_PING_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_TASK_COMPLETE_TOOL_NAME,
	CRISPY_TASK_SCOPE_REQUEST_TOOL_NAME,
	CRISPY_TASK_SCOPE_RESULT_TOOL_NAME,
} from './toolNames';

export const CRISPY_MCP_SERVER_NAME = 'crispy';
export const CRISPY_MCP_SERVER_VERSION = '0.0.1';

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
export type TaskToolOperation = 'complete' | 'scope-request' | 'scope-result';

export const TASK_TOOL_ERROR_CODES = Object.freeze([
	'invalid_input',
	'payload_too_large',
	'registration_inactive',
	'busy',
	'internal_error',
] as const);
export type TaskToolErrorCode = typeof TASK_TOOL_ERROR_CODES[number];

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
export const CRISPY_TASK_COMPLETE_INPUT_SCHEMA = z.object({
	status: z.enum(['completed', 'rejected']),
	summary: z.string(),
}).strict();
export const CRISPY_TASK_SCOPE_REQUEST_INPUT_SCHEMA = z.object({
	access: z.enum(['read', 'write']),
	paths: z.array(z.string()).min(1).max(TASK_TOOL_PATH_MAX_COUNT),
	reason: z.string(),
}).strict();
export const CRISPY_TASK_SCOPE_RESULT_INPUT_SCHEMA = z.object({
	requestId: z.string().min(1),
	result: z.enum(['approved', 'rejected']),
}).strict();

export interface CrispyToolServerOptions {
	readonly agentActivityCompatible: boolean;
	readonly handleAgentActivity: (
		operation: AgentActivityToolOperation,
		input: unknown,
	) => CallToolResult;
	readonly taskLease?: TaskToolLease;
	readonly handleTaskTool?: (
		operation: TaskToolOperation,
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
const TASK_COMPLETE_INPUT_SCHEMA = createNonReflectingSchema(
	CRISPY_TASK_COMPLETE_INPUT_SCHEMA,
);
const TASK_SCOPE_REQUEST_INPUT_SCHEMA = createNonReflectingSchema(
	CRISPY_TASK_SCOPE_REQUEST_INPUT_SCHEMA,
);
const TASK_SCOPE_RESULT_INPUT_SCHEMA = createNonReflectingSchema(
	CRISPY_TASK_SCOPE_RESULT_INPUT_SCHEMA,
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
	}, {
		instructions: createCrispyMcpInstructions(
			options.agentActivityCompatible,
			options.taskLease !== undefined
				&& options.handleTaskTool !== undefined,
		),
	});

	server.registerTool(
		CRISPY_PING_TOOL_NAME,
		{
			description: 'Checks Crispy MCP reachability. Call only for explicit startup, restart, or connection diagnostics; never routinely.',
			inputSchema: PING_INPUT_SCHEMA,
			annotations: PING_ANNOTATIONS,
		},
		(input): CallToolResult => isCrispyToolValidationFailure(input)
			? createActivityToolErrorResult('invalid_input')
			: createPingSuccessResult(),
	);

	if (options.agentActivityCompatible) {
		server.registerTool(
			CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
			{
				description: `${CRISPY_AGENT_ACTIVITY_REQUIRED_MARKER} Updates the user-selected Crispy Canvas activity graph without changing workspace content or scope. Call on the completion anchor with planned before workspace work; call on each meaningful target with active before read/analyze/verify or editing before modification. Use mentioned only for a response-only path and rejected only for an intentional skip. After clearing child targets with crispy_caa, call on the anchor with completed as the final Activity call before a successful response.`,
				inputSchema: SET_ACTIVITY_INPUT_SCHEMA,
				annotations: ACTIVITY_ANNOTATIONS,
			},
			(input): CallToolResult => options.handleAgentActivity('set', input),
		);
		server.registerTool(
			CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
			{
				description: `${CRISPY_AGENT_ACTIVITY_REQUIRED_MARKER} Removes a marker from the user-selected Crispy Canvas activity graph without changing workspace content. Before a successful final response, clear every non-anchor target used by the request deepest-first, including a completed child; then call crispy_saa once on the anchor with completed as the final Activity call. Also clear stale, irrelevant, renamed, or deleted targets. Do not clear the final completed anchor or recreate descendant mentioned markers.`,
				inputSchema: CLEAR_ACTIVITY_INPUT_SCHEMA,
				annotations: ACTIVITY_ANNOTATIONS,
			},
			(input): CallToolResult => options.handleAgentActivity('clear', input),
		);
	}

	if (options.taskLease && options.handleTaskTool) {
		registerTaskTools(server, options.handleTaskTool);
	}

	return server;
}

function registerTaskTools(
	server: McpServer,
	handleTaskTool: NonNullable<CrispyToolServerOptions['handleTaskTool']>,
): void {
	server.registerTool(
		CRISPY_TASK_COMPLETE_TOOL_NAME,
		{
			description: 'Required terminal signal for this Crispy Task Work. Call exactly once after the assigned work is finished, using completed only for success and rejected for an intentional scope or user-denial outcome. This call ends the Task-owned Agent process after Host acceptance.',
			inputSchema: TASK_COMPLETE_INPUT_SCHEMA,
			annotations: ACTIVITY_ANNOTATIONS,
		},
		(input): CallToolResult => isCrispyToolValidationFailure(input)
			|| !isTaskCompleteInputWithinByteLimits(input)
			? createTaskToolErrorResult('invalid_input')
			: handleTaskTool('complete', input),
	);
	server.registerTool(
		CRISPY_TASK_SCOPE_REQUEST_TOOL_NAME,
		{
			description: 'Call before attempting to read or modify any path outside the assigned Task reference/work areas. Retain the returned requestId, then attempt that exact access so the provider opens its normal permission UI in this same tab. This tool requests attention but does not itself grant access.',
			inputSchema: TASK_SCOPE_REQUEST_INPUT_SCHEMA,
			annotations: ACTIVITY_ANNOTATIONS,
		},
		(input): CallToolResult => isCrispyToolValidationFailure(input)
			|| !isTaskScopeRequestInputWithinByteLimits(input)
			? createTaskToolErrorResult('invalid_input')
			: handleTaskTool('scope-request', input),
	);
	server.registerTool(
		CRISPY_TASK_SCOPE_RESULT_TOOL_NAME,
		{
			description: 'After the normal permission prompt in this Task Agent tab is resolved, report the retained requestId as approved or rejected before doing anything else. A rejected result terminates this Work as rejected.',
			inputSchema: TASK_SCOPE_RESULT_INPUT_SCHEMA,
			annotations: ACTIVITY_ANNOTATIONS,
		},
		(input): CallToolResult => isCrispyToolValidationFailure(input)
			? createTaskToolErrorResult('invalid_input')
			: handleTaskTool('scope-result', input),
	);
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

export function createTaskToolSuccessResult(requestId?: string): CallToolResult {
	return {
		content: [{
			type: 'text',
			text: JSON.stringify({
				ok: true,
				accepted: true,
				...(requestId === undefined ? {} : { requestId }),
			}),
		}],
	};
}

export function createTaskToolErrorResult(
	error: TaskToolErrorCode,
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
	taskCompatible = false,
): unknown {
	if (!Array.isArray(parsedBody)) {
		return normalizeRequestElement(
			parsedBody,
			agentActivityCompatible,
			taskCompatible,
		);
	}

	let normalizedBatch: unknown[] | undefined;
	for (let index = 0; index < parsedBody.length; index += 1) {
		const original = parsedBody[index];
		const normalized = normalizeRequestElement(
			original,
			agentActivityCompatible,
			taskCompatible,
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
	taskCompatible: boolean,
): unknown {
	if (!isJSONRPCRequest(value) || value.method !== 'tools/call') {
		return value;
	}
	const params = value.params;
	if (!isPlainRecord(params)) {
		return value;
	}
	const name = params.name;
	if (!isRecognizedToolName(name, agentActivityCompatible, taskCompatible)) {
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
	taskCompatible: boolean,
): boolean {
	return value === CRISPY_PING_TOOL_NAME
		|| (
			agentActivityCompatible
			&& (
				value === CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME
				|| value === CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME
			)
		)
		|| (
			taskCompatible
			&& (
				value === CRISPY_TASK_COMPLETE_TOOL_NAME
				|| value === CRISPY_TASK_SCOPE_REQUEST_TOOL_NAME
				|| value === CRISPY_TASK_SCOPE_RESULT_TOOL_NAME
			)
		);
}

function isTaskCompleteInputWithinByteLimits(value: unknown): boolean {
	return isPlainRecord(value)
		&& typeof value.summary === 'string'
		&& Buffer.byteLength(value.summary, 'utf8') <= TASK_TOOL_SUMMARY_MAX_UTF8_BYTES;
}

function isTaskScopeRequestInputWithinByteLimits(value: unknown): boolean {
	return isPlainRecord(value)
		&& typeof value.reason === 'string'
		&& Buffer.byteLength(value.reason, 'utf8') <= TASK_TOOL_REASON_MAX_UTF8_BYTES
		&& Array.isArray(value.paths)
		&& new Set(value.paths).size === value.paths.length
		&& value.paths.every((path) => (
			typeof path === 'string'
			&& path.length > 0
			&& !path.includes('\0')
			&& Buffer.byteLength(path, 'utf8') <= TASK_TOOL_PATH_MAX_UTF8_BYTES
		));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
