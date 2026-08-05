import path from 'node:path';

import { isRecord } from '../model/webviewMessage';
import type { AgentEvent, AgentToolName, ChangePlan } from './agentTypes';
import { validateChangePlan, type ChangePlanValidationResult } from './changePlanValidator';

/**
 * JSON으로 파싱한 agent message가 Crispy ChangePlan인지 판정하는 함수 계약입니다.
 * 제품에서는 `validateChangePlan()`을 감싸 사용하고, 단위 테스트에서는 Schema asset 없이
 * 후보 선택 동작만 검증할 수 있도록 대체 함수를 주입합니다.
 *
 * @param value agent message에서 JSON으로 파싱한 검증 전 값
 * @returns Plan의 유효 여부와 실패 이유
 */
type PlanValidator = (value: unknown) => ChangePlanValidationResult;

/**
 * Codex JSONL parser를 한 실행에 맞게 구성하는 내부 옵션입니다.
 *
 * Parser 인스턴스는 실행 한 건의 버퍼와 누적 상태를 보유하므로 `runCodex()`가 Codex
 * 프로세스를 시작할 때마다 새로 생성해야 합니다.
 */
export interface CodexEventParserOptions {
	/** `isAdditionalCandidate` 등 ChangePlan 의미 검증에 사용하는 원본 사용자 요청입니다. */
	userPrompt: string;
	/** 명령에 포함된 절대 경로를 안전한 상대 경로로 바꾸는 기준 Workspace입니다. */
	workspaceRoot: string;
	/** 테스트 또는 별도 번들 환경에서 사용할 ChangePlan Schema 경로입니다. */
	schemaPath?: string;
	/** 변환된 진행 이벤트를 Webview 등 외부 소비자에게 실시간 전달하는 callback입니다. */
	onEvent?: (event: AgentEvent) => void;
	/** 실제 Validator를 대체하는 테스트용 주입 지점입니다. 생략하면 제품 Validator를 사용합니다. */
	validatePlan?: PlanValidator;
}

/**
 * stdout 스트림을 끝까지 처리한 뒤 Runner에 전달하는 누적 파싱 결과입니다.
 *
 * 실행 성공 여부는 이 객체만으로 결정하지 않습니다. `runCodex()`가 프로세스 종료 코드,
 * 취소와 timeout까지 함께 확인한 뒤 최종 `AgentRunResult`를 만듭니다.
 */
export interface CodexEventParserResult {
	/** JSONL 한 줄 자체를 JSON으로 해석하지 못한 횟수입니다. Plan 내용 오류는 포함하지 않습니다. */
	parseFailureCount: number;
	/** `item.completed / agent_message` 조건을 만족해 검사한 메시지 수입니다. */
	agentMessageCount: number;
	/** 모든 후보 중 마지막으로 JSON 파싱과 Validator를 통과한 ChangePlan입니다. */
	plan?: ChangePlan;
	/** 가장 최근 Plan 후보가 JSON 파싱 또는 검증에 실패한 이유입니다. */
	planError?: string;
	/** Codex의 `error` 또는 `turn.failed` 이벤트에서 받은 Provider 오류입니다. */
	providerError?: string;
}

/**
 * 타입이 정해지지 않은 Codex 원본 JSON 객체를 단계적으로 검사하기 위한 내부 표현입니다.
 * 각 필드는 사용 직전에 별도 type guard를 거쳐야 하며, 이 interface만으로 원본 형식을
 * 신뢰해서는 안 됩니다.
 */
interface UnknownRecord {
	[key: string]: unknown;
}

/**
 * Codex stdout JSONL을 공통 AgentEvent와 최종 ChangePlan 후보로 변환하는 상태형 parser입니다.
 *
 * Node stream의 chunk 경계는 JSONL 줄 경계와 일치하지 않으므로 완성되지 않은 마지막 줄을
 * 다음 chunk까지 보존합니다. 한 실행의 파싱 실패 수, 도구 이벤트 중복 ID, Provider 오류와
 * 마지막 유효 Plan을 함께 누적하며, 프로세스가 닫힌 뒤 `finish()`에서 결과를 반환합니다.
 *
 * 원본 JSONL은 외부에 그대로 노출하지 않습니다. UI에는 Provider와 무관한 `AgentEvent`만
 * 전달하여 이후 다른 Agent를 연결해도 Webview가 Codex 고유 형식에 의존하지 않게 합니다.
 */
