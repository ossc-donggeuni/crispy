import type {
	HostToWebviewWireMessage,
	WebviewToHostWireMessage,
} from './agent/protocol';

/** Webview에서 Extension Host로 전송하는 ready 및 terminal wire 메시지 타입이다. */
export type WebviewToExtensionMessage = WebviewToHostWireMessage;

/** Extension Host에서 Webview로 전송하는 ready 및 terminal wire 메시지 타입이다. */
export type ExtensionToWebviewMessage = HostToWebviewWireMessage;

export type {
	HostToWebviewMessage,
	HostToWebviewWireMessage,
	OutputSequence,
	SessionId,
	TabId,
	WebviewToHostMessage,
	WebviewToHostWireMessage,
} from './agent/protocol';
