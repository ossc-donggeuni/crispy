/**
 * 생성된 전체 Codex protocol union에서 Crispy 단계 1~4가 사용하는 method와 Item을 추출한다.
 * 생성 타입을 복제하지 않고 `Extract<>`와 교차 타입으로 제품 내부 계약만 강화한다.
 */

import type { ClientNotification } from './generated/ClientNotification';
import type { ClientRequest } from './generated/ClientRequest';
import type { RequestId } from './generated/RequestId';
import type { ServerNotificationEnvelope } from './generated/ServerNotificationEnvelope';
import type { ServerRequest } from './generated/ServerRequest';
import type { CommandExecutionApprovalDecision } from './generated/v2/CommandExecutionApprovalDecision';
import type { CommandExecutionRequestApprovalResponse } from './generated/v2/CommandExecutionRequestApprovalResponse';
import type { FileChangeApprovalDecision } from './generated/v2/FileChangeApprovalDecision';
import type { FileChangeRequestApprovalResponse } from './generated/v2/FileChangeRequestApprovalResponse';
import type { ThreadItem } from './generated/v2/ThreadItem';

/** app-server 요청과 응답을 연결하는 Codex 생성 식별자 타입이다. */
export type CodexRequestId = RequestId;

/** Extension Host가 연결 협상을 시작할 때 보내는 요청이다. */
export type InitializeRequest = Extract<
	ClientRequest,
	{ method: 'initialize' }
>;

/**
 * 생성 스키마의 initialize 요청 중 Crispy가 실제 연결에서 사용하는 계약이다.
 * 실험 필드는 수신하고 attestation 역방향 요청은 받지 않는 값으로 고정한다.
 */
export type CrispyInitializeRequest = Omit<InitializeRequest, 'params'> & {
	params: Omit<InitializeRequest['params'], 'capabilities'> & {
		capabilities: Omit<
			NonNullable<InitializeRequest['params']['capabilities']>,
			'experimentalApi' | 'requestAttestation'
		> & {
			experimentalApi: true;
			requestAttestation: false;
		};
	};
};

/** initialize 응답 뒤 Extension Host가 보내는 준비 완료 알림이다. */
export type InitializedNotification = Extract<
	ClientNotification,
	{ method: 'initialized' }
>;

/** 새 Codex 대화 컨테이너를 생성하는 요청이다. */
export type ThreadStartRequest = Extract<
	ClientRequest,
	{ method: 'thread/start' }
>;

/** 기존 Thread에 사용자 입력 Turn을 시작하는 요청이다. */
export type TurnStartRequest = Extract<
	ClientRequest,
	{ method: 'turn/start' }
>;

/** 생성 request의 지정된 params field만 Crispy 내부에서 필수·non-null로 강화한다. */
type WithRequiredNonNullableParams<
	Request extends { params: object },
	Keys extends keyof Request['params'],
> = Omit<Request, 'params'> & {
	params: Omit<Request['params'], Keys> & {
		[Key in Keys]-?: NonNullable<Request['params'][Key]>;
	};
};

/**
 * 생성 스키마에서는 선택적이지만 Crispy가 새 Thread마다 항상 보내는 필드를 고정한 요청이다.
 */
export type CrispyThreadStartRequest = WithRequiredNonNullableParams<
	ThreadStartRequest,
	| 'cwd'
	| 'runtimeWorkspaceRoots'
	| 'approvalPolicy'
	| 'approvalsReviewer'
	| 'sandbox'
	| 'ephemeral'
	| 'threadSource'
>;

/** 사용자 메시지 중복 방지 ID를 항상 포함하는 Crispy의 Turn 시작 요청이다. */
export type CrispyTurnStartRequest = WithRequiredNonNullableParams<
	TurnStartRequest,
	'clientUserMessageId'
>;

/** 새 Thread가 생성됐음을 알리는 app-server Notification이다. */
export type ThreadStartedNotification = Extract<
	ServerNotificationEnvelope,
	{ method: 'thread/started' }
>;

/** Thread의 idle, active, error 상태 변경을 알리는 Notification이다. */
export type ThreadStatusChangedNotification = Extract<
	ServerNotificationEnvelope,
	{ method: 'thread/status/changed' }
>;

/** Turn 실행 시작과 초기 Turn 상태를 알리는 Notification이다. */
export type TurnStartedNotification = Extract<
	ServerNotificationEnvelope,
	{ method: 'turn/started' }
>;

/** Turn의 최종 상태와 오류를 알리는 Notification이다. */
export type TurnCompletedNotification = Extract<
	ServerNotificationEnvelope,
	{ method: 'turn/completed' }
>;

/** 하나의 Thread Item 생명주기 시작을 알리는 Notification이다. */
export type ItemStartedNotification = Extract<
	ServerNotificationEnvelope,
	{ method: 'item/started' }
>;

/** 하나의 Thread Item 최종 상태를 알리는 Notification이다. */
export type ItemCompletedNotification = Extract<
	ServerNotificationEnvelope,
	{ method: 'item/completed' }
>;

/** Agent 메시지 본문 뒤에 이어 붙일 텍스트 조각 Notification이다. */
export type AgentMessageDeltaNotification = Extract<
	ServerNotificationEnvelope,
	{ method: 'item/agentMessage/delta' }
>;

