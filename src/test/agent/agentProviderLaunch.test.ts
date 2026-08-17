import * as assert from 'assert';
import {
	createAgentAutoRunInputResolver,
	WINDOWS_CLAUDE_COMMAND_CANDIDATES,
	WINDOWS_CODEX_COMMAND_CANDIDATES,
} from '../../agent/host/agent/agentProviderLaunch';
import type { ShellLaunchPolicy } from '../../agent/host/shell/types';

const windowsPolicy: ShellLaunchPolicy = {
	executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
	args: [],
	cwd: 'C:\\workspace',
	env: {
		Path: 'C:\\cli;C:\\Windows\\System32',
		PATHEXT: '.COM;.EXE;.BAT;.CMD',
	},
};

suite('Agent provider CLI 자동 탐색', () => {
	test('Windows Codex는 codex, codex.cmd, codex.exe 순으로 첫 성공 후보를 사용한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return command === 'codex.cmd';
			},
		});

		assert.strictEqual(
			await resolver('codex', windowsPolicy),
			'codex.cmd\r',
		);
		assert.deepStrictEqual(probes, ['codex', 'codex.cmd']);
		assert.deepStrictEqual(
			WINDOWS_CODEX_COMMAND_CANDIDATES,
			['codex', 'codex.cmd', 'codex.exe'],
		);
	});

	test('Windows Claude도 claude, claude.cmd, claude.exe 순으로 탐색한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return command === 'claude.exe';
			},
		});

		assert.strictEqual(
			await resolver('claude', windowsPolicy),
			'claude.exe\r',
		);
		assert.deepStrictEqual(probes, ['claude', 'claude.cmd', 'claude.exe']);
		assert.deepStrictEqual(
			WINDOWS_CLAUDE_COMMAND_CANDIDATES,
			['claude', 'claude.cmd', 'claude.exe'],
		);
	});

	test('설정한 CLI 경로를 먼저 검증하고 PowerShell 경로 하나로 안전하게 입력한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			getCliPath: (providerId) => providerId === 'codex'
				? " C:\\Program Files\\Codex's CLI\\codex.exe "
				: undefined,
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return true;
			},
		});

		assert.strictEqual(
			await resolver('codex', windowsPolicy),
			"& 'C:\\Program Files\\Codex''s CLI\\codex.exe'\r",
		);
		assert.deepStrictEqual(
			probes,
			["C:\\Program Files\\Codex's CLI\\codex.exe"],
		);
	});

	test('유효하지 않은 override 뒤에는 provider 기본 후보로 fallback한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			getCliPath: () => 'C:\\missing\\claude.exe',
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return command === 'claude.cmd';
			},
		});

		assert.strictEqual(
			await resolver('claude', windowsPolicy),
			'claude.cmd\r',
		);
		assert.deepStrictEqual(probes, [
			'C:\\missing\\claude.exe',
			'claude',
			'claude.cmd',
		]);
	});

	test('같은 provider와 PATH의 성공 결과를 재사용하고 provider별 cache는 분리한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return !command.endsWith('.cmd') && !command.endsWith('.exe');
			},
		});

		assert.strictEqual(await resolver('codex', windowsPolicy), 'codex\r');
		assert.strictEqual(await resolver('codex', windowsPolicy), 'codex\r');
		assert.strictEqual(await resolver('claude', windowsPolicy), 'claude\r');
		assert.deepStrictEqual(probes, ['codex', 'claude']);
	});

	test('모든 Windows probe가 실패하면 문서 기준 기본 이름을 유지한다', async () => {
		let probeCount = 0;
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async () => {
				probeCount += 1;
				return false;
			},
		});

		assert.strictEqual(await resolver('codex', windowsPolicy), 'codex\r');
		assert.strictEqual(await resolver('claude', windowsPolicy), 'claude\r');
		assert.strictEqual(await resolver('codex', windowsPolicy), 'codex\r');
		assert.strictEqual(probeCount, 9);
	});

	test('POSIX override는 executable 한 단어로 인용하고 Antigravity에는 적용하지 않는다', async () => {
		const resolver = createAgentAutoRunInputResolver({
			platform: 'linux',
			getCliPath: () => "/opt/agent's bin/cli",
		});

		assert.strictEqual(
			await resolver('codex', windowsPolicy),
			"'/opt/agent'\\''s bin/cli'\r",
		);
		assert.strictEqual(await resolver('antigravity', windowsPolicy), undefined);
	});
});
