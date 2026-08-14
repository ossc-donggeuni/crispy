import { randomUUID } from 'crypto';
import type { SessionId, TabId } from '../../protocol/messages';
import { ID_MAX_LENGTH, ID_PATTERN } from '../../protocol/limits';
import type { PtyAdapter } from './ptyAdapter';
import { TerminalSession } from './terminalSession';

/**
 * TerminalHost가 session 등록을 거부한 안정적인 내부 원인이다.
 * 원본 tabId나 생성된 sessionId를 오류 payload에 포함하지 않는다.
 */
export type TerminalHostRegistrationErrorCode =
	| 'tab_already_has_session'
	| 'session_id_collision'
	| 'invalid_generated_session_id';

/** 등록 오류 code를 외부 값을 포함하지 않는 고정 메시지로 변환하는 allowlist다. */
const REGISTRATION_ERROR_MESSAGES: Readonly<
	Record<TerminalHostRegistrationErrorCode, string>
> = Object.freeze({
	tab_already_has_session: 'Terminal tab already has an active session.',
	session_id_collision: 'Generated terminal session identifier already exists.',
	invalid_generated_session_id: 'Generated terminal session identifier is invalid.',
});

/** 원본 tabId나 sessionId를 포함하지 않는 Host 내부 등록 오류다. */
export class TerminalHostRegistrationError extends Error {
	/**
	 * 고정된 code와 메시지만 가진 session 등록 오류를 생성한다.
	 *
	 * @param code 등록을 거부한 안전한 내부 원인이다.
	 */
	constructor(readonly code: TerminalHostRegistrationErrorCode) {
		super(REGISTRATION_ERROR_MESSAGES[code]);
		this.name = 'TerminalHostRegistrationError';
	}
}

/**
 * 새 sessionId 문자열을 반환하는 Host 내부 생성기다.
 * 테스트에서는 순서를 예측할 수 있는 deterministic 구현을 주입할 수 있다.
 */
export type SessionIdGenerator = () => string;

/**
 * UUID에 Host 전용 prefix를 붙여 protocol 규칙을 만족하는 sessionId를 생성한다.
 *
 * @returns 충돌 가능성이 낮고 protocol ID 형식과 최대 길이를 만족하는 식별자다.
 */
export function generateTerminalSessionId(): SessionId {
	return `session-${randomUUID()}`;
}

/** TerminalHost 생성에 필요한 Host 소유 의존성이다. */
export interface TerminalHostOptions {
	/** 새 TerminalSession에 전달할 주입 가능한 PTY 생성 경계다. */
	readonly ptyAdapter: PtyAdapter;

	/** 테스트 또는 특수 Host 구성을 위한 선택적 sessionId 생성기다. */
	readonly sessionIdGenerator?: SessionIdGenerator;
}

/**
 * 생성된 sessionId가 protocol 문자 규칙과 최대 길이를 만족하는지 확인한다.
 *
 * @param value generator가 반환한 검증 전 값이다.
 * @returns Host sessionId로 안전하게 사용할 수 있으면 true다.
 */
function isValidSessionId(value: unknown): value is SessionId {
	return typeof value === 'string'
		&& value.length <= ID_MAX_LENGTH
		&& ID_PATTERN.test(value);
}

/**
 * tab별 현재 session과 전체 session을 두 개의 Map으로 관리하는 Host 골격이다.
 * 실제 PTY 시작, 입출력, restart 및 cleanup orchestration은 수행하지 않는다.
 */
export class TerminalHost {
	/** 모든 등록 session을 Host 소유 sessionId로 조회하는 기본 Map이다. */
	private readonly sessionsById = new Map<SessionId, TerminalSession>();

	/** 각 Webview tab을 현재 sessionId 하나에 연결하는 ownership Map이다. */
	private readonly activeSessionByTab = new Map<TabId, SessionId>();

	/** 생성되는 모든 TerminalSession에 전달할 PTY adapter다. */
	private readonly ptyAdapter: PtyAdapter;

