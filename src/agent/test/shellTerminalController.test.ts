import * as assert from 'assert';
import type * as vscode from 'vscode';
import {
	ShellTerminalController,
	type ShellSessionHost,
} from '../host/shellTerminalController';
import type { StartShellOptions } from '../host/ptySessionManager';
import type { TerminalHostMessage } from '../protocol';
import { HostMessageBuffer } from '../host/hostMessageBuffer';

/**
 * Controller의 session 소유권, 변조 메시지 거부, workspace 오류 및 overflow 처리를 검증한다.
 */
suite('Agent Shell Terminal Controller', () => {
	test('ready에서 한 번만 시작하고 active session 소유 input과 resize만 전달한다', async () => {
		const panel = new FakePanel();
		const sessions = new FakeSessions();
		const controller = new ShellTerminalController(
			panel.asWebviewPanel(),
			{ ok: true, rootPath: '/work space/한글' },
			{ log: () => undefined, error: () => undefined },
			sessions,
		);

		panel.emitMessage({ type: 'terminal/ready', payload: { cols: 80, rows: 24 } });
		await settleAsyncMessages();
		assert.strictEqual(sessions.startCount, 1);
		assert.deepStrictEqual(panel.postedMessages.map((message) => message.type), [
			'terminal/starting',
			'terminal/started',
		]);
		assert.strictEqual(sessions.lastStart?.cwd, '/work space/한글');

		panel.emitMessage({ type: 'terminal/ready', payload: { cols: 90, rows: 30 } });
		panel.emitMessage({
			type: 'terminal/input',
			payload: { sessionId: 'foreign-session', data: 'ignored' },
		});
		panel.emitMessage({
			type: 'terminal/input',
			payload: { sessionId: 'session-1', data: '한글' },
		});
		panel.emitMessage({
			type: 'terminal/resize',
			payload: { sessionId: 'session-1', cols: 100, rows: 40 },
		});
		await settleAsyncMessages();

		assert.strictEqual(sessions.startCount, 1);
		assert.deepStrictEqual(sessions.writes, [['session-1', '한글']]);
		assert.deepStrictEqual(sessions.resizes, [['session-1', 100, 40]]);

		sessions.emit({
			type: 'terminal/exited',
			payload: { sessionId: 'session-1', exitCode: 0 },
		});
		await settleAsyncMessages();
		assert.strictEqual(panel.postedMessages.at(-1)?.type, 'terminal/exited');
		assert.strictEqual(await controller.dispose(), true);
	});

	test('실행 계약 필드가 포함된 변조 요청을 무시한다', async () => {
		const panel = new FakePanel();
		const sessions = new FakeSessions();
		const controller = new ShellTerminalController(
			panel.asWebviewPanel(),
			{ ok: true, rootPath: '/workspace' },
			{ log: () => undefined, error: () => undefined },
			sessions,
		);

		panel.emitMessage({
			type: 'terminal/ready',
			payload: { cols: 80, rows: 24, executable: '/bin/sh' },
		});
		await settleAsyncMessages();
		assert.strictEqual(sessions.startCount, 0);
		assert.strictEqual(panel.postedMessages.length, 0);
		await controller.dispose();
	});

	test('지원하지 않는 workspace는 PTY를 만들지 않고 명확한 오류를 전달한다', async () => {
		const panel = new FakePanel();
		const sessions = new FakeSessions();
		const controller = new ShellTerminalController(
			panel.asWebviewPanel(),
			{ ok: false, message: '단일 file workspace만 지원합니다.' },
			{ log: () => undefined, error: () => undefined },
			sessions,
		);

		panel.emitMessage({ type: 'terminal/ready', payload: { cols: 80, rows: 24 } });
		await settleAsyncMessages();
		assert.strictEqual(sessions.startCount, 0);
		assert.deepStrictEqual(panel.postedMessages[0], {
			type: 'terminal/error',
			payload: {
				code: 'invalid_workspace',
				message: '단일 file workspace만 지원합니다.',
				recoverable: false,
			},
		});
		await controller.dispose();
	});

	test('숨김 output buffer가 상한을 넘으면 chunk를 자르지 않고 session을 중단한다', async () => {
		const panel = new FakePanel();
		const sessions = new FakeSessions();
		const controller = new ShellTerminalController(
			panel.asWebviewPanel(),
			{ ok: true, rootPath: '/workspace' },
			{ log: () => undefined, error: () => undefined },
			sessions,
			new HostMessageBuffer(4),
		);

		panel.emitMessage({ type: 'terminal/ready', payload: { cols: 80, rows: 24 } });
		await settleAsyncMessages();
		panel.visible = false;
		sessions.emit(output('😀'));
		sessions.emit(output('A'));
		await settleAsyncMessages();

		assert.deepStrictEqual(sessions.stops, ['session-1']);
		panel.visible = true;
		panel.emitViewState();
		await settleAsyncMessages();
		assert.deepStrictEqual(panel.postedMessages.slice(-2), [
			output('😀'),
			{
				type: 'terminal/error',
				payload: {
					code: 'buffer_overflow',
					message: '보류된 terminal 출력이 8MiB를 초과하여 세션을 중단했습니다.',
					recoverable: true,
					sessionId: 'session-1',
				},
			},
		]);
		await controller.dispose();
	});
});

