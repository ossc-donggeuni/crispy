import * as assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import {
	createMcpChildEnvironment,
	spawnMcpChild,
} from '../../mcp/sessionRuntime';
import type {
	HostToMcpChildMessage,
	McpChildToHostMessage,
} from '../../mcp/ipcProtocol';

const childEntryPath = path.resolve(
	__dirname,
	'../../../dist/mcp-server.mjs',
);

suite('Standalone MCP child transaction', () => {
	test('random loopback ready→register→ping→revoke→shutdown 뒤 old port를 닫는다', async () => {
		const identity = createIdentity();
		const child = launchChild(identity.generation);
		try {
			const ready = await waitForMessage(
				child,
				(message): message is Extract<McpChildToHostMessage, { type: 'server.ready' }> =>
					message.type === 'server.ready',
			);
			assert.ok(Number.isSafeInteger(ready.port));
			assert.ok(ready.port > 0);

			const registeredPromise = waitForMessage(
				child,
				(message): message is Extract<McpChildToHostMessage, { type: 'auth.registered' }> =>
					message.type === 'auth.registered'
					&& message.requestId === 'request-register',
			);
			await send(child, {
				type: 'auth.register',
				requestId: 'request-register',
				...identity,
			});
			const registered = await registeredPromise;
			assert.strictEqual(registered.sessionId, identity.sessionId);

			const pingObservedPromise = waitForMessage(
				child,
				(message): message is Extract<McpChildToHostMessage, {
					type: 'session.crispyPingObserved';
				}> => message.type === 'session.crispyPingObserved',
			);
			const response = await fetch(`http://127.0.0.1:${ready.port}/mcp/${identity.routeId}`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${identity.token}`,
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'tools/call',
					params: { name: 'crispy_ping', arguments: {} },
				}),
			});
			assert.strictEqual(response.status, 200);
			const responseText = await response.text();
			const dataLine = responseText
				.split(/\r?\n/u)
				.find((line) => line.startsWith('data:'));
			const body = JSON.parse(
				dataLine?.slice('data:'.length).trimStart() ?? responseText,
			) as {
				result?: { content?: Array<{ text?: string }> };
			};
			assert.deepStrictEqual(
				JSON.parse(body.result?.content?.[0]?.text ?? 'null'),
				{ ok: true, server: 'crispy', mode: 'observation-only' },
			);
			const pingObserved = await pingObservedPromise;
			assert.deepStrictEqual(pingObserved, {
				type: 'session.crispyPingObserved',
				generation: identity.generation,
				sessionId: identity.sessionId,
			});

			const revokedPromise = waitForMessage(
				child,
				(message): message is Extract<McpChildToHostMessage, { type: 'auth.revoked' }> =>
					message.type === 'auth.revoked'
					&& message.requestId === 'request-revoke',
			);
			await send(child, {
				type: 'auth.revoke',
				requestId: 'request-revoke',
				generation: identity.generation,
				sessionId: identity.sessionId,
			});
			await revokedPromise;

			const exitPromise = waitForExit(child);
			await send(child, {
				type: 'server.shutdown',
				requestId: 'request-shutdown',
				generation: identity.generation,
			});
			const exit = await exitPromise;
			assert.deepStrictEqual(exit, { code: 0, signal: null });
			await assertPortClosed(ready.port);
		} finally {
			killChild(child);
		}
	});

	test('한 generation의 second registration과 다른 session revoke를 거부한다', async () => {
		const first = createIdentity();
		const child = launchChild(first.generation);
		try {
			await waitForMessage(child, (message) => message.type === 'server.ready');
			const registered = waitForMessage(child, (message) =>
				message.type === 'auth.registered'
				&& message.requestId === 'request-first');
			await send(child, {
				type: 'auth.register', requestId: 'request-first', ...first,
			});
			await registered;

			const secondFailure = waitForMessage(child, (message) =>
				message.type === 'operation.failed'
				&& message.requestId === 'request-second');
			await send(child, {
				type: 'auth.register',
				requestId: 'request-second',
				generation: first.generation,
				sessionId: 'session-second',
				routeId: randomBytes(24).toString('base64url'),
				token: randomBytes(32).toString('base64url'),
			});
			const registrationFailure = await secondFailure;
			assert.strictEqual(
				registrationFailure.type === 'operation.failed'
					? registrationFailure.reason
					: undefined,
				'auth_registration_failed',
			);

			const revokeFailure = waitForMessage(child, (message) =>
				message.type === 'operation.failed'
				&& message.requestId === 'request-wrong-revoke');
			await send(child, {
				type: 'auth.revoke',
				requestId: 'request-wrong-revoke',
				generation: first.generation,
				sessionId: 'session-second',
			});
			const wrongRevoke = await revokeFailure;
			assert.strictEqual(
				wrongRevoke.type === 'operation.failed'
					? wrongRevoke.reason
					: undefined,
				'auth_revoke_failed',
			);
		} finally {
			await shutdownChild(child, first.generation);
		}
	});

	test('malformed IPC failure는 원본 credential을 반사하지 않고 정상 종료할 수 있다', async () => {
		const identity = createIdentity();
		const child = launchChild(identity.generation);
		try {
			await waitForMessage(child, (message) => message.type === 'server.ready');
			const malformedToken = `${identity.token}!malformed-sensitive-tail`;
			const failurePromise = waitForMessage(child, (message) =>
				message.type === 'operation.failed'
				&& message.reason === 'invalid_message');
			child.send({
				type: 'auth.register',
				requestId: 'request-malformed',
				generation: identity.generation,
				sessionId: identity.sessionId,
				routeId: identity.routeId,
				token: malformedToken,
				extra: identity.routeId,
			});
			const failure = await failurePromise;
			const serialized = JSON.stringify(failure);
			assert.ok(!serialized.includes(malformedToken));
			assert.ok(!serialized.includes(identity.routeId));
			assert.deepStrictEqual(Object.keys(failure).sort(), [
				'generation', 'reason', 'type',
			]);
		} finally {
			await shutdownChild(child, identity.generation);
		}
	});

	test('parent IPC disconnect 시 self-shutdown하고 독립 child는 서로 다른 port를 쓴다', async () => {
		const first = createIdentity();
		const second = createIdentity();
		const firstChild = launchChild(first.generation);
		const secondChild = launchChild(second.generation);
		try {
			const [firstReady, secondReady] = await Promise.all([
				waitForMessage(firstChild, (message) => message.type === 'server.ready'),
				waitForMessage(secondChild, (message) => message.type === 'server.ready'),
			]);
			assert.ok(firstReady.type === 'server.ready');
			assert.ok(secondReady.type === 'server.ready');
			assert.notStrictEqual(firstReady.port, secondReady.port);

			const disconnectedExit = waitForExit(firstChild);
			firstChild.disconnect();
			assert.deepStrictEqual(await disconnectedExit, { code: 0, signal: null });
			await assertPortClosed(firstReady.port);
			await shutdownChild(secondChild, second.generation);
			await assertPortClosed(secondReady.port);
		} finally {
			killChild(firstChild);
			killChild(secondChild);
		}
	});
});

function createIdentity(): {
	readonly generation: string;
	readonly sessionId: string;
	readonly routeId: string;
	readonly token: string;
} {
	return {
		generation: `generation-${randomUUID()}`,
		sessionId: `session-${randomUUID()}`,
		routeId: randomBytes(24).toString('base64url'),
		token: randomBytes(32).toString('base64url'),
	};
}

function launchChild(generation: string): ChildProcess {
	return spawnMcpChild({
		executablePath: process.execPath,
		childEntryPath,
		generation,
		environment: createMcpChildEnvironment({
			...process.env,
			crispy_mcp_token: 'must-not-reach-child',
		}, generation),
	});
}

function waitForMessage<Message extends McpChildToHostMessage>(
	child: ChildProcess,
	predicate: (message: McpChildToHostMessage) => message is Message,
): Promise<Message>;
function waitForMessage(
	child: ChildProcess,
	predicate: (message: McpChildToHostMessage) => boolean,
): Promise<McpChildToHostMessage>;
function waitForMessage(
	child: ChildProcess,
	predicate: (message: McpChildToHostMessage) => boolean,
): Promise<McpChildToHostMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error('MCP child message timeout'));
		}, 5000);
		const onMessage = (message: McpChildToHostMessage): void => {
			if (!predicate(message)) {
				return;
			}
			cleanup();
			resolve(message);
		};
		const onExit = (): void => {
			cleanup();
			reject(new Error('MCP child exited before expected message'));
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			child.off('message', onMessage);
			child.off('exit', onExit);
		};
		child.on('message', onMessage);
		child.once('exit', onExit);
	});
}

function send(child: ChildProcess, message: HostToMcpChildMessage): Promise<void> {
	return new Promise((resolve, reject) => {
		child.send(message, (error) => error === null ? resolve() : reject(error));
	});
}

function waitForExit(
	child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('MCP child exit timeout')), 5000);
		child.once('exit', (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
}

async function shutdownChild(child: ChildProcess, generation: string): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	const exit = waitForExit(child);
	if (child.connected) {
		await send(child, {
			type: 'server.shutdown',
			requestId: 'request-final-shutdown',
			generation,
		}).catch(() => undefined);
	}
	await exit.catch(() => undefined);
}

function killChild(child: ChildProcess): void {
	if (child.exitCode === null && child.signalCode === null) {
		try {
			child.kill('SIGKILL');
		} catch {
			/** Test failure path에서도 orphan child를 남기지 않는다. */
		}
	}
}

function assertPortClosed(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: '127.0.0.1', port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error('old MCP port close check timed out'));
		}, 1000);
		socket.once('connect', () => {
			clearTimeout(timer);
			socket.destroy();
			reject(new Error('old MCP port still accepts connections'));
		});
		socket.once('error', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}
