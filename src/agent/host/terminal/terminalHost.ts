import { randomUUID } from 'crypto';
import type {
	HostToWebviewMessage,
	SessionId,
	TabId,
	WebviewToHostMessage,
} from '../../protocol/messages';
import type { ProviderId } from '../../protocol/providers';
import {
	buildCodexBareLaunchPlan,
	buildCodexMcpLaunchPlan,
} from '../../../mcp/codexLaunchPlan';
import {
	buildClaudeBareLaunchPlan,
	buildClaudeMcpLaunchPlan,
} from '../../../mcp/claudeLaunchPlan';
import {
	createAgentProcessSpawnRequest,
	type AgentLaunchPlan,
	type AgentProcessSpawnRequest,
} from '../../../mcp/agentLaunchPlan';
import type {
	BuildCodexBareLaunchPlanOptions,
	BuildCodexMcpLaunchPlanOptions,
} from '../../../mcp/codexLaunchPlan';
import type {
	BuildClaudeBareLaunchPlanOptions,
	BuildClaudeMcpLaunchPlanOptions,
} from '../../../mcp/claudeLaunchPlan';
import { spawnAgentPty } from '../../../mcp/agentPtyLaunch';
import type {
	McpPrepareResult,
	McpSessionRuntime,
	McpSessionRuntimeEvent,
} from '../../../mcp/sessionRuntime';
import type { PrepareCodexTerminalLaunch } from '../../../mcp/codexTerminalLaunch';
import type {
	PreparedClaudeTerminalLaunch,
	PrepareClaudeTerminalLaunch,
} from '../../../mcp/claudeTerminalLaunch';
import {
	CLAUDE_STARTUP_DIAGNOSTIC_MAX_BYTES,
	classifyClaudeStartupDiagnostic,
} from '../../../mcp/claudeDiagnostic';
import {
	createMcpFailure,
	retryabilityByFailureReason,
	type McpFailure,
	type McpFailureReason,
} from '../../../mcp/failureReason';
import {
	resolveAgentAutoRunInput,
	resolveDetectedAgentAutoRunInput,
	type AgentAutoRunInputResolver,
} from '../agent/agentProviderLaunch';
import type {
	PtyAdapter,
	PtyExitEvent,
	PtyProcessHandle,
} from './ptyAdapter';
import {
	prepareTerminalLaunch,
	type PrepareTerminalLaunch,
} from './prepareTerminalLaunch';
import {
	TerminalProcessExitedBeforeReadyError,
	TerminalSession,
} from './terminalSession';
import type { ProcessTreeController } from './processTreeController';
import { createHostProcessTreeController } from './processTreeControllerFactory';

/**
 * `TerminalHost`가 생성한 생명주기 메시지를 Webview 전송 계층에 전달하는 함수다.
 *
 * @param message Webview로 전달할 검증된 Host 메시지
 */
export type TerminalHostMessageEmitter = (
	message: HostToWebviewMessage,
) => void;

/** TerminalHost가 session별 MCP ownership에 사용하는 Panel-owned supervisor 계약이다. */
export interface McpSupervisor {
	prepareSession(sessionId: string): Promise<McpPrepareResult>;
	stopSession(sessionId: string): Promise<void>;
	getSessionRuntime(sessionId: string): Pick<
		McpSessionRuntime,
		'generation' | 'lifecycle' | 'markProviderStarted'
	> | undefined;
	dispose(): Promise<void>;
}

/** Backward-compatible test/public type name retained while orchestration becomes provider-neutral. */
export type CodexMcpSupervisor = McpSupervisor;

export type CodexMcpLaunchPlanBuilder = (
	options: BuildCodexMcpLaunchPlanOptions,
) => AgentLaunchPlan | Promise<AgentLaunchPlan>;

export type CodexBareLaunchPlanBuilder = (
	options: BuildCodexBareLaunchPlanOptions,
) => AgentLaunchPlan | Promise<AgentLaunchPlan>;

export type ClaudeMcpLaunchPlanBuilder = (
	options: BuildClaudeMcpLaunchPlanOptions,
) => AgentLaunchPlan | Promise<AgentLaunchPlan>;

export type ClaudeBareLaunchPlanBuilder = (
	options: BuildClaudeBareLaunchPlanOptions,
) => AgentLaunchPlan | Promise<AgentLaunchPlan>;

export type AgentProcessSpawnRequestBuilder = (
	plan: AgentLaunchPlan,
	options: {
		readonly platform?: NodeJS.Platform;
		readonly environment: NodeJS.ProcessEnv;
	},
) => AgentProcessSpawnRequest | Promise<AgentProcessSpawnRequest>;

export type AgentPtySpawner = (
	session: TerminalSession,
	request: AgentProcessSpawnRequest,
	cols: number,
	rows: number,
) => Promise<void>;

type McpProviderId = Extract<ProviderId, 'codex' | 'claude'>;

interface PreparedStructuredProviderLaunch {
	readonly executable: BuildCodexBareLaunchPlanOptions['executable'];
	readonly cwd: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly platform: NodeJS.Platform;
}

type StructuredProviderPreparation<TPreparation> =
	| { readonly ok: true; readonly preparation: TPreparation }
	| {
		readonly ok: false;
		readonly error: Extract<HostToWebviewMessage, { readonly type: 'terminal.error' }>;
	};

interface StructuredMcpProviderStartOptions<
	TPreparation extends PreparedStructuredProviderLaunch,
> {
	readonly providerId: McpProviderId;
	readonly prepare: (
		tabId: TabId,
		sessionId: SessionId,
	) => Promise<StructuredProviderPreparation<TPreparation>>;
	readonly canUseMcp: (preparation: TPreparation) => boolean;
	readonly buildMcpPlan: (
		preparation: TPreparation,
		connection: Extract<McpPrepareResult, { readonly ok: true }>['connection'],
	) => AgentLaunchPlan | Promise<AgentLaunchPlan>;
	readonly buildBarePlan: (
		preparation: TPreparation,
	) => AgentLaunchPlan | Promise<AgentLaunchPlan>;
	readonly publishStartupFailures: boolean;
	readonly onAuthenticatedRequestReady?: (
		session: TerminalSession,
		preparation: TPreparation,
		plan: AgentLaunchPlan,
		generation: string,
	) => void;
}

/**
 * UUID에 Host 전용 접두사를 붙여 프로토콜 규칙을 만족하는 `sessionId`를 생성한다.
 *
 * @returns 충돌 가능성이 낮고 프로토콜 ID 형식과 최대 길이를 만족하는 식별자
 */
function generateTerminalSessionId(): SessionId {
	return `session-${randomUUID()}`;
}

/**
 * `TerminalHost` 생성에 필요한 Host 소유 의존성이다.
 */
export interface TerminalHostOptions {
	/** 새 `TerminalSession`에 전달할 주입 가능한 PTY 생성 경계다. */
	readonly ptyAdapter: PtyAdapter;

	/** 작업공간과 셸 정책을 적용하는 시작 및 재시작 공통 준비 함수다. */
	readonly prepareLaunch?: PrepareTerminalLaunch;

	/** 생성된 생명주기 메시지를 Webview 전송 계층으로 넘기는 함수다. */
	readonly emitMessage: TerminalHostMessageEmitter;

	/** Shell 정책에서 provider CLI 자동 실행 입력을 탐색하는 Host 경계다. */
	readonly resolveAgentAutoRunInput?: AgentAutoRunInputResolver;

	/** Codex direct-root launch를 Shell 정책과 분리해 준비하는 경계다. */
	readonly prepareCodexLaunch?: PrepareCodexTerminalLaunch;

	/** Claude direct-root launch와 credential-free version gate를 준비하는 경계다. */
	readonly prepareClaudeLaunch?: PrepareClaudeTerminalLaunch;

	/** Panel이 소유하며 provider session별 adapter runtime을 격리하는 supervisor다. */
	readonly mcpSupervisor?: McpSupervisor;

	/** 결정적인 transaction/race test를 위한 structured plan builder 경계다. */
	readonly buildCodexMcpLaunchPlan?: CodexMcpLaunchPlanBuilder;
	readonly buildCodexBareLaunchPlan?: CodexBareLaunchPlanBuilder;
	readonly buildClaudeMcpLaunchPlan?: ClaudeMcpLaunchPlanBuilder;
	readonly buildClaudeBareLaunchPlan?: ClaudeBareLaunchPlanBuilder;
	readonly createAgentProcessSpawnRequest?: AgentProcessSpawnRequestBuilder;
	readonly spawnAgentPty?: AgentPtySpawner;

	/** Session 분리 뒤 PID snapshot과 비동기 OS 종료를 담당하는 Host controller다. */
	readonly processTreeController?: ProcessTreeController;
}

/**
 * 터미널 시작 단계별 고정 오류 메시지 정책이다.
 */
const START_ERROR_MESSAGES = Object.freeze({
	duplicate: 'Terminal tab already has an active session.',
	registration: 'Terminal session could not be created.',
	preparation: 'Terminal launch policy could not be prepared.',
	spawn: 'Terminal process could not be started.',
	operation: 'Terminal process operation failed.',
	restartUnknown: 'Terminal session could not be found.',
	restartInProgress: 'Terminal restart is already in progress.',
	restartUnavailable: 'Terminal session can no longer be restarted.',
	unknownTab: 'Terminal tab is not registered.',
});

/** 재시작 시 마지막으로 확인된 크기가 없을 때 사용하는 Host 기본 terminal 크기다. */
const RESTART_FALLBACK_DIMENSIONS = Object.freeze({ cols: 80, rows: 24 });
/** 3초 deactivate budget에서 2초 process-tree cleanup을 남기는 PID 준비 상한이다. */
export const DETACHED_PID_READY_TIMEOUT_MS = 500;

/** Host 내부 lifecycle은 숨은 준비 상태와 지속 표시 상태를 모두 구분한다. */
export type InternalMcpStatus =
	| 'idle'
	| 'preparing'
	| 'awaiting_activity'
	| 'connected'
	| 'failed'
	| 'cleared';

