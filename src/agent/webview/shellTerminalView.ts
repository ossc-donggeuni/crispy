import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
	isTerminalHostMessage,
	type TerminalWebviewMessage,
} from '../protocol';

/** terminal protocol 메시지를 Extension Host에 전달하는 VS Code Webview API 계약이다. */
export interface TerminalWebviewApi {
	/** @param message Host에 전달할 검증 가능한 terminal 메시지 */
	postMessage(message: TerminalWebviewMessage): void;
}

/** 단일 terminal 화면 구성에 필요한 DOM 요소 모음이다. */
export interface ShellTerminalElements {
	container: HTMLElement;
	overlay: HTMLElement;
	status: HTMLElement;
	restartButton: HTMLButtonElement;
}

/** Dock·resize·visibility 변화에서 호출할 terminal 화면 갱신 계약이다. */
export interface ShellTerminalView {
	/** 다음 animation frame에 xterm 크기 맞춤을 예약한다. */
	scheduleFit(): void;
	/** 숨김 상태에서 복귀한 xterm의 크기와 전체 행을 다시 그린다. */
	restoreVisibleTerminal(): void;
}

/**
 * 단일 xterm/FitAddon 화면을 PTY protocol에 연결한다.
 *
 * @param elements terminal container, 상태 overlay 및 Restart 버튼
 * @param vscodeApi Host에 typed terminal 메시지를 전송할 Webview API
 * @returns Dock·resize·visibility 변화에서 사용할 화면 갱신 함수
 */
