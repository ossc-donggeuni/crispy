import {
	isValidMcpBearerToken,
	isValidMcpOpaqueId,
	isValidMcpRouteId,
} from './sessionCredentials';

export type HostToMcpChildMessage =
	| {
		readonly type: 'auth.register';
		readonly requestId: string;
		readonly generation: string;
		readonly sessionId: string;
		readonly routeId: string;
		readonly token: string;
	}
	| {
		readonly type: 'auth.revoke';
		readonly requestId: string;
		readonly generation: string;
		readonly sessionId: string;
	}
	| {
		readonly type: 'server.shutdown';
		readonly requestId: string;
		readonly generation: string;
	};

export const MCP_CHILD_OPERATION_FAILURE_REASONS = Object.freeze([
	'server_start_failed',
	'invalid_message',
	'auth_registration_failed',
	'auth_revoke_failed',
	'shutdown_failed',
] as const);

export type McpChildOperationFailureReason =
	typeof MCP_CHILD_OPERATION_FAILURE_REASONS[number];

export type McpChildToHostMessage =
	| {
		readonly type: 'server.ready';
		readonly generation: string;
		readonly port: number;
	}
	| {
		readonly type: 'auth.registered';
		readonly requestId: string;
		readonly generation: string;
		readonly sessionId: string;
	}
	| {
		readonly type: 'auth.revoked';
		readonly requestId: string;
		readonly generation: string;
		readonly sessionId: string;
	}
	| {
		readonly type: 'session.mcpActivityObserved';
		readonly generation: string;
		readonly sessionId: string;
	}
	| {
		readonly type: 'session.crispyPingObserved';
		readonly generation: string;
		readonly sessionId: string;
	}
	| {
		readonly type: 'operation.failed';
		readonly requestId?: string;
		readonly generation: string;
		readonly sessionId?: string;
		readonly reason: McpChildOperationFailureReason;
	};

export type McpIpcValidationErrorCode =
	| 'invalid_message'
	| 'missing_field'
	| 'unknown_type'
	| 'invalid_field'
	| 'unexpected_field';

export interface McpIpcValidationError {
	readonly code: McpIpcValidationErrorCode;
	readonly field?: string;
}

export type McpIpcParseResult<Message> =
	| { readonly ok: true; readonly value: Message }
	| { readonly ok: false; readonly error: McpIpcValidationError };

type FieldValidator = (value: unknown) => boolean;
type MessageFields = Readonly<Record<string, {
	readonly validate: FieldValidator;
	readonly optional?: true;
}>>;
type MessageRegistry = Readonly<Record<string, MessageFields>>;

const id = field(isValidMcpOpaqueId);
const route = field(isValidMcpRouteId);
const token = field(isValidMcpBearerToken);
const port = field((value) => Number.isSafeInteger(value)
	&& Number(value) >= 1
	&& Number(value) <= 65535);
const failureReason = field((value) => typeof value === 'string'
	&& (MCP_CHILD_OPERATION_FAILURE_REASONS as readonly string[]).includes(value));

const HOST_TO_CHILD_SCHEMAS = registry({
	'auth.register': {
		requestId: id,
		generation: id,
		sessionId: id,
		routeId: route,
		token,
	},
	'auth.revoke': {
		requestId: id,
		generation: id,
		sessionId: id,
	},
	'server.shutdown': {
		requestId: id,
		generation: id,
	},
});

const CHILD_TO_HOST_SCHEMAS = registry({
	'server.ready': {
		generation: id,
		port,
	},
	'auth.registered': {
		requestId: id,
		generation: id,
		sessionId: id,
	},
	'auth.revoked': {
		requestId: id,
		generation: id,
		sessionId: id,
	},
	'session.mcpActivityObserved': {
		generation: id,
		sessionId: id,
	},
	'session.crispyPingObserved': {
		generation: id,
		sessionId: id,
	},
	'operation.failed': {
		requestId: optional(id),
		generation: id,
		sessionId: optional(id),
		reason: failureReason,
	},
});

/** Dedicated IPC channel에서 child가 받는 unknown payload를 exact schema로 복사한다. */
export function parseHostToMcpChildMessage(
	value: unknown,
): McpIpcParseResult<HostToMcpChildMessage> {
	return parseMessage(
		value,
		HOST_TO_CHILD_SCHEMAS,
	) as McpIpcParseResult<HostToMcpChildMessage>;
}

/** Dedicated IPC channel에서 Host가 받는 unknown payload를 exact schema로 복사한다. */
export function parseMcpChildToHostMessage(
	value: unknown,
): McpIpcParseResult<McpChildToHostMessage> {
	return parseMessage(
		value,
		CHILD_TO_HOST_SCHEMAS,
	) as McpIpcParseResult<McpChildToHostMessage>;
}

function parseMessage(
	value: unknown,
	schemas: MessageRegistry,
): McpIpcParseResult<Record<string, unknown>> {
	if (!isRecord(value)) {
		return failure('invalid_message');
	}
	if (!Object.hasOwn(value, 'type')) {
		return failure('missing_field', 'type');
	}
	if (typeof value.type !== 'string') {
		return failure('invalid_field', 'type');
	}
	if (!Object.hasOwn(schemas, value.type)) {
		return failure('unknown_type', 'type');
	}

	const fields = schemas[value.type];
	for (const [name, schema] of Object.entries(fields)) {
		if (!Object.hasOwn(value, name) && schema.optional !== true) {
			return failure('missing_field', name);
		}
	}
	for (const name of Object.getOwnPropertyNames(value)) {
		if (name !== 'type' && !Object.hasOwn(fields, name)) {
			return failure('unexpected_field', name);
		}
	}

	const parsed: Record<string, unknown> = { type: value.type };
	for (const [name, schema] of Object.entries(fields)) {
		if (!Object.hasOwn(value, name) && schema.optional === true) {
			continue;
		}
		if (!schema.validate(value[name])) {
			return failure('invalid_field', name);
		}
		parsed[name] = value[name];
	}
	return { ok: true, value: Object.freeze(parsed) };
}

function field(validate: FieldValidator): MessageFields[string] {
	return Object.freeze({ validate });
}

function optional(schema: MessageFields[string]): MessageFields[string] {
	return Object.freeze({ ...schema, optional: true });
}

function registry<const Registry extends MessageRegistry>(
	value: Registry,
): Registry {
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(
	code: McpIpcValidationErrorCode,
	fieldName?: string,
): McpIpcParseResult<never> {
	return {
		ok: false,
		error: Object.freeze({
			code,
			...(fieldName === undefined ? {} : { field: fieldName }),
		}),
	};
}
