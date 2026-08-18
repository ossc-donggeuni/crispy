import * as assert from 'assert';

interface CliInvocation {
	readonly command: string;
	readonly baseArgs: readonly string[];
	readonly environment: Readonly<NodeJS.ProcessEnv>;
}

interface InstalledVsixSmokeModule {
	resolveCliInvocation(
		vscodeExecutablePath: string,
		platform: NodeJS.Platform,
		environment: NodeJS.ProcessEnv,
		windowsCodeCommandText?: string,
	): CliInvocation;
}

const { resolveCliInvocation } = require(
	'../../../scripts/smoke-installed-vsix',
) as InstalledVsixSmokeModule;

suite('Installed VSIX CLI invocation', () => {
	test('Windows에서는 공백·한글 경로를 shell 없이 Code.exe 인자로 보존한다', () => {
		const executable = 'C:\\Users\\user\\OneDrive\\바탕 화면\\VS Code 1.125.0\\Code.exe';
		const sourceEnvironment = {
			VSCODE_DEV: 'must-be-cleared',
			CRISPY_UNICODE_VALUE: '한글 값',
		};
		const codeCommandText = [
			'@echo off',
			'set ELECTRON_RUN_AS_NODE=1',
			'"%~dp0..\\Code.exe" "%~dp0..\\synthetic-build-id\\runtime\\cli-main.mjs" %*',
		].join('\r\n');

		const invocation = resolveCliInvocation(
			executable,
			'win32',
			sourceEnvironment,
			codeCommandText,
		);

		assert.strictEqual(invocation.command, executable);
		assert.deepStrictEqual(invocation.baseArgs, [
			'C:\\Users\\user\\OneDrive\\바탕 화면\\VS Code 1.125.0\\synthetic-build-id\\runtime\\cli-main.mjs',
		]);
		assert.strictEqual(invocation.environment.ELECTRON_RUN_AS_NODE, '1');
		assert.strictEqual(invocation.environment.VSCODE_DEV, undefined);
		assert.strictEqual(invocation.environment.CRISPY_UNICODE_VALUE, '한글 값');
		assert.strictEqual(sourceEnvironment.VSCODE_DEV, 'must-be-cleared');
	});
});
