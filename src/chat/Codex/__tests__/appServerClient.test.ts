import * as assert from 'node:assert';
import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
	CodexAppServerClient,
	CodexAppServerRpcError,
	codexProtocolCliVersion,
	createCodexClientInfo,
	type CodexAppServerClientOptions,
} from '../appServerClient';
import type { CodexInboundMessage } from '../runtimeValidation';

interface FakeHarness {
	/** 테스트에서 app-server stdout과 stderr를 제어하는 process다. */
	process: FakeAppServerProcess;
	/** Host가 stdin으로 전송한 JSON 메시지 순서다. */
	received: Array<Record<string, unknown>>;
	/** 구조화된 Crispy Output Channel 로그 원문이다. */
	logs: string[];
	/** runtime validation을 통과해 callback으로 전달된 메시지다. */
	inbound: CodexInboundMessage[];
	/** 테스트 옵션으로 생성된 client다. */
	client: CodexAppServerClient;
}

class FakeAppServerProcess extends EventEmitter {
	public readonly stdin = new PassThrough();
	public readonly stdout = new PassThrough();
	public readonly stderr = new PassThrough();
	public readonly pid = 42_424;
	public exitCode: number | null = null;
	public signalCode: NodeJS.Signals | null = null;
	private closed = false;

	public kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
		this.close(null, signal);
		return true;
	}

	public close(code: number | null, signal: NodeJS.Signals | null = null): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.exitCode = code;
		this.signalCode = signal;
		this.stdout.end();
		this.stderr.end();
		this.stdin.destroy();
		queueMicrotask(() => this.emit('close', code, signal));
	}
}

