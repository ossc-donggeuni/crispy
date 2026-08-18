import * as assert from 'assert';
import {
	createAgentAutoRunInputResolver,
	WINDOWS_ANTIGRAVITY_COMMAND_CANDIDATES,
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

	test('Windows Antigravity는 agy, agy.cmd, agy.exe 순으로 첫 성공 후보를 사용한다', async () => {
		const cmdProbes: string[] = [];
		const cmdResolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async (command, policy) => {
				assert.strictEqual(policy, windowsPolicy);
				cmdProbes.push(command);
				return command === 'agy.cmd';
			},
		});

		assert.strictEqual(
			await cmdResolver('antigravity', windowsPolicy),
			'agy.cmd\r',
		);
		assert.deepStrictEqual(cmdProbes, ['agy', 'agy.cmd']);

		const exeProbes: string[] = [];
		const exeResolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async (command, policy) => {
				assert.strictEqual(policy, windowsPolicy);
				exeProbes.push(command);
				return command === 'agy.exe';
			},
		});

		assert.strictEqual(
			await exeResolver('antigravity', windowsPolicy),
			'agy.exe\r',
		);
		assert.deepStrictEqual(exeProbes, ['agy', 'agy.cmd', 'agy.exe']);
		assert.deepStrictEqual(
			WINDOWS_ANTIGRAVITY_COMMAND_CANDIDATES,
			['agy', 'agy.cmd', 'agy.exe'],
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

	test('Antigravity override를 먼저 검증하고 공백과 작은따옴표를 안전하게 입력한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			getCliPath: (providerId) => providerId === 'antigravity'
				? " C:\\Program Files\\Google's Antigravity\\agy.exe "
				: undefined,
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return true;
			},
		});

		assert.strictEqual(
			await resolver('antigravity', windowsPolicy),
			"& 'C:\\Program Files\\Google''s Antigravity\\agy.exe'\r",
		);
		assert.deepStrictEqual(
			probes,
			["C:\\Program Files\\Google's Antigravity\\agy.exe"],
		);
	});

	test('유효하지 않은 Antigravity override 뒤에는 모든 기본 후보를 순서대로 탐색한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			getCliPath: () => 'C:\\missing\\agy.exe',
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return command === 'agy.exe';
			},
		});

		assert.strictEqual(
			await resolver('antigravity', windowsPolicy),
			'agy.exe\r',
		);
		assert.deepStrictEqual(probes, [
			'C:\\missing\\agy.exe',
			'agy',
			'agy.cmd',
			'agy.exe',
		]);
	});

	test('같은 provider와 환경의 성공 결과를 재사용하고 provider별 cache는 분리한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return !command.endsWith('.cmd') && !command.endsWith('.exe');
			},
		});

		assert.strictEqual(await resolver('antigravity', windowsPolicy), 'agy\r');
		assert.strictEqual(await resolver('antigravity', windowsPolicy), 'agy\r');
		assert.strictEqual(await resolver('codex', windowsPolicy), 'codex\r');
		assert.strictEqual(await resolver('codex', windowsPolicy), 'codex\r');
		assert.strictEqual(await resolver('claude', windowsPolicy), 'claude\r');
		assert.deepStrictEqual(probes, ['agy', 'codex', 'claude']);
	});

	test('동시 Antigravity resolve는 같은 성공 probe Promise를 공유한다', async () => {
		let probeCount = 0;
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async () => {
				probeCount += 1;
				await Promise.resolve();
				return true;
			},
		});

		assert.deepStrictEqual(
			await Promise.all([
				resolver('antigravity', windowsPolicy),
				resolver('antigravity', windowsPolicy),
			]),
			['agy\r', 'agy\r'],
		);
		assert.strictEqual(probeCount, 1);
	});

	test('Windows launch 환경이나 Antigravity override가 바뀌면 별도로 탐색한다', async () => {
		let override = 'C:\\Antigravity\\agy.exe';
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			getCliPath: () => override,
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return true;
			},
		});
		const policyVariants: ShellLaunchPolicy[] = [
			windowsPolicy,
			{ ...windowsPolicy, executable: 'C:\\PowerShell\\pwsh.exe' },
			{ ...windowsPolicy, cwd: 'C:\\other-workspace' },
			{
				...windowsPolicy,
				env: { ...windowsPolicy.env, Path: 'C:\\other-path' },
			},
			{
				...windowsPolicy,
				env: { ...windowsPolicy.env, PATH: 'C:\\uppercase-path' },
			},
			{
				...windowsPolicy,
				env: { ...windowsPolicy.env, PATHEXT: '.EXE;.CMD' },
			},
		];

		for (const policy of policyVariants) {
			assert.strictEqual(
				await resolver('antigravity', policy),
				"& 'C:\\Antigravity\\agy.exe'\r",
			);
		}
		assert.strictEqual(
			await resolver('antigravity', windowsPolicy),
			"& 'C:\\Antigravity\\agy.exe'\r",
		);
		override = 'D:\\Antigravity\\agy.exe';
		assert.strictEqual(
			await resolver('antigravity', windowsPolicy),
			"& 'D:\\Antigravity\\agy.exe'\r",
		);

		assert.strictEqual(probes.length, policyVariants.length + 1);
	});

	test('기본 이름과 같은 Antigravity override도 안전한 override 형식을 유지한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			getCliPath: () => ' agy ',
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return true;
			},
		});

		assert.strictEqual(
			await resolver('antigravity', windowsPolicy),
			"& 'agy'\r",
		);
		assert.deepStrictEqual(probes, ['agy']);
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

	test('모든 Antigravity 후보 실패 결과는 cache하지 않고 다음 호출에서 재탐색한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return false;
			},
		});

		assert.strictEqual(await resolver('antigravity', windowsPolicy), 'agy\r');
		assert.strictEqual(await resolver('antigravity', windowsPolicy), 'agy\r');
		assert.deepStrictEqual(probes, [
			'agy',
			'agy.cmd',
			'agy.exe',
			'agy',
			'agy.cmd',
			'agy.exe',
		]);
	});

	test('macOS와 Linux provider override를 executable 한 단어로 안전하게 인용한다', async () => {
		for (const platform of ['darwin', 'linux'] as const) {
			const resolver = createAgentAutoRunInputResolver({
				platform,
				getCliPath: () => "/opt/Google's Antigravity/agy --unsafe",
			});

			for (const providerId of ['codex', 'claude', 'antigravity'] as const) {
				assert.strictEqual(
					await resolver(providerId, windowsPolicy),
					"'/opt/Google'\\''s Antigravity/agy --unsafe'\r",
				);
			}
		}
	});

	test('공백뿐인 Antigravity override는 미설정으로 취급한다', async () => {
		const resolver = createAgentAutoRunInputResolver({
			platform: 'linux',
			getCliPath: () => '   ',
		});

		assert.strictEqual(await resolver('antigravity', windowsPolicy), 'agy\r');
	});
});
