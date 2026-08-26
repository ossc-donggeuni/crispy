import {
	resolveEffectiveWorkGraphTargets,
	type TaskBlueprint,
	type WorkAgentProviderId,
} from './taskModel';
import { getTaskFlowAnalysis } from './taskValidation';
import type {
	TaskGraphTargetArea,
	TaskGraphTargetOrigin,
	WorkspaceTaskRecord,
} from './workspaceTaskState';

/** Host가 Task 실행 전체에 부여하는 terminal 상태다. */
export type TaskExecutionState = 'running' | 'completed' | 'rejected' | 'failed';

/** 연결된 Work 하나가 실행 중 거치는 상태다. */
export type TaskWorkExecutionState =
	| 'pending'
	| 'starting'
	| 'running'
	| 'waiting-approval'
	| 'completed'
	| 'rejected'
	| 'failed'
	| 'blocked';

/** 외부 소비자가 변경할 수 없는 Work 실행 상태다. */
export interface TaskWorkExecutionSnapshot {
	readonly nodeId: string;
	readonly state: TaskWorkExecutionState;
	readonly summary?: string;
}

/** Blueprint 영속 상태와 분리된 Task 실행의 현재 snapshot이다. */
export interface TaskExecutionSnapshot {
	readonly executionId: string;
	readonly taskId: string;
	readonly storageRevision: number;
	readonly state: TaskExecutionState;
	readonly startNodeId: string;
	readonly endNodeId: string;
	readonly works: readonly TaskWorkExecutionSnapshot[];
}

/** terminal Start 상태와 별개로 Agent process가 더 진행 중인지 판별한다. */
export function isTaskExecutionActive(snapshot: TaskExecutionSnapshot): boolean {
	return snapshot.state === 'running' || snapshot.works.some(({ state }) => (
		state === 'starting'
		|| state === 'running'
		|| state === 'waiting-approval'
	));
}

export type TaskExecutionSubscriber = (snapshot: TaskExecutionSnapshot) => void;

/** Provider sandbox와 사용자 prompt가 공유하는 하나의 정규화된 실행 범위다. */
export interface TaskExecutionScopeTarget {
	readonly sourceId: string;
	readonly sourceRootId: string;
	readonly access: 'read' | 'read-write';
	/** 기본 범위와 Work 고유 범위 중 실제 provenance를 가진 Task node다. */
	readonly originNodeId: string;
}

/** Work 시작 시점에 Host가 Workspace record에서 고정하는 불변 실행 계획이다. */
export interface TaskWorkExecutionPlan {
	readonly taskId: string;
	readonly workNodeId: string;
	readonly title: string;
	readonly prompt: string;
	readonly providerId: WorkAgentProviderId;
	/** 기존 Agent 탭 assignment가 사용하는 Task 소유 Workspace Root다. */
	readonly workspaceRootId: string;
	readonly scope: readonly TaskExecutionScopeTarget[];
}

/** DAG dependency와 실행 상태 전이를 소유하는 Host용 scheduler다. */
export interface TaskExecutionScheduler {
	getSnapshot(): TaskExecutionSnapshot;
	/** 현재 admission과 dependency를 모두 통과한 pending Work를 Blueprint 순서로 반환한다. */
	getReadyWorkNodeIds(): readonly string[];
	markWorkStarting(workNodeId: string): boolean;
	markWorkRunning(workNodeId: string): boolean;
	markWorkWaitingForApproval(workNodeId: string): boolean;
	resumeWork(workNodeId: string): boolean;
	completeWork(workNodeId: string, summary?: string): boolean;
	rejectWork(workNodeId: string, summary?: string): boolean;
	failWork(workNodeId: string, summary?: string): boolean;
	subscribe(subscriber: TaskExecutionSubscriber): () => void;
}

interface MutableWorkExecution {
	readonly nodeId: string;
	state: TaskWorkExecutionState;
	summary?: string;
}

/**
 * Task 기본 범위와 Work 고유 범위를 합성해 실행 입력을 만든다.
 * 같은 Source가 reference/work에 함께 있으면 실제 수정 권한이 필요한 work가 이긴다.
 * provenance가 하나라도 누락된 record는 프롬프트만으로 보완하지 않고 fail-closed한다.
 */
