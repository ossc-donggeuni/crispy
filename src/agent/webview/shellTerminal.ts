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

/** Shell 종료를 알리는 덮개 제목이며 종료 코드와 무관하게 동일하다. */
export const TERMINAL_EXITED_OVERLAY_TITLE = 'Terminal exited';

/** 시작 실패를 알리는 덮개 제목이며 실행 계약 정보를 포함하지 않는다. */
export const TERMINAL_START_FAILED_OVERLAY_TITLE = 'Unable to start terminal';

/** 재시작 요청 버튼에 표시하는 고정 문구다. */
export const TERMINAL_RESTART_BUTTON_LABEL = 'Restart';

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

type TerminalRestartMessage = Extract<
	WebviewToHostMessage,
	{ type: 'terminal.restart' }
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
	reset(): void;
	onData(listener: (data: string) => void): unknown;
	dispose(): void;
}

/**
 * 기존 Terminal buffer를 지우지 않고 그 위에 표시하는 세션 종료 상태다.
 * Host가 제공한 안전한 종료 정보와 고정 오류 메시지만 값으로 가진다.
 */
export type TerminalOverlayState =
	| {
		readonly kind: 'exited';
		readonly exitCode?: number;
		readonly signal?: number;
	}
	| {
		readonly kind: 'error';
		readonly message: string;
		readonly canRestart: boolean;
	};

/** 종료 및 오류 덮개 DOM을 교체 가능하게 감싸는 최소 표시 경계다. */
export interface TerminalOverlayView {
	/** 현재 Terminal buffer를 유지한 채 주어진 상태를 덮개로 표시한다. */
	show(state: TerminalOverlayState): void;

	/** 표시 중인 덮개를 숨기고 내용을 비운다. */
	hide(): void;
}

/** xterm 생성 순서와 실패 경로를 외부 영향 없이 검증하기 위한 의존성 경계다. */
export interface ShellTerminalDependencies {
	createTerminal(): XtermTerminal;
	createFitAddon(): FitAddon;
	createTabId(): TabId;
	createOverlayView(
		overlay: HTMLElement,
		onRestart: () => void,
	): TerminalOverlayView;
	requestAnimationFrame(callback: FrameRequestCallback): number;
	createResizeObserver(callback: ResizeObserverCallback): ResizeObserver;
	addWindowResizeListener(listener: () => void): () => void;
	addVisibilityChangeListener(listener: () => void): () => void;
	isDocumentHidden(): boolean;
}

