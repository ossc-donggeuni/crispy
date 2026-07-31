/**
 * Codex와 이후 추가될 Agent Provider가 공통으로 반환하는 변경 계획의 단위 작업입니다.
 * 각 대상 배열은 Workspace 루트 기준 상대 경로만 포함합니다.
 */
export interface ChangePlanTask {
	id: string;
	title: string;
	description: string;
	order: number;
	directTargets: string[];
	createdTargets: string[];
	deletedTargets: string[];
	referenceTargets: string[];
	possibleImpactTargets: string[];
}

/** 변경 또는 참고가 예상되는 파일 항목입니다. */
export interface ChangePlanFileItem {
	path: string;
	codeNodeId: string;
	reason: string;
	taskIds: string[];
}

/** 파일 전체 삭제와 파일 내부 요소 제거를 함께 표현하는 항목입니다. */
export interface ChangePlanRemovedTarget {
	path: string;
	codeNodeId: string;
	description: string;
	isFileDeletion: boolean;
	taskIds: string[];
}

export type ChangePlanRelation = 'direct' | 'possible-impact' | 'reference';
export type ChangePlanChange = 'create' | 'modify' | 'delete';
export type ChangePlanMatchStatus = 'resolved' | 'scoped' | 'unresolved';

/**
 * ChangePlan의 모든 대상을 하나의 그래프 노드 형태로 정규화한 항목입니다.
 * unresolved 대상만 path가 null일 수 있습니다.
 */
export interface ChangePlanTargetNode {
	relation: ChangePlanRelation;
	changes: ChangePlanChange[];
	matchStatus: ChangePlanMatchStatus;
	path: string | null;
	codeNodeId: string;
	taskIds: string[];
	isAdditionalCandidate: boolean;
	isFileDeletion: boolean;
	originalTargetText: string | null;
	note: string | null;
}

/** Crispy가 Provider와 무관하게 소비하는 최종 작업 계획입니다. */
export interface ChangePlan {
	title: string;
	summary: string;
	tasks: ChangePlanTask[];
	expectedModifiedFiles: ChangePlanFileItem[];
	expectedCreatedFiles: ChangePlanFileItem[];
	expectedDeletedOrRemovedTargets: ChangePlanRemovedTarget[];
	referenceFiles: ChangePlanFileItem[];
	targetNodes: ChangePlanTargetNode[];
	preImplementationChecks: string[];
	postImplementationComparisonCriteria: string[];
}

/** Webview에 Provider별 명령 문자열 대신 전달하는 의미 기반 도구 이름입니다. */
export type AgentToolName = 'list_files' | 'read_file' | 'search_code' | 'run_command';

/** Agent 실행 중 Webview 등 외부 소비자에게 실시간으로 전달되는 공통 이벤트입니다. */
export type AgentEvent =
	| { type: 'status'; message: string }
	| { type: 'tool'; name: AgentToolName; target?: string }
	| { type: 'message'; text: string }
	| { type: 'plan'; plan: ChangePlan }
	| { type: 'error'; message: string };

export type AgentRunStatus = 'completed' | 'failed' | 'cancelled' | 'timed-out';

/**
 * Agent 프로세스 종료 정보와 검증된 ChangePlan을 함께 반환하는 공통 결과입니다.
 * completed가 아닌 경우 plan은 제공하지 않고 error에 사용자에게 전달할 원인을 담습니다.
 */
export interface AgentRunResult {
	provider: 'codex';
	status: AgentRunStatus;
	exitCode: number | null;
	stderr: string;
	parseFailureCount: number;
	plan?: ChangePlan;
	error?: string;
}

/** runCodex 실행 옵션입니다. timeoutMs를 생략하면 5분을 사용합니다. */
export interface RunCodexOptions {
	workspaceRoot: string;
	onEvent?: (event: AgentEvent) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
}
