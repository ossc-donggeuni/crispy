import type {
	PtyAdapter,
	PtyExitEvent,
	PtyListenerDisposable,
	PtyProcessHandle,
	PtyReadyPidWaitOptions,
	PtySpawnOptions,
} from '../../../agent/host/terminal/ptyAdapter';

function subscribe<Listener>(
	listeners: Set<Listener>,
	listener: Listener,
): PtyListenerDisposable {
	listeners.add(listener);
	let disposed = false;

	return {
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			listeners.delete(listener);
		},
	};
}

/** TerminalSession 단위 테스트에서 native node-pty를 대체하는 process handle이다. */
export class FakePtyProcessHandle implements PtyProcessHandle {
	readonly writes: string[] = [];
	readonly resizes: Array<{ readonly cols: number; readonly rows: number }> = [];
	readonly readyPidWaitTimeouts: Array<number | undefined> = [];
	killCallCount = 0;

	private readonly dataListeners = new Set<(data: string) => void>();
	private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
	private readonly readyWaiters = new Set<{
		readonly resolve: (pid: number) => void;
		readonly reject: (error: Error) => void;
	}>();
	private currentPid: number;

	constructor(pid: number) {
		this.currentPid = pid;
	}

	get pid(): number {
		return this.currentPid;
	}

	get dataListenerCount(): number {
		return this.dataListeners.size;
	}

	get exitListenerCount(): number {
		return this.exitListeners.size;
	}

	waitForReadyPid(options: PtyReadyPidWaitOptions = {}): Promise<number> {
		this.readyPidWaitTimeouts.push(options.timeoutMs);
		if (Number.isSafeInteger(this.currentPid) && this.currentPid > 1) {
			return Promise.resolve(this.currentPid);
		}

		return new Promise<number>((resolve, reject) => {
			this.readyWaiters.add({ resolve, reject });
		});
	}

	setReadyPid(pid: number): void {
		this.currentPid = pid;
		if (!Number.isSafeInteger(pid) || pid <= 1) {
			return;
		}

		for (const waiter of [...this.readyWaiters]) {
			this.readyWaiters.delete(waiter);
			waiter.resolve(pid);
		}
	}

	rejectReadyPid(error: Error = new Error('fake PTY PID was not ready')): void {
		for (const waiter of [...this.readyWaiters]) {
			this.readyWaiters.delete(waiter);
			waiter.reject(error);
		}
	}

	write(data: string): void {
		this.writes.push(data);
	}

	resize(cols: number, rows: number): void {
		this.resizes.push({ cols, rows });
	}

	kill(): void {
		this.killCallCount += 1;
	}

	onData(listener: (data: string) => void): PtyListenerDisposable {
		return subscribe(this.dataListeners, listener);
	}

	onExit(listener: (event: PtyExitEvent) => void): PtyListenerDisposable {
		return subscribe(this.exitListeners, listener);
	}

	emitData(data: string): void {
		for (const listener of [...this.dataListeners]) {
			listener(data);
		}
	}

	emitExit(event: PtyExitEvent): void {
		for (const waiter of [...this.readyWaiters]) {
			this.readyWaiters.delete(waiter);
			waiter.reject(new Error('fake PTY exited before readiness'));
		}
		for (const listener of [...this.exitListeners]) {
			listener(event);
		}
	}
}

/** spawn 기록과 생성 handle을 노출하는 native-free PTY adapter다. */
export class FakePtyAdapter implements PtyAdapter {
	readonly spawnCalls: PtySpawnOptions[] = [];
	readonly handles: FakePtyProcessHandle[] = [];
	spawnFailuresRemaining = 0;

	constructor(private readonly fakePid = 4242) {}

	spawn(options: PtySpawnOptions): FakePtyProcessHandle {
		this.spawnCalls.push({
			...options,
			args: typeof options.args === 'string'
				? options.args
				: [...options.args],
			env: { ...options.env },
		});
		if (this.spawnFailuresRemaining > 0) {
			this.spawnFailuresRemaining -= 1;
			throw new Error('fake PTY spawn failed');
		}
		const handle = new FakePtyProcessHandle(this.fakePid);
		this.handles.push(handle);
		return handle;
	}
}
