import * as assert from 'assert';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
	CODEX_MCP_SMOKE_PROMPT,
	CodexSmokeEventObserver,
	createCodexSmokeArgs,
	createCodexSmokeSpawnOptions,
	runCodexMcpSmoke,
	type CodexProviderSpawnRequest,
	type CodexSmokeStatus,
	type CodexSmokeSupervisor,
} from '../../mcp/codexSmoke';
import { McpConnectionDescriptor } from '../../mcp/sessionRuntime';
import type { McpPrepareResult } from '../../mcp/sessionRuntime';
import type { AgentExecutableResolver } from '../../mcp/agentExecutableResolver';
import type { CodexConfigStyleResolver } from '../../mcp/codexCompatibility';

const generation = 'generation-codex-smoke';
const sessionId = 'session-codex-smoke';
const routeId = Buffer.alloc(24, 0x31).toString('base64url');
const bearerToken = Buffer.alloc(32, 0x52).toString('base64url');

suite('Codex MCP dev smoke transaction', () => {
	test('auth 등록 뒤 structured config로 provider를 시작하고 activity 후 모두 정리한다', async () => {
		const fixture = createSmokeFixture();
		let spawnRequest: CodexProviderSpawnRequest | undefined;
		const succeeded = await runCodexMcpSmoke({
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
			'adapter_ready',
			'awaiting_activity',
			'activity_observed',
		]);
		assert.strictEqual(fixture.prepareCount, 1);
		assert.strictEqual(fixture.markProviderStartedCount, 1);
		assert.strictEqual(fixture.terminateCount, 1);
		assert.strictEqual(fixture.disposeCount, 1);
		assert.ok(spawnRequest !== undefined);
		assert.strictEqual(spawnRequest.executable, '/usr/local/bin/codex');
		assert.strictEqual(spawnRequest.cwd, '/workspace');
		assert.strictEqual(spawnRequest.args[0], '--ask-for-approval');
		assert.strictEqual(spawnRequest.args[2], 'exec');
		assert.strictEqual(spawnRequest.args.at(-1), CODEX_MCP_SMOKE_PROMPT);
		assert.strictEqual(spawnRequest.args.some(
			(argument) => argument.includes(bearerToken),
		), false);
		assert.strictEqual(spawnRequest.environment.CRISPY_MCP_TOKEN, bearerToken);
		assert.strictEqual(spawnRequest.environment.crispy_mcp_token, undefined);
		assert.strictEqual(spawnRequest.environment.ELECTRON_RUN_AS_NODE, undefined);
		assert.strictEqual(spawnRequest.environment.KEEP_ME, 'yes');
	});

	test('prepare failure는 provider와 credential config를 만들지 않고 안전하게 종료한다', async () => {
		const fixture = createSmokeFixture({
			prepareResult: {
				ok: false,
				failure: { reason: 'adapter_ready_timeout', retryable: true },
				providerAction: 'continue_without_mcp',
			},
		});
		let spawnCount = 0;
		const succeeded = await runCodexMcpSmoke({
			...fixture.options,
			spawnProvider: () => {
				spawnCount += 1;
				return fixture.provider;
			},
		});

		assert.strictEqual(succeeded, false);
		assert.strictEqual(spawnCount, 0);
		assert.deepStrictEqual(fixture.statuses, ['failed:adapter_ready_timeout']);
		assert.strictEqual(fixture.markProviderStartedCount, 0);
		assert.strictEqual(fixture.disposeCount, 1);
	});

	test('provider spawn throw는 raw error 없이 provider_unavailable로 정리한다', async () => {
		const fixture = createSmokeFixture();
		const succeeded = await runCodexMcpSmoke({
			...fixture.options,
			spawnProvider: () => {
				throw new Error(`spawn failed ${bearerToken}`);
			},
		});

		assert.strictEqual(succeeded, false);
		assert.deepStrictEqual(fixture.statuses, [
			'adapter_ready',
			'awaiting_activity',
			'failed:provider_unavailable',
		]);
		assert.strictEqual(fixture.statuses.join('').includes(bearerToken), false);
		assert.strictEqual(fixture.terminateCount, 0);
		assert.strictEqual(fixture.disposeCount, 1);
	});

	test('executable resolve failure는 provider를 만들지 않고 safe reason으로 정리한다', async () => {
		const fixture = createSmokeFixture();
		let spawnCount = 0;
		const succeeded = await runCodexMcpSmoke({
			...fixture.options,
			resolveExecutable: async () => ({
				ok: false,
				reason: 'provider_unavailable',
			}),
			spawnProvider: () => {
				spawnCount += 1;
				return fixture.provider;
			},
		});

		assert.strictEqual(succeeded, false);
		assert.strictEqual(spawnCount, 0);
		assert.deepStrictEqual(fixture.statuses, [
			'adapter_ready',
			'failed:provider_unavailable',
		]);
		assert.strictEqual(fixture.disposeCount, 1);
	});

	test('Windows cmd resolver 결과는 ComSpec one-shot request로 smoke한다', async () => {
		const fixture = createSmokeFixture();
		let spawnRequest: CodexProviderSpawnRequest | undefined;
		const succeeded = await runCodexMcpSmoke({
			...fixture.options,
			platform: 'win32',
			baseEnvironment: {
				ComSpec: 'C:\\Windows\\System32\\cmd.exe',
				PATH: 'C:\\npm',
			},
			resolveExecutable: async (providerId, options) => {
				assert.strictEqual(providerId, 'codex');
				assert.strictEqual(options?.platform, 'win32');
				return {
					ok: true,
					executable: {
						executable: 'C:\\npm\\codex.cmd',
						launcherKind: 'cmd-one-shot',
					},
				};
			},
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
		assert.ok(spawnRequest !== undefined);
		assert.strictEqual(spawnRequest.executable, 'C:\\Windows\\System32\\cmd.exe');
		assert.deepStrictEqual(spawnRequest.args.slice(0, 4), [
			'/d', '/s', '/v:off', '/c',
		]);
		assert.strictEqual(spawnRequest.windowsVerbatimArguments, true);
		assert.strictEqual(
			spawnRequest.environment.CRISPY_MCP_TOKEN,
			bearerToken,
		);
		assert.strictEqual(spawnRequest.args.some(
			(argument) => argument.includes(bearerToken),
		), false);
	});

	test('current runtime이 아니면 provider started를 표시하지 않고 stale로 정리한다', async () => {
		const fixture = createSmokeFixture({ runtimeGeneration: 'generation-stale' });
		const succeeded = await runCodexMcpSmoke({
			...fixture.options,
			spawnProvider: () => fixture.provider,
		});

		assert.strictEqual(succeeded, false);
		assert.deepStrictEqual(fixture.statuses, [
			'adapter_ready',
			'awaiting_activity',
			'failed:stale_session',
		]);
		assert.strictEqual(fixture.markProviderStartedCount, 0);
		assert.strictEqual(fixture.terminateCount, 1);
		assert.strictEqual(fixture.disposeCount, 1);
	});

	test('provider exit가 activity보다 먼저면 silence 추론 없이 관찰 사실만 보고한다', async () => {
		const fixture = createSmokeFixture();
		const succeededPromise = runCodexMcpSmoke({
			...fixture.options,
			spawnProvider: () => {
				setImmediate(() => fixture.exitProvider(1));
				return fixture.provider;
			},
		});
		const succeeded = await succeededPromise;

		assert.strictEqual(succeeded, false);
		assert.deepStrictEqual(fixture.statuses, [
			'adapter_ready',
			'awaiting_activity',
			'failed:provider_exited',
		]);
		assert.strictEqual(fixture.statuses.some(
			(status) => status.includes('timeout') || status.includes('handshake'),
		), false);
		assert.strictEqual(fixture.disposeCount, 1);
	});

	test('old generation event는 무시하고 current authenticated activity만 성공시킨다', async () => {
		const fixture = createSmokeFixture();
		const succeeded = await runCodexMcpSmoke({
			...fixture.options,
			spawnProvider: () => {
				setImmediate(() => {
					fixture.events.handle({
						type: 'session.crispyPingObserved',
						generation: 'generation-old',
						sessionId,
					});
					fixture.events.handle({
						type: 'session.mcpActivityObserved',
						generation,
						sessionId,
					});
					fixture.events.handle({
						type: 'session.crispyPingObserved',
						generation,
						sessionId,
					});
				});
				return fixture.provider;
			},
		});

		assert.strictEqual(succeeded, true);
		assert.strictEqual(
			fixture.statuses.filter((status) => status === 'activity_observed').length,
			1,
		);
	});

	test('abort는 제품 failure reason을 만들지 않고 smoke_cancelled로 정리한다', async () => {
		const fixture = createSmokeFixture();
		const controller = new AbortController();
		const succeededPromise = runCodexMcpSmoke({
			...fixture.options,
			signal: controller.signal,
			spawnProvider: () => {
				setImmediate(() => controller.abort());
				return fixture.provider;
			},
		});
		const succeeded = await succeededPromise;

		assert.strictEqual(succeeded, false);
		assert.strictEqual(fixture.statuses.at(-1), 'failed:smoke_cancelled');
		assert.strictEqual(fixture.terminateCount, 1);
		assert.strictEqual(fixture.disposeCount, 1);
	});
});

suite('Codex MCP dev smoke launch contract', () => {
	test('공식 non-interactive 인자와 config를 shell 문자열 없이 보존한다', () => {
		const configArgs = Object.freeze([
			'--config',
			'mcp_servers.crispy_canvas_test.required=false',
		]);
		const args = createCodexSmokeArgs(configArgs);

		assert.deepStrictEqual(args, [
			'--ask-for-approval',
			'never',
			'exec',
			'--ephemeral',
			'--color',
			'never',
			'--sandbox',
			'read-only',
			...configArgs,
			CODEX_MCP_SMOKE_PROMPT,
		]);
	});

	test('provider stdout/stderr와 shell을 끄고 환경을 직접 전달한다', () => {
		const request: CodexProviderSpawnRequest = {
			executable: '/opt/codex',
			args: ['exec'],
			cwd: '/workspace',
			environment: { SAFE: 'value' },
			windowsVerbatimArguments: false,
		};
		const options = createCodexSmokeSpawnOptions(request);

		assert.strictEqual(options.cwd, '/workspace');
		assert.strictEqual(options.env, request.environment);
		assert.deepStrictEqual(options.stdio, ['ignore', 'ignore', 'ignore']);
		assert.strictEqual(options.shell, false);
		assert.strictEqual(options.windowsHide, true);
		assert.strictEqual(options.windowsVerbatimArguments, false);
	});
});

function createSmokeFixture(overrides: {
	readonly prepareResult?: McpPrepareResult;
	readonly runtimeGeneration?: string;
} = {}): {
	readonly options: {
		readonly supervisor: CodexSmokeSupervisor;
		readonly events: CodexSmokeEventObserver;
		readonly sessionId: string;
		readonly cwd: string;
		readonly baseEnvironment: NodeJS.ProcessEnv;
		readonly randomBytes: (size: number) => Buffer;
		readonly resolveExecutable: AgentExecutableResolver;
		readonly resolveConfigStyle: CodexConfigStyleResolver;
		readonly terminateProvider: (provider: ChildProcess) => Promise<void>;
		readonly report: (status: CodexSmokeStatus) => void;
	};
	readonly events: CodexSmokeEventObserver;
	readonly provider: ChildProcess;
	readonly statuses: CodexSmokeStatus[];
	readonly prepareCount: number;
	readonly markProviderStartedCount: number;
	readonly terminateCount: number;
	readonly disposeCount: number;
	readonly exitProvider: (code: number) => void;
} {
	const connection = new McpConnectionDescriptor(
		generation,
		sessionId,
		`http://127.0.0.1:44123/mcp/${routeId}`,
		bearerToken,
	);
	const prepareResult: McpPrepareResult = overrides.prepareResult ?? {
		ok: true,
		connection,
	};
	const events = new CodexSmokeEventObserver(sessionId);
	const statuses: CodexSmokeStatus[] = [];
	let prepareCount = 0;
	let markProviderStartedCount = 0;
	let terminateCount = 0;
	let disposeCount = 0;
	let exitCode: number | null = null;
	const providerEmitter = new EventEmitter();
	const provider = providerEmitter as unknown as ChildProcess;
	Object.defineProperties(provider, {
		pid: { value: 12345, configurable: true },
		exitCode: { get: () => exitCode, configurable: true },
		signalCode: { get: () => null, configurable: true },
	});
	const supervisor: CodexSmokeSupervisor = {
		prepareSession: async () => {
			prepareCount += 1;
			return prepareResult;
		},
		getSessionRuntime: () => ({
			generation: overrides.runtimeGeneration ?? generation,
			markProviderStarted: () => {
				markProviderStartedCount += 1;
				return true;
			},
		}),
		dispose: async () => {
			disposeCount += 1;
		},
	};
	const options = {
		supervisor,
		events,
		sessionId,
		cwd: '/workspace',
		baseEnvironment: {
			crispy_mcp_token: 'stale',
			ELECTRON_RUN_AS_NODE: '1',
			KEEP_ME: 'yes',
		},
		randomBytes: (size: number) => Buffer.alloc(size, 0x73),
		resolveExecutable: async () => Object.freeze({
			ok: true as const,
			executable: Object.freeze({
				executable: '/usr/local/bin/codex',
				launcherKind: 'direct' as const,
			}),
		}),
		resolveConfigStyle: async () => 'keyed-filters' as const,
		terminateProvider: async () => {
			terminateCount += 1;
		},
		report: (status: CodexSmokeStatus) => statuses.push(status),
	};
	return {
		options,
		events,
		provider,
		statuses,
		get prepareCount() { return prepareCount; },
		get markProviderStartedCount() { return markProviderStartedCount; },
		get terminateCount() { return terminateCount; },
		get disposeCount() { return disposeCount; },
		exitProvider: (code: number) => {
			exitCode = code;
			providerEmitter.emit('exit', code, null);
		},
	};
}
