import * as assert from 'node:assert/strict';
import {
	PATH_MAX_SEGMENTS,
	PATH_MAX_UTF8_BYTES,
	isCanonicalAgentActivityPath,
	normalizeAgentActivityPath,
} from '../../mcp/agentActivityProtocol';

suite('MCP Agent Activity lexical path protocol', () => {
	test('POSIX/Windows absolute, drive-relative, rooted, UNC, device와 URI path를 거부한다', () => {
		for (const invalidPath of [
			'/workspace/src/file.ts',
			'C:/workspace/file.ts',
			'c:\\workspace\\file.ts',
			'D:relative\\file.ts',
			'\\rooted\\file.ts',
			'\\\\server\\share\\file.ts',
			'\\\\?\\C:\\workspace\\file.ts',
			'\\\\.\\NUL',
			'\\??\\C:\\workspace\\file.ts',
			'file:///workspace/file.ts',
			'https://example.invalid/file.ts',
			'vscode-remote://ssh-remote+host/workspace/file.ts',
		]) {
			assert.deepStrictEqual(
				normalizeAgentActivityPath(invalidPath, 'file'),
				{ ok: false, error: 'invalid_path' },
				invalidPath,
			);
		}
	});

	test('Windows DOS reserved device basename을 모든 component와 extension에서 거부한다', () => {
		for (const path of [
			'NUL',
			'devices/CON',
			'devices/prn.txt',
			'devices/AUX.log',
			'devices/COM1.json',
			'devices/com9:stream',
			'devices/LPT1',
			'devices/lpt9.txt',
			'devices/COM¹.txt',
			'devices/com²',
			'devices/LPT³.log',
			'devices/NUL .txt',
			'CONIN$',
			'devices/conout$',
			'nested/devices/CONIN$.txt',
			'nested/devices/conout$:stream',
		]) {
			assert.deepStrictEqual(
				normalizeAgentActivityPath(path, 'file', 'win32'),
				{ ok: false, error: 'invalid_path' },
				path,
			);
			assert.strictEqual(
				isCanonicalAgentActivityPath(path, 'file', 'win32'),
				false,
				path,
			);
		}
	});

	test('POSIX에서는 DOS device와 같은 합법적인 filename을 변경하지 않는다', () => {
		for (const path of [
			'NUL',
			'devices/CON',
			'devices/COM1.txt',
			'devices/LPT³.log',
			'CONIN$',
			'devices/conout$.txt',
			'nested/devices/CONIN$:stream',
		]) {
			assert.deepStrictEqual(
				normalizeAgentActivityPath(path, 'file', 'linux'),
				{ ok: true, path },
			);
			assert.strictEqual(
				isCanonicalAgentActivityPath(path, 'file', 'linux'),
				true,
			);
		}
	});

	test('traversal과 canonicalization 뒤 드러나는 drive/URI prefix를 거부한다', () => {
		for (const invalidPath of [
			'../file.ts',
			'src/../file.ts',
			'src\\..\\file.ts',
			'./C:/workspace/file.ts',
			'.\\C:\\workspace\\file.ts',
			'./https://example.invalid/file.ts',
			'.\\file:\\workspace\\file.ts',
		]) {
			assert.deepStrictEqual(
				normalizeAgentActivityPath(invalidPath, 'file'),
				{ ok: false, error: 'invalid_path' },
				invalidPath,
			);
		}
	});

	test('duplicate separator와 dot segment를 제거하고 canonical path는 idempotent다', () => {
		for (const [rawPath, expectedPath] of [
			['src//./mcp\\./toolServer.ts', 'src/mcp/toolServer.ts'],
			['./src///mcp/./protocolServer.ts/.', 'src/mcp/protocolServer.ts'],
			['folder\\nested//file.ts', 'folder/nested/file.ts'],
		] as const) {
			const normalized = normalizeAgentActivityPath(rawPath, 'file');
			assert.deepStrictEqual(normalized, { ok: true, path: expectedPath });
			assert.deepStrictEqual(
				normalizeAgentActivityPath(expectedPath, 'file'),
				normalized,
			);
			assert.strictEqual(isCanonicalAgentActivityPath(expectedPath, 'file'), true);
			assert.strictEqual(
				isCanonicalAgentActivityPath(rawPath, 'file'),
				false,
			);
		}
	});

	test('raw/canonical UTF-8 byte 상한 4096/4097과 multibyte 경계를 지킨다', () => {
		const asciiAtLimit = 'a'.repeat(PATH_MAX_UTF8_BYTES);
		const asciiOverLimit = `${asciiAtLimit}a`;
		const multibyteAtLimit = `${'한'.repeat(1_365)}a`;
		const multibyteOverLimit = `${multibyteAtLimit}a`;

		assert.strictEqual(Buffer.byteLength(asciiAtLimit, 'utf8'), 4_096);
		assert.strictEqual(Buffer.byteLength(asciiOverLimit, 'utf8'), 4_097);
		assert.strictEqual(Buffer.byteLength(multibyteAtLimit, 'utf8'), 4_096);
		assert.strictEqual(Buffer.byteLength(multibyteOverLimit, 'utf8'), 4_097);

		for (const path of [asciiAtLimit, multibyteAtLimit]) {
			assert.deepStrictEqual(
				normalizeAgentActivityPath(path, 'file'),
				{ ok: true, path },
			);
			assert.strictEqual(isCanonicalAgentActivityPath(path, 'file'), true);
		}
		for (const path of [asciiOverLimit, multibyteOverLimit]) {
			assert.deepStrictEqual(
				normalizeAgentActivityPath(path, 'file'),
				{ ok: false, error: 'payload_too_large' },
			);
			assert.strictEqual(isCanonicalAgentActivityPath(path, 'file'), false);
		}
	});

	test('canonical segment 상한 256/257을 지킨다', () => {
		const atLimit = Array.from(
			{ length: PATH_MAX_SEGMENTS },
			(_value, index) => `s${index}`,
		).join('/');
		const overLimit = `${atLimit}/overflow`;

		assert.strictEqual(atLimit.split('/').length, 256);
		assert.strictEqual(overLimit.split('/').length, 257);
		assert.deepStrictEqual(
			normalizeAgentActivityPath(atLimit, 'folder'),
			{ ok: true, path: atLimit },
		);
		assert.deepStrictEqual(
			normalizeAgentActivityPath(overLimit, 'folder'),
			{ ok: false, error: 'payload_too_large' },
		);
	});

	test('Workspace root의 유일한 canonical path는 folder `.`이다', () => {
		for (const rawPath of ['.', './', '././', '.\\.']) {
			assert.deepStrictEqual(
				normalizeAgentActivityPath(rawPath, 'folder'),
				{ ok: true, path: '.' },
			);
		}
		assert.deepStrictEqual(
			normalizeAgentActivityPath('.', 'file'),
			{ ok: false, error: 'invalid_path' },
		);
		assert.strictEqual(isCanonicalAgentActivityPath('.', 'folder'), true);
		assert.strictEqual(isCanonicalAgentActivityPath('.', 'file'), false);
	});

	test('trim/decode/Unicode normalization/case folding/tilde/env expansion을 하지 않는다', () => {
		const nfc = '\u00e9';
		const nfd = 'e\u0301';
		const cases = [
			'  spaced folder / file.ts  ',
			'%2e%2e/%2F/%5C/file.ts',
			'SRC/MixedCase/File.TS',
			'~/src/$HOME/${USER}/%USER%/file.ts',
			nfc,
			nfd,
		] as const;

		for (const path of cases) {
			assert.deepStrictEqual(
				normalizeAgentActivityPath(path, 'file'),
				{ ok: true, path },
			);
		}
		assert.notStrictEqual(nfc, nfd);
		const normalizedNfc = normalizeAgentActivityPath(nfc, 'file');
		const normalizedNfd = normalizeAgentActivityPath(nfd, 'file');
		assert.ok(normalizedNfc.ok);
		assert.ok(normalizedNfd.ok);
		assert.notStrictEqual(normalizedNfc.path, normalizedNfd.path);
	});

	test('empty path와 NUL은 canonical root로 보정하지 않고 거부한다', () => {
		for (const invalidPath of ['', 'src/\0/file.ts']) {
			assert.deepStrictEqual(
				normalizeAgentActivityPath(invalidPath, 'file'),
				{ ok: false, error: 'invalid_path' },
			);
		}
	});
});
