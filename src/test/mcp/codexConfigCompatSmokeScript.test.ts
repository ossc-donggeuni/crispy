import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface CodexConfigCompatSmokeModule {
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
	createWindowsBatchFixtureSource,
	createWindowsLauncherFixture,
	shouldDeferTemporaryCleanup,
} = require('../../../scripts/smoke-codex-config-compat') as CodexConfigCompatSmokeModule;

suite('Codex config compatibility smoke script', () => {
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
				'Crispy 한글 공백 100% ! & (Codex)',
			);
			assert.match(scriptSource, /codex-cli 999\.0\.0/u);
			assert.match(scriptSource, /CRISPY_WINDOWS_ARGV:/u);
		} finally {
			fs.rmSync(temporaryRoot, { recursive: true, force: true });
		}
	});
});