interface InternalMcpStatusRecord {
	readonly status: InternalMcpStatus;
	readonly failure?: McpFailure;
	published: boolean;
}

function isValidProcessTreeRootPid(pid: number): boolean {
	return Number.isSafeInteger(pid) && pid > 1;
}

/**
 * 탭별 현재 세션 저장소와 Host 소유 PTY 시작·입력·크기 변경·출력·종료 경로를 관리한다.
 * 재시작 및 process lifecycle 정리 조정은 후속 단계의 책임이다.
 */
export class TerminalHost {
	/** 등록된 모든 세션을 Host 소유 `sessionId`로 조회하는 저장소다. */
	private readonly sessionsById = new Map<SessionId, TerminalSession>();

	/** 각 Webview 탭을 현재 `sessionId` 하나에 연결하는 소유권 저장소다. */
	private readonly activeSessionByTab = new Map<TabId, SessionId>();

	/** Webview가 만들어 Host에 등록한, 아직 살아 있는 탭 식별자 집합이다. */
	private readonly registeredTabs = new Set<TabId>();

	/** 탭별로 마지막에 선택된 provider이며 세션 시작과 재시작에 함께 사용한다. */
	private readonly providerByTab = new Map<TabId, ProviderId>();

	/** 세션 시작 전에 탐색을 마친 provider CLI 입력을 현재 session에 연결한다. */
	private readonly providerAutoRunInputBySession = new Map<SessionId, string>();

	/** 재시작 PTY를 이전과 같은 크기로 생성하기 위한 탭별 마지막 terminal 크기다. */
	private readonly lastDimensionsByTab = new Map<
		TabId,
		{ readonly cols: number; readonly rows: number }
	>();

	/** 생성되는 모든 `TerminalSession`에 전달할 PTY 어댑터다. */
	private readonly ptyAdapter: PtyAdapter;

	/** 작업공간과 셸 실행 정책을 순서대로 적용하는 준비 경계다. */
	private readonly prepareLaunch: PrepareTerminalLaunch;

	/** Host 생명주기 메시지를 Webview 전송 계층으로 넘기는 경계다. */
	private readonly emitMessage: TerminalHostMessageEmitter;

	/** 실제 Shell 정책에서 provider CLI command를 선택하는 비동기 resolver다. */
	private readonly resolveProviderAutoRunInput: AgentAutoRunInputResolver;

	/** Codex만 interactive Shell 없이 준비하는 production/injected 경계다. */
	private readonly prepareCodexLaunch: PrepareCodexTerminalLaunch | undefined;

	/** Claude를 interactive Shell 없이 준비하고 version compatibility를 판정하는 경계다. */
	private readonly prepareClaudeLaunch: PrepareClaudeTerminalLaunch | undefined;

	/** Panel 소유 MCP runtime registry이며 미주입 시 기존 provider 동작만 유지한다. */
	private readonly mcpSupervisor: McpSupervisor | undefined;

	private readonly buildCodexMcpPlan: CodexMcpLaunchPlanBuilder;
	private readonly buildCodexBarePlan: CodexBareLaunchPlanBuilder;
	private readonly buildClaudeMcpPlan: ClaudeMcpLaunchPlanBuilder;
	private readonly buildClaudeBarePlan: ClaudeBareLaunchPlanBuilder;
	private readonly createAgentSpawnRequest: AgentProcessSpawnRequestBuilder;
	private readonly spawnProviderPty: AgentPtySpawner;

	/** 실제 MCP plan을 spawn하는 current provider session과 runtime generation의 결합이다. */
	private readonly mcpRuntimeBySession = new Map<SessionId, Readonly<{
		readonly providerId: Extract<ProviderId, 'codex' | 'claude'>;
		readonly generation: string;
	}>>();

	/** PTY spawn 경계에 진입한 MCP provider session만 provider-started 표시를 허용한다. */
	private readonly mcpPtySpawnStarted = new Set<SessionId>();

	/** Authenticated Claude의 exact startup rejection만 credential-free bare fallback에 연결한다. */
	private readonly claudeStartupBySession = new Map<SessionId, {
		readonly generation: string;
		readonly serverName: string;
		readonly preparation: PreparedClaudeTerminalLaunch;
		output: string;
		interactiveInputObserved: boolean;
		activityObserved: boolean;
	}>();

	/** session별 숨은 준비/대기와 visible connected/failed 상태의 Host source of truth다. */
	private readonly mcpStatusBySession = new Map<
		SessionId,
		InternalMcpStatusRecord
	>();

	/** 같은 탭의 명시적 MCP+Agent restart 연타를 Host에서도 직렬화한다. */
	private readonly mcpRestartByTab = new Map<TabId, Promise<void>>();

	/** Session 종료 경로에서 root-only kill을 피하는 process-tree controller다. */
	private readonly processTreeController: ProcessTreeController;

	/** Webview가 마지막으로 알린 활성 탭이며 등록된 탭만 값이 될 수 있다. */
	private activeTabId: TabId | undefined;

	/** Webview dispose 뒤 모든 terminal message 전송을 중단하는 gate다. */
	private messageDeliveryActive = true;

	/** Panel runtime에서 분리된 뒤 새 요청과 in-flight spawn을 거부하는 gate다. */
	private lifecycleActive = true;

	/** detach에서 native 호출 없이 넘겨받아 비동기 종료까지 보존하는 PTY ownership이다. */
	private detachedProcesses: readonly PtyProcessHandle[] = [];

	/** 반복 terminate 호출이 공유하는 최초 비동기 cleanup Promise다. */
	private terminationPromise: Promise<void> | undefined;

	/** Panel dispose가 동기 시작한 MCP supervisor cleanup을 terminate가 기다린다. */
	private mcpTerminationPromise: Promise<void> | undefined;

	/** reset/reselect/restart/tab close가 분리한 session별 process-tree cleanup이다. */
	private readonly processCleanupBySession = new Map<SessionId, Promise<void>>();

	/** 같은 탭의 다음 CLI 시작이 이전 process tree 종료를 기다리는 경계다. */
	private readonly processCleanupByTab = new Map<TabId, Promise<void>>();

	/**
	 * 비어 있는 세션 저장소와 Host 소유 의존성을 초기화한다.
	 * 객체 생성만으로 세션을 만들거나 네이티브 PTY를 불러오지 않는다.
	 *
	 * @param options PTY 어댑터, 실행 준비 함수 및 메시지 전달 함수
	 */
	constructor(options: TerminalHostOptions) {
		this.ptyAdapter = options.ptyAdapter;
		this.prepareLaunch = options.prepareLaunch ?? prepareTerminalLaunch;
		this.emitMessage = options.emitMessage;
		this.resolveProviderAutoRunInput = options.resolveAgentAutoRunInput
			?? resolveDetectedAgentAutoRunInput;
		this.prepareCodexLaunch = options.prepareCodexLaunch;
		this.prepareClaudeLaunch = options.prepareClaudeLaunch;
		this.mcpSupervisor = options.mcpSupervisor;
		this.buildCodexMcpPlan = options.buildCodexMcpLaunchPlan
			?? buildCodexMcpLaunchPlan;
		this.buildCodexBarePlan = options.buildCodexBareLaunchPlan
			?? buildCodexBareLaunchPlan;
		this.buildClaudeMcpPlan = options.buildClaudeMcpLaunchPlan
			?? buildClaudeMcpLaunchPlan;
		this.buildClaudeBarePlan = options.buildClaudeBareLaunchPlan
			?? buildClaudeBareLaunchPlan;
		this.createAgentSpawnRequest = options.createAgentProcessSpawnRequest
			?? createAgentProcessSpawnRequest;
		this.spawnProviderPty = options.spawnAgentPty ?? spawnAgentPty;
		this.processTreeController = options.processTreeController
			?? createHostProcessTreeController();
	}

	/**
	 * 검증된 `tab.create`로 새 탭을 등록한다.
	 * provider가 아직 정해지지 않았으므로 이 시점에는 `TerminalSession`을 만들지 않으며,
	 * 이후 `terminal.ready`와 `agent.switch` 요청을 받을 수 있는 탭으로만 표시한다.
	 * 같은 탭에 대한 반복 요청은 기존 등록과 활성 탭을 그대로 둔다.
	 *
	 * @param tabId 프로토콜 검증을 통과한 Webview 소유 탭 식별자
	 */
	createTab(tabId: TabId): void {
		if (!this.lifecycleActive) {
			return;
		}
		if (this.registeredTabs.has(tabId)) {
			return;
		}

		this.registeredTabs.add(tabId);
		this.activeTabId = tabId;
	}

	/**
	 * 검증된 `tab.switch`로 현재 활성 탭을 기록한다.
	 * 등록되지 않은 탭은 활성 탭으로 받아들이지 않으며 세션 상태는 바꾸지 않는다.
	 *
	 * @param tabId 프로토콜 검증을 통과한 Webview 소유 탭 식별자
	 */
	switchTab(tabId: TabId): void {
		if (!this.lifecycleActive) {
			return;
		}
		if (!this.registeredTabs.has(tabId)) {
			this.failWithoutTransition(
				tabId,
				null,
				'session_not_found',
				START_ERROR_MESSAGES.unknownTab,
				false,
			);
			return;
		}

		this.activeTabId = tabId;
	}

	/**
	 * 검증된 `tab.close`로 탭이 소유한 세션을 정리하고 등록을 해제한다.
	 * 정리는 재시작 흐름과 동일한 입력 차단 → PTY 종료 → listener 해제 순서를 따르며,
	 * 세션이 없는 탭이나 이미 닫힌 탭에 대해서도 안전하게 반복 호출할 수 있다.
	 *
	 * @param tabId 프로토콜 검증을 통과한 Webview 소유 탭 식별자
	 */
	closeTab(tabId: TabId): void {
		if (!this.lifecycleActive) {
			return;
		}
		const session = this.getActiveSession(tabId);
		if (session !== undefined) {
			void this.cleanupSessionProcessTree(session);
			this.removeSession(session.sessionId);
		}

		this.registeredTabs.delete(tabId);
		this.providerByTab.delete(tabId);
		this.lastDimensionsByTab.delete(tabId);
		this.activeSessionByTab.delete(tabId);
		if (this.activeTabId === tabId) {
			this.activeTabId = undefined;
		}
	}

