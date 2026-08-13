import * as assert from 'assert';
import { resolveTerminalWorkspace } from '../workspace';

/**
 * trusted 단일 file workspace만 terminal root로 허용하는 정책을 검증한다.
 */
suite('Agent Terminal Workspace', () => {
	test('하나의 trusted file workspace root만 허용한다', () => {
		assert.deepStrictEqual(resolveTerminalWorkspace(true, [{
			uri: { scheme: 'file', fsPath: '/work space/한글' },
		}]), { ok: true, rootPath: '/work space/한글' });
	});

	test('untrusted, multi-root, virtual workspace를 명확히 거부한다', () => {
		assert.strictEqual(resolveTerminalWorkspace(false, [{
			uri: { scheme: 'file', fsPath: '/workspace' },
		}]).ok, false);
		assert.strictEqual(resolveTerminalWorkspace(true, []).ok, false);
		assert.strictEqual(resolveTerminalWorkspace(true, [
			{ uri: { scheme: 'file', fsPath: '/one' } },
			{ uri: { scheme: 'file', fsPath: '/two' } },
		]).ok, false);
		assert.strictEqual(resolveTerminalWorkspace(true, [{
			uri: { scheme: 'vscode-remote', fsPath: '/workspace' },
		}]).ok, false);
	});
});
