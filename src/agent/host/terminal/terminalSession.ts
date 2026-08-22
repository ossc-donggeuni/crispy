import {
	TERMINAL_ERROR_CODES,
	type TerminalErrorCode,
} from '../../protocol/errors';
import type { SessionId, TabId } from '../../protocol/messages';
import type {
	PtyAdapter,
	PtyExitEvent,
	PtyListenerDisposable,
	PtyProcessHandle,
	PtySpawnOptions,
} from './ptyAdapter';

/** PTY를 아직 시작하지 않은 새 session 상태다. */
export interface TerminalSessionIdleState {
	/** 상태 판별에 사용하는 고정 식별자다. */
	readonly kind: 'idle';
}

/** Host가 PTY 시작 절차를 진행 중인 상태다. */
export interface TerminalSessionStartingState {
	/** 상태 판별에 사용하는 고정 식별자다. */
	readonly kind: 'starting';
}

/** 유효한 PID를 가진 PTY가 실행 중인 상태다. */
export interface TerminalSessionRunningState {
	/** 상태 판별에 사용하는 고정 식별자다. */
	readonly kind: 'running';

	/** Extension Host가 PTY handle에서 읽은 유효한 process ID다. */
	readonly pid: number;
}

/** 실행 중이던 PTY의 종료 절차를 진행 중인 상태다. */
export interface TerminalSessionStoppingState {
	/** 상태 판별에 사용하는 고정 식별자다. */
	readonly kind: 'stopping';

	/** running 상태에서 그대로 보존한 process ID다. */
	readonly pid: number;
}

/** PTY 종료를 관찰한 상태다. */
export interface TerminalSessionExitedState {
	/** 상태 판별에 사용하는 고정 식별자다. */
	readonly kind: 'exited';

	/** PTY exit event가 보고한 유한 종료 코드다. */
	readonly exitCode: number;

	/** PTY exit event가 보고한 signal이며 signal이 없으면 null이다. */
	readonly signal: number | null;
}

/** 안전한 protocol 오류 코드로 종료된 상태다. */
export interface TerminalSessionErrorState {
	/** 상태 판별에 사용하는 고정 식별자다. */
	readonly kind: 'error';

	/** Webview protocol allowlist에 포함된 안전한 오류 코드다. */
	readonly code: TerminalErrorCode;
}

/** 더 이상 다른 lifecycle 상태로 전이할 수 없는 최종 상태다. */
export interface TerminalSessionDisposedState {
	/** 상태 판별에 사용하는 고정 식별자다. */
	readonly kind: 'disposed';
}

/**
 * TerminalSession이 가질 수 있는 Host 내부 lifecycle 상태다.
 * `kind`를 확인하면 해당 상태에서만 유효한 PID, 종료 정보 또는 오류 코드에 접근할 수 있다.
 */
export type TerminalSessionState =
	| TerminalSessionIdleState
	| TerminalSessionStartingState
	| TerminalSessionRunningState
	| TerminalSessionStoppingState
	| TerminalSessionExitedState
	| TerminalSessionErrorState
	| TerminalSessionDisposedState;

/** 상태 전이 검사에서 사용하는 전체 `kind` 문자열 union이다. */
export type TerminalSessionStateKind = TerminalSessionState['kind'];

/**
 * 상태 전이 또는 상태 payload가 TerminalSession invariant를 위반한 원인이다.
 * 각 값은 원본 PID, 식별자, exception 또는 실행 계약을 포함하지 않는다.
 */
export type TerminalSessionStateErrorCode =
	| 'invalid_transition'
	| 'invalid_pid'
	| 'invalid_exit_event'
	| 'invalid_error_code';

/** 상태 오류 code를 외부 값을 포함하지 않는 고정 메시지로 변환하는 allowlist다. */
const STATE_ERROR_MESSAGES: Readonly<
	Record<TerminalSessionStateErrorCode, string>
> = Object.freeze({
	invalid_transition: 'Invalid terminal session state transition.',
	invalid_pid: 'Invalid terminal process identifier.',
	invalid_exit_event: 'Invalid terminal exit event.',
	invalid_error_code: 'Invalid terminal error code.',
});

