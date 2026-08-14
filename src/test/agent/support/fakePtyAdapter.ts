import type {
	PtyAdapter,
	PtyExitEvent,
	PtyListenerDisposable,
	PtyProcessHandle,
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
	killCallCount = 0;

	private readonly dataListeners = new Set<(data: string) => void>();
	private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

	constructor(readonly pid: number) {}

	get dataListenerCount(): number {
		return this.dataListeners.size;
	}

	get exitListenerCount(): number {
		return this.exitListeners.size;
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
		for (const listener of [...this.exitListeners]) {
			listener(event);
		}
	}
}

/** spawn 기록과 생성 handle을 노출하는 native-free PTY adapter다. */
export class FakePtyAdapter implements PtyAdapter {
	readonly spawnCalls: PtySpawnOptions[] = [];
	readonly handles: FakePtyProcessHandle[] = [];

	constructor(private readonly fakePid = 4242) {}

	spawn(options: PtySpawnOptions): FakePtyProcessHandle {
		this.spawnCalls.push({
			...options,
			args: [...options.args],
			env: { ...options.env },
		});
		const handle = new FakePtyProcessHandle(this.fakePid);
		this.handles.push(handle);
		return handle;
	}
}