export function createTaskWorkExecutionPlan(
	record: WorkspaceTaskRecord,
	workNodeId: string,
): TaskWorkExecutionPlan | undefined {
	const work = record.task.nodes.find((node) => (
		node.kind === 'work' && node.id === workNodeId
	));
	if (work?.kind !== 'work') {
		return undefined;
	}
	const targets = resolveEffectiveWorkGraphTargets(record.task, workNodeId);
	if (!targets) {
		return undefined;
	}
	const start = record.task.nodes.find((node) => node.kind === 'start');
	if (!start) {
		throw new Error('Task execution start node is missing.');
	}
	const workSourceIds = new Set(targets.work);
	const scope: TaskExecutionScopeTarget[] = [];
	const appendTarget = (
		sourceId: string,
		area: TaskGraphTargetArea,
		access: TaskExecutionScopeTarget['access'],
	): void => {
		const origin = findTaskTargetOrigin(
			record.targetOrigins,
			work.id,
			start.id,
			area,
			sourceId,
		);
		if (!origin) {
			throw new Error('Task execution target provenance is missing.');
		}
		scope.push(Object.freeze({
			sourceId,
			sourceRootId: origin.sourceRootId,
			access,
			originNodeId: origin.nodeId,
		}));
	};

	for (const sourceId of targets.reference) {
		if (!workSourceIds.has(sourceId)) {
			appendTarget(sourceId, 'reference', 'read');
		}
	}
	for (const sourceId of targets.work) {
		appendTarget(sourceId, 'work', 'read-write');
	}

	return Object.freeze({
		taskId: record.task.id,
		workNodeId: work.id,
		title: work.title,
		prompt: work.prompt,
		providerId: work.agentProviderId,
		workspaceRootId: record.ownerRootId,
		scope: Object.freeze(scope),
	});
}

/** Work-local provenance를 기본 Start provenance보다 우선한다. */
function findTaskTargetOrigin(
	origins: readonly TaskGraphTargetOrigin[],
	workNodeId: string,
	startNodeId: string,
	area: TaskGraphTargetArea,
	sourceId: string,
): TaskGraphTargetOrigin | undefined {
	return origins.find((origin) => (
		origin.nodeId === workNodeId
		&& origin.area === area
		&& origin.sourceId === sourceId
	)) ?? origins.find((origin) => (
		origin.nodeId === startNodeId
		&& origin.area === area
		&& origin.sourceId === sourceId
	));
}

/**
 * ready Task의 연결된 subgraph만 고정해 실행 scheduler를 만든다.
 * 고립 Work는 flow 분석과 동일하게 실행 대상에서 제외한다.
 */