	/**
	 * 검증된 `agent.reset`으로 탭 등록은 유지하면서 현재 CLI와 provider 배정을 지운다.
	 * 새 xterm의 `terminal.ready`를 다시 받아야 하므로 이전 표면 크기도 함께 버린다.
	 *
	 * @param tabId provider 선택 화면으로 되돌릴 Webview 소유 탭 식별자
	 */
	resetAgent(tabId: TabId): void {
		if (!this.lifecycleActive) {
			return;
		}
		if (!this.registeredTabs.has(tabId)) {
			this.failWithoutTransition(
				tabId,
				null,
				'session_not_found',
				START_ERROR_MESSAGES.unknownTab,
				false,
			);
			return;
		}

		const session = this.getActiveSession(tabId);
		if (session !== undefined) {
			void this.cleanupSessionProcessTree(session);
			this.removeSession(session.sessionId);
		}

		this.providerByTab.delete(tabId);
		this.lastDimensionsByTab.delete(tabId);
		this.activeSessionByTab.delete(tabId);
	}

	/**
	 * 검증된 `agent.switch`로 탭의 provider를 정하고 세션을 그 provider로 다시 시작한다.
	 * provider를 바꾸는 선택과 같은 provider를 유지하는 재시작이 같은 경로를 사용하므로
	 * 실행 중 세션이 있으면 항상 기존 세션을 정리한 뒤 새 세션을 시작한다.
	 * Terminal 크기를 아직 모르는 탭은 provider만 기록하고 `terminal.ready`를 기다린다.
	 *
	 * @param tabId 프로토콜 검증을 통과한 Webview 소유 탭 식별자
	 * @param providerId 프로토콜 allowlist를 통과한 provider 식별자
	 * @returns 정리와 시작 흐름이 끝나면 완료되는 Promise
	 */
	async switchAgent(tabId: TabId, providerId: ProviderId): Promise<void> {
		if (!this.lifecycleActive) {
			return;
		}
		if (!this.registeredTabs.has(tabId)) {
			this.failWithoutTransition(
				tabId,
				null,
				'session_not_found',
				START_ERROR_MESSAGES.unknownTab,
				false,
			);
			return;
		}

		this.providerByTab.set(tabId, providerId);

		const current = this.getActiveSession(tabId);
		let pendingCleanup = this.getTabProcessCleanup(tabId);
		if (current !== undefined) {
			pendingCleanup = this.cleanupSessionProcessTree(current);
			this.removeSession(current.sessionId);
		}
		if (pendingCleanup !== undefined) {
			await pendingCleanup;
		}
		if (
			!this.lifecycleActive
			|| !this.registeredTabs.has(tabId)
			|| this.providerByTab.get(tabId) !== providerId
			|| this.getActiveSession(tabId) !== undefined
		) {
			return;
		}

		const dimensions = this.lastDimensionsByTab.get(tabId);
		if (dimensions === undefined) {
			/** 크기를 알기 전에 시작하면 첫 화면이 잘못된 폭으로 그려지므로 기다린다. */
			return;
		}

		await this.startSession(tabId, dimensions.cols, dimensions.rows);
	}

	/**
	 * 검증된 `terminal.ready`를 탭 표면 준비 신호로 처리한다.
	 * provider가 아직 정해지지 않은 탭은 크기만 기록하고 세션을 시작하지 않으므로
	 * provider 선택과 표면 준비 중 나중에 도착한 쪽이 첫 세션 시작을 유발한다.
	 *
	 * @param tabId 프로토콜 검증을 통과한 Webview 소유 탭 식별자
	 * @param cols 프로토콜 검증을 통과한 초기 터미널 열 수
	 * @param rows 프로토콜 검증을 통과한 초기 터미널 행 수
	 * @returns 필요한 경우의 시작 흐름까지 끝나면 완료되는 Promise
	 */
	async handleTerminalReady(
		tabId: TabId,
		cols: number,
		rows: number,
	): Promise<void> {
		if (!this.lifecycleActive) {
			return;
		}
		if (!this.registeredTabs.has(tabId)) {
			this.failWithoutTransition(
				tabId,
				null,
				'session_not_found',
				START_ERROR_MESSAGES.unknownTab,
				false,
			);
			return;
		}

		this.lastDimensionsByTab.set(tabId, { cols, rows });
		if (!this.providerByTab.has(tabId)) {
			return;
		}

		const pendingCleanup = this.getTabProcessCleanup(tabId);
		if (pendingCleanup !== undefined) {
			await pendingCleanup;
		}
		if (
			!this.lifecycleActive
			|| !this.registeredTabs.has(tabId)
			|| !this.providerByTab.has(tabId)
		) {
			return;
		}

		const current = this.getActiveSession(tabId);
		if (
			current !== undefined
			&& (
				current.state.kind === 'starting'
				|| current.state.kind === 'running'
				|| current.state.kind === 'stopping'
			)
		) {
			return;
		}

		await this.startSession(tabId, cols, rows);
	}

	/**
	 * 탭에 배정된 provider 식별자를 조회한다.
	 *
	 * @param tabId 조회할 Webview 소유 탭 식별자
	 * @returns 배정된 provider 또는 아직 선택되지 않았으면 `undefined`
	 */
	getTabProvider(tabId: TabId): ProviderId | undefined {
		return this.providerByTab.get(tabId);
	}

	/**
	 * Webview가 마지막으로 알린 활성 탭을 조회한다.
	 *
	 * @returns 현재 활성 탭 식별자 또는 활성 탭이 없으면 `undefined`
	 */
	getActiveTabId(): TabId | undefined {
		return this.activeTabId;
	}

	/**
	 * 탭이 Host에 등록되어 있는지 확인한다.
	 *
	 * @param tabId 확인할 Webview 소유 탭 식별자
	 * @returns 아직 닫히지 않은 등록된 탭이면 `true`
	 */
	hasTab(tabId: TabId): boolean {
		return this.registeredTabs.has(tabId);
	}

	/**
	 * 검증된 `terminal.ready` 값으로 새 PTY 세션을 시작한다.
	 * `sessionId`와 실행 계약은 Host만 생성하며 중복 요청이나 내부 실패를 던지지 않고
	 * 고정된 `terminal.error` 결과로 변환한다.
	 *
	 * @param tabId 프로토콜 검증을 통과한 Webview 소유 탭 식별자
	 * @param cols 프로토콜 검증을 통과한 초기 터미널 열 수
	 * @param rows 프로토콜 검증을 통과한 초기 터미널 행 수
	 * @returns 시작 흐름과 메시지 발행이 끝나면 완료되는 Promise
	 */
	async startSession(
		tabId: TabId,
		cols: number,
		rows: number,
	): Promise<void> {
		if (!this.lifecycleActive) {
			return;
		}
		const current = this.getActiveSession(tabId);
		if (
			current !== undefined
			&& (
				current.state.kind === 'starting'
				|| current.state.kind === 'running'
				|| current.state.kind === 'stopping'
			)
		) {
			this.failWithoutTransition(
				tabId,
				current,
				'invalid_session_state',
				START_ERROR_MESSAGES.duplicate,
				false,
			);
			return;
		}

		let session: TerminalSession | undefined;
		if (current?.state.kind === 'idle') {
			session = current;
		} else {
			if (current !== undefined) {
				this.clearMcpStatus(current);
				this.activeSessionByTab.delete(tabId);
			}
			session = this.createSession(tabId);
		}
		if (session === undefined) {
			this.failWithoutTransition(
				tabId,
				null,
				'internal_error',
				START_ERROR_MESSAGES.registration,
				true,
			);
			return;
		}

		try {
			session.markStarting();
		} catch {
			this.failWithoutTransition(
				tabId,
				null,
				'internal_error',
				START_ERROR_MESSAGES.registration,
				true,
			);
			return;
		}

		const providerId = this.providerByTab.get(tabId);
		if (providerId === 'codex') {
			this.mcpStatusBySession.set(session.sessionId, {
				status: 'preparing',
				published: false,
			});
		}
		this.publish({ type: 'terminal.starting', tabId });

		if (
			providerId === 'codex'
			&& this.prepareCodexLaunch !== undefined
			&& this.mcpSupervisor !== undefined
		) {
			await this.startCodexSession(session, cols, rows);
			return;
		}
		if (
			providerId === 'claude'
			&& this.prepareClaudeLaunch !== undefined
			&& this.mcpSupervisor !== undefined
		) {
			await this.startClaudeSession(session, cols, rows);
			return;
		}

		let preparation: Awaited<ReturnType<PrepareTerminalLaunch>>;
		try {
			preparation = await this.prepareLaunch(tabId, session.sessionId);
		} catch {
			if (!this.lifecycleActive || !this.isCurrentSession(session)) {
				return;
			}
			this.failSession(
				session,
				'internal_error',
				START_ERROR_MESSAGES.preparation,
				true,
			);
			return;
		}

		if (!this.lifecycleActive || !this.isCurrentSession(session)) {
			/** detach 중 완료된 준비 작업이 session 상태나 native PTY를 변경하지 못하게 한다. */
			return;
		}

		if (!preparation.ok) {
			session.markError(preparation.error.code);
			this.publish(preparation.error);
			return;
		}

		let autoRunInput: string | undefined;
		if (providerId !== undefined) {
			try {
				autoRunInput = await this.resolveProviderAutoRunInput(
					providerId,
					preparation.policy,
				);
			} catch {
				/** 탐색 경계 자체의 실패는 기존 기본 command로 안전하게 복구한다. */
				autoRunInput = resolveAgentAutoRunInput(providerId);
			}
		}

		if (!this.lifecycleActive || !this.isCurrentSession(session)) {
			/** stale 탐색 결과가 교체되거나 닫힌 session에 입력되지 않게 한다. */
			return;
		}
		if (autoRunInput !== undefined) {
			this.providerAutoRunInputBySession.set(session.sessionId, autoRunInput);
		}

		this.lastDimensionsByTab.set(tabId, { cols, rows });
		try {
			await session.start(preparation.policy, cols, rows);
		} catch {
			this.providerAutoRunInputBySession.delete(session.sessionId);
			if (!this.lifecycleActive || !this.isCurrentSession(session)) {
				return;
			}
			this.failSession(
				session,
				'start_failed',
				START_ERROR_MESSAGES.spawn,
				true,
			);
		}
	}

