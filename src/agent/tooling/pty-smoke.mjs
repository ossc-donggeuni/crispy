/** 통합 smoke test mjs */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const fixture = fileURLToPath(new URL('../fixtures/terminal-fixture.mjs', import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'crispy-terminal-'));
const cwd = join(temporaryRoot, '공백 포함 한글 workspace');
await mkdir(cwd);
const resolvedCwd = await realpath(cwd);

let child;
let output = '';
/**
 * 실제 node-pty에서 terminal fixture를 실행하고 입출력·화면 capability·Unicode cwd를 검증한다.
 */
try {
  child = pty.spawn(process.execPath, [fixture], {
    name: 'xterm-256color',
    cwd,
    cols: 80,
    rows: 24,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });

  await new Promise((resolve, reject) => {
    let unicodeSent = false;
    let resizeSent = false;
    let ctrlCSent = false;
    const timeout = setTimeout(() => {
      reject(new Error(`PTY smoke test timed out. Output: ${JSON.stringify(output)}`));
    }, 10_000);

    child.onData((data) => {
      output += data;
      if (output.includes('READY 80x24') && !unicodeSent) {
        unicodeSent = true;
        child.write('한글😀\r');
      }
      if (output.includes('UNICODE_INPUT_OK 한글 😀') && !resizeSent) {
        resizeSent = true;
        child.resize(100, 40);
        setTimeout(() => child.write('SIZE\r'), 100);
      }
      if (output.includes('SIZE 100x40') && !ctrlCSent) {
        ctrlCSent = true;
        child.write('\x03');
      }
    });

    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      try {
        assert.match(output, /ANSI_OK/);
        assert.match(output, /TRUECOLOR_OK/);
        assert.match(output, /ALT_SCREEN_OK/);
        assert.match(output, /READY 80x24/);
        assert.match(output, /UNICODE_INPUT_OK 한글 😀/);
        assert.match(output, /SIZE 100x40/);
        assert.match(output, /CTRL_C_OK/);
        assert.match(output, new RegExp(`CWD ${escapeRegExp(resolvedCwd)}`));
        assert.equal(exitCode, 130);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });

  console.log('PTY smoke passed: ANSI, truecolor, alternate screen, Unicode, input, resize, Ctrl+C, Unicode cwd.');
} finally {
  try {
    child?.kill();
  } catch {}
  await rm(temporaryRoot, { recursive: true, force: true });
}

/**
 * 파일 경로를 정규식 literal로 안전하게 사용할 수 있도록 특수 문자를 이스케이프한다.
 *
 * @param {string} value 정규식에 삽입할 원본 문자열
 * @returns {string} 정규식 특수 문자가 이스케이프된 문자열
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
