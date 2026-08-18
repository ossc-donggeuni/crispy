import * as assert from 'assert';

interface FakeDisposable {
	dispose(): void;
}

interface FakePtyExitEvent {
	readonly exitCode: number;
	readonly signal?: number;
}

interface FakePty {
	readonly pid: number;
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
	readonly pid = 9102;
	readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
	killCalls = 0;
	disposedListeners = 0;
	writeCalls = 0;

	private readonly readyMarker: string;
	private dataListener: ((data: string) => void) | undefined;
	private exitListener: ((event: FakePtyExitEvent) => void) | undefined;

	constructor(shellCommand: string) {
		const readyMarker = shellCommand.match(/CRISPY_READY:(crispy-ready-[^ &]+)/u)?.[1];
		assert.notStrictEqual(readyMarker, undefined);
		this.readyMarker = readyMarker as string;
	}

	onData(listener: (data: string) => void): FakeDisposable {
		this.dataListener = listener;
		return this.createDisposable();
	}

	onExit(listener: (event: FakePtyExitEvent) => void): FakeDisposable {
		this.exitListener = listener;
		queueMicrotask(() => {
			this.dataListener?.(`CRISPY_READY:${this.readyMarker}\r\n`);
		});
		return this.createDisposable();
	}

	write(data: string): void {
		this.writeCalls += 1;
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
		let terminal: SuccessfulWindowsPty | undefined;
		let spawnCall: {
			readonly executable: string;
			readonly args: readonly string[];
		} | undefined;
		const result = await runPtySmoke(
			{
				spawn: (executable, args) => {
					spawnCall = { executable, args: [...args] };
					terminal = new SuccessfulWindowsPty(args[5]);
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
		assert.ok(spawnCall?.args[5].includes('@echo CRISPY_READY:'));
		assert.deepStrictEqual(terminal?.resizeCalls, [{ cols: 100, rows: 30 }]);
		assert.strictEqual(terminal?.writeCalls, 2);
		assert.strictEqual(terminal?.disposedListeners, 2);
		assert.strictEqual(terminal?.killCalls, 1);
	});
});
