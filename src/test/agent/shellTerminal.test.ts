import * as assert from 'assert';
import type { FitAddon } from '@xterm/addon-fit';
import {
	initializeShellTerminal,
	readVsCodeAnsiTheme,
	TERMINAL_INITIAL_FALLBACK_DIMENSIONS,
	TERMINAL_INITIAL_FIT_MAX_FRAMES,
	TERMINAL_INITIALIZATION_ERROR_MESSAGE,
	type ShellTerminalDependencies,
	type TerminalOverlayState,
	type TerminalOverlayView,
} from '../../agent/webview/shellTerminal';

const TAB_ID = 'tab-webview-terminal';
const SESSION_ID = 'session-current';

suite('Shell Terminal Webview', () => {
	test('VS Code Terminal CSS 색상을 xterm theme에 매핑한다', () => {
		const cssValues: Readonly<Record<string, string>> = {
			'--vscode-terminal-background': ' #010101 ',
			'--vscode-terminal-foreground': '#f1f1f1',
			'--vscode-terminalCursor-foreground': '#020202',
			'--vscode-terminalCursor-background': '#f2f2f2',
			'--vscode-terminal-selectionBackground': '#030303',
			'--vscode-terminal-ansiBlack': '#000000',
			'--vscode-terminal-ansiRed': '#aa0000',
			'--vscode-terminal-ansiGreen': '#00aa00',
			'--vscode-terminal-ansiYellow': '#aaaa00',
			'--vscode-terminal-ansiBlue': '#0000aa',
			'--vscode-terminal-ansiMagenta': '#aa00aa',
			'--vscode-terminal-ansiCyan': '#00aaaa',
			'--vscode-terminal-ansiWhite': '#aaaaaa',
			'--vscode-terminal-ansiBrightBlack': '#555555',
			'--vscode-terminal-ansiBrightRed': '#ff5555',
			'--vscode-terminal-ansiBrightGreen': '#55ff55',
			'--vscode-terminal-ansiBrightYellow': '#ffff55',
			'--vscode-terminal-ansiBrightBlue': '#5555ff',
			'--vscode-terminal-ansiBrightMagenta': '#ff55ff',
			'--vscode-terminal-ansiBrightCyan': '#55ffff',
			'--vscode-terminal-ansiBrightWhite': '   ',
		};

		const theme = withWebviewComputedStyle(
			{ body: (name) => cssValues[name] ?? '' },
			readVsCodeAnsiTheme,
		);

		assert.deepStrictEqual(theme, {
			background: '#010101',
			foreground: '#f1f1f1',
			cursor: '#020202',
			cursorAccent: '#f2f2f2',
			selectionBackground: '#030303',
			black: '#000000',
			red: '#aa0000',
			green: '#00aa00',
			yellow: '#aaaa00',
			blue: '#0000aa',
			magenta: '#aa00aa',
			cyan: '#00aaaa',
			white: '#aaaaaa',
			brightBlack: '#555555',
			brightRed: '#ff5555',
			brightGreen: '#55ff55',
			brightYellow: '#ffff55',
			brightBlue: '#5555ff',
			brightMagenta: '#ff55ff',
			brightCyan: '#55ffff',
			brightWhite: undefined,
		});
	});

	test('VS Code theme 조회 실패 시 xterm 기본 theme로 fallback한다', () => {
		const theme = withWebviewComputedStyle(
			{
				body: () => {
					throw new Error('computed style unavailable');
				},
			},
			readVsCodeAnsiTheme,
		);

		assert.deepStrictEqual(theme, {});
	});

	test('테마 변수를 documentElement에 주입한 경우에도 읽는다', () => {
		/* VS Code 버전에 따라 주입 대상이 달라도 같은 팔레트를 얻어야 한다. */
		const theme = withWebviewComputedStyle(
			{
				body: () => '',
				documentElement: (name) =>
					name === '--vscode-terminal-ansiRed' ? '#aa0000' : '',
			},
			readVsCodeAnsiTheme,
		);

		assert.strictEqual(theme.red, '#aa0000');
	});

	test('body에 주입된 값을 documentElement 값보다 우선한다', () => {
		const theme = withWebviewComputedStyle(
			{
				body: (name) =>
					name === '--vscode-terminal-ansiRed' ? '#aa0000' : '',
				documentElement: (name) =>
					name === '--vscode-terminal-ansiRed' ? '#0000aa' : '#00aa00',
			},
			readVsCodeAnsiTheme,
		);

		assert.strictEqual(theme.red, '#aa0000');
		/* body가 비워 둔 값은 documentElement에서 이어서 찾는다. */
		assert.strictEqual(theme.green, '#00aa00');
	});

	test('Terminal, FitAddon, load, open, fit 순서로 xterm을 mount한다', () => {
		const events: string[] = [];
		const terminal = new FakeTerminal(events);
		const fitAddon = createFitAddon(events, { cols: 100, rows: 32 });
		const animationFrames = new FakeAnimationFrames(events);
		const elements = createElements();

		const controller = initializeShellTerminal(
			elements.surface,
			elements.mount,
			elements.overlay,
			() => undefined,
			createDependencies(terminal, fitAddon, events, animationFrames),
		);

		assert.strictEqual(controller.tabId, TAB_ID);
		assert.deepStrictEqual(events, [
			'createTerminal',
			'createFitAddon',
			'loadAddon',
			'open',
			'onData',
			'requestAnimationFrame',
		]);

		animationFrames.flushNext();
		assert.deepStrictEqual(events.slice(-2), ['fit', 'proposeDimensions']);
		assert.strictEqual(terminal.openedContainer, elements.mount);
		assert.strictEqual(elements.overlay.hidden, true);
	});

	test('첫 animation frame의 유효한 크기로 terminal.ready를 한 번만 보낸다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const animationFrames = new FakeAnimationFrames();
		initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(
				terminal,
				createFitAddon([], { cols: 132, rows: 43 }),
				[],
				animationFrames,
			),
		);

		assert.deepStrictEqual(messages, []);
		animationFrames.flushNext();

		assert.deepStrictEqual(messages, [{
			type: 'terminal.ready',
			tabId: TAB_ID,
			cols: 132,
			rows: 43,
		}]);
		assert.deepStrictEqual(Object.keys(messages[0] as object).sort(), [
			'cols',
			'rows',
			'tabId',
			'type',
		]);
		assert.strictEqual(animationFrames.pendingCount, 0);
	});

	test('0 이하 크기에서는 ready를 미루고 다음 frame의 유효한 크기를 사용한다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const animationFrames = new FakeAnimationFrames();
		let proposals = 0;
		initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(
				terminal,
				createFitAddon([], () => {
					proposals += 1;
					return proposals === 1
						? { cols: 0, rows: 0 }
						: { cols: 96, rows: 28 };
				}),
				[],
				animationFrames,
			),
		);

		animationFrames.flushNext();
		assert.deepStrictEqual(messages, []);
		assert.strictEqual(animationFrames.pendingCount, 1);

		animationFrames.flushNext();
		assert.deepStrictEqual(messages, [{
			type: 'terminal.ready',
			tabId: TAB_ID,
			cols: 96,
			rows: 28,
		}]);
	});

	test('숨겨진 surface의 크기가 계속 없으면 제한 frame 뒤 80x24로 시작한다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const animationFrames = new FakeAnimationFrames();
		initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(
				terminal,
				createFitAddon([], () => undefined),
				[],
				animationFrames,
			),
		);

		for (let frame = 1; frame < TERMINAL_INITIAL_FIT_MAX_FRAMES; frame += 1) {
			animationFrames.flushNext();
			assert.deepStrictEqual(messages, []);
		}
		animationFrames.flushNext();

		assert.deepStrictEqual(messages, [{
			type: 'terminal.ready',
			tabId: TAB_ID,
			...TERMINAL_INITIAL_FALLBACK_DIMENSIONS,
		}]);
		assert.strictEqual(animationFrames.pendingCount, 0);
	});

	test('ResizeObserver, Dock/Drag 호출, Window, Visibility 이벤트를 한 frame으로 병합한다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const animationFrames = new FakeAnimationFrames();
		const environment = new FakeTerminalEnvironment();
		let dimensions = { cols: 80, rows: 24 };
		const controller = initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(
				terminal,
				createFitAddon([], () => dimensions),
				[],
				animationFrames,
				environment,
			),
		);

		animationFrames.flushNext();
		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		dimensions = { cols: 132, rows: 43 };

		controller.scheduleTerminalFit();
		controller.scheduleTerminalFit();
		environment.triggerContainerResize();
		environment.triggerWindowResize();
		environment.triggerVisibilityChange();
		assert.strictEqual(animationFrames.pendingCount, 1);

		animationFrames.flushNext();
		assert.deepStrictEqual(messages[1], {
			type: 'terminal.resize',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			cols: 132,
			rows: 43,
		});
		assert.deepStrictEqual(Object.keys(messages[1] as object).sort(), [
			'cols',
			'rows',
			'sessionId',
			'tabId',
			'type',
		]);

		environment.triggerContainerResize();
		animationFrames.flushNext();
		assert.strictEqual(messages.length, 2, '동일한 cols/rows는 중복 전송하지 않아야 한다.');
	});

	test('hidden 또는 0 크기에서는 resize하지 않고 visible 복귀 뒤 다시 fit한다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const animationFrames = new FakeAnimationFrames();
		const environment = new FakeTerminalEnvironment();
		const elements = createElements();
		let dimensions = { cols: 80, rows: 24 };
		const controller = initializeShellTerminal(
			elements.surface,
			elements.mount,
			elements.overlay,
			(message) => messages.push(message),
			createDependencies(
				terminal,
				createFitAddon([], () => dimensions),
				[],
				animationFrames,
				environment,
			),
		);

		animationFrames.flushNext();
		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		animationFrames.flushNext();

		dimensions = { cols: 120, rows: 36 };
		environment.hidden = true;
		environment.triggerVisibilityChange();
		animationFrames.flushNext();
		assert.strictEqual(messages.length, 1);

		environment.hidden = false;
		elements.surfaceElement.hidden = true;
		environment.triggerContainerResize();
		animationFrames.flushNext();
		assert.strictEqual(messages.length, 1);

		elements.surfaceElement.hidden = false;
		elements.mountElement.clientWidth = 0;
		environment.triggerContainerResize();
		animationFrames.flushNext();
		assert.strictEqual(messages.length, 1);

		elements.mountElement.clientWidth = 800;
		environment.triggerVisibilityChange();
		animationFrames.flushNext();
		assert.deepStrictEqual(messages[1], {
			type: 'terminal.resize',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			cols: 120,
			rows: 36,
		});
	});

	test('0 이하 cols/rows와 종료된 session에는 resize를 전송하지 않는다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const animationFrames = new FakeAnimationFrames();
		let dimensions = { cols: 80, rows: 24 };
		const controller = initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(
				terminal,
				createFitAddon([], () => dimensions),
				[],
				animationFrames,
			),
		);

		animationFrames.flushNext();
		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		dimensions = { cols: 0, rows: 30 };
		animationFrames.flushNext();
		controller.scheduleTerminalFit();
		dimensions = { cols: 100, rows: 0 };
		animationFrames.flushNext();
		assert.strictEqual(messages.length, 1);

		controller.handleHostMessage({
			type: 'terminal.exited',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			exitCode: 0,
		});
		controller.scheduleTerminalFit();
		dimensions = { cols: 140, rows: 50 };
		animationFrames.flushNext();
		assert.strictEqual(messages.length, 1);
	});

	test('fit 계산 실패를 호출자에 전파하지 않고 다음 resize에서 복구한다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const animationFrames = new FakeAnimationFrames();
		let dimensions = { cols: 80, rows: 24 };
		let shouldThrow = false;
		const fitAddon = createFitAddon([], () => dimensions);
		fitAddon.fit = () => {
			if (shouldThrow) {
				throw new Error('fit failed');
			}
		};
		const controller = initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(terminal, fitAddon, [], animationFrames),
		);

		animationFrames.flushNext();
		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		shouldThrow = true;
		assert.doesNotThrow(() => animationFrames.flushNext());
		assert.strictEqual(messages.length, 1);

		shouldThrow = false;
		dimensions = { cols: 110, rows: 35 };
		controller.scheduleTerminalFit();
		animationFrames.flushNext();
		assert.strictEqual(messages.length, 2);
	});

	test('현재 tabId와 sessionId가 모두 일치하는 output만 원문 그대로 write한다', () => {
		const terminal = new FakeTerminal();
		const controller = initializeShellTerminal(
			...createElementArguments(),
			() => undefined,
			createDependencies(terminal),
		);
		const unchangedOutput = '\u001b[31mred\u001b[0m\r\n한글  \n';

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: 'tab-other',
			sessionId: SESSION_ID,
			data: 'wrong tab',
		});
		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: TAB_ID,
			sessionId: 'session-stale',
			data: 'stale session',
		});
		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: unchangedOutput,
		});

		assert.deepStrictEqual(terminal.writes, [unchangedOutput]);
	});

	test('xterm onData 문자열을 분기나 변형 없이 현재 session input으로 보낸다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const controller = initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(terminal),
		);
		const unchangedInput = '한글 paste\r\u007f\t\u001b[A\u0003\u0004';

		terminal.emitData('not attached');
		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		terminal.emitData(unchangedInput);

		assert.deepStrictEqual(messages, [{
			type: 'terminal.input',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: unchangedInput,
		}]);
		assert.strictEqual(terminal.focusCalls, 1);
	});

	test('다른 tab의 started는 focus하지 않고 현재 tab의 started만 입력 focus한다', () => {
		const terminal = new FakeTerminal();
		const controller = initializeShellTerminal(
			...createElementArguments(),
			() => undefined,
			createDependencies(terminal),
		);

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: 'tab-other',
			sessionId: SESSION_ID,
		});
		assert.strictEqual(terminal.focusCalls, 0);

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		assert.strictEqual(terminal.focusCalls, 1);
	});

	test('종료된 현재 session에는 input과 늦은 output을 연결하지 않는다', () => {
		const terminal = new FakeTerminal();
		const messages: unknown[] = [];
		const controller = initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(terminal),
		);

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		controller.handleHostMessage({
			type: 'terminal.exited',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			exitCode: 0,
		});
		terminal.emitData('late input');
		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: 'late output',
		});

		assert.deepStrictEqual(messages, []);
		assert.deepStrictEqual(terminal.writes, []);
	});

	test('Shell 종료 시 buffer를 유지한 채 exit code 덮개를 표시한다', () => {
		const terminal = new FakeTerminal();
		const overlayView = new FakeOverlayView();
		const elements = createElements();
		const controller = initializeShellTerminal(
			elements.surface,
			elements.mount,
			elements.overlay,
			() => undefined,
			createDependencies(
				terminal,
				createFitAddon(),
				[],
				new FakeAnimationFrames(),
				new FakeTerminalEnvironment(),
				overlayView,
			),
		);

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: 'kept output',
		});
		controller.handleHostMessage({
			type: 'terminal.exited',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			exitCode: 3,
			signal: 15,
		});

		assert.deepStrictEqual(overlayView.shownStates, [{
			kind: 'exited',
			exitCode: 3,
			signal: 15,
		}]);
		assert.strictEqual(terminal.resetCalls, 0);
		assert.deepStrictEqual(terminal.writes, ['kept output']);
		assert.strictEqual(elements.surfaceElement.dataset.state, 'exited');
	});

	test('시작 실패 덮개는 Host의 안전한 메시지만 표시한다', () => {
		const overlayView = new FakeOverlayView();
		const controller = initializeShellTerminal(
			...createElementArguments(),
			() => undefined,
			createDependencies(
				new FakeTerminal(),
				createFitAddon(),
				[],
				new FakeAnimationFrames(),
				new FakeTerminalEnvironment(),
				overlayView,
			),
		);

		controller.handleHostMessage({
			type: 'terminal.error',
			tabId: TAB_ID,
			sessionId: 'session-failed-start',
			code: 'shell_unavailable',
			message: 'Terminal launch policy could not be prepared.',
			canRestart: true,
		});

		assert.deepStrictEqual(overlayView.shownStates, [{
			kind: 'error',
			message: 'Terminal launch policy could not be prepared.',
			canRestart: true,
		}]);
	});

	test('재시작 버튼은 tabId와 sessionId만 담은 restart를 한 번 보낸다', () => {
		const messages: unknown[] = [];
		const overlayView = new FakeOverlayView();
		const controller = initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(
				new FakeTerminal(),
				createFitAddon(),
				[],
				new FakeAnimationFrames(),
				new FakeTerminalEnvironment(),
				overlayView,
			),
		);

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		controller.handleHostMessage({
			type: 'terminal.exited',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			exitCode: 0,
		});
		overlayView.clickRestart();
		overlayView.clickRestart();

		assert.deepStrictEqual(messages, [{
			type: 'terminal.restart',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		}]);
	});

	test('새 PTY가 시작된 뒤에만 buffer를 reset하고 덮개를 제거한다', () => {
		const terminal = new FakeTerminal();
		const overlayView = new FakeOverlayView();
		const elements = createElements();
		const controller = initializeShellTerminal(
			elements.surface,
			elements.mount,
			elements.overlay,
			() => undefined,
			createDependencies(
				terminal,
				createFitAddon(),
				[],
				new FakeAnimationFrames(),
				new FakeTerminalEnvironment(),
				overlayView,
			),
		);

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		assert.strictEqual(terminal.resetCalls, 0, '최초 시작은 buffer를 지우지 않는다.');

		controller.handleHostMessage({
			type: 'terminal.exited',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			exitCode: 0,
		});
		overlayView.clickRestart();
		assert.strictEqual(terminal.resetCalls, 0, 'restart 요청만으로는 지우지 않는다.');
		assert.strictEqual(overlayView.hideCalls, 0);

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: 'session-restarted',
		});

		assert.strictEqual(terminal.resetCalls, 1);
		assert.strictEqual(overlayView.hideCalls, 1);
		assert.strictEqual(elements.surfaceElement.dataset.state, 'ready');
	});

	test('재시작 시작이 실패하면 buffer를 유지한 채 오류 덮개를 다시 표시한다', () => {
		const terminal = new FakeTerminal();
		const overlayView = new FakeOverlayView();
		const messages: unknown[] = [];
		const controller = initializeShellTerminal(
			...createElementArguments(),
			(message) => messages.push(message),
			createDependencies(
				terminal,
				createFitAddon(),
				[],
				new FakeAnimationFrames(),
				new FakeTerminalEnvironment(),
				overlayView,
			),
		);

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: 'kept output',
		});
		controller.handleHostMessage({
			type: 'terminal.exited',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			exitCode: 1,
		});
		overlayView.clickRestart();
		controller.handleHostMessage({
			type: 'terminal.error',
			tabId: TAB_ID,
			sessionId: 'session-restart-failed',
			code: 'start_failed',
			message: 'Terminal process could not be started.',
			canRestart: true,
		});

		assert.strictEqual(terminal.resetCalls, 0);
		assert.deepStrictEqual(terminal.writes, ['kept output']);
		assert.strictEqual(overlayView.hideCalls, 0);
		assert.deepStrictEqual(overlayView.shownStates[1], {
			kind: 'error',
			message: 'Terminal process could not be started.',
			canRestart: true,
		});

		overlayView.clickRestart();
		assert.deepStrictEqual(messages[1], {
			type: 'terminal.restart',
			tabId: TAB_ID,
			sessionId: 'session-restart-failed',
		});
	});

	test('재시작 뒤 이전 session의 늦은 output, exit 및 error를 무시한다', () => {
		const terminal = new FakeTerminal();
		const overlayView = new FakeOverlayView();
		const controller = initializeShellTerminal(
			...createElementArguments(),
			() => undefined,
			createDependencies(
				terminal,
				createFitAddon(),
				[],
				new FakeAnimationFrames(),
				new FakeTerminalEnvironment(),
				overlayView,
			),
		);

		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		controller.handleHostMessage({
			type: 'terminal.exited',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			exitCode: 0,
		});
		overlayView.clickRestart();
		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: 'session-restarted',
		});

		controller.handleHostMessage({
			type: 'terminal.output',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			data: 'late output',
		});
		controller.handleHostMessage({
			type: 'terminal.exited',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			exitCode: 9,
		});
		controller.handleHostMessage({
			type: 'terminal.error',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
			code: 'internal_error',
			message: 'Terminal process operation failed.',
			canRestart: true,
		});

		assert.deepStrictEqual(terminal.writes, []);
		assert.strictEqual(overlayView.shownStates.length, 1);
		assert.strictEqual(overlayView.hideCalls, 1);
	});

	test('초기화 예외 원문을 노출하지 않고 Terminal 영역만 error 상태로 바꾼다', () => {
		const terminal = new FakeTerminal();
		const elements = createElements();
		const dependencies = createDependencies(terminal);
		dependencies.createFitAddon = () => {
			throw new Error('secret initialization details');
		};

		const controller = initializeShellTerminal(
			elements.surface,
			elements.mount,
			elements.overlay,
			() => undefined,
			dependencies,
		);

		assert.strictEqual(elements.surfaceElement.dataset.state, 'error');
		assert.strictEqual(
			elements.overlayElement.textContent,
			TERMINAL_INITIALIZATION_ERROR_MESSAGE,
		);
		assert.ok(!elements.overlayElement.textContent.includes('secret'));
		assert.strictEqual(elements.overlayElement.hidden, false);
		assert.strictEqual(elements.overlayElement.role, 'alert');
		assert.strictEqual(elements.mountElement.replaceChildrenCalls, 1);
		assert.strictEqual(terminal.disposeCalls, 1);
		controller.handleHostMessage({
			type: 'terminal.started',
			tabId: TAB_ID,
			sessionId: SESSION_ID,
		});
		assert.doesNotThrow(() => {
			controller.handleHostMessage({
				type: 'terminal.output',
				tabId: TAB_ID,
				sessionId: SESSION_ID,
				data: 'ignored',
			});
		});
	});
});

