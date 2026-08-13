import * as assert from 'assert';
import type { IDisposable, IPty } from 'node-pty';
import * as pty from 'node-pty';
import { PtySessionManager } from '../host/ptySessionManager';
import type { TerminalHostMessage } from '../protocol';

/**
 * 주입한 가짜 PTY를 통해 session manager의 실행 계약과 소유 관계를 검증한다.
 */
suite('Agent Terminal PTY Session Manager', () => {
	test('Host shell 계약, cwd, input, resize와 종료를 session별로 소유한다', async () => {
		const child = new FakePty();
		let spawnCall: SpawnCall | undefined;
		const messages: TerminalHostMessage[] = [];
		const manager = new PtySessionManager(
			{ log: () => undefined, error: () => undefined },
			((file, args, options) => {
				spawnCall = { file, args, options };
				return child;
			}) as typeof pty.spawn,
			() => 'session-1',
		);

		const sessionId = manager.startShell({
			launch: { executable: '/bin/test-shell', args: [], label: 'test-shell' },
			cwd: '/work space/한글',
			cols: 80,
			rows: 24,
			emit: (message) => messages.push(message),
		});

		assert.strictEqual(sessionId, 'session-1');
		assert.strictEqual(spawnCall?.file, '/bin/test-shell');
		assert.deepStrictEqual(spawnCall?.args, []);
		assert.strictEqual(spawnCall?.options.cwd, '/work space/한글');
		assert.strictEqual(spawnCall?.options.cols, 80);
		assert.strictEqual(spawnCall?.options.rows, 24);
		assert.strictEqual(spawnCall?.options.env?.TERM, 'xterm-256color');

		child.emitData('ANSI\u001b[0m 한글');
		assert.deepStrictEqual(messages[0], {
			type: 'terminal/output',
			payload: { sessionId: 'session-1', data: 'ANSI\u001b[0m 한글' },
		});
		assert.strictEqual(manager.write('not-owned', 'ignored'), false);
		assert.strictEqual(manager.write('session-1', 'input'), true);
		assert.deepStrictEqual(child.writes, ['input']);
		assert.strictEqual(manager.resize('session-1', 120, 40), true);
		assert.deepStrictEqual(child.resizes, [[120, 40]]);

		assert.strictEqual(await manager.dispose(), true);
		assert.strictEqual(manager.size, 0);
		assert.strictEqual(child.killCount, 1);
		assert.deepStrictEqual(messages.at(-1), {
			type: 'terminal/exited',
			payload: { sessionId: 'session-1', exitCode: 0 },
		});
	});
});

/** 가짜 PTY 생성 함수가 받은 executable, 인자 및 fork 옵션을 기록한다. */
interface SpawnCall {
	file: string;
	args: string[] | string;
	options: pty.IPtyForkOptions | pty.IWindowsPtyForkOptions;
}

/**
 * 외부 process 없이 PTY 입력, resize, data 및 exit event를 재현하는 테스트 대역이다.
 */
class FakePty implements IPty {
	readonly pid = 987_654_321;
	readonly cols = 80;
	readonly rows = 24;
	readonly process = 'test-shell';
	handleFlowControl = false;
	readonly writes: Array<string | Buffer> = [];
	readonly resizes: Array<[number, number]> = [];
	killCount = 0;
	private readonly dataListeners = new Set<(data: string) => void>();
	private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

	readonly onData = (listener: (data: string) => void): IDisposable => {
		this.dataListeners.add(listener);
		return { dispose: () => this.dataListeners.delete(listener) };
	};

	readonly onExit = (
		listener: (event: { exitCode: number; signal?: number }) => void,
	): IDisposable => {
		this.exitListeners.add(listener);
		return { dispose: () => this.exitListeners.delete(listener) };
	};

	/**
	 * terminal 입력을 기록한다.
	 *
	 * @param data session manager가 PTY로 전달한 원본 입력
	 */
	write(data: string | Buffer): void {
		this.writes.push(data);
	}

	/**
	 * terminal resize 요청을 기록한다.
	 *
	 * @param cols 변경할 열 수
	 * @param rows 변경할 행 수
	 */
	resize(cols: number, rows: number): void {
		this.resizes.push([cols, rows]);
	}

	/** Windows ConPTY용 화면 초기화를 흉내 내는 no-op 메서드다. */
	clear(): void {}
	/** PTY output pause 계약을 충족하는 no-op 메서드다. */
	pause(): void {}
	/** PTY output resume 계약을 충족하는 no-op 메서드다. */
	resume(): void {}

	/** 등록된 exit listener에 정상 종료 event를 전달한다. */
	kill(): void {
		this.killCount += 1;
		for (const listener of [...this.exitListeners]) {
			listener({ exitCode: 0 });
		}
	}

	/**
	 * 등록된 data listener에 가짜 PTY 출력을 전달한다.
	 *
	 * @param data session manager가 수신할 terminal 출력
	 */
	emitData(data: string): void {
		for (const listener of this.dataListeners) {
			listener(data);
		}
	}
}