/** 원본 식별자나 실행 정보를 포함하지 않는 Host 내부 상태 오류다. */
export class TerminalSessionStateError extends Error {
	/**
	 * 고정된 code와 메시지만 가진 상태 오류를 생성한다.
	 *
	 * @param code 위반한 상태 invariant의 안전한 내부 식별자다.
	 */
	constructor(readonly code: TerminalSessionStateErrorCode) {
		super(STATE_ERROR_MESSAGES[code]);
		this.name = 'TerminalSessionStateError';
	}
}

/**
 * Native PTY creation succeeded, but the process exited before a usable PID became available.
 * Buffered output stays private so callers can classify it without reflecting it through logs.
 */
export class TerminalProcessExitedBeforeReadyError extends Error {
	readonly event: PtyExitEvent;
	readonly #bufferedOutput: string;

	constructor(event: PtyExitEvent, bufferedOutput: string) {
		super('Terminal process exited before its identifier became ready.');
		this.name = 'TerminalProcessExitedBeforeReadyError';
		this.event = Object.freeze({ ...event });
		this.#bufferedOutput = bufferedOutput;
	}

	withBufferedOutput<Result>(consumer: (output: string) => Result): Result {
		return consumer(this.#bufferedOutput);
	}
}

/** TerminalSession이 생성 시 받는 Host 소유 identity와 의존성이다. */
export interface TerminalSessionOptions {
	/** Webview가 생성하고 Host validator가 검증한 tab 식별자다. */
	readonly tabId: TabId;

	/** TerminalHost가 생성한 session 수명주기 고유 식별자다. */
	readonly sessionId: SessionId;

	/** Host가 검증한 실행 계약으로 process를 생성할 PTY 경계다. */
	readonly ptyAdapter: PtyAdapter;

	/** PTY output batch를 상위 Host routing 경계로 전달한다. */
	readonly onOutput: (data: string) => void;

	/** PTY 종료 이벤트를 상위 Host routing 경계로 전달한다. */
	readonly onExit: (event: PtyExitEvent) => void;

	/** 실제 PID가 준비되어 running 전이가 완료된 시점을 상위 Host에 알린다. */
	readonly onRunning: () => void;
}

/** 모든 새 session이 공유하는 변경 불가능한 idle 상태다. */
const IDLE_STATE: TerminalSessionIdleState = Object.freeze({ kind: 'idle' });

/** payload가 없는 starting 상태의 변경 불가능한 공용 값이다. */
const STARTING_STATE: TerminalSessionStartingState = Object.freeze({
	kind: 'starting',
});

/** payload가 없는 disposed 상태의 변경 불가능한 공용 값이다. */
const DISPOSED_STATE: TerminalSessionDisposedState = Object.freeze({
	kind: 'disposed',
});

/** dispose 전이가 허용되는 전체 lifecycle 상태 목록이다. */
const ALL_STATE_KINDS: readonly TerminalSessionStateKind[] = Object.freeze([
	'idle',
	'starting',
	'running',
	'stopping',
	'exited',
	'error',
	'disposed',
]);
/** runtime에서 error 상태 code를 검증하는 protocol allowlist Set이다. */
const terminalErrorCodes = new Set<TerminalErrorCode>(TERMINAL_ERROR_CODES);

/**
 * PID가 process-tree 제어에 사용할 수 있는 양의 safe integer인지 확인한다.
 *
 * @param pid 검증할 process ID다.
 * @returns PID가 1보다 큰 safe integer이면 true다.
 */
function isValidPid(pid: number): boolean {
	return Number.isSafeInteger(pid) && pid > 1;
}

/**
 * PTY 종료 정보가 protocol에 전달 가능한 유한 number인지 확인한다.
 *
 * @param value 검증할 종료 코드 또는 signal이다.
 * @returns 값이 유한 number이면 true다.
 */
function isValidExitNumber(value: number): boolean {
	return Number.isFinite(value);
}

/**
 * unknown 값이 공개 terminal 오류 code allowlist에 포함되는지 확인한다.
 *
 * @param value 검증할 오류 code 후보 값이다.
 * @returns 안전한 TerminalErrorCode로 좁힐 수 있으면 true다.
 */
function isTerminalErrorCode(value: unknown): value is TerminalErrorCode {
	return typeof value === 'string'
		&& terminalErrorCodes.has(value as TerminalErrorCode);
}

/**
 * Terminal 하나의 immutable identity, lifecycle 상태와 생성된 PTY handle을 관리한다.
 * 실제 실행 계약 준비와 protocol 메시지 발행은 상위 TerminalHost가 담당한다.
 */
export class TerminalSession {
	/** session이 소속된 Webview tab의 변경 불가능한 식별자다. */
	readonly tabId: TabId;