	/** Codex의 검증된 config style을 공통 direct-PTY transaction에 연결한다. */
	private startCodexSession(
		session: TerminalSession,
		cols: number,
		rows: number,
	): Promise<void> {
		const prepare = this.prepareCodexLaunch;
		if (prepare === undefined) {
			return Promise.resolve();
		}
		return this.startStructuredMcpProviderSession(session, cols, rows, {
			providerId: 'codex',
			prepare,
			canUseMcp: (preparation) =>
				preparation.shellEnvironmentPolicyStyle !== undefined,
			buildMcpPlan: (preparation, connection) => this.buildCodexMcpPlan({
				executable: preparation.executable,
				cwd: preparation.cwd,
				connection,
				shellEnvironmentPolicyStyle:
					preparation.shellEnvironmentPolicyStyle!,
			}),
			buildBarePlan: (preparation) => this.buildCodexBarePlan({
				executable: preparation.executable,
				cwd: preparation.cwd,
			}),
			publishStartupFailures: true,
		});
	}

	/** Claude compatibility gate 통과 뒤에만 session MCP를 준비하고 그 외에는 bare로 연다. */
	private startClaudeSession(
		session: TerminalSession,
		cols: number,
		rows: number,
	): Promise<void> {
		const prepare = this.prepareClaudeLaunch;
		if (prepare === undefined) {
			return Promise.resolve();
		}
		return this.startStructuredMcpProviderSession(session, cols, rows, {
			providerId: 'claude',
			prepare,
			canUseMcp: (preparation) => preparation.mcpCompatible,
			buildMcpPlan: (preparation, connection) => this.buildClaudeMcpPlan({
				executable: preparation.executable,
				cwd: preparation.cwd,
				connection,
			}),
			buildBarePlan: (preparation) => this.buildClaudeBarePlan({
				executable: preparation.executable,
				cwd: preparation.cwd,
			}),
			publishStartupFailures: false,
			onAuthenticatedRequestReady: (
				currentSession,
				preparation,
				plan,
				generation,
			) => {
				if (plan.mcpServerName === undefined) {
					throw new Error('Authenticated Claude plan has no server name.');
				}
				this.claudeStartupBySession.set(currentSession.sessionId, {
					generation,
					serverName: plan.mcpServerName,
					preparation,
					output: '',
					interactiveInputObserved: false,
					activityObserved: false,
				});
			},
		});
	}

	/** ready→registered 뒤에만 authenticated plan을 만들고 startup MCP 실패는 bare로 연다. */
	private async startStructuredMcpProviderSession<
		TPreparation extends PreparedStructuredProviderLaunch,
	>(
		session: TerminalSession,
		cols: number,
		rows: number,
		options: StructuredMcpProviderStartOptions<TPreparation>,
	): Promise<void> {
		const supervisor = this.mcpSupervisor;
		if (supervisor === undefined) {
			return;
		}
		const recordStartupFailure = (reason: McpFailureReason): void => {
			if (options.publishStartupFailures) {
				this.recordMcpFailure(session, reason);
			}
		};

		let preparationResult: StructuredProviderPreparation<TPreparation>;
		try {
			preparationResult = await options.prepare(
				session.tabId,
				session.sessionId,
			);
		} catch {
			if (this.isCurrentProviderSession(session, options.providerId)) {
				this.failSession(
					session,
					'internal_error',
					START_ERROR_MESSAGES.preparation,
					true,
				);
			}
			return;
		}

		if (!this.isCurrentProviderSession(session, options.providerId)) {
			return;
		}
		if (!preparationResult.ok) {
			session.markError(preparationResult.error.code);
			this.publish(preparationResult.error);
			return;
		}

		const preparation = preparationResult.preparation;
		const canUseMcp = options.canUseMcp(preparation);
		let prepared: McpPrepareResult | undefined;
		if (canUseMcp) {
			try {
				prepared = await supervisor.prepareSession(session.sessionId);
			} catch {
				recordStartupFailure('adapter_start_failed');
			}
		} else if (options.providerId === 'codex') {
			recordStartupFailure('safe_session_injection_unavailable');
		}
		if (prepared !== undefined && !prepared.ok) {
			recordStartupFailure(prepared.failure.reason);
		}

		if (!this.isCurrentProviderSession(session, options.providerId)) {
			await this.cleanupMcpSession(session.sessionId);
			return;
		}

		let plan: AgentLaunchPlan | undefined;
		let generation: string | undefined;
		if (prepared?.ok && canUseMcp) {
			generation = prepared.connection.generation;
			const runtime = supervisor.getSessionRuntime(session.sessionId);
			if (
				runtime !== undefined
				&& runtime.generation === generation
				&& runtime.lifecycle === 'running'
			) {
				this.mcpRuntimeBySession.set(session.sessionId, {
					providerId: options.providerId,
					generation,
				});
				try {
					plan = await options.buildMcpPlan(
						preparation,
						prepared.connection,
					);
				} catch {
					recordStartupFailure('provider_config_rejected');
				}
			}
		}

		if (!this.isCurrentProviderSession(session, options.providerId)) {
			await this.cleanupMcpSession(session.sessionId);
			return;
		}
		if (
			plan === undefined
			|| generation === undefined
			|| plan.providerId !== options.providerId
			|| !plan.expectsMcp
			|| plan.mcpServerName === undefined
			|| !this.isCurrentMcpRuntime(
				session,
				options.providerId,
				generation,
			)
		) {
			if (
				generation !== undefined
				&& this.mcpStatusBySession.get(session.sessionId)?.status !== 'failed'
			) {
				const runtime = supervisor.getSessionRuntime(session.sessionId);
				recordStartupFailure(
					runtime === undefined || runtime.lifecycle !== 'running'
						? 'adapter_exited'
						: 'provider_config_rejected',
				);
			}
			await this.cleanupMcpSession(session.sessionId);
			if (!this.isCurrentProviderSession(session, options.providerId)) {
				return;
			}
			generation = undefined;
			try {
				plan = await options.buildBarePlan(preparation);
			} catch {
				plan = undefined;
			}
		}

		if (
			!this.isCurrentProviderSession(session, options.providerId)
			|| plan === undefined
			|| plan.providerId !== options.providerId
			|| plan.expectsMcp !== (generation !== undefined)
		) {
			if (generation !== undefined) {
				await this.cleanupMcpSession(session.sessionId);
			}
			if (
				plan === undefined
				&& this.isCurrentProviderSession(session, options.providerId)
			) {
				this.failSession(
					session,
					'start_failed',
					START_ERROR_MESSAGES.spawn,
					true,
				);
			}
			return;
		}

		let request: AgentProcessSpawnRequest | undefined;
		try {
			request = await this.createAgentSpawnRequest(plan, {
				platform: preparation.platform,
				environment: preparation.environment,
			});
			if (generation !== undefined) {
				options.onAuthenticatedRequestReady?.(
					session,
					preparation,
					plan,
					generation,
				);
			}
		} catch {
			request = undefined;
			if (generation !== undefined) {
				recordStartupFailure('safe_session_injection_unavailable');
			}
		}

		if (!this.isCurrentProviderSession(session, options.providerId)) {
			await this.cleanupMcpSession(session.sessionId);
			return;
		}
		if (
			generation !== undefined
			&& (
				request === undefined
				|| !this.isCurrentMcpRuntime(
					session,
					options.providerId,
					generation,
				)
			)
		) {
			if (this.mcpStatusBySession.get(session.sessionId)?.status !== 'failed') {
				recordStartupFailure('adapter_exited');
			}
			await this.cleanupMcpSession(session.sessionId);
			if (!this.isCurrentProviderSession(session, options.providerId)) {
				return;
			}
			generation = undefined;
			try {
				plan = await options.buildBarePlan(preparation);
				if (
					plan.providerId !== options.providerId
					|| plan.expectsMcp
				) {
					throw new Error('Invalid bare provider launch plan.');
				}
				request = await this.createAgentSpawnRequest(plan, {
					platform: preparation.platform,
					environment: preparation.environment,
				});
			} catch {
				request = undefined;
			}
		}

		if (
			!this.isCurrentProviderSession(session, options.providerId)
			|| request === undefined
			|| (generation !== undefined && !this.isCurrentMcpRuntime(
				session,
				options.providerId,
				generation,
			))
		) {
			if (generation !== undefined) {
				await this.cleanupMcpSession(session.sessionId);
			}
			if (
				request === undefined
				&& this.isCurrentProviderSession(session, options.providerId)
			) {
				this.failSession(
					session,
					'start_failed',
					START_ERROR_MESSAGES.spawn,
					true,
				);
			}
			return;
		}

		this.lastDimensionsByTab.set(session.tabId, { cols, rows });
		if (generation === undefined) {
			this.mcpRuntimeBySession.delete(session.sessionId);
		} else {
			this.mcpRuntimeBySession.set(session.sessionId, {
				providerId: options.providerId,
				generation,
			});
			if (options.publishStartupFailures) {
				this.setMcpAwaitingActivity(session);
			}
		}
		this.mcpPtySpawnStarted.add(session.sessionId);
		try {
			await this.spawnProviderPty(session, request, cols, rows);
		} catch (error: unknown) {
			if (error instanceof TerminalProcessExitedBeforeReadyError) {
				if (!this.isCurrentProviderSession(session, options.providerId)) {
					await this.cleanupMcpSession(session.sessionId);
					return;
				}
				this.handleProviderExitBeforeReady(session, error);
				return;
			}
			const authenticatedSpawnFailed = generation !== undefined;
			if (authenticatedSpawnFailed) {
				recordStartupFailure('safe_session_injection_unavailable');
			}
			this.mcpPtySpawnStarted.delete(session.sessionId);
			await this.cleanupMcpSession(session.sessionId);
			if (!this.isCurrentProviderSession(session, options.providerId)) {
				return;
			}

			if (authenticatedSpawnFailed) {
				let bareRequest: AgentProcessSpawnRequest | undefined;
				try {
					const barePlan = await options.buildBarePlan(preparation);
					if (
						barePlan.providerId !== options.providerId
						|| barePlan.expectsMcp
					) {
						throw new Error('Invalid bare provider launch plan.');
					}
					bareRequest = await this.createAgentSpawnRequest(barePlan, {
						platform: preparation.platform,
						environment: preparation.environment,
					});
				} catch {
					/** Authenticated native spawn failure receives at most one bare retry. */
				}

				if (!this.isCurrentProviderSession(session, options.providerId)) {
					return;
				}
				if (bareRequest !== undefined) {
					this.mcpPtySpawnStarted.add(session.sessionId);
					try {
						await this.spawnProviderPty(
							session,
							bareRequest,
							cols,
							rows,
						);
						return;
					} catch {
						this.mcpPtySpawnStarted.delete(session.sessionId);
					}
				}
			}

			this.failSession(
				session,
				'start_failed',
				START_ERROR_MESSAGES.spawn,
				true,
			);
			return;
		}

		if (!this.isCurrentProviderSession(session, options.providerId)) {
			await this.cleanupMcpSession(session.sessionId);
		}
	}

