import {
	isJSONRPCRequest,
	isJSONRPCResultResponse,
	type JSONRPCRequest,
	type JSONRPCResultResponse,
} from '@modelcontextprotocol/server';

/** SDK response 복제본을 activity 판정에 사용할 때 허용하는 최대 크기다. */
export const MCP_ACTIVITY_RESPONSE_MAX_BYTES = 256 * 1024;

/**
 * 인증·route/current-generation 확인을 끝낸 요청의 SDK response가 정상 result인지 판정한다.
 * MCP method/params validation은 SDK가 담당하며 여기서는 SDK type guard와 request/response ID
 * 대응만 확인한다.
 */
export async function responseProvesMcpActivity(
	requestBody: unknown,
	response: Response,
): Promise<boolean> {
	if (
		response.status < 200
		|| response.status >= 300
		|| response.status === 202
		|| response.body === null
	) {
		cancelResponseBody(response.body);
		return false;
	}

	const mediaType = response.headers
		.get('content-type')
		?.split(';', 1)[0]
		?.trim()
		.toLowerCase();
	if (mediaType === 'application/json') {
		const bodyText = await readBoundedResponseText(response.body);
		return bodyText !== undefined
			&& hasMatchingSuccessResult(requestBody, parseJsonValue(bodyText));
	}
	if (mediaType === 'text/event-stream') {
		return streamProvesMcpActivity(requestBody, response.body);
	}

	cancelResponseBody(response.body);
	return false;
}

/** Exported separately so batch/error/tool-level-result semantics stay deterministic in unit tests. */
export function hasMatchingSuccessResult(
	requestBody: unknown,
	responseBodies: readonly unknown[],
): boolean {
	const requests = toArray(requestBody).filter(isJSONRPCRequest);
	if (requests.length === 0) {
		return false;
	}

	const successfulResponses = responseBodies
		.flatMap(toArray)
		.filter(isJSONRPCResultResponse);
	return requests.some((request) => successfulResponses.some(
		(response) => requestIdsEqual(request, response),
	));
}

function requestIdsEqual(
	request: JSONRPCRequest,
	response: JSONRPCResultResponse,
): boolean {
	return typeof request.id === typeof response.id && request.id === response.id;
}

function toArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [value];
}

function parseJsonValue(value: string): unknown[] {
	try {
		return [JSON.parse(value) as unknown];
	} catch {
		return [];
	}
}

async function readBoundedResponseText(
	body: ReadableStream<Uint8Array>,
): Promise<string | undefined> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let byteLength = 0;
	let bodyText = '';
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				bodyText += decoder.decode();
				return bodyText.length === 0 ? undefined : bodyText;
			}
			byteLength += chunk.value.byteLength;
			if (byteLength > MCP_ACTIVITY_RESPONSE_MAX_BYTES) {
				cancelReader(reader);
				return undefined;
			}
			bodyText += decoder.decode(chunk.value, { stream: true });
		}
	} catch {
		cancelReader(reader);
		return undefined;
	} finally {
		releaseReader(reader);
	}
}

/** Legacy SSE response를 event 단위로 읽고 matching result가 보이면 나머지 stream을 버린다. */
async function streamProvesMcpActivity(
	requestBody: unknown,
	body: ReadableStream<Uint8Array>,
): Promise<boolean> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8', { fatal: true });
	let byteLength = 0;
	let bufferedText = '';
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) {
				bufferedText += decoder.decode();
				return sseEventProvesMcpActivity(requestBody, bufferedText);
			}

			byteLength += chunk.value.byteLength;
			if (byteLength > MCP_ACTIVITY_RESPONSE_MAX_BYTES) {
				cancelReader(reader);
				return false;
			}
			bufferedText += decoder.decode(chunk.value, { stream: true });

			const parsed = takeCompleteSseEvents(bufferedText);
			bufferedText = parsed.remainder;
			if (parsed.events.some(
				(event) => sseEventProvesMcpActivity(requestBody, event),
			)) {
				cancelReader(reader);
				return true;
			}
		}
	} catch {
		cancelReader(reader);
		return false;
	} finally {
		releaseReader(reader);
	}
}

function takeCompleteSseEvents(value: string): {
	readonly events: readonly string[];
	readonly remainder: string;
} {
	const events: string[] = [];
	let remainder = value;
	while (true) {
		const separator = /\r?\n\r?\n/.exec(remainder);
		if (separator === null) {
			return { events, remainder };
		}
		events.push(remainder.slice(0, separator.index));
		remainder = remainder.slice(separator.index + separator[0].length);
	}
}

function sseEventProvesMcpActivity(
	requestBody: unknown,
	event: string,
): boolean {
	const data = event
		.split(/\r?\n/)
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trimStart())
		.join('\n');
	return data.length > 0
		&& data !== '[DONE]'
		&& hasMatchingSuccessResult(requestBody, parseJsonValue(data));
}

function cancelResponseBody(body: ReadableStream<Uint8Array> | null): void {
	if (body !== null) {
		void body.cancel().catch(() => undefined);
	}
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	void reader.cancel().catch(() => undefined);
}

function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
	try {
		reader.releaseLock();
	} catch {
		/** 이미 종료된 response 관찰 경계에서는 release 실패를 외부로 전파하지 않는다. */
	}
}