	/** Webview 입력과 독립적으로 sessionId를 발급하는 Host 생성기다. */
	private readonly sessionIdGenerator: SessionIdGenerator;

	/**
	 * 비어 있는 Map registry와 Host 소유 의존성을 초기화한다.
	 * 생성만으로 session을 만들거나 native PTY를 로드하지 않는다.
	 *
	 * @param options PTY adapter와 선택적인 sessionId 생성기다.
	 */
	constructor(options: TerminalHostOptions) {
		this.ptyAdapter = options.ptyAdapter;
		this.sessionIdGenerator = options.sessionIdGenerator
			?? generateTerminalSessionId;
	}

	/**
	 * Host가 새 sessionId를 생성하여 tab의 현재 session을 등록한다.
	 * Webview가 제공한 sessionId를 받을 수 있는 인자를 두지 않는다.
	 *
	 * @param tabId Webview가 생성하고 protocol validator를 통과한 tab 식별자다.
	 * @returns idle 상태로 등록된 새 TerminalSession이다.
	 * @throws {TerminalHostRegistrationError} tab 중복, ID 충돌 또는 잘못된 생성 ID다.
	 */
	createSession(tabId: TabId): TerminalSession {
		if (this.activeSessionByTab.has(tabId)) {
			throw new TerminalHostRegistrationError('tab_already_has_session');
		}

		const generatedSessionId = this.sessionIdGenerator();
		if (!isValidSessionId(generatedSessionId)) {
			throw new TerminalHostRegistrationError(
				'invalid_generated_session_id',
			);
		}
		if (this.sessionsById.has(generatedSessionId)) {
			throw new TerminalHostRegistrationError('session_id_collision');
		}

		const session = new TerminalSession({
			tabId,
			sessionId: generatedSessionId,
			ptyAdapter: this.ptyAdapter,
		});
		this.sessionsById.set(generatedSessionId, session);
		this.activeSessionByTab.set(tabId, generatedSessionId);
		return session;
	}

	/**
	 * Host sessionId로 등록된 session을 조회한다.
	 *
	 * @param sessionId 조회할 Host 소유 session 식별자다.
	 * @returns 등록된 TerminalSession 또는 찾을 수 없으면 undefined다.
	 */
	getSession(sessionId: SessionId): TerminalSession | undefined {
		return this.sessionsById.get(sessionId);
	}

	/**
	 * tabId에 연결된 현재 session을 두 Map을 통해 조회한다.
	 *
	 * @param tabId Webview가 소유하는 tab 식별자다.
	 * @returns 해당 tab의 현재 TerminalSession 또는 연결이 없으면 undefined다.
	 */
	getActiveSession(tabId: TabId): TerminalSession | undefined {
		const sessionId = this.activeSessionByTab.get(tabId);
		return sessionId === undefined
			? undefined
			: this.sessionsById.get(sessionId);
	}

	/**
	 * tab과 session이 현재 양방향 ownership 관계인지 확인한다.
	 * session의 tabId와 activeSessionByTab의 역방향 연결을 모두 확인한다.
	 *
	 * @param tabId 소유 관계를 확인할 Webview tab 식별자다.
	 * @param sessionId 소유 관계를 확인할 Host session 식별자다.
	 * @returns 두 Map과 session identity가 모두 일치하면 true다.
	 */
	ownsSession(tabId: TabId, sessionId: SessionId): boolean {
		const session = this.sessionsById.get(sessionId);
		return session !== undefined
			&& session.tabId === tabId
			&& this.activeSessionByTab.get(tabId) === sessionId;
	}

	/**
	 * session을 두 Map에서 원자적으로 제거한다.
	 * lifecycle dispose나 PTY cleanup은 수행하지 않으며 이후 단계의 호출자가 먼저 완료해야 한다.
	 *
	 * @param sessionId 제거할 Host 소유 session 식별자다.
	 * @returns 제거한 session 또는 등록된 session이 없으면 undefined다.
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
}