	/** 실제 PID가 준비된 현재 session에만 started와 provider 입력을 한 번 전달한다. */
	private handleSessionRunning(session: TerminalSession): void {
		if (
			!this.lifecycleActive
			|| !this.isCurrentSession(session)
			|| session.state.kind !== 'running'
		) {
			return;
		}

		const mcpRuntime = this.mcpRuntimeBySession.get(session.sessionId);
		if (
			mcpRuntime !== undefined
			&& this.mcpPtySpawnStarted.has(session.sessionId)
		) {
			const runtime = this.mcpSupervisor?.getSessionRuntime(session.sessionId);
			if (
				runtime !== undefined
				&& runtime.generation === mcpRuntime.generation
				&& runtime.lifecycle === 'running'
			) {
				runtime.markProviderStarted();
			}
		}

		this.publish({
			type: 'terminal.started',
			tabId: session.tabId,
			sessionId: session.sessionId,
		});
		this.publishCurrentMcpStatus(session);
		this.runProviderAutoStart(session);
	}

	/**
	 * 시작된 Shell 위에서 세션 준비 중 탐색을 마친 provider CLI 입력을 전달한다.
	 * 커맨드는 Host resolver에서만 결정되며 Webview가 보낸 값은 사용하지 않는다.
	 *
	 * @param session 방금 running 상태가 된 탭의 현재 세션
	 */
	private runProviderAutoStart(session: TerminalSession): void {
		if (session.state.kind !== 'running') {
			return;
		}

		const autoRunInput = this.providerAutoRunInputBySession.get(session.sessionId);
		this.providerAutoRunInputBySession.delete(session.sessionId);
		if (autoRunInput === undefined) {
			return;
		}

		this.performPtyOperation(
			session,
			() => session.writeInput(autoRunInput),
		);
	}

	/**
	 * 검증된 `terminal.input`을 현재 탭이 소유한 실행 중 세션으로 전달한다.
	 * 소유권이 다르거나 stale 또는 non-running 세션이면 입력을 전달하지 않는다.
	 *
	 * @param message 프로토콜 검증을 통과한 terminal 입력 메시지
	 */
	routeInput(
		message: Extract<WebviewToHostMessage, { type: 'terminal.input' }>,
	): void {
		const session = this.getOwnedRunningSession(
			message.tabId,
			message.sessionId,
		);
		if (session === undefined) {
			return;
		}
		const claudeStartup = this.claudeStartupBySession.get(session.sessionId);
		if (claudeStartup !== undefined) {
			claudeStartup.interactiveInputObserved = true;
		}

		this.performPtyOperation(
			session,
			() => session.writeInput(message.data),
		);
	}

	/**
	 * 검증된 `terminal.resize`를 현재 탭이 소유한 실행 중 세션으로 전달한다.
	 * 소유권이 다르거나 stale 또는 non-running 세션이면 크기를 변경하지 않는다.
	 *
	 * @param message 프로토콜 검증을 통과한 terminal 크기 메시지
	 */
	routeResize(
		message: Extract<WebviewToHostMessage, { type: 'terminal.resize' }>,
	): void {
		const session = this.getOwnedRunningSession(
			message.tabId,
			message.sessionId,
		);
		if (session === undefined) {
			return;
		}

		this.lastDimensionsByTab.set(message.tabId, {
			cols: message.cols,
			rows: message.rows,
		});
		this.performPtyOperation(
			session,
			() => session.resize(message.cols, message.rows),
		);
	}

	/**
	 * 검증된 `terminal.restart`로 같은 탭의 세션을 새 `sessionId`로 다시 시작한다.
	 * 요청은 소유 관계만 지정하므로 실행 계약과 terminal 크기는 Host가 다시 결정하며,
	 * 시작 흐름은 workspace/Shell 정책 재검증을 포함한 `startSession`을 그대로 재사용한다.
	 *
	 * @param tabId 프로토콜 검증을 통과한 Webview 소유 탭 식별자
	 * @param sessionId 재시작 대상으로 지목된 Host 소유 세션 식별자
	 * @returns 정리와 재시작 흐름이 끝나면 완료되는 Promise
	 */
	async restartSession(tabId: TabId, sessionId: SessionId): Promise<void> {
		if (!this.lifecycleActive) {
			return;
		}
		const session = this.sessionsById.get(sessionId);
		if (session === undefined || !this.ownsSession(tabId, sessionId)) {
			this.failWithoutTransition(
				tabId,
				null,
				'session_not_found',
				START_ERROR_MESSAGES.restartUnknown,
				false,
			);
			return;
		}

		if (
			session.state.kind === 'starting'
			|| session.state.kind === 'running'
			|| session.state.kind === 'stopping'
		) {
			this.failWithoutTransition(
				tabId,
				session,
				'invalid_session_state',
				START_ERROR_MESSAGES.restartInProgress,
				false,
			);
			return;
		}

		if (session.state.kind === 'disposed') {
			this.failWithoutTransition(
				tabId,
				session,
				'invalid_session_state',
				START_ERROR_MESSAGES.restartUnavailable,
				false,
			);
			return;
		}

		const registeredAtRestart = this.registeredTabs.has(tabId);
		const providerAtRestart = this.providerByTab.get(tabId);
		const pendingCleanup = this.cleanupSessionProcessTree(session);
		this.removeSession(sessionId);
		await pendingCleanup;
		if (
			!this.lifecycleActive
			|| this.getActiveSession(tabId) !== undefined
			|| (
				registeredAtRestart
				&& (
					!this.registeredTabs.has(tabId)
					|| this.providerByTab.get(tabId) !== providerAtRestart
				)
			)
		) {
			return;
		}

		const dimensions = this.lastDimensionsByTab.get(tabId)
			?? RESTART_FALLBACK_DIMENSIONS;
		await this.startSession(tabId, dimensions.cols, dimensions.rows);
	}

	/**
	 * retryable MCP failure에서만 실행 중 Codex와 adapter를 함께 정리하고 fresh session을 만든다.
	 * 같은 탭의 동시 요청은 최초 transaction Promise를 공유하며 다른 탭과는 독립적이다.
	 */
	restartMcpSession(tabId: TabId, sessionId: SessionId): Promise<void> {
		const existing = this.mcpRestartByTab.get(tabId);
		if (existing !== undefined) {
			return existing;
		}
		if (!this.canRestartMcpSession(tabId, sessionId)) {
			return Promise.resolve();
		}

		const restart = Promise.resolve().then(() =>
			this.performMcpRestart(tabId, sessionId)
		).finally(() => {
			if (this.mcpRestartByTab.get(tabId) === restart) {
				this.mcpRestartByTab.delete(tabId);
			}
		});
		this.mcpRestartByTab.set(tabId, restart);
		return restart;
	}

	private canRestartMcpSession(tabId: TabId, sessionId: SessionId): boolean {
		const session = this.sessionsById.get(sessionId);
		const status = this.mcpStatusBySession.get(sessionId);
		return this.lifecycleActive
			&& session !== undefined
			&& this.ownsSession(tabId, sessionId)
			&& this.providerByTab.get(tabId) === 'codex'
			&& session.state.kind === 'running'
			&& status?.status === 'failed'
			&& status.failure !== undefined
			&& retryabilityByFailureReason[status.failure.reason];
	}

	private async performMcpRestart(
		tabId: TabId,
		sessionId: SessionId,
	): Promise<void> {
		if (!this.canRestartMcpSession(tabId, sessionId)) {
			return;
		}
		const session = this.sessionsById.get(sessionId);
		if (session === undefined) {
			return;
		}

		const dimensions = this.lastDimensionsByTab.get(tabId)
			?? RESTART_FALLBACK_DIMENSIONS;
		this.clearMcpStatus(session);
		const cleanup = this.cleanupSessionProcessTree(session);
		this.removeSession(sessionId);
		await cleanup;
		if (
			!this.lifecycleActive
			|| !this.registeredTabs.has(tabId)
			|| this.providerByTab.get(tabId) !== 'codex'
			|| this.getActiveSession(tabId) !== undefined
			|| !this.mcpRestartByTab.has(tabId)
		) {
			return;
		}

		await this.startSession(tabId, dimensions.cols, dimensions.rows);
	}

