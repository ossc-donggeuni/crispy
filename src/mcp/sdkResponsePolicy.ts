import {
	CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME,
	CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME,
} from './toolServer';

const FIXED_JSON_RPC_MESSAGES = new Map<number, string>([
	[-32700, 'Parse error'],
	[-32600, 'Invalid Request'],
	[-32601, 'Method not found'],
	[-32602, 'Invalid params'],
	[-32603, 'Internal error'],
]);

const FIXED_ACTIVITY_TOOL_NOT_FOUND_MESSAGES = new Set<string>([
	`Tool ${CRISPY_SET_AGENT_ACTIVITY_TOOL_NAME} not found`,
	`Tool ${CRISPY_CLEAR_AGENT_ACTIVITY_TOOL_NAME} not found`,
]);

interface SanitizedValue {
	readonly value: unknown;
	readonly changed: boolean;
}

/**
 * The pinned SDK owns protocol classification and codes. This public Response
 * boundary removes only free-form SDK/Zod/error detail before it reaches HTTP.
 */
export async function sanitizeMcpSdkResponse(response: Response): Promise<Response> {
	const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
	if (contentType.startsWith('text/event-stream')) {
		return sanitizeEventStreamResponse(response);
	}
	if (!contentType.startsWith('application/json')) {
		return response;
	}

	let originalBody: string;
	try {
		originalBody = await response.text();
	} catch {
		originalBody = fixedInternalErrorJson();
	}
	const sanitizedBody = sanitizeJsonText(originalBody);
	const headers = new Headers(response.headers);
	headers.delete('content-length');
	headers.set('content-length', String(Buffer.byteLength(sanitizedBody, 'utf8')));
	return new Response(sanitizedBody, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function sanitizeEventStreamResponse(response: Response): Response {
	if (response.body === null) {
		return response;
	}
	const decoder = new TextDecoder('utf-8', { fatal: true });
	const encoder = new TextEncoder();
	let pending = '';
	const transform = new TransformStream<Uint8Array, Uint8Array>({
		transform: (chunk, controller) => {
			pending += decoder.decode(chunk, { stream: true });
			let newlineIndex = pending.indexOf('\n');
			while (newlineIndex >= 0) {
				const line = pending.slice(0, newlineIndex + 1);
				pending = pending.slice(newlineIndex + 1);
				controller.enqueue(encoder.encode(sanitizeEventStreamLine(line)));
				newlineIndex = pending.indexOf('\n');
			}
		},
		flush: (controller) => {
			pending += decoder.decode();
			if (pending.length > 0) {
				controller.enqueue(encoder.encode(sanitizeEventStreamLine(pending)));
			}
		},
	});
	const headers = new Headers(response.headers);
	headers.delete('content-length');
	return new Response(response.body.pipeThrough(transform), {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function sanitizeEventStreamLine(rawLine: string): string {
	const hasNewline = rawLine.endsWith('\n');
	const withoutNewline = hasNewline ? rawLine.slice(0, -1) : rawLine;
	const hasCarriageReturn = withoutNewline.endsWith('\r');
	const line = hasCarriageReturn
		? withoutNewline.slice(0, -1)
		: withoutNewline;
	if (!line.startsWith('data:')) {
		return rawLine;
	}
	const prefix = line.startsWith('data: ') ? 'data: ' : 'data:';
	const data = line.slice(prefix.length);
	return `${prefix}${sanitizeJsonText(data)}${hasCarriageReturn ? '\r' : ''}${
		hasNewline ? '\n' : ''
	}`;
}

function sanitizeJsonText(body: string): string {
	try {
		const parsed = JSON.parse(body) as unknown;
		const sanitized = sanitizeJsonRpcValue(parsed);
		return sanitized.changed ? JSON.stringify(sanitized.value) : body;
	} catch {
		return fixedInternalErrorJson();
	}
}

function sanitizeJsonRpcValue(value: unknown): SanitizedValue {
	if (Array.isArray(value)) {
		let changed = false;
		const sanitized = value.map((item) => {
			const result = sanitizeJsonRpcValue(item);
			changed ||= result.changed;
			return result.value;
		});
		return changed ? { value: sanitized, changed: true } : { value, changed: false };
	}
	if (!isRecord(value) || !isRecord(value.error)) {
		return { value, changed: false };
	}

	const code = typeof value.error.code === 'number'
		&& Number.isSafeInteger(value.error.code)
		? value.error.code
		: -32603;
	const sanitized: Record<string, unknown> = {
		jsonrpc: '2.0',
	};
	if (Object.hasOwn(value, 'id')) {
		sanitized.id = value.id;
	}
	sanitized.error = {
		code,
		message: fixedJsonRpcErrorMessage(code, value.error.message),
	};
	return { value: sanitized, changed: true };
}

function fixedJsonRpcErrorMessage(code: number, originalMessage: unknown): string {
	if (
		code === -32602
		&& typeof originalMessage === 'string'
	) {
		if (FIXED_ACTIVITY_TOOL_NOT_FOUND_MESSAGES.has(originalMessage)) {
			return originalMessage;
		}
		if (originalMessage.startsWith('Tool ') && originalMessage.endsWith(' not found')) {
			return 'Tool not found';
		}
	}
	return FIXED_JSON_RPC_MESSAGES.get(code) ?? 'Request failed';
}

function fixedInternalErrorJson(): string {
	return JSON.stringify({
		jsonrpc: '2.0',
		id: null,
		error: { code: -32603, message: 'Internal error' },
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
