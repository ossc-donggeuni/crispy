import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

/** Webview bundle에 포함되는 terminal UI runtime constructor다. */
export const WEBVIEW_TERMINAL_RUNTIME = Object.freeze({
	Terminal,
	FitAddon,
});

/**
 * xterm과 FitAddon이 Webview runtime에 실제로 연결되었는지 확인한다.
 * Terminal 인스턴스와 DOM은 이후 UI 단계에서 생성한다.
 */
export function assertWebviewTerminalRuntimeAvailable(): void {
	if (
		typeof WEBVIEW_TERMINAL_RUNTIME.Terminal !== 'function'
		|| typeof WEBVIEW_TERMINAL_RUNTIME.FitAddon !== 'function'
	) {
		throw new Error('Crispy terminal UI runtime is unavailable.');
	}
}
