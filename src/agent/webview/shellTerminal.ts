import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
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

/** 실제 xterm과 테스트 대역이 함께 구현하는 최소 터미널 경계다. */
interface XtermTerminal {
	loadAddon(addon: FitAddon): void;
	open(container: HTMLElement): void;
	write(data: string): void;
	onData(listener: (data: string) => void): unknown;
	dispose(): void;
}

/** xterm 생성 순서와 실패 경로를 외부 영향 없이 검증하기 위한 의존성 경계다. */
export interface ShellTerminalDependencies {
	createTerminal(): XtermTerminal;
	createFitAddon(): FitAddon;
	createTabId(): TabId;
}

/** 터미널 입력을 VS Code 웹뷰 메시지 경계로 전달하는 함수다. */
export type PostTerminalMessage = (message: TerminalInputMessage) => void;

/** 웹뷰 진입점이 터미널 세션 메시지를 전달하는 데 사용하는 최소 제어 경계다. */
export interface ShellTerminalController {
	/** 웹뷰가 생성하고 후속 `terminal.ready` 메시지에서 재사용할 탭 식별자다. */
	readonly tabId: TabId;

	/** 검증된 호스트 메시지를 현재 탭 및 세션과 대조해 처리한다. */
	handleHostMessage(message: HostToWebviewMessage): void;
}

const defaultDependencies: ShellTerminalDependencies = {
	createTerminal: () => new Terminal(),
	createFitAddon: () => new FitAddon(),
	createTabId: () => `tab-${globalThis.crypto.randomUUID()}`,
};

/**
 * xterm을 터미널 영역에 장착하고 기존 터미널 입출력 프로토콜에 연결한다.
 * 초기화 실패는 이 함수 안에서 고정된 화면 상태로 격리하고 호출자에게 전파하지 않는다.
 *
 * @param surface xterm 장착 영역과 상태 덮개를 포함하는 터미널 영역
 * @param mount xterm이 실제 DOM을 생성하는 컨테이너
 * @param overlay 터미널 영역 안에서만 상태를 표시하는 덮개
 * @param postMessage `terminal.input` 메시지를 호스트로 보내는 웹뷰 API 경계
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

	const controller: ShellTerminalController = {
		tabId,
		handleHostMessage(message): void {
			switch (message.type) {
				case 'terminal.started':
					if (message.tabId === tabId) {
						activeSessionId = message.sessionId;
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
			}
		},
	};

	try {
		terminal = dependencies.createTerminal();
		const fitAddon = dependencies.createFitAddon();
		terminal.loadAddon(fitAddon);
		terminal.open(mount);
		fitAddon.fit();
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
	} catch {
		try {
			terminal?.dispose();
		} catch {
			// 부분 초기화된 xterm의 정리 실패도 Terminal surface 안에 격리한다.
		}
		terminal = undefined;
		mount.replaceChildren();
		surface.dataset.state = 'error';
		overlay.textContent = TERMINAL_INITIALIZATION_ERROR_MESSAGE;
		overlay.hidden = false;
		overlay.setAttribute('role', 'alert');
	}

	return controller;
}