	/**
	 * Host가 새 `sessionId`를 생성하여 탭의 현재 세션을 등록한다.
	 * Webview가 제공한 `sessionId`를 받을 수 있는 인자는 두지 않는다.
	 *
	 * @param tabId Webview가 생성하고 프로토콜 검증을 통과한 탭 식별자
	 * @returns 대기 상태로 등록된 새 `TerminalSession` 또는 등록할 수 없으면 `undefined`
	 */
	private createSession(tabId: TabId): TerminalSession | undefined {
		if (this.activeSessionByTab.has(tabId)) {
			return undefined;
		}

		const generatedSessionId = generateTerminalSessionId();
		if (this.sessionsById.has(generatedSessionId)) {
			return undefined;
		}

		let session!: TerminalSession;
		session = new TerminalSession({
			tabId,
			sessionId: generatedSessionId,
			ptyAdapter: this.ptyAdapter,
			onOutput: (data) => this.routeOutput(session, data),
			onExit: (event) => this.routeExit(session, event),
			onRunning: () => this.handleSessionRunning(session),
		});
		this.sessionsById.set(generatedSessionId, session);
		this.activeSessionByTab.set(tabId, generatedSessionId);
		return session;
	}

	/** Webview가 dispose된 뒤 terminal output과 lifecycle message 전송을 중단한다. */
	stopMessageDelivery(): void {
		this.messageDeliveryActive = false;
	}

	/**
	 * Panel과 Webview routing을 native 종료 작업에서 동기적으로 분리한다.
	 * 이 경로에서는 PTY kill이나 외부 명령을 호출하지 않으며, 최초 호출에서 확보한
	 * runtime 소유 process handle만 `terminate()`가 이후 PID 준비와 snapshot에 사용한다.
	 */
	detach(): void {
		if (!this.lifecycleActive) {
			return;
		}

		this.lifecycleActive = false;
		this.stopMessageDelivery();
		this.beginMcpTermination();
		const processes: PtyProcessHandle[] = [];
		for (const session of [...this.sessionsById.values()]) {
			if (session.state.kind === 'running') {
				try {
					session.markStopping();
				} catch {
					/** 상태 표시 실패도 동기 routing 분리를 막지 않는다. */
				}
			}

			try {
				const process = session.detachProcess();
				if (process !== undefined) {
					processes.push(process);
				}
			} catch {
				/** listener 해제 실패도 다른 session 분리를 막지 않는다. */
			}

			try {
				session.markDisposed();
			} catch {
				/** 최종 상태 표시 실패를 Panel lifecycle 밖으로 전파하지 않는다. */
			}
		}

		this.detachedProcesses = Object.freeze([...new Set(processes)]);
		this.sessionsById.clear();
		this.activeSessionByTab.clear();
		this.providerAutoRunInputBySession.clear();
		this.mcpRuntimeBySession.clear();
		this.mcpPtySpawnStarted.clear();
		this.claudeStartupBySession.clear();
		this.mcpStatusBySession.clear();
		this.mcpRestartByTab.clear();
		this.lastDimensionsByTab.clear();
		this.registeredTabs.clear();
		this.providerByTab.clear();
		this.activeTabId = undefined;
	}

	/**
	 * detach에서 확보한 process마다 PID 준비를 기다린 뒤 snapshot과 OS adapter로 정리한다.
	 * 여러 session 중 하나가 실패해도 나머지를 계속하며 반복 호출은 같은 Promise를 반환한다.
	 *
	 * @returns 모든 root 정리가 완료되면 이행되는 최초 cleanup Promise
	 */
	terminate(): Promise<void> {
		this.detach();
		this.terminationPromise ??= Promise.all([
			this.mcpTerminationPromise ?? Promise.resolve(),
			...this.processCleanupBySession.values(),
			...this.detachedProcesses.map((process) =>
				this.terminateProcessTree(process)
			),
		]).then(() => undefined, () => undefined);
		return this.terminationPromise;
	}

	/** PID가 지연되는 ConPTY도 handle을 보존해 준비 후 process tree를 종료한다. */
	private async terminateProcessTree(
		process: PtyProcessHandle,
	): Promise<void> {
		let rootPid = process.pid;
		if (!isValidProcessTreeRootPid(rootPid)) {
			try {
				rootPid = await process.waitForReadyPid({
					timeoutMs: DETACHED_PID_READY_TIMEOUT_MS,
				});
			} catch {
				this.killProcessHandle(process);
				return;
			}
		}
		if (!isValidProcessTreeRootPid(rootPid)) {
			this.killProcessHandle(process);
			return;
		}

		try {
			const capture = await this.processTreeController.capture(rootPid);
			if (capture.status !== 'captured') {
				this.killProcessHandle(process);
				return;
			}
			const result = await this.processTreeController.terminate(capture.snapshot);
			if (
				result.outcome !== 'gracefully_terminated'
				&& result.outcome !== 'already_terminated'
				&& result.outcome !== 'force_terminated'
			) {
				this.killProcessHandle(process);
			}
		} catch {
			this.killProcessHandle(process);
		}
	}

	private killProcessHandle(process: PtyProcessHandle): void {
		try {
			process.kill();
		} catch {
			/** 비동기 fallback kill 실패도 다른 process와 MCP 정리를 막지 않는다. */
		}
	}

	/**
	 * 실행 중 session을 routing에서 즉시 분리하고 전체 process tree를 비동기로 종료한다.
	 * 유효 PID를 확보할 수 없거나 capture/terminate가 실패하면 root handle kill로 수렴한다.
	 * 같은 session의 반복 요청은 최초 cleanup Promise를 재사용한다.
	 */
	private cleanupSessionProcessTree(session: TerminalSession): Promise<void> {
		const existing = this.processCleanupBySession.get(session.sessionId);
		if (existing !== undefined) {
			return existing;
		}

		const mcpCleanup = this.cleanupMcpSession(session.sessionId);
		if (session.state.kind === 'running') {
			try {
				session.markStopping();
			} catch {
				/** 상태 표시 실패도 routing 분리와 process-tree 정리를 막지 않는다. */
			}
		}

		let process: PtyProcessHandle | undefined;
		try {
			process = session.detachProcess();
		} catch {
			/** handle 분리 실패도 최종 상태 전이와 MCP 정리를 막지 않는다. */
		}

		try {
			session.markDisposed();
		} catch {
			/** 상태 전이 실패도 이미 분리한 handle 정리를 막지 않는다. */
		}

		const cleanup = Promise.all([
			mcpCleanup,
			process === undefined
				? Promise.resolve()
				: this.terminateProcessTree(process),
		]).then(() => undefined, () => undefined);
		this.processCleanupBySession.set(session.sessionId, cleanup);
		this.processCleanupByTab.set(session.tabId, cleanup);
		void cleanup.then(() => {
			if (this.processCleanupBySession.get(session.sessionId) === cleanup) {
				this.processCleanupBySession.delete(session.sessionId);
			}
			if (this.processCleanupByTab.get(session.tabId) === cleanup) {
				this.processCleanupByTab.delete(session.tabId);
			}
		});
		return cleanup;
	}

	/** 같은 탭에서 앞서 분리한 process tree가 끝날 때까지만 다음 시작을 보류한다. */
	private getTabProcessCleanup(tabId: TabId): Promise<void> | undefined {
		return this.processCleanupByTab.get(tabId);
	}

	/**
	 * Panel dispose와 Extension deactivate가 공유하는 Host 전체 정리 경계다.
	 * 메시지 전송을 먼저 중단한 뒤 등록된 모든 세션을 재시작 흐름과 동일한
	 * 입력 차단 → 크기 변경 차단 → PTY 종료 → listener 해제 순서로 정리하고
	 * 마지막으로 세션 및 탭 참조를 제거한다. 반복 호출해도 안전하다.
	 * 개별 세션 정리 실패는 남은 세션 정리나 호출자에게 전파하지 않는다.
	 */
	dispose(): void {
		if (!this.lifecycleActive) {
			return;
		}
		this.lifecycleActive = false;
		this.stopMessageDelivery();
		this.beginMcpTermination();

		for (const session of [...this.sessionsById.values()]) {
			this.disposeSessionProcess(session);
		}

		this.sessionsById.clear();
		this.activeSessionByTab.clear();
		this.providerAutoRunInputBySession.clear();
		this.mcpRuntimeBySession.clear();
		this.mcpPtySpawnStarted.clear();
		this.claudeStartupBySession.clear();
		this.mcpStatusBySession.clear();
		this.mcpRestartByTab.clear();
		this.lastDimensionsByTab.clear();
		this.registeredTabs.clear();
		this.providerByTab.clear();
		this.activeTabId = undefined;
	}

	/** 현재 소유 session에서 온 PTY output만 정확한 identity와 함께 전달한다. */
	private routeOutput(session: TerminalSession, data: string): void {
		if (
			!this.isCurrentSession(session)
			|| (
				session.state.kind !== 'running'
				&& session.state.kind !== 'stopping'
			)
		) {
			return;
		}
		this.appendClaudeStartupOutput(session.sessionId, data);

		this.publish({
			type: 'terminal.output',
			tabId: session.tabId,
			sessionId: session.sessionId,
			data,
		});
	}

	/** 현재 소유 session의 exit만 상태에 저장하고 Webview에 전달한다. */
	private routeExit(session: TerminalSession, event: PtyExitEvent): void {
		if (
			!this.isCurrentSession(session)
			|| (
				session.state.kind !== 'running'
				&& session.state.kind !== 'stopping'
			)
		) {
			return;
		}

		const signal = event.signal ?? null;
		const claudeFallbackPreparation = this.getClaudeFallbackPreparation(
			session,
			event,
		);
		session.markExited(event.exitCode, signal);
		if (claudeFallbackPreparation !== undefined) {
			void this.relaunchClaudeBareAfterStartupRejection(
				session,
				claudeFallbackPreparation,
			);
			return;
		}
		this.clearMcpStatus(session);
		void this.cleanupMcpSession(session.sessionId);
		this.publish({
			type: 'terminal.exited',
			tabId: session.tabId,
			sessionId: session.sessionId,
			exitCode: event.exitCode,
			...(event.signal === undefined ? {} : { signal: event.signal }),
		});
	}

