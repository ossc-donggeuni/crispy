import { randomUUID } from 'crypto';
import type {
	HostToWebviewMessage,
	SessionId,
	TabId,
	WebviewToHostMessage,
} from '../../protocol/messages';
import type { ProviderId } from '../../protocol/providers';
import {
	resolveAgentAutoRunInput,
	resolveDetectedAgentAutoRunInput,
	type AgentAutoRunInputResolver,
} from '../agent/agentProviderLaunch';
import type { PtyAdapter, PtyExitEvent } from './ptyAdapter';
import {
	prepareTerminalLaunch,
	type PrepareTerminalLaunch,
} from './prepareTerminalLaunch';
import { TerminalSession } from './terminalSession';
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

	/** Panel detach 뒤 PID snapshot과 비동기 OS 종료를 담당하는 Host controller다. */
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

	/** Panel 종료 경로에서 동기 node-pty kill을 피하는 process-tree controller다. */
	private readonly processTreeController: ProcessTreeController;

	/** Webview가 마지막으로 알린 활성 탭이며 등록된 탭만 값이 될 수 있다. */
	private activeTabId: TabId | undefined;

	/** Webview dispose 뒤 모든 terminal message 전송을 중단하는 gate다. */
	private messageDeliveryActive = true;

	/** Panel runtime에서 분리된 뒤 새 요청과 in-flight spawn을 거부하는 gate다. */
	private lifecycleActive = true;

	/** detach에서 native 호출 없이 확보한 runtime 소유 root PID 목록이다. */
	private detachedRootPids: readonly number[] = [];

	/** 반복 terminate 호출이 공유하는 최초 비동기 cleanup Promise다. */
	private terminationPromise: Promise<void> | undefined;

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
			this.disposeSessionProcess(session);
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
			this.disposeSessionProcess(session);
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
		if (current !== undefined) {
			this.disposeSessionProcess(current);
			this.removeSession(current.sessionId);
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

		this.publish({ type: 'terminal.starting', tabId });

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

		const providerId = this.providerByTab.get(tabId);
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

	/** 실제 PID가 준비된 현재 session에만 started와 provider 입력을 한 번 전달한다. */
	private handleSessionRunning(session: TerminalSession): void {
		if (
			!this.lifecycleActive
			|| !this.isCurrentSession(session)
			|| session.state.kind !== 'running'
		) {
			return;
		}

		this.publish({
			type: 'terminal.started',
			tabId: session.tabId,
			sessionId: session.sessionId,
		});
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

		this.disposeSessionProcess(session);
		this.removeSession(sessionId);

		const dimensions = this.lastDimensionsByTab.get(tabId)
			?? RESTART_FALLBACK_DIMENSIONS;
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
	 * runtime 소유 root PID만 `terminate()`가 이후 비동기 snapshot에 사용한다.
	 */
	detach(): void {
		if (!this.lifecycleActive) {
			return;
		}

		this.lifecycleActive = false;
		this.stopMessageDelivery();
		const rootPids: number[] = [];
		for (const session of [...this.sessionsById.values()]) {
			if (session.state.kind === 'running') {
				try {
					session.markStopping();
				} catch {
					/** 상태 표시 실패도 동기 routing 분리를 막지 않는다. */
				}
			}

			try {
				const pid = session.detachProcess();
				if (pid !== undefined) {
					rootPids.push(pid);
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

		this.detachedRootPids = Object.freeze([...new Set(rootPids)]);
		this.sessionsById.clear();
		this.activeSessionByTab.clear();
		this.providerAutoRunInputBySession.clear();
		this.lastDimensionsByTab.clear();
		this.registeredTabs.clear();
		this.providerByTab.clear();
		this.activeTabId = undefined;
	}

	/**
	 * detach에서 확보한 root마다 종료 전 snapshot을 얻고 비동기 OS adapter로 정리한다.
	 * 여러 session 중 하나가 실패해도 나머지를 계속하며 반복 호출은 같은 Promise를 반환한다.
	 *
	 * @returns 모든 root 정리가 완료되면 이행되는 최초 cleanup Promise
	 */
	terminate(): Promise<void> {
		this.detach();
		this.terminationPromise ??= Promise.all(
			this.detachedRootPids.map(async (rootPid) => {
				try {
					const capture = await this.processTreeController.capture(rootPid);
					if (capture.status !== 'captured') {
						return;
					}
					await this.processTreeController.terminate(capture.snapshot);
				} catch {
					/** 원본 process/command 오류를 호출자나 로그로 전파하지 않는다. */
				}
			}),
		).then(() => undefined, () => undefined);
		return this.terminationPromise;
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

		for (const session of [...this.sessionsById.values()]) {
			this.disposeSessionProcess(session);
		}

		this.sessionsById.clear();
		this.activeSessionByTab.clear();
		this.providerAutoRunInputBySession.clear();
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
		session.markExited(event.exitCode, signal);
		this.publish({
			type: 'terminal.exited',
			tabId: session.tabId,
			sessionId: session.sessionId,
			exitCode: event.exitCode,
			...(event.signal === undefined ? {} : { signal: event.signal }),
		});
	}

	/** 전달받은 객체가 현재 tab/session 양방향 소유 관계와 동일한지 확인한다. */
	private isCurrentSession(session: TerminalSession): boolean {
		return this.sessionsById.get(session.sessionId) === session
			&& this.activeSessionByTab.get(session.tabId) === session.sessionId;
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

		this.sessionsById.delete(sessionId);
		this.providerAutoRunInputBySession.delete(sessionId);
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
		session.markError(code);
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