/** 명령 실행 출력 뒤에 이어 붙일 텍스트 조각 Notification이다. */
export type CommandExecutionOutputDeltaNotification = Extract<
	ServerNotificationEnvelope,
	{ method: 'item/commandExecution/outputDelta' }
>;

/** app-server가 요청한 파일 변경 승인 요청이다. */
export type FileChangeApprovalRequest = Extract<
	ServerRequest,
	{ method: 'item/fileChange/requestApproval' }
>;

/** app-server가 요청한 명령 실행 승인 요청이다. */
export type CommandExecutionApprovalRequest = Extract<
	ServerRequest,
	{ method: 'item/commandExecution/requestApproval' }
>;

/** app-server가 더 이상 승인 응답을 기다리지 않음을 알리는 Notification이다. */
export type ServerRequestResolvedNotification = Extract<
	ServerNotificationEnvelope,
	{ method: 'serverRequest/resolved' }
>;

/** 첨부 규약이 1~4단계에서 사용하는 Host 요청 union이다. */
export type DocumentedClientRequest = InitializeRequest
	| ThreadStartRequest
	| TurnStartRequest;

/** 첨부 규약이 1~4단계에서 사용하는 Host Notification이다. */
export type DocumentedClientNotification = InitializedNotification;

/** 첨부 규약이 1~4단계에서 사용하는 app-server Notification union이다. */
export type DocumentedServerNotification = ThreadStartedNotification
	| ThreadStatusChangedNotification
	| TurnStartedNotification
	| TurnCompletedNotification
	| ItemStartedNotification
	| ItemCompletedNotification
	| AgentMessageDeltaNotification
	| CommandExecutionOutputDeltaNotification
	| ServerRequestResolvedNotification;

/** 첨부 규약이 1~4단계에서 사용하는 app-server 역방향 요청 union이다. */
export type DocumentedServerRequest = FileChangeApprovalRequest
	| CommandExecutionApprovalRequest;

/** Crispy 1차 UI 범위에 포함되는 다섯 Thread Item의 discriminator다. */
export type CoreThreadItemType = 'userMessage'
	| 'agentMessage'
	| 'reasoning'
	| 'commandExecution'
	| 'fileChange';

/** 생성된 전체 ThreadItem에서 Crispy core 5 Item만 추출한 union이다. */
export type CoreThreadItem = Extract<
	ThreadItem,
	{ type: CoreThreadItemType }
>;

/** 생성된 userMessage Item 분기다. */
export type UserMessageItem = Extract<ThreadItem, { type: 'userMessage' }>;

/** 생성된 agentMessage Item 분기다. */
export type AgentMessageItem = Extract<ThreadItem, { type: 'agentMessage' }>;

/** 생성된 reasoning Item 분기다. */
export type ReasoningItem = Extract<ThreadItem, { type: 'reasoning' }>;

/** 생성된 commandExecution Item 분기다. */
export type CommandExecutionItem = Extract<
	ThreadItem,
	{ type: 'commandExecution' }
>;

/** 생성된 fileChange Item 분기다. */
export type FileChangeItem = Extract<ThreadItem, { type: 'fileChange' }>;

/** 명령 승인에서 app-server에 그대로 돌려줄 생성 decision union이다. */
export type CommandApprovalDecision = CommandExecutionApprovalDecision;

/** 파일 승인에서 app-server에 그대로 돌려줄 생성 decision union이다. */
export type FileApprovalDecision = FileChangeApprovalDecision;

/** 명령 승인 요청의 result에 사용하는 수정된 생성 응답 타입이다. */
export type CommandApprovalResponse = CommandExecutionRequestApprovalResponse;

/** 파일 승인 요청의 result에 사용하는 생성 응답 타입이다. */
export type FileApprovalResponse = FileChangeRequestApprovalResponse;

/** 추출된 protocol 분기가 `never`가 아닌지 compile time에 판정한다. */
type IsNotNever<Value> = [Value] extends [never] ? false : true;
/** 조건이 `true`가 아니면 TypeScript type-check를 실패시키는 assertion helper다. */
type Assert<Condition extends true> = Condition;

/** 생성 스키마 변경으로 문서화된 method가 사라지면 type-check를 실패시킨다. */
type ProtocolExtractionAssertions = [
	Assert<IsNotNever<InitializeRequest>>,
	Assert<IsNotNever<CrispyInitializeRequest>>,
	Assert<IsNotNever<InitializedNotification>>,
	Assert<IsNotNever<ThreadStartRequest>>,
	Assert<IsNotNever<CrispyThreadStartRequest>>,
	Assert<IsNotNever<TurnStartRequest>>,
	Assert<IsNotNever<CrispyTurnStartRequest>>,
	Assert<IsNotNever<ThreadStartedNotification>>,
	Assert<IsNotNever<ThreadStatusChangedNotification>>,
	Assert<IsNotNever<TurnStartedNotification>>,
	Assert<IsNotNever<TurnCompletedNotification>>,
	Assert<IsNotNever<ItemStartedNotification>>,
	Assert<IsNotNever<ItemCompletedNotification>>,
	Assert<IsNotNever<AgentMessageDeltaNotification>>,
	Assert<IsNotNever<CommandExecutionOutputDeltaNotification>>,
	Assert<IsNotNever<FileChangeApprovalRequest>>,
	Assert<IsNotNever<CommandExecutionApprovalRequest>>,
	Assert<IsNotNever<ServerRequestResolvedNotification>>,
	Assert<IsNotNever<CoreThreadItem>>,
];
