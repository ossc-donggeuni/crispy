import type {
	HOST_TO_WEBVIEW_MESSAGE_SCHEMAS,
	InferMessageSchemaRegistry,
	WEBVIEW_TO_HOST_MESSAGE_SCHEMAS,
} from './schemas';

/** Webview가 소유하며 Host가 session에 연결하는 tab 식별자다. */
export type TabId = string;

/** Host가 생성하고 수명주기를 관리하는 terminal session 식별자다. */
export type SessionId = string;

/** Ready handshake를 포함해 Webview가 Host로 보낼 수 있는 전체 wire 메시지다. */
export type WebviewToHostWireMessage = InferMessageSchemaRegistry<
	typeof WEBVIEW_TO_HOST_MESSAGE_SCHEMAS
>;

/** Ready handshake를 포함해 Host가 Webview로 보낼 수 있는 전체 wire 메시지다. */
export type HostToWebviewWireMessage = InferMessageSchemaRegistry<
	typeof HOST_TO_WEBVIEW_MESSAGE_SCHEMAS
>;

/** Webview가 Extension Host에 보낼 수 있는 terminal protocol 메시지다. */
export type WebviewToHostMessage = Exclude<
	WebviewToHostWireMessage,
	{ type: 'webview.ready' }
>;

/** Extension Host가 Webview에 보낼 수 있는 terminal protocol 메시지다. */
export type HostToWebviewMessage = Exclude<
	HostToWebviewWireMessage,
	{ type: 'extension.ready' }
>;