	/** TerminalHost가 발급한 변경 불가능한 session 식별자다. */
	readonly sessionId: SessionId;

	/** Host가 검증한 실행 계약만 전달받는 PTY 생성 경계다. */
	private readonly ptyAdapter: PtyAdapter;

	/** 변형하지 않은 PTY output batch를 Host에 전달하는 callback이다. */
	private readonly onOutput: (data: string) => void;

	/** PTY exit 정보를 Host에 전달하는 callback이다. */
	private readonly onExit: (event: PtyExitEvent) => void;

	/** running 전이 뒤 started 발행과 provider 자동 실행을 요청하는 callback이다. */
	private readonly onRunning: () => void;

	/** spawn 성공 뒤 session이 소유하는 PTY handle이다. */
	private activeProcess: PtyProcessHandle | undefined;

	/** 현재 PTY output listener 구독이다. */
	private dataListener: PtyListenerDisposable | undefined;

	/** 현재 PTY exit listener 구독이다. */
	private exitListener: PtyListenerDisposable | undefined;

	/** 다음 microtask에 전달할 원본 output 조각을 도착 순서대로 보관한다. */
	private pendingOutput: string[] = [];

	/** PID 준비 전에 종료된 현재 process와 안전한 내부 종료 snapshot이다. */
	private exitBeforeReady: Readonly<{
		readonly process: PtyProcessHandle;
		readonly error: TerminalProcessExitedBeforeReadyError;
	}> | undefined;

	/** output flush microtask가 이미 예약되었는지 나타낸다. */
	private outputFlushScheduled = false;

	/** 오직 `transition()`을 통해서만 교체되는 현재 lifecycle 상태다. */
	private currentState: TerminalSessionState = IDLE_STATE;

	/**
	 * Host가 결정한 identity와 PTY 의존성을 가진 idle session을 생성한다.
	 * 생성 과정에서는 workspace 검증, shell 해석 또는 PTY spawn을 수행하지 않는다.
	 *
	 * @param options Host가 소유하는 tabId, sessionId와 PTY adapter다.
	 */
	constructor(options: TerminalSessionOptions) {
		this.tabId = options.tabId;
		this.sessionId = options.sessionId;
		this.ptyAdapter = options.ptyAdapter;
		this.onOutput = options.onOutput;
		this.onExit = options.onExit;
		this.onRunning = options.onRunning;
	}

	/**
	 * 현재 lifecycle 상태의 변경 불가능한 snapshot을 반환한다.
	 *
	 * @returns 현재 상태에 필요한 payload만 포함한 discriminated union 값이다.
	 */
	get state(): TerminalSessionState {
		return this.currentState;
	}

	/**
	 * idle session의 시작 절차 진입을 표시한다.
	 *
	 * @throws {TerminalSessionStateError} 현재 상태가 idle이 아닌 경우 발생한다.
	 */
	markStarting(): void {
		this.transition(['idle'], STARTING_STATE);
	}

