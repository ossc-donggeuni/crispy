import {
	TERMINAL_ERROR_CODES,
	WORKSPACE_EXECUTION_ERROR_CODES,
} from './errors';
import { PROVIDER_IDS } from './providers';
import { MCP_FAILURE_REASONS } from '../../mcp/failureReason';
import {
	ID_MAX_LENGTH,
	ID_PATTERN,
	TERMINAL_COLS_MAX,
	TERMINAL_COLS_MIN,
	TERMINAL_INPUT_MAX_BYTES,
	TERMINAL_ROWS_MAX,
	TERMINAL_ROWS_MIN,
} from './limits';
import {
	validationFailure,
	validationSuccess,
	type MessageParseResult,
	type MessageValidationErrorCode,
} from './validation';
import {
	validateWorkspaceRootId,
	type WorkspaceRootId,
} from '../../workspace/workspaceRootId';

/**
 * unknown 필드 값을 특정 protocol 값으로 변환하는 runtime schema다.
 *
 * @typeParam Value 검증 성공 시 반환할 필드 값 타입
 */
interface FieldSchema<Value> {
	/** true이면 wire message에서 이 필드를 생략할 수 있다. */
	readonly optional?: true;

	/**
	 * 필드 값을 검증한다.
	 *
	 * @param value 외부에서 수신한 검증 전 값
	 * @param field 오류에 표시할 필드 이름
	 * @returns 검증된 필드 값 또는 payload를 반사하지 않는 오류
	 */
	parse(value: unknown, field: string): MessageParseResult<Value>;
}

/** 한 메시지 type에 필요한 필드 이름과 schema의 읽기 전용 매핑이다. */
type FieldSchemaMap = Readonly<Record<string, FieldSchema<unknown>>>;

/** 메시지 type과 해당 필드 schema를 연결하는 방향별 runtime registry다. */
type MessageSchemaRegistry = Readonly<Record<string, FieldSchemaMap>>;

/** FieldSchema의 검증 성공 값 타입을 추출한다. */
type InferFieldSchema<Schema> = Schema extends FieldSchema<infer Value>
	? Value
	: never;

/** 필드 schema map을 검증 완료 메시지의 필드 타입으로 변환한다. */
type InferFields<Schemas extends FieldSchemaMap> = {
	-readonly [Field in keyof Schemas as Schemas[Field] extends { readonly optional: true }
		? never
		: Field]: InferFieldSchema<Schemas[Field]>;
} & {
	-readonly [Field in keyof Schemas as Schemas[Field] extends { readonly optional: true }
		? Field
		: never]?: InferFieldSchema<Schemas[Field]>;
};

/**
 * Schema registry의 key와 필드 parser로부터 discriminated wire-message union을 만든다.
 *
 * @typeParam Registry 메시지 type별 필드 schema registry
 */
export type InferMessageSchemaRegistry<Registry extends MessageSchemaRegistry> = {
	[Type in keyof Registry & string]: { type: Type } & InferFields<Registry[Type]>;
}[keyof Registry & string];

/** tabId와 sessionId가 공통 ID 형식 및 최대 길이를 만족하는지 검증한다. */
const idSchema = defineFieldSchema<string>((value, field) => {
	if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
		return validationFailure('invalid_field', field);
	}
	if (value.length > ID_MAX_LENGTH) {
		return validationFailure('value_out_of_range', field);
	}

	return validationSuccess(value);
});

/** Host가 전송한 terminal.error code가 공개 오류 code allowlist에 있는지 검증한다. */
const terminalErrorCodeSchema = stringAllowlistSchema(
	TERMINAL_ERROR_CODES,
	'invalid_field',
);
/**
 * Webview가 지정한 provider 식별자가 protocol allowlist에 있는지 검증한다.
 * allowlist 밖의 값은 별도 code로 구분해 Host가 실행 정책을 찾기 전에 거부한다.
 */
