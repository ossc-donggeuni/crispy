import * as assert from 'assert';
import {
	isTerminalHostMessage,
	isTerminalWebviewMessage,
} from '../protocol';
import { TERMINAL_POLICY } from '../policy';

/**
 * Host와 Webview 사이 메시지 allowlist, exact key 및 제한값 검증을 확인한다.
 */
suite('Agent Terminal Protocol', () => {
	test('ready, input, resize, restart allowlist를 허용한다', () => {
		assert.strictEqual(isTerminalWebviewMessage({
			type: 'terminal/ready',
			payload: { cols: 80, rows: 24 },
		}), true);
		assert.strictEqual(isTerminalWebviewMessage({
			type: 'terminal/input',
			payload: { sessionId: 'session-1', data: '한글\r' },
		}), true);
		assert.strictEqual(isTerminalWebviewMessage({
			type: 'terminal/resize',
			payload: { sessionId: 'session-1', cols: 120, rows: 40 },
		}), true);
		assert.strictEqual(isTerminalWebviewMessage({
			type: 'terminal/restart',
			payload: { cols: 80, rows: 24 },
		}), true);
	});

	test('Webview가 executable, args, cwd 또는 알려지지 않은 필드를 전달하면 거부한다', () => {
		const rejected: unknown[] = [
			{
				type: 'terminal/ready',
				payload: { cols: 80, rows: 24, executable: '/bin/sh' },
			},
			{
				type: 'terminal/restart',
				payload: { cols: 80, rows: 24, args: ['--login'] },
			},
			{
				type: 'terminal/resize',
				payload: { sessionId: 'session-1', cols: 80, rows: 24, cwd: '/tmp' },
			},
			{ type: 'session/start', payload: { executable: '/bin/sh' } },
		];

		for (const message of rejected) {
			assert.strictEqual(isTerminalWebviewMessage(message), false);
		}
	});

	test('dimension, ID, UTF-8 input byte 제한을 적용한다', () => {
		assert.strictEqual(isTerminalWebviewMessage({
			type: 'terminal/ready',
			payload: { cols: 0, rows: 24 },
		}), false);
		assert.strictEqual(isTerminalWebviewMessage({
			type: 'terminal/input',
			payload: {
				sessionId: 'x'.repeat(TERMINAL_POLICY.maxSessionIdLength + 1),
				data: '',
			},
		}), false);
		assert.strictEqual(isTerminalWebviewMessage({
			type: 'terminal/input',
			payload: {
				sessionId: 'session-1',
				data: '😀'.repeat(TERMINAL_POLICY.maxInputBytes / 4 + 1),
			},
		}), false);
	});

	test('Host 메시지도 exact contract로 검증한다', () => {
		assert.strictEqual(isTerminalHostMessage({
			type: 'terminal/started',
			payload: { sessionId: 'session-1', cwd: '/workspace', shellLabel: 'zsh' },
		}), true);
		assert.strictEqual(isTerminalHostMessage({
			type: 'terminal/output',
			payload: { sessionId: 'session-1', data: 'secret', extra: true },
		}), false);
	});
});