	/**
	 * Host가 검증한 Shell 정책과 terminal 크기로 PTY를 생성한다.
	 * executable, args, cwd와 env를 별도 인자로 받지 않아 Webview 값이 실행 계약을
	 * 덮어쓸 수 없다. spawn 성공 뒤 output과 exit listener를 session이 소유한다.
	 *
	 * @param policy workspace와 Shell policy가 확정한 Host 내부 실행 계약이다.
	 * @param cols protocol validator를 통과한 초기 terminal 열 수다.
	 * @param rows protocol validator를 통과한 초기 terminal 행 수다.
	 * spawn 직후 PID가 0인 Windows ConPTY는 실제 PID가 준비될 때까지 starting을 유지한다.
	 * @throws {TerminalSessionStateError} starting 상태가 아니거나 준비된 PID가 유효하지 않은 경우 발생한다.
	 * @throws {unknown} 주입된 PTY adapter가 안전한 상위 오류 변환을 위해 보고한 spawn 실패다.
	 * @returns 실제 PID가 준비되어 running 전이와 callback이 끝나면 이행되는 Promise
	 */
	start(
		policy: Omit<PtySpawnOptions, 'cols' | 'rows'>,
		cols: number,
		rows: number,
	): Promise<void> {
		this.assertCanTransitionFrom(['starting']);
		const process = this.ptyAdapter.spawn({
			executable: policy.executable,
			args: policy.args,
			cwd: policy.cwd,
			env: policy.env,
			cols,
			rows,
		});

		this.activeProcess = process;

		try {
			this.dataListener = process.onData((data) => this.enqueueOutput(data));
			this.exitListener = process.onExit((event) => this.handleExit(event));
		} catch (error: unknown) {
			this.rollbackStart(process);
			throw error;
		}
		const synchronousExit = this.takeExitBeforeReady(process);
		if (synchronousExit !== undefined) {
			return Promise.reject(synchronousExit);
		}

		if (isValidPid(process.pid)) {
			try {
				this.completeStart(process, process.pid);
			} catch (error: unknown) {
				this.rollbackStart(process);
				throw error;
			}
			return Promise.resolve();
		}

		let readyPid: Promise<number>;
		try {
			readyPid = process.waitForReadyPid();
		} catch (error: unknown) {
			this.rollbackStart(process);
			throw error;
		}
		return readyPid.then(
			(pid) => {
				const exitBeforeReady = this.takeExitBeforeReady(process);
				if (exitBeforeReady !== undefined) {
					throw exitBeforeReady;
				}
				try {
					this.completeStart(process, pid);
				} catch (error: unknown) {
					this.rollbackStart(process);
					throw error;
				}
			},
			(error: unknown) => {
				const exitBeforeReady = this.takeExitBeforeReady(process);
				if (exitBeforeReady !== undefined) {
					throw exitBeforeReady;
				}
				this.rollbackStart(process);
				throw error;
			},
		);
	}

	/** 이미 종료된 pre-ready process를 kill하지 않고 listener와 ownership만 해제한다. */
	private takeExitBeforeReady(
		process: PtyProcessHandle,
	): TerminalProcessExitedBeforeReadyError | undefined {
		const exitBeforeReady = this.exitBeforeReady;
		if (exitBeforeReady?.process !== process) {
			return undefined;
		}
		this.exitBeforeReady = undefined;
		if (this.activeProcess === process) {
			this.activeProcess = undefined;
		}
		this.pendingOutput = [];
		this.disposePtyListeners();
		return exitBeforeReady.error;
	}

	/** spawn 뒤 start transaction이 실패하면 생성한 native PTY ownership을 되돌린다. */
	private rollbackStart(process: PtyProcessHandle): void {
		if (this.activeProcess !== process) {
			return;
		}
		if (this.exitBeforeReady?.process === process) {
			this.exitBeforeReady = undefined;
		}
		this.activeProcess = undefined;
		this.pendingOutput = [];
		try {
			process.kill();
		} catch {
			/** 종료 요청 실패도 listener와 session ownership 해제를 막지 않는다. */
		}
		this.disposePtyListeners();
	}

	/** 준비 완료가 현재 process와 starting 상태에 속할 때만 running으로 승격한다. */
	private completeStart(process: PtyProcessHandle, pid: number): void {
		if (this.activeProcess !== process || this.currentState.kind !== 'starting') {
			return;
		}

		this.markRunning(pid);
		try {
			this.onRunning();
		} catch {
			/** 상위 lifecycle 알림 실패가 native listener 정리를 건너뛰지 않게 한다. */
		}
		this.scheduleOutputFlush();
	}

	/** PTY output 조각을 변형 없이 같은 microtask batch에 순서대로 추가한다. */
	private enqueueOutput(data: string): void {
		if (
			this.currentState.kind !== 'starting'
			&& this.currentState.kind !== 'running'
			&& this.currentState.kind !== 'stopping'
		) {
			return;
		}

		this.pendingOutput.push(data);
		if (this.currentState.kind === 'starting') {
			return;
		}
		this.scheduleOutputFlush();
	}

	/** running 발행 뒤에만 pending output flush microtask를 예약한다. */
	private scheduleOutputFlush(): void {
		if (this.outputFlushScheduled || this.pendingOutput.length === 0) {
			return;
		}

		this.outputFlushScheduled = true;
		queueMicrotask(() => this.flushOutput());
	}