class FakeTerminal {
	readonly writes: string[] = [];
	openedContainer: HTMLElement | undefined;
	disposeCalls = 0;
	focusCalls = 0;
	resetCalls = 0;
	private dataListener: ((data: string) => void) | undefined;

	constructor(private readonly events: string[] = []) {}

	loadAddon(_addon: FitAddon): void {
		this.events.push('loadAddon');
	}

	open(container: HTMLElement): void {
		this.events.push('open');
		this.openedContainer = container;
	}

	focus(): void {
		this.focusCalls += 1;
	}

	write(data: string): void {
		this.writes.push(data);
	}

	reset(): void {
		this.resetCalls += 1;
	}

	onData(listener: (data: string) => void): unknown {
		this.events.push('onData');
		this.dataListener = listener;
		return undefined;
	}

	dispose(): void {
		this.disposeCalls += 1;
	}

	emitData(data: string): void {
		this.dataListener?.(data);
	}
}

/** 덮개 DOM 대신 표시 상태와 재시작 클릭만 기록하는 테스트 대역이다. */
class FakeOverlayView implements TerminalOverlayView {
	readonly shownStates: TerminalOverlayState[] = [];
	hideCalls = 0;
	private requestRestart: (() => void) | undefined;

	attach(_overlay: HTMLElement, onRestart: () => void): TerminalOverlayView {
		this.requestRestart = onRestart;
		return this;
	}

