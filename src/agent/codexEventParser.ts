import path from 'node:path';

import { isRecord } from '../model/webviewMessage';
import type { AgentEvent, AgentToolName, ChangePlan } from './agentTypes';
import { validateChangePlan, type ChangePlanValidationResult } from './changePlanValidator';

type PlanValidator = (value: unknown) => ChangePlanValidationResult;

export interface CodexEventParserOptions {
	userPrompt: string;
	workspaceRoot: string;
	schemaPath?: string;
	onEvent?: (event: AgentEvent) => void;
	validatePlan?: PlanValidator;
}

export interface CodexEventParserResult {
	parseFailureCount: number;
	agentMessageCount: number;
	plan?: ChangePlan;
	planError?: string;
	providerError?: string;
}

interface UnknownRecord {
	[key: string]: unknown;
}

/**
 * Codex의 stdout JSONL을 chunk 단위로 받아 공통 AgentEvent와 최종 ChangePlan으로 변환합니다.
 * Node stream의 chunk 경계는 JSONL 줄 경계와 일치하지 않으므로, 완성되지 않은 마지막 줄을
 * 다음 chunk까지 보존하는 버퍼가 반드시 필요합니다.
 */
export class CodexEventParser {
	private readonly onEvent?: (event: AgentEvent) => void;
	private readonly workspaceRoot: string;
	private readonly validatePlan: PlanValidator;
	private readonly emittedToolItemIds = new Set<string>();
	private lineBuffer = '';
	private parseFailureCount = 0;
	private agentMessageCount = 0;
	private lastValidPlan?: ChangePlan;
	private lastPlanError?: string;
	private providerError?: string;

	public constructor(options: CodexEventParserOptions) {
		this.onEvent = options.onEvent;
		this.workspaceRoot = path.resolve(options.workspaceRoot);
		this.validatePlan = options.validatePlan
			?? ((value) => validateChangePlan(value, {
				userPrompt: options.userPrompt,
				schemaPath: options.schemaPath,
			}));
	}

	/** stdout에서 받은 데이터를 누적하고, 개행으로 완성된 JSONL만 즉시 처리합니다. */
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

	private handleTurnFailure(value: unknown): void {
		if (isRecord(value) && typeof value.message === 'string') {
			this.handleProviderError(value.message);
		}
	}

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

/** Codex의 원본 shell 명령을 Provider 공통 의미 이름으로 축약합니다. */
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
