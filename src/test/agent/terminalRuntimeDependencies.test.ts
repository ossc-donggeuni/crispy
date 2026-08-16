import * as assert from 'assert';
import * as nodePty from 'node-pty';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

interface NodePtyRuntimeContract {
	readonly staging: {
		readonly version: string;
		readonly artifactsByTarget: Readonly<Record<string, readonly string[]>>;
	};
}

const { nodePtyRuntimeDependency } = require(
	'../../../scripts/runtime-dependencies',
) as { readonly nodePtyRuntimeDependency: NodePtyRuntimeContract };

suite('Terminal runtime dependencies', () => {
	test('node-pty runtime을 로드할 수 있다', () => {
		assert.strictEqual(typeof nodePty.spawn, 'function');
	});

	test('beta.14 target allowlist는 Windows ConPTY와 target prebuild만 포함한다', () => {
		const { version, artifactsByTarget } = nodePtyRuntimeDependency.staging;
		assert.strictEqual(version, '1.2.0-beta.14');
		assert.deepStrictEqual(artifactsByTarget['linux-x64'], [
			'prebuilds/linux-x64/pty.node',
		]);
		assert.deepStrictEqual(artifactsByTarget['win32-x64'], [
			'prebuilds/win32-x64/conpty.node',
			'prebuilds/win32-x64/conpty_console_list.node',
			'prebuilds/win32-x64/conpty/OpenConsole.exe',
			'prebuilds/win32-x64/conpty/conpty.dll',
		]);
	});

	test('xterm runtime을 로드할 수 있다', () => {
		assert.strictEqual(typeof Terminal, 'function');
		assert.strictEqual(typeof FitAddon, 'function');
	});
});