const providerIdSchema = stringAllowlistSchema(
	PROVIDER_IDS,
	'provider_not_allowed',
);
/** Workspace ID는 URI payload 길이를 제한하지 않고 공용 leaf validator를 사용한다. */
const workspaceRootIdSchema = defineFieldSchema<WorkspaceRootId>((value, field) => {
	const result = validateWorkspaceRootId(value);

	return result.ok
		? validationSuccess(result.value)
		: validationFailure('invalid_field', field);
});
/** switch attempt와 assignment revision은 ordering 가능한 양의 safe integer다. */
const orderingRevisionSchema = defineFieldSchema<number>((value, field) => {
	if (
		typeof value !== 'number'
		|| !Number.isSafeInteger(value)
		|| value < 1
	) {
		return validationFailure('invalid_field', field);
	}

	return validationSuccess(value);
});
const workspaceExecutionErrorCodeSchema = stringAllowlistSchema(
	WORKSPACE_EXECUTION_ERROR_CODES,
	'invalid_field',
);
/** MCP 실패 reason은 공유 domain allowlist에서만 가져온다. */
const mcpFailureReasonSchema = stringAllowlistSchema(
	MCP_FAILURE_REASONS,
	'invalid_field',
);
const mcpVisibleStatusSchema = stringAllowlistSchema(
	['connected', 'failed'] as const,
	'invalid_field',
);

/** Terminal 열 수가 protocol 범위 안의 정수인지 검증한다. */
const colsSchema = integerRangeSchema(TERMINAL_COLS_MIN, TERMINAL_COLS_MAX);

/** Terminal 행 수가 protocol 범위 안의 정수인지 검증한다. */
const rowsSchema = integerRangeSchema(TERMINAL_ROWS_MIN, TERMINAL_ROWS_MAX);

/** Terminal 입력이 문자열이며 UTF-8 byte 제한 안인지 검증한다. */
const inputSchema = limitedUtf8StringSchema(TERMINAL_INPUT_MAX_BYTES);

/** 일반 문자열 필드를 검증한다. */
const stringSchema = defineFieldSchema<string>((value, field) => {
	if (typeof value !== 'string') {
		return validationFailure('invalid_field', field);
	}

	return validationSuccess(value);
});
/** boolean 필드를 검증한다. */
const booleanSchema = defineFieldSchema<boolean>((value, field) => {
	if (typeof value !== 'boolean') {
		return validationFailure('invalid_field', field);
	}

	return validationSuccess(value);
});
/** exitCode와 signal에 사용하는 유한 number schema다. */
const numberSchema = defineFieldSchema<number>((value, field) => {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return validationFailure('invalid_field', field);
	}

	return validationSuccess(value);
});
/** terminal.error가 session 생성 전에도 전송될 수 있도록 null을 허용하는 ID schema다. */
const nullableIdSchema = nullableSchema(idSchema);

/**
 * Webview→Host 전체 wire 계약의 단일 runtime schema registry다.
 *
 * Registry key가 알려진 message type allowlist가 되며 각 값의 key가 해당
 * 메시지에 허용되는 정확한 필드 집합이 된다. TypeScript 메시지 union도 이
 * 값에서 추론하므로 type 목록과 validator를 별도로 동기화하지 않는다.
 */
