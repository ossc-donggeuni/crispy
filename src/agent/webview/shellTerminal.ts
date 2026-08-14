import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import type {
	HostToWebviewMessage,
	SessionId,
	TabId,
	WebviewToHostMessage,
} from '../protocol';

/** xterm 초기화 실패 시 원본 예외 대신 터미널 영역에 표시하는 고정 문구다. */
export const TERMINAL_INITIALIZATION_ERROR_MESSAGE =
	'Terminal could not be initialized.';

type TerminalInputMessage = Extract<
	WebviewToHostMessage,
	{ type: 'terminal.input' }
>;

type TerminalReadyMessage = Extract<
	WebviewToHostMessage,
	{ type: 'terminal.ready' }
>;

type TerminalResizeMessage = Extract<
	WebviewToHostMessage,
	{ type: 'terminal.resize' }
>;

/** 초기 layout을 기다리는 최대 animation frame 수다. */
export const TERMINAL_INITIAL_FIT_MAX_FRAMES = 20;

/** 숨겨진 Terminal surface도 PTY 시작을 막지 않는 초기 크기다. */
export const TERMINAL_INITIAL_FALLBACK_DIMENSIONS = Object.freeze({
	cols: 80,
	rows: 24,
});

/** 실제 xterm과 테스트 대역이 함께 구현하는 최소 터미널 경계다. */
interface XtermTerminal {
	loadAddon(addon: FitAddon): void;
	open(container: HTMLElement): void;
	focus(): void;
	write(data: string): void;
	onData(listener: (data: string) => void): unknown;
	dispose(): void;
}

/** xterm 생성 순서와 실패 경로를 외부 영향 없이 검증하기 위한 의존성 경계다. */
export interface ShellTerminalDependencies {
	createTerminal(): XtermTerminal;
	createFitAddon(): FitAddon;
	createTabId(): TabId;
	requestAnimationFrame(callback: FrameRequestCallback): number;
	createResizeObserver(callback: ResizeObserverCallback): ResizeObserver;
	addWindowResizeListener(listener: () => void): () => void;
	addVisibilityChangeListener(listener: () => void): () => void;
	isDocumentHidden(): boolean;
}

/** 터미널 준비, 입력과 크기 변경을 VS Code 웹뷰 메시지 경계로 전달하는 함수다. */
export type PostTerminalMessage = (
	message: TerminalReadyMessage | TerminalInputMessage | TerminalResizeMessage,
) => void;

/** 웹뷰 진입점이 터미널 세션 메시지를 전달하는 데 사용하는 최소 제어 경계다. */
export interface ShellTerminalController {
	/** 웹뷰가 생성하고 후속 `terminal.ready` 메시지에서 재사용할 탭 식별자다. */
	readonly tabId: TabId;

	/** 검증된 호스트 메시지를 현재 탭 및 세션과 대조해 처리한다. */
	handleHostMessage(message: HostToWebviewMessage): void;

	/** 다음 animation frame에 Terminal fit을 예약한다. */
	scheduleTerminalFit(): void;

	/** Terminal과 resize 관찰자를 정리한다. */
	dispose(): void;
}

/** VS Code가 Webview에 주입한 Terminal 색상을 xterm theme 속성에 연결한다. */
export function readVsCodeAnsiTheme(): ITheme {
	try {
		const css = getComputedStyle(document.documentElement);
		const value = (name: string): string | undefined =>
			css.getPropertyValue(name).trim() || undefined;

		return {
			background: value('--vscode-terminal-background'),
			foreground: value('--vscode-terminal-foreground'),
			cursor: value('--vscode-terminalCursor-foreground'),
			cursorAccent: value('--vscode-terminalCursor-background'),
			selectionBackground: value('--vscode-terminal-selectionBackground'),
			black: value('--vscode-terminal-ansiBlack'),
			red: value('--vscode-terminal-ansiRed'),
			green: value('--vscode-terminal-ansiGreen'),
			yellow: value('--vscode-terminal-ansiYellow'),
			blue: value('--vscode-terminal-ansiBlue'),
			magenta: value('--vscode-terminal-ansiMagenta'),
			cyan: value('--vscode-terminal-ansiCyan'),
			white: value('--vscode-terminal-ansiWhite'),
			brightBlack: value('--vscode-terminal-ansiBrightBlack'),
			brightRed: value('--vscode-terminal-ansiBrightRed'),
			brightGreen: value('--vscode-terminal-ansiBrightGreen'),
			brightYellow: value('--vscode-terminal-ansiBrightYellow'),
			brightBlue: value('--vscode-terminal-ansiBrightBlue'),
			brightMagenta: value('--vscode-terminal-ansiBrightMagenta'),
			brightCyan: value('--vscode-terminal-ansiBrightCyan'),
			brightWhite: value('--vscode-terminal-ansiBrightWhite'),
		};
	} catch {
		return {};
	}
}

