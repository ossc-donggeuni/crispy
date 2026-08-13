import * as assert from 'assert';
import * as nodePty from 'node-pty';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

suite('Terminal runtime dependencies', () => {
    test('node-pty runtime을 로드할 수 있다', () => {
        assert.strictEqual(typeof nodePty.spawn, 'function');
    });

    test('xterm runtime을 로드할 수 있다', () => {
        assert.strictEqual(typeof Terminal, 'function');
        assert.strictEqual(typeof FitAddon, 'function');
    });
});