export class CodexEventParser {
	/** 변환된 이벤트를 실시간으로 받는 외부 callback입니다. 예외는 `emit()`에서 격리합니다. */
	private readonly onEvent?: (event: AgentEvent) => void;
	/** 명령에서 발견한 절대 경로를 상대 경로로 정규화할 기준 Workspace입니다. */
	private readonly workspaceRoot: string;
	/** agent message의 JSON 값을 최종 ChangePlan 후보로 인정할지 판정합니다. */
	private readonly validatePlan: PlanValidator;
	/** started와 completed에서 같은 command item을 중복 전달하지 않기 위한 item ID 집합입니다. */
	private readonly emittedToolItemIds = new Set<string>();
	/** 아직 개행을 만나지 못해 완성되지 않은 JSONL 조각입니다. */
	private lineBuffer = '';
	/** JSONL 줄 자체의 JSON.parse 실패 횟수입니다. Plan 후보의 내용 오류와 분리합니다. */
	private parseFailureCount = 0;
	/** 완료된 agent message를 확인한 횟수입니다. 유효 여부와 무관하게 증가합니다. */
	private agentMessageCount = 0;
	/** 현재까지 검사한 후보 중 가장 나중에 검증을 통과한 Plan입니다. */
	private lastValidPlan?: ChangePlan;
	/** 가장 최근 Plan 후보의 JSON 파싱 또는 Validator 실패 이유입니다. */
	private lastPlanError?: string;
	/** Provider가 원본 이벤트로 전달한 가장 최근 실행 오류입니다. */
	private providerError?: string;

	/**
	 * Codex 실행 한 건에 사용할 parser 상태와 Plan Validator를 준비합니다.
	 *
	 * @param options 사용자 요청, Workspace, 이벤트 callback과 선택적 테스트 의존성
	 */
	public constructor(options: CodexEventParserOptions) {
		this.onEvent = options.onEvent;
		this.workspaceRoot = path.resolve(options.workspaceRoot);
		this.validatePlan = options.validatePlan
			?? ((value) => validateChangePlan(value, {
				userPrompt: options.userPrompt,
				schemaPath: options.schemaPath,
			}));
	}

	/**
	 * stdout에서 받은 chunk를 누적하고 개행으로 완성된 JSONL 줄만 즉시 처리합니다.
	 *
	 * 하나의 JSON 객체가 여러 chunk로 나뉘거나 여러 줄이 한 chunk에 함께 올 수 있으므로,
	 * chunk 하나를 곧바로 `JSON.parse()`하지 않고 줄 단위로 분리합니다. 마지막 미완성 조각은
	 * `lineBuffer`에 남겨 다음 호출과 이어 붙입니다.
	 *
	 * @param chunk Codex stdout의 `data` 이벤트에서 받은 Buffer 또는 문자열
	 * @returns 반환값 없이 파서의 버퍼와 누적 결과를 갱신합니다.
	 */
	public push(chunk: Buffer | string): void {
		this.lineBuffer += chunk.toString();

		let newlineIndex = this.lineBuffer.indexOf('\n');
		while (newlineIndex >= 0) {
			const line = this.lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
			this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
			this.parseLine(line);
			newlineIndex = this.lineBuffer.indexOf('\n');
		}
	}

	/**
	 * stream 종료 시 개행 없이 남은 마지막 줄도 처리하고 누적 결과를 반환합니다.
	 * 마지막으로 도착한 메시지가 아니라, 끝까지 검사한 메시지 중 마지막으로 검증에 성공한
	 * Plan을 유지하므로 중간의 유효 Plan을 첫 번째 결과로 조기 확정하지 않습니다.
	 *
	 * @returns JSONL 품질 정보, Provider 오류와 마지막 유효 ChangePlan 후보
	 */
	public finish(): CodexEventParserResult {
		if (this.lineBuffer.trim().length > 0) {
			this.parseLine(this.lineBuffer.replace(/\r$/, ''));
		}
		this.lineBuffer = '';

		return {
			parseFailureCount: this.parseFailureCount,
			agentMessageCount: this.agentMessageCount,
			plan: this.lastValidPlan,
			planError: this.lastPlanError,
			providerError: this.providerError,
		};
	}