const defaultDependencies: ShellTerminalDependencies = {
	createTerminal: () => new Terminal({ theme: readVsCodeAnsiTheme() }),
	createFitAddon: () => new FitAddon(),
	createTabId: () => `tab-${globalThis.crypto.randomUUID()}`,
	requestAnimationFrame: (callback) => globalThis.requestAnimationFrame(callback),
	createResizeObserver: (callback) => new ResizeObserver(callback),
	addWindowResizeListener: (listener) => {
		window.addEventListener('resize', listener);
		return () => window.removeEventListener('resize', listener);
	},
	addVisibilityChangeListener: (listener) => {
		document.addEventListener('visibilitychange', listener);
		return () => document.removeEventListener('visibilitychange', listener);
	},
	isDocumentHidden: () => document.hidden,
};

/**
 * xterm을 터미널 영역에 장착하고 기존 터미널 입출력 프로토콜에 연결한다.
 * 초기화 실패는 이 함수 안에서 고정된 화면 상태로 격리하고 호출자에게 전파하지 않는다.
 *
 * @param surface xterm 장착 영역과 상태 덮개를 포함하는 터미널 영역
 * @param mount xterm이 실제 DOM을 생성하는 컨테이너
 * @param overlay 터미널 영역 안에서만 상태를 표시하는 덮개
 * @param postMessage Terminal 메시지를 호스트로 보내는 웹뷰 API 경계
 * @param dependencies xterm과 탭 식별자를 생성하는 의존성
 * @returns 현재 탭과 세션의 소유 관계를 관리하는 제어 객체
 */
