import * as assert from 'assert';
import {
	HOST_TERMINAL_RUNTIME,
	assertHostTerminalRuntimeAvailable,
} from '../agent/host/runtimeDependencies';
import {
	WEBVIEW_TERMINAL_RUNTIME,
	assertWebviewTerminalRuntimeAvailable,
} from '../agent/webview/runtimeDependencies';

suite('Terminal runtime dependency wiring', () => {
	test('Extension Host가 현재 플랫폼의 node-pty runtime을 로드한다', () => {
		assert.doesNotThrow(assertHostTerminalRuntimeAvailable);
		assert.strictEqual(typeof HOST_TERMINAL_RUNTIME.spawn, 'function');
	});

	test('Webview bundle entry가 xterm과 FitAddon constructor를 로드한다', () => {
		assert.doesNotThrow(assertWebviewTerminalRuntimeAvailable);
		assert.strictEqual(typeof WEBVIEW_TERMINAL_RUNTIME.Terminal, 'function');
		assert.strictEqual(typeof WEBVIEW_TERMINAL_RUNTIME.FitAddon, 'function');
	});
});
