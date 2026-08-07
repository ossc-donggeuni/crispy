/** app-server stdout에서 들어온 unknown JSON의 envelope와 initialize 응답을 검증하는 모듈이다. */

import type { InitializeResponse } from './generated/InitializeResponse';
import type { RequestId } from './generated/RequestId';

/** app-server 오류 응답의 JSON-RPC 오류 정보다. */
export interface CodexRpcErrorPayload {
	/** JSON-RPC 또는 app-server가 지정한 숫자 오류 코드다. */
	code: number;
	/** 사용자가 아닌 protocol 소비자에게 전달되는 오류 설명이다. */
	message: string;
	/** 오류에 딸린 추가 정보이며 없으면 존재하지 않는다. */
	data?: unknown;
}

/** 분류된 모든 inbound 메시지가 원본 JSON 객체를 보존하기 위한 공통 계약이다. */
interface CodexInboundMessageBase {
	/** runtime validation을 통과한 수정되지 않은 JSON 객체다. */
	value: Readonly<Record<string, unknown>>;
}

/** app-server가 Host 요청 ID에 성공 결과를 돌려준 메시지다. */
export interface CodexSuccessfulResponse extends CodexInboundMessageBase {
	/** 메시지 분류 discriminator다. */
	kind: 'response';
	/** Host 요청과 연결되는 ID다. */
	id: RequestId;
	/** method별 응답 validator가 이후 검증할 원본 결과다. */
	result: unknown;
}

/** app-server가 Host 요청 ID에 오류를 돌려준 메시지다. */
export interface CodexErrorResponse extends CodexInboundMessageBase {
	/** 메시지 분류 discriminator다. */
	kind: 'errorResponse';
	/** Host 요청과 연결되는 ID다. */
	id: RequestId;
	/** 검증된 JSON-RPC 오류 정보다. */
	error: CodexRpcErrorPayload;
}

/** app-server가 Host에 응답을 요구하며 보낸 역방향 요청이다. */
export interface CodexServerRequestMessage extends CodexInboundMessageBase {
	/** 메시지 분류 discriminator다. */
	kind: 'request';
	/** Host 응답에 그대로 사용할 요청 ID다. */
	id: RequestId;
	/** 알 수 없는 값도 보존하는 원본 protocol method다. */
	method: string;
	/** method별 handler가 이후 검증할 원본 params다. */
	params?: unknown;
}

/** app-server가 응답을 요구하지 않고 Host에 보낸 알림이다. */
export interface CodexServerNotificationMessage extends CodexInboundMessageBase {
	/** 메시지 분류 discriminator다. */
	kind: 'notification';
	/** 알 수 없는 값도 보존하는 원본 protocol method다. */
	method: string;
	/** method별 handler가 이후 검증할 원본 params다. */
	params?: unknown;
}

/** stdout JSONL에서 허용하는 app-server 메시지 분기다. */
export type CodexInboundMessage = CodexSuccessfulResponse
	| CodexErrorResponse
	| CodexServerRequestMessage
	| CodexServerNotificationMessage;

/** 외부 JSON 메시지의 runtime validation 결과다. */
export type CodexInboundValidationResult = {
	valid: true;
	message: CodexInboundMessage;
} | {
	valid: false;
	error: string;
};

/**
 * JSON.parse 결과가 app-server의 request, notification 또는 response envelope인지 검사한다.
 * 알려지지 않은 method와 추가 field는 호환성을 위해 허용하고 원본 객체에 보존한다.
 *
 * @param value stdout JSONL 한 줄을 JSON.parse한 값
 * @returns 분류된 메시지 또는 거부 이유
 */
export function validateCodexInboundMessage(value: unknown): CodexInboundValidationResult {
	if (!isRecord(value)) {
		return invalid('app-server 메시지는 JSON 객체여야 합니다.');
	}

	const hasMethod = Object.hasOwn(value, 'method');
	const hasId = Object.hasOwn(value, 'id');
	if (hasMethod) {
		if (typeof value.method !== 'string' || value.method.length === 0) {
			return invalid('method는 비어 있지 않은 문자열이어야 합니다.');
		}
		if (!hasId) {
			return {
				valid: true,
				message: {
					kind: 'notification',
					method: value.method,
					params: value.params,
					value,
				},
			};
		}
		if (!isRequestId(value.id)) {
			return invalid('요청 id는 문자열 또는 숫자여야 합니다.');
		}
		return {
			valid: true,
			message: {
				kind: 'request',
				id: value.id,
				method: value.method,
				params: value.params,
				value,
			},
		};
	}

	if (!hasId || !isRequestId(value.id)) {
		return invalid('응답은 문자열 또는 숫자 id를 포함해야 합니다.');
	}

	const hasResult = Object.hasOwn(value, 'result');
	const hasError = Object.hasOwn(value, 'error');
	if (hasResult === hasError) {
		return invalid('응답은 result 또는 error 중 정확히 하나를 포함해야 합니다.');
	}
	if (hasResult) {
		return {
			valid: true,
			message: {
				kind: 'response',
				id: value.id,
				result: value.result,
				value,
			},
		};
	}
	if (!isRpcErrorPayload(value.error)) {
		return invalid('error 응답은 숫자 code와 문자열 message를 포함해야 합니다.');
	}
	return {
		valid: true,
		message: {
			kind: 'errorResponse',
			id: value.id,
			error: value.error,
			value,
		},
	};
}

/** initialize 결과가 현재 생성된 InitializeResponse의 필수 필드를 만족하는지 검사한다. */
export function isInitializeResponse(value: unknown): value is InitializeResponse {
	return isRecord(value)
		&& typeof value.userAgent === 'string'
		&& typeof value.codexHome === 'string'
		&& typeof value.platformFamily === 'string'
		&& typeof value.platformOs === 'string';
}

/** unknown 값이 null이 아닌 일반 JSON 객체인지 검사한다. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** unknown 값이 생성된 RequestId 규격인지 검사한다. */
export function isRequestId(value: unknown): value is RequestId {
	return typeof value === 'string'
		|| (typeof value === 'number' && Number.isFinite(value));
}

/**
 * @param value error response의 payload 후보.
 * @returns 숫자 code와 문자열 message를 가진 JSON-RPC 오류인지 여부.
 */
function isRpcErrorPayload(value: unknown): value is CodexRpcErrorPayload {
	return isRecord(value)
		&& typeof value.code === 'number'
		&& Number.isFinite(value.code)
		&& typeof value.message === 'string';
}

/**
 * @param error 외부 envelope를 거부한 구체적인 이유.
 * @returns discriminator가 `valid: false`인 검증 실패 결과.
 */
function invalid(error: string): CodexInboundValidationResult {
	return { valid: false, error };
}
