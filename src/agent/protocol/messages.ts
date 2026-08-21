import type {
	HOST_TO_WEBVIEW_MESSAGE_SCHEMAS,
	InferMessageSchemaRegistry,
	WEBVIEW_TO_HOST_MESSAGE_SCHEMAS,
} from './schemas';
import type { McpFailureReason } from '../../mcp/failureReason';

/** Webview가 소유하며 Host가 session에 연결하는 tab 식별자다. */
export type TabId = string;

/** Host가 생성하고 수명주기를 관리하는 terminal session 식별자다. */
export type SessionId = string;

/** Ready handshake를 포함해 Webview가 Host로 보낼 수 있는 전체 wire 메시지다. */
export type WebviewToHostWireMessage = InferMessageSchemaRegistry<
	typeof WEBVIEW_TO_HOST_MESSAGE_SCHEMAS
>;

/** Ready handshake를 포함해 Host가 Webview로 보낼 수 있는 전체 wire 메시지다. */
type InferredHostToWebviewWireMessage = InferMessageSchemaRegistry<
	typeof HOST_TO_WEBVIEW_MESSAGE_SCHEMAS
>;

/** Conditional MCP status 조합을 정적으로도 정확히 표현하는 Host wire 계약이다. */
export type McpStatusChangedMessage =
	| {
		readonly type: 'mcp.statusChanged';
		readonly tabId: TabId;
		readonly sessionId: SessionId;
		readonly status: 'connected';
	}
	| {
		readonly type: 'mcp.statusChanged';
		readonly tabId: TabId;
		readonly sessionId: SessionId;
		readonly status: 'failed';
		readonly reason: McpFailureReason;
		readonly retryable: boolean;
	};

export interface McpStatusClearedMessage {
	readonly type: 'mcp.statusCleared';
	readonly tabId: TabId;
	readonly sessionId: SessionId;
}

/** Ready handshake를 포함해 Host가 Webview로 보낼 수 있는 전체 wire 메시지다. */
export type HostToWebviewWireMessage =
	| Exclude<InferredHostToWebviewWireMessage, {
		readonly type: 'mcp.statusChanged' | 'mcp.statusCleared';
	}>
	| McpStatusChangedMessage
	| McpStatusClearedMessage;

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