	/** 예약된 output을 가공 없이 한 번의 Host callback으로 전달한다. */
	private flushOutput(): void {
		this.outputFlushScheduled = false;
		if (this.pendingOutput.length === 0) {
			return;
		}

		const data = this.pendingOutput.join('');
		this.pendingOutput = [];
		try {
			this.onOutput(data);
		} catch {
			/** Terminal output listener 오류는 session 경계 밖으로 전파하지 않는다. */
		}
	}

	/** 마지막 output을 먼저 전달한 뒤 exit routing을 호출하고 listener를 해제한다. */
	private handleExit(event: PtyExitEvent): void {
		if (this.currentState.kind === 'starting') {
			const process = this.activeProcess;
			if (process !== undefined) {
				this.exitBeforeReady = Object.freeze({
					process,
					error: new TerminalProcessExitedBeforeReadyError(
						event,
						this.pendingOutput.join(''),
					),
				});
			}
			this.pendingOutput = [];
			this.disposePtyListeners();
			return;
		}

		if (
			this.currentState.kind !== 'running'
			&& this.currentState.kind !== 'stopping'
		) {
			return;
		}

		this.flushOutput();
		try {
			this.onExit(event);
		} catch {
			/** Terminal exit listener 오류는 다른 extension 기능으로 전파하지 않는다. */
		} finally {
			this.disposePtyListeners();
		}
	}

	/**
	 * 재시작 전 정리 단계에서 session이 소유한 PTY와 구독을 멱등하게 해제한다.
	 * 입력 차단 → 크기 변경 차단 → PTY 종료 요청 → listener 해제 순서를 유지하며
	 * 개별 정리 실패를 상위 재시작 흐름으로 전파하지 않는다.
	 */
	disposeProcess(): void {
		const process = this.activeProcess;
		/** activeProcess를 먼저 비워 남은 입력과 크기 변경을 PTY에 전달하지 않는다. */
		this.activeProcess = undefined;
		this.exitBeforeReady = undefined;
		this.pendingOutput = [];

		try {
			process?.kill();
		} catch {
			/** PTY 종료 요청 실패도 listener 정리와 재시작 흐름을 막지 않는다. */
		}
		this.disposePtyListeners();
	}

	/**
	 * Panel detach 경로에서 native 종료 호출 없이 입력·resize와 listener 소유권을 해제한다.
	 * process handle ownership은 이후 비동기 경계가 지연 PID까지 기다려 종료하는 데 사용한다.
	 *
	 * @returns 비동기 종료 경계로 ownership을 넘길 process handle 또는 없으면 undefined
	 */
	detachProcess(): PtyProcessHandle | undefined {
		const process = this.activeProcess;
		this.activeProcess = undefined;
		this.exitBeforeReady = undefined;
		this.pendingOutput = [];
		this.disposePtyListeners();

		return process;
	}

	/** PTY data/exit listener 구독을 멱등하게 해제한다. */
	private disposePtyListeners(): void {
		for (const listener of [this.dataListener, this.exitListener]) {
			try {
				listener?.dispose();
			} catch {
				/** 개별 listener 해제 실패가 나머지 listener 정리를 막지 않는다. */
			}
		}
		this.dataListener = undefined;
		this.exitListener = undefined;
	}

	/**
	 * 실행 중인 PTY에 Webview에서 검증된 입력을 그대로 전달한다.
	 * 문자열을 정리하거나 개행, 제어 문자 또는 Unicode를 변경하지 않는다.
	 *
	 * @param data 프로토콜 검증을 통과한 원본 terminal 입력
	 */
	writeInput(data: string): void {
		if (this.currentState.kind !== 'running' || this.activeProcess === undefined) {
			return;
		}

		this.activeProcess.write(data);
	}

	/**
	 * 실행 중인 PTY 크기를 Webview에서 검증된 열과 행으로 변경한다.
	 *
	 * @param cols 프로토콜 검증을 통과한 terminal 열 수
	 * @param rows 프로토콜 검증을 통과한 terminal 행 수
	 */
	resize(cols: number, rows: number): void {
		if (this.currentState.kind !== 'running' || this.activeProcess === undefined) {
			return;
		}

		this.activeProcess.resize(cols, rows);
	}

