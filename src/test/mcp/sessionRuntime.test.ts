import * as assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
	createMcpChildEnvironment,
	createMcpChildSpawnOptions,
	McpSessionRuntime,
	validateMcpHostRuntime,
	type McpChildSpawnRequest,
	type McpSessionRuntimeEvent,
} from '../../mcp/sessionRuntime';
import {
	createReadyFakeChild,
	FakeMcpChild,
} from './support/fakeMcpChild';

const hostRuntime = Object.freeze({
	platform: 'darwin',
	arch: 'arm64',
	nodeVersion: '24.1.0',
	executablePath: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
});

suite('MCP session runtime lifecycle', () => {
	test('child 환경에서 credential과 Node 실행 제어 변형을 제거한다', () => {
		const parent = {
			PATH: '/bin',
			CRISPY_MCP_TOKEN: 'first-secret',
			crispy_mcp_token: 'second-secret',
			CrIsPy_McP_ToKeN: 'third-secret',
			CRISPY_MCP_GENERATION: 'stale-generation',
			ELECTRON_RUN_AS_NODE: '0',
			NODE_OPTIONS: '--require /workspace/hook.js',
			Node_Path: '/workspace/node_modules',
		};
		const snapshot = { ...parent };
		const child = createMcpChildEnvironment(parent, 'generation-fresh');

		assert.deepStrictEqual(parent, snapshot);
		assert.strictEqual(child.PATH, '/bin');
		assert.strictEqual(child.ELECTRON_RUN_AS_NODE, '1');
		assert.strictEqual(child.CRISPY_MCP_GENERATION, 'generation-fresh');
		const childNames = new Set(Object.keys(child).map((name) => name.toUpperCase()));
		assert.ok(!childNames.has('CRISPY_MCP_TOKEN'));
		assert.ok(!childNames.has('NODE_OPTIONS'));
		assert.ok(!childNames.has('NODE_PATH'));
	});

	test('child spawn은 standalone asset 디렉터리를 cwd로 고정한다', () => {
		const childEntryPath = path.join(
			process.cwd(),
			'installed-extension',
			'dist',
			'mcp-server.mjs',
		);
		const environment = { ELECTRON_RUN_AS_NODE: '1' };
		const options = createMcpChildSpawnOptions({
			executablePath: process.execPath,
			childEntryPath,
			generation: 'generation-spawn-options',
			environment,
		});

		assert.strictEqual(options.cwd, path.dirname(childEntryPath));
		assert.strictEqual(options.env, environment);
		assert.deepStrictEqual(options.stdio, ['ignore', 'ignore', 'ignore', 'ipc']);
		assert.strictEqual(options.shell, false);
		assert.strictEqual(options.windowsHide, true);
	});

	test('지원 target과 runtime만 허용하고 안전한 failure reason을 반환한다', () => {
		assert.strictEqual(validateMcpHostRuntime(hostRuntime), undefined);
		assert.strictEqual(validateMcpHostRuntime({
			...hostRuntime,
			platform: 'linux',
			arch: 'x64',
			glibcVersionRuntime: '2.28',
		}), undefined);
		assert.strictEqual(validateMcpHostRuntime({
			...hostRuntime,
			platform: 'linux',
			arch: 'x64',
		}), 'unsupported_runtime');
		assert.strictEqual(validateMcpHostRuntime({
			...hostRuntime,
			platform: 'linux',
			arch: 'x64',
			glibcVersionRuntime: '',
		}), 'unsupported_runtime');
		assert.strictEqual(validateMcpHostRuntime({
			...hostRuntime, platform: 'darwin', arch: 'x64',
		}), 'unsupported_platform');
		assert.strictEqual(validateMcpHostRuntime({
			...hostRuntime, nodeVersion: '20.19.0',
		}), 'unsupported_runtime');
		assert.strictEqual(validateMcpHostRuntime({
			...hostRuntime, executablePath: '',
		}), 'unsupported_runtime');
	});

	test('Linux musl은 credential 생성과 child spawn 전에 fail-open한다', async () => {
		let randomCalls = 0;
		let spawnCalls = 0;
		const runtime = createRuntime({
			hostRuntime: {
				...hostRuntime,
				platform: 'linux',
				arch: 'x64',
			},
			randomBytes: (size) => {
				randomCalls += 1;
				return Buffer.alloc(size);
			},
			spawnChild: () => {
				spawnCalls += 1;
				throw new Error('must not spawn');
			},
		});

		const result = await runtime.start();

		assert.deepStrictEqual(result, {
			ok: false,
			failure: { reason: 'unsupported_runtime', retryable: false },
			providerAction: 'continue_without_mcp',
		});
		assert.strictEqual(randomCalls, 0);
		assert.strictEqual(spawnCalls, 0);
		assert.strictEqual(runtime.lifecycle, 'stopped');
	});

	test('spawn throw는 adapter_start_failed이고 child credential을 env/argv로 만들지 않는다', async () => {
		let spawnRequest: McpChildSpawnRequest | undefined;
		const runtime = createRuntime({
			spawnChild: (request) => {
				spawnRequest = request;
				throw new Error('raw spawn error with path');
			},
			parentEnvironment: { CRISPY_MCP_TOKEN: 'parent-secret' },
		});
		const result = await runtime.start();

		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.deepStrictEqual(result.failure, {
				reason: 'adapter_start_failed', retryable: true,
			});
		}
		assert.ok(spawnRequest !== undefined);
		assert.deepStrictEqual(
			Object.keys(spawnRequest.environment).sort(),
			['CRISPY_MCP_GENERATION', 'ELECTRON_RUN_AS_NODE'],
		);
		assert.strictEqual(runtime.lifecycle, 'stopped');
	});

	test('credential CSPRNG failure를 raw rejection 없이 adapter_start_failed로 정리한다', async () => {
		let spawnCalls = 0;
		const runtime = createRuntime({
			randomBytes: () => {
				throw new Error('raw CSPRNG failure');
			},
			spawnChild: () => {
				spawnCalls += 1;
				throw new Error('must not spawn');
			},
		});
		const result = await runtime.start();
		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.failure.reason, 'adapter_start_failed');
		}
		assert.strictEqual(spawnCalls, 0);
		assert.strictEqual(runtime.lifecycle, 'stopped');
	});

	test('ready timeout은 adapter_ready_timeout으로 rollback하고 shutdown 뒤 kill한다', async () => {
		const child = new FakeMcpChild({
			generation: 'generation-runtime',
			announceReady: false,
			exitOnShutdown: false,
		});
		const runtime = createRuntime({
			spawnChild: () => child.asChildProcess(),
			timeouts: { readyMs: 5, shutdownMs: 5, killMs: 20 },
		});
		const result = await runtime.start();

		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.strictEqual(result.failure.reason, 'adapter_ready_timeout');
		}
		assert.deepStrictEqual(child.sent.map((message) => message.type), [
			'server.shutdown',
		]);
		assert.deepStrictEqual(child.killSignals, ['SIGKILL']);
		assert.strictEqual(runtime.lifecycle, 'stopped');
	});

	test('register failure와 ACK timeout은 auth_registration_failed로 revoke rollback한다', async () => {
		for (const mode of ['failure', 'timeout'] as const) {
			const child = createReadyFakeChild({
				generation: `generation-${mode}`,
				port: mode === 'failure' ? 42_001 : 42_002,
				failRegistration: mode === 'failure',
				acknowledgeRegistration: mode !== 'timeout',
			});
			const runtime = createRuntime({
				generation: `generation-${mode}`,
				spawnChild: () => child.asChildProcess(),
				timeouts: { registrationMs: 5 },
			});
			const result = await runtime.start();

			assert.strictEqual(result.ok, false);
			if (!result.ok) {
				assert.strictEqual(result.failure.reason, 'auth_registration_failed');
			}
			assert.deepStrictEqual(child.sent.map((message) => message.type), [
				'auth.register', 'auth.revoke', 'server.shutdown',
			]);
			assert.strictEqual(runtime.lifecycle, 'stopped');
		}
	});

	test('ready 대기 cancellation은 stale provider-ready 결과나 event를 만들지 않는다', async () => {
		const child = new FakeMcpChild({
			generation: 'generation-runtime', announceReady: false,
		});
		const events: McpSessionRuntimeEvent[] = [];
		const runtime = createRuntime({
			spawnChild: () => child.asChildProcess(),
			onEvent: (event) => events.push(event),
		});
		const starting = runtime.start();
		const cleanup = runtime.stop();
		child.announceReady();

		const result = await starting;
		await cleanup;
		assert.strictEqual(result.ok, false);
		assert.deepStrictEqual(events, []);
		assert.strictEqual(runtime.lifecycle, 'stopped');
	});

	test('registered ACK와 경쟁한 cancellation도 connection을 공개하지 않는다', async () => {
		let runtime: McpSessionRuntime;
		const child = createReadyFakeChild({
			generation: 'generation-runtime', port: 42_003,
		});
		child.on('message', (message: unknown) => {
			if ((message as { type?: string }).type === 'auth.registered') {
				void runtime.stop();
			}
		});
		runtime = createRuntime({ spawnChild: () => child.asChildProcess() });

		const result = await runtime.start();
		assert.strictEqual(result.ok, false);
		assert.strictEqual(runtime.lifecycle, 'stopped');
	});

	test('ready→register→registered 후 Host-only descriptor를 만들고 cleanup을 공유한다', async () => {
		const child = createReadyFakeChild({
			generation: 'generation-runtime', port: 42_004,
		});
		const runtime = createRuntime({ spawnChild: () => child.asChildProcess() });
		const firstStart = runtime.start();
		assert.strictEqual(runtime.start(), firstStart);
		const result = await firstStart;
		assert.strictEqual(result.ok, true);
		if (!result.ok) {
			return;
		}

		const token = result.connection.withBearerToken((value) => value);
		assert.ok(token.length >= 43);
		assert.ok(!JSON.stringify(result.connection).includes(token));
		assert.ok(!Object.keys(result.connection).includes('token'));
		assert.strictEqual(runtime.lifecycle, 'running');
		const defaultRegister = child.sent.find(
			(message) => message.type === 'auth.register',
		);
		assert.ok(defaultRegister?.type === 'auth.register');
		assert.strictEqual(defaultRegister.agentActivityCompatible, false);

		const firstStop = runtime.stop();
		assert.strictEqual(runtime.stop(), firstStop);
		await firstStop;
		assert.deepStrictEqual(child.sent.map((message) => message.type), [
			'auth.register', 'auth.revoke', 'server.shutdown',
		]);
		assert.throws(() => result.connection.withBearerToken((value) => value));
		assert.strictEqual(runtime.lifecycle, 'stopped');
		assert.strictEqual(child.listenerCount('message'), 0);
		assert.strictEqual(child.listenerCount('error'), 0);
		assert.strictEqual(child.listenerCount('exit'), 0);
		const stoppedRestart = await runtime.start();
		assert.strictEqual(stoppedRestart.ok, false);
	});

	test('Host-owned explicit Activity capability만 auth.register에 immutable 전달한다', async () => {
		const child = createReadyFakeChild({
			generation: 'generation-runtime', port: 42_005,
		});
		const runtime = createRuntime({
			spawnChild: () => child.asChildProcess(),
			agentActivityCompatible: true,
		});
		assert.strictEqual((await runtime.start()).ok, true);
		const register = child.sent.find((message) => message.type === 'auth.register');
		assert.ok(register?.type === 'auth.register');
		assert.strictEqual(register.agentActivityCompatible, true);
		await runtime.stop();
	});

	test('revoke ACK와 shutdown timeout 뒤에도 kill fallback과 listener 정리를 완료한다', async () => {
		const child = createReadyFakeChild({
			generation: 'generation-runtime',
			port: 42_009,
			acknowledgeRevoke: false,
			exitOnShutdown: false,
		});
		const runtime = createRuntime({
			spawnChild: () => child.asChildProcess(),
			timeouts: { revokeMs: 5, shutdownMs: 5, killMs: 20 },
		});
		assert.strictEqual((await runtime.start()).ok, true);
		await runtime.stop();

		assert.deepStrictEqual(child.sent.map((message) => message.type), [
			'auth.register', 'auth.revoke', 'server.shutdown',
		]);
		assert.deepStrictEqual(child.killSignals, ['SIGKILL']);
		assert.strictEqual(child.listenerCount('message'), 0);
		assert.strictEqual(child.listenerCount('exit'), 0);
		assert.strictEqual(runtime.lifecycle, 'stopped');
	});

	test('cleanup request ID 생성 실패도 shutdown과 listener 정리를 건너뛰지 않는다', async () => {
		let requestIndex = 0;
		const child = createReadyFakeChild({
			generation: 'generation-runtime', port: 42_011,
		});
		const runtime = createRuntime({
			spawnChild: () => child.asChildProcess(),
			createRequestId: () => {
				requestIndex += 1;
				return requestIndex === 2
					? 'invalid request id'
					: `request-${requestIndex}`;
			},
		});
		assert.strictEqual((await runtime.start()).ok, true);
		await runtime.stop();
		assert.deepStrictEqual(child.sent.map((message) => message.type), [
			'auth.register', 'server.shutdown',
		]);
		assert.strictEqual(child.listenerCount('message'), 0);
		assert.strictEqual(runtime.lifecycle, 'stopped');
	});

	test('stale generation/request ACK를 무시하고 current activity를 한 번만 전달한다', async () => {
		const child = createReadyFakeChild({
			generation: 'generation-runtime',
			port: 42_005,
			acknowledgeRegistration: false,
		});
		const events: McpSessionRuntimeEvent[] = [];
		const runtime = createRuntime({
			spawnChild: () => child.asChildProcess(),
			onEvent: (event) => events.push(event),
		});
		const starting = runtime.start();
		await waitUntil(() => child.sent.some((message) => message.type === 'auth.register'));
		const register = child.sent.find(
			(message) => message.type === 'auth.register',
		);
		assert.ok(register?.type === 'auth.register');
		child.emitMessage({
			type: 'auth.registered',
			requestId: register.requestId,
			generation: 'generation-stale',
			sessionId: register.sessionId,
		});
		child.emitMessage({
			type: 'auth.registered',
			requestId: 'request-stale',
			generation: register.generation,
			sessionId: register.sessionId,
		});
		child.emitMessage({
			type: 'operation.failed',
			requestId: register.requestId,
			generation: register.generation,
			sessionId: 'session-other',
			reason: 'auth_registration_failed',
		});
		child.emitMessage({
			type: 'operation.failed',
			requestId: register.requestId,
			generation: register.generation,
			sessionId: register.sessionId,
			reason: 'auth_revoke_failed',
		});
		child.emitMessage({
			type: 'auth.registered',
			requestId: register.requestId,
			generation: register.generation,
			sessionId: register.sessionId,
		});
		assert.strictEqual((await starting).ok, true);

		child.emitMessage({
			type: 'session.mcpActivityObserved',
			generation: 'generation-stale',
			sessionId: 'session-runtime',
		});
		child.emitMessage({
			type: 'session.mcpActivityObserved',
			generation: 'generation-runtime',
			sessionId: 'session-other',
		});
		for (let index = 0; index < 2; index += 1) {
			child.emitMessage({
				type: 'session.mcpActivityObserved',
				generation: 'generation-runtime',
				sessionId: 'session-runtime',
			});
		}
		child.emitMessage({
			type: 'session.crispyPingObserved',
			generation: 'generation-stale',
			sessionId: 'session-runtime',
		});
		child.emitMessage({
			type: 'session.crispyPingObserved',
			generation: 'generation-runtime',
			sessionId: 'session-other',
		});
		for (let index = 0; index < 2; index += 1) {
			child.emitMessage({
				type: 'session.crispyPingObserved',
				generation: 'generation-runtime',
				sessionId: 'session-runtime',
			});
		}
		assert.deepStrictEqual(events.map((event) => event.type), [
			'session.mcpActivityObserved',
			'session.crispyPingObserved',
		]);
		await runtime.stop();
	});

	test('provider 시작 전 crash는 fail-open이고 자동 restart하지 않는다', async () => {
		let spawnCount = 0;
		let providerTerminationCalls = 0;
		const events: McpSessionRuntimeEvent[] = [];
		const child = createReadyFakeChild({
			generation: 'generation-runtime', port: 42_006,
		});
		const runtime = createRuntime({
			spawnChild: () => {
				spawnCount += 1;
				return child.asChildProcess();
			},
			onEvent: (event) => events.push(event),
		});
		const result = await runtime.start();
		assert.strictEqual(result.ok, true);
		child.exit(1, null);
		await waitUntil(() => runtime.lifecycle === 'crashed');

		const failure = events.find((event) => event.type === 'runtime.failure');
		assert.ok(failure?.type === 'runtime.failure');
		assert.strictEqual(failure.failure.reason, 'adapter_exited');
		assert.strictEqual(failure.providerStarted, false);
		assert.strictEqual(failure.providerAction, 'continue_without_mcp');
		assert.strictEqual(providerTerminationCalls, 0);
		assert.strictEqual(spawnCount, 1);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.strictEqual(spawnCount, 1);
		providerTerminationCalls += 0;
	});

	test('provider 시작 후 crash는 provider를 유지하고 adapter_exited만 emit한다', async () => {
		const events: McpSessionRuntimeEvent[] = [];
		const child = createReadyFakeChild({
			generation: 'generation-runtime', port: 42_007,
		});
		const runtime = createRuntime({
			spawnChild: () => child.asChildProcess(),
			onEvent: (event) => events.push(event),
		});
		assert.strictEqual((await runtime.start()).ok, true);
		assert.strictEqual(runtime.markProviderStarted(), true);
		child.exit(1, null);
		await waitUntil(() => runtime.lifecycle === 'crashed');

		assert.strictEqual(events.length, 1);
		const failure = events[0];
		assert.strictEqual(failure.type, 'runtime.failure');
		if (failure.type === 'runtime.failure') {
			assert.strictEqual(failure.failure.reason, 'adapter_exited');
			assert.strictEqual(failure.providerStarted, true);
			assert.strictEqual(failure.providerAction, 'keep_running');
		}
	});

	test('exit 확인 전 child error도 crash로 보고 살아 있는 child를 shutdown한다', async () => {
		const events: McpSessionRuntimeEvent[] = [];
		const child = createReadyFakeChild({
			generation: 'generation-runtime', port: 42_012,
		});
		const runtime = createRuntime({
			spawnChild: () => child.asChildProcess(),
			onEvent: (event) => events.push(event),
		});
		assert.strictEqual((await runtime.start()).ok, true);
		child.emit('error', new Error('raw child error'));
		await waitUntil(() => child.sent.some(
			(message) => message.type === 'server.shutdown',
		));
		assert.strictEqual(runtime.lifecycle, 'crashed');
		assert.deepStrictEqual(child.sent.map((message) => message.type), [
			'auth.register', 'auth.revoke', 'server.shutdown',
		]);
		assert.deepStrictEqual(events.map((event) => event.type), ['runtime.failure']);
	});

	test('duplicate server.ready는 protocol violation으로 current runtime을 crash 처리한다', async () => {
		const events: McpSessionRuntimeEvent[] = [];
		const child = createReadyFakeChild({
			generation: 'generation-runtime', port: 42_010,
		});
		const runtime = createRuntime({
			spawnChild: () => child.asChildProcess(),
			onEvent: (event) => events.push(event),
		});
		assert.strictEqual((await runtime.start()).ok, true);
		child.announceReady();
		await waitUntil(() => runtime.lifecycle === 'crashed');
		assert.deepStrictEqual(events.map((event) => event.type), ['runtime.failure']);
	});

	test('intentional shutdown exit는 adapter_exited를 emit하지 않는다', async () => {
		const events: McpSessionRuntimeEvent[] = [];
		const child = createReadyFakeChild({
			generation: 'generation-runtime', port: 42_008,
		});
		const runtime = createRuntime({
			spawnChild: () => child.asChildProcess(),
			onEvent: (event) => events.push(event),
		});
		assert.strictEqual((await runtime.start()).ok, true);
		await runtime.stop();
		assert.deepStrictEqual(events, []);
		assert.strictEqual(runtime.lifecycle, 'stopped');
	});
});

function createRuntime(overrides: Partial<ConstructorParameters<
	typeof McpSessionRuntime
>[0]> = {}): McpSessionRuntime {
	let requestIndex = 0;
	return new McpSessionRuntime({
		generation: 'generation-runtime',
		sessionId: 'session-runtime',
		childEntryPath: '/extension/dist/mcp-server.mjs',
		hostRuntime,
		timeouts: {
			readyMs: 100,
			registrationMs: 100,
			revokeMs: 20,
			shutdownMs: 20,
			killMs: 20,
		},
		createRequestId: () => `request-${++requestIndex}`,
		...overrides,
	});
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('test condition timed out');
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}
