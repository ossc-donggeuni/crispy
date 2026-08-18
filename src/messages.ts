import type {
	HostToWebviewWireMessage,
	WebviewToHostWireMessage,
} from './agent/protocol';
import type { PersistedWebviewState } from './webview/webviewState';

/** Webview 전체 snapshot 변경을 Extension Host에 전달하는 상태 경계 메시지다. */
export interface WebviewStateChangedMessage {
	type: 'webview.stateChanged';
	state: PersistedWebviewState;
}

/** Webview에서 Extension Host로 전송하는 Agent wire 및 Webview state 메시지다. */
export type WebviewToExtensionMessage =
	| WebviewToHostWireMessage
	| WebviewStateChangedMessage;

/** Extension Host에서 Webview로 전송하는 ready 및 terminal wire 메시지 타입이다. */
export type ExtensionToWebviewMessage = HostToWebviewWireMessage;

/** `src/agent/protocol`이 공개하는 타입을 기존 import 경로에서도 재노출한다. */
export type * from './agent/protocol';