	show(state: TerminalOverlayState): void {
		this.shownStates.push(state);
	}

	hide(): void {
		this.hideCalls += 1;
	}

	clickRestart(): void {
		this.requestRestart?.();
	}
}

class FakeElement {
	readonly dataset: DOMStringMap = {};
	textContent = '';
	role: string | undefined;
	replaceChildrenCalls = 0;

	constructor(
		public hidden = false,
		public clientWidth = 800,
		public clientHeight = 600,
	) {}

	setAttribute(name: string, value: string): void {
		if (name === 'role') {
			this.role = value;
		}
	}

	replaceChildren(): void {
		this.replaceChildrenCalls += 1;
	}

	asHtmlElement(): HTMLElement {
		return this as unknown as HTMLElement;
	}
}

interface FakeElements {
	readonly surfaceElement: FakeElement;
	readonly mountElement: FakeElement;
	readonly overlayElement: FakeElement;
	readonly surface: HTMLElement;
	readonly mount: HTMLElement;
	readonly overlay: HTMLElement;
}

function createElements(): FakeElements {
	const surfaceElement = new FakeElement();
	const mountElement = new FakeElement();
	const overlayElement = new FakeElement(true);

	return {
		surfaceElement,
		mountElement,
		overlayElement,
		surface: surfaceElement.asHtmlElement(),
		mount: mountElement.asHtmlElement(),
		overlay: overlayElement.asHtmlElement(),
	};
}

