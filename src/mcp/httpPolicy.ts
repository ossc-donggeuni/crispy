import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { TextDecoder } from 'node:util';

export const MCP_LOOPBACK_HOST = '127.0.0.1';
export const MCP_REQUEST_BODY_MAX_BYTES = 64 * 1024;
export const MCP_HTTP_MAX_CONNECTIONS = 96;
export const MCP_HTTP_HEADERS_TIMEOUT_MS = 5_000;
export const MCP_HTTP_REQUEST_TIMEOUT_MS = 15_000;
export const MCP_HTTP_KEEP_ALIVE_TIMEOUT_MS = 5_000;
export const MCP_HTTP_KEEP_ALIVE_TIMEOUT_BUFFER_MS = 0;
export const MCP_HTTP_MAX_REQUESTS_PER_SOCKET = 256;
export const MCP_AUTHENTICATED_IN_FLIGHT_PER_REGISTRATION = 64;
export const MCP_TOO_MANY_REQUESTS_BODY = '{"error":"too_many_requests"}';

export type McpBodyReadResult =
	| { readonly ok: true; readonly parsedBody: unknown }
	| {
		readonly ok: false;
		readonly status: 400 | 413;
		readonly closeConnection?: true;
	};

/** application/json과 선택적인 UTF-8 charset 하나만 허용한다. */
export function isAllowedMcpContentType(value: string | undefined): boolean {
	if (value === undefined) {
		return false;
	}
	return /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i
		.test(value);
}

/** 입력 길이에 관계없이 고정 길이 digest를 timingSafeEqual에 전달한다. */
export function matchesBearerToken(
	authorization: string | undefined,
	expectedToken: string,
): boolean {
	const prefix = 'Bearer ';
	const provided = authorization?.startsWith(prefix)
		? authorization.slice(prefix.length)
		: '';
	const expectedDigest = createHash('sha256').update(expectedToken, 'utf8').digest();
	const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
	return authorization !== undefined
		&& authorization.startsWith(prefix)
		&& provided.length > 0
		&& timingSafeEqual(expectedDigest, providedDigest);
}

/** SDK adapter에 넘기기 전에 raw Node stream에 실제 body 상한을 적용한다. */
export async function readBoundedJsonBody(
	request: IncomingMessage,
): Promise<McpBodyReadResult> {
	const declaredLength = parseContentLength(request.headers['content-length']);
	if (declaredLength === 'invalid') {
		request.pause();
		return { ok: false, status: 400, closeConnection: true };
	}
	if (declaredLength !== undefined && declaredLength > MCP_REQUEST_BODY_MAX_BYTES) {
		request.pause();
		return { ok: false, status: 413, closeConnection: true };
	}

	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let length = 0;
		let settled = false;

		const finish = (result: McpBodyReadResult, pause = false): void => {
			if (settled) {
				return;
			}
			settled = true;
			request.off('data', onData);
			request.off('end', onEnd);
			request.off('error', onError);
			request.off('aborted', onAborted);
			if (pause) {
				request.pause();
			}
			resolve(result);
		};

		const onData = (rawChunk: Buffer | Uint8Array): void => {
			const chunk = Buffer.isBuffer(rawChunk)
				? rawChunk
				: Buffer.from(rawChunk);
			length += chunk.byteLength;
			if (length > MCP_REQUEST_BODY_MAX_BYTES) {
				finish({ ok: false, status: 413, closeConnection: true }, true);
				return;
			}
			chunks.push(chunk);
		};

		const onEnd = (): void => {
			try {
				const bodyText = new TextDecoder('utf-8', { fatal: true }).decode(
					Buffer.concat(chunks, length),
				);
				finish({
					ok: true,
					parsedBody: JSON.parse(bodyText) as unknown,
				});
			} catch {
				finish({ ok: false, status: 400 });
			}
		};

		const onError = (): void => finish({ ok: false, status: 400 });
		const onAborted = (): void => finish({ ok: false, status: 400 });

		request.on('data', onData);
		request.once('end', onEnd);
		request.once('error', onError);
		request.once('aborted', onAborted);
	});
}

export function writeSafeHttpResponse(
	response: ServerResponse,
	status: number,
	body: string,
	headers?: Readonly<Record<string, string>>,
): void {
	if (response.headersSent || response.destroyed) {
		return;
	}
	response.writeHead(status, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Content-Length': Buffer.byteLength(body, 'utf8'),
		...headers,
	});
	response.end(body);
}

export function writeTooManyRequestsResponse(response: ServerResponse): void {
	if (response.headersSent || response.destroyed) {
		return;
	}
	response.shouldKeepAlive = false;
	response.writeHead(429, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(MCP_TOO_MANY_REQUESTS_BODY, 'utf8'),
		Connection: 'close',
	});
	response.end(MCP_TOO_MANY_REQUESTS_BODY);
}

function parseContentLength(
	value: string | undefined,
): number | 'invalid' | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!/^(?:0|[1-9]\d*)$/.test(value)) {
		return 'invalid';
	}
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}