/**
 * 실제 node-pty 없이 Controller가 호출하는 session Host 계약을 기록하는 테스트 대역이다.
 */
class FakeSessions implements ShellSessionHost {
	startCount = 0;
	lastStart: StartShellOptions | undefined;
	writes: Array<[string, string]> = [];
	resizes: Array<[string, number, number]> = [];
	stops: string[] = [];
	private emitMessage: ((message: TerminalHostMessage) => void) | undefined;

	/**
	 * 시작 옵션과 emit callback을 저장하고 고정 세션 ID를 반환한다.
	 *
	 * @param options Controller가 확정한 shell 시작 옵션
	 * @returns 테스트에서 사용하는 고정 세션 ID
	 */
	startShell(options: StartShellOptions): string {
		this.startCount += 1;
		this.lastStart = options;
		this.emitMessage = options.emit;
		return 'session-1';
	}

	/**
	 * Controller가 전달한 terminal 입력을 기록한다.
	 *
	 * @param sessionId 입력 대상 세션 ID
	 * @param data 전달된 원본 입력
	 * @returns 테스트 대역의 입력 성공 여부
	 */
	write(sessionId: string, data: string): boolean {
		this.writes.push([sessionId, data]);
		return true;
	}

	/**
	 * Controller가 전달한 terminal 크기를 기록한다.
	 *
	 * @param sessionId resize 대상 세션 ID
	 * @param cols 열 수
	 * @param rows 행 수
	 * @returns 테스트 대역의 resize 성공 여부
	 */
	resize(sessionId: string, cols: number, rows: number): boolean {
		this.resizes.push([sessionId, cols, rows]);
		return true;
	}

	/**
	 * 중단 대상 세션을 기록하고 종료 event를 Controller로 되돌린다.
	 *
	 * @param sessionId 중단할 세션 ID
	 * @returns cleanup 성공 결과
	 */
	stop(sessionId: string): Promise<boolean> {
		this.stops.push(sessionId);
		this.emit({
			type: 'terminal/exited',
			payload: { sessionId, exitCode: 1 },
		});
		return Promise.resolve(true);
	}

	/** @returns 전체 테스트 세션 cleanup 성공 결과 */
	dispose(): Promise<boolean> {
		return Promise.resolve(true);
	}

	/**
	 * 저장된 session callback을 통해 Host 메시지를 Controller로 전달한다.
	 *
	 * @param message 전달할 가짜 session 메시지
	 */
	emit(message: TerminalHostMessage): void {
		this.emitMessage?.(message);
	}
}

/**
 * VS Code WebviewPanel의 메시지 수신, view state 및 postMessage만 재현하는 테스트 대역이다.
 */
class FakePanel {
	visible = true;
	readonly postedMessages: TerminalHostMessage[] = [];
	private messageListener: ((message: unknown) => void) | undefined;
	private viewStateListener:
		| ((event: vscode.WebviewPanelOnDidChangeViewStateEvent) => void)
		| undefined;

	readonly webview = {
		onDidReceiveMessage: (
			listener: (message: unknown) => void,
			_thisArg?: unknown,
			disposables?: vscode.Disposable[],
		): vscode.Disposable => {
			this.messageListener = listener;
			const disposable = { dispose: () => undefined };
			disposables?.push(disposable);
			return disposable;
		},
		postMessage: async (message: TerminalHostMessage): Promise<boolean> => {
			this.postedMessages.push(message);
			return true;
		},
	};

	/**
	 * Panel visibility listener를 등록하고 disposable을 반환한다.
	 *
	 * @param _listener visibility 변경 listener
	 * @param _thisArg listener의 선택적 thisArg
	 * @param disposables listener disposable을 모을 배열
	 * @returns 등록 해제를 나타내는 disposable
	 */
	onDidChangeViewState(
		_listener: (event: vscode.WebviewPanelOnDidChangeViewStateEvent) => void,
		_thisArg?: unknown,
		disposables?: vscode.Disposable[],
	): vscode.Disposable {
		this.viewStateListener = _listener;
		const disposable = { dispose: () => undefined };
		disposables?.push(disposable);
		return disposable;
	}

	/**
	 * Webview에서 Host로 들어오는 원본 메시지를 발생시킨다.
	 *
	 * @param message Controller에 전달할 원본 메시지
	 */
	emitMessage(message: unknown): void {
		this.messageListener?.(message);
	}

	/** 저장된 listener에 현재 Panel의 view state 변경을 알린다. */
	emitViewState(): void {
		this.viewStateListener?.({ webviewPanel: this.asWebviewPanel() });
	}

	/** @returns FakePanel을 VS Code WebviewPanel 타입으로 변환한 테스트 객체 */
	asWebviewPanel(): vscode.WebviewPanel {
		return this as unknown as vscode.WebviewPanel;
	}
}

/** 비동기 메시지 callback과 Promise microtask가 완료될 때까지 두 event loop turn을 기다린다. */
async function settleAsyncMessages(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Controller 테스트용 terminal output 메시지를 생성한다.
 *
 * @param data session-1에 연결할 출력 문자열
 * @returns terminal output Host 메시지
 */
function output(data: string): TerminalHostMessage {
	return { type: 'terminal/output', payload: { sessionId: 'session-1', data } };
}