function createElementArguments(): [HTMLElement, HTMLElement, HTMLElement] {
	const elements = createElements();
	return [elements.surface, elements.mount, elements.overlay];
}

function createDependencies(
	terminal: FakeTerminal,
	fitAddon = createFitAddon(),
	events: string[] = [],
	animationFrames = new FakeAnimationFrames(),
	environment = new FakeTerminalEnvironment(),
	overlayView = new FakeOverlayView(),
): ShellTerminalDependencies {
	return {
		createTerminal: () => {
			events.push('createTerminal');
			return terminal;
		},
		createFitAddon: () => {
			events.push('createFitAddon');
			return fitAddon;
		},
		createTabId: () => TAB_ID,
		createOverlayView: (overlay, onRestart) =>
			overlayView.attach(overlay, onRestart),
		requestAnimationFrame: (callback) => animationFrames.request(callback),
		createResizeObserver: (callback) => environment.createResizeObserver(callback),
		addWindowResizeListener: (listener) => environment.addWindowResizeListener(listener),
		addVisibilityChangeListener: (listener) =>
			environment.addVisibilityChangeListener(listener),
		isDocumentHidden: () => environment.hidden,
	};
}

class FakeTerminalEnvironment {
	hidden = false;
	private resizeObserverListener: (() => void) | undefined;
	private windowResizeListener: (() => void) | undefined;
	private visibilityChangeListener: (() => void) | undefined;

