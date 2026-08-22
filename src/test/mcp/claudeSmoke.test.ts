import * as assert from 'node:assert/strict';
import type { AgentProcessSpawnRequest } from '../../mcp/agentLaunchPlan';
import {
	ClaudeSmokeEventObserver,
	createClaudeMcpSmokeArgs,
	createClaudeMcpSmokePrompt,
	runClaudeMcpSmoke,
	type ClaudeSmokeStatus,
} from '../../mcp/claudeSmoke';
import { McpConnectionDescriptor } from '../../mcp/sessionRuntime';
import { FakePtyProcessHandle } from '../agent/support/fakePtyAdapter';

const generation = 'generation-claude-smoke';
const sessionId = 'session-claude-smoke';
const routeId = Buffer.alloc(24, 0x31).toString('base64url');
const bearerToken = Buffer.alloc(32, 0x52).toString('base64url');

suite('Claude MCP L1 dev smoke transaction', () => {
	test('version gate와 auth 등록 뒤 node-pty request에서 ping을 관찰한다', async () => {
		const fixture = createFixture('registered');
		let spawnRequest: AgentProcessSpawnRequest | undefined;
		const succeeded = await runClaudeMcpSmoke({
			...fixture.options,
			spawnProvider: (request) => {
				spawnRequest = request;
				setImmediate(() => fixture.events.handle({
					type: 'session.crispyPingObserved',
					generation,
					sessionId,
				}));
				return fixture.provider;
			},
		});

		assert.strictEqual(succeeded, true);
		assert.deepStrictEqual(fixture.statuses, [
			'version_compatible',
			'adapter_ready',
			'awaiting_activity',
			'activity_observed',
		]);
		assert.strictEqual(fixture.prepareCount(), 1);
		assert.strictEqual(fixture.markProviderStartedCount(), 1);
		assert.strictEqual(fixture.disposeCount(), 1);
		assert.ok(spawnRequest !== undefined);
		assert.strictEqual(spawnRequest.executable, '/usr/local/bin/claude');
		const serverName = `${'crispy_canvas_'}${'ab'.repeat(16)}`;
		assert.deepStrictEqual(
			spawnRequest.args.slice(0, 4),
			createClaudeMcpSmokeArgs(serverName),
		);
		assert.strictEqual(
			spawnRequest.args[3],
			createClaudeMcpSmokePrompt(serverName),
		);
		assert.strictEqual(spawnRequest.args[1], `mcp__${serverName}__crispy_ping`);
		assert.strictEqual(spawnRequest.args[1].includes('*'), false);
		assert.strictEqual(spawnRequest.args.at(-2), '--mcp-config');
		assert.strictEqual(spawnRequest.args.some(
			(argument) => argument.includes(bearerToken),
		), false);
		assert.strictEqual(spawnRequest.args.at(-1)?.includes(
			'Bearer ${CRISPY_MCP_TOKEN}',
		), true);
		assert.strictEqual(spawnRequest.environment.CRISPY_MCP_TOKEN, bearerToken);
		assert.strictEqual(spawnRequest.environment.crispy_mcp_token, undefined);
		assert.strictEqual(spawnRequest.environment.ELECTRON_RUN_AS_NODE, undefined);
		assert.strictEqual(spawnRequest.environment.KEEP_ME, 'yes');
	});

	test('negative control은 같은 inline config에서 token env만 제거하고 activity 없이 끝난다', async () => {
		const fixture = createFixture('missing-negative-control');
		let spawnRequest: AgentProcessSpawnRequest | undefined;
		const succeeded = await runClaudeMcpSmoke({
			...fixture.options,
			spawnProvider: (request) => {
				spawnRequest = request;
				setImmediate(() => fixture.provider.emitExit({ exitCode: 0 }));
				return fixture.provider;
			},
		});

		assert.strictEqual(succeeded, true);
		assert.deepStrictEqual(fixture.statuses, [
			'version_compatible',
			'adapter_ready',
			'awaiting_activity',
			'negative_control_passed',
		]);
		assert.ok(spawnRequest !== undefined);
		assert.strictEqual(Object.keys(spawnRequest.environment).some(
			(name) => name.toUpperCase() === 'CRISPY_MCP_TOKEN',
		), false);
		assert.strictEqual(spawnRequest.args.at(-1)?.includes(
			'Bearer ${CRISPY_MCP_TOKEN}',
		), true);
		assert.strictEqual(JSON.stringify(spawnRequest).includes(bearerToken), false);
	});

	test('negative control에서 authenticated activity가 오면 즉시 실패한다', async () => {
		const fixture = createFixture('missing-negative-control');
		const succeeded = await runClaudeMcpSmoke({
			...fixture.options,
			spawnProvider: () => {
				setImmediate(() => fixture.events.handle({
					type: 'session.mcpActivityObserved',
					generation,
					sessionId,
				}));
				return fixture.provider;
			},
		});

		assert.strictEqual(succeeded, false);
		assert.strictEqual(
			fixture.statuses.at(-1),
			'failed:negative_control_activity',
		);
	});

	test('minimum 미만 또는 probe 실패는 adapter/token/config를 만들지 않는다', async () => {
		for (const compatibility of [
			{ version: { major: 2, minor: 1, patch: 120 }, compatible: false },
			undefined,
		]) {
			const fixture = createFixture('registered');
			let spawnCount = 0;
			const succeeded = await runClaudeMcpSmoke({
				...fixture.options,
				resolveCompatibility: async () => compatibility,
				spawnProvider: () => {
					spawnCount += 1;
					return fixture.provider;
				},
			});

			assert.strictEqual(succeeded, false);
			assert.strictEqual(fixture.prepareCount(), 0);
			assert.strictEqual(spawnCount, 0);
			assert.strictEqual(
				fixture.statuses.at(-1),
				compatibility === undefined
					? 'failed:version_probe_failed'
					: 'failed:version_incompatible',
			);
			assert.strictEqual(fixture.statuses.some(
				(status) => status.includes('provider_update_required'),
			), false);
		}
	});
});

