import * as crypto from 'node:crypto';
import type { IDisposable, IPty, spawn as spawnPty } from 'node-pty';
import * as pty from 'node-pty';
import type { TerminalHostMessage } from '../protocol';
import {
	createTerminalEnvironment,
	TERMINAL_POLICY,
	type ShellLaunchPolicy,
} from '../policy';

/** 테스트에서 PTY 생성기를 주입할 수 있도록 보존한 node-pty spawn 함수 타입이다. */
type PtySpawner = typeof spawnPty;
/** Host 메시지 union에서 terminal 종료 메시지만 추출한 타입이다. */
type SessionExitMessage = Extract<TerminalHostMessage, { type: 'terminal/exited' }>;

/** 실행 중인 PTY와 해당 이벤트 구독 및 종료 확인 상태를 묶어 관리한다. */
interface ActiveSession {
	process: IPty;
	dataSubscription: IDisposable;
	exitSubscription: IDisposable;
	exitPromise: Promise<void>;
	resolveExit: () => void;
	stopPromise?: Promise<boolean>;
}

/** 기본 shell PTY를 시작할 때 Host가 확정하여 전달하는 실행 옵션이다. */
export interface StartShellOptions {
	launch: ShellLaunchPolicy;
	cwd: string;
	cols: number;
	rows: number;
	emit: (message: TerminalHostMessage) => void;
}

/** terminal 본문을 제외한 lifecycle 상태만 기록하는 로그 계약이다. */
export type StatusWriter = Pick<Console, 'log' | 'error'>;

/** 기본 shell PTY의 생성·입력·크기·process-tree 종료를 Host에서 소유한다. */
export class PtySessionManager {
	private readonly sessions = new Map<string, ActiveSession>();

	/**
	 * PTY 세션 관리자를 생성한다.
	 *
	 * @param writer 민감한 terminal 본문을 제외한 상태 로그 출력기
	 * @param spawn 실제 또는 테스트용 PTY 생성 함수
	 * @param createSessionId Host 소유 세션 ID 생성 함수
	 */
	public constructor(
		private readonly writer: StatusWriter,
		private readonly spawn: PtySpawner = pty.spawn,
		private readonly createSessionId: () => string = crypto.randomUUID,
	) {}

	/** @returns 현재 관리 중인 활성 PTY 세션 수 */
	public get size(): number {
		return this.sessions.size;
	}

	/**
	 * Host가 확정한 shell 계약으로 interactive PTY를 시작한다.
	 *
	 * @param options 실행 정책, workspace cwd, 초기 크기 및 메시지 전달 callback
	 * @returns Host가 생성한 고유 세션 ID
	 */
	public startShell(options: StartShellOptions): string {
		const sessionId = this.createSessionId();
		const child = this.spawn(options.launch.executable, [...options.launch.args], {
			name: 'xterm-256color',
			cwd: options.cwd,
			cols: options.cols,
			rows: options.rows,
			env: createTerminalEnvironment(),
		});

		let resolveExit: () => void = () => undefined;
		const exitPromise = new Promise<void>((resolve) => {
			resolveExit = resolve;
		});
		const placeholder = { dispose: () => undefined };
		const session: ActiveSession = {
			process: child,
			dataSubscription: placeholder,
			exitSubscription: placeholder,
			exitPromise,
			resolveExit,
		};
		this.sessions.set(sessionId, session);

		session.dataSubscription = child.onData((data) => {
			if (this.sessions.has(sessionId)) {
				options.emit({ type: 'terminal/output', payload: { sessionId, data } });
			}
		});
		session.exitSubscription = child.onExit(({ exitCode, signal }) => {
			const active = this.sessions.get(sessionId);
			if (!active) {
				return;
			}

			this.sessions.delete(sessionId);
			active.dataSubscription.dispose();
			active.exitSubscription.dispose();
			active.resolveExit();
			this.writer.log(
				`[Crispy Terminal] PTY exited: pid=${child.pid}, session=${sessionId}, code=${exitCode}`,
			);
			const payload: SessionExitMessage['payload'] = {
				sessionId,
				exitCode,
				...(signal === undefined ? {} : { signal }),
			};
			options.emit({ type: 'terminal/exited', payload });
		});

		this.writer.log(`[Crispy Terminal] PTY started: pid=${child.pid}, session=${sessionId}`);
		return sessionId;
	}

	/**
	 * 지정 세션에 terminal 입력을 원문 그대로 전달한다.
	 *
	 * @param sessionId 입력을 받을 Host 소유 세션 ID
	 * @param data xterm이 생성한 원본 terminal 입력
	 * @returns 세션을 찾아 입력 전달에 성공했는지 여부
	 */
	public write(sessionId: string, data: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}