	/**
	 * A process that exited after native spawn but before PID readiness is not a spawn failure.
	 * Only an exact authenticated Claude startup rejection may relaunch; every other provider exit
	 * becomes a visible start failure without a bare retry.
	 */
	private handleProviderExitBeforeReady(
		session: TerminalSession,
		error: TerminalProcessExitedBeforeReadyError,
	): void {
		error.withBufferedOutput((output) => {
			this.appendClaudeStartupOutput(session.sessionId, output);
		});
		const claudeFallbackPreparation = this.getClaudeFallbackPreparation(
			session,
			error.event,
		);
		if (claudeFallbackPreparation !== undefined) {
			void this.relaunchClaudeBareAfterStartupRejection(
				session,
				claudeFallbackPreparation,
			);
			return;
		}

		this.failSession(
			session,
			'start_failed',
			START_ERROR_MESSAGES.spawn,
			true,
		);
	}

	/** Exact pre-interactive Claude diagnostics are the sole post-spawn bare fallback signal. */
	private getClaudeFallbackPreparation(
		session: TerminalSession,
		event: PtyExitEvent,
	): PreparedClaudeTerminalLaunch | undefined {
		const startup = this.claudeStartupBySession.get(session.sessionId);
		if (startup === undefined) {
			return undefined;
		}
		const rejection = classifyClaudeStartupDiagnostic({
			exitCode: event.exitCode,
			signal: event.signal ?? null,
			reachedInteractivePrompt:
				startup.interactiveInputObserved || startup.activityObserved,
			stderr: startup.output,
			expectedMcpServerName: startup.serverName,
		});
		return rejection === undefined ? undefined : startup.preparation;
	}

	/** Keeps only a small in-memory startup window used by the exact diagnostic classifier. */
	private appendClaudeStartupOutput(sessionId: SessionId, data: string): void {
		const startup = this.claudeStartupBySession.get(sessionId);
		if (startup === undefined) {
			return;
		}
		if (Buffer.byteLength(startup.output, 'utf8') > CLAUDE_STARTUP_DIAGNOSTIC_MAX_BYTES) {
			return;
		}
		const next = `${startup.output}${data}`;
		startup.output = Buffer.byteLength(next, 'utf8')
			> CLAUDE_STARTUP_DIAGNOSTIC_MAX_BYTES
			? '\0'.repeat(CLAUDE_STARTUP_DIAGNOSTIC_MAX_BYTES + 1)
			: next;
	}

	/**
	 * An exact, pre-interactive Claude config/policy rejection gets one fresh bare session.
	 * This path reuses the already resolved executable and never probes or authenticates again,
	 * preventing a fallback loop.
	 */
	private async relaunchClaudeBareAfterStartupRejection(
		oldSession: TerminalSession,
		preparation: PreparedClaudeTerminalLaunch,
	): Promise<void> {
		if (!this.isCurrentProviderSession(oldSession, 'claude')) {
			return;
		}
		const tabId = oldSession.tabId;
		const dimensions = this.lastDimensionsByTab.get(tabId)
			?? RESTART_FALLBACK_DIMENSIONS;
		const mcpCleanup = this.cleanupMcpSession(oldSession.sessionId);
		try {
			oldSession.disposeProcess();
			oldSession.markDisposed();
		} catch {
			/** The exited PTY has no remaining input ownership; MCP cleanup still continues. */
		}
		this.removeSession(oldSession.sessionId);
		await mcpCleanup;

		if (
			!this.lifecycleActive
			|| !this.registeredTabs.has(tabId)
			|| this.providerByTab.get(tabId) !== 'claude'
			|| this.getActiveSession(tabId) !== undefined
		) {
			return;
		}

		const session = this.createSession(tabId);
		if (session === undefined) {
			this.failWithoutTransition(
				tabId,
				null,
				'internal_error',
				START_ERROR_MESSAGES.registration,
				true,
			);
			return;
		}
		try {
			session.markStarting();
		} catch {
			this.failSession(
				session,
				'internal_error',
				START_ERROR_MESSAGES.registration,
				true,
			);
			return;
		}
		this.publish({ type: 'terminal.starting', tabId });

		let request: AgentProcessSpawnRequest | undefined;
		try {
			const plan = await this.buildClaudeBarePlan({
				executable: preparation.executable,
				cwd: preparation.cwd,
			});
			if (plan.providerId !== 'claude' || plan.expectsMcp) {
				throw new Error('Invalid bare Claude launch plan.');
			}
			request = await this.createAgentSpawnRequest(plan, {
				platform: preparation.platform,
				environment: preparation.environment,
			});
		} catch {
			/** The one bare attempt reports start_failed below without another fallback. */
		}

		if (!this.isCurrentProviderSession(session, 'claude')) {
			return;
		}
		if (request === undefined) {
			this.failSession(
				session,
				'start_failed',
				START_ERROR_MESSAGES.spawn,
				true,
			);
			return;
		}

		this.lastDimensionsByTab.set(tabId, dimensions);
		this.mcpPtySpawnStarted.add(session.sessionId);
		try {
			await this.spawnProviderPty(
				session,
				request,
				dimensions.cols,
				dimensions.rows,
			);
		} catch {
			this.mcpPtySpawnStarted.delete(session.sessionId);
			if (this.isCurrentProviderSession(session, 'claude')) {
				this.failSession(
					session,
					'start_failed',
					START_ERROR_MESSAGES.spawn,
					true,
				);
			}
		}
	}

	/** 전달받은 객체가 현재 tab/session 양방향 소유 관계와 동일한지 확인한다. */
	private isCurrentSession(session: TerminalSession): boolean {
		return this.sessionsById.get(session.sessionId) === session
			&& this.activeSessionByTab.get(session.tabId) === session.sessionId;
	}

	/** Session object identity와 현재 provider 배정을 하나의 attempt gate로 검사한다. */
	private isCurrentProviderSession(
		session: TerminalSession,
		providerId: ProviderId,
	): boolean {
		return this.lifecycleActive
			&& this.isCurrentSession(session)
			&& this.providerByTab.get(session.tabId) === providerId;
	}

	/** Current provider attempt와 supervisor runtime generation을 함께 검사한다. */
	private isCurrentMcpRuntime(
		session: TerminalSession,
		providerId: McpProviderId,
		generation: string,
	): boolean {
		const runtime = this.mcpSupervisor?.getSessionRuntime(session.sessionId);
		const ownership = this.mcpRuntimeBySession.get(session.sessionId);
		return this.isCurrentProviderSession(session, providerId)
			&& session.state.kind === 'starting'
			&& ownership?.providerId === providerId
			&& ownership.generation === generation
			&& runtime?.generation === generation
			&& runtime.lifecycle === 'running';
	}

	/** Supervisor event를 current tab/session/provider/generation과 대조해 처리한다. */
	handleMcpRuntimeEvent(event: McpSessionRuntimeEvent): void {
		const session = this.sessionsById.get(event.sessionId);
		const ownership = this.mcpRuntimeBySession.get(event.sessionId);
		if (
			!this.lifecycleActive
			|| session === undefined
			|| ownership === undefined
			|| !this.isCurrentSession(session)
			|| this.providerByTab.get(session.tabId) !== ownership.providerId
			|| ownership.generation !== event.generation
		) {
			return;
		}

		switch (event.type) {
			case 'session.mcpActivityObserved':
				if (ownership.providerId === 'codex') {
					this.setMcpConnected(session);
				} else {
					const startup = this.claudeStartupBySession.get(session.sessionId);
					if (startup?.generation === event.generation) {
						startup.activityObserved = true;
					}
				}
				break;
			case 'runtime.failure':
				if (ownership.providerId === 'codex') {
					this.recordMcpFailure(session, event.failure.reason);
				} else {
					this.claudeStartupBySession.delete(session.sessionId);
					void this.cleanupMcpSession(session.sessionId);
				}
				break;
			case 'session.crispyPingObserved':
				if (ownership.providerId === 'claude') {
					const startup = this.claudeStartupBySession.get(session.sessionId);
					if (startup?.generation === event.generation) {
						startup.activityObserved = true;
					}
				}
				break;
		}
	}

	/** 테스트와 Host state snapshot이 credential-free 내부 상태만 조회하는 경계다. */
	getMcpStatus(sessionId: SessionId): Readonly<InternalMcpStatusRecord> | undefined {
		const status = this.mcpStatusBySession.get(sessionId);
		return status === undefined ? undefined : Object.freeze({ ...status });
	}

	private setMcpAwaitingActivity(session: TerminalSession): void {
		const current = this.mcpStatusBySession.get(session.sessionId);
		if (current?.status === 'failed') {
			return;
		}
		this.mcpStatusBySession.set(session.sessionId, {
			status: 'awaiting_activity',
			published: false,
		});
	}

	private setMcpConnected(session: TerminalSession): void {
		const current = this.mcpStatusBySession.get(session.sessionId);
		if (current?.status === 'connected' || current?.status === 'failed') {
			return;
		}
		this.mcpStatusBySession.set(session.sessionId, {
			status: 'connected',
			published: false,
		});
		this.publishCurrentMcpStatus(session);
	}

	private recordMcpFailure(
		session: TerminalSession,
		reason: McpFailureReason,
	): void {
		const current = this.mcpStatusBySession.get(session.sessionId);
		if (current?.status === 'failed') {
			return;
		}
		this.mcpStatusBySession.set(session.sessionId, {
			status: 'failed',
			failure: createMcpFailure(reason),
			published: false,
		});
		this.publishCurrentMcpStatus(session);
	}

