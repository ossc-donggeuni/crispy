import * as assert from 'node:assert/strict';
import {
	McpAdapterSupervisor,
	McpConnectionDescriptor,
	McpSessionRuntime,
	type McpAdapterSupervisorOptions,
	type McpSessionRuntimeEvent,
	type McpSessionRuntimeOptions,
	type SupervisorRuntimeEvent,
} from '../../mcp';
import {
	createReadyFakeChild,
	type FakeMcpChild,
} from './support/fakeMcpChild';

const hostRuntime = Object.freeze({
	platform: 'darwin',
	arch: 'arm64',
	nodeVersion: '24.2.0',
	executablePath: '/extension-host/Electron',
});

suite('MCP adapter supervisor', () => {
	test('두 session의 child, port, route, token과 generation을 격리한다', async () => {
		const fixture = createSupervisorFixture();
		const [first, second] = await Promise.all([
			fixture.supervisor.prepareSession('session-one'),
			fixture.supervisor.prepareSession('session-two'),
		]);
		assert.strictEqual(first.ok, true);
		assert.strictEqual(second.ok, true);
		if (!first.ok || !second.ok) {
			return;
		}

		assert.strictEqual(fixture.children.length, 2);
		assert.notStrictEqual(fixture.children[0].pid, fixture.children[1].pid);
		assert.notStrictEqual(first.connection.generation, second.connection.generation);
		assert.notStrictEqual(first.connection.url, second.connection.url);
		assert.notStrictEqual(
			first.connection.withBearerToken((token) => token),
			second.connection.withBearerToken((token) => token),
		);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-one'),
			fixture.runtimes[0],
		);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-two'),
			fixture.runtimes[1],
		);
		assert.strictEqual(fixture.runtimes[0].lifecycle, 'running');
		assert.strictEqual(fixture.runtimes[1].lifecycle, 'running');
		await fixture.supervisor.dispose();
	});

	test('같은 session의 duplicate prepare는 하나의 Promise와 child를 공유한다', async () => {
		const fixture = createSupervisorFixture();
		const first = fixture.supervisor.prepareSession('session-one');
		const second = fixture.supervisor.prepareSession('session-one');

		assert.strictEqual(first, second);
		assert.strictEqual((await first).ok, true);
		assert.strictEqual(fixture.children.length, 1);
		await fixture.supervisor.dispose();
	});

	test('event envelope는 current exact runtime object를 frozen source로 전달한다', async () => {
		const fixture = createSupervisorFixture();
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		const runtime = fixture.runtimes[0];
		fixture.children[0].emitMessage({
			type: 'session.crispyPingObserved',
			generation: runtime.generation,
			sessionId: runtime.sessionId,
		});

		assert.strictEqual(fixture.events.length, 1);
		assert.strictEqual(Object.isFrozen(fixture.events[0]), true);
		assert.deepStrictEqual(Object.keys(fixture.events[0]), [
			'sourceRuntime', 'event',
		]);
		assert.strictEqual(fixture.events[0].sourceRuntime, runtime);
		assert.deepStrictEqual(fixture.events[0].event, {
			type: 'session.crispyPingObserved',
			generation: runtime.generation,
			sessionId: runtime.sessionId,
		});
		await fixture.supervisor.dispose();
	});

	test('agent Activity capability는 construction 때 immutable boolean으로 캡처한다', async () => {
		const disabled = createSupervisorFixture();
		(disabled.supervisorOptions as {
			agentActivityCompatible?: boolean;
		}).agentActivityCompatible = true;
		assert.strictEqual(
			(await disabled.supervisor.prepareSession('session-disabled')).ok,
			true,
		);
		const disabledRegister = disabled.children[0].sent.find(
			(message) => message.type === 'auth.register',
		);
		assert.ok(disabledRegister?.type === 'auth.register');
		assert.strictEqual(disabledRegister.agentActivityCompatible, false);
		await disabled.supervisor.dispose();

		const enabled = createSupervisorFixture({ agentActivityCompatible: true });
		(enabled.supervisorOptions as {
			agentActivityCompatible?: boolean;
		}).agentActivityCompatible = false;
		assert.strictEqual(
			(await enabled.supervisor.prepareSession('session-enabled')).ok,
			true,
		);
		const enabledRegister = enabled.children[0].sent.find(
			(message) => message.type === 'auth.register',
		);
		assert.ok(enabledRegister?.type === 'auth.register');
		assert.strictEqual(enabledRegister.agentActivityCompatible, true);
		await enabled.supervisor.dispose();
	});

	test('exact runtime retirement는 pending Promise를 memo하고 settlement 뒤 보존하지 않는다', async () => {
		const fixture = createSupervisorFixture();
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		const runtime = fixture.runtimes[0];
		const stopGate = deferRuntimeStop(runtime);
		const ownership = inspectSupervisorOwnership(fixture.supervisor);

		const firstRetirement = fixture.supervisor.retireExactRuntime(runtime);
		assert.strictEqual(
			fixture.supervisor.retireExactRuntime(runtime),
			firstRetirement,
		);
		assert.strictEqual(fixture.supervisor.getSessionRuntime('session-one'), undefined);
		assert.strictEqual(stopGate.calls, 1);
		assert.strictEqual(ownership.liveRuntimes.size, 1);
		assert.strictEqual(ownership.retirements.size, 1);

		stopGate.release();
		await firstRetirement;
		assert.strictEqual(ownership.liveRuntimes.size, 0);
		assert.strictEqual(ownership.retirements.size, 0);
		await fixture.supervisor.retireExactRuntime(runtime);
		assert.strictEqual(stopGate.calls, 1);
		await fixture.supervisor.dispose();
	});

	test('foreign runtime retirement는 current exact runtime에 영향 없는 no-op이다', async () => {
		const fixture = createSupervisorFixture();
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		const current = fixture.runtimes[0];
		const foreign = new McpSessionRuntime({
			generation: current.generation,
			sessionId: current.sessionId,
			childEntryPath: '/foreign/dist/mcp-server.mjs',
			hostRuntime,
		});
		let foreignStopCalls = 0;
		Object.defineProperty(foreign, 'stop', {
			value: (): Promise<void> => {
				foreignStopCalls += 1;
				return Promise.resolve();
			},
		});

		await fixture.supervisor.retireExactRuntime(foreign);
		assert.strictEqual(foreignStopCalls, 0);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-one'),
			current,
		);
		await fixture.supervisor.dispose();
	});

	test('factory가 다른 identity runtime을 반환하면 map에 넣지 않고 exact retire한다', async () => {
		let mismatchedRuntime: McpSessionRuntime | undefined;
		let stopCalls = 0;
		const supervisor = new McpAdapterSupervisor({
			extensionUri: { fsPath: '/installed/crispy' },
			createGeneration: () => 'generation-expected',
			createRuntime: (options) => {
				const runtime = new McpSessionRuntime({
					...options,
					sessionId: 'session-factory-substitute',
				});
				mismatchedRuntime = runtime;
				Object.defineProperty(runtime, 'stop', {
					value: (): Promise<void> => {
						stopCalls += 1;
						return Promise.resolve();
					},
				});
				return runtime;
			},
		});

		const result = await supervisor.prepareSession('session-expected');
		assert.strictEqual(result.ok, false);
		assert.ok(mismatchedRuntime !== undefined);
		await waitUntil(() => stopCalls === 1);
		assert.strictEqual(
			supervisor.getSessionRuntime('session-expected'),
			undefined,
		);
		const ownership = inspectSupervisorOwnership(supervisor);
		await waitUntil(() => ownership.liveRuntimes.size === 0);
		assert.strictEqual(ownership.retirements.size, 0);
		await supervisor.dispose();
	});

	test('start 중 runtime identity가 바뀌면 connection을 공개하지 않고 exact retire한다', async () => {
		let ownedRuntime: McpSessionRuntime | undefined;
		let stopCalls = 0;
		const supervisor = new McpAdapterSupervisor({
			extensionUri: { fsPath: '/installed/crispy' },
			createGeneration: () => 'generation-captured',
			createRuntime: (options) => {
				const runtime = new McpSessionRuntime(options);
				ownedRuntime = runtime;
				Object.defineProperty(runtime, 'start', {
					value: async () => {
						(runtime as unknown as { sessionId: string }).sessionId =
							'session-mutated';
						return Object.freeze({
							ok: true as const,
							connection: new McpConnectionDescriptor(
								'generation-captured',
								'session-mutated',
								'http://127.0.0.1:44000/mcp/route-mutated',
								't'.repeat(43),
							),
						});
					},
				});
				Object.defineProperty(runtime, 'stop', {
					value: (): Promise<void> => {
						stopCalls += 1;
						return Promise.resolve();
					},
				});
				return runtime;
			},
		});

		const result = await supervisor.prepareSession('session-captured');
		assert.strictEqual(result.ok, false);
		assert.ok(ownedRuntime !== undefined);
		assert.strictEqual(stopCalls, 1);
		assert.strictEqual(
			supervisor.getSessionRuntime('session-captured'),
			undefined,
		);
		await supervisor.dispose();
	});

	test('factory 내부 reentrant dispose도 그 factory가 만든 runtime settlement를 기다린다', async () => {
		let supervisor!: McpAdapterSupervisor;
		let disposeDuringFactory: Promise<void> | undefined;
		let releaseStop!: () => void;
		const stopGate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		let stopCalls = 0;
		supervisor = new McpAdapterSupervisor({
			extensionUri: { fsPath: '/installed/crispy' },
			createGeneration: () => 'generation-reentrant-dispose',
			createRuntime: (options) => {
				const runtime = new McpSessionRuntime(options);
				Object.defineProperty(runtime, 'stop', {
					value: (): Promise<void> => {
						stopCalls += 1;
						return stopGate;
					},
				});
				disposeDuringFactory = supervisor.dispose();
				return runtime;
			},
		});

		const prepare = await supervisor.prepareSession('session-reentrant');
		assert.strictEqual(prepare.ok, false);
		assert.ok(disposeDuringFactory !== undefined);
		assert.strictEqual(supervisor.dispose(), disposeDuringFactory);
		assert.strictEqual(stopCalls, 1);
		let disposeSettled = false;
		void disposeDuringFactory.then(() => {
			disposeSettled = true;
		});
		await nextTurn();
		assert.strictEqual(disposeSettled, false);

		releaseStop();
		await disposeDuringFactory;
		assert.strictEqual(disposeSettled, true);
		const ownership = inspectSupervisorOwnership(supervisor);
		assert.strictEqual(ownership.liveRuntimes.size, 0);
		assert.strictEqual(ownership.retirements.size, 0);
	});

	test('detached old runtime event는 replacement와 current prepare를 변경하지 않는다', async () => {
		const fixture = createSupervisorFixture();
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		const oldRuntime = fixture.runtimes[0];
		const oldStopGate = deferRuntimeStop(oldRuntime);
		const oldRetirement = fixture.supervisor.retireExactRuntime(oldRuntime);
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		const replacement = fixture.runtimes[1];
		const oldSink = fixture.runtimeEventSinks.get(oldRuntime);
		assert.ok(oldSink !== undefined);

		oldSink({
			type: 'session.crispyPingObserved',
			generation: oldRuntime.generation,
			sessionId: oldRuntime.sessionId,
		});
		assert.deepStrictEqual(fixture.events, []);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-one'),
			replacement,
		);

		oldStopGate.release();
		await oldRetirement;
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-one'),
			replacement,
		);
		await fixture.supervisor.dispose();
	});

	test('forged A→B envelope는 lookup 전에 A만 retire하고 B를 보존한다', async () => {
		const fixture = createSupervisorFixture();
		await Promise.all([
			fixture.supervisor.prepareSession('session-a'),
			fixture.supervisor.prepareSession('session-b'),
		]);
		const runtimeA = fixture.runtimes[0];
		const runtimeB = fixture.runtimes[1];
		const stopGateA = deferRuntimeStop(runtimeA);
		const sinkA = fixture.runtimeEventSinks.get(runtimeA);
		assert.ok(sinkA !== undefined);

		sinkA({
			type: 'session.crispyPingObserved',
			generation: runtimeB.generation,
			sessionId: runtimeB.sessionId,
		});
		assert.strictEqual(fixture.supervisor.getSessionRuntime('session-a'), undefined);
		assert.strictEqual(fixture.supervisor.getSessionRuntime('session-b'), runtimeB);
		assert.strictEqual(stopGateA.calls, 1);
		assert.deepStrictEqual(fixture.events, []);

		stopGateA.release();
		await waitUntil(() => runtimeA.lifecycle === 'stopped');
		await fixture.supervisor.dispose();
	});

	test('한 session stop과 crash가 다른 session에 영향을 주지 않는다', async () => {
		const fixture = createSupervisorFixture();
		await Promise.all([
			fixture.supervisor.prepareSession('session-one'),
			fixture.supervisor.prepareSession('session-two'),
		]);

		await fixture.supervisor.stopSession('session-one');
		assert.strictEqual(fixture.supervisor.getSessionRuntime('session-one'), undefined);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-two')?.lifecycle,
			'running',
		);

		fixture.children[1].exit(1, null);
		await waitUntil(() => fixture.events.some(
			({ event }) => event.type === 'runtime.failure'
				&& event.sessionId === 'session-two',
		));
		assert.strictEqual(fixture.supervisor.getSessionRuntime('session-one'), undefined);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-two')?.lifecycle,
			'crashed',
		);
		await fixture.supervisor.dispose();
	});

	test('restart는 old runtime 정리 후 fresh child, port, route, token과 generation을 만든다', async () => {
		const fixture = createSupervisorFixture();
		const first = await fixture.supervisor.prepareSession('session-one');
		assert.strictEqual(first.ok, true);
		if (!first.ok) {
			return;
		}
		const firstGeneration = first.connection.generation;
		const firstUrl = first.connection.url;
		const firstToken = first.connection.withBearerToken((token) => token);

		const restarted = await fixture.supervisor.restartSession('session-one');
		assert.strictEqual(restarted.ok, true);
		if (!restarted.ok) {
			return;
		}
		assert.strictEqual(fixture.children.length, 2);
		assert.notStrictEqual(restarted.connection.generation, firstGeneration);
		assert.notStrictEqual(restarted.connection.url, firstUrl);
		assert.notStrictEqual(
			restarted.connection.withBearerToken((token) => token),
			firstToken,
		);
		assert.throws(() => first.connection.withBearerToken((token) => token));
		assert.deepStrictEqual(
			fixture.children[0].sent.map((message) => message.type),
			['auth.register', 'auth.revoke', 'server.shutdown'],
		);
		await fixture.supervisor.dispose();
	});

	test('restart와 경쟁한 prepare는 같은 fresh transaction을 공유한다', async () => {
		const fixture = createSupervisorFixture();
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		const restart = fixture.supervisor.restartSession('session-one');
		const concurrentPrepare = fixture.supervisor.prepareSession('session-one');
		assert.strictEqual(concurrentPrepare, restart);
		assert.strictEqual((await restart).ok, true);
		assert.strictEqual(fixture.children.length, 2);
		await fixture.supervisor.dispose();
	});

	test('restart와 경쟁한 stop은 await 뒤 fresh runtime으로 target을 바꾸지 않는다', async () => {
		const fixture = createSupervisorFixture();
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		const restart = fixture.supervisor.restartSession('session-one');
		const firstStop = fixture.supervisor.stopSession('session-one');
		assert.strictEqual(fixture.supervisor.stopSession('session-one'), firstStop);
		assert.strictEqual((await restart).ok, true);
		await firstStop;
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-one'),
			fixture.runtimes[1],
		);
		assert.strictEqual(fixture.runtimes[1].lifecycle, 'running');
		assert.strictEqual(fixture.children.length, 2);
		await fixture.supervisor.dispose();
	});

	test('stop 중 prepare를 차단하고 완료 후 같은 session ID를 fresh runtime으로 준비한다', async () => {
		const fixture = createSupervisorFixture();
		const first = await fixture.supervisor.prepareSession('session-one');
		assert.strictEqual(first.ok, true);
		if (!first.ok) {
			return;
		}

		const stop = fixture.supervisor.stopSession('session-one');
		const duringStop = await fixture.supervisor.prepareSession('session-one');
		assert.strictEqual(duringStop.ok, false);
		assert.strictEqual(fixture.children.length, 1);
		await stop;
		assert.strictEqual(fixture.supervisor.getSessionRuntime('session-one'), undefined);

		const second = await fixture.supervisor.prepareSession('session-one');
		assert.strictEqual(second.ok, true);
		if (!second.ok) {
			return;
		}
		assert.strictEqual(fixture.children.length, 2);
		assert.notStrictEqual(second.connection.generation, first.connection.generation);
		assert.throws(() => first.connection.withBearerToken((token) => token));
		await fixture.supervisor.dispose();
	});

	test('supervisor dispose는 소유 runtime을 모두 정리하고 같은 Promise를 재사용한다', async () => {
		const fixture = createSupervisorFixture();
		await Promise.all([
			fixture.supervisor.prepareSession('session-one'),
			fixture.supervisor.prepareSession('session-two'),
		]);
		const firstDispose = fixture.supervisor.dispose();
		assert.strictEqual(fixture.supervisor.dispose(), firstDispose);
		await firstDispose;

		assert.strictEqual(fixture.supervisor.getSessionRuntime('session-one'), undefined);
		assert.strictEqual(fixture.supervisor.getSessionRuntime('session-two'), undefined);
		assert.deepStrictEqual(fixture.children.map((child) => child.sent.map(
			(message) => message.type,
		)), [[
			'auth.register', 'auth.revoke', 'server.shutdown',
		], [
			'auth.register', 'auth.revoke', 'server.shutdown',
		]]);
		const afterDispose = await fixture.supervisor.prepareSession('session-three');
		assert.strictEqual(afterDispose.ok, false);
		assert.strictEqual(fixture.children.length, 2);
	});

	test('dispose는 pending detached old와 current replacement 모두의 settlement를 기다린다', async () => {
		const fixture = createSupervisorFixture();
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		const oldRuntime = fixture.runtimes[0];
		const oldStopGate = deferRuntimeStop(oldRuntime);
		const oldRetirement = fixture.supervisor.retireExactRuntime(oldRuntime);
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		const replacement = fixture.runtimes[1];
		const replacementStopGate = deferRuntimeStop(replacement);

		let disposeSettled = false;
		const dispose = fixture.supervisor.dispose();
		void dispose.then(() => {
			disposeSettled = true;
		});
		assert.strictEqual(fixture.supervisor.dispose(), dispose);
		assert.strictEqual(fixture.supervisor.getSessionRuntime('session-one'), undefined);
		assert.strictEqual(oldStopGate.calls, 1);
		assert.strictEqual(replacementStopGate.calls, 1);
		await nextTurn();
		assert.strictEqual(disposeSettled, false);

		replacementStopGate.release();
		await waitUntil(() => replacement.lifecycle === 'stopped');
		await nextTurn();
		assert.strictEqual(disposeSettled, false);

		oldStopGate.release();
		await oldRetirement;
		await dispose;
		assert.strictEqual(disposeSettled, true);
		const ownership = inspectSupervisorOwnership(fixture.supervisor);
		assert.strictEqual(ownership.liveRuntimes.size, 0);
		assert.strictEqual(ownership.retirements.size, 0);
	});

	test('crash 뒤 명시적 restart 전에는 새 adapter를 자동 생성하지 않는다', async () => {
		const fixture = createSupervisorFixture();
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		fixture.children[0].exit(1, null);
		await waitUntil(() => fixture.events.some(
			({ event }) => event.type === 'runtime.failure',
		));
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.strictEqual(fixture.children.length, 1);

		const duplicate = await fixture.supervisor.prepareSession('session-one');
		assert.strictEqual(duplicate.ok, false);
		if (!duplicate.ok) {
			assert.strictEqual(duplicate.failure.reason, 'adapter_exited');
		}
		assert.strictEqual(fixture.children.length, 1);

		assert.strictEqual(
			(await fixture.supervisor.restartSession('session-one')).ok,
			true,
		);
		assert.strictEqual(fixture.children.length, 2);
		await fixture.supervisor.dispose();
	});
});