export function createTaskExecutionScheduler(
	task: TaskBlueprint,
	executionId: string,
	storageRevision: number,
): TaskExecutionScheduler {
	assertExecutionIdentity(executionId, storageRevision);
	const analysis = getTaskFlowAnalysis(task);
	if (analysis.status !== 'ready') {
		throw new Error('Task flow is not ready for execution.');
	}
	const start = task.nodes.find((node) => node.kind === 'start');
	const end = task.nodes.find((node) => node.kind === 'end');
	if (!start || !end) {
		throw new Error('Task execution boundaries are missing.');
	}
	const connectedNodeIds = new Set(analysis.connectedNodeIds);
	const connectedWorks = task.nodes.filter((node) => (
		node.kind === 'work' && connectedNodeIds.has(node.id)
	));
	const workByNodeId = new Map<string, MutableWorkExecution>(
		connectedWorks.map((work) => [work.id, {
			nodeId: work.id,
			state: 'pending',
		}]),
	);
	const incomingByNodeId = new Map<string, string[]>();
	for (const nodeId of connectedNodeIds) {
		incomingByNodeId.set(nodeId, []);
	}
	for (const edge of task.edges) {
		if (connectedNodeIds.has(edge.source) && connectedNodeIds.has(edge.target)) {
			incomingByNodeId.get(edge.target)?.push(edge.source);
		}
	}
	const subscribers = new Set<TaskExecutionSubscriber>();
	let executionState: TaskExecutionState = 'running';

	const createSnapshot = (): TaskExecutionSnapshot => Object.freeze({
		executionId,
		taskId: task.id,
		storageRevision,
		state: executionState,
		startNodeId: start.id,
		endNodeId: end.id,
		works: Object.freeze(connectedWorks.map(({ id }) => {
			const work = workByNodeId.get(id)!;
			return Object.freeze({
				nodeId: work.nodeId,
				state: work.state,
				...(work.summary === undefined ? {} : { summary: work.summary }),
			});
		})),
	});

	const notify = (): void => {
		const snapshot = createSnapshot();
		for (const subscriber of [...subscribers]) {
			try {
				subscriber(snapshot);
			} catch {
				/** 실행 상태 구독자 하나의 실패를 scheduler 경계에 격리한다. */
			}
		}
	};

	const arePredecessorsCompleted = (workNodeId: string): boolean => (
		(incomingByNodeId.get(workNodeId) ?? []).every((predecessorId) => (
			predecessorId === start.id
				|| workByNodeId.get(predecessorId)?.state === 'completed'
		))
	);

	const getReadyWorkNodeIds = (): readonly string[] => executionState === 'running'
		? Object.freeze(connectedWorks.flatMap(({ id }) => (
			workByNodeId.get(id)?.state === 'pending' && arePredecessorsCompleted(id)
				? [id]
				: []
		)))
		: Object.freeze([]);

	const transition = (
		workNodeId: string,
		from: readonly TaskWorkExecutionState[],
		to: TaskWorkExecutionState,
		summary?: string,
	): boolean => {
		const work = workByNodeId.get(workNodeId);
		if (!work || !from.includes(work.state)) {
			return false;
		}
		work.state = to;
		if (summary === undefined) {
			delete work.summary;
		} else {
			work.summary = summary;
		}
		return true;
	};

	const blockUnstartedWorks = (): void => {
		for (const work of workByNodeId.values()) {
			if (work.state === 'pending' || work.state === 'starting') {
				work.state = 'blocked';
			}
		}
	};

	const endIsReached = (): boolean => (
		(incomingByNodeId.get(end.id) ?? []).every((nodeId) => (
			workByNodeId.get(nodeId)?.state === 'completed'
		))
	);

	return {
		getSnapshot: createSnapshot,
		getReadyWorkNodeIds,

		markWorkStarting(workNodeId): boolean {
			if (
				executionState !== 'running'
				|| !getReadyWorkNodeIds().includes(workNodeId)
				|| !transition(workNodeId, ['pending'], 'starting')
			) {
				return false;
			}
			notify();
			return true;
		},

		markWorkRunning(workNodeId): boolean {
			if (
				executionState !== 'running'
				|| !transition(workNodeId, ['starting'], 'running')
			) {
				return false;
			}
			notify();
			return true;
		},

		markWorkWaitingForApproval(workNodeId): boolean {
			if (!transition(workNodeId, ['running'], 'waiting-approval')) {
				return false;
			}
			notify();
			return true;
		},

		resumeWork(workNodeId): boolean {
			if (!transition(workNodeId, ['waiting-approval'], 'running')) {
				return false;
			}
			notify();
			return true;
		},

		completeWork(workNodeId, summary): boolean {
			if (!transition(
				workNodeId,
				['running'],
				'completed',
				summary,
			)) {
				return false;
			}
			if (executionState === 'running' && endIsReached()) {
				executionState = 'completed';
			}
			notify();
			return true;
		},

		rejectWork(workNodeId, summary): boolean {
			if (!transition(
				workNodeId,
				['starting', 'running', 'waiting-approval'],
				'rejected',
				summary,
			)) {
				return false;
			}
			if (executionState === 'running') {
				executionState = 'rejected';
				blockUnstartedWorks();
			}
			notify();
			return true;
		},

		failWork(workNodeId, summary): boolean {
			if (!transition(
				workNodeId,
				['starting', 'running', 'waiting-approval'],
				'failed',
				summary,
			)) {
				return false;
			}
			if (executionState === 'running') {
				executionState = 'failed';
				blockUnstartedWorks();
			}
			notify();
			return true;
		},

		subscribe(subscriber): () => void {
			subscribers.add(subscriber);
			return () => subscribers.delete(subscriber);
		},
	};
}

function assertExecutionIdentity(executionId: string, storageRevision: number): void {
	if (executionId.length === 0 || !Number.isSafeInteger(storageRevision) || storageRevision < 0) {
		throw new Error('Task execution identity is invalid.');
	}
}
