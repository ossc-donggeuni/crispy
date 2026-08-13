import * as assert from 'assert';
import {
	createTerminalEnvironment,
	getDefaultShellPolicy,
} from '../policy';

/**
 * 플랫폼별 기본 shell 계약과 PTY 환경 변수 보정 정책을 검증한다.
 */
suite('Agent Terminal Policy', () => {
	test('Unix는 SHELL을 인자 없는 interactive non-login 계약으로 사용한다', () => {
		assert.deepStrictEqual(getDefaultShellPolicy('darwin', { SHELL: '/bin/zsh' }), {
			executable: '/bin/zsh',
			args: [],
			label: 'zsh',
		});
	});

	test('Windows는 시스템 Windows PowerShell 5.1 계약을 사용한다', () => {
		assert.deepStrictEqual(getDefaultShellPolicy('win32', { SHELL: '/bin/zsh' }), {
			executable: 'powershell.exe',
			args: [],
			label: 'Windows PowerShell',
		});
	});

	test('PTY 환경은 truecolor를 활성화하고 NO_COLOR를 제거한다', () => {
		const environment = createTerminalEnvironment({ PATH: '/bin', NO_COLOR: '1' });

		assert.strictEqual(environment.PATH, '/bin');
		assert.strictEqual(environment.TERM, 'xterm-256color');
		assert.strictEqual(environment.COLORTERM, 'truecolor');
		assert.strictEqual(environment.TERM_PROGRAM, 'vscode');
		assert.strictEqual(environment.NO_COLOR, undefined);
	});
});
