import { isValidMcpOpaqueId } from './sessionCredentials';

export const PATH_MAX_UTF8_BYTES = 4_096;
export const PATH_MAX_SEGMENTS = 256;
export const ACTIVITY_IPC_MAX_UTF8_BYTES = 8 * 1_024;

export const AGENT_ACTIVITY_KINDS = Object.freeze([
	'planned',
	'active',
	'editing',
	'completed',
	'mentioned',
	'rejected',
] as const);

export const AGENT_ACTIVITY_TARGET_KINDS = Object.freeze([
	'file',
	'folder',
] as const);

export type AgentActivityKind = typeof AGENT_ACTIVITY_KINDS[number];
export type AgentActivityTargetKind = typeof AGENT_ACTIVITY_TARGET_KINDS[number];

export type AgentActivityRequested =
	| {
		readonly type: 'session.agentActivityRequested';
		readonly sessionId: string;
		readonly generation: string;
		readonly operation: 'set';
		readonly path: string;
		readonly targetKind: AgentActivityTargetKind;
		readonly activity: AgentActivityKind;
	}
	| {
		readonly type: 'session.agentActivityRequested';
		readonly sessionId: string;
		readonly generation: string;
		readonly operation: 'clear';
		readonly path: string;
		readonly targetKind: AgentActivityTargetKind;
	};

export type AgentActivityPathResult =
	| { readonly ok: true; readonly path: string }
	| {
		readonly ok: false;
		readonly error: 'invalid_path' | 'payload_too_large';
	};

