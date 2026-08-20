import {
	isJSONRPCRequest,
	isJSONRPCResultResponse,
	type JSONRPCRequest,
	type JSONRPCResultResponse,
} from '@modelcontextprotocol/server';

/** SDK response 복제본을 activity 판정에 사용할 때 허용하는 최대 크기다. */
const MCP_ACTIVITY_RESPONSE_MAX_BYTES = 256 * 1024;

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
		return false;
	}

	let bodyText: string;
	try {
		bodyText = await response.clone().text();
	} catch {
		return false;
	}
	if (
		bodyText.length === 0
		|| Buffer.byteLength(bodyText, 'utf8') > MCP_ACTIVITY_RESPONSE_MAX_BYTES
	) {
		return false;
	}

	const responseBodies = parseResponseBodies(
		response.headers.get('content-type'),
		bodyText,
	);
	return hasMatchingSuccessResult(requestBody, responseBodies);
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

function parseResponseBodies(
	contentType: string | null,
	bodyText: string,
): unknown[] {
	const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase();
	if (mediaType === 'application/json') {
		return parseJsonValue(bodyText);
	}
	if (mediaType === 'text/event-stream') {
		return parseSseData(bodyText);
	}
	return [];
}

function parseJsonValue(value: string): unknown[] {
	try {
		return [JSON.parse(value) as unknown];
	} catch {
		return [];
	}
}

/** SDK가 legacy request에 SSE response를 선택하는 경우의 data framing만 해제한다. */
function parseSseData(value: string): unknown[] {
	const parsed: unknown[] = [];
	for (const event of value.split(/\r?\n\r?\n/)) {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trimStart())
			.join('\n');
		if (data.length > 0 && data !== '[DONE]') {
			parsed.push(...parseJsonValue(data));
		}
	}
	return parsed;
}
