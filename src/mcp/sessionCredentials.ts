import { randomBytes } from 'node:crypto';

/** Bearer token에 사용하는 최소 CSPRNG byte 수다. */
export const MCP_TOKEN_RANDOM_BYTES = 32;

/** Session route를 추측하기 어렵게 만드는 CSPRNG byte 수다. */
export const MCP_ROUTE_RANDOM_BYTES = 24;

/** C2 parent/child 경계가 한 MCP session을 등록할 때 전달할 memory-only 값이다. */
export interface McpSessionCredentials {
	readonly generation: string;
	readonly sessionId: string;
	readonly routeId: string;
	readonly token: string;
}

/** 결정적인 test에서만 대체할 수 있는 CSPRNG 경계다. */
export type McpRandomBytes = (size: number) => Buffer;

/**
 * Session별 route와 최소 256-bit bearer token을 생성한다.
 * 반환값은 persistence나 Webview 전송을 위한 형태가 아니며 process memory에만 둔다.
 */
export function createMcpSessionCredentials(
	generation: string,
	sessionId: string,
	random: McpRandomBytes = randomBytes,
): McpSessionCredentials {
	assertOpaqueId(generation);
	assertOpaqueId(sessionId);

	const routeId = random(MCP_ROUTE_RANDOM_BYTES).toString('base64url');
	const token = random(MCP_TOKEN_RANDOM_BYTES).toString('base64url');
	if (
		decodedBase64UrlLength(routeId) < MCP_ROUTE_RANDOM_BYTES
		|| decodedBase64UrlLength(token) < MCP_TOKEN_RANDOM_BYTES
	) {
		throw new Error('MCP credential generation failed.');
	}

	return Object.freeze({ generation, sessionId, routeId, token });
}

/** 외부 IPC validator가 생기기 전에도 core가 잘못된 credential을 수락하지 않게 한다. */
export function assertValidMcpSessionCredentials(
	credentials: McpSessionCredentials,
): void {
	assertOpaqueId(credentials.generation);
	assertOpaqueId(credentials.sessionId);
	if (!isValidMcpRouteId(credentials.routeId)) {
		throw new Error('MCP route registration failed.');
	}
	if (!isValidMcpBearerToken(credentials.token)) {
		throw new Error('MCP token registration failed.');
	}
}

/** Parent/child IPC identity에 공통으로 적용하는 길이와 문자 allowlist다. */
export function isValidMcpOpaqueId(value: unknown): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= 128
		&& /^[A-Za-z0-9._:-]+$/.test(value);
}

/** C1의 24-byte canonical base64url route 계약을 IPC에서도 재사용한다. */
export function isValidMcpRouteId(value: unknown): value is string {
	return typeof value === 'string'
		&& isCanonicalBase64Url(value)
		&& decodedBase64UrlLength(value) >= MCP_ROUTE_RANDOM_BYTES;
}

/** C1의 최소 256-bit canonical base64url bearer 계약을 IPC에서도 재사용한다. */
export function isValidMcpBearerToken(value: unknown): value is string {
	return typeof value === 'string'
		&& isCanonicalBase64Url(value)
		&& decodedBase64UrlLength(value) >= MCP_TOKEN_RANDOM_BYTES;
}

function assertOpaqueId(value: string): void {
	if (!isValidMcpOpaqueId(value)) {
		throw new Error('MCP session identity is invalid.');
	}
}

function isCanonicalBase64Url(value: string): boolean {
	return /^[A-Za-z0-9_-]+$/.test(value)
		&& Buffer.from(value, 'base64url').toString('base64url') === value;
}

function decodedBase64UrlLength(value: string): number {
	return Buffer.from(value, 'base64url').byteLength;
}
