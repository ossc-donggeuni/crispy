/** app-server 송수신과 process 출력을 Crispy Output Channel용 JSON record로 만드는 모듈이다. */

import type {
	CodexLogDirection,
	CodexLogMessageKind,
	CodexLogRecord,
} from './contracts';
import { isRecord, isRequestId } from './runtimeValidation';

/** 기존 Crispy Output Channel에서 로그 기록에 필요한 최소 기능이다. */
export interface CodexOutputWriter {
	/** Output Channel에 완성된 한 줄을 추가한다. */
	appendLine(value: string): void;
}

/** 구조화된 app-server 로그 생성에 주입하는 시각 공급자다. */
export type CodexLogClock = () => Date;

/** Output Channel에서 app-server 구조화 로그를 구분하는 기본 접두사다. */
export const defaultCodexLogPrefix = '[Codex app-server]';

/** app-server 메시지를 Crispy Output Channel의 구조화된 한 줄 로그로 기록한다. */
export class CodexAppServerLogger {
	/** 완성된 로그 한 줄을 받는 기존 Crispy Output Channel writer다. */
	private readonly writer: CodexOutputWriter;
	/** timestamp 생성을 실제 시각 또는 테스트 고정 시각으로 교체하는 함수다. */
	private readonly clock: CodexLogClock;
	/** 다른 Crispy 로그에서 app-server record를 구분하는 문자열이다. */
	private readonly prefix: string;

	/**
	 * @param writer 기존 Crispy Output Channel 또는 동일한 appendLine 구현
	 * @param clock 테스트에서 고정할 수 있는 로그 시각 공급자
	 * @param prefix 다른 Crispy 로그와 app-server 로그를 구분하는 접두사
	 */
	public constructor(
		writer: CodexOutputWriter,
		clock: CodexLogClock = () => new Date(),
		prefix = defaultCodexLogPrefix,
	) {
		this.writer = writer;
		this.clock = clock;
		this.prefix = prefix;
	}

	/**
	 * raw payload와 검증된 JSON 객체에서 진단 metadata를 추출해 기록한다.
	 *
	 * @param direction 메시지 방향 또는 process 소스
	 * @param kind request, response, notification 등 메시지 분류
	 * @param raw 수정하지 않은 JSONL 또는 stderr 문자열
	 * @param value JSON으로 해석된 경우의 원본 값
	 */
	public write(
		direction: CodexLogDirection,
		kind: CodexLogMessageKind,
		raw: string,
		value?: unknown,
	): void {
		const record: CodexLogRecord = {
			timestamp: this.clock().toISOString(),
			direction,
			kind,
			raw,
			...extractMetadata(value),
		};

		try {
			this.writer.appendLine(`${this.prefix} ${JSON.stringify(record)}`);
		} catch {
			// Output Channel 종료나 테스트 writer 예외가 protocol 처리를 중단하지 않게 한다.
		}
	}
}

/**
 * 알려진 envelope와 params·result 중첩 객체에서 검색 가능한 protocol 식별자를 추출한다.
 * 알 수 없는 field는 거부하지 않으며 raw payload에 그대로 남는다.
 *
 * @param value JSON으로 파싱되었거나 Host가 전송할 원본 객체.
 * @returns method, request, Thread, Turn과 Item 식별자 중 발견된 metadata.
 */
function extractMetadata(value: unknown): Partial<CodexLogRecord> {
	if (!isRecord(value)) {
		return {};
	}

	const params = isRecord(value.params) ? value.params : undefined;
	const result = isRecord(value.result) ? value.result : undefined;
	const paramsThread = params && isRecord(params.thread) ? params.thread : undefined;
	const paramsTurn = params && isRecord(params.turn) ? params.turn : undefined;
	const resultThread = result && isRecord(result.thread) ? result.thread : undefined;
	const resultTurn = result && isRecord(result.turn) ? result.turn : undefined;
	const item = params && isRecord(params.item) ? params.item : undefined;
	const requestId = isRequestId(value.id)
		? value.id
		: params && isRequestId(params.requestId)
			? params.requestId
			: undefined;
	const threadId = findString('threadId', value, params, result)
		?? findString('id', paramsThread, resultThread);
	const turnId = findString('turnId', value, params, result)
		?? findString('id', paramsTurn, resultTurn);
	const itemId = findString('itemId', value, params)
		?? findString('id', item);

	return {
		...(typeof value.method === 'string' ? { method: value.method } : {}),
		...(requestId !== undefined ? { requestId } : {}),
		...(threadId !== undefined ? { threadId } : {}),
		...(turnId !== undefined ? { turnId } : {}),
		...(itemId !== undefined ? { itemId } : {}),
	};
}

/**
 * 후보 객체를 우선순위대로 탐색해 같은 이름의 첫 문자열 field를 반환한다.
 *
 * @param key 찾을 field 이름.
 * @param records 탐색 순서가 보존된 객체 후보.
 * @returns 처음 발견한 문자열 또는 `undefined`.
 */
function findString(
	key: string,
	...records: Array<Record<string, unknown> | undefined>
): string | undefined {
	for (const record of records) {
		if (record && typeof record[key] === 'string') {
			return record[key];
		}
	}
	return undefined;
}