export const WEBVIEW_TO_HOST_MESSAGE_SCHEMAS = defineMessageSchemaRegistry({
	'webview.ready': {},
	'terminal.ready': {
		tabId: idSchema,
		cols: colsSchema,
		rows: rowsSchema,
	},
	'terminal.input': {
		tabId: idSchema,
		sessionId: idSchema,
		data: inputSchema,
	},
	'terminal.resize': {
		tabId: idSchema,
		sessionId: idSchema,
		cols: colsSchema,
		rows: rowsSchema,
	},
	/** Webview는 실행 계약도 terminal 크기도 다시 보내지 않고 소유 관계만 지정한다. */
	'terminal.restart': {
		tabId: idSchema,
		sessionId: idSchema,
	},
	/** 실행 계약과 retry 판단은 Host가 소유하고 Webview는 현재 소유 관계만 보낸다. */
	'mcp.restart': {
		tabId: idSchema,
		sessionId: idSchema,
	},
	'terminal.visible': {
		tabId: idSchema,
		visible: booleanSchema,
	},
	/** tabId는 Webview가 소유하므로 생성 시점에도 Host가 값을 지정하지 않는다. */
	'tab.create': {
		tabId: idSchema,
	},
	'tab.switch': {
		tabId: idSchema,
	},
	'tab.close': {
		tabId: idSchema,
	},
	/**
	 * provider 선택과 재시작을 함께 나타내며 실행 파일, 인자와 환경은 포함하지 않는다.
	 * 실행 계약은 Host가 providerId로 자신의 registry에서 다시 결정한다.
	 */
	'agent.switch': {
		tabId: idSchema,
		providerId: providerIdSchema,
		workspaceRootId: workspaceRootIdSchema,
		switchAttemptId: orderingRevisionSchema,
	},
	/** 현재 탭은 유지하면서 provider와 실행 중 CLI를 초기화한다. */
	'agent.reset': {
		tabId: idSchema,
	},
});

/**
 * Host→Webview 전체 wire 계약의 단일 runtime schema registry다.
 *
 * 각 필드 schema는 외부 값을 검증하는 동시에 성공 결과의 정적 타입을 제공한다.
 */
export const HOST_TO_WEBVIEW_MESSAGE_SCHEMAS = defineMessageSchemaRegistry({
	'extension.ready': {},
	'terminal.starting': {
		tabId: idSchema,
		sessionId: idSchema,
	},
	'agent.switchAccepted': {
		tabId: idSchema,
		providerId: providerIdSchema,
		workspaceRootId: workspaceRootIdSchema,
		switchAttemptId: orderingRevisionSchema,
		assignmentRevision: orderingRevisionSchema,
	},
	'agent.resetCompleted': {
		tabId: idSchema,
		assignmentRevision: orderingRevisionSchema,
	},
	'terminal.started': {
		tabId: idSchema,
		sessionId: idSchema,
	},
	'terminal.output': {
		tabId: idSchema,
		sessionId: idSchema,
		data: stringSchema,
	},
	'terminal.exited': {
		tabId: idSchema,
		sessionId: idSchema,
		exitCode: optionalFieldSchema(numberSchema),
		signal: optionalFieldSchema(numberSchema),
	},
	'terminal.error': {
		tabId: idSchema,
		sessionId: nullableIdSchema,
		code: terminalErrorCodeSchema,
		message: stringSchema,
		canRestart: booleanSchema,
		switchAttemptId: optionalFieldSchema(orderingRevisionSchema),
	},
	'terminal.cleanupFailed': {
		tabId: idSchema,
		sessionId: idSchema,
		message: stringSchema,
	},
	'mcp.statusChanged': {
		tabId: idSchema,
		sessionId: idSchema,
		status: mcpVisibleStatusSchema,
		reason: optionalFieldSchema(mcpFailureReasonSchema),
		retryable: optionalFieldSchema(booleanSchema),
	},
	'mcp.statusCleared': {
		tabId: idSchema,
		sessionId: idSchema,
	},
	'mcp.restartRejected': {
		tabId: idSchema,
		sessionId: idSchema,
		code: workspaceExecutionErrorCodeSchema,
		message: stringSchema,
	},
});

/**
 * unknown 값을 registry가 정의한 정확한 필드 집합으로 검증하고 새 객체로 복사한다.
 * 금지 필드는 일반적인 추가 필드보다 먼저 검사하여 보안 정책 위반을 구분한다.
 *
 * @typeParam Registry 방향별 메시지 schema registry 타입
 * @param value 외부에서 수신한 검증 전 메시지
 * @param registry 알려진 type과 필드 계약을 정의하는 registry
 * @param forbiddenFields 수신 방향에서 명시적으로 금지하는 필드 이름 집합
 * @returns 허용된 필드만 복사한 새 메시지 또는 구조화된 validation 오류
 */