const URI_OR_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:/;
const POST_CANONICAL_DEVICE_PREFIX = /^(?:\?|\?\?)(?:\/|$)/;
const WINDOWS_RESERVED_DOS_DEVICE_BASENAME =
	/^(?:CON|PRN|AUX|NUL|CON(?:IN|OUT)\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i;

/**
 * Workspace-relative Tool paths are lexical data here. The Host repeats this
 * exact validation before any filesystem lookup in a later phase.
 */
export function normalizeAgentActivityPath(
	rawPath: string,
	targetKind: AgentActivityTargetKind,
	platform: NodeJS.Platform = process.platform,
): AgentActivityPathResult {
	if (Buffer.byteLength(rawPath, 'utf8') > PATH_MAX_UTF8_BYTES) {
		return pathFailure('payload_too_large');
	}
	if (
		rawPath.length === 0
		|| rawPath.includes('\0')
		|| hasUnpairedSurrogate(rawPath)
		|| hasAbsoluteOrSchemePrefix(rawPath)
	) {
		return pathFailure('invalid_path');
	}

	const segments: string[] = [];
	for (const segment of rawPath.replaceAll('\\', '/').split('/')) {
		if (segment.length === 0 || segment === '.') {
			continue;
		}
		if (segment === '..' || !isCanonicalSegment(segment)) {
			return pathFailure('invalid_path');
		}
		segments.push(segment);
	}
	if (
		platform === 'win32'
		&& segments.some(isWindowsReservedDosDeviceSegment)
	) {
		return pathFailure('invalid_path');
	}

	if (segments.length > PATH_MAX_SEGMENTS) {
		return pathFailure('payload_too_large');
	}
	const canonicalPath = segments.length === 0 ? '.' : segments.join('/');
	if (
		hasAbsoluteOrSchemePrefix(canonicalPath)
		|| POST_CANONICAL_DEVICE_PREFIX.test(canonicalPath)
	) {
		return pathFailure('invalid_path');
	}
	if (Buffer.byteLength(canonicalPath, 'utf8') > PATH_MAX_UTF8_BYTES) {
		return pathFailure('payload_too_large');
	}
	if (
		(canonicalPath === '.' && targetKind !== 'folder')
		|| !isIdempotentCanonicalPath(canonicalPath)
	) {
		return pathFailure('invalid_path');
	}
	return { ok: true, path: canonicalPath };
}

export function createSetAgentActivityRequested(input: Readonly<{
	sessionId: string;
	generation: string;
	path: string;
	targetKind: AgentActivityTargetKind;
	activity: AgentActivityKind;
}>): AgentActivityRequested {
	return Object.freeze({
		type: 'session.agentActivityRequested',
		sessionId: input.sessionId,
		generation: input.generation,
		operation: 'set',
		path: input.path,
		targetKind: input.targetKind,
		activity: input.activity,
	});
}

export function createClearAgentActivityRequested(input: Readonly<{
	sessionId: string;
	generation: string;
	path: string;
	targetKind: AgentActivityTargetKind;
}>): AgentActivityRequested {
	return Object.freeze({
		type: 'session.agentActivityRequested',
		sessionId: input.sessionId,
		generation: input.generation,
		operation: 'clear',
		path: input.path,
		targetKind: input.targetKind,
	});
}

export function isAgentActivityKind(value: unknown): value is AgentActivityKind {
	return typeof value === 'string'
		&& (AGENT_ACTIVITY_KINDS as readonly string[]).includes(value);
}

export function isAgentActivityTargetKind(
	value: unknown,
): value is AgentActivityTargetKind {
	return typeof value === 'string'
		&& (AGENT_ACTIVITY_TARGET_KINDS as readonly string[]).includes(value);
}

/** Parser-side field check only; the Host still repeats lexical validation. */
export function isCanonicalAgentActivityPath(
	value: unknown,
	targetKind: unknown,
	platform: NodeJS.Platform = process.platform,
): value is string {
	if (typeof value !== 'string' || !isAgentActivityTargetKind(targetKind)) {
		return false;
	}
	const normalized = normalizeAgentActivityPath(value, targetKind, platform);
	return normalized.ok && normalized.path === value;
}

export function isValidAgentActivityRequestedIdentity(
	event: AgentActivityRequested,
): boolean {
	return isValidMcpOpaqueId(event.sessionId)
		&& isValidMcpOpaqueId(event.generation);
}

function hasAbsoluteOrSchemePrefix(value: string): boolean {
	return value.startsWith('/')
		|| value.startsWith('\\')
		|| WINDOWS_DRIVE_PREFIX.test(value)
		|| URI_OR_SCHEME_PREFIX.test(value);
}

function isCanonicalSegment(segment: string): boolean {
	return segment.length > 0
		&& segment !== '.'
		&& segment !== '..'
		&& !segment.includes('/')
		&& !segment.includes('\\')
		&& !segment.includes('\0')
		&& !hasUnpairedSurrogate(segment);
}

/**
 * Win32는 DOS device basename을 모든 directory component에서 case-insensitive하게
 * 해석한다. Extension, stream suffix와 Win32가 제거하는 trailing space도 device
 * identity를 바꾸지 않으므로 path를 보정하지 않고 전체 입력을 거부한다.
 */
function isWindowsReservedDosDeviceSegment(segment: string): boolean {
	const extensionIndex = segment.search(/[.:]/u);
	const basename = (
		extensionIndex < 0 ? segment : segment.slice(0, extensionIndex)
	).replace(/ +$/u, '');
	return WINDOWS_RESERVED_DOS_DEVICE_BASENAME.test(basename);
}

function isIdempotentCanonicalPath(value: string): boolean {
	if (value === '.') {
		return true;
	}
	const segments = value.split('/');
	return segments.length <= PATH_MAX_SEGMENTS
		&& segments.every(isCanonicalSegment)
		&& segments.join('/') === value;
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xD800 && code <= 0xDBFF) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xDC00 || next > 0xDFFF) {
				return true;
			}
			index += 1;
		} else if (code >= 0xDC00 && code <= 0xDFFF) {
			return true;
		}
	}
	return false;
}

function pathFailure(
	error: 'invalid_path' | 'payload_too_large',
): AgentActivityPathResult {
	return Object.freeze({ ok: false, error });
}
