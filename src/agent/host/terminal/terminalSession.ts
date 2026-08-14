import {
	TERMINAL_ERROR_CODES,
	type TerminalErrorCode,
} from '../../protocol/errors';
import type { SessionId, TabId } from '../../protocol/messages';
import type { PtyAdapter } from './ptyAdapter';

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

/** TerminalSession이 생성 시 받는 Host 소유 identity와 의존성이다. */
export interface TerminalSessionOptions {
	/** Webview가 생성하고 Host validator가 검증한 tab 식별자다. */
	readonly tabId: TabId;

	/** TerminalHost가 생성한 session 수명주기 고유 식별자다. */
	readonly sessionId: SessionId;

	/** 다음 start 단계에서 사용할 주입 가능한 PTY 생성 경계다. */
	readonly ptyAdapter: PtyAdapter;
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
 * Terminal 하나의 immutable identity와 lifecycle 상태를 관리한다.
 * PTY adapter는 다음 start 단계에서 사용할 수 있도록 주입만 받으며 여기서는 spawn하지 않는다.
 */
export class TerminalSession {
	/** session이 소속된 Webview tab의 변경 불가능한 식별자다. */
	readonly tabId: TabId;

	/** TerminalHost가 발급한 변경 불가능한 session 식별자다. */
	readonly sessionId: SessionId;

	/** 다음 start 단계에서 사용할 PTY 생성 경계이며 이 단계에서는 호출하지 않는다. */
	private readonly ptyAdapter: PtyAdapter;

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
	 * stopping PTY에서 관찰한 종료 정보를 기록한다.
	 *
	 * @param exitCode PTY가 보고한 유한 종료 코드다.
	 * @param signal PTY가 보고한 유한 signal 또는 signal이 없음을 나타내는 null이다.
	 * @throws {TerminalSessionStateError} stopping 상태가 아니거나 종료 정보가 유효하지 않은 경우 발생한다.
	 */
	markExited(exitCode: number, signal: number | null): void {
		this.assertCanTransitionFrom(['stopping']);
		if (
			!isValidExitNumber(exitCode)
			|| (signal !== null && !isValidExitNumber(signal))
		) {
			throw new TerminalSessionStateError('invalid_exit_event');
		}

		this.transition(
			['stopping'],
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