function createFixture(
	credentialMode: 'registered' | 'missing-negative-control',
): {
	readonly options: Parameters<typeof runClaudeMcpSmoke>[0];
	readonly events: ClaudeSmokeEventObserver;
	readonly provider: FakePtyProcessHandle;
	readonly statuses: ClaudeSmokeStatus[];
	readonly prepareCount: () => number;
	readonly markProviderStartedCount: () => number;
	readonly disposeCount: () => number;
} {
	const events = new ClaudeSmokeEventObserver(
		sessionId,
		credentialMode === 'missing-negative-control',
	);
	const provider = new FakePtyProcessHandle(8101);
	const connection = new McpConnectionDescriptor(
		generation,
		sessionId,
		`http://127.0.0.1:43123/mcp/${routeId}`,
		bearerToken,
	);
	const statuses: ClaudeSmokeStatus[] = [];
	let prepares = 0;
	let providerStarts = 0;
	let disposes = 0;
	return {
		events,
		provider,
		statuses,
		prepareCount: () => prepares,
		markProviderStartedCount: () => providerStarts,
		disposeCount: () => disposes,
		options: {
			supervisor: {
				prepareSession: async () => {
					prepares += 1;
					return { ok: true, connection };
				},
				getSessionRuntime: () => ({
					generation,
					markProviderStarted: () => {
						providerStarts += 1;
						return true;
					},
				}),
				dispose: async () => {
					disposes += 1;
					connection.invalidate();
				},
			},
			events,
			sessionId,
			cwd: '/workspace',
			baseEnvironment: {
				CRISPY_MCP_TOKEN: 'stale-one',
				crispy_mcp_token: 'stale-two',
				ELECTRON_RUN_AS_NODE: '1',
				KEEP_ME: 'yes',
			},
			credentialMode,
			platform: 'darwin',
			resolveExecutable: async () => ({
				ok: true,
				executable: {
					executable: '/usr/local/bin/claude',
					launcherKind: 'direct',
				},
			}),
			resolveCompatibility: async () => ({
				version: { major: 2, minor: 1, patch: 234 },
				compatible: true,
			}),
			spawnProvider: () => provider,
			terminateProvider: async (process) => process.kill(),
			randomBytes: (size) => Buffer.alloc(size, 0xab),
			report: (status) => statuses.push(status),
		},
	};
}
