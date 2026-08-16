import * as assert from 'assert';

interface FakeDisposable {
	dispose(): void;
}

interface FakePtyExitEvent {
	readonly exitCode: number;
	readonly signal?: number;
}

interface FakePty {
	readonly killCalls: number;
	readonly resizeCalls: ReadonlyArray<{ readonly cols: number; readonly rows: number }>;
	readonly disposedListeners: number;
	onData(listener: (data: string) => void): FakeDisposable;
	onExit(listener: (event: FakePtyExitEvent) => void): FakeDisposable;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}

interface PtySmokeModule {
	runPtySmoke(
		nodePty: {
			spawn(
				executable: string,
				args: readonly string[],
				options: unknown,
			): FakePty;
		},
		target: string,
		smokeCwd: string,
	): Promise<{ readonly exitCode: number; readonly resize: string }>;
}

const { runPtySmoke } = require('../../../scripts/pty-smoke') as PtySmokeModule;

class SuccessfulWindowsPty implements FakePty {
	readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
	killCalls = 0;
	disposedListeners = 0;

	private dataListener: ((data: string) => void) | undefined;
	private exitListener: ((event: FakePtyExitEvent) => void) | undefined;

	onData(listener: (data: string) => void): FakeDisposable {
		this.dataListener = listener;
		return this.createDisposable();
	}

	onExit(listener: (event: FakePtyExitEvent) => void): FakeDisposable {
		this.exitListener = listener;
		return this.createDisposable();
	}

	write(data: string): void {
		const initialMarker = data.match(/crispy-initial-[^\r]+/u)?.[0];
		if (initialMarker !== undefined) {
			this.dataListener?.(`CRISPY_INITIAL:${initialMarker}\r\n`);
			return;
		}

		const resizedMarker = data.match(/crispy-resized-[^\r]+/u)?.[0];
		if (resizedMarker !== undefined) {
			this.dataListener?.(`CRISPY_RESIZED:${resizedMarker}\r\n`);
			this.exitListener?.({ exitCode: 0 });
		}
	}

	resize(cols: number, rows: number): void {
		this.resizeCalls.push({ cols, rows });
	}

	kill(): void {
		this.killCalls += 1;
	}

	private createDisposable(): FakeDisposable {
		let disposed = false;
		return {
			dispose: () => {
				if (!disposed) {
					disposed = true;
					this.disposedListeners += 1;
				}
			},
		};
	}
}

suite('node-pty packaging smoke helper', () => {
	test('Windows 성공 경로도 listener와 PTY native handle을 정리한다', async () => {
		const terminal = new SuccessfulWindowsPty();
		let spawnCall: {
			readonly executable: string;
			readonly args: readonly string[];
		} | undefined;
		const result = await runPtySmoke(
			{
				spawn: (executable, args) => {
					spawnCall = { executable, args: [...args] };
					return terminal;
				},
			},
			'win32-x64',
			'C:\\isolated-extension',
		);

		assert.deepStrictEqual(result, { exitCode: 0, resize: 'completed' });
		assert.deepStrictEqual(spawnCall?.args.slice(0, 5), [
			'/d',
			'/s',
			'/q',
			'/v:on',
			'/c',
		]);
		assert.ok(spawnCall?.args[5].includes('@set /p CRISPY_VALUE='));
		assert.deepStrictEqual(terminal.resizeCalls, [{ cols: 100, rows: 30 }]);
		assert.strictEqual(terminal.disposedListeners, 2);
		assert.strictEqual(terminal.killCalls, 1);
	});
});
