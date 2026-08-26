import * as assert from 'assert';

interface CliInvocation {
	readonly command: string;
	readonly baseArgs: readonly string[];
	readonly environment: Readonly<NodeJS.ProcessEnv>;
}

interface InstalledVsixSmokeModule {
	parseArguments(argv: readonly string[]): Readonly<{
		target: string;
		vsixPath: string;
		vscodeVersion: string;
	}>;
	resolveCliInvocation(
		vscodeExecutablePath: string,
		platform: NodeJS.Platform,
		environment: NodeJS.ProcessEnv,
		windowsCodeCommandText?: string,
	): CliInvocation;
}

interface FakeCodexSmokeModule {
	readonly ACTIVITY_SEQUENCE: readonly string[];
	activityMarker(index: number, activity: string): string;
	decodeMcpResponse(responseText: string): unknown;
	parseMcpUrlFromArguments(argv: readonly string[]): URL;
}

const { parseArguments, resolveCliInvocation } = require(
	'../../../scripts/smoke-installed-vsix',
) as InstalledVsixSmokeModule;
const fakeCodex = require(
	'../../../scripts/installed-smoke/fake-codex',
) as FakeCodexSmokeModule;

suite('Installed VSIX CLI invocation', () => {
	test('설치 smoke는 exact/Stable/Insiders 버전을 선택하고 기본값을 보존한다', () => {
		const target = `${process.platform}-${process.arch}`;
		const defaultSelection = parseArguments(['--target', target]);
		const selected = parseArguments([
			'--target', target,
			'--vscode-version', '1.131.0',
		]);
		const stable = parseArguments([
			'--target', target,
			'--vscode-version', 'stable',
		]);
		const insiders = parseArguments([
			'--target', target,
			'--vscode-version', 'insiders',
		]);

		assert.strictEqual(defaultSelection.vscodeVersion, '1.125.0');
		assert.strictEqual(selected.vscodeVersion, '1.131.0');
		assert.strictEqual(stable.vscodeVersion, 'stable');
		assert.strictEqual(insiders.vscodeVersion, 'insiders');
		assert.throws(
			() => parseArguments([
				'--target', target,
				'--vscode-version', 'latest',
			]),
			/invalid VS Code version/u,
		);
	});

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

	test('가짜 Codex는 Host config URL과 SSE를 strict하게 해석한다', () => {
		const url = fakeCodex.parseMcpUrlFromArguments([
			'--config',
			'mcp_servers.crispy_canvas_test.url="http://127.0.0.1:43123/mcp/route_test"',
		]);
		assert.strictEqual(
			url.toString(),
			'http://127.0.0.1:43123/mcp/route_test',
		);
		assert.deepStrictEqual(
			fakeCodex.decodeMcpResponse(
				'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n',
			),
			{ jsonrpc: '2.0', id: 1, result: {} },
		);
		assert.throws(
			() => fakeCodex.parseMcpUrlFromArguments([
				'--config',
				'mcp_servers.crispy_canvas_test.url="https://example.com/mcp/route"',
			]),
			/invalid_mcp_url/u,
		);
	});

	test('가짜 Codex Activity marker 순서는 6종 state와 handshake를 고정한다', () => {
		assert.deepStrictEqual(fakeCodex.ACTIVITY_SEQUENCE, [
			'planned',
			'active',
			'editing',
			'completed',
			'mentioned',
			'rejected',
		]);
		assert.deepStrictEqual(
			fakeCodex.ACTIVITY_SEQUENCE.map((activity, index) => (
				fakeCodex.activityMarker(index, activity)
			)),
			[
				'state-00-planned',
				'state-01-active',
				'state-02-editing',
				'state-03-completed',
				'state-04-mentioned',
				'state-05-rejected',
			],
		);
	});
});