	createResizeObserver(callback: ResizeObserverCallback): ResizeObserver {
		return {
			observe: () => {
				this.resizeObserverListener = () => callback([], {} as ResizeObserver);
			},
			disconnect: () => {
				this.resizeObserverListener = undefined;
			},
			unobserve: () => undefined,
		} as ResizeObserver;
	}

	addWindowResizeListener(listener: () => void): () => void {
		this.windowResizeListener = listener;
		return () => {
			this.windowResizeListener = undefined;
		};
	}

	addVisibilityChangeListener(listener: () => void): () => void {
		this.visibilityChangeListener = listener;
		return () => {
			this.visibilityChangeListener = undefined;
		};
	}

	triggerContainerResize(): void {
		this.resizeObserverListener?.();
	}

	triggerWindowResize(): void {
		this.windowResizeListener?.();
	}

	triggerVisibilityChange(): void {
		this.visibilityChangeListener?.();
	}
}

type ProposedDimensions = { readonly cols: number; readonly rows: number } | undefined;

function createFitAddon(
	events: string[] = [],
	dimensions: ProposedDimensions | (() => ProposedDimensions) = {
		cols: 80,
		rows: 24,
	},
): FitAddon {
	return {
		activate: () => undefined,
		dispose: () => undefined,
		fit: () => events.push('fit'),
		proposeDimensions: () => {
			events.push('proposeDimensions');
			return typeof dimensions === 'function' ? dimensions() : dimensions;
		},
	} as FitAddon;
}

