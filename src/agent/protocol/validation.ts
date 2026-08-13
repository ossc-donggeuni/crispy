/** Runtime message validation이 외부에 노출하는 안정적인 오류 code union이다. */
export type MessageValidationErrorCode =
	| 'invalid_message'
	| 'unknown_type'
	| 'missing_field'
	| 'unexpected_field'
	| 'forbidden_field'
	| 'invalid_field'
	| 'value_out_of_range'
	| 'provider_not_allowed';

/**
 * Payload 값을 반사하지 않는 구조화된 validation 오류다.
 * `message`에는 고정 문구와 문제 필드 이름만 포함한다.
 */
export interface MessageValidationError {
	code: MessageValidationErrorCode;
	message: string;
	field?: string;
}

/**
 * Runtime parser의 성공 또는 실패를 `ok`로 구분하는 결과 타입이다.
 *
 * @typeParam Message 검증 성공 시 반환할 메시지 타입
 */
export type MessageParseResult<Message> =
	| { ok: true; value: Message }
	| { ok: false; error: MessageValidationError };

/**
 * 검증된 값을 성공 결과로 감싼다.
 *
 * @typeParam Value 검증된 값 타입
 * @param value schema 검증을 통과한 값
 * @returns `ok: true`와 검증된 값을 담은 결과
 */
export function validationSuccess<Value>(
	value: Value,
): MessageParseResult<Value> {
	return { ok: true, value };
}

/**
 * 원본 payload 값을 포함하지 않는 실패 결과를 생성한다.
 *
 * @param code 실패 원인을 구분하는 안정적인 validation 오류 code
 * @param field 문제가 발생한 필드 이름. 메시지 자체 오류면 생략한다.
 * @returns 고정 문구만 사용하는 `ok: false` 결과
 */
export function validationFailure(
	code: MessageValidationErrorCode,
	field?: string,
): MessageParseResult<never> {
	const message = field === undefined
		? 'Invalid message.'
		: `Invalid field '${field}'.`;

	return {
		ok: false,
		error: {
			code,
			message,
			...(field === undefined ? {} : { field }),
		},
	};
}
