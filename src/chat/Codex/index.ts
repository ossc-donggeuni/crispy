/** Codex app-server 연결 계층이 외부 모듈에 제공하는 안정적인 public export surface다. */

export {
	CodexAppServerClient,
	CodexAppServerRpcError,
	codexProtocolCliVersion,
	createCodexClientInfo,
	defaultAppServerArguments,
	defaultCodexExecutable,
	defaultRequestTimeoutMs,
	defaultRequestIdPrefix,
	defaultVersionArguments,
	defaultVersionTimeoutMs,
} from './appServerClient';

/** app-server client 생성 옵션, 의존성 주입과 양방향 응답에 필요한 public 타입이다. */
export type {
	CodexAppServerClientOptions,
	CodexAppServerDependencies,
	CodexCliVersionResult,
	CodexHostErrorResponse,
	CodexHostResponse,
	SpawnAppServerProcess,
} from './appServerClient';

/** Thread·Turn·Item·승인·로그를 관리하는 Crispy 내부 상태와 View Model 타입이다. */
export type {
	CodexApprovalChoiceView,
	CodexApprovalView,
	CodexCommandApprovalView,
	CodexConnectionPhase,
	CodexConnectionState,
	CodexFileApprovalView,
	CodexLogDirection,
	CodexLogMessageKind,
	CodexLogRecord,
	CodexPendingApproval,
	CodexPendingCommandApproval,
	CodexPendingFileApproval,
	CodexThreadState,
	CodexTimelineItem,
	CodexTimelineItemLifecycle,
	CodexTurnState,
} from './contracts';

/** JSONL decoder의 runtime class와 허용 chunk 타입이다. */
export { JsonlLineDecoder } from './jsonl';
/** JSONL decoder가 실제 stream과 테스트에서 받을 수 있는 chunk 타입이다. */
export type { JsonlChunk } from './jsonl';

/** app-server inbound envelope와 initialize 응답의 runtime validator다. */
export {
	isInitializeResponse,
	isRecord,
	isRequestId,
	validateCodexInboundMessage,
} from './runtimeValidation';

/** runtime validation 이후 소비자가 사용하는 분류된 inbound 메시지 타입이다. */
export type {
	CodexErrorResponse,
	CodexInboundMessage,
	CodexInboundValidationResult,
	CodexRpcErrorPayload,
	CodexServerNotificationMessage,
	CodexServerRequestMessage,
	CodexSuccessfulResponse,
} from './runtimeValidation';

/** 생성 protocol union에서 단계 1~4 범위로 추출하거나 강화한 method와 Item 타입이다. */
export type {
	AgentMessageDeltaNotification,
	AgentMessageItem,
	CodexRequestId,
	CrispyInitializeRequest,
	CrispyThreadStartRequest,
	CrispyTurnStartRequest,
	CommandApprovalDecision,
	CommandApprovalResponse,
	CommandExecutionApprovalRequest,
	CommandExecutionItem,
	CommandExecutionOutputDeltaNotification,
	CoreThreadItem,
	CoreThreadItemType,
	DocumentedClientNotification,
	DocumentedClientRequest,
	DocumentedServerNotification,
	DocumentedServerRequest,
	FileApprovalDecision,
	FileApprovalResponse,
	FileChangeApprovalRequest,
	FileChangeItem,
	InitializeRequest,
	InitializedNotification,
	ItemCompletedNotification,
	ItemStartedNotification,
	ReasoningItem,
	ServerRequestResolvedNotification,
	ThreadStartedNotification,
	ThreadStartRequest,
	ThreadStatusChangedNotification,
	TurnCompletedNotification,
	TurnStartedNotification,
	TurnStartRequest,
	UserMessageItem,
} from './protocol';
