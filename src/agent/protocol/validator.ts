import {
	HOST_TO_WEBVIEW_MESSAGE_SCHEMAS,
	WEBVIEW_TO_HOST_MESSAGE_SCHEMAS,
	parseMessageWithSchemaRegistry,
} from './schemas';
import type {
	HostToWebviewWireMessage,
	WebviewToHostWireMessage,
} from './messages';
import { retryabilityByFailureReason } from '../../mcp/failureReason';
import type {
	MessageParseResult,
	MessageValidationError,
	MessageValidationErrorCode,
} from './validation';

export type {
	MessageParseResult,
	MessageValidationError,
	MessageValidationErrorCode,
} from './validation';

/**
 * Webview가 지정할 수 없으며 Extension Host만 소유하는 실행 계약 필드다.
 * 일반적인 추가 필드와 보안 경계 위반을 구분하기 위해 별도 집합으로 관리한다.
 */
const WEBVIEW_FORBIDDEN_FIELDS = new Set([
	'cwd',
	'path',
	'uri',
	'fsPath',
	'workspaceRoot',
	'workspace',
	'root',
	'executable',
	'command',
	'args',
	'env',
	'pid',
	'pty',
	'providerPolicy',
	'providerConfig',
	'timeout',
	'limits',
	'token',
	'route',
	'port',
	'generation',
]);

/**
 * Webview에서 Host로 오는 unknown 값을 방향별 schema와 금지 필드 정책으로 검증한다.
 *
 * @param value Webview에서 수신한 검증 전 값
 * @returns 허용된 필드만 복사한 새 메시지 또는 구조화된 validation 오류
 */
export function parseWebviewToHostMessage(
	value: unknown,
): MessageParseResult<WebviewToHostWireMessage> {
	return parseMessageWithSchemaRegistry(
		value,
		WEBVIEW_TO_HOST_MESSAGE_SCHEMAS,
		WEBVIEW_FORBIDDEN_FIELDS,
	);
}

/**
 * Host에서 Webview로 오는 unknown 값을 방향별 schema로 검증한다.
 *
 * @param value Extension Host에서 수신한 검증 전 값
 * @returns 허용된 필드만 복사한 새 메시지 또는 구조화된 validation 오류
 */
export function parseHostToWebviewMessage(
	value: unknown,
): MessageParseResult<HostToWebviewWireMessage> {
	const parsed = parseMessageWithSchemaRegistry(
		value,
		HOST_TO_WEBVIEW_MESSAGE_SCHEMAS,
	);
	if (!parsed.ok || parsed.value.type !== 'mcp.statusChanged') {
		return parsed as MessageParseResult<HostToWebviewWireMessage>;
	}

	const message = parsed.value;
	if (message.status === 'connected') {
		return message.reason === undefined && message.retryable === undefined
			? parsed as MessageParseResult<HostToWebviewWireMessage>
			: conditionalMcpStatusFailure('reason');
	}
	if (
		message.reason === undefined
		|| message.retryable === undefined
		|| message.retryable !== retryabilityByFailureReason[message.reason]
	) {
		return conditionalMcpStatusFailure(
			message.reason === undefined ? 'reason' : 'retryable',
		);
	}

	return parsed as MessageParseResult<HostToWebviewWireMessage>;
}

/** MCP status의 교차 필드 오류를 payload 반사 없이 기존 validation 형태로 만든다. */
function conditionalMcpStatusFailure(
	field: 'reason' | 'retryable',
): MessageParseResult<HostToWebviewWireMessage> {
	return {
		ok: false,
		error: {
			code: 'invalid_field',
			message: 'Message field is invalid.',
			field,
		},
	};
}