	/**
	 * 시작된 PTY와 유효한 PID를 running 상태에 기록한다.
	 *
	 * @param pid Host가 PTY handle에서 읽은 process ID다.
	 * @throws {TerminalSessionStateError} starting 상태가 아니거나 PID가 유효하지 않은 경우 발생한다.
	 */
	markRunning(pid: number): void {
		this.assertCanTransitionFrom(['starting']);
		if (!isValidPid(pid)) {
			throw new TerminalSessionStateError('invalid_pid');
		}

		this.transition(['starting'], Object.freeze({ kind: 'running', pid }));
	}

	/**
	 * running PID를 보존하며 종료 절차 진입을 표시한다.
	 *
	 * @throws {TerminalSessionStateError} 현재 상태가 running이 아닌 경우 발생한다.
	 */
	markStopping(): void {
		this.assertCanTransitionFrom(['running']);
		const { pid } = this.currentState as TerminalSessionRunningState;
		this.transition(
			['running'],
			Object.freeze({ kind: 'stopping', pid }),
		);
	}

	/**
	 * running 또는 stopping PTY에서 관찰한 종료 정보를 기록한다.
	 *
	 * @param exitCode PTY가 보고한 유한 종료 코드다.
	 * @param signal PTY가 보고한 유한 signal 또는 signal이 없음을 나타내는 null이다.
	 * @throws {TerminalSessionStateError} 종료 가능한 상태가 아니거나 종료 정보가 유효하지 않은 경우 발생한다.
	 */
	markExited(exitCode: number, signal: number | null): void {
		this.assertCanTransitionFrom(['running', 'stopping']);
		if (
			!isValidExitNumber(exitCode)
			|| (signal !== null && !isValidExitNumber(signal))
		) {
			throw new TerminalSessionStateError('invalid_exit_event');
		}

		this.transition(
			['running', 'stopping'],
			Object.freeze({ kind: 'exited', exitCode, signal }),
		);
	}

	/**
	 * 시작·실행·종료 절차에서 발생한 실패를 안전한 오류 상태로 기록한다.
	 *
	 * @param code protocol allowlist에 정의된 안전한 오류 코드다.
	 * @throws {TerminalSessionStateError} 오류 전이가 허용되지 않거나 code가 allowlist 밖인 경우 발생한다.
	 */
	markError(code: TerminalErrorCode): void {
		this.assertCanTransitionFrom(['starting', 'running', 'stopping']);
		if (!isTerminalErrorCode(code)) {
			throw new TerminalSessionStateError('invalid_error_code');
		}

		this.transition(
			['starting', 'running', 'stopping'],
			Object.freeze({ kind: 'error', code }),
		);
	}

	/**
	 * 모든 lifecycle 상태를 최종 disposed 상태로 전이한다.
	 * disposed 상태에서의 반복 호출은 같은 상태를 유지하므로 안전하다.
	 */
	markDisposed(): void {
		this.transition(ALL_STATE_KINDS, DISPOSED_STATE);
	}

	/**
	 * 상태 변경이 허용된 상태인지 검사한 뒤 단일 경계에서만 상태를 변경한다.
	 *
	 * @param allowedFrom nextState로 이동할 수 있는 이전 상태 목록이다.
	 * @param nextState 검증 성공 후 저장할 변경 불가능한 다음 상태다.
	 * @throws {TerminalSessionStateError} 현재 상태가 allowedFrom에 없는 경우 발생한다.
	 */
	private transition(
		allowedFrom: readonly TerminalSessionStateKind[],
		nextState: TerminalSessionState,
	): void {
		this.assertCanTransitionFrom(allowedFrom);
		this.currentState = nextState;
	}

	/**
	 * 현재 lifecycle 상태가 허용된 이전 상태 중 하나인지 확인한다.
	 *
	 * @param allowedFrom 현재 상태로 허용할 상태 종류 목록이다.
	 * @throws {TerminalSessionStateError} 허용되지 않은 상태 전이면 발생한다.
	 */
	private assertCanTransitionFrom(
		allowedFrom: readonly TerminalSessionStateKind[],
	): void {
		if (!allowedFrom.includes(this.currentState.kind)) {
			throw new TerminalSessionStateError('invalid_transition');
		}
	}
}