export function initializeShellTerminal(
	surface: HTMLElement,
	mount: HTMLElement,
	overlay: HTMLElement,
	postMessage: PostTerminalMessage,
	dependencies: ShellTerminalDependencies = defaultDependencies,
): ShellTerminalController {
	const tabId = dependencies.createTabId();
	let activeSessionId: SessionId | undefined;
	let terminal: XtermTerminal | undefined;
	let fitAddon: FitAddon | undefined;
	let resizeObserver: ResizeObserver | undefined;
	let removeWindowResizeListener: (() => void) | undefined;
	let removeVisibilityChangeListener: (() => void) | undefined;
	let fitScheduled = false;
	let disposed = false;
	let readySent = false;
	let attemptedFrames = 0;
	let lastSentDimensions: { cols: number; rows: number } | undefined;

	/**
	 * 모든 layout 및 visibility 이벤트를 한 animation frame으로 병합해 xterm을 맞춘다.
	 * fit, 측정 또는 전송 실패는 Terminal 경계 안에 격리한다.
	 */
	function scheduleTerminalFit(): void {
		if (disposed || fitScheduled || terminal === undefined || fitAddon === undefined) {
			return;
		}

		fitScheduled = true;
		try {
			dependencies.requestAnimationFrame(() => {
				fitScheduled = false;
				if (disposed || terminal === undefined || fitAddon === undefined) {
					return;
				}

				if (!readySent) {
					attemptedFrames += 1;
				}

				let dimensions: ReturnType<FitAddon['proposeDimensions']>;
				try {
					const isHidden = dependencies.isDocumentHidden()
						|| surface.hidden
						|| mount.hidden
						|| mount.clientWidth <= 0
						|| mount.clientHeight <= 0;

					if (!isHidden) {
						fitAddon.fit();
						dimensions = fitAddon.proposeDimensions();
					}
				} catch {
					dimensions = undefined;
				}

				if (
					dimensions !== undefined
					&& Number.isInteger(dimensions.cols)
					&& Number.isInteger(dimensions.rows)
					&& dimensions.cols > 0
					&& dimensions.rows > 0
				) {
					const { cols, rows } = dimensions;
					if (!readySent) {
						postReady(cols, rows);
						return;
					}

					if (
						activeSessionId !== undefined
						&& (lastSentDimensions?.cols !== cols
							|| lastSentDimensions?.rows !== rows)
					) {
						try {
							postMessage({
								type: 'terminal.resize',
								tabId,
								sessionId: activeSessionId,
								cols,
								rows,
							});
							lastSentDimensions = { cols, rows };
						} catch {
							// Resize 전송 실패가 Graph, Dock, Drag Resize로 전파되지 않게 한다.
						}
					}
					return;
				}

				if (!readySent) {
					if (attemptedFrames >= TERMINAL_INITIAL_FIT_MAX_FRAMES) {
						postReady(
							TERMINAL_INITIAL_FALLBACK_DIMENSIONS.cols,
							TERMINAL_INITIAL_FALLBACK_DIMENSIONS.rows,
						);
						return;
					}

					scheduleTerminalFit();
				}
			});
		} catch {
			fitScheduled = false;
			// animation frame 예약 실패도 다른 Webview 기능으로 전파하지 않는다.
		}
	}

	const postReady = (cols: number, rows: number): void => {
		readySent = true;
		try {
			postMessage({
				type: 'terminal.ready',
				tabId,
				cols,
				rows,
			});
			lastSentDimensions = { cols, rows };
		} catch {
			// Ready 전송 실패가 Graph나 다른 Webview 기능으로 전파되지 않게 한다.
		}
	};

	const dispose = (): void => {
		if (disposed) {
			return;
		}

		disposed = true;
		const cleanupActions = [
			() => resizeObserver?.disconnect(),
			() => removeWindowResizeListener?.(),
			() => removeVisibilityChangeListener?.(),
			() => terminal?.dispose(),
		];
		for (const cleanup of cleanupActions) {
			try {
				cleanup();
			} catch {
				// 한 정리 실패가 나머지 Terminal 및 Webview 정리를 막지 않게 한다.
			}
		}
		terminal = undefined;
		fitAddon = undefined;
	};

	const controller: ShellTerminalController = {
		tabId,
		scheduleTerminalFit,
		dispose,
		handleHostMessage(message): void {
			switch (message.type) {
				case 'terminal.started':
					if (message.tabId === tabId) {
						activeSessionId = message.sessionId;
						try {
							terminal?.focus();
						} catch {
							// Focus 실패는 이미 시작된 PTY의 입출력 경로에 영향을 주지 않는다.
						}
						scheduleTerminalFit();
					}
					break;
				case 'terminal.output':
					if (
						message.tabId !== tabId
						|| message.sessionId !== activeSessionId
						|| terminal === undefined
					) {
						return;
					}

					try {
						terminal.write(message.data);
					} catch {
						// Terminal 렌더링 오류를 다른 Webview 기능으로 전파하지 않는다.
					}
					break;
				case 'terminal.exited':
					if (
						message.tabId === tabId
						&& message.sessionId === activeSessionId
					) {
						activeSessionId = undefined;
					}
					break;
				case 'terminal.error':
					if (
						message.tabId === tabId
						&& message.sessionId === activeSessionId
					) {
						activeSessionId = undefined;
					}
					break;
			}
		},
	};

	try {
		terminal = dependencies.createTerminal();
		fitAddon = dependencies.createFitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(mount);
		terminal.onData((data) => {
			if (activeSessionId === undefined) {
				return;
			}

			try {
				postMessage({
					type: 'terminal.input',
					tabId,
					sessionId: activeSessionId,
					data,
				});
			} catch {
				// Webview 전송 실패가 xterm 입력 처리나 Graph 기능으로 전파되지 않게 한다.
			}
		});

		resizeObserver = dependencies.createResizeObserver(scheduleTerminalFit);
		resizeObserver.observe(mount);
		removeWindowResizeListener = dependencies.addWindowResizeListener(
			scheduleTerminalFit,
		);
		removeVisibilityChangeListener = dependencies.addVisibilityChangeListener(
			scheduleTerminalFit,
		);
		scheduleTerminalFit();
	} catch {
		dispose();
		mount.replaceChildren();
		surface.dataset.state = 'error';
		overlay.textContent = TERMINAL_INITIALIZATION_ERROR_MESSAGE;
		overlay.hidden = false;
		overlay.setAttribute('role', 'alert');
	}

	return controller;
}
