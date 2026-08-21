/** PTY event listener 한 개의 구독을 해제하는 Host 내부 계약이다. */
export interface PtyListenerDisposable {
	dispose(): void;
}

/** PTY process 종료 시 node-pty로부터 복사해 전달하는 최소 이벤트다. */
export interface PtyExitEvent {
	readonly exitCode: number;
	readonly signal?: number;
}

/**
 * 검증된 Host 실행 계약과 초기 terminal 크기로 PTY를 생성하는 옵션이다.
 * 이 타입은 Webview protocol에 노출하지 않는다.
 */
export interface PtySpawnOptions {
	readonly executable: string;
	/** Windows cmd one-shot만 node-pty의 raw command-line string을 사용한다. */
	readonly args: readonly string[] | string;
	readonly cwd: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly cols: number;
	readonly rows: number;
}

/** 실제 PID 준비를 기다리는 호출 경계별 timeout 정책이다. */
export interface PtyReadyPidWaitOptions {
	readonly timeoutMs?: number;
}

/** TerminalSession이 사용하는 PTY process의 최소 Host 내부 포트다. */
export interface PtyProcessHandle {
	readonly pid: number;

	/**
	 * native PTY가 실제 child PID를 공개할 때까지 기다린다.
	 * Windows ConPTY는 spawn 직후 PID가 0일 수 있으므로 즉시 PID를 전제하지 않는다.
	 */
	waitForReadyPid(options?: PtyReadyPidWaitOptions): Promise<number>;

	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;

	onData(listener: (data: string) => void): PtyListenerDisposable;
	onExit(listener: (event: PtyExitEvent) => void): PtyListenerDisposable;
}

/** TerminalSession 생성 시 주입하는 PTY process factory다. */
export interface PtyAdapter {
	spawn(options: PtySpawnOptions): PtyProcessHandle;
}
