import * as assert from 'node:assert/strict';
import {
	McpAdapterSupervisor,
	type McpSessionRuntimeEvent,
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
			fixture.supervisor.getSessionRuntime('session-one')?.lifecycle,
			'running',
		);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-two')?.lifecycle,
			'running',
		);
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

	test('한 session stop과 crash가 다른 session에 영향을 주지 않는다', async () => {
		const fixture = createSupervisorFixture();
		await Promise.all([
			fixture.supervisor.prepareSession('session-one'),
			fixture.supervisor.prepareSession('session-two'),
		]);

		await fixture.supervisor.stopSession('session-one');
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-one')?.lifecycle,
			'stopped',
		);
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-two')?.lifecycle,
			'running',
		);

		fixture.children[1].exit(1, null);
		await waitUntil(() => fixture.events.some(
			(event) => event.type === 'runtime.failure'
				&& event.sessionId === 'session-two',
		));
		assert.strictEqual(
			fixture.supervisor.getSessionRuntime('session-one')?.lifecycle,
			'stopped',
		);
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

	test('restart와 경쟁한 stop은 fresh runtime까지 정리하고 Promise를 공유한다', async () => {
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
			fixture.supervisor.getSessionRuntime('session-one')?.lifecycle,
			'stopped',
		);
		assert.strictEqual(fixture.children.length, 2);
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

	test('crash 뒤 명시적 restart 전에는 새 adapter를 자동 생성하지 않는다', async () => {
		const fixture = createSupervisorFixture();
		assert.strictEqual(
			(await fixture.supervisor.prepareSession('session-one')).ok,
			true,
		);
		fixture.children[0].exit(1, null);
		await waitUntil(() => fixture.events.some(
			(event) => event.type === 'runtime.failure',
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

function createSupervisorFixture(): {
	readonly supervisor: McpAdapterSupervisor;
	readonly children: FakeMcpChild[];
	readonly events: McpSessionRuntimeEvent[];
} {
	const children: FakeMcpChild[] = [];
	const events: McpSessionRuntimeEvent[] = [];
	let generationIndex = 0;
	let requestIndex = 0;
	const supervisor = new McpAdapterSupervisor({
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
		onEvent: (event) => events.push(event),
	});
	return { supervisor, children, events };
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