class FakeAnimationFrames {
	private readonly callbacks: FrameRequestCallback[] = [];

	constructor(private readonly events: string[] = []) {}

	get pendingCount(): number {
		return this.callbacks.length;
	}

	request(callback: FrameRequestCallback): number {
		this.events.push('requestAnimationFrame');
		this.callbacks.push(callback);
		return this.callbacks.length;
	}

	flushNext(): void {
		const callback = this.callbacks.shift();
		assert.ok(callback, 'Expected a pending animation frame callback.');
		callback(0);
	}
}

function withWebviewComputedStyle<T>(
	sources: {
		readonly body?: (name: string) => string;
		readonly documentElement?: (name: string) => string;
	},
	action: () => T,
): T {
	const body = sources.body === undefined ? undefined : {};
	const documentElement = sources.documentElement === undefined ? undefined : {};
	const documentDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		'document',
	);
	const getComputedStyleDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		'getComputedStyle',
	);

	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: { body, documentElement },
	});
	Object.defineProperty(globalThis, 'getComputedStyle', {
		configurable: true,
		value: (element: unknown) => ({
			getPropertyValue: element === body
				? sources.body ?? (() => '')
				: sources.documentElement ?? (() => ''),
		}),
	});

	try {
		return action();
	} finally {
		restoreGlobalProperty('document', documentDescriptor);
		restoreGlobalProperty('getComputedStyle', getComputedStyleDescriptor);
	}
}

function restoreGlobalProperty(
	name: 'document' | 'getComputedStyle',
	descriptor: PropertyDescriptor | undefined,
): void {
	if (descriptor === undefined) {
		Reflect.deleteProperty(globalThis, name);
		return;
	}

	Object.defineProperty(globalThis, name, descriptor);
}