suite('CodexAppServerClient', () => {
	test('manifest metadata와 고정 capability로 initialize 후 initialized를 보낸다', async () => {
		const harness = createHarness();
		const state = await harness.client.start();

		assert.strictEqual(state.phase, 'ready');
		assert.strictEqual(state.cliVersion, codexProtocolCliVersion);
		assert.strictEqual(state.serverUserAgent, 'fake-app-server');
		assert.deepStrictEqual(harness.received.slice(0, 2), [
			{
				id: 'test-1',
				method: 'initialize',
				params: {
					clientInfo: {
						name: 'crispy-test',
						title: 'Crispy Test',
						version: '1.2.3',
					},
					capabilities: {
						experimentalApi: true,
						requestAttestation: false,
					},
				},
			},
			{ method: 'initialized' },
		]);

		const records = parseLogRecords(harness.logs);
		assert.ok(records.some((record) => record.direction === 'hostToServer'
			&& record.kind === 'request'
			&& record.method === 'initialize'));
		assert.ok(records.some((record) => record.direction === 'serverToHost'
			&& record.kind === 'response'
			&& record.requestId === 'test-1'));
		assert.ok(records.some((record) => record.direction === 'hostToServer'
			&& record.kind === 'notification'
			&& record.method === 'initialized'));

		await harness.client.stop();
		assert.strictEqual(harness.client.state.phase, 'stopped');
	});

	test('분할 JSONL, 잘못된 JSON, 알 수 없는 method와 stderr를 서로 분리한다', async () => {
		const harness = createHarness();
		await harness.client.start();

		harness.process.stdout.write('{not-json}\n');
		const notification = JSON.stringify({
			method: 'future/notification',
			params: { threadId: 'thread-1' },
		});
		harness.process.stdout.write(notification.slice(0, 13));
		harness.process.stdout.write(`${notification.slice(13)}\n`);
		harness.process.stdout.write(`${JSON.stringify({
			id: 'server-request-1',
			method: 'future/request',
			params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' },
		})}\n`);
		harness.process.stdout.write(`${JSON.stringify({
			method: 'item/started',
			params: {
				threadId: 'thread-1',
				turnId: 'turn-1',
				item: { id: 'nested-item-1', type: 'agentMessage' },
			},
		})}\n`);
		harness.process.stderr.write('fake warning\n');

		assert.ok(harness.inbound.some((message) => message.kind === 'notification'
			&& message.method === 'future/notification'));
		assert.ok(harness.inbound.some((message) => message.kind === 'request'
			&& message.method === 'future/request'));
		const records = parseLogRecords(harness.logs);
		assert.ok(records.some((record) => record.kind === 'parseError'
			&& record.raw === '{not-json}'));
		assert.ok(records.some((record) => record.kind === 'notification'
			&& record.threadId === 'thread-1'));
		assert.ok(records.some((record) => record.kind === 'request'
			&& record.turnId === 'turn-1'
			&& record.itemId === 'item-1'));
		assert.ok(records.some((record) => record.method === 'item/started'
			&& record.itemId === 'nested-item-1'));
		assert.ok(records.some((record) => record.kind === 'stderr'
			&& record.raw === 'fake warning\n'));

		await harness.client.stop();
	});

	test('request ID별 성공과 오류 응답을 올바른 Promise에 연결한다', async () => {
		const harness = createHarness((message, process) => {
			if (message.method !== 'thread/start') {
				return;
			}
			const id = message.id;
			if (id === 'request-success') {
				process.stdout.write(`${JSON.stringify({ id, result: { ok: true } })}\n`);
			} else {
				process.stdout.write(`${JSON.stringify({
					id,
					error: { code: -32_001, message: 'request failed', data: { retry: false } },
				})}\n`);
			}
		});
		await harness.client.start();

		const result = await harness.client.request<{ ok: boolean }>({
			id: 'request-success',
			method: 'thread/start',
			params: {},
		});
		assert.deepStrictEqual(result, { ok: true });
		await assert.rejects(
			harness.client.request({
				id: 'request-failure',
				method: 'thread/start',
				params: {},
			}),
			(error: unknown) => error instanceof CodexAppServerRpcError
				&& error.code === -32_001
				&& error.message === 'request failed',
		);
		assert.strictEqual(harness.client.pendingRequestCount, 0);

		await harness.client.stop();
	});

	test('응답 없는 요청을 설정된 제한 시간 뒤 pending에서 제거한다', async () => {
		const requestTimeoutMs = 20;
		const harness = createHarness(undefined, {}, { requestTimeoutMs });
		await harness.client.start();

		await assert.rejects(
			harness.client.request({
				id: 'request-timeout',
				method: 'thread/start',
				params: {},
			}),
			new RegExp(`${requestTimeoutMs}ms 안에 응답하지 않았습니다`),
		);
		assert.strictEqual(harness.client.pendingRequestCount, 0);
		assert.ok(parseLogRecords(harness.logs).some((record) =>
			record.kind === 'lifecycle'
			&& record.requestId === 'request-timeout'
			&& record.method === 'thread/start'));

		await harness.client.stop();
	});

	test('종료 중 start 요청을 종료 완료 뒤 하나의 새 연결로 직렬화한다', async () => {
		const processes = [new FakeAppServerProcess(), new FakeAppServerProcess()];
		const received: Array<Record<string, unknown>> = [];
		for (const process of processes) {
			bindFakeAppServer(process, received);
		}
		let spawnCount = 0;
		let releaseTermination: (() => void) | undefined;
		const terminationGate = new Promise<void>((resolve) => {
			releaseTermination = resolve;
		});
		const states: string[] = [];
		const client = new CodexAppServerClient({
			clientInfo: createCodexClientInfo('publisher.crispy-test', {
				name: 'crispy-test',
				displayName: 'Crispy Test',
				version: '1.2.3',
			}),
			outputWriter: { appendLine: () => undefined },
			requestIdPrefix: 'restart',
			onConnectionStateChanged: (state) => states.push(state.phase),
			dependencies: {
				spawnProcess: () => {
					const process = processes[spawnCount];
					assert.ok(process, '예상보다 많은 app-server process가 생성됐습니다.');
					spawnCount += 1;
					return process as unknown as ChildProcessWithoutNullStreams;
				},
				readCliVersion: async () => ({
					version: codexProtocolCliVersion,
					stdout: `codex-cli ${codexProtocolCliVersion}\n`,
					stderr: '',
				}),
				terminateProcessTree: async (child) => {
					await terminationGate;
					(child as unknown as FakeAppServerProcess).close(0);
				},
			},
		});

		await client.start();
		const stopPromise = client.stop();
		await Promise.resolve();
		assert.strictEqual(client.state.phase, 'stopping');

		let restartSettled = false;
		const restartPromise = client.start().then((state) => {
			restartSettled = true;
			return state;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.strictEqual(restartSettled, false);
		assert.strictEqual(spawnCount, 1);

		releaseTermination?.();
		await stopPromise;
		const restartedState = await restartPromise;
		assert.strictEqual(restartedState.phase, 'ready');
		assert.strictEqual(spawnCount, 2);
		assert.ok(states.includes('stopping'));

		await client.stop();
	});

	test('비정상 프로세스 종료 시 모든 pending request를 거부하고 failed가 된다', async () => {
		const harness = createHarness();
		await harness.client.start();

		const pending = harness.client.request({
			id: 'pending-request',
			method: 'thread/start',
			params: {},
		});
		harness.process.close(7);

		await assert.rejects(pending, /exitCode=7/);
		assert.strictEqual(harness.client.pendingRequestCount, 0);
		assert.strictEqual(harness.client.state.phase, 'failed');
		assert.match(harness.client.state.error ?? '', /exitCode=7/);
	});

	test('CLI 버전 차이는 경고만 남기고 handshake를 계속한다', async () => {
		const harness = createHarness(undefined, {
			readCliVersion: async () => ({
				version: '9.9.9',
				stdout: 'codex-cli 9.9.9\n',
				stderr: '',
			}),
		});

		const state = await harness.client.start();
		assert.strictEqual(state.phase, 'ready');
		assert.strictEqual(state.cliVersion, '9.9.9');
		assert.ok(parseLogRecords(harness.logs).some((record) =>
			typeof record.raw === 'string' && record.raw.includes('version mismatch')));

		await harness.client.stop();
	});
});

function createHarness(
	onMessage?: (message: Record<string, unknown>, process: FakeAppServerProcess) => void,
	dependencyOverrides: NonNullable<CodexAppServerClientOptions['dependencies']> = {},
	clientOverrides: Pick<Partial<CodexAppServerClientOptions>, 'requestTimeoutMs'> = {},
): FakeHarness {
	const process = new FakeAppServerProcess();
	const received: Array<Record<string, unknown>> = [];
	const logs: string[] = [];
	const inbound: CodexInboundMessage[] = [];
	bindFakeAppServer(process, received, onMessage);

	const client = new CodexAppServerClient({
		clientInfo: createCodexClientInfo('publisher.crispy-test', {
			name: 'crispy-test',
			displayName: 'Crispy Test',
			version: '1.2.3',
		}),
		outputWriter: { appendLine: (line) => logs.push(line) },
		requestIdPrefix: 'test',
		logClock: () => new Date('2026-08-06T00:00:00.000Z'),
		onMessage: (message) => inbound.push(message),
		...clientOverrides,
		dependencies: {
			spawnProcess: () => process as unknown as ChildProcessWithoutNullStreams,
			readCliVersion: async () => ({
				version: codexProtocolCliVersion,
				stdout: `codex-cli ${codexProtocolCliVersion}\n`,
				stderr: '',
			}),
			terminateProcessTree: async () => process.close(0),
			...dependencyOverrides,
		},
	});

	return { process, received, logs, inbound, client };
}

function bindFakeAppServer(
	process: FakeAppServerProcess,
	received: Array<Record<string, unknown>>,
	onMessage?: (message: Record<string, unknown>, process: FakeAppServerProcess) => void,
): void {
	let stdinBuffer = '';
	process.stdin.on('data', (chunk: Buffer | string) => {
		stdinBuffer += chunk.toString();
		let newlineIndex = stdinBuffer.indexOf('\n');
		while (newlineIndex !== -1) {
			const raw = stdinBuffer.slice(0, newlineIndex);
			stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
			const message = JSON.parse(raw) as Record<string, unknown>;
			received.push(message);
			if (message.method === 'initialize') {
				const response = `${JSON.stringify({
					id: message.id,
					result: {
						userAgent: 'fake-app-server',
						codexHome: '/tmp/codex-home',
						platformFamily: 'unix',
						platformOs: 'macos',
					},
				})}\n`;
				process.stdout.write(response.slice(0, 9));
				process.stdout.write(response.slice(9));
			} else {
				onMessage?.(message, process);
			}
			newlineIndex = stdinBuffer.indexOf('\n');
		}
	});
}

function parseLogRecords(logs: readonly string[]): Array<Record<string, unknown>> {
	return logs.map((line) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>);
}
