import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface CodexConfigCompatSmokeModule {
	assertInstructionPreservationOutput(
		output: string,
		options: Readonly<{
			layer: string;
			expectedMarker?: string;
			expectedAgentsMarker: string;
			unexpectedMarkers?: readonly string[];
			expectsGraphInstructions: boolean;
			token: string;
		}>,
	): void;
	createWindowsBatchFixtureSource(
		nodeExecutable: string,
		probeScript: string,
	): string;
	createWindowsLauncherFixture(temporaryRoot: string): Readonly<{
		readonly executable: string;
		readonly launcherKind: 'cmd-one-shot';
	}>;
	shouldDeferTemporaryCleanup(error: unknown, platform: NodeJS.Platform): boolean;
}

const {
	assertInstructionPreservationOutput,
	createWindowsBatchFixtureSource,
	createWindowsLauncherFixture,
	shouldDeferTemporaryCleanup,
} = require('../../../scripts/smoke-codex-config-compat') as CodexConfigCompatSmokeModule;

const promptInputMarker = 'CRISPY_PROMPT_INPUT_PROBE';
const projectInstructionsMarker = 'CRISPY_PROJECT_INSTRUCTIONS_PRESERVED';
const projectAgentsMarker = 'CRISPY_PROJECT_AGENTS_PRESERVED';
const graphInstructionsMarker = '[REQUIRED FOR USER-VISIBLE GRAPH]';
const mcpToken = 'CRISPY_TEST_MCP_TOKEN';

function promptInputOutput(...texts: readonly string[]): string {
	return JSON.stringify([{
		type: 'message',
		role: 'user',
		content: texts.map((text) => ({ type: 'input_text', text })),
	}], undefined, 2);
}

function preservationOptions(overrides: Partial<Parameters<
	typeof assertInstructionPreservationOutput
>[1]> = {}): Parameters<typeof assertInstructionPreservationOutput>[1] {
	return {
		layer: 'project Activity-enabled',
		expectedMarker: projectInstructionsMarker,
		expectedAgentsMarker: projectAgentsMarker,
		unexpectedMarkers: [],
		expectsGraphInstructions: true,
		token: mcpToken,
		...overrides,
	};
}

suite('Codex config compatibility smoke script', () => {
	test('ConPTY 제어문자와 물리 줄바꿈을 제거한 JSON prompt 값만 검증한다', () => {
		const serializedPrompt = promptInputOutput(
			promptInputMarker,
			projectInstructionsMarker,
			projectAgentsMarker,
			graphInstructionsMarker,
		);
		const physicallyWrappedPrompt = serializedPrompt.replace(
			projectAgentsMarker,
			projectAgentsMarker.replace(
				'AGENTS_',
				'AGENTS_\u001b[31m\r\n\u001b[0m',
			),
		);
		const output = [
			'\u001b[?25lCodex diagnostic\r\n',
			physicallyWrappedPrompt,
			'\r\n\u001b[?25h',
		].join('');

		assert.doesNotThrow(() => assertInstructionPreservationOutput(
			output,
			preservationOptions(),
		));
	});

	test('JSON 밖의 marker는 prompt 보존 증거로 인정하지 않는다', () => {
		const output = `${projectAgentsMarker}\r\n${promptInputOutput(
			promptInputMarker,
			projectInstructionsMarker,
			graphInstructionsMarker,
		)}`;

		assert.throws(
			() => assertInstructionPreservationOutput(
				output,
				preservationOptions(),
			),
			/AGENTS\.md instructions were not preserved/u,
		);
	});

	test('ConPTY가 분절한 MCP credential도 다른 prompt assertion보다 먼저 거부한다', () => {
		const output = promptInputOutput(mcpToken).replace(
			mcpToken,
			mcpToken.replace('MCP_', 'MCP_\r\n'),
		);

		assert.throws(
			() => assertInstructionPreservationOutput(
				output,
				preservationOptions(),
			),
			/exposed the MCP credential/u,
		);
	});

	test('손상된 prompt-input transcript를 substring 검사로 통과시키지 않는다', () => {
		const output = `[${promptInputMarker}${projectInstructionsMarker}${projectAgentsMarker}`;

		assert.throws(
			() => assertInstructionPreservationOutput(
				output,
				preservationOptions(),
			),
			/JSON input list/u,
		);
	});

	test('standalone smoke는 node-pty handle이 남아도 결과 코드로 종료한다', () => {
		const source = fs.readFileSync(
			path.join(__dirname, '../../../scripts/smoke-codex-config-compat.js'),
			'utf8',
		);

		assert.match(source, /\(\) => process\.exit\(0\)/u);
		assert.match(source, /process\.exit\(1\)/u);
	});

	test('Windows ConPTY가 남긴 일시적 파일 잠금은 smoke 결과를 실패시키지 않는다', () => {
		for (const code of ['EBUSY', 'ENOTEMPTY', 'EPERM']) {
			const error = Object.assign(new Error('locked'), { code });
			assert.strictEqual(
				shouldDeferTemporaryCleanup(error, 'win32'),
				true,
			);
			assert.strictEqual(
				shouldDeferTemporaryCleanup(error, 'linux'),
				false,
			);
		}

		assert.strictEqual(
			shouldDeferTemporaryCleanup(
				Object.assign(new Error('access denied'), { code: 'EACCES' }),
				'win32',
			),
			false,
		);
	});

	test('전용 cmd fixture는 npm shim의 self-path lookup에 의존하지 않는다', () => {
		const source = createWindowsBatchFixtureSource(
			'C:\\Node 100%\\node.exe',
			'C:\\Probe ! & (한글)\\probe.js',
		);

		assert.match(source, /SETLOCAL DisableDelayedExpansion/u);
		assert.match(source, /"C:\\Node 100%%\\node\.exe"/u);
		assert.match(source, /"C:\\Probe ! & \(한글\)\\probe\.js"/u);
		assert.doesNotMatch(source, /%~dp0/u);
	});

	test('특수문자 디렉터리에 독립 실행 가능한 launcher fixture를 만든다', () => {
		const temporaryRoot = fs.mkdtempSync(path.join(
			os.tmpdir(),
			'crispy-codex-config-smoke-test-',
		));
		try {
			const fixture = createWindowsLauncherFixture(temporaryRoot);
			const scriptSource = fs.readFileSync(
				path.join(temporaryRoot, 'windows-launcher-fixture.js'),
				'utf8',
			);

			assert.strictEqual(fixture.launcherKind, 'cmd-one-shot');
			assert.strictEqual(path.basename(fixture.executable), 'codex.cmd');
			assert.strictEqual(
				path.basename(path.dirname(fixture.executable)),
				'Crispy 한글 공백 %CRISPY_FIXTURE% 100% ! & (Codex)',
			);
			assert.match(scriptSource, /codex-cli 999\.0\.0/u);
			assert.match(scriptSource, /CRISPY_WINDOWS_ARGV:/u);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});
});