export function parseMessageWithSchemaRegistry<
	const Registry extends MessageSchemaRegistry,
>(
	value: unknown,
	registry: Registry,
	forbiddenFields?: ReadonlySet<string>,
): MessageParseResult<InferMessageSchemaRegistry<Registry>> {
	if (!isMessageRecord(value)) {
		return validationFailure('invalid_message');
	}
	if (!hasOwn(value, 'type')) {
		return validationFailure('missing_field', 'type');
	}
	if (typeof value.type !== 'string') {
		return validationFailure('invalid_field', 'type');
	}
	if (!hasOwn(registry, value.type)) {
		return validationFailure('unknown_type', 'type');
	}

	if (forbiddenFields) {
		for (const field of Object.getOwnPropertyNames(value)) {
			if (forbiddenFields.has(field)) {
				return validationFailure('forbidden_field', field);
			}
		}
	}

	const type = value.type;
	const fieldSchemas = registry[type];
	for (const field of Object.keys(fieldSchemas)) {
		if (!hasOwn(value, field) && fieldSchemas[field].optional !== true) {
			return validationFailure('missing_field', field);
		}
	}

	for (const field of Object.getOwnPropertyNames(value)) {
		if (field !== 'type' && !hasOwn(fieldSchemas, field)) {
			return validationFailure('unexpected_field', field);
		}
	}

	const parsedMessage: Record<string, unknown> = { type };
	for (const [field, schema] of Object.entries(fieldSchemas)) {
		if (!hasOwn(value, field) && schema.optional === true) {
			continue;
		}
		const fieldResult = schema.parse(value[field], field);
		if (!fieldResult.ok) {
			return fieldResult;
		}
		parsedMessage[field] = fieldResult.value;
	}

	/** 모든 필드가 schema를 통과한 뒤 새 객체에 복사되었으므로 inferred union이다. */
	return validationSuccess(
		parsedMessage as InferMessageSchemaRegistry<Registry>,
	);
}

/**
 * Literal type과 필드 key를 보존하면서 메시지 schema registry를 정의한다.
 *
 * @typeParam Registry 전달된 registry의 literal 타입
 * @param registry 메시지 type별 필드 schema 선언
 * @returns 타입이 넓혀지지 않은 동일 registry
 */
function defineMessageSchemaRegistry<
	const Registry extends MessageSchemaRegistry,
>(registry: Registry): Registry {
	return registry;
}

/**
 * 필드 parser를 타입 추론 가능한 FieldSchema로 감싼다.
 *
 * @typeParam Value 검증 성공 값 타입
 * @param parse unknown 필드 값을 검증하는 함수
 * @returns 메시지 registry에서 재사용할 필드 schema
 */
function defineFieldSchema<Value>(
	parse: FieldSchema<Value>['parse'],
): FieldSchema<Value> {
	return { parse };
}

/** 기존 field schema를 wire message에서 생략 가능한 schema로 표시한다. */
function optionalFieldSchema<Value>(
	schema: FieldSchema<Value>,
): FieldSchema<Value> & { readonly optional: true } {
	return { ...schema, optional: true };
}

/**
 * 주어진 폐구간 안의 정수만 허용하는 필드 schema를 만든다.
 *
 * @param minimum 허용할 최솟값
 * @param maximum 허용할 최댓값
 * @returns 정수 타입과 범위를 검증하는 필드 schema
 */
function integerRangeSchema(
	minimum: number,
	maximum: number,
): FieldSchema<number> {
	return defineFieldSchema((value, field) => {
		if (typeof value !== 'number' || !Number.isInteger(value)) {
			return validationFailure('invalid_field', field);
		}
		if (value < minimum || value > maximum) {
			return validationFailure('value_out_of_range', field);
		}

		return validationSuccess(value);
	});
}

