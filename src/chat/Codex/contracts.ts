/**
 * 생성 protocol 객체를 그대로 보존하면서 Crispy Host 상태와 UI View Model을 정의하는 모듈이다.
 * 모든 외부 protocol 값은 runtime validation 이후 이 계약으로 변환해야 한다.
 */

import type { ThreadStatus } from './generated/v2/ThreadStatus';
import type { TurnError } from './generated/v2/TurnError';
import type { TurnItemsView } from './generated/v2/TurnItemsView';
import type { TurnStatus } from './generated/v2/TurnStatus';
import type {
	CodexRequestId,
	CommandApprovalDecision,
	CommandExecutionApprovalRequest,
	CoreThreadItem,
	FileApprovalDecision,
	FileChangeApprovalRequest,
} from './protocol';

/** Extension Host가 관리하는 app-server 연결 단계다. */
export type CodexConnectionPhase = 'stopped'
	| 'starting'
	| 'initializing'
	| 'ready'
	| 'stopping'
	| 'failed';

/** app-server 연결의 현재 상태와 진단 정보를 보관한다. */
export interface CodexConnectionState {
	/** 현재 프로세스와 initialize handshake의 진행 단계다. */
	phase: CodexConnectionPhase;
	/** 확인된 `codex-cli` 버전이며 확인 전에는 존재하지 않는다. */
	cliVersion?: string;
	/** initialize 응답의 app-server user agent이며 응답 전에는 존재하지 않는다. */
	serverUserAgent?: string;
	/** 연결 실패 시 사용자와 로그에 표시할 정규화된 오류 메시지다. */
	error?: string;
}

/** Thread 안에서 하나의 Turn이 보유하는 실행 및 Item 상태다. */
export interface CodexTurnState {
	/** 이 Turn이 속한 Codex Thread ID다. */
	threadId: string;
	/** Codex가 생성한 Turn ID다. */
	turnId: string;
	/** 진행 중, 완료, 중단, 실패를 나타내는 생성 상태 값이다. */
	status: TurnStatus;
	/** 현재 Item 배열이 미로딩, 요약, 전체 중 어느 범위인지 나타낸다. */
	itemsView: TurnItemsView;
	/** Item ID를 키로 보관하는 core 5 timeline Item 상태다. */
	items: ReadonlyMap<string, CodexTimelineItem>;
	/** 실패한 Turn의 생성 오류 정보이며 그 외 상태에서는 `null`이다. */
	error: TurnError | null;
	/** Unix seconds 단위의 Turn 시작 시각이며 아직 모르면 `null`이다. */
	startedAt: number | null;
	/** Unix seconds 단위의 Turn 완료 시각이며 진행 중이면 `null`이다. */
	completedAt: number | null;
	/** Turn 전체 소요 밀리초이며 app-server가 제공하지 않으면 `null`이다. */
	durationMs: number | null;
}

/** 여러 Turn을 포함하는 Codex Thread의 Host 상태다. */
export interface CodexThreadState {
	/** Codex가 생성한 안정적인 Thread ID다. */
	threadId: string;
	/** Thread가 미로딩, idle, active, system error 중 어느 상태인지 나타낸다. */
	status: ThreadStatus;
	/** Turn ID를 키로 보관하는 Thread의 Turn 상태다. */
	turns: ReadonlyMap<string, CodexTurnState>;
	/** 현재 실행 중인 유일한 Turn ID이며 idle이면 존재하지 않는다. */
	activeTurnId?: string;
}

/** 하나의 timeline Item이 시작 또는 완료 중 어느 생명주기 상태인지 나타낸다. */
export type CodexTimelineItemLifecycle = 'started' | 'completed';

/** 생성 ThreadItem을 복제하지 않고 UI timeline 메타데이터와 결합한다. */
export interface CodexTimelineItem {
	/** 이 Item이 속한 Codex Thread ID다. */
	threadId: string;
	/** 이 Item이 속한 Codex Turn ID다. */
	turnId: string;
	/** 생성 스키마에서 추출한 core 5 Item 원본 상태다. */
	item: CoreThreadItem;
	/** item/started 또는 item/completed에서 유도한 현재 생명주기 상태다. */
	lifecycle: CodexTimelineItemLifecycle;
	/** item/started가 제공한 Unix milliseconds 시각이다. */
	startedAtMs?: number;
	/** item/completed가 제공한 Unix milliseconds 시각이다. */
	completedAtMs?: number;
}

/** Webview가 승인 결과를 선택할 때 사용하는 표시 전용 선택지다. */
export interface CodexApprovalChoiceView {
	/** Host가 생성하고 Webview가 그대로 돌려주는 불투명 선택지 ID다. */
	choiceId: string;
	/** 승인 버튼이나 메뉴에 표시할 사용자용 이름이다. */
	label: string;
	/** 정책 변경 등 추가 판단 정보이며 필요하지 않으면 생략한다. */
	description?: string;
}

