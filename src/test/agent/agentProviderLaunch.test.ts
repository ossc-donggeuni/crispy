import * as assert from 'assert';
import type { ChildProcess } from 'node:child_process';
import {
	createAgentAutoRunInputResolver,
	createWindowsAgentCommandProbe,
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
	test('실제 Windows execFile probe는 fresh Workspace preflight 없이는 child를 만들지 않는다', async () => {
		let preflightCalls = 0;
		let execFileCalls = 0;
		const probe = createWindowsAgentCommandProbe(() => {
			execFileCalls += 1;
			throw new Error('guard 실패 뒤 execFile이 호출되면 안 된다');
		});
		const available = await probe(
			'codex',
			{ ...windowsPolicy, executable: process.execPath },
			undefined,
			() => {
				preflightCalls += 1;
				return undefined;
			},
		);

		assert.strictEqual(available, false);
		assert.strictEqual(preflightCalls, 1);
		assert.strictEqual(execFileCalls, 0);
	});

	test('Windows execFile probe는 fresh cwd를 guard 직후 child options에 적용한다', async () => {
		const events: string[] = [];
		let childCwd: string | undefined;
		const probe = createWindowsAgentCommandProbe((
			_executable,
			_args,
			options,
			onExit,
		) => {
			childCwd = options.cwd;
			events.push('execFile');
			setImmediate(() => onExit(null));
			return {} as ChildProcess;
		});

		const available = await probe(
			'codex',
			windowsPolicy,
			undefined,
			() => {
				events.push('workspace');
				return 'C:\\fresh\\workspace';
			},
		);

		assert.strictEqual(available, true);
		assert.strictEqual(childCwd, 'C:\\fresh\\workspace');
		assert.deepStrictEqual(events, ['workspace', 'execFile']);
	});

	test('Codex·Claude Windows 후보마다 fresh Workspace resolver를 전달한다', async () => {
		const probes: string[] = [];
		const freshCwds: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async (
				command,
				_policy,
				_signal,
				resolveWorkspaceCwdBeforeSpawn,
			) => {
				probes.push(command);
				freshCwds.push(resolveWorkspaceCwdBeforeSpawn?.() ?? 'blocked');
				return true;
			},
		});

		for (const providerId of ['codex', 'claude'] as const) {
			assert.strictEqual(
				await resolver(
					providerId,
					windowsPolicy,
					undefined,
					() => `C:\\fresh\\${providerId}`,
				),
				`${providerId}\r`,
			);
		}

		assert.deepStrictEqual(probes, ['codex', 'claude']);
		assert.deepStrictEqual(freshCwds, [
			'C:\\fresh\\codex',
			'C:\\fresh\\claude',
		]);
	});

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

	test('같은 provider와 환경의 성공 결과를 재사용하고 provider별 cache는 분리한다', async () => {
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
		assert.strictEqual(await resolver('claude', windowsPolicy), 'claude\r');
		assert.deepStrictEqual(probes, ['codex', 'claude']);
	});

	test('동시 Codex resolve는 같은 성공 probe Promise를 공유한다', async () => {
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
				resolver('codex', windowsPolicy),
				resolver('codex', windowsPolicy),
			]),
			['codex\r', 'codex\r'],
		);
		assert.strictEqual(probeCount, 1);
	});

	test('취소된 Windows 탐색은 현재 probe를 끝내고 다음 후보를 실행하지 않는다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: (command, _policy, signal) => {
				probes.push(command);
				return new Promise((resolve) => {
					if (signal?.aborted) {
						resolve(false);
						return;
					}
					signal?.addEventListener('abort', () => resolve(false), {
						once: true,
					});
				});
			},
		});
		const controller = new AbortController();

		const resolution = resolver(
			'claude',
			windowsPolicy,
			controller.signal,
		);
		await Promise.resolve();
		controller.abort();

		assert.strictEqual(await resolution, undefined);
		assert.deepStrictEqual(probes, ['claude']);
	});

	test('Windows launch 환경이나 Codex override가 바뀌면 별도로 탐색한다', async () => {
		let override = 'C:\\Codex\\codex.exe';
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
				await resolver('codex', policy),
				"& 'C:\\Codex\\codex.exe'\r",
			);
		}
		assert.strictEqual(
			await resolver('codex', windowsPolicy),
			"& 'C:\\Codex\\codex.exe'\r",
		);
		override = 'D:\\Codex\\codex.exe';
		assert.strictEqual(
			await resolver('codex', windowsPolicy),
			"& 'D:\\Codex\\codex.exe'\r",
		);

		assert.strictEqual(probes.length, policyVariants.length + 1);
	});

	test('기본 이름과 같은 Claude override도 안전한 override 형식을 유지한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			getCliPath: () => ' claude ',
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return true;
			},
		});

		assert.strictEqual(
			await resolver('claude', windowsPolicy),
			"& 'claude'\r",
		);
		assert.deepStrictEqual(probes, ['claude']);
	});

	test('모든 Windows probe 실패는 기본 이름을 유지하고 다음 호출에서 재탐색한다', async () => {
		const probes: string[] = [];
		const resolver = createAgentAutoRunInputResolver({
			platform: 'win32',
			probeWindowsCommand: async (command) => {
				probes.push(command);
				return false;
			},
		});

		assert.strictEqual(await resolver('codex', windowsPolicy), 'codex\r');
		assert.strictEqual(await resolver('claude', windowsPolicy), 'claude\r');
		assert.strictEqual(await resolver('codex', windowsPolicy), 'codex\r');
		assert.deepStrictEqual(probes, [
			'codex',
			'codex.cmd',
			'codex.exe',
			'claude',
			'claude.cmd',
			'claude.exe',
			'codex',
			'codex.cmd',
			'codex.exe',
		]);
	});

	test('macOS와 Linux provider override를 executable 한 단어로 안전하게 인용한다', async () => {
		for (const platform of ['darwin', 'linux'] as const) {
			const resolver = createAgentAutoRunInputResolver({
				platform,
				getCliPath: () => "/opt/Provider's CLI/provider --unsafe",
			});

			for (const providerId of ['codex', 'claude'] as const) {
				assert.strictEqual(
					await resolver(providerId, windowsPolicy),
					"'/opt/Provider'\\''s CLI/provider --unsafe'\r",
				);
			}
		}
	});

	test('공백뿐인 Claude override는 미설정으로 취급한다', async () => {
		const resolver = createAgentAutoRunInputResolver({
			platform: 'linux',
			getCliPath: () => '   ',
		});

		assert.strictEqual(await resolver('claude', windowsPolicy), 'claude\r');
	});
});
