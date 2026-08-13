import type { TerminalErrorCode } from './errors';
import type { ProviderId } from './providers';

/** Webview가 소유하며 Host가 session에 연결하는 tab 식별자다. */
export type TabId = string;

/** Host가 생성하고 수명주기를 관리하는 terminal session 식별자다. */
export type SessionId = string;

/** Host가 session별로 발급하는 1부터 시작하는 output 순서 번호다. */
export type OutputSequence = number;

/** Webview가 Extension Host에 보낼 수 있는 terminal protocol 메시지다. */
export type WebviewToHostMessage =
	| {
		type: 'terminal.ready';
		tabId: TabId;
		providerId: ProviderId;
		cols: number;
		rows: number;
	}
	| {
		type: 'terminal.input';
		tabId: TabId;
		sessionId: SessionId;
		data: string;
	}
	| {
		type: 'terminal.resize';
		tabId: TabId;
		sessionId: SessionId;
		cols: number;
		rows: number;
	}
	| {
		type: 'terminal.outputAck';
		tabId: TabId;
		sessionId: SessionId;
		sequence: OutputSequence;
	}
	| {
		type: 'terminal.restart';
		tabId: TabId;
		sessionId: SessionId;
		cols: number;
		rows: number;
	}
	| {
		type: 'terminal.visible';
		tabId: TabId;
		visible: boolean;
	};

/** Extension Host가 Webview에 보낼 수 있는 terminal protocol 메시지다. */
export type HostToWebviewMessage =
	| {
		type: 'terminal.starting';
		tabId: TabId;
	}
	| {
		type: 'terminal.started';
		tabId: TabId;
		sessionId: SessionId;
	}
	| {
		type: 'terminal.output';
		tabId: TabId;
		sessionId: SessionId;
		sequence: OutputSequence;
		data: string;
	}
	| {
		type: 'terminal.exited';
		tabId: TabId;
		sessionId: SessionId;
		exitCode: number | null;
		signal: number | null;
	}
	| {
		type: 'terminal.error';
		tabId: TabId;
		sessionId: SessionId | null;
		code: TerminalErrorCode;
		message: string;
		canRestart: boolean;
	}
	| {
		type: 'terminal.cleanupFailed';
		tabId: TabId;
		sessionId: SessionId;
		message: string;
	};

/** 기존 명칭과 함께 terminal 방향을 명시적으로 표현하는 별칭이다. */
export type TerminalWebviewMessage = WebviewToHostMessage;
export type TerminalHostMessage = HostToWebviewMessage;