/** 터미널 준비, 입력, 크기 변경과 재시작을 VS Code 웹뷰 메시지 경계로 전달하는 함수다. */
export type PostTerminalMessage = (
	message:
		| TerminalReadyMessage
		| TerminalInputMessage
		| TerminalResizeMessage
		| TerminalRestartMessage,
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

/**
 * VS Code가 Webview에 주입한 Terminal 색상을 xterm theme 속성에 연결한다.
 *
 * 테마 변수는 VS Code 버전에 따라 `body` 또는 `documentElement`에 주입된다.
 * CSS 변수는 아래로만 상속되므로 한쪽만 조회하면 값을 전부 놓치고 xterm 기본
 * 팔레트로 조용히 떨어질 수 있어, 두 요소를 순서대로 조회한다.
 *
 * @returns 찾은 색상만 채운 xterm theme이며 조회에 실패하면 빈 theme이다.
 */
export function readVsCodeAnsiTheme(): ITheme {
	try {
		const sources = [document.body, document.documentElement]
			.filter((element): element is HTMLElement => Boolean(element))
			.map((element) => getComputedStyle(element));
		const value = (name: string): string | undefined => {
			for (const source of sources) {
				const resolved = source.getPropertyValue(name).trim();
				if (resolved.length > 0) {
					return resolved;
				}
			}

			return undefined;
		};

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

/**
 * 종료 상태를 Host가 제공한 값만 사용하는 한 줄 설명으로 변환한다.
 * 실행 파일 경로, 환경 변수 또는 원본 예외는 어떤 상태에서도 포함하지 않는다.
 *
 * @param state 표시할 종료 또는 오류 상태
 * @returns 제목 아래에 표시할 설명 문자열이며 표시할 정보가 없으면 빈 문자열
 */
function describeTerminalOverlayState(state: TerminalOverlayState): string {
	if (state.kind === 'error') {
		return state.message;
	}

	const details: string[] = [];
	if (state.exitCode !== undefined) {
		details.push(`Exit code: ${state.exitCode}`);
	}
	if (state.signal !== undefined) {
		details.push(`Signal: ${state.signal}`);
	}

	return details.join('  ');
}

/**
 * Terminal 영역 안에서만 상태와 재시작 버튼을 표시하는 기본 덮개를 만든다.
 * 덮개는 xterm mount와 분리된 요소만 교체하므로 기존 buffer를 지우지 않는다.
 *
 * @param overlay 터미널 영역 안의 덮개 컨테이너
 * @param onRestart 재시작 버튼 클릭을 제어 객체로 전달하는 함수
 * @returns 상태 표시와 숨김만 노출하는 덮개 제어 객체
 */
function createDefaultOverlayView(
	overlay: HTMLElement,
	onRestart: () => void,
): TerminalOverlayView {
	const panel = document.createElement('div');
	panel.className = 'terminal-overlay-panel';

	const title = document.createElement('p');
	title.className = 'terminal-overlay-title';

	const detail = document.createElement('p');
	detail.className = 'terminal-overlay-detail';

	const restartButton = document.createElement('button');
	restartButton.type = 'button';
	restartButton.className = 'terminal-overlay-restart';
	restartButton.textContent = TERMINAL_RESTART_BUTTON_LABEL;
	restartButton.addEventListener('click', () => onRestart());

	panel.append(title, detail, restartButton);

	return {
		show(state): void {
			title.textContent = state.kind === 'exited'
				? TERMINAL_EXITED_OVERLAY_TITLE
				: TERMINAL_START_FAILED_OVERLAY_TITLE;
			detail.textContent = describeTerminalOverlayState(state);
			detail.hidden = detail.textContent.length === 0;
			restartButton.hidden = state.kind === 'error' && !state.canRestart;
			overlay.replaceChildren(panel);
			overlay.setAttribute('role', state.kind === 'error' ? 'alert' : 'status');
			overlay.hidden = false;
		},
		hide(): void {
			overlay.hidden = true;
			overlay.removeAttribute('role');
			overlay.replaceChildren();
		},
	};
}

/** 실제 xterm과 브라우저 API를 사용하는 기본 Terminal 의존성이다. */
export const defaultShellTerminalDependencies: ShellTerminalDependencies = {
	createTerminal: () => new Terminal({ theme: readVsCodeAnsiTheme() }),
	createFitAddon: () => new FitAddon(),
	createTabId: () => `tab-${globalThis.crypto.randomUUID()}`,
	createOverlayView: (overlay, onRestart) =>
		createDefaultOverlayView(overlay, onRestart),
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
 * 세션 종료와 시작 실패는 기존 buffer를 유지한 채 덮개로 표시하고 재시작 요청으로 연결한다.
 * 초기화 실패는 이 함수 안에서 고정된 화면 상태로 격리하고 호출자에게 전파하지 않는다.
 *
 * @param surface xterm 장착 영역과 상태 덮개를 포함하는 터미널 영역
 * @param mount xterm이 실제 DOM을 생성하는 컨테이너
 * @param overlay 터미널 영역 안에서만 상태를 표시하는 덮개
 * @param postMessage Terminal 메시지를 호스트로 보내는 웹뷰 API 경계
 * @param dependencies xterm, 탭 식별자와 상태 덮개를 생성하는 의존성
 * @returns 현재 탭과 세션의 소유 관계를 관리하는 제어 객체
 */
export function initializeShellTerminal(
	surface: HTMLElement,
	mount: HTMLElement,
	overlay: HTMLElement,
	postMessage: PostTerminalMessage,
	dependencies: ShellTerminalDependencies = defaultShellTerminalDependencies,
): ShellTerminalController {
	const tabId = dependencies.createTabId();
	let activeSessionId: SessionId | undefined;
	let sessionEverStarted = false;
	let restartSessionId: SessionId | undefined;
	let restartRequested = false;
	let overlayVisible = false;
	let terminal: XtermTerminal | undefined;
	let overlayView: TerminalOverlayView | undefined;
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
						lastSentDimensions?.cols === cols
						&& lastSentDimensions?.rows === rows
					) {
						return;
					}

					if (activeSessionId !== undefined) {
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
						return;
					}

					/*
					 * 아직 첫 세션이 시작되지 않은 탭은 provider 선택 전에 크기가 바뀔 수 있다.
					 * 이때만 준비 신호를 다시 보내 Host가 최신 크기로 PTY를 시작하게 한다.
					 * 세션이 한 번이라도 시작된 뒤에는 종료 상태에서 다시 보내지 않으므로
					 * 사용자가 재시작을 요청하지 않은 세션이 저절로 살아나지 않는다.
					 */
					if (!sessionEverStarted) {
						postReady(cols, rows);
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

	/**
	 * 기존 Terminal buffer를 유지한 채 종료 또는 오류 상태를 덮개로 표시한다.
	 * 표시 실패는 Terminal 영역 밖의 Webview 기능으로 전파하지 않는다.
	 */
	const showOverlay = (state: TerminalOverlayState): void => {
		if (disposed) {
			return;
		}

		try {
			overlayView?.show(state);
			overlayVisible = true;
			surface.dataset.state = state.kind === 'exited' ? 'exited' : 'error';
		} catch {
			// 덮개 렌더링 실패가 Graph, Dock, Drag Resize로 전파되지 않게 한다.
		}
	};

	/** 새 PTY가 시작된 뒤에만 호출해 덮개를 제거하고 준비 상태로 되돌린다. */
	const hideOverlay = (): void => {
		try {
			overlayView?.hide();
		} catch {
			// 덮개 제거 실패도 이미 시작된 PTY의 입출력 경로에 영향을 주지 않는다.
		}
		overlayVisible = false;
		surface.dataset.state = 'ready';
	};

	/**
	 * 재시작 버튼 클릭을 소유 관계만 담은 호스트 요청으로 변환한다.
	 * 실행 계약과 terminal 크기는 Host가 다시 결정하므로 전송하지 않으며,
	 * 세션이 만들어지기 전에 실패한 경우에만 최초 시작 경로를 다시 사용한다.
	 */
	const requestRestart = (): void => {
		if (disposed || restartRequested) {
			return;
		}

		restartRequested = true;
		const sessionId = restartSessionId;
		if (sessionId === undefined) {
			postReady(
				lastSentDimensions?.cols ?? TERMINAL_INITIAL_FALLBACK_DIMENSIONS.cols,
				lastSentDimensions?.rows ?? TERMINAL_INITIAL_FALLBACK_DIMENSIONS.rows,
			);
			return;
		}

		try {
			postMessage({ type: 'terminal.restart', tabId, sessionId });
		} catch {
			// 재시작 전송 실패 뒤에도 사용자가 같은 덮개에서 다시 시도할 수 있게 한다.
			restartRequested = false;
		}
	};

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
		overlayView = undefined;
	};

	const controller: ShellTerminalController = {
		tabId,
		scheduleTerminalFit,
		dispose,
		handleHostMessage(message): void {
			switch (message.type) {
				case 'terminal.started':
					if (message.tabId === tabId) {
						const replacedSessionId = activeSessionId;
						activeSessionId = message.sessionId;
						restartSessionId = undefined;
						restartRequested = false;
						/*
						 * 이전 세션이 있었다면 provider 전환처럼 종료 덮개를 거치지 않은
						 * 교체일 수 있으므로, 새 PTY 시작을 확인한 뒤 buffer를 정리한다.
						 */
						if (
							overlayVisible
							|| (
								replacedSessionId !== undefined
								&& replacedSessionId !== message.sessionId
							)
						) {
							try {
								terminal?.reset();
							} catch {
								// Buffer 초기화 실패가 새 세션 입출력 연결을 막지 않게 한다.
							}
						}
						if (overlayVisible) {
							hideOverlay();
						}
						sessionEverStarted = true;
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
						restartSessionId = message.sessionId;
						restartRequested = false;
						showOverlay({
							kind: 'exited',
							...(message.exitCode === undefined
								? {}
								: { exitCode: message.exitCode }),
							...(message.signal === undefined
								? {}
								: { signal: message.signal }),
						});
					}
					break;
				case 'terminal.error':
					/* 현재 세션이 없을 때만 Host가 새로 만든 세션의 시작 실패를 받아들인다. */
					if (
						message.tabId !== tabId
						|| (
							activeSessionId !== undefined
							&& message.sessionId !== activeSessionId
						)
					) {
						return;
					}

					activeSessionId = undefined;
					restartSessionId = message.sessionId ?? undefined;
					restartRequested = false;
					showOverlay({
						kind: 'error',
						message: message.message,
						canRestart: message.canRestart,
					});
					break;
			}
		},
	};

	try {
		overlayView = dependencies.createOverlayView(overlay, requestRestart);
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
		overlayView = undefined;
		overlayVisible = false;
	}

	return controller;
}
