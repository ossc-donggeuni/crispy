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
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
	readonly cols: number;
	readonly rows: number;
}

/** TerminalSession이 사용하는 PTY process의 최소 Host 내부 포트다. */
export interface PtyProcessHandle {
	readonly pid: number;

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

