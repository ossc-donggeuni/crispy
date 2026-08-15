import { randomUUID } from 'crypto';
import type {
	HostToWebviewMessage,
	SessionId,
	TabId,
	WebviewToHostMessage,
} from '../../protocol/messages';
import type { PtyAdapter, PtyExitEvent } from './ptyAdapter';
import {
	prepareTerminalLaunch,
	type PrepareTerminalLaunch,
} from './prepareTerminalLaunch';
import { TerminalSession } from './terminalSession';

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

	/** Webview dispose 뒤 모든 terminal message 전송을 중단하는 gate다. */
	private messageDeliveryActive = true;

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
			this.failSession(
				session,
				'internal_error',
				START_ERROR_MESSAGES.preparation,
				true,
			);
			return;
		}

		if (!preparation.ok) {
			session.markError(preparation.error.code);
			this.publish(preparation.error);
			return;
		}

		this.lastDimensionsByTab.set(tabId, { cols, rows });
		try {
			session.start(preparation.policy, cols, rows);
		} catch {
			this.failSession(
				session,
				'start_failed',
				START_ERROR_MESSAGES.spawn,
				true,
			);
			return;
		}

		const message = {
			type: 'terminal.started',
			tabId,
			sessionId: session.sessionId,
		} as const;
		this.publish(message);
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
	 * Panel dispose와 Extension deactivate가 공유하는 Host 전체 정리 경계다.
	 * 메시지 전송을 먼저 중단한 뒤 등록된 모든 세션을 재시작 흐름과 동일한
	 * 입력 차단 → 크기 변경 차단 → PTY 종료 → listener 해제 순서로 정리하고
	 * 마지막으로 세션 및 탭 참조를 제거한다. 반복 호출해도 안전하다.
	 * 개별 세션 정리 실패는 남은 세션 정리나 호출자에게 전파하지 않는다.
	 */
	dispose(): void {
		this.stopMessageDelivery();

		for (const session of [...this.sessionsById.values()]) {
			this.disposeSessionProcess(session);
		}

		this.sessionsById.clear();
		this.activeSessionByTab.clear();
		this.lastDimensionsByTab.clear();
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
				/* 종료 절차 표시 실패도 PTY 정리를 막지 않게 한다. */
			}
		}

		try {
			session.disposeProcess();
		} catch {
			/* PTY 정리 실패가 새 세션 생성을 막지 않게 한다. */
		}

		try {
			session.markDisposed();
		} catch {
			/* 상태 전이 실패도 재시작 흐름 밖으로 전파하지 않는다. */
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
			/* 메시지 전송 생명주기는 PTY 시작 결과와 별도로 관리한다. */
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