export function initializeShellTerminal(
	elements: ShellTerminalElements,
	vscodeApi: TerminalWebviewApi,
): ShellTerminalView {
	const computed = getComputedStyle(document.body);
	const editorBackground = cssColor(computed, '--vscode-editor-background', '#1e1e1e');
	const editorForeground = cssColor(computed, '--vscode-editor-foreground', '#cccccc');
	const terminal = new Terminal({
		cursorBlink: true,
		cursorStyle: 'block',
		fontFamily: computed.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace',
		fontSize: 13,
		scrollback: 5_000,
		allowProposedApi: false,
		theme: {
			background: cssColor(
				computed,
				'--vscode-terminal-background',
				editorBackground,
			),
			foreground: cssColor(
				computed,
				'--vscode-terminal-foreground',
				editorForeground,
			),
			cursor: cssColor(
				computed,
				'--vscode-terminalCursor-foreground',
				editorForeground,
			),
			cursorAccent: cssColor(
				computed,
				'--vscode-terminalCursor-background',
				editorBackground,
			),
			selectionBackground: cssColor(
				computed,
				'--vscode-terminal-selectionBackground',
				cssColor(computed, '--vscode-editor-selectionBackground', '#264f78'),
			),
			selectionForeground: cssColor(computed, '--vscode-terminal-selectionForeground'),
			selectionInactiveBackground: cssColor(
				computed,
				'--vscode-terminal-inactiveSelectionBackground',
			),
			black: cssColor(computed, '--vscode-terminal-ansiBlack'),
			red: cssColor(computed, '--vscode-terminal-ansiRed'),
			green: cssColor(computed, '--vscode-terminal-ansiGreen'),
			yellow: cssColor(computed, '--vscode-terminal-ansiYellow'),
			blue: cssColor(computed, '--vscode-terminal-ansiBlue'),
			magenta: cssColor(computed, '--vscode-terminal-ansiMagenta'),
			cyan: cssColor(computed, '--vscode-terminal-ansiCyan'),
			white: cssColor(computed, '--vscode-terminal-ansiWhite'),
			brightBlack: cssColor(computed, '--vscode-terminal-ansiBrightBlack'),
			brightRed: cssColor(computed, '--vscode-terminal-ansiBrightRed'),
			brightGreen: cssColor(computed, '--vscode-terminal-ansiBrightGreen'),
			brightYellow: cssColor(computed, '--vscode-terminal-ansiBrightYellow'),
			brightBlue: cssColor(computed, '--vscode-terminal-ansiBrightBlue'),
			brightMagenta: cssColor(computed, '--vscode-terminal-ansiBrightMagenta'),
			brightCyan: cssColor(computed, '--vscode-terminal-ansiBrightCyan'),
			brightWhite: cssColor(computed, '--vscode-terminal-ansiBrightWhite'),
		},
	});
	const fitAddon = new FitAddon();
	terminal.loadAddon(fitAddon);
	terminal.open(elements.container);

	let sessionId: string | undefined;
	let resizeScheduled = false;

	/** 현재 container 크기에 맞춰 xterm 열과 행을 즉시 계산한다. */
	const fitTerminal = () => {
		if (elements.container.clientWidth === 0 || elements.container.clientHeight === 0) {
			return;
		}
		fitAddon.fit();
	};

	/** 중복 예약을 방지하며 다음 animation frame에 terminal fit을 실행한다. */
	const scheduleFit = () => {
		if (resizeScheduled) {
			return;
		}

		resizeScheduled = true;
		requestAnimationFrame(() => {
			resizeScheduled = false;
			fitTerminal();
		});
	};

	/** 숨김 또는 focus 이탈 후 terminal 크기와 전체 화면 내용을 복원한다. */
	const restoreVisibleTerminal = () => {
		scheduleFit();
		requestAnimationFrame(() => {
			if (terminal.rows > 0) {
				terminal.refresh(0, terminal.rows - 1);
			}
		});
	};

	terminal.onData((data) => {
		if (sessionId) {
			vscodeApi.postMessage({ type: 'terminal/input', payload: { sessionId, data } });
		}
	});
	terminal.onResize(({ cols, rows }) => {
		if (sessionId) {
			vscodeApi.postMessage({
				type: 'terminal/resize',
				payload: { sessionId, cols, rows },
			});
		}
	});

	const resizeObserver = new ResizeObserver(scheduleFit);
	resizeObserver.observe(elements.container);
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) {
			restoreVisibleTerminal();
		}
	});
	window.addEventListener('focus', restoreVisibleTerminal);

	elements.restartButton.addEventListener('click', () => {
		if (sessionId) {
			return;
		}

		fitTerminal();
		terminal.reset();
		showOverlay(elements, '기본 shell을 다시 시작하는 중입니다…', false);
		vscodeApi.postMessage({
			type: 'terminal/restart',
			payload: { cols: terminal.cols, rows: terminal.rows },
		});
	});

	window.addEventListener('message', (event: MessageEvent<unknown>) => {
		if (!isTerminalHostMessage(event.data)) {
			return;
		}

		const message = event.data;
		switch (message.type) {
			case 'terminal/starting':
				showOverlay(elements, `${message.payload.shellLabel} 시작 중…`, false);
				break;
			case 'terminal/started':
				sessionId = message.payload.sessionId;
				hideOverlay(elements);
				terminal.focus();
				break;
			case 'terminal/output':
				if (message.payload.sessionId === sessionId) {
					terminal.write(message.payload.data);
				}
				break;
			case 'terminal/exited':
				if (message.payload.sessionId === sessionId) {
					sessionId = undefined;
					const signal = message.payload.signal === undefined
						? ''
						: ` · signal ${message.payload.signal}`;
					showOverlay(
						elements,
						`Terminal이 종료되었습니다 · exit ${message.payload.exitCode}${signal}`,
						true,
					);
				}
				break;
			case 'terminal/error':
				if (!message.payload.sessionId || message.payload.sessionId === sessionId) {
					sessionId = undefined;
					showOverlay(
						elements,
						message.payload.message,
						message.payload.recoverable,
					);
				}
				break;
		}
	});

	window.addEventListener('beforeunload', () => {
		resizeObserver.disconnect();
		terminal.dispose();
	}, { once: true });

	fitTerminal();
	vscodeApi.postMessage({
		type: 'terminal/ready',
		payload: { cols: terminal.cols, rows: terminal.rows },
	});

	return { scheduleFit, restoreVisibleTerminal };
}

/**
 * terminal 위에 상태 메시지와 선택적인 Restart 동작을 표시한다.
 *
 * @param elements 상태를 표시할 terminal DOM 요소
 * @param message 사용자에게 보여줄 상태 또는 오류 메시지
 * @param restartAvailable Restart 버튼을 노출할지 여부
 */
function showOverlay(
	elements: ShellTerminalElements,
	message: string,
	restartAvailable: boolean,
): void {
	elements.status.textContent = message;
	elements.restartButton.hidden = !restartAvailable;
	elements.overlay.hidden = false;
}

/**
 * 실행 중인 terminal을 가리지 않도록 상태 overlay를 숨긴다.
 *
 * @param elements overlay를 숨길 terminal DOM 요소
 */
function hideOverlay(elements: ShellTerminalElements): void {
	elements.overlay.hidden = true;
	elements.restartButton.hidden = true;
}

/**
 * VS Code theme CSS 변수 값을 읽고 없으면 fallback을 반환한다.
 *
 * @param computed Webview body의 계산된 style
 * @param variable 조회할 VS Code CSS 변수명
 * @param fallback theme 변수가 없을 때 사용할 색상
 * @returns theme 값, fallback 또는 undefined
 */
function cssColor(
	computed: CSSStyleDeclaration,
	variable: string,
	fallback?: string,
): string | undefined {
	return computed.getPropertyValue(variable).trim() || fallback;
}
