import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import type {
	AgentAssignment,
	HostToWebviewMessage,
	SessionId,
	SwitchAttemptId,
	TabId,
	WebviewToHostMessage,
	WorkspaceRootId,
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
} from '../../../mcp/sessionRuntime';
import type { SupervisorRuntimeEvent } from '../../../mcp/adapterSupervisor';
import {
	isValidTaskToolLease,
	type TaskToolLease,
	type TaskToolRequested,
} from '../../../mcp/taskToolProtocol';
import {
	normalizeAgentActivityPath,
	type AgentActivityRequested,
} from '../../../mcp/agentActivityProtocol';
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
import { WORKSPACE_EXECUTION_ERROR_CODES } from '../../protocol/errors';
import {
	mapWorkspaceFailureToMcpRestartRejected,
	mapWorkspaceFailureToTerminalError,
} from '../workspace/workspaceErrorMessage';
import {
	resolveWorkspaceForExecution,
	type WorkspaceResolver,
} from '../workspace/workspaceResolver';
import { readVsCodeWorkspaceTrust } from '../workspace/workspaceContext';
import type {
	ValidatedWorkspaceRoot,
	WorkspaceValidationFailure,
	WorkspaceValidationResult,
} from '../workspace/types';
import {
	TerminalProcessExitedBeforeReadyError,
	TerminalSession,
} from './terminalSession';
import type { ProcessTreeController } from './processTreeController';
import { createHostProcessTreeController } from './processTreeControllerFactory';
import { TerminalSessionIdAllocator } from './terminalSessionIdAllocator';
import { WORKSPACE_ROOT_ID_PREFIX } from '../../../workspace/workspaceRootId';
import {
	createClaudeTaskPermissionArgs,
	createCodexTaskPermissionArgs,
	type TaskAgentScopePath,
} from '../../../task/taskAgentLaunchPolicy';

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
	prepareSession(
		sessionId: string,
		taskLease?: TaskToolLease,
	): Promise<McpPrepareResult>;
	getSessionRuntime(sessionId: string): McpSessionRuntime | undefined;
	retireExactRuntime(runtime: McpSessionRuntime): Promise<void>;
	dispose(): Promise<void>;
}

/** Backward-compatible test/public type name retained while orchestration becomes provider-neutral. */
export type CodexMcpSupervisor = McpSupervisor;

/** Terminal I/O와 monitor가 VS Code의 현재 Workspace Trust만 읽는 경계다. */
export type WorkspaceTrustReader = () => boolean;

/** Active-session Trust monitor를 테스트에서 결정적으로 구동하는 interval 경계다. */
export interface WorkspaceTrustMonitorScheduler {
	setInterval(callback: () => void, intervalMs: number): object | number;
	clearInterval(handle: object | number): void;
}

/** Revoke 후 Presentation refresh를 예약하는 Host 외부 알림 경계다. */
export type WorkspaceTrustRevokedObserver = () => void;

/** Authenticated native spawn과 exact Host ownership을 결합하는 Host-only lease다. */
export interface ActivityLease {
	readonly session: TerminalSession;
	readonly assignment: AgentAssignment;
	readonly providerId: ProviderId;
	readonly workspaceRootId: WorkspaceRootId;
	readonly runtime: McpSessionRuntime;
	readonly generation: string;
	readonly launchRootUri: string;
	readonly launchRootFsPath: string;
	readonly epoch: number;
	revoked: boolean;
}

/** Phase 4 Graph bridge가 받는 exact Host-only Activity handoff다. */
export interface HostAgentActivityRequest {
	readonly lease: ActivityLease;
	readonly sourceRuntime: McpSessionRuntime;
	readonly event: AgentActivityRequested;
}

export type HostAgentActivityRequestHandler = (
	request: HostAgentActivityRequest,
) => void;

/** Phase 4 cleanup을 runtime/process teardown 전에 삽입하는 synchronous Host seam이다. */
export type ActivityLeaseRevokedHandler = (lease: ActivityLease) => void;

/** Task-owned Agent tab 하나에 Host가 고정하는 실행 입력이다. */
export interface TaskTerminalSessionDescriptor extends TaskToolLease {
	readonly prompt: string;
	readonly scope: readonly TaskAgentScopePath[];
}

/** Task controller가 exact session lifecycle과 MCP 완료 신호를 받는 Host event다. */
export type TaskTerminalSessionEvent =
	| {
		readonly type: 'started';
		readonly tabId: TabId;
		readonly sessionId: SessionId;
		readonly descriptor: TaskTerminalSessionDescriptor;
	}
	| {
		readonly type: 'failed';
		readonly tabId: TabId;
		readonly sessionId?: SessionId;
		readonly descriptor: TaskTerminalSessionDescriptor;
	}
	| {
		readonly type: 'exited';
		readonly tabId: TabId;
		readonly sessionId: SessionId;
		readonly descriptor: TaskTerminalSessionDescriptor;
		readonly exitCode: number;
		readonly signal: number | null;
		readonly expected: boolean;
	}
	| {
		readonly type: 'tool';
		readonly tabId: TabId;
		readonly sessionId: SessionId;
		readonly descriptor: TaskTerminalSessionDescriptor;
		readonly event: TaskToolRequested;
	};

export type TaskTerminalSessionEventHandler = (
	event: TaskTerminalSessionEvent,
) => void;

interface ActivityLeaseState {
	readonly session: TerminalSession;
	readonly assignment: AgentAssignment;
	nextEpoch: number | undefined;
	lease?: ActivityLease;
}

/** 실행 중 autonomous CLI도 revoke 뒤 오래 남지 않게 하는 polling 상한이다. */
export const WORKSPACE_TRUST_MONITOR_INTERVAL_MS = 1000;

const systemWorkspaceTrustMonitorScheduler: WorkspaceTrustMonitorScheduler = {
	setInterval: (callback, intervalMs) => {
		const handle = setInterval(callback, intervalMs);
		handle.unref();
		return handle;
	},
	clearInterval: (handle) => clearInterval(
		handle as ReturnType<typeof setInterval>,
	),
};

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
		workspaceRootId: WorkspaceRootId,
		signal?: AbortSignal,
	) => Promise<StructuredProviderPreparation<TPreparation>>;
	readonly canUseMcp: (preparation: TPreparation) => boolean;
	readonly buildMcpPlan: (
		preparation: TPreparation,
		connection: Extract<McpPrepareResult, { readonly ok: true }>['connection'],
	) => AgentLaunchPlan | Promise<AgentLaunchPlan>;
	readonly buildBarePlan: (
		preparation: TPreparation,
	) => AgentLaunchPlan | Promise<AgentLaunchPlan>;
	readonly onAuthenticatedRequestReady?: (
		session: TerminalSession,
		preparation: TPreparation,
		plan: AgentLaunchPlan,
		generation: string,
	) => void;
}

type ClaudeStartupFallback = Readonly<{
	readonly preparation: PreparedClaudeTerminalLaunch;
	readonly reason: Extract<
		McpFailureReason,
		'provider_config_rejected' | 'provider_policy_blocked'
	>;
}>;

/** MCP 자동 연결과 명시적 재시작을 지원하는 현재 provider allowlist다. */
function isMcpProviderId(
	providerId: ProviderId | undefined,
): providerId is McpProviderId {
	return providerId === 'codex' || providerId === 'claude';
}

function isWorkspaceExecutionErrorCode(
	code: string,
): code is WorkspaceValidationFailure['code'] {
	return workspaceExecutionErrorCodes.has(code);
}

/**
 * `TerminalHost` 생성에 필요한 Host 소유 의존성이다.
 */
export interface TerminalHostOptions {
	/** 새 `TerminalSession`에 전달할 주입 가능한 PTY 생성 경계다. */
	readonly ptyAdapter: PtyAdapter;

	/** 작업공간과 셸 정책을 적용하는 시작 및 재시작 공통 준비 함수다. */
	readonly prepareLaunch?: PrepareTerminalLaunch;

	/** assignment commit 및 native spawn 직전에 fresh Workspace를 검증한다. */
	readonly workspaceResolver?: WorkspaceResolver;

	/** Terminal I/O와 active-session monitor가 fresh Trust만 읽는 경계다. */
	readonly readWorkspaceTrust?: WorkspaceTrustReader;

	/** Active-session Trust polling을 테스트 가능한 interval로 예약한다. */
	readonly workspaceTrustMonitorScheduler?: WorkspaceTrustMonitorScheduler;

	/** Trust revoke 관찰 시 atomic Workspace Presentation refresh를 예약한다. */
	readonly onWorkspaceTrustRevoked?: WorkspaceTrustRevokedObserver;

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

	/** Host가 고정하며 provider, env, child 또는 Webview가 변경할 수 없는 Activity gate다. */
	readonly agentActivityCompatible?: boolean;

	/** Exact ActivityLease 검증을 마친 요청만 Phase 4 Host bridge로 넘기는 경계다. */
	readonly onAgentActivityRequest?: HostAgentActivityRequestHandler;

	/** Exact lease revoke 뒤 resource teardown 전에 Phase 4 cleanup을 연결하는 seam이다. */
	readonly onActivityLeaseRevoked?: ActivityLeaseRevokedHandler;

	/** Task-owned session의 exact lifecycle을 Task execution controller로 넘긴다. */
	readonly onTaskSessionEvent?: TaskTerminalSessionEventHandler;

	/** Deterministic allocator test에서만 사용하는 panel-lifetime nonce/counter다. */
	readonly sessionIdNonce?: string;
	readonly initialSessionIdCounter?: number;

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
	workspaceLocked: 'Reset the Agent before changing its Workspace.',
	resetting: 'Agent reset is still being committed.',
	mcpRestartUnavailable: 'MCP restart is no longer valid for the current session.',
});

/** 재시작 시 마지막으로 확인된 크기가 없을 때 사용하는 Host 기본 terminal 크기다. */
const RESTART_FALLBACK_DIMENSIONS = Object.freeze({ cols: 80, rows: 24 });
const workspaceExecutionErrorCodes = new Set<string>(
	WORKSPACE_EXECUTION_ERROR_CODES,
);
const TASK_TERMINAL_PROMPT_MAX_UTF8_BYTES = 256 * 1024;
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

interface WorkspaceLaunchIdentity {
	readonly uri: string;
	readonly fsPath: string;
}

/** Fresh resolver가 exact root를 돌려준 경우에만 URI와 cwd를 함께 capture한다. */
function captureWorkspaceLaunchIdentity(
	root: ValidatedWorkspaceRoot,
	expectedRootId: WorkspaceRootId,
): WorkspaceLaunchIdentity | undefined {
	if (root.id !== expectedRootId) {
		return undefined;
	}
	try {
		const uri = root.workspaceFolder.uri.toString();
		if (
			typeof uri !== 'string'
			|| uri.length === 0
			|| `${WORKSPACE_ROOT_ID_PREFIX}${uri}` !== root.id
		) {
			return undefined;
		}
		return Object.freeze({ uri, fsPath: root.fsPath });
	} catch {
		return undefined;
	}
}