/**
 * 공유 상수에 선언된 문자열만 허용하는 allowlist schema를 만든다.
 *
 * @typeParam Values 허용 문자열 tuple 타입
 * @param values 허용할 문자열 목록
 * @param unknownValueCode 문자열이 allowlist 밖일 때 사용할 오류 code
 * @returns allowlist 원소 union을 성공 값으로 반환하는 필드 schema
 */
function stringAllowlistSchema<const Values extends readonly string[]>(
	values: Values,
	unknownValueCode: MessageValidationErrorCode,
): FieldSchema<Values[number]> {
	return defineFieldSchema((value, field) => {
		if (typeof value !== 'string') {
			return validationFailure('invalid_field', field);
		}

		for (const allowedValue of values) {
			if (value === allowedValue) {
				return validationSuccess(allowedValue);
			}
		}

		return validationFailure(unknownValueCode, field);
	});
}

/**
 * 기존 schema의 검증 규칙에 null 허용을 추가한다.
 *
 * @typeParam Value 기존 schema의 성공 값 타입
 * @param schema null이 아닌 값에 적용할 schema
 * @returns 기존 성공 값 또는 null을 허용하는 필드 schema
 */
function nullableSchema<Value>(
	schema: FieldSchema<Value>,
): FieldSchema<Value | null> {
	return defineFieldSchema((value, field) => {
		if (value === null) {
			return validationSuccess(null);
		}

		return schema.parse(value, field);
	});
}

/**
 * 문자열 타입과 UTF-8 인코딩 후 최대 byte 크기를 검증하는 schema를 만든다.
 *
 * @param maximumBytes 허용할 UTF-8 최대 byte 수
 * @returns 문자열의 UTF-8 byte 제한을 검증하는 필드 schema
 */
function limitedUtf8StringSchema(maximumBytes: number): FieldSchema<string> {
	return defineFieldSchema((value, field) => {
		if (typeof value !== 'string') {
			return validationFailure('invalid_field', field);
		}
		if (exceedsUtf8ByteLimit(value, maximumBytes)) {
			return validationFailure('value_out_of_range', field);
		}

		return validationSuccess(value);
	});
}

/**
 * Node 전용 API 없이 문자열의 UTF-8 byte 수가 제한을 넘는지 계산한다.
 * 제한을 넘는 즉시 종료하며 surrogate pair는 하나의 Unicode code point로 처리한다.
 *
 * @param value byte 크기를 계산할 JavaScript 문자열
 * @param limit 허용할 최대 UTF-8 byte 수
 * @returns UTF-8 byte 수가 제한보다 크면 `true`
 */
function exceedsUtf8ByteLimit(value: string, limit: number): boolean {
	let byteLength = 0;

	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) {
			byteLength += 1;
		} else if (codeUnit <= 0x7ff) {
			byteLength += 2;
		} else if (
			codeUnit >= 0xd800
			&& codeUnit <= 0xdbff
			&& index + 1 < value.length
			&& value.charCodeAt(index + 1) >= 0xdc00
			&& value.charCodeAt(index + 1) <= 0xdfff
		) {
			byteLength += 4;
			index += 1;
		} else {
			byteLength += 3;
		}

		if (byteLength > limit) {
			return true;
		}
	}

	return false;
}

/**
 * 값이 null 또는 배열이 아닌 메시지 객체 후보인지 판별한다.
 *
 * @param value 외부에서 수신한 unknown 값
 * @returns 문자열 key로 접근 가능한 객체이면 `true`
 */
function isMessageRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Prototype chain을 따르지 않고 객체 자신의 필드만 확인한다.
 *
 * @param object 필드 소유 여부를 검사할 객체
 * @param field 검사할 필드 이름
 * @returns 객체가 해당 필드를 직접 소유하면 `true`
 */
function hasOwn(object: object, field: string): boolean {
	return Object.prototype.hasOwnProperty.call(object, field);
}