/** command와 file 승인 View Model이 공유하는 식별 및 표시 정보다. */
interface CodexApprovalViewBase {
	/** 응답과 serverRequest/resolved 연결에 사용하는 최상위 RPC request ID다. */
	requestId: CodexRequestId;
	/** 승인 요청이 속한 Codex Thread ID다. */
	threadId: string;
	/** 승인 요청이 속한 Codex Turn ID다. */
	turnId: string;
	/** 승인 대상 Thread Item ID다. */
	itemId: string;
	/** 승인 요청 시작 Unix milliseconds 시각이다. */
	startedAtMs: number;
	/** 승인 Dock에 표시할 짧은 제목이다. */
	title: string;
	/** app-server가 제공한 승인 이유이며 없으면 `null`이다. */
	reason: string | null;
	/** 사용자에게 노출할 수 있는 승인 선택지 목록이다. */
	choices: readonly CodexApprovalChoiceView[];
}

/** commandExecution 승인 Dock에 전달하는 표시 전용 데이터다. */
export interface CodexCommandApprovalView extends CodexApprovalViewBase {
	/** 승인 종류를 구분하는 고정 discriminator다. */
	kind: 'commandExecution';
	/** 실행하려는 원본 명령이며 app-server가 생략하면 `null`이다. */
	command: string | null;
	/** 명령 실행 디렉터리이며 app-server가 생략하면 `null`이다. */
	cwd: string | null;
	/** 한 Item의 하위 승인 callback을 구분하는 ID이며 일반 요청에서는 `null`이다. */
	approvalId: string | null;
}

/** fileChange 승인 Dock에 전달하는 표시 전용 데이터다. */
export interface CodexFileApprovalView extends CodexApprovalViewBase {
	/** 승인 종류를 구분하는 고정 discriminator다. */
	kind: 'fileChange';
	/** 세션 범위 쓰기 허용을 요청한 root이며 제공되지 않으면 `null`이다. */
	grantRoot: string | null;
}

/** 현재 첨부 규약에서 UI가 표시하는 command 또는 file 승인 union이다. */
export type CodexApprovalView = CodexCommandApprovalView
	| CodexFileApprovalView;

/** Host가 command 선택지와 정확한 생성 decision을 함께 보관하는 상태다. */
export interface CodexPendingCommandApproval {
	/** app-server가 보낸 수정하지 않은 command 승인 요청이다. */
	request: CommandExecutionApprovalRequest;
	/** Webview에 전달할 command 승인 표시 데이터다. */
	view: CodexCommandApprovalView;
	/** choice ID를 app-server에 그대로 반환할 decision으로 연결한다. */
	decisionsByChoiceId: ReadonlyMap<string, CommandApprovalDecision>;
}

/** Host가 file 선택지와 정확한 생성 decision을 함께 보관하는 상태다. */
export interface CodexPendingFileApproval {
	/** app-server가 보낸 수정하지 않은 file 승인 요청이다. */
	request: FileChangeApprovalRequest;
	/** Webview에 전달할 file 승인 표시 데이터다. */
	view: CodexFileApprovalView;
	/** choice ID를 app-server에 그대로 반환할 decision으로 연결한다. */
	decisionsByChoiceId: ReadonlyMap<string, FileApprovalDecision>;
}

/** Extension Host가 응답 전까지 보관하는 승인 요청 상태 union이다. */
export type CodexPendingApproval = CodexPendingCommandApproval
	| CodexPendingFileApproval;

/** 로그가 어느 방향 또는 프로세스 소스에서 발생했는지 나타낸다. */
export type CodexLogDirection = 'hostToServer'
	| 'serverToHost'
	| 'process';

/** Output Channel에서 raw payload를 분류하는 메시지 종류다. */
export type CodexLogMessageKind = 'request'
	| 'response'
	| 'notification'
	| 'stderr'
	| 'lifecycle'
	| 'parseError'
	| 'validationError';

/** Output Channel에 기록할 app-server 메시지의 구조화된 메타데이터다. */
export interface CodexLogRecord {
	/** 로그를 만든 시점의 ISO 8601 문자열이다. */
	timestamp: string;
	/** 메시지가 이동한 방향 또는 프로세스 자체 이벤트다. */
	direction: CodexLogDirection;
	/** 요청, 응답, 알림, stderr 등 로그의 분류다. */
	kind: CodexLogMessageKind;
	/** 수정하거나 마스킹하지 않은 원본 JSON 또는 stderr 문자열이다. */
	raw: string;
	/** 메시지가 method를 가질 때 기록하는 정확한 protocol method다. */
	method?: string;
	/** 메시지가 ID를 가질 때 기록하는 request ID다. */
	requestId?: CodexRequestId;
	/** payload에서 찾은 Thread ID다. */
	threadId?: string;
	/** payload에서 찾은 Turn ID다. */
	turnId?: string;
	/** payload에서 찾은 Item ID다. */
	itemId?: string;
}
