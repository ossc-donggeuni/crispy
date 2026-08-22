import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type {
	HostToMcpChildMessage,
	McpChildToHostMessage,
} from '../../../mcp/ipcProtocol';

let nextFakePid = 80_000;

export interface FakeMcpChildOptions {
	readonly generation: string;
	readonly port?: number;
	readonly announceReady?: boolean;
	readonly acknowledgeRegistration?: boolean;
	readonly failRegistration?: boolean;
	readonly acknowledgeRevoke?: boolean;
	readonly exitOnShutdown?: boolean;
	readonly exitOnKill?: boolean;
}

export class FakeMcpChild extends EventEmitter {
	readonly pid = nextFakePid++;
	readonly sent: HostToMcpChildMessage[] = [];
	readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
	connected = true;
	killed = false;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	private exited = false;

	constructor(readonly options: FakeMcpChildOptions) {
		super();
	}

	announceReady(): void {
		this.emitMessage({
			type: 'server.ready',
			generation: this.options.generation,
			port: this.options.port ?? 41_000,
		});
	}

	send(
		message: HostToMcpChildMessage,
		callback?: (error: Error | null) => void,
	): boolean {
		if (!this.connected || this.exited) {
			callback?.(new Error('fake child is disconnected'));
			return false;
		}
		this.sent.push(message);
		callback?.(null);
		queueMicrotask(() => this.respond(message));
		return true;
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killed = true;
		this.killSignals.push(signal);
		if (this.options.exitOnKill !== false) {
			queueMicrotask(() => this.exit(null, 'SIGKILL'));
		}
		return true;
	}

	disconnect(): void {
		if (!this.connected) {
			return;
		}
		this.connected = false;
		this.emit('disconnect');
	}

	exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
		if (this.exited) {
			return;
		}
		this.exited = true;
		this.connected = false;
		this.exitCode = code;
		this.signalCode = signal;
		this.emit('exit', code, signal);
	}

	emitMessage(message: McpChildToHostMessage | unknown): void {
		this.emit('message', message);
	}

	asChildProcess(): ChildProcess {
		return this as unknown as ChildProcess;
	}

	private respond(message: HostToMcpChildMessage): void {
		if (this.exited) {
			return;
		}
		switch (message.type) {
			case 'auth.register':
				if (this.options.failRegistration) {
					this.emitMessage({
						type: 'operation.failed',
						requestId: message.requestId,
						generation: message.generation,
						sessionId: message.sessionId,
						reason: 'auth_registration_failed',
					});
				} else if (this.options.acknowledgeRegistration !== false) {
					this.emitMessage({
						type: 'auth.registered',
						requestId: message.requestId,
						generation: message.generation,
						sessionId: message.sessionId,
					});
				}
				break;
			case 'auth.revoke':
				if (this.options.acknowledgeRevoke !== false) {
					this.emitMessage({
						type: 'auth.revoked',
						requestId: message.requestId,
						generation: message.generation,
						sessionId: message.sessionId,
					});
				}
				break;
			case 'server.shutdown':
				if (this.options.exitOnShutdown !== false) {
					this.exit(0, null);
				}
				break;
		}
	}
}

export function createReadyFakeChild(
	options: FakeMcpChildOptions,
): FakeMcpChild {
	const child = new FakeMcpChild(options);
	if (options.announceReady !== false) {
		queueMicrotask(() => child.announceReady());
	}
	return child;
}