	/**
	 * 완성된 JSONL 한 줄을 JSON으로 해석하고 Codex 이벤트 처리 단계로 전달합니다.
	 *
	 * 빈 줄과 형식을 알 수 없는 정상 JSON 값은 무시합니다. `parseFailureCount`는 줄 전체가
	 * 깨져 `JSON.parse()`할 수 없을 때만 증가하며, 정상 이벤트 안의 Plan text 오류는
	 * `lastPlanError`로 따로 관리합니다.
	 *
	 * @param line 개행 문자가 제거된 JSONL 한 줄
	 * @returns 반환값 없이 누적 상태와 외부 이벤트를 갱신합니다.
	 */
	private parseLine(line: string): void {
		if (line.trim().length === 0) {
			return;
		}

		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			// parseFailureCount는 JSONL 전송 단위 자체가 깨졌을 때만 증가합니다.
			// 정상 이벤트 내부의 agent_message.text 파싱 실패와 섞으면 스트림 품질을
			// Plan 품질로 오인하게 되므로 두 오류 범위를 의도적으로 분리합니다.
			this.parseFailureCount += 1;
			return;
		}

		if (!isRecord(event) || typeof event.type !== 'string') {
			return;
		}
		this.handleRawEvent(event);
	}

	/**
	 * Codex 원본 이벤트의 `type`에 따라 상태, 오류 또는 item 처리기로 분배합니다.
	 *
	 * `turn.completed`는 대화 turn의 종료 신호일 뿐 프로세스 종료나 유효 Plan 생성을
	 * 보장하지 않으므로 진행 이벤트만 내보내고 성공 상태를 확정하지 않습니다.
	 *
	 * @param event 최소한 문자열 `type` 필드를 가진 Codex 원본 이벤트
	 * @returns 반환값 없이 알맞은 세부 처리기를 호출합니다.
	 */
	private handleRawEvent(event: UnknownRecord): void {
		switch (event.type) {
			case 'thread.started':
				this.emit({ type: 'status', message: '프로젝트 분석을 시작했습니다.' });
				break;
			case 'turn.started':
				this.emit({ type: 'status', message: '작업 계획 작성을 시작했습니다.' });
				break;
			case 'turn.completed':
				// 이 이벤트는 Codex turn의 끝일 뿐 프로세스 종료·Plan 검증을 보장하지 않습니다.
				this.emit({ type: 'status', message: 'Codex 응답 처리가 완료되었습니다.' });
				break;
			case 'error':
				this.handleProviderError(event.message);
				break;
			case 'turn.failed':
				this.handleTurnFailure(event.error);
				break;
			case 'item.started':
			case 'item.completed':
				this.handleItemEvent(event.type, event.item);
				break;
		}
	}

	/**
	 * Provider 오류 문자열을 저장하고 중복되지 않은 error 이벤트로 전달합니다.
	 *
	 * @param value Codex `error` 이벤트의 검증 전 message 값
	 * @returns 반환값 없이 Provider 오류 상태와 외부 이벤트를 갱신합니다.
	 */
	private handleProviderError(value: unknown): void {
		if (typeof value !== 'string' || value.trim().length === 0) {
			return;
		}
		if (this.providerError === value) {
			return;
		}
		this.providerError = value;
		this.emit({ type: 'error', message: value });
	}

	/**
	 * `turn.failed`의 중첩 error 객체에서 message를 안전하게 꺼내 공통 오류 처리로 전달합니다.
	 *
	 * @param value Codex `turn.failed.error`의 검증 전 값
	 * @returns 반환값 없이 유효한 문자열 message가 있을 때만 오류 상태를 갱신합니다.
	 */
	private handleTurnFailure(value: unknown): void {
		if (isRecord(value) && typeof value.message === 'string') {
			this.handleProviderError(value.message);
		}
	}

	/**
	 * Codex item의 시작·완료 이벤트를 도구 실행, reasoning 또는 agent message로 분류합니다.
	 *
	 * command는 시작 시점부터 UI에 진행 상황을 표시할 수 있도록 처리하고, reasoning과
	 * agent message는 내용이 완성된 `item.completed`에서만 소비합니다.
	 *
	 * @param eventType `item.started` 또는 `item.completed`
	 * @param value Codex 이벤트의 검증 전 item 값
	 * @returns 반환값 없이 도구·메시지 이벤트 또는 Plan 후보 상태를 갱신합니다.
	 */
	private handleItemEvent(eventType: string, value: unknown): void {
		if (!isRecord(value) || typeof value.type !== 'string') {
			return;
		}

		if (value.type === 'command_execution') {
			this.handleCommandItem(eventType, value);
			return;
		}

		if (eventType !== 'item.completed') {
			return;
		}

		if (value.type === 'reasoning' && typeof value.text === 'string' && value.text.trim()) {
			this.emit({ type: 'message', text: value.text });
			return;
		}

		if (value.type === 'agent_message' && typeof value.text === 'string') {
			this.handleAgentMessage(value.text);
		}
	}

	/**
	 * Codex command item을 공통 도구 이름과 안전한 Workspace 상대 대상으로 변환합니다.
	 *
	 * Provider 버전에 따라 `item.started`가 생략될 수 있어 completed도 fallback으로 받지만,
	 * 같은 item ID는 `emittedToolItemIds`로 한 번만 전달합니다.
	 *
	 * @param eventType command가 보고된 item lifecycle 단계
	 * @param item 문자열 command를 포함할 수 있는 Codex item
	 * @returns 반환값 없이 필요한 경우 tool 이벤트를 전달합니다.
	 */
	private handleCommandItem(eventType: string, item: UnknownRecord): void {
		if (typeof item.command !== 'string' || item.command.trim().length === 0) {
			return;
		}

		const itemId = typeof item.id === 'string' ? item.id : undefined;
		if (itemId && this.emittedToolItemIds.has(itemId)) {
			return;
		}
		// item.started가 없는 Provider 버전도 진행 상황을 표시할 수 있도록 completed를
		// fallback으로 받되, 동일 ID는 한 번만 Webview에 전달합니다.
		if (eventType === 'item.started' || eventType === 'item.completed') {
			if (itemId) {
				this.emittedToolItemIds.add(itemId);
			}
			const name = classifyCodexTool(item.command);
			const target = extractWorkspaceTarget(item.command, this.workspaceRoot, name);
			this.emit(target ? { type: 'tool', name, target } : { type: 'tool', name });
		}
	}

	/**
	 * 완료된 agent message를 JSON ChangePlan 후보로 파싱하고 검증합니다.
	 *
	 * 설명 문장처럼 JSON이 아닌 message는 UI에 일반 message로 전달하고 Plan 오류를 남깁니다.
	 * 유효한 후보는 즉시 최종 plan 이벤트로 확정하지 않고 `lastValidPlan`만 교체합니다.
	 * 이후 메시지가 잘못되어도 이미 확보한 유효 Plan은 유지하며, 더 나중의 유효 후보가
	 * 도착하면 그 후보로 교체합니다.
	 *
	 * @param text Codex `item.completed / agent_message`의 원본 text
	 * @returns 반환값 없이 메시지 수, 마지막 유효 Plan과 Plan 오류를 갱신합니다.
	 */
	private handleAgentMessage(text: string): void {
		this.agentMessageCount += 1;

		let candidate: unknown;
		try {
			candidate = JSON.parse(text);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastPlanError = `agent_message.text가 JSON이 아닙니다: ${message}`;
			this.emit({ type: 'message', text });
			return;
		}

		try {
			const validation = this.validatePlan(candidate);
			if (validation.valid) {
				// 뒤에 더 완전한 Plan이 올 수 있으므로 즉시 외부에 plan 이벤트를 보내지 않고
				// 마지막 유효 후보만 교체합니다. 최종 확정은 프로세스 종료 후 runCodex가 합니다.
				this.lastValidPlan = candidate as ChangePlan;
				this.lastPlanError = undefined;
				return;
			}
			this.lastPlanError = validation.errors.join('; ');
		} catch (error) {
			this.lastPlanError = error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * 변환된 AgentEvent를 외부 callback에 안전하게 전달합니다.
	 *
	 * Webview가 닫히는 순간 등 UI callback에서 예외가 발생해도 Parser나 Codex child process의
	 * 수명주기를 중단시키지 않도록 예외를 이 경계에서 격리합니다.
	 *
	 * @param event Provider 형식에서 변환된 공통 AgentEvent
	 * @returns 반환값 없이 callback이 있을 때 한 번 호출합니다.
	 */
	private emit(event: AgentEvent): void {
		if (!this.onEvent) {
			return;
		}
		try {
			this.onEvent(event);
		} catch {
			// UI 콜백의 예외가 Codex 프로세스를 고아 상태로 만들거나 실행 결과를
			// failed로 바꾸지 않도록 Provider 수명주기 경계에서 격리합니다.
		}
	}
}

/**
 * Codex의 원본 shell 명령을 Provider 공통 의미 기반 도구 이름으로 축약합니다.
 *
 * Webview가 `rg`, `sed` 같은 Codex 구현 세부사항을 직접 해석하지 않도록 대표적인
 * 읽기 명령을 목록·파일 읽기·검색으로 분류하고 나머지는 일반 명령으로 처리합니다.
 * 이 함수는 명령 실행 권한을 판단하는 보안 경계가 아니라 UI 표시용 정규화 함수입니다.
 *
 * @param command Codex command item에 기록된 원본 명령 문자열
 * @returns Webview와 다른 Provider가 공유하는 `AgentToolName`
 */
export function classifyCodexTool(command: string): AgentToolName {
	const normalized = command.trim().toLowerCase();
	if (/\brg\s+--files\b/.test(normalized) || /\b(?:ls|find|fd|tree)\b/.test(normalized)) {
		return 'list_files';
	}
	if (/\b(?:cat|sed|head|tail|bat)\b/.test(normalized)) {
		return 'read_file';
	}
	if (/\b(?:rg|grep)\b/.test(normalized)) {
		return 'search_code';
	}
	return 'run_command';
}

/**
 * 도구 명령에서 Webview에 표시할 안전한 Workspace 상대 대상 경로를 추정합니다.
 *
 * 따옴표로 묶인 인자를 보존해 token을 만들고 마지막 경로 후보부터 검사합니다. 절대 경로는
 * Workspace 내부일 때만 상대 경로로 바꾸며, 상위 경로 이동이나 일반 명령은 target 없이
 * 전달합니다. 완전한 shell parser가 아니므로 UI 힌트만 제공하고 실행 판단에는 사용하지 않습니다.
 *
 * @param command Codex가 실행하거나 완료한 원본 명령 문자열
 * @param workspaceRoot 절대 경로를 상대 경로로 바꾸는 기준 Workspace
 * @param toolName 앞서 분류된 공통 도구 이름
 * @returns 안전한 대상 후보가 있으면 POSIX 형식 상대 경로, 없으면 undefined
 */
function extractWorkspaceTarget(
	command: string,
	workspaceRoot: string,
	toolName: AgentToolName,
): string | undefined {
	if (toolName === 'run_command') {
		return undefined;
	}

	const tokens = [...command.matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/g)]
		.map((match) => match[1] ?? match[2] ?? match[3])
		.map((token) => token.replace(/[;,]+$/, ''));

	for (let index = tokens.length - 1; index >= 0; index -= 1) {
		const token = tokens[index];
		if (!token || token.startsWith('-') || /^(?:\||&&|\d+|\d+,\d+p)$/.test(token)) {
			continue;
		}

		let relativeTarget: string;
		if (path.isAbsolute(token)) {
			relativeTarget = path.relative(workspaceRoot, path.resolve(token));
			if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
				continue;
			}
		} else {
			relativeTarget = token.replace(/^\.\//, '');
		}

		if (relativeTarget === '.' || relativeTarget.length === 0 || relativeTarget.includes('..')) {
			continue;
		}
		return relativeTarget.split(path.sep).join('/');
	}
	return undefined;
}