		try {
			session.process.write(data);
			return true;
		} catch (error) {
			this.writer.error(`[Crispy Terminal] PTY input failed: session=${sessionId}, ${String(error)}`);
			return false;
		}
	}

	/**
	 * 지정 PTY의 크기를 xterm의 현재 열과 행에 맞춘다.
	 *
	 * @param sessionId 크기를 변경할 Host 소유 세션 ID
	 * @param cols terminal 열 수
	 * @param rows terminal 행 수
	 * @returns 세션을 찾아 크기 변경에 성공했는지 여부
	 */
	public resize(sessionId: string, cols: number, rows: number): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}

		try {
			session.process.resize(cols, rows);
			return true;
		} catch (error) {
			this.writer.error(`[Crispy Terminal] PTY resize failed: session=${sessionId}, ${String(error)}`);
			return false;
		}
	}

	/**
	 * process group 종료를 요청하고 PTY exit event가 확인될 때까지 기다린다.
	 *
	 * @param sessionId 종료할 Host 소유 세션 ID
	 * @returns process tree의 실제 종료가 확인됐는지 여부
	 */
	public stop(sessionId: string): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return Promise.resolve(true);
		}

		if (!session.stopPromise) {
			session.stopPromise = this.stopSession(sessionId, session);
		}

		return session.stopPromise;
	}

	/**
	 * Panel 또는 Extension 종료 시 모든 session의 실제 종료 결과를 합산한다.
	 *
	 * @returns 모든 PTY process tree의 종료가 확인됐는지 여부
	 */
	public async dispose(): Promise<boolean> {
		const results = await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
		return results.every(Boolean);
	}

	/**
	 * 정상 종료 신호 후 timeout이 지나면 강제 종료 신호를 보내고 exit를 확인한다.
	 *
	 * @param sessionId 종료할 세션 ID
	 * @param session 종료할 활성 세션 상태
	 * @returns 제한 시간 안에 세션 종료가 확인됐는지 여부
	 */
	private async stopSession(sessionId: string, session: ActiveSession): Promise<boolean> {
		this.requestProcessTreeSignal(session.process, 'SIGHUP');

		if (await waitFor(session.exitPromise, TERMINAL_POLICY.gracefulShutdownTimeoutMs)) {
			return true;
		}

		this.requestProcessTreeSignal(session.process, 'SIGKILL');
		const exited = await waitFor(session.exitPromise, TERMINAL_POLICY.forceShutdownTimeoutMs);

		if (!exited) {
			this.writer.error(
				`[Crispy Terminal] PTY process tree cleanup timed out: pid=${session.process.pid}, session=${sessionId}`,
			);
		}

		return exited;
	}

	/**
	 * Unix에서는 process group 전체에, Windows나 fallback 경로에서는 PTY에 종료 신호를 보낸다.
	 *
	 * @param child 종료 신호를 받을 PTY
	 * @param signal 정상 또는 강제 종료에 사용할 신호
	 */
	private requestProcessTreeSignal(child: IPty, signal: 'SIGHUP' | 'SIGKILL'): void {
		if (process.platform !== 'win32') {
			try {
				process.kill(-child.pid, signal);
				return;
			} catch (error) {
				if (!isMissingProcessError(error)) {
					this.writer.error(
						`[Crispy Terminal] Process-group signal failed: pid=${child.pid}, signal=${signal}, ${String(error)}`,
					);
				}
			}
		}

		try {
			child.kill(process.platform === 'win32' ? undefined : signal);
		} catch (error) {
			if (!isMissingProcessError(error)) {
				this.writer.error(
					`[Crispy Terminal] PTY signal failed: pid=${child.pid}, signal=${signal}, ${String(error)}`,
				);
			}
		}
	}
}

/**
 * Promise 완료를 지정 timeout 동안 기다린다.
 *
 * @param promise 완료를 기다릴 Promise
 * @param timeoutMs 최대 대기 시간
 * @returns timeout 전에 Promise가 완료됐는지 여부
 */
async function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
	let timeout: NodeJS.Timeout | undefined;
	const timedOut = new Promise<false>((resolve) => {
		timeout = setTimeout(() => resolve(false), timeoutMs);
	});
	const exited = promise.then(() => true as const);
	const result = await Promise.race([exited, timedOut]);

	if (timeout) {
		clearTimeout(timeout);
	}

	return result;
}

/**
 * 오류가 이미 종료되어 존재하지 않는 process를 가리키는지 확인한다.
 *
 * @param error process signal 과정에서 발생한 원본 오류
 * @returns 오류 code가 ESRCH인지 여부
 */
function isMissingProcessError(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& (error as { code?: unknown }).code === 'ESRCH';
}
