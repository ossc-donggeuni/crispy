import * as assert from 'assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Webview 산출물에 xterm 스타일과 기존 Crispy Grid 스타일이 함께 포함되는지 검증한다.
 */
suite('Agent Terminal Webview Bundle', () => {
	test('xterm과 Crispy Grid layout CSS를 하나의 Webview stylesheet에 포함한다', async () => {
		const stylesheet = await readFile(
			resolve(process.cwd(), 'dist', 'webview', 'webview.css'),
			'utf8',
		);

		for (const selector of [
			'.xterm',
			'.crispy-layout',
			'#graph-area',
			'#agent-chat-area',
			'#terminal-shell',
			'#terminal-overlay',
		]) {
			assert.ok(stylesheet.includes(selector), `Missing bundled selector: ${selector}`);
		}
	});
});
