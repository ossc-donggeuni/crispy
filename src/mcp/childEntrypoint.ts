import { CrispyMcpProtocolServer } from './protocolServer';
import {
	parseHostToMcpChildMessage,
	type McpChildOperationFailureReason,
	type McpChildToHostMessage,
} from './ipcProtocol';
import { isValidMcpOpaqueId } from './sessionCredentials';
import { MCP_CHILD_GENERATION_ENV } from './childBootstrap';

const generation = process.env[MCP_CHILD_GENERATION_ENV];
if (!isValidMcpOpaqueId(generation) || typeof process.send !== 'function') {
	process.exitCode = 1;
} else {
	startChild(generation);
}

function startChild(childGeneration: string): void {
	let shutdownPromise: Promise<void> | undefined;
	const server = new CrispyMcpProtocolServer({
		generation: childGeneration,
		onActivityObserved: (event) => {
			sendSafe({
				type: event.type,
				generation: event.generation,
				sessionId: event.sessionId,
			});
		},
	});

	const shutdown = (exitCode: number): Promise<void> => {
		shutdownPromise ??= (async () => {
			process.off('message', onMessage);
			process.off('disconnect', onDisconnect);
			await server.shutdown().catch(() => undefined);
			if (process.connected) {
				try {
					process.disconnect();
				} catch {
					/** 이미 닫힌 IPC channel은 종료를 방해하지 않는다. */
				}
			}
			process.exit(exitCode);
		})();
		return shutdownPromise;
	};

	const failOperation = (
		reason: McpChildOperationFailureReason,
		requestId?: string,
		sessionId?: string,
	): void => {
		sendSafe({
			type: 'operation.failed',
			generation: childGeneration,
			reason,
			...(requestId === undefined ? {} : { requestId }),
			...(sessionId === undefined ? {} : { sessionId }),
		});
	};

	const onMessage = (value: unknown): void => {
		const parsed = parseHostToMcpChildMessage(value);
		if (!parsed.ok) {
			failOperation('invalid_message');
			return;
		}
		const message = parsed.value;
		if (message.generation !== childGeneration) {
			failOperation('invalid_message', message.requestId);
			return;
		}

		switch (message.type) {
			case 'auth.register':
				try {
					server.registerSession({
						generation: message.generation,
						sessionId: message.sessionId,
						routeId: message.routeId,
						token: message.token,
					});
					sendSafe({
						type: 'auth.registered',
						requestId: message.requestId,
						generation: message.generation,
						sessionId: message.sessionId,
					});
				} catch {
					failOperation(
						'auth_registration_failed',
						message.requestId,
						message.sessionId,
					);
				}
				break;
			case 'auth.revoke':
				if (server.revokeSession(message.generation, message.sessionId)) {
					sendSafe({
						type: 'auth.revoked',
						requestId: message.requestId,
						generation: message.generation,
						sessionId: message.sessionId,
					});
				} else {
					failOperation(
						'auth_revoke_failed',
						message.requestId,
						message.sessionId,
					);
				}
				break;
			case 'server.shutdown':
				void shutdown(0);
				break;
		}
	};

	const onDisconnect = (): void => {
		void shutdown(0);
	};

	process.on('message', onMessage);
	process.once('disconnect', onDisconnect);
	process.once('SIGINT', () => void shutdown(0));
	process.once('SIGTERM', () => void shutdown(0));
	process.once('uncaughtException', () => void shutdown(1));
	process.once('unhandledRejection', () => void shutdown(1));

	void server.start().then(
		(ready) => {
			sendSafe({
				type: 'server.ready',
				generation: childGeneration,
				port: ready.port,
			});
		},
		() => {
			failOperation('server_start_failed');
			void shutdown(1);
		},
	);
}

/** IPC send 오류와 callback 오류는 payload나 원본 exception을 출력하지 않는다. */
function sendSafe(message: McpChildToHostMessage): void {
	if (!process.connected || typeof process.send !== 'function') {
		return;
	}
	try {
		process.send(message, () => undefined);
	} catch {
		/** Parent disconnect와 경쟁한 send는 child cleanup 경계가 처리한다. */
	}
}