	/** terminal.started 이후의 current session에만 visible status를 한 번 발행한다. */
	private publishCurrentMcpStatus(session: TerminalSession): void {
		if (!this.isCurrentSession(session) || session.state.kind !== 'running') {
			return;
		}
		const record = this.mcpStatusBySession.get(session.sessionId);
		if (record === undefined || record.published) {
			return;
		}
		if (record.status === 'connected') {
			record.published = true;
			this.publish({
				type: 'mcp.statusChanged',
				tabId: session.tabId,
				sessionId: session.sessionId,
				status: 'connected',
			});
			return;
		}
		if (record.status === 'failed' && record.failure !== undefined) {
			record.published = true;
			this.publish({
				type: 'mcp.statusChanged',
				tabId: session.tabId,
				sessionId: session.sessionId,
				status: 'failed',
				reason: record.failure.reason,
				retryable: record.failure.retryable,
			});
		}
	}

	/** old session clear가 fresh session을 지우지 않도록 current ownership에서만 발행한다. */
	private clearMcpStatus(session: TerminalSession): void {
		const record = this.mcpStatusBySession.get(session.sessionId);
		if (record === undefined) {
			return;
		}
		this.mcpStatusBySession.delete(session.sessionId);
		if (!this.isCurrentSession(session)) {
			return;
		}
		this.publish({
			type: 'mcp.statusCleared',
			tabId: session.tabId,
			sessionId: session.sessionId,
		});
	}

	/**
	 * Host의 `sessionId`로 등록된 세션을 조회한다.
	 *
	 * @param sessionId 조회할 Host 소유 세션 식별자
	 * @returns 등록된 `TerminalSession` 또는 찾을 수 없으면 `undefined`
	 */
	getSession(sessionId: SessionId): TerminalSession | undefined {
		return this.sessionsById.get(sessionId);
	}

	/**
	 * `tabId`에 연결된 현재 세션을 소유권 저장소에서 조회한다.
	 *
	 * @param tabId Webview가 소유하는 탭 식별자
	 * @returns 해당 탭의 현재 `TerminalSession` 또는 연결이 없으면 `undefined`
	 */
	getActiveSession(tabId: TabId): TerminalSession | undefined {
		const sessionId = this.activeSessionByTab.get(tabId);
		return sessionId === undefined
			? undefined
			: this.sessionsById.get(sessionId);
	}

	/**
	 * 탭과 세션이 현재 양방향 소유 관계인지 확인한다.
	 * 세션의 `tabId`와 `activeSessionByTab`의 역방향 연결을 모두 검사한다.
	 *
	 * @param tabId 소유 관계를 확인할 Webview 탭 식별자
	 * @param sessionId 소유 관계를 확인할 Host 세션 식별자
	 * @returns 두 저장소와 세션 식별 정보가 모두 일치하면 `true`
	 */
	ownsSession(tabId: TabId, sessionId: SessionId): boolean {
		const session = this.sessionsById.get(sessionId);
		return session !== undefined
			&& session.tabId === tabId
			&& this.activeSessionByTab.get(tabId) === sessionId;
	}

	/**
	 * 세션을 식별자 및 탭 소유권 저장소에서 원자적으로 제거한다.
	 * 생명주기 폐기나 PTY 정리는 수행하지 않으며 후속 단계의 호출자가 먼저 완료해야 한다.
	 *
	 * @param sessionId 제거할 Host 소유 세션 식별자
	 * @returns 제거한 세션 또는 등록된 세션이 없으면 `undefined`
	 */
	removeSession(sessionId: SessionId): TerminalSession | undefined {
		const session = this.sessionsById.get(sessionId);
		if (session === undefined) {
			return undefined;
		}

		this.clearMcpStatus(session);
		this.sessionsById.delete(sessionId);
		this.providerAutoRunInputBySession.delete(sessionId);
		void this.cleanupMcpSession(sessionId);
		if (this.activeSessionByTab.get(session.tabId) === sessionId) {
			this.activeSessionByTab.delete(session.tabId);
		}
		return session;
	}

	/**
	 * 탭과 세션의 양방향 소유권 및 실행 중 상태를 모두 만족하는 세션을 찾는다.
	 *
	 * @param tabId Webview 소유 탭 식별자
	 * @param sessionId Host 소유 세션 식별자
	 * @returns 입력과 크기 변경을 받을 수 있는 세션 또는 `undefined`
	 */
	private getOwnedRunningSession(
		tabId: TabId,
		sessionId: SessionId,
	): TerminalSession | undefined {
		const session = this.sessionsById.get(sessionId);
		return session !== undefined
			&& session.tabId === tabId
			&& this.activeSessionByTab.get(tabId) === sessionId
			&& session.state.kind === 'running'
			? session
			: undefined;
	}

	/**
	 * 재시작 또는 Host 정리 전에 세션의 PTY와 구독을 해제하고 최종 상태로 전이한다.
	 * 실행 중 세션은 stopping을 거쳐 disposed로 전이하므로 정리 시작 시점부터
	 * 새 입력과 크기 변경이 PTY에 전달되지 않는다.
	 * 정리 실패는 원본 예외를 노출하지 않고 새 세션 시작이나 Host 정리 흐름을 막지 않는다.
	 *
	 * @param session PTY를 종료하고 최종 상태로 전이할 세션
	 */
	private disposeSessionProcess(session: TerminalSession): void {
		void this.cleanupMcpSession(session.sessionId);
		if (session.state.kind === 'running') {
			try {
				session.markStopping();
			} catch {
				/** 종료 절차 표시 실패도 PTY 정리를 막지 않게 한다. */
			}
		}

		try {
			session.disposeProcess();
		} catch {
			/** PTY 정리 실패가 새 세션 생성을 막지 않게 한다. */
		}

		try {
			session.markDisposed();
		} catch {
			/** 상태 전이 실패도 재시작 흐름 밖으로 전파하지 않는다. */
		}
	}

	/** Session credential을 먼저 무효화하고 adapter 정리를 멱등 supervisor 경계에 위임한다. */
	private cleanupMcpSession(sessionId: SessionId): Promise<void> {
		this.mcpRuntimeBySession.delete(sessionId);
		this.mcpPtySpawnStarted.delete(sessionId);
		this.claudeStartupBySession.delete(sessionId);
		const supervisor = this.mcpSupervisor;
		if (supervisor === undefined) {
			return Promise.resolve();
		}
		try {
			return supervisor.stopSession(sessionId).catch(() => undefined);
		} catch {
			return Promise.resolve();
		}
	}

	/** Panel detach 시 supervisor를 즉시 closed 상태로 만들고 최초 cleanup Promise를 보존한다. */
	private beginMcpTermination(): void {
		if (this.mcpTerminationPromise !== undefined) {
			return;
		}
		try {
			this.mcpTerminationPromise = this.mcpSupervisor?.dispose()
				.catch(() => undefined)
				?? Promise.resolve();
		} catch {
			this.mcpTerminationPromise = Promise.resolve();
		}
	}

	/**
	 * PTY 동작 실패를 원본 예외 노출 없이 안전한 세션 오류로 전환한다.
	 *
	 * @param session PTY 동작을 수행할 실행 중 세션
	 * @param operation 원본 입력이나 실행 계약을 기록·반사하지 않는 PTY 호출
	 */
	private performPtyOperation(
		session: TerminalSession,
		operation: () => void,
	): void {
		try {
			operation();
		} catch {
			this.failSession(
				session,
				'internal_error',
				START_ERROR_MESSAGES.operation,
				true,
			);
		}
	}

	/**
	 * 생명주기 메시지 전송 실패가 터미널 시작 흐름을 중단하지 않게 한다.
	 *
	 * @param message Webview 전송 계층으로 전달할 Host 메시지
	 */
	private publish(message: HostToWebviewMessage): void {
		if (!this.messageDeliveryActive) {
			return;
		}

		try {
			this.emitMessage(message);
		} catch {
			/** 메시지 전송 생명주기는 PTY 시작 결과와 별도로 관리한다. */
		}
	}

	/**
	 * 시작 중인 세션을 안전한 오류 상태로 전환하고 고정 프로토콜 메시지를 만든다.
	 *
	 * @param session 오류 상태로 전환할 시작 중 세션
	 * @param code Webview에 공개할 허용된 오류 코드
	 * @param message 외부 실행 정보를 포함하지 않는 고정 오류 메시지
	 * @param canRestart Webview에서 재시도를 허용할지 여부
	 */
	private failSession(
		session: TerminalSession,
		code: 'start_failed' | 'internal_error',
		message: string,
		canRestart: boolean,
	): void {
		const ownsDirectProviderPty = this.mcpPtySpawnStarted.has(session.sessionId);
		this.clearMcpStatus(session);
		session.markError(code);
		if (ownsDirectProviderPty) {
			void this.cleanupMcpSession(session.sessionId);
			try {
				session.disposeProcess();
			} catch {
				/** Direct provider failure still converges on listener cleanup. */
			}
		}
		this.failWithoutTransition(
			session.tabId,
			session,
			code,
			message,
			canRestart,
		);
	}

	/**
	 * 세션 상태 변경 없이 고정 `terminal.error`를 발행한다.
	 *
	 * @param tabId 오류가 발생한 Webview 탭 식별자
	 * @param session 관련 세션 또는 등록 전에 실패했을 때의 `null`
	 * @param code Webview에 공개할 허용된 오류 코드
	 * @param message 외부 실행 정보를 포함하지 않는 고정 오류 메시지
	 * @param canRestart Webview에서 재시도를 허용할지 여부
	 */
	private failWithoutTransition(
		tabId: TabId,
		session: TerminalSession | null,
		code:
			| 'invalid_session_state'
			| 'session_not_found'
			| 'start_failed'
			| 'internal_error',
		message: string,
		canRestart: boolean,
	): void {
		const error = {
			type: 'terminal.error',
			tabId,
			sessionId: session?.sessionId ?? null,
			code,
			message,
			canRestart,
		} as const;
		this.publish(error);
	}
}
