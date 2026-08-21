import * as assert from 'assert';
import { resolveAgentExecutable } from '../../mcp/agentExecutableResolver';

suite('Agent executable resolver', () => {
	test('macOS와 Linux는 PATH의 native Codex를 direct executable로 resolve한다', async () => {
		for (const platform of ['darwin', 'linux'] as const) {
			const probes: string[] = [];
			const result = await resolveAgentExecutable('codex', {
				platform,
				environment: { PATH: '/first:/opt/bin' },
				isExecutableFile: async (candidate) => {
					probes.push(candidate);
					return candidate === '/opt/bin/codex';
				},
			});

			assert.deepStrictEqual(result, {
				ok: true,
				executable: {
					executable: '/opt/bin/codex',
					launcherKind: 'direct',
				},
			});
			assert.deepStrictEqual(probes, ['/first/codex', '/opt/bin/codex']);
		}
	});

	test('Windows PATHEXT 순서로 native exe와 npm cmd를 구분한다', async () => {
		const exe = await resolveAgentExecutable('codex', {
			platform: 'win32',
			environment: {
				Path: 'C:\\native;C:\\npm',
				PATHEXT: '.EXE;.CMD',
			},
			isExecutableFile: async (candidate) => candidate === 'C:\\native\\codex.exe',
		});
		const cmd = await resolveAgentExecutable('codex', {
			platform: 'win32',
			environment: {
				PATH: 'C:\\native;C:\\npm',
				PATHEXT: '.EXE;.CMD',
			},
			isExecutableFile: async (candidate) => candidate === 'C:\\npm\\codex.cmd',
		});

		assert.deepStrictEqual(exe, {
			ok: true,
			executable: {
				executable: 'C:\\native\\codex.exe',
				launcherKind: 'direct',
			},
		});
		assert.deepStrictEqual(cmd, {
			ok: true,
			executable: {
				executable: 'C:\\npm\\codex.cmd',
				launcherKind: 'cmd-one-shot',
			},
		});
	});

	test('Windows custom exe/cmd 경로를 한 파일로만 받고 raw quote를 거부한다', async () => {
		for (const [override, launcherKind] of [
			['C:\\Program Files\\한글 & Codex\\codex.exe', 'direct'],
			['C:\\Program Files\\100% (Codex)!\\codex.cmd', 'cmd-one-shot'],
		] as const) {
			const result = await resolveAgentExecutable('codex', {
				platform: 'win32',
				environment: {},
				override,
				isExecutableFile: async (candidate) => candidate === override,
			});
			assert.deepStrictEqual(result, {
				ok: true,
				executable: { executable: override, launcherKind },
			});
		}

		const invalid = await resolveAgentExecutable('codex', {
			platform: 'win32',
			environment: {},
			override: 'C:\\Codex" & calc.exe & "\\codex.cmd',
			isExecutableFile: async () => true,
		});
		assert.deepStrictEqual(invalid, { ok: false, reason: 'invalid_override' });
	});

	test('실행할 후보가 없거나 플랫폼이 다르면 safe reason만 반환한다', async () => {
		assert.deepStrictEqual(
			await resolveAgentExecutable('codex', {
				platform: 'win32',
				environment: { PATH: 'C:\\missing' },
				isExecutableFile: async () => false,
			}),
			{ ok: false, reason: 'provider_unavailable' },
		);
		assert.deepStrictEqual(
			await resolveAgentExecutable('codex', { platform: 'freebsd' }),
			{ ok: false, reason: 'unsupported_platform' },
		);
	});
});
