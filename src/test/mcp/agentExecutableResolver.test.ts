import * as assert from 'assert';
import { resolveAgentExecutable } from '../../mcp/agentExecutableResolver';

suite('Agent executable resolver', () => {
	test('macOS와 Linux는 PATH의 native Codex·Claude를 direct executable로 resolve한다', async () => {
		for (const providerId of ['codex', 'claude'] as const) {
			for (const platform of ['darwin', 'linux'] as const) {
				const probes: string[] = [];
				const expected = `/opt/bin/${providerId}`;
				const result = await resolveAgentExecutable(providerId, {
					platform,
					environment: { PATH: '/first:/opt/bin' },
					isExecutableFile: async (candidate) => {
						probes.push(candidate);
						return candidate === expected;
					},
				});

				assert.deepStrictEqual(result, {
					ok: true,
					executable: {
						executable: expected,
						launcherKind: 'direct',
					},
				});
				assert.deepStrictEqual(probes, [
					`/first/${providerId}`,
					expected,
				]);
			}
		}
	});

	test('Windows PATHEXT 순서로 Codex·Claude native exe와 npm cmd를 구분한다', async () => {
		for (const providerId of ['codex', 'claude'] as const) {
			const exePath = `C:\\native\\${providerId}.exe`;
			const cmdPath = `C:\\npm\\${providerId}.cmd`;
			const exe = await resolveAgentExecutable(providerId, {
				platform: 'win32',
				environment: {
					Path: 'C:\\native;C:\\npm',
					PATHEXT: '.EXE;.CMD',
				},
				isExecutableFile: async (candidate) => candidate === exePath,
			});
			const cmd = await resolveAgentExecutable(providerId, {
				platform: 'win32',
				environment: {
					PATH: 'C:\\native;C:\\npm',
					PATHEXT: '.EXE;.CMD',
				},
				isExecutableFile: async (candidate) => candidate === cmdPath,
			});

			assert.deepStrictEqual(exe, {
				ok: true,
				executable: {
					executable: exePath,
					launcherKind: 'direct',
				},
			});
			assert.deepStrictEqual(cmd, {
				ok: true,
				executable: {
					executable: cmdPath,
					launcherKind: 'cmd-one-shot',
				},
			});
		}
	});

	test('Windows Codex·Claude override를 한 파일로만 받고 raw quote를 거부한다', async () => {
		for (const providerId of ['codex', 'claude'] as const) {
			for (const [override, launcherKind] of [
				[`C:\\Program Files\\한글 & CLI\\${providerId}.exe`, 'direct'],
				[`C:\\Program Files\\100% (CLI)!\\${providerId}.cmd`, 'cmd-one-shot'],
			] as const) {
				const result = await resolveAgentExecutable(providerId, {
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