/** Runtime에서 `revoked`만 변경할 수 있는 exact enumerable lease record를 만든다. */
function createActivityLeaseRecord(input: ActivityLease): ActivityLease {
	const lease = {} as ActivityLease;
	for (const [name, value] of Object.entries(input)) {
		Object.defineProperty(lease, name, {
			value,
			enumerable: true,
			writable: name === 'revoked',
			configurable: false,
		});
	}
	return Object.seal(lease);
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

	/** 탭별 provider와 Workspace root를 함께 고정하는 불변 실행 배정이다. */
	private readonly assignmentByTab = new Map<TabId, AgentAssignment>();

	/** Webview ordering에만 사용하는 탭별 성공 commit revision이다. */
	private readonly assignmentRevisionByTab = new Map<TabId, number>();

	/** 각 session이 생성될 때 capture한 assignment object identity다. */
	private readonly assignmentBySession = new Map<SessionId, AgentAssignment>();

	/** logical Reset commit 중 reentrant switch mutation을 차단하는 탭 집합이다. */
	private readonly resettingTabs = new Set<TabId>();

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

	/** 매 호출마다 VS Code의 현재 Workspace 상태를 다시 읽는 실행 resolver다. */
	private readonly workspaceResolver: WorkspaceResolver;

	/** Root 상태와 분리해 Terminal/MCP 경계에서 현재 Trust만 fresh하게 읽는다. */
	private readonly readWorkspaceTrust: WorkspaceTrustReader;

	/** Active session이 있는 동안 하나의 bounded Trust interval만 소유한다. */
	private readonly workspaceTrustMonitorScheduler: WorkspaceTrustMonitorScheduler;

	/** Trust revoke 관찰을 Presentation refresh coordinator에 알리는 callback이다. */
	private readonly onWorkspaceTrustRevoked: WorkspaceTrustRevokedObserver;

	/** 현재 Panel runtime이 소유한 단일 Trust monitor handle이다. */
	private workspaceTrustMonitorHandle: object | number | undefined;

	/** 같은 untrusted epoch에서 revoke cleanup과 오류 발행을 한 번으로 제한한다. */
	private workspaceTrustRevokedObserved = false;

	/** Revoke가 분리한 Agent/MCP process tree 정리 완료를 공유한다. */
	private workspaceTrustRevokeCleanup: Promise<void> | undefined;

	/** Trust revoke로 error 전이된 session의 stale async continuation을 차단한다. */
	private readonly workspaceTrustFailedSessions = new Set<SessionId>();

	/** Session 준비 중 별도 child process를 만드는 probe의 취소 및 완료 ownership이다. */
	private readonly preparationBySession = new Map<SessionId, Readonly<{
		readonly controller: AbortController;
		readonly completion: Promise<void>;
	}>>();

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

	/** 생성 시 한 번 capture한 Host-owned Activity capability다. */
	private readonly agentActivityCompatible: boolean;

	/** Phase 4 전까지 exact Host handoff만 제공하며 기본 handler는 no-op이다. */
	private readonly onAgentActivityRequest:
		HostAgentActivityRequestHandler | undefined;
	private readonly onActivityLeaseRevoked:
		ActivityLeaseRevokedHandler | undefined;
	private readonly onTaskSessionEvent: TaskTerminalSessionEventHandler | undefined;

	/** Panel lifetime 전체의 session 생성 경로가 공유하는 단일 allocator다. */
	private readonly sessionIdAllocator: TerminalSessionIdAllocator;

	/** Gate=true일 때만 존재하고 live session 범위에서 lease epoch/current만 보존한다. */
	private readonly activityLeaseStateBySession:
		Map<SessionId, ActivityLeaseState> | undefined;

	/** 일반 Agent tab과 섞이지 않는 Task-owned tab/session의 불변 실행 lease다. */
	private readonly taskDescriptorByTab = new Map<
		TabId,
		TaskTerminalSessionDescriptor
	>();
	private readonly taskDescriptorBySession = new Map<
		SessionId,
		TaskTerminalSessionDescriptor
	>();
	private readonly expectedTaskSessionStops = new Set<SessionId>();
	private readonly taskWorkingDirectoryByTab = new Map<TabId, string>();
	private readonly taskWorkingDirectoryBySession = new Map<SessionId, string>();

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
		readonly runtime: McpSessionRuntime;
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

	/** 같은 탭의 명시적 MCP+Agent restart 연타를 요청 session과 함께 직렬화한다. */
	private readonly mcpRestartByTab = new Map<TabId, {
		readonly sessionId: SessionId;
		readonly completion: Promise<void>;
	}>();

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

	/** detach가 취소한 provider preparation child cleanup을 terminate까지 보존한다. */
	private detachedPreparationCleanups: readonly Promise<void>[] = [];

	/** 반복 terminate 호출이 공유하는 최초 비동기 cleanup Promise다. */
	private terminationPromise: Promise<void> | undefined;

	/** Panel dispose가 동기 시작한 MCP supervisor cleanup을 terminate가 기다린다. */
	private mcpTerminationPromise: Promise<void> | undefined;

	/** reset/reselect/restart/tab close가 분리한 session별 process-tree cleanup이다. */
	private readonly processCleanupBySession = new Map<SessionId, Promise<void>>();

	/** 같은 탭의 다음 CLI 시작이 앞선 모든 resource cleanup을 기다리는 경계다. */
	private readonly tabCleanupBarrier = new Map<TabId, Promise<void>>();

	/**
	 * 비어 있는 세션 저장소와 Host 소유 의존성을 초기화한다.
	 * 객체 생성만으로 세션을 만들거나 네이티브 PTY를 불러오지 않는다.
	 *
	 * @param options PTY 어댑터, 실행 준비 함수 및 메시지 전달 함수
	 */
	constructor(options: TerminalHostOptions) {
		this.ptyAdapter = options.ptyAdapter;
		this.prepareLaunch = options.prepareLaunch ?? prepareTerminalLaunch;
		this.workspaceResolver = options.workspaceResolver
			?? resolveWorkspaceForExecution;
		this.readWorkspaceTrust = options.readWorkspaceTrust
			?? readVsCodeWorkspaceTrust;
		this.workspaceTrustMonitorScheduler = options.workspaceTrustMonitorScheduler
			?? systemWorkspaceTrustMonitorScheduler;
		this.onWorkspaceTrustRevoked = options.onWorkspaceTrustRevoked
			?? (() => undefined);
		this.emitMessage = options.emitMessage;
		this.resolveProviderAutoRunInput = options.resolveAgentAutoRunInput
			?? resolveDetectedAgentAutoRunInput;
		this.prepareCodexLaunch = options.prepareCodexLaunch;
		this.prepareClaudeLaunch = options.prepareClaudeLaunch;
		this.mcpSupervisor = options.mcpSupervisor;
		this.agentActivityCompatible = options.agentActivityCompatible === true;
		this.onAgentActivityRequest = this.agentActivityCompatible
			? options.onAgentActivityRequest
			: undefined;
		this.onActivityLeaseRevoked = this.agentActivityCompatible
			? options.onActivityLeaseRevoked
			: undefined;
		this.onTaskSessionEvent = options.onTaskSessionEvent;
		this.activityLeaseStateBySession = this.agentActivityCompatible
			? new Map<SessionId, ActivityLeaseState>()
			: undefined;
		this.sessionIdAllocator = new TerminalSessionIdAllocator({
			nonce: options.sessionIdNonce,
			initialCounter: options.initialSessionIdCounter,
		});
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
	 * Task controller가 요청한 ordinary Agent tab을 기존 switch/start transaction으로 연다.
	 * Task descriptor는 Webview payload에서 받지 않고 Host가 고정하며, 같은 tab은 일반
	 * reset/reselect/restart 경로로 바뀔 수 없다.
	 */
	async createTaskSession(
		tabId: TabId,
		providerId: ProviderId,
		workspaceRootId: WorkspaceRootId,
		switchAttemptId: SwitchAttemptId,
		descriptor: TaskTerminalSessionDescriptor,
	): Promise<void> {
		if (!this.lifecycleActive) {
			throw new Error('Task Agent host is inactive.');
		}
		if (this.registeredTabs.has(tabId)) {
			throw new Error('Task Agent tab is already registered.');
		}
		if (!isValidTaskTerminalSessionDescriptor(descriptor)) {
			throw new Error('Task Agent descriptor is invalid.');
		}

		const workingDirectory = mkdtempSync(nodePath.join(
			tmpdir(),
			'crispy-task-',
		));
		const frozenDescriptor = Object.freeze({
			...descriptor,
			scope: Object.freeze(descriptor.scope.map((entry) => Object.freeze({
				...entry,
			}))),
		});
		this.registeredTabs.add(tabId);
		this.taskDescriptorByTab.set(tabId, frozenDescriptor);
		this.taskWorkingDirectoryByTab.set(tabId, workingDirectory);
		await this.switchAgentForRequest(
			tabId,
			providerId,
			workspaceRootId,
			switchAttemptId,
			frozenDescriptor,
		);
	}

	/** Task 완료/reject 수락 뒤 exact process tree를 종료하되 tab 표면은 보존한다. */
	async stopTaskSession(
		executionId: string,
		workNodeId: string,
	): Promise<boolean> {
		const entry = [...this.taskDescriptorByTab.entries()].find(([, descriptor]) => (
			descriptor.executionId === executionId
			&& descriptor.workNodeId === workNodeId
		));
		if (!entry) {
			return false;
		}
		const [tabId] = entry;
		const session = this.getActiveSession(tabId);
		if (session === undefined) {
			this.taskDescriptorByTab.delete(tabId);
			await this.cleanupTaskWorkingDirectory(tabId);
			return true;
		}
		this.expectedTaskSessionStops.add(session.sessionId);
		await this.cleanupSessionProcessTree(session);
		this.removeSession(session.sessionId);
		this.taskDescriptorByTab.delete(tabId);
		await this.cleanupTaskWorkingDirectory(tabId);
		return true;
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
		const taskDescriptor = this.taskDescriptorByTab.get(tabId);
		if (
			taskDescriptor !== undefined
			&& session !== undefined
			&& !this.expectedTaskSessionStops.has(session.sessionId)
		) {
			this.emitTaskSessionEvent({
				type: 'failed',
				tabId,
				sessionId: session.sessionId,
				descriptor: taskDescriptor,
			});
		}
		if (session !== undefined) {
			void this.cleanupSessionProcessTree(session);
			this.removeSession(session.sessionId);
		}

		this.registeredTabs.delete(tabId);
		this.assignmentByTab.delete(tabId);
		this.assignmentRevisionByTab.delete(tabId);
		this.resettingTabs.delete(tabId);
		this.lastDimensionsByTab.delete(tabId);
		this.activeSessionByTab.delete(tabId);
		this.taskDescriptorByTab.delete(tabId);
		void this.cleanupTaskWorkingDirectory(tabId);
		if (this.activeTabId === tabId) {
			this.activeTabId = undefined;
		}
		this.updateWorkspaceTrustMonitor();
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
		if (this.taskDescriptorByTab.has(tabId)) {
			this.failWithoutTransition(
				tabId,
				this.getActiveSession(tabId) ?? null,
				'invalid_session_state',
				'Task-owned Agent tabs cannot be reset while the Task owns them.',
				false,
			);
			return;
		}
		if (this.resettingTabs.has(tabId)) {
			return;
		}

		this.resettingTabs.add(tabId);
		const session = this.getActiveSession(tabId);
		this.assignmentByTab.delete(tabId);
		if (session !== undefined) {
			void this.cleanupSessionProcessTree(session);
			this.removeSession(session.sessionId);
		}

		this.lastDimensionsByTab.delete(tabId);
		this.activeSessionByTab.delete(tabId);
		const assignmentRevision = this.incrementAssignmentRevision(tabId);
		this.publish({
			type: 'agent.resetCompleted',
			tabId,
			assignmentRevision,
		});
		this.resettingTabs.delete(tabId);
		this.updateWorkspaceTrustMonitor();
	}

	/**
	 * 검증된 `agent.switch`로 탭의 provider를 정하고 세션을 그 provider로 다시 시작한다.
	 * provider를 바꾸는 선택과 같은 provider를 유지하는 재시작이 같은 경로를 사용하므로
	 * 실행 중 세션이 있으면 항상 기존 세션을 정리한 뒤 새 세션을 시작한다.
	 * Terminal 크기를 아직 모르는 탭은 provider만 기록하고 `terminal.ready`를 기다린다.
	 *
	 * @param tabId 프로토콜 검증을 통과한 Webview 소유 탭 식별자
	 * @param providerId 프로토콜 allowlist를 통과한 provider 식별자
	 * @param workspaceRootId Host Catalog에서 round-trip한 Workspace root 식별자
	 * @param switchAttemptId Webview가 발급한 switch correlation 식별자
	 * @returns 정리와 시작 흐름이 끝나면 완료되는 Promise
	 */
	async switchAgent(
		tabId: TabId,
		providerId: ProviderId,
		workspaceRootId: WorkspaceRootId,
		switchAttemptId: SwitchAttemptId,
	): Promise<void> {
		return this.switchAgentForRequest(
			tabId,
			providerId,
			workspaceRootId,
			switchAttemptId,
			undefined,
		);
	}

	private async switchAgentForRequest(
		tabId: TabId,
		providerId: ProviderId,
		workspaceRootId: WorkspaceRootId,
		switchAttemptId: SwitchAttemptId,
		taskDescriptor: TaskTerminalSessionDescriptor | undefined,
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
		const ownedTaskDescriptor = this.taskDescriptorByTab.get(tabId);
		if (
			ownedTaskDescriptor !== undefined
			&& ownedTaskDescriptor !== taskDescriptor
		) {
			this.failWithoutTransition(
				tabId,
				this.getActiveSession(tabId) ?? null,
				'invalid_session_state',
				'Task-owned Agent tabs cannot change provider or Workspace.',
				false,
				switchAttemptId,
			);
			return;
		}
		if (this.resettingTabs.has(tabId)) {
			this.failWithoutTransition(
				tabId,
				null,
				'invalid_session_state',
				START_ERROR_MESSAGES.resetting,
				false,
				switchAttemptId,
			);
			return;
		}

		const previousAssignment = this.assignmentByTab.get(tabId);
		if (
			previousAssignment !== undefined
			&& previousAssignment.workspaceRootId !== workspaceRootId
		) {
			this.failWithoutTransition(
				tabId,
				null,
				'workspace_change_requires_reset',
				START_ERROR_MESSAGES.workspaceLocked,
				false,
				switchAttemptId,
			);
			return;
		}

		let preflight: WorkspaceValidationResult;
		try {
			preflight = this.workspaceResolver(workspaceRootId);
		} catch {
			this.failWithoutTransition(
				tabId,
				null,
				'internal_error',
				START_ERROR_MESSAGES.preparation,
				false,
				switchAttemptId,
			);
			return;
		}
		if (!preflight.ok) {
			const trustCleanup = preflight.code === 'workspace_untrusted'
				? this.handleWorkspaceTrustRevoke()
				: undefined;
			const error = mapWorkspaceFailureToTerminalError(
				preflight,
				tabId,
				null,
			);
			this.publish({
				...error,
				canRestart: false,
				switchAttemptId,
			});
			await trustCleanup;
			return;
		}
		this.observeWorkspaceTrustGranted();

		const assignment = Object.freeze({
			providerId,
			workspaceRootId,
		}) satisfies AgentAssignment;
		this.assignmentByTab.set(tabId, assignment);
		const assignmentRevision = this.incrementAssignmentRevision(tabId);

		const current = this.getActiveSession(tabId);
		let pendingCleanup = this.getTabCleanupBarrier(tabId);
		if (current !== undefined) {
			pendingCleanup = this.cleanupSessionProcessTree(current);
			this.removeSession(current.sessionId);
		}
		this.publish({
			type: 'agent.switchAccepted',
			tabId,
			providerId,
			workspaceRootId,
			switchAttemptId,
			assignmentRevision,
		});
		if (pendingCleanup !== undefined) {
			await pendingCleanup;
		}
		if (
			!this.lifecycleActive
			|| !this.registeredTabs.has(tabId)
			|| this.assignmentByTab.get(tabId) !== assignment
			|| this.getActiveSession(tabId) !== undefined
		) {
			return;
		}

		const dimensions = this.lastDimensionsByTab.get(tabId);
		if (dimensions === undefined) {
			/** 크기를 알기 전에 시작하면 첫 화면이 잘못된 폭으로 그려지므로 기다린다. */
			return;
		}

		await this.startSessionForAssignment(
			tabId,
			dimensions.cols,
			dimensions.rows,
			assignment,
		);
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
		const assignment = this.assignmentByTab.get(tabId);
		if (assignment === undefined) {
			return;
		}

		const pendingCleanup = this.getTabCleanupBarrier(tabId);
		if (pendingCleanup !== undefined) {
			await pendingCleanup;
		}
		if (
			!this.lifecycleActive
			|| !this.registeredTabs.has(tabId)
			|| this.assignmentByTab.get(tabId) !== assignment
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

		await this.startSessionForAssignment(tabId, cols, rows, assignment);
	}

	/**
	 * 탭에 배정된 provider 식별자를 조회한다.
	 *
	 * @param tabId 조회할 Webview 소유 탭 식별자
	 * @returns 배정된 provider 또는 아직 선택되지 않았으면 `undefined`
	 */
	getTabProvider(tabId: TabId): ProviderId | undefined {
		return this.assignmentByTab.get(tabId)?.providerId;
	}

	/** 탭의 현재 불변 assignment object를 조회한다. */
	getTabAssignment(tabId: TabId): AgentAssignment | undefined {
		return this.assignmentByTab.get(tabId);
	}

	/** Webview ordering용 현재 assignment revision을 조회한다. */
	getAssignmentRevision(tabId: TabId): number {
		return this.assignmentRevisionByTab.get(tabId) ?? 0;
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
		return this.startSessionForAssignment(
			tabId,
			cols,
			rows,
			this.assignmentByTab.get(tabId),
		);
	}

	/** 내부 transaction이 capture한 assignment identity로만 새 session을 시작한다. */
	private async startSessionForAssignment(
		tabId: TabId,
		cols: number,
		rows: number,
		capturedAssignment: AgentAssignment | undefined,
	): Promise<void> {
		if (!this.lifecycleActive) {
			return;
		}
		if (!this.isCurrentAssignment(tabId, capturedAssignment)) {
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
			session = this.createSession(tabId, capturedAssignment);
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

		const providerId = capturedAssignment?.providerId;
		if (isMcpProviderId(providerId)) {
			this.mcpStatusBySession.set(session.sessionId, {
				status: 'preparing',
				published: false,
			});
		}
		this.publish({
			type: 'terminal.starting',
			tabId,
			sessionId: session.sessionId,
		});
		this.updateWorkspaceTrustMonitor();

		if (
			providerId === 'codex'
			&& capturedAssignment !== undefined
			&& this.prepareCodexLaunch !== undefined
			&& this.mcpSupervisor !== undefined
		) {
			await this.startCodexSession(session, cols, rows);
			return;
		}
		if (
			providerId === 'claude'
			&& capturedAssignment !== undefined
			&& this.prepareClaudeLaunch !== undefined
			&& this.mcpSupervisor !== undefined
		) {
			await this.startClaudeSession(session, cols, rows);
			return;
		}

		let preparation: Awaited<ReturnType<PrepareTerminalLaunch>>;
		try {
			preparation = await this.prepareLaunch(
				tabId,
				session.sessionId,
				capturedAssignment?.workspaceRootId,
			);
		} catch {
			if (!this.isCurrentAssignmentSession(session, capturedAssignment)) {
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

		if (!this.isCurrentAssignmentSession(session, capturedAssignment)) {
			/** detach 중 완료된 준비 작업이 session 상태나 native PTY를 변경하지 못하게 한다. */
			return;
		}

		if (!preparation.ok) {
			if (
				capturedAssignment !== undefined
				&& isWorkspaceExecutionErrorCode(preparation.error.code)
			) {
				await this.failWorkspaceStart(
					session,
					capturedAssignment,
					{ ok: false, code: preparation.error.code },
				);
				return;
			}
			session.markError(preparation.error.code);
			this.updateWorkspaceTrustMonitor();
			this.publish(preparation.error);
			return;
		}

		let autoRunInput: string | undefined;
		if (providerId !== undefined) {
			try {
				autoRunInput = await this.runSessionPreparation(
					session,
					(signal) => this.resolveProviderAutoRunInput(
						providerId,
						preparation.policy,
						signal,
						() => {
							if (
								capturedAssignment === undefined
								|| !this.isCurrentAssignmentSession(
									session,
									capturedAssignment,
								)
							) {
								return undefined;
							}
							let freshWorkspace: WorkspaceValidationResult;
							try {
								freshWorkspace = this.workspaceResolver(
									capturedAssignment.workspaceRootId,
								);
							} catch {
								return undefined;
							}
							if (!freshWorkspace.ok) {
								if (freshWorkspace.code === 'workspace_untrusted') {
									void this.handleWorkspaceTrustRevoke();
								}
								return undefined;
							}
							if (!this.isCurrentAssignmentSession(
								session,
								capturedAssignment,
							)) {
								return undefined;
							}
							this.observeWorkspaceTrustGranted();
							return freshWorkspace.root.fsPath;
						},
					),
				);
			} catch {
				/** 탐색 경계 자체의 실패는 기존 기본 command로 안전하게 복구한다. */
				autoRunInput = resolveAgentAutoRunInput(providerId);
			}
		}

		if (!this.isCurrentAssignmentSession(session, capturedAssignment)) {
			/** stale 탐색 결과가 교체되거나 닫힌 session에 입력되지 않게 한다. */
			return;
		}
		if (autoRunInput !== undefined) {
			this.providerAutoRunInputBySession.set(session.sessionId, autoRunInput);
		}

		this.lastDimensionsByTab.set(tabId, { cols, rows });
		let finalPolicy = preparation.policy;
		if (capturedAssignment !== undefined) {
			let finalWorkspace: WorkspaceValidationResult;
			try {
				finalWorkspace = this.workspaceResolver(
					capturedAssignment.workspaceRootId,
				);
			} catch {
				this.providerAutoRunInputBySession.delete(session.sessionId);
				this.failSession(
					session,
					'internal_error',
					START_ERROR_MESSAGES.preparation,
					true,
				);
				return;
			}
			if (!finalWorkspace.ok) {
				this.providerAutoRunInputBySession.delete(session.sessionId);
				await this.failWorkspaceStart(
					session,
					capturedAssignment,
					finalWorkspace,
				);
				return;
			}
			if (!this.isCurrentAssignmentSession(session, capturedAssignment)) {
				return;
			}
			this.observeWorkspaceTrustGranted();
			finalPolicy = {
				...preparation.policy,
				cwd: finalWorkspace.root.fsPath,
			};
		}
		try {
			const started = session.start(finalPolicy, cols, rows);
			await started;
		} catch {
			this.providerAutoRunInputBySession.delete(session.sessionId);
			if (!this.isCurrentAssignmentSession(session, capturedAssignment)) {
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
		const taskDescriptor = this.taskDescriptorBySession.get(session.sessionId);
		return this.startStructuredMcpProviderSession(session, cols, rows, {
			providerId: 'codex',
			prepare,
			canUseMcp: (preparation) =>
				preparation.shellEnvironmentPolicyStyle !== undefined,
			buildMcpPlan: (preparation, connection) => this.buildCodexMcpPlan({
				executable: preparation.executable,
				cwd: preparation.cwd,
				connection,
				agentActivityCompatible: this.agentActivityCompatible,
				shellEnvironmentPolicyStyle:
					preparation.shellEnvironmentPolicyStyle!,
				...(taskDescriptor === undefined
					? {}
					: {
						argsBeforeConfig: createCodexTaskPermissionArgs(
							taskDescriptor.scope,
						),
						argsAfterConfig: ['--', createTaskAgentPrompt(taskDescriptor)],
					}),
			}),
			buildBarePlan: (preparation) => this.buildCodexBarePlan({
				executable: preparation.executable,
				cwd: preparation.cwd,
			}),
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
		const taskDescriptor = this.taskDescriptorBySession.get(session.sessionId);
		return this.startStructuredMcpProviderSession(session, cols, rows, {
			providerId: 'claude',
			prepare,
			canUseMcp: (preparation) => preparation.mcpCompatible,
			buildMcpPlan: (preparation, connection) => this.buildClaudeMcpPlan({
				executable: preparation.executable,
				cwd: preparation.cwd,
				connection,
				agentActivityCompatible: this.agentActivityCompatible,
				...(taskDescriptor === undefined
					? {}
					: {
						createArgs: (serverName) => (
							createClaudeTaskPermissionArgs(
								taskDescriptor.scope,
								preparation.cwd,
								serverName,
							)
						),
						argsAfterConfig: ['--', createTaskAgentPrompt(taskDescriptor)],
					}),
			}),
			buildBarePlan: (preparation) => this.buildClaudeBarePlan({
				executable: preparation.executable,
				cwd: preparation.cwd,
			}),
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
		const assignment = this.assignmentBySession.get(session.sessionId);
		if (
			assignment === undefined
			|| assignment.providerId !== options.providerId
			|| this.assignmentByTab.get(session.tabId) !== assignment
		) {
			return;
		}
		const recordStartupFailure = (reason: McpFailureReason): void => {
			this.recordMcpFailure(session, reason);
		};
		let preparedRuntime: McpSessionRuntime | undefined;
		const hasPreparedRuntimeReplacement = (): boolean => {
			const supervisorRuntime = supervisor.getSessionRuntime(session.sessionId);
			const hostRuntime = this.mcpRuntimeBySession.get(session.sessionId)?.runtime;
			return (
				supervisorRuntime !== undefined
				&& supervisorRuntime !== preparedRuntime
			) || (
				hostRuntime !== undefined
				&& hostRuntime !== preparedRuntime
			);
		};
		const retirePreparedRuntime = (): Promise<void> => preparedRuntime === undefined
			? Promise.resolve()
			: this.cleanupMcpSession(session.sessionId, preparedRuntime);

		let preparationResult: StructuredProviderPreparation<TPreparation>;
		try {
			preparationResult = await this.runSessionPreparation(
				session,
				(signal) => options.prepare(
					session.tabId,
					session.sessionId,
					assignment.workspaceRootId,
					signal,
				),
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
			if (isWorkspaceExecutionErrorCode(preparationResult.error.code)) {
					await this.failWorkspaceStart(
						session,
						assignment,
						{ ok: false, code: preparationResult.error.code },
						{ expectedRuntime: undefined },
					);
				return;
			}
			session.markError(preparationResult.error.code);
			this.updateWorkspaceTrustMonitor();
			this.publish(preparationResult.error);
			return;
		}

		const preparation = preparationResult.preparation;
		const canUseMcp = options.canUseMcp(preparation);
		const taskOwned = this.taskDescriptorBySession.has(session.sessionId);
		if (taskOwned && !canUseMcp) {
			this.failSession(
				session,
				'start_failed',
				'Task Agent requires the authenticated MCP session boundary.',
				false,
			);
			return;
		}
		let prepared: McpPrepareResult | undefined;
		if (canUseMcp) {
			if (!this.guardWorkspaceTrust(session, assignment)) {
				return;
			}
			try {
				const taskDescriptor = this.taskDescriptorBySession.get(
					session.sessionId,
				);
				const pendingPrepare = supervisor.prepareSession(
					session.sessionId,
					taskDescriptor === undefined
						? undefined
						: Object.freeze({
							executionId: taskDescriptor.executionId,
							workNodeId: taskDescriptor.workNodeId,
						}),
				);
				preparedRuntime = supervisor.getSessionRuntime(session.sessionId);
				prepared = await pendingPrepare;
			} catch {
				if (
					this.isCurrentProviderSession(session, options.providerId)
					&& !hasPreparedRuntimeReplacement()
				) {
					recordStartupFailure('adapter_start_failed');
				}
			}
		} else if (options.providerId === 'codex') {
			recordStartupFailure('safe_session_injection_unavailable');
		}

		if (!this.isCurrentProviderSession(session, options.providerId)) {
			await retirePreparedRuntime();
			return;
		}
		if (hasPreparedRuntimeReplacement()) {
			await retirePreparedRuntime();
			return;
		}
		if (prepared !== undefined && !prepared.ok) {
			recordStartupFailure(prepared.failure.reason);
		}

		let plan: AgentLaunchPlan | undefined;
		let generation: string | undefined;
		let authenticatedPlanRejected = false;
		if (prepared?.ok && canUseMcp) {
			generation = prepared.connection.generation;
			if (
				preparedRuntime !== undefined
				&& supervisor.getSessionRuntime(session.sessionId) === preparedRuntime
				&& preparedRuntime.generation === generation
				&& preparedRuntime.lifecycle === 'running'
			) {
				this.mcpRuntimeBySession.set(session.sessionId, {
					providerId: options.providerId,
					generation,
					runtime: preparedRuntime,
				});
				try {
					plan = await options.buildMcpPlan(
						preparation,
						prepared.connection,
					);
				} catch {
					authenticatedPlanRejected = true;
				}
			}
		}

		if (!this.isCurrentProviderSession(session, options.providerId)) {
			await retirePreparedRuntime();
			return;
		}
		if (hasPreparedRuntimeReplacement()) {
			await retirePreparedRuntime();
			return;
		}
		if (authenticatedPlanRejected) {
			recordStartupFailure('provider_config_rejected');
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
				recordStartupFailure(
					preparedRuntime === undefined
						|| preparedRuntime.lifecycle !== 'running'
						? 'adapter_exited'
						: 'provider_config_rejected',
				);
			}
			await retirePreparedRuntime();
			if (
				!this.isCurrentProviderSession(session, options.providerId)
				|| hasPreparedRuntimeReplacement()
			) {
				return;
			}
			if (taskOwned) {
				this.failSession(
					session,
					'start_failed',
					'Task Agent MCP registration failed.',
					false,
				);
				return;
			}
			generation = undefined;
			try {
				plan = await options.buildBarePlan(preparation);
			} catch {
				plan = undefined;
			}
		}
		if (hasPreparedRuntimeReplacement()) {
			await retirePreparedRuntime();
			return;
		}

		if (
			!this.isCurrentProviderSession(session, options.providerId)
			|| plan === undefined
			|| plan.providerId !== options.providerId
			|| plan.expectsMcp !== (generation !== undefined)
		) {
			if (generation !== undefined) {
				await retirePreparedRuntime();
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
		let authenticatedRequestRejected = false;
		try {
			request = await this.createAgentSpawnRequest(plan, {
				platform: preparation.platform,
				environment: preparation.environment,
			});
		} catch {
			request = undefined;
			authenticatedRequestRejected = generation !== undefined;
		}

		if (!this.isCurrentProviderSession(session, options.providerId)) {
			await retirePreparedRuntime();
			return;
		}
		if (hasPreparedRuntimeReplacement()) {
			await retirePreparedRuntime();
			return;
		}
		if (
			request !== undefined
			&& generation !== undefined
			&& this.isCurrentMcpRuntime(
				session,
				options.providerId,
				generation,
			)
		) {
			try {
				options.onAuthenticatedRequestReady?.(
					session,
					preparation,
					plan,
					generation,
				);
			} catch {
				request = undefined;
				authenticatedRequestRejected = true;
			}
		}
		if (hasPreparedRuntimeReplacement()) {
			await retirePreparedRuntime();
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
				recordStartupFailure(
					authenticatedRequestRejected
						? 'safe_session_injection_unavailable'
						: 'adapter_exited',
				);
			}
			await retirePreparedRuntime();
			if (
				!this.isCurrentProviderSession(session, options.providerId)
				|| hasPreparedRuntimeReplacement()
			) {
				return;
			}
			if (taskOwned) {
				this.failSession(
					session,
					'start_failed',
					'Task Agent authenticated launch was rejected.',
					false,
				);
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
		if (hasPreparedRuntimeReplacement()) {
			await retirePreparedRuntime();
			return;
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
				await retirePreparedRuntime();
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
			const runtime = supervisor.getSessionRuntime(session.sessionId);
			if (runtime !== undefined && runtime !== preparedRuntime) {
				await retirePreparedRuntime();
				return;
			}
			if (
				runtime === undefined
				|| runtime !== preparedRuntime
				|| runtime.generation !== generation
				|| runtime.lifecycle !== 'running'
			) {
				recordStartupFailure('adapter_exited');
				await retirePreparedRuntime();
				return;
			}
			this.mcpRuntimeBySession.set(session.sessionId, {
				providerId: options.providerId,
				generation,
				runtime,
			});
			this.setMcpAwaitingActivity(session);
		}
		let finalWorkspace: WorkspaceValidationResult;
		try {
			finalWorkspace = this.workspaceResolver(assignment.workspaceRootId);
		} catch {
			await retirePreparedRuntime();
			if (
				this.isCurrentProviderSession(session, options.providerId)
				&& !hasPreparedRuntimeReplacement()
			) {
				this.failSession(
					session,
					'internal_error',
					START_ERROR_MESSAGES.preparation,
					true,
				);
			}
			return;
		}
		if (!finalWorkspace.ok) {
			if (
				!this.isCurrentProviderSession(session, options.providerId)
				|| hasPreparedRuntimeReplacement()
			) {
				await retirePreparedRuntime();
				return;
			}
			await this.failWorkspaceStart(
				session,
				assignment,
				finalWorkspace,
				{ expectedRuntime: preparedRuntime },
			);
			return;
		}
		const launchIdentity = captureWorkspaceLaunchIdentity(
			finalWorkspace.root,
			assignment.workspaceRootId,
		);
		if (launchIdentity === undefined) {
			if (
				!this.isCurrentProviderSession(session, options.providerId)
				|| hasPreparedRuntimeReplacement()
			) {
				await retirePreparedRuntime();
				return;
			}
			await this.failWorkspaceStart(
				session,
				assignment,
				{ ok: false, code: 'workspace_root_unavailable' },
				{ expectedRuntime: preparedRuntime },
			);
			return;
		}
		if (
			!this.isCurrentProviderSession(session, options.providerId)
			|| (generation !== undefined && !this.isCurrentMcpRuntime(
				session,
				options.providerId,
				generation,
			))
		) {
			if (generation !== undefined) {
				await retirePreparedRuntime();
			}
			return;
		}
		this.observeWorkspaceTrustGranted();
		const finalRequest = Object.freeze({
			...request,
			cwd: this.taskWorkingDirectoryBySession.get(session.sessionId)
				?? launchIdentity.fsPath,
		});
		const authenticatedRuntime = generation === undefined
			? undefined
			: preparedRuntime;
		try {
			if (authenticatedRuntime !== undefined) {
				this.mcpPtySpawnStarted.add(session.sessionId);
				if (
					this.agentActivityCompatible
					&& this.installActivityLease(
						session,
						assignment,
						authenticatedRuntime,
						launchIdentity,
					) === undefined
				) {
					throw new Error(
						'Authenticated Activity ownership is unavailable.',
					);
				}
			}
			const spawned = this.spawnProviderPty(session, finalRequest, cols, rows);
			await spawned;
		} catch (error: unknown) {
			let preReadyFallback: ClaudeStartupFallback | undefined;
			if (error instanceof TerminalProcessExitedBeforeReadyError) {
				error.withBufferedOutput((output) => {
					this.appendClaudeStartupOutput(session.sessionId, output);
				});
				preReadyFallback = this.getClaudeStartupFallback(
					session,
					error.event,
				);
			}
			if (authenticatedRuntime !== undefined) {
				const supervisorRuntimeBeforeCleanup = supervisor.getSessionRuntime(
					session.sessionId,
				);
				const hostRuntimeBeforeCleanup = this.mcpRuntimeBySession.get(
					session.sessionId,
				)?.runtime;
				const replacementObservedBeforeCleanup = (
					supervisorRuntimeBeforeCleanup !== undefined
					&& supervisorRuntimeBeforeCleanup !== authenticatedRuntime
				) || (
					hostRuntimeBeforeCleanup !== undefined
					&& hostRuntimeBeforeCleanup !== authenticatedRuntime
				);
				this.revokeExactActivityLease(session, authenticatedRuntime);
				this.mcpPtySpawnStarted.delete(session.sessionId);
				await this.cleanupMcpSession(
					session.sessionId,
					authenticatedRuntime,
				);
				const supervisorRuntimeAfterCleanup = supervisor.getSessionRuntime(
					session.sessionId,
				);
				const hostRuntimeAfterCleanup = this.mcpRuntimeBySession.get(
					session.sessionId,
				)?.runtime;
				if (
					replacementObservedBeforeCleanup
					|| (
						supervisorRuntimeAfterCleanup !== undefined
						&& supervisorRuntimeAfterCleanup !== authenticatedRuntime
					)
					|| (
						hostRuntimeAfterCleanup !== undefined
						&& hostRuntimeAfterCleanup !== authenticatedRuntime
					)
				) {
					return;
				}
			} else {
				this.mcpPtySpawnStarted.delete(session.sessionId);
			}
			if (!this.isCurrentProviderSession(session, options.providerId)) {
				return;
			}
			if (error instanceof TerminalProcessExitedBeforeReadyError) {
				if (
					preReadyFallback !== undefined
					&& authenticatedRuntime !== undefined
				) {
						void this.relaunchClaudeBareAfterStartupRejection(
							session,
							preReadyFallback.preparation,
							preReadyFallback.reason,
							authenticatedRuntime,
						);
				} else {
					this.failSession(
						session,
						'start_failed',
						START_ERROR_MESSAGES.spawn,
						true,
					);
				}
				return;
			}
			const authenticatedSpawnFailed = authenticatedRuntime !== undefined;
			if (authenticatedSpawnFailed) {
				recordStartupFailure('safe_session_injection_unavailable');
			}

			if (authenticatedSpawnFailed) {
				if (taskOwned) {
					this.failSession(
						session,
						'start_failed',
						'Task Agent process could not start safely.',
						false,
					);
					return;
				}
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

				if (
					!this.isCurrentProviderSession(session, options.providerId)
					|| supervisor.getSessionRuntime(session.sessionId) !== undefined
					|| this.mcpRuntimeBySession.has(session.sessionId)
				) {
					return;
				}
				if (bareRequest !== undefined) {
					let fallbackWorkspace: WorkspaceValidationResult;
					try {
						fallbackWorkspace = this.workspaceResolver(
							assignment.workspaceRootId,
						);
					} catch {
						if (
							supervisor.getSessionRuntime(session.sessionId)
								!== undefined
							|| this.mcpRuntimeBySession.has(session.sessionId)
						) {
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
					if (!fallbackWorkspace.ok) {
						if (
							supervisor.getSessionRuntime(session.sessionId)
								!== undefined
							|| this.mcpRuntimeBySession.has(session.sessionId)
						) {
							return;
						}
						await this.failWorkspaceStart(
							session,
							assignment,
							fallbackWorkspace,
							{ expectedRuntime: undefined },
						);
						return;
					}
					const fallbackLaunchIdentity = captureWorkspaceLaunchIdentity(
						fallbackWorkspace.root,
						assignment.workspaceRootId,
					);
					if (fallbackLaunchIdentity === undefined) {
						if (
							supervisor.getSessionRuntime(session.sessionId)
								!== undefined
							|| this.mcpRuntimeBySession.has(session.sessionId)
						) {
							return;
						}
						await this.failWorkspaceStart(
							session,
							assignment,
							{
								ok: false,
								code: 'workspace_root_unavailable',
							},
							{ expectedRuntime: undefined },
						);
						return;
					}
					if (
						!this.isCurrentProviderSession(session, options.providerId)
						|| supervisor.getSessionRuntime(session.sessionId) !== undefined
						|| this.mcpRuntimeBySession.has(session.sessionId)
					) {
						return;
					}
					this.observeWorkspaceTrustGranted();
					const finalBareRequest = Object.freeze({
						...bareRequest,
						cwd: fallbackLaunchIdentity.fsPath,
					});
					try {
						const spawned = this.spawnProviderPty(
							session,
							finalBareRequest,
							cols,
							rows,
						);
						await spawned;
						return;
					} catch {
						if (
							supervisor.getSessionRuntime(session.sessionId)
								!== undefined
							|| this.mcpRuntimeBySession.has(session.sessionId)
						) {
							return;
						}
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
			await this.cleanupMcpSession(
				session.sessionId,
				authenticatedRuntime,
			);
		}
	}

	/** 실제 PID가 준비된 현재 session에만 started와 provider 입력을 한 번 전달한다. */
	private handleSessionRunning(session: TerminalSession): void {
		const assignment = this.assignmentBySession.get(session.sessionId);
		if (
			!this.lifecycleActive
			|| !this.isCurrentSession(session)
			|| (
				assignment !== undefined
				&& this.assignmentByTab.get(session.tabId) !== assignment
			)
			|| session.state.kind !== 'running'
		) {
			return;
		}
		if (
			assignment !== undefined
			&& !this.guardWorkspaceTrust(session, assignment)
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
				&& runtime === mcpRuntime.runtime
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
		const taskDescriptor = this.taskDescriptorBySession.get(session.sessionId);
		if (taskDescriptor !== undefined) {
			this.emitTaskSessionEvent({
				type: 'started',
				tabId: session.tabId,
				sessionId: session.sessionId,
				descriptor: taskDescriptor,
			});
		}
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
		const assignment = this.assignmentBySession.get(session.sessionId);
		if (
			assignment !== undefined
			&& !this.guardWorkspaceTrust(session, assignment)
		) {
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
		const assignment = this.assignmentBySession.get(session.sessionId);
		if (
			assignment !== undefined
			&& !this.guardWorkspaceTrust(session, assignment)
		) {
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
		const assignment = this.assignmentBySession.get(session.sessionId);
		if (
			assignment !== undefined
			&& !this.guardWorkspaceTrust(session, assignment)
		) {
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
		if (this.taskDescriptorByTab.has(tabId)) {
			this.failWithoutTransition(
				tabId,
				this.sessionsById.get(sessionId) ?? null,
				'invalid_session_state',
				'Task-owned Agent tabs cannot be restarted.',
				false,
			);
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

		const assignmentAtRestart = this.assignmentByTab.get(tabId);
		if (assignmentAtRestart !== undefined) {
			let workspace: WorkspaceValidationResult;
			try {
				workspace = this.workspaceResolver(
					assignmentAtRestart.workspaceRootId,
				);
			} catch {
				this.failWithoutTransition(
					tabId,
					session,
					'internal_error',
					START_ERROR_MESSAGES.preparation,
					true,
				);
				return;
			}
			if (!workspace.ok) {
				if (workspace.code === 'workspace_untrusted') {
					await this.handleWorkspaceTrustRevoke();
				}
				this.publish(mapWorkspaceFailureToTerminalError(
					workspace,
					tabId,
					sessionId,
				));
				return;
			}
			this.observeWorkspaceTrustGranted();
			if (this.assignmentByTab.get(tabId) !== assignmentAtRestart) {
				return;
			}
		}

		const registeredAtRestart = this.registeredTabs.has(tabId);
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
					|| this.assignmentByTab.get(tabId) !== assignmentAtRestart
				)
			)
		) {
			return;
		}

		const dimensions = this.lastDimensionsByTab.get(tabId)
			?? RESTART_FALLBACK_DIMENSIONS;
		await this.startSessionForAssignment(
			tabId,
			dimensions.cols,
			dimensions.rows,
			assignmentAtRestart,
		);
	}

	/**
	 * retryable MCP failure에서만 실행 중 provider와 adapter를 함께 정리하고 fresh session을 만든다.
	 * 같은 탭의 동시 요청은 최초 transaction Promise를 공유하며 다른 탭과는 독립적이다.
	 */
	restartMcpSession(tabId: TabId, sessionId: SessionId): Promise<void> {
		if (this.taskDescriptorByTab.has(tabId)) {
			this.rejectMcpRestartForInvalidState(tabId, sessionId);
			return Promise.resolve();
		}
		const existing = this.mcpRestartByTab.get(tabId);
		if (existing !== undefined) {
			if (existing.sessionId !== sessionId) {
				this.rejectMcpRestartForInvalidState(tabId, sessionId);
				return Promise.resolve();
			}
			return existing.completion;
		}
		if (!this.canRestartMcpSession(tabId, sessionId)) {
			this.rejectMcpRestartForInvalidState(tabId, sessionId);
			return Promise.resolve();
		}

		const restart = Promise.resolve().then(() =>
			this.performMcpRestart(tabId, sessionId)
		).finally(() => {
			if (this.mcpRestartByTab.get(tabId)?.completion === restart) {
				this.mcpRestartByTab.delete(tabId);
			}
		});
		this.mcpRestartByTab.set(tabId, { sessionId, completion: restart });
		return restart;
	}

	private canRestartMcpSession(tabId: TabId, sessionId: SessionId): boolean {
		const session = this.sessionsById.get(sessionId);
		const status = this.mcpStatusBySession.get(sessionId);
		const providerId = this.assignmentByTab.get(tabId)?.providerId;
		return this.lifecycleActive
			&& session !== undefined
			&& this.ownsSession(tabId, sessionId)
			&& isMcpProviderId(providerId)
			&& session.state.kind === 'running'
			&& status?.status === 'failed'
			&& status.failure !== undefined
			&& retryabilityByFailureReason[status.failure.reason];
	}

	/** stale 요청도 Webview pending을 끝낼 수 있도록 기존 CLI를 건드리지 않는 응답을 보낸다. */
	private rejectMcpRestartForInvalidState(
		tabId: TabId,
		sessionId: SessionId,
	): void {
		this.publish({
			type: 'mcp.restartRejected',
			tabId,
			sessionId,
			code: 'invalid_session_state',
			message: START_ERROR_MESSAGES.mcpRestartUnavailable,
		});
	}

	private async performMcpRestart(
		tabId: TabId,
		sessionId: SessionId,
	): Promise<void> {
		if (!this.canRestartMcpSession(tabId, sessionId)) {
			this.rejectMcpRestartForInvalidState(tabId, sessionId);
			return;
		}
		const session = this.sessionsById.get(sessionId);
		if (session === undefined) {
			this.rejectMcpRestartForInvalidState(tabId, sessionId);
			return;
		}
		const assignment = this.assignmentByTab.get(tabId);
		if (assignment === undefined || !isMcpProviderId(assignment.providerId)) {
			this.rejectMcpRestartForInvalidState(tabId, sessionId);
			return;
		}
		let workspace: WorkspaceValidationResult;
		try {
			workspace = this.workspaceResolver(assignment.workspaceRootId);
		} catch {
			this.publish(mapWorkspaceFailureToMcpRestartRejected(
				{ ok: false, code: 'workspace_root_unavailable' },
				tabId,
				sessionId,
			));
			return;
		}
		if (!workspace.ok) {
			if (workspace.code === 'workspace_untrusted') {
				await this.handleWorkspaceTrustRevoke();
				return;
			}
			this.publish(mapWorkspaceFailureToMcpRestartRejected(
				workspace,
				tabId,
				sessionId,
			));
			return;
		}
		if (captureWorkspaceLaunchIdentity(
			workspace.root,
			assignment.workspaceRootId,
		) === undefined) {
			this.publish(mapWorkspaceFailureToMcpRestartRejected(
				{ ok: false, code: 'workspace_root_unavailable' },
				tabId,
				sessionId,
			));
			return;
		}
		this.observeWorkspaceTrustGranted();
		if (
			!this.canRestartMcpSession(tabId, sessionId)
			|| this.assignmentByTab.get(tabId) !== assignment
			|| this.sessionsById.get(sessionId) !== session
		) {
			this.rejectMcpRestartForInvalidState(tabId, sessionId);
			return;
		}
		try {
			workspace = this.workspaceResolver(assignment.workspaceRootId);
		} catch {
			this.publish(mapWorkspaceFailureToMcpRestartRejected(
				{ ok: false, code: 'workspace_root_unavailable' },
				tabId,
				sessionId,
			));
			return;
		}
		if (!workspace.ok) {
			if (workspace.code === 'workspace_untrusted') {
				await this.handleWorkspaceTrustRevoke();
				return;
			}
			this.publish(mapWorkspaceFailureToMcpRestartRejected(
				workspace,
				tabId,
				sessionId,
			));
			return;
		}
		if (captureWorkspaceLaunchIdentity(
			workspace.root,
			assignment.workspaceRootId,
		) === undefined) {
			this.publish(mapWorkspaceFailureToMcpRestartRejected(
				{ ok: false, code: 'workspace_root_unavailable' },
				tabId,
				sessionId,
			));
			return;
		}
		this.observeWorkspaceTrustGranted();
		if (
			!this.canRestartMcpSession(tabId, sessionId)
			|| !this.registeredTabs.has(tabId)
			|| this.assignmentByTab.get(tabId) !== assignment
			|| this.assignmentBySession.get(sessionId) !== assignment
			|| this.sessionsById.get(sessionId) !== session
			|| !this.ownsSession(tabId, sessionId)
			|| this.mcpRestartByTab.get(tabId)?.sessionId !== sessionId
		) {
			this.rejectMcpRestartForInvalidState(tabId, sessionId);
			return;
		}

		const dimensions = this.lastDimensionsByTab.get(tabId)
			?? RESTART_FALLBACK_DIMENSIONS;
		this.revokeExactActivityLease(session);
		this.clearMcpStatus(session);
		const cleanup = this.cleanupSessionProcessTree(session);
		this.removeSession(sessionId);
		await cleanup;
		if (
			!this.lifecycleActive
			|| !this.registeredTabs.has(tabId)
			|| this.assignmentByTab.get(tabId) !== assignment
			|| this.getActiveSession(tabId) !== undefined
			|| !this.mcpRestartByTab.has(tabId)
		) {
			return;
		}

		await this.startSessionForAssignment(
			tabId,
			dimensions.cols,
			dimensions.rows,
			assignment,
		);
	}

	/**
	 * Host가 새 `sessionId`를 생성하여 탭의 현재 세션을 등록한다.
	 * Webview가 제공한 `sessionId`를 받을 수 있는 인자는 두지 않는다.
	 *
	 * @param tabId Webview가 생성하고 프로토콜 검증을 통과한 탭 식별자
	 * @returns 대기 상태로 등록된 새 `TerminalSession` 또는 등록할 수 없으면 `undefined`
	 */
	private createSession(
		tabId: TabId,
		assignment: AgentAssignment | undefined = this.assignmentByTab.get(tabId),
	): TerminalSession | undefined {
		if (this.activeSessionByTab.has(tabId)) {
			return undefined;
		}

		const generatedSessionId = this.sessionIdAllocator.allocate(
			(sessionId) => this.sessionsById.has(sessionId),
		);
		if (generatedSessionId === undefined) {
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
		if (assignment !== undefined) {
			this.assignmentBySession.set(generatedSessionId, assignment);
		}
		const taskDescriptor = this.taskDescriptorByTab.get(tabId);
		if (taskDescriptor !== undefined) {
			this.taskDescriptorBySession.set(generatedSessionId, taskDescriptor);
			const taskWorkingDirectory = this.taskWorkingDirectoryByTab.get(tabId);
			if (taskWorkingDirectory !== undefined) {
				this.taskWorkingDirectoryBySession.set(
					generatedSessionId,
					taskWorkingDirectory,
				);
			}
		}
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
		this.stopWorkspaceTrustMonitor();
		const ownedSessions = [...this.sessionsById.values()];
		for (const session of ownedSessions) {
			this.revokeExactActivityLease(session);
		}
		/**
		 * Activity cleanup은 live Webview에 clear를 admission할 수 있어야 하므로
		 * inbound lifecycle gate를 닫은 뒤 outbound delivery/Supervisor teardown보다
		 * 먼저 exact lease를 회수한다.
		 */
		this.stopMessageDelivery();
		this.beginMcpTermination();
		const processes: PtyProcessHandle[] = [];
		const preparationCleanups: Promise<void>[] = [];
		for (const session of ownedSessions) {
			preparationCleanups.push(
				this.cancelSessionPreparation(session.sessionId),
			);
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
		this.detachedPreparationCleanups = Object.freeze(preparationCleanups);
		this.sessionsById.clear();
		this.activeSessionByTab.clear();
		this.providerAutoRunInputBySession.clear();
		this.mcpRuntimeBySession.clear();
		this.mcpPtySpawnStarted.clear();
		this.claudeStartupBySession.clear();
		this.mcpStatusBySession.clear();
		this.mcpRestartByTab.clear();
		for (const tabId of this.taskWorkingDirectoryByTab.keys()) {
			void this.cleanupTaskWorkingDirectory(tabId);
		}
		this.taskDescriptorByTab.clear();
		this.taskDescriptorBySession.clear();
		this.expectedTaskSessionStops.clear();
		this.taskWorkingDirectoryBySession.clear();
		this.lastDimensionsByTab.clear();
		this.registeredTabs.clear();
		this.assignmentByTab.clear();
		this.assignmentRevisionByTab.clear();
		this.assignmentBySession.clear();
		this.activityLeaseStateBySession?.clear();
		this.workspaceTrustFailedSessions.clear();
		this.preparationBySession.clear();
		this.resettingTabs.clear();
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
			...this.detachedPreparationCleanups,
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
	 * 실행 중 session을 routing에서 즉시 분리하고 provider 준비 child, MCP와 전체 process
	 * tree 정리를 같은 탭 barrier에서 기다린다.
	 * 유효 PID를 확보할 수 없거나 capture/terminate가 실패하면 root handle kill로 수렴한다.
	 * 같은 session의 반복 요청은 최초 cleanup Promise를 재사용한다.
	 */
	private cleanupSessionProcessTree(session: TerminalSession): Promise<void> {
		this.revokeExactActivityLease(session);
		const preparationCleanup = this.cancelSessionPreparation(session.sessionId);
		const existing = this.processCleanupBySession.get(session.sessionId);
		if (existing !== undefined) {
			return this.getTabCleanupBarrier(session.tabId) ?? existing;
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
		this.updateWorkspaceTrustMonitor();

		const cleanup = Promise.all([
			preparationCleanup,
			mcpCleanup,
			process === undefined
				? Promise.resolve()
				: this.terminateProcessTree(process),
		]).then(() => undefined, () => undefined);
		this.processCleanupBySession.set(session.sessionId, cleanup);
		const barrier = this.registerTabCleanup(session.tabId, cleanup);
		void cleanup.then(() => {
			if (this.processCleanupBySession.get(session.sessionId) === cleanup) {
				this.processCleanupBySession.delete(session.sessionId);
			}
		});
		return barrier;
	}

	/** 앞선 barrier와 새 cleanup을 결합해 같은 탭의 cleanup을 빠짐없이 직렬화한다. */
	private registerTabCleanup(
		tabId: TabId,
		cleanup: Promise<void>,
	): Promise<void> {
		const previous = this.tabCleanupBarrier.get(tabId);
		const barrier = previous === undefined
			? cleanup
			: Promise.all([previous, cleanup]).then(() => undefined, () => undefined);
		this.tabCleanupBarrier.set(tabId, barrier);
		void barrier.then(() => {
			if (this.tabCleanupBarrier.get(tabId) === barrier) {
				this.tabCleanupBarrier.delete(tabId);
			}
		});
		return barrier;
	}

	/** 같은 탭에서 앞서 분리한 모든 resource가 끝날 때까지 다음 시작을 보류한다. */
	private getTabCleanupBarrier(tabId: TabId): Promise<void> | undefined {
		return this.tabCleanupBarrier.get(tabId);
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
		this.stopWorkspaceTrustMonitor();
		const ownedSessions = [...this.sessionsById.values()];
		for (const session of ownedSessions) {
			this.revokeExactActivityLease(session);
		}
		this.beginMcpTermination();

		for (const session of ownedSessions) {
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
		for (const tabId of this.taskWorkingDirectoryByTab.keys()) {
			void this.cleanupTaskWorkingDirectory(tabId);
		}
		this.taskDescriptorByTab.clear();
		this.taskDescriptorBySession.clear();
		this.expectedTaskSessionStops.clear();
		this.taskWorkingDirectoryBySession.clear();
		this.lastDimensionsByTab.clear();
		this.registeredTabs.clear();
		this.assignmentByTab.clear();
		this.assignmentRevisionByTab.clear();
		this.assignmentBySession.clear();
		this.activityLeaseStateBySession?.clear();
		this.workspaceTrustFailedSessions.clear();
		this.preparationBySession.clear();
		this.resettingTabs.clear();
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
		const assignment = this.assignmentBySession.get(session.sessionId);
		if (
			assignment !== undefined
			&& !this.guardWorkspaceTrust(session, assignment)
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
		const authenticatedRuntime = this.mcpRuntimeBySession.get(
			session.sessionId,
		)?.runtime;
		this.revokeExactActivityLease(session, authenticatedRuntime);
		const taskDescriptor = this.taskDescriptorBySession.get(session.sessionId);
		const claudeFallback = taskDescriptor === undefined
			? this.getClaudeStartupFallback(session, event)
			: undefined;
		session.markExited(event.exitCode, signal);
		this.updateWorkspaceTrustMonitor();
		if (claudeFallback !== undefined && authenticatedRuntime !== undefined) {
			void this.relaunchClaudeBareAfterStartupRejection(
				session,
				claudeFallback.preparation,
				claudeFallback.reason,
				authenticatedRuntime,
				() => {
					if (
						this.isCurrentSession(session)
						&& session.state.kind === 'exited'
					) {
						this.publishTerminalExited(session, event);
					}
				},
			);
			return;
		}
		this.clearMcpStatus(session);
		void this.cleanupMcpSession(session.sessionId);
		this.publishTerminalExited(session, event);
		if (taskDescriptor !== undefined) {
			this.emitTaskSessionEvent({
				type: 'exited',
				tabId: session.tabId,
				sessionId: session.sessionId,
				descriptor: taskDescriptor,
				exitCode: event.exitCode,
				signal,
				expected: this.expectedTaskSessionStops.has(session.sessionId),
			});
		}
	}

	/** Captured PTY exit payload를 credential-free public message로 한 번 전달한다. */
	private publishTerminalExited(
		session: TerminalSession,
		event: PtyExitEvent,
	): void {
		this.publish({
			type: 'terminal.exited',
			tabId: session.tabId,
			sessionId: session.sessionId,
			exitCode: event.exitCode,
			...(event.signal === undefined ? {} : { signal: event.signal }),
		});
	}

	/** Exact pre-interactive Claude diagnostics are the sole post-spawn bare fallback signal. */
	private getClaudeStartupFallback(
		session: TerminalSession,
		event: PtyExitEvent,
	): ClaudeStartupFallback | undefined {
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
		return rejection === undefined
			? undefined
			: Object.freeze({ preparation: startup.preparation, reason: rejection });
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
		reason: Extract<
			McpFailureReason,
			'provider_config_rejected' | 'provider_policy_blocked'
		>,
		authenticatedRuntime: McpSessionRuntime,
		onReplacementPreserved?: () => void,
	): Promise<void> {
		if (!this.isCurrentProviderSession(oldSession, 'claude')) {
			return;
		}
		const assignment = this.assignmentBySession.get(oldSession.sessionId);
		if (assignment?.providerId !== 'claude') {
			return;
		}
		const tabId = oldSession.tabId;
		const dimensions = this.lastDimensionsByTab.get(tabId)
			?? RESTART_FALLBACK_DIMENSIONS;
		const supervisorRuntimeBeforeCleanup = this.mcpSupervisor
			?.getSessionRuntime(oldSession.sessionId);
		const hostRuntimeBeforeCleanup = this.mcpRuntimeBySession.get(
			oldSession.sessionId,
		)?.runtime;
		this.revokeExactActivityLease(oldSession, authenticatedRuntime);
		await this.cleanupMcpSession(
			oldSession.sessionId,
			authenticatedRuntime,
		);
		const supervisorRuntimeAfterCleanup = this.mcpSupervisor
			?.getSessionRuntime(oldSession.sessionId);
		const hostRuntimeAfterCleanup = this.mcpRuntimeBySession.get(
			oldSession.sessionId,
		)?.runtime;
		if (
			(
				supervisorRuntimeBeforeCleanup !== undefined
				&& supervisorRuntimeBeforeCleanup !== authenticatedRuntime
			)
			|| (
				hostRuntimeBeforeCleanup !== undefined
				&& hostRuntimeBeforeCleanup !== authenticatedRuntime
			)
			|| (
				supervisorRuntimeAfterCleanup !== undefined
				&& supervisorRuntimeAfterCleanup !== authenticatedRuntime
			)
			|| (
				hostRuntimeAfterCleanup !== undefined
				&& hostRuntimeAfterCleanup !== authenticatedRuntime
			)
			|| !this.isCurrentProviderSession(oldSession, 'claude')
			|| this.assignmentBySession.get(oldSession.sessionId) !== assignment
			|| this.assignmentByTab.get(tabId) !== assignment
		) {
			try {
				onReplacementPreserved?.();
			} catch {
				/** Exit finalization consumer failure does not affect exact retirement. */
			}
			return;
		}
		try {
			oldSession.disposeProcess();
			oldSession.markDisposed();
		} catch {
			/** The exited PTY has no remaining input ownership; MCP cleanup still continues. */
		}
		this.removeSessionAfterExactMcpCleanup(
			oldSession.sessionId,
			authenticatedRuntime,
		);

		if (
			!this.lifecycleActive
			|| !this.registeredTabs.has(tabId)
			|| this.assignmentByTab.get(tabId) !== assignment
			|| this.getActiveSession(tabId) !== undefined
		) {
			return;
		}

		const session = this.createSession(tabId, assignment);
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
		this.recordMcpFailure(session, reason);
		this.publish({
			type: 'terminal.starting',
			tabId,
			sessionId: session.sessionId,
		});
		this.updateWorkspaceTrustMonitor();

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
		let finalWorkspace: WorkspaceValidationResult;
		try {
			finalWorkspace = this.workspaceResolver(assignment.workspaceRootId);
		} catch {
			this.failSession(
				session,
				'internal_error',
				START_ERROR_MESSAGES.preparation,
				true,
			);
			return;
		}
		if (!finalWorkspace.ok) {
			await this.failWorkspaceStart(session, assignment, finalWorkspace);
			return;
		}
		const launchIdentity = captureWorkspaceLaunchIdentity(
			finalWorkspace.root,
			assignment.workspaceRootId,
		);
		if (launchIdentity === undefined) {
			await this.failWorkspaceStart(session, assignment, {
				ok: false,
				code: 'workspace_root_unavailable',
			});
			return;
		}
		if (
			!this.isCurrentProviderSession(session, 'claude')
			|| this.assignmentBySession.get(session.sessionId) !== assignment
			|| this.assignmentByTab.get(tabId) !== assignment
		) {
			return;
		}
		this.observeWorkspaceTrustGranted();
		const finalRequest = Object.freeze({
			...request,
			cwd: launchIdentity.fsPath,
		});

		this.lastDimensionsByTab.set(tabId, dimensions);
		try {
			const spawned = this.spawnProviderPty(
				session,
				finalRequest,
				dimensions.cols,
				dimensions.rows,
			);
			await spawned;
		} catch {
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

	/** 값이 같은 재할당도 구분하도록 현재 assignment object identity를 검사한다. */
	private isCurrentAssignment(
		tabId: TabId,
		assignment: AgentAssignment | undefined,
	): boolean {
		return this.lifecycleActive
			&& this.assignmentByTab.get(tabId) === assignment;
	}

	/** current session과 그 시작 시 capture한 assignment identity를 함께 검사한다. */
	private isCurrentAssignmentSession(
		session: TerminalSession,
		assignment: AgentAssignment | undefined,
	): boolean {
		return this.lifecycleActive
			&& this.isCurrentSession(session)
			&& !this.workspaceTrustFailedSessions.has(session.sessionId)
			&& this.assignmentByTab.get(session.tabId) === assignment
			&& this.assignmentBySession.get(session.sessionId) === assignment;
	}

	/** 성공한 assignment/reset commit의 Webview ordering revision을 한 번 증가시킨다. */
	private incrementAssignmentRevision(tabId: TabId): number {
		const revision = (this.assignmentRevisionByTab.get(tabId) ?? 0) + 1;
		this.assignmentRevisionByTab.set(tabId, revision);
		return revision;
	}

	/** Session object identity와 현재 provider 배정을 하나의 attempt gate로 검사한다. */
	private isCurrentProviderSession(
		session: TerminalSession,
		providerId: ProviderId,
	): boolean {
		return this.lifecycleActive
			&& this.isCurrentSession(session)
			&& !this.workspaceTrustFailedSessions.has(session.sessionId)
			&& this.assignmentBySession.get(session.sessionId)?.providerId === providerId
			&& this.assignmentByTab.get(session.tabId)
				=== this.assignmentBySession.get(session.sessionId);
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
			&& ownership.runtime === runtime
			&& runtime?.generation === generation
			&& runtime.lifecycle === 'running';
	}

	/** Final resolver identity와 exact runtime을 native spawn 직전에 하나의 lease로 묶는다. */
	private installActivityLease(
		session: TerminalSession,
		assignment: AgentAssignment,
		runtime: McpSessionRuntime,
		launchIdentity: WorkspaceLaunchIdentity,
	): ActivityLease | undefined {
		const states = this.activityLeaseStateBySession;
		const ownership = this.mcpRuntimeBySession.get(session.sessionId);
		if (
			states === undefined
			|| !this.agentActivityCompatible
			|| !this.isCurrentProviderSession(session, assignment.providerId)
			|| this.assignmentBySession.get(session.sessionId) !== assignment
			|| this.assignmentByTab.get(session.tabId) !== assignment
			|| ownership?.runtime !== runtime
			|| ownership.generation !== runtime.generation
			|| this.mcpSupervisor?.getSessionRuntime(session.sessionId) !== runtime
			|| runtime.lifecycle !== 'running'
		) {
			return undefined;
		}

		let state = states.get(session.sessionId);
		if (
			state !== undefined
			&& (state.session !== session || state.assignment !== assignment)
		) {
			this.revokeExactActivityLease(state.session);
			if (states.get(session.sessionId) === state) {
				states.delete(session.sessionId);
			}
			state = undefined;
		}
		if (state === undefined) {
			state = {
				session,
				assignment,
				nextEpoch: 1,
			};
			states.set(session.sessionId, state);
		} else if (state.lease !== undefined) {
			this.revokeExactActivityLease(session, state.lease.runtime);
		}

		const epoch = state.nextEpoch;
		if (!Number.isSafeInteger(epoch) || (epoch ?? 0) < 1) {
			return undefined;
		}
		const lease = createActivityLeaseRecord({
			session,
			assignment,
			providerId: assignment.providerId,
			workspaceRootId: assignment.workspaceRootId,
			runtime,
			generation: runtime.generation,
			launchRootUri: launchIdentity.uri,
			launchRootFsPath: launchIdentity.fsPath,
			epoch: epoch!,
			revoked: false,
		});
		state.lease = lease;
		return lease;
	}

	/** Exact current lease를 한 번 revoke하고 Phase 4 cleanup seam을 teardown 전에 호출한다. */
	private revokeExactActivityLease(
		session: TerminalSession,
		expectedRuntime?: McpSessionRuntime,
	): ActivityLease | undefined {
		const states = this.activityLeaseStateBySession;
		const state = states?.get(session.sessionId);
		const lease = state?.lease;
		if (
			state === undefined
			|| lease === undefined
			|| state.session !== session
			|| lease.session !== session
			|| (expectedRuntime !== undefined && lease.runtime !== expectedRuntime)
			|| lease.revoked
		) {
			return undefined;
		}

		lease.revoked = true;
		delete state.lease;
		state.nextEpoch = lease.epoch < Number.MAX_SAFE_INTEGER
			? lease.epoch + 1
			: undefined;
		try {
			this.onActivityLeaseRevoked?.(lease);
		} catch {
			/** Phase 4 cleanup consumer 실패도 권한 회수와 resource teardown을 막지 않는다. */
		}
		return lease;
	}

	/**
	 * Phase 4 bridge가 fresh resolver 실패를 발견했을 때 Host-owned lease state와
	 * epoch를 보존하며 exact current lease만 회수한다. Trust 상실은 기존 전역
	 * Trust cleanup 경계로 보내고, 그 밖의 root 실패는 CLI/process를 유지한다.
	 */
	handleAgentActivityWorkspaceFailure(
		lease: ActivityLease,
		failure: WorkspaceValidationFailure,
	): void {
		if (!this.isExactCurrentActivityLease(lease)) {
			return;
		}
		if (failure.code === 'workspace_untrusted') {
			void this.handleWorkspaceTrustRevoke();
			return;
		}

		this.revokeAgentActivityLease(lease);
	}

	/** Sequence/capability fail-closed 경로가 exact lease만 Host-owned 방식으로 회수한다. */
	revokeAgentActivityLease(lease: ActivityLease): void {
		if (!this.isExactCurrentActivityLease(lease)) {
			return;
		}

		this.revokeExactActivityLease(lease.session, lease.runtime);
	}

	/**
	 * Workspace Folder callback의 같은 turn에서 removed root를 먼저 회수하고,
	 * 남은 lease도 fresh resolver로 exact launch identity와 다시 대조한다.
	 * 일반 File watcher event에서는 이 진입점을 호출하지 않는다.
	 */
	handleAgentActivityWorkspaceFoldersChanged(
		removedWorkspaceRootIds: readonly WorkspaceRootId[],
	): void {
		const states = this.activityLeaseStateBySession;
		if (states === undefined || !this.agentActivityCompatible) {
			return;
		}
		const removed = new Set<WorkspaceRootId>(removedWorkspaceRootIds);
		const leases = [...states.values()]
			.map((state) => state.lease)
			.filter((lease): lease is ActivityLease => lease !== undefined);

		for (const lease of leases) {
			if (!this.isExactCurrentActivityLease(lease)) {
				continue;
			}
			if (removed.has(lease.workspaceRootId)) {
				this.handleAgentActivityWorkspaceFailure(lease, {
					ok: false,
					code: 'workspace_root_unavailable',
				});
				continue;
			}

			let resolution: WorkspaceValidationResult;
			try {
				resolution = this.workspaceResolver(lease.workspaceRootId);
			} catch {
				resolution = { ok: false, code: 'workspace_root_unavailable' };
			}
			if (!resolution.ok) {
				this.handleAgentActivityWorkspaceFailure(lease, resolution);
				continue;
			}
			const identity = captureWorkspaceLaunchIdentity(
				resolution.root,
				lease.workspaceRootId,
			);
			if (
				identity === undefined
				|| identity.uri !== lease.launchRootUri
				|| identity.fsPath !== lease.launchRootFsPath
			) {
				this.handleAgentActivityWorkspaceFailure(lease, {
					ok: false,
					code: 'workspace_root_unavailable',
				});
			}
		}
	}

	/** Host registry, lease object와 current epoch를 object identity로 함께 검사한다. */
	private isExactCurrentActivityLease(lease: ActivityLease): boolean {
		const state = this.activityLeaseStateBySession?.get(lease.session.sessionId);
		return this.lifecycleActive
			&& !lease.revoked
			&& state?.lease === lease
			&& state.session === lease.session
			&& state.assignment === lease.assignment
			&& this.sessionsById.get(lease.session.sessionId) === lease.session
			&& this.assignmentBySession.get(lease.session.sessionId) === lease.assignment
			&& this.assignmentByTab.get(lease.session.tabId) === lease.assignment;
	}

	/** Session registry 제거 시 current lease를 revoke하고 bounded epoch state도 폐기한다. */
	private forgetActivityLeaseState(session: TerminalSession): void {
		const states = this.activityLeaseStateBySession;
		if (states === undefined) {
			return;
		}
		this.revokeExactActivityLease(session);
		if (states.get(session.sessionId)?.session === session) {
			states.delete(session.sessionId);
		}
	}

	/** Exact lease gate와 Host-side lexical revalidation을 통과한 Activity만 넘긴다. */
	private handleAgentActivityRequested(
		sourceRuntime: McpSessionRuntime,
		event: AgentActivityRequested,
	): void {
		const states = this.activityLeaseStateBySession;
		const state = states?.get(event.sessionId);
		const lease = state?.lease;
		const session = this.sessionsById.get(event.sessionId);
		const ownership = this.mcpRuntimeBySession.get(event.sessionId);
		if (
			states === undefined
			|| !this.agentActivityCompatible
			|| state === undefined
			|| lease === undefined
			|| lease.revoked
			|| session === undefined
			|| state.session !== session
			|| lease.session !== session
			|| (
				session.state.kind !== 'starting'
				&& session.state.kind !== 'running'
			)
			|| !this.mcpPtySpawnStarted.has(session.sessionId)
			|| state.assignment !== lease.assignment
			|| this.activeSessionByTab.get(session.tabId) !== session.sessionId
			|| this.assignmentBySession.get(session.sessionId) !== lease.assignment
			|| this.assignmentByTab.get(session.tabId) !== lease.assignment
			|| lease.providerId !== lease.assignment.providerId
			|| lease.workspaceRootId !== lease.assignment.workspaceRootId
			|| ownership?.providerId !== lease.providerId
			|| ownership.runtime !== sourceRuntime
			|| ownership.generation !== event.generation
			|| lease.runtime !== sourceRuntime
			|| lease.generation !== event.generation
			|| sourceRuntime.sessionId !== event.sessionId
			|| sourceRuntime.generation !== event.generation
			|| sourceRuntime.lifecycle !== 'running'
			|| this.mcpSupervisor?.getSessionRuntime(event.sessionId) !== sourceRuntime
		) {
			return;
		}

		const normalized = normalizeAgentActivityPath(event.path, event.targetKind);
		if (!normalized.ok || normalized.path !== event.path) {
			return;
		}
		if (!this.guardWorkspaceTrust(session, lease.assignment)) {
			return;
		}

		try {
			this.onAgentActivityRequest?.(Object.freeze({
				lease,
				sourceRuntime,
				event,
			}));
		} catch {
			/** Host bridge consumer 실패는 runtime이나 terminal lifecycle을 변경하지 않는다. */
		}
	}

	/** Supervisor event를 current tab/session/provider/generation과 대조해 처리한다. */
	handleMcpRuntimeEvent(envelope: SupervisorRuntimeEvent): void {
		const { sourceRuntime, event } = envelope;
		const session = this.sessionsById.get(event.sessionId);
		const ownership = this.mcpRuntimeBySession.get(event.sessionId);
		const assignment = this.assignmentBySession.get(event.sessionId);
		if (
			!this.lifecycleActive
			|| session === undefined
			|| ownership === undefined
			|| assignment === undefined
			|| !this.isCurrentSession(session)
			|| this.assignmentByTab.get(session.tabId) !== assignment
			|| assignment.providerId !== ownership.providerId
			|| sourceRuntime.sessionId !== event.sessionId
			|| sourceRuntime.generation !== event.generation
			|| ownership.runtime !== sourceRuntime
			|| ownership.generation !== event.generation
			|| this.mcpSupervisor?.getSessionRuntime(event.sessionId)
				!== sourceRuntime
		) {
			return;
		}
		if (event.type === 'session.agentActivityRequested') {
			this.handleAgentActivityRequested(sourceRuntime, event);
			return;
		}
		if (event.type === 'session.taskToolRequested') {
			const descriptor = this.taskDescriptorBySession.get(session.sessionId);
			if (
				descriptor === undefined
				|| descriptor !== this.taskDescriptorByTab.get(session.tabId)
				|| descriptor.executionId !== event.executionId
				|| descriptor.workNodeId !== event.workNodeId
			) {
				return;
			}
			if (!this.guardWorkspaceTrust(session, assignment)) {
				return;
			}
			this.emitTaskSessionEvent({
				type: 'tool',
				tabId: session.tabId,
				sessionId: session.sessionId,
				descriptor,
				event,
			});
			return;
		}
		if (!this.guardWorkspaceTrust(session, assignment)) {
			return;
		}

		switch (event.type) {
			case 'session.mcpActivityObserved':
				if (ownership.providerId === 'claude') {
					const startup = this.claudeStartupBySession.get(session.sessionId);
					if (startup?.generation === event.generation) {
						startup.activityObserved = true;
					}
				}
				this.setMcpConnected(session);
				break;
			case 'runtime.failure':
				this.revokeExactActivityLease(session, sourceRuntime);
				if (ownership.providerId === 'claude') {
					this.claudeStartupBySession.delete(session.sessionId);
				}
				this.recordMcpFailure(session, event.failure.reason);
				void this.cleanupMcpSession(session.sessionId, sourceRuntime);
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
		const assignment = this.assignmentBySession.get(session.sessionId);
		if (
			assignment === undefined
			|| !this.isCurrentAssignmentSession(session, assignment)
			|| session.state.kind !== 'running'
		) {
			return;
		}
		if (!this.guardWorkspaceTrust(session, assignment)) {
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
		if (!record.published || !this.isCurrentSession(session)) {
			return;
		}
		const assignment = this.assignmentBySession.get(session.sessionId);
		if (assignment !== undefined && !this.readWorkspaceTrustFresh()) {
			/** 현재 lifecycle transition이 끝난 뒤 revoke cleanup이 안전하게 error를 commit한다. */
			queueMicrotask(() => void this.handleWorkspaceTrustRevoke());
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
		return this.removeSessionWithMcpCleanup(sessionId);
	}

	/** Exact attempt cleanup 뒤 같은 sessionId의 replacement를 다시 조회하지 않고 제거한다. */
	private removeSessionAfterExactMcpCleanup(
		sessionId: SessionId,
		expectedRuntime: McpSessionRuntime,
	): TerminalSession | undefined {
		return this.removeSessionWithMcpCleanup(sessionId, expectedRuntime);
	}

	private removeSessionWithMcpCleanup(
		sessionId: SessionId,
		expectedRuntime?: McpSessionRuntime,
	): TerminalSession | undefined {
		const session = this.sessionsById.get(sessionId);
		if (session === undefined) {
			return undefined;
		}

		this.forgetActivityLeaseState(session);
		this.clearMcpStatus(session);
		this.sessionsById.delete(sessionId);
		this.assignmentBySession.delete(sessionId);
		this.taskDescriptorBySession.delete(sessionId);
		this.taskWorkingDirectoryBySession.delete(sessionId);
		this.expectedTaskSessionStops.delete(sessionId);
		this.workspaceTrustFailedSessions.delete(sessionId);
		void this.cancelSessionPreparation(sessionId);
		this.providerAutoRunInputBySession.delete(sessionId);
		void this.cleanupMcpSession(sessionId, expectedRuntime);
		if (this.activeSessionByTab.get(session.tabId) === sessionId) {
			this.activeSessionByTab.delete(session.tabId);
		}
		this.updateWorkspaceTrustMonitor();
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

	/** 별도 child를 만들 수 있는 provider 준비 작업을 session-scoped AbortSignal에 연결한다. */
	private runSessionPreparation<Result>(
		session: TerminalSession,
		operation: (signal: AbortSignal) => Promise<Result>,
	): Promise<Result> {
		const previous = this.preparationBySession.get(session.sessionId);
		previous?.controller.abort();

		const controller = new AbortController();
		let complete!: () => void;
		const completion = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const ownership = Object.freeze({ controller, completion });
		this.preparationBySession.set(session.sessionId, ownership);

		let work: Promise<Result>;
		try {
			work = operation(controller.signal);
		} catch (error: unknown) {
			work = Promise.reject(error);
		}
		void work.then(complete, complete);
		void completion.then(() => {
			if (this.preparationBySession.get(session.sessionId) === ownership) {
				this.preparationBySession.delete(session.sessionId);
			}
		});
		return work;
	}

	/** Revoke/cleanup이 현재 provider 준비 작업을 중단하고 child tree 종료 완료를 공유한다. */
	private cancelSessionPreparation(sessionId: SessionId): Promise<void> {
		const ownership = this.preparationBySession.get(sessionId);
		if (ownership === undefined) {
			return Promise.resolve();
		}
		ownership.controller.abort();
		return ownership.completion;
	}

	/** Trust reader 예외를 실행 허용으로 해석하지 않고 fail-closed boolean으로 수렴한다. */
	private readWorkspaceTrustFresh(): boolean {
		try {
			return this.readWorkspaceTrust() === true;
		} catch {
			return false;
		}
	}

	/**
	 * Terminal I/O, provider-started, MCP spawn/status 경계에서 Trust를 fresh하게 확인한다.
	 * Root removal이나 path 상태는 이 경계에서 검사하지 않으므로 실행 중 retention 정책을
	 * 그대로 유지한다.
	 */
	private guardWorkspaceTrust(
		session: TerminalSession,
		assignment: AgentAssignment,
	): boolean {
		if (
			!this.lifecycleActive
			|| this.workspaceTrustFailedSessions.has(session.sessionId)
			|| this.sessionsById.get(session.sessionId) !== session
			|| this.activeSessionByTab.get(session.tabId) !== session.sessionId
			|| this.assignmentBySession.get(session.sessionId) !== assignment
			|| this.assignmentByTab.get(session.tabId) !== assignment
		) {
			return false;
		}
		if (this.readWorkspaceTrustFresh()) {
			this.observeWorkspaceTrustGranted();
			return true;
		}

		void this.handleWorkspaceTrustRevoke();
		return false;
	}

	/** Fresh trusted boundary가 다음 revoke epoch와 monitor를 다시 활성화한다. */
	private observeWorkspaceTrustGranted(): void {
		this.workspaceTrustRevokedObserved = false;
		this.workspaceTrustRevokeCleanup = undefined;
		this.updateWorkspaceTrustMonitor();
	}

	/** starting/running/stopping assignment가 있는 동안 하나의 bounded monitor만 유지한다. */
	private updateWorkspaceTrustMonitor(): void {
		const hasActiveAssignedSession = this.lifecycleActive
			&& !this.workspaceTrustRevokedObserved
			&& [...this.sessionsById.values()].some((session) => (
				this.assignmentBySession.has(session.sessionId)
				&& !this.workspaceTrustFailedSessions.has(session.sessionId)
				&& (
					session.state.kind === 'starting'
					|| session.state.kind === 'running'
					|| session.state.kind === 'stopping'
				)
			));
		if (!hasActiveAssignedSession) {
			this.stopWorkspaceTrustMonitor();
			return;
		}
		if (this.workspaceTrustMonitorHandle !== undefined) {
			return;
		}

		try {
			this.workspaceTrustMonitorHandle =
				this.workspaceTrustMonitorScheduler.setInterval(
					() => this.pollWorkspaceTrust(),
					WORKSPACE_TRUST_MONITOR_INTERVAL_MS,
				);
		} catch {
			this.workspaceTrustMonitorHandle = undefined;
		}
	}

	/** Interval tick마다 Trust만 읽고 session이 사라졌으면 monitor를 즉시 해제한다. */
	private pollWorkspaceTrust(): void {
		if (!this.lifecycleActive) {
			this.stopWorkspaceTrustMonitor();
			return;
		}
		const hasActiveAssignedSession = [...this.sessionsById.values()].some(
			(session) => this.assignmentBySession.has(session.sessionId)
				&& !this.workspaceTrustFailedSessions.has(session.sessionId)
				&& (
					session.state.kind === 'starting'
					|| session.state.kind === 'running'
					|| session.state.kind === 'stopping'
				),
		);
		if (!hasActiveAssignedSession) {
			this.stopWorkspaceTrustMonitor();
			return;
		}
		if (!this.readWorkspaceTrustFresh()) {
			void this.handleWorkspaceTrustRevoke();
		}
	}

	/** Panel runtime이 소유한 Trust interval을 멱등하게 해제한다. */
	private stopWorkspaceTrustMonitor(): void {
		const handle = this.workspaceTrustMonitorHandle;
		this.workspaceTrustMonitorHandle = undefined;
		if (handle === undefined) {
			return;
		}
		try {
			this.workspaceTrustMonitorScheduler.clearInterval(handle);
		} catch {
			/** Monitor 해제 실패가 session routing 차단과 process cleanup을 막지 않는다. */
		}
	}

	/**
	 * 같은 untrusted epoch를 한 번만 처리하고 모든 active Agent/MCP ownership을 동기적으로
	 * 분리한 뒤 process tree cleanup Promise를 공유한다.
	 */
	private handleWorkspaceTrustRevoke(): Promise<void> {
		if (this.workspaceTrustRevokedObserved) {
			return this.workspaceTrustRevokeCleanup ?? Promise.resolve();
		}

		this.workspaceTrustRevokedObserved = true;
		this.stopWorkspaceTrustMonitor();
		try {
			this.onWorkspaceTrustRevoked();
		} catch {
			/** Presentation refresh 알림 실패가 실행 권한 회수와 정리를 막지 않는다. */
		}

		const cleanup = Promise.all(
			[...this.sessionsById.values()].map((session) => {
				const assignment = this.assignmentBySession.get(session.sessionId);
				return assignment === undefined
					? Promise.resolve()
					: this.failRunningSessionForTrustRevoke(session, assignment);
			}),
		).then(() => undefined, () => undefined);
		this.workspaceTrustRevokeCleanup = cleanup;
		return cleanup;
	}

	/**
	 * Revoke 대상 session을 current retry identity로 보존하면서 I/O, MCP publication과 native
	 * process ownership을 먼저 분리하고 `workspace_untrusted` error를 발행한다.
	 */
	private failRunningSessionForTrustRevoke(
		session: TerminalSession,
		assignment: AgentAssignment,
	): Promise<void> {
		if (
			!this.lifecycleActive
			|| this.sessionsById.get(session.sessionId) !== session
			|| this.activeSessionByTab.get(session.tabId) !== session.sessionId
			|| this.assignmentBySession.get(session.sessionId) !== assignment
			|| this.assignmentByTab.get(session.tabId) !== assignment
			|| (
				session.state.kind !== 'starting'
				&& session.state.kind !== 'running'
				&& session.state.kind !== 'stopping'
			)
		) {
			return Promise.resolve();
		}

		this.revokeExactActivityLease(session);
		this.workspaceTrustFailedSessions.add(session.sessionId);
		this.providerAutoRunInputBySession.delete(session.sessionId);
		this.mcpStatusBySession.delete(session.sessionId);
		const preparationCleanup = this.cancelSessionPreparation(session.sessionId);

		let process: PtyProcessHandle | undefined;
		try {
			process = session.detachProcess();
		} catch {
			/** Listener 분리 실패도 error 전이와 남은 Agent/MCP 정리를 막지 않는다. */
		}
		const mcpCleanup = this.cleanupMcpSession(session.sessionId);

		if (
			this.sessionsById.get(session.sessionId) === session
			&& this.activeSessionByTab.get(session.tabId) === session.sessionId
			&& this.assignmentBySession.get(session.sessionId) === assignment
			&& this.assignmentByTab.get(session.tabId) === assignment
		) {
			try {
				session.markError('workspace_untrusted');
				this.publish(mapWorkspaceFailureToTerminalError(
					{ ok: false, code: 'workspace_untrusted' },
					session.tabId,
					session.sessionId,
				));
			} catch {
				/** 이미 stale한 lifecycle이면 captured resource cleanup만 계속한다. */
			}
		}
		this.updateWorkspaceTrustMonitor();

		const cleanup = Promise.all([
			preparationCleanup,
			mcpCleanup,
			process === undefined
				? Promise.resolve()
				: this.terminateProcessTree(process),
		]).then(() => undefined, () => undefined);
		this.processCleanupBySession.set(session.sessionId, cleanup);
		const barrier = this.registerTabCleanup(session.tabId, cleanup);
		void cleanup.then(() => {
			if (this.processCleanupBySession.get(session.sessionId) === cleanup) {
				this.processCleanupBySession.delete(session.sessionId);
			}
		});
		return barrier;
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
		this.revokeExactActivityLease(session);
		void this.cancelSessionPreparation(session.sessionId);
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
		this.updateWorkspaceTrustMonitor();
	}

	/** Captured exact runtime만 ownership에서 분리하고 supervisor retirement에 위임한다. */
	private cleanupMcpSession(
		sessionId: SessionId,
		expectedRuntime?: McpSessionRuntime,
	): Promise<void> {
		const supervisor = this.mcpSupervisor;
		const ownership = this.mcpRuntimeBySession.get(sessionId);
		const retires = new Set<McpSessionRuntime>();
		if (expectedRuntime !== undefined) {
			retires.add(expectedRuntime);
		} else {
			const supervisorCurrent = supervisor?.getSessionRuntime(sessionId);
			if (supervisorCurrent !== undefined) {
				retires.add(supervisorCurrent);
			}
			if (ownership !== undefined) {
				retires.add(ownership.runtime);
			}
		}
		if (
			expectedRuntime === undefined
			|| ownership?.runtime === expectedRuntime
		) {
			const session = this.sessionsById.get(sessionId);
			if (session !== undefined) {
				this.revokeExactActivityLease(session, expectedRuntime);
			}
			this.mcpRuntimeBySession.delete(sessionId);
			this.mcpPtySpawnStarted.delete(sessionId);
			this.claudeStartupBySession.delete(sessionId);
		}
		if (supervisor === undefined || retires.size === 0) {
			return Promise.resolve();
		}
		return Promise.all(
			[...retires].map((runtime) => {
				try {
					return supervisor.retireExactRuntime(runtime)
						.catch(() => undefined);
				} catch {
					return Promise.resolve();
				}
			}),
		).then(() => undefined);
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

	private emitTaskSessionEvent(event: TaskTerminalSessionEvent): void {
		try {
			this.onTaskSessionEvent?.(Object.freeze(event));
		} catch {
			/** Task controller 실패는 TerminalHost resource lifecycle을 변경하지 않는다. */
		}
	}

	private async cleanupTaskWorkingDirectory(tabId: TabId): Promise<void> {
		const directory = this.taskWorkingDirectoryByTab.get(tabId);
		if (directory === undefined) {
			return;
		}
		this.taskWorkingDirectoryByTab.delete(tabId);
		try {
			await rm(directory, { recursive: true, force: true, maxRetries: 2 });
		} catch {
			/** Session temp 정리 실패는 다른 Task/Terminal cleanup을 막지 않는다. */
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
		this.revokeExactActivityLease(session);
		void this.cancelSessionPreparation(session.sessionId);
		const ownsDirectProviderPty = this.mcpPtySpawnStarted.has(session.sessionId);
		this.clearMcpStatus(session);
		session.markError(code);
		this.updateWorkspaceTrustMonitor();
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

	/** post-assignment Workspace 실패를 retry 가능한 current session으로 보존한다. */
	private async failWorkspaceStart(
		session: TerminalSession,
		assignment: AgentAssignment,
		failure: WorkspaceValidationFailure,
		exactMcpCleanup?: Readonly<{
			readonly expectedRuntime: McpSessionRuntime | undefined;
		}>,
	): Promise<void> {
		if (failure.code === 'workspace_untrusted') {
			await this.handleWorkspaceTrustRevoke();
			return;
		}
		const hasExactMcpReplacement = (
			expectedRuntime: McpSessionRuntime | undefined,
		): boolean => {
			const supervisorRuntime = this.mcpSupervisor?.getSessionRuntime(
				session.sessionId,
			);
			const hostRuntime = this.mcpRuntimeBySession.get(
				session.sessionId,
			)?.runtime;
			return (
				supervisorRuntime !== undefined
				&& supervisorRuntime !== expectedRuntime
			) || (
				hostRuntime !== undefined
				&& hostRuntime !== expectedRuntime
			);
		};
		if (exactMcpCleanup !== undefined) {
			const expectedRuntime = exactMcpCleanup.expectedRuntime;
			if (expectedRuntime !== undefined) {
				this.revokeExactActivityLease(session, expectedRuntime);
				await this.cleanupMcpSession(session.sessionId, expectedRuntime);
			}
			if (hasExactMcpReplacement(expectedRuntime)) {
				return;
			}
		} else {
			this.revokeExactActivityLease(session);
		}
		let preparationCleanup = this.cancelSessionPreparation(session.sessionId);
		if (exactMcpCleanup !== undefined) {
			await preparationCleanup;
			if (
				hasExactMcpReplacement(exactMcpCleanup.expectedRuntime)
				|| !this.isCurrentAssignmentSession(session, assignment)
			) {
				return;
			}
			preparationCleanup = Promise.resolve();
		}
		this.providerAutoRunInputBySession.delete(session.sessionId);
		this.clearMcpStatus(session);

		let process: PtyProcessHandle | undefined;
		try {
			process = session.detachProcess();
		} catch {
			/** listener 분리 실패도 MCP/runtime 정리와 safe error 전이를 막지 않는다. */
		}

		const mcpCleanup = exactMcpCleanup === undefined
			? this.cleanupMcpSession(session.sessionId)
			: Promise.resolve();
		const cleanup = Promise.all([
			preparationCleanup,
			mcpCleanup,
			process === undefined
				? Promise.resolve()
				: this.terminateProcessTree(process),
		]).then(() => undefined, () => undefined);
		await this.registerTabCleanup(session.tabId, cleanup);

		if (
			!this.isCurrentAssignmentSession(session, assignment)
			|| (
				exactMcpCleanup !== undefined
				&& hasExactMcpReplacement(exactMcpCleanup.expectedRuntime)
			)
		) {
			return;
		}
		try {
			session.markError(failure.code);
		} catch {
			return;
		}
		this.updateWorkspaceTrustMonitor();
		this.publish(mapWorkspaceFailureToTerminalError(
			failure,
			session.tabId,
			session.sessionId,
		));
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
			| 'internal_error'
			| 'workspace_change_requires_reset',
		message: string,
		canRestart: boolean,
		switchAttemptId?: SwitchAttemptId,
	): void {
		const error = {
			type: 'terminal.error',
			tabId,
			sessionId: session?.sessionId ?? null,
			code,
			message,
			canRestart,
			...(switchAttemptId === undefined ? {} : { switchAttemptId }),
		} as const;
		this.publish(error);
		const taskDescriptor = this.taskDescriptorByTab.get(tabId);
		if (
			taskDescriptor !== undefined
			&& (session === null || session.state.kind === 'error')
		) {
			this.emitTaskSessionEvent({
				type: 'failed',
				tabId,
				...(session === null ? {} : { sessionId: session.sessionId }),
				descriptor: taskDescriptor,
			});
		}
	}
}

function isValidTaskTerminalSessionDescriptor(
	value: TaskTerminalSessionDescriptor,
): boolean {
	return isValidTaskToolLease({
		executionId: value.executionId,
		workNodeId: value.workNodeId,
	})
		&& typeof value.prompt === 'string'
		&& value.prompt.trim().length > 0
		&& Buffer.byteLength(value.prompt, 'utf8')
			<= TASK_TERMINAL_PROMPT_MAX_UTF8_BYTES
		&& Array.isArray(value.scope)
		&& value.scope.length <= 256
		&& new Set(value.scope.map(({ path }) => path)).size === value.scope.length
		&& value.scope.every((target) => (
			nodePath.isAbsolute(target.path)
			&& !target.path.includes('\0')
			&& (target.kind === 'file' || target.kind === 'folder')
			&& (target.access === 'read' || target.access === 'read-write')
		));
}

function createTaskAgentPrompt(
	descriptor: TaskTerminalSessionDescriptor,
): string {
	return [
		descriptor.prompt,
		'',
		'CRISPY TASK EXECUTION CONTRACT:',
		'- Work only within the reference and work areas stated above.',
		'- Reference areas are read-only. Work areas are the only paths you may modify.',
		'- Before accessing any other path, call crispy_task_scope_request, retain its requestId, then attempt that exact access so the provider asks the user in this same Agent tab.',
		'- After the provider prompt resolves, call crispy_task_scope_result with that requestId and approved or rejected before continuing. A rejected result ends this Work.',
		'- When the work is finished, call crispy_task_complete exactly once with completed and a concise summary.',
	].join('\n');
}