interface SupervisorFixture {
	readonly supervisor: McpAdapterSupervisor;
	readonly children: FakeMcpChild[];
	readonly events: SupervisorRuntimeEvent[];
	readonly runtimes: McpSessionRuntime[];
	readonly runtimeEventSinks: ReadonlyMap<
		McpSessionRuntime,
		(event: McpSessionRuntimeEvent) => void
	>;
	readonly supervisorOptions: McpAdapterSupervisorOptions;
}

function createSupervisorFixture(options: Readonly<{
	agentActivityCompatible?: boolean;
}> = {}): SupervisorFixture {
	const children: FakeMcpChild[] = [];
	const events: SupervisorRuntimeEvent[] = [];
	const runtimes: McpSessionRuntime[] = [];
	const runtimeEventSinks = new Map<
		McpSessionRuntime,
		(event: McpSessionRuntimeEvent) => void
	>();
	let generationIndex = 0;
	let requestIndex = 0;
	const supervisorOptions = {
		extensionUri: { fsPath: '/installed/crispy' },
		hostRuntime,
		timeouts: {
			readyMs: 100,
			registrationMs: 100,
			revokeMs: 20,
			shutdownMs: 20,
			killMs: 20,
		},
		createGeneration: () => `generation-${++generationIndex}`,
		createRequestId: () => `request-${++requestIndex}`,
		spawnChild: (request) => {
			const child = createReadyFakeChild({
				generation: request.generation,
				port: 43_000 + children.length,
			});
			children.push(child);
			return child.asChildProcess();
		},
		createRuntime: (runtimeOptions: McpSessionRuntimeOptions) => {
			const runtime = new McpSessionRuntime(runtimeOptions);
			runtimes.push(runtime);
			if (runtimeOptions.onEvent !== undefined) {
				runtimeEventSinks.set(runtime, runtimeOptions.onEvent);
			}
			return runtime;
		},
		onEvent: (event) => events.push(event),
		agentActivityCompatible: options.agentActivityCompatible,
	} satisfies McpAdapterSupervisorOptions;
	const supervisor = new McpAdapterSupervisor(supervisorOptions);
	return {
		supervisor,
		children,
		events,
		runtimes,
		runtimeEventSinks,
		supervisorOptions,
	};
}

interface RuntimeStopGate {
	readonly calls: number;
	release(): void;
}

function deferRuntimeStop(runtime: McpSessionRuntime): RuntimeStopGate {
	const originalStop = runtime.stop.bind(runtime);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	let stop: Promise<void> | undefined;
	Object.defineProperty(runtime, 'stop', {
		value: (): Promise<void> => {
			calls += 1;
			stop ??= gate.then(() => originalStop());
			return stop;
		},
	});
	return {
		get calls() {
			return calls;
		},
		release,
	};
}

function inspectSupervisorOwnership(supervisor: McpAdapterSupervisor): {
	readonly liveRuntimes: ReadonlySet<McpSessionRuntime>;
	readonly retirements: ReadonlyMap<McpSessionRuntime, Promise<void>>;
} {
	return supervisor as unknown as {
		readonly liveRuntimes: ReadonlySet<McpSessionRuntime>;
		readonly retirements: ReadonlyMap<McpSessionRuntime, Promise<void>>;
	};
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
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
