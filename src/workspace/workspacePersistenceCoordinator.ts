import * as vscode from 'vscode';
import {
	createDefaultWorkspacePersistentState,
	parseWorkspacePersistentState,
	type WorkspacePersistentState,
	type WorkspaceTaskRelocation,
} from './workspaceMetadata';
import {
	mergeWorkspacePersistentStates,
	partitionWorkspacePersistentStateByRoot,
	writeWorkspacePersistentState,
	type WorkspaceRootPersistentState,
} from './workspacePersistence';

/** Root 전체 snapshot을 실제 저장소에 기록하는 주입 가능한 경계다. */
export type WorkspaceRootStateWriter = (
	rootUri: vscode.Uri,
	state: WorkspacePersistentState,
) => Promise<void>;

/** Workspace runtime snapshot을 순서대로 안전하게 저장하는 coordinator다. */
export interface WorkspacePersistenceCoordinator {
	/** Disk에서 읽은 현재 상태를 write 없이 durable 기준점으로 교체한다. */
	setInitialState(
		state: WorkspacePersistentState,
		rootUris: readonly vscode.Uri[],
	): void;
	/** 최신 desired snapshot을 받아 실행 중 변경을 후속 한 번으로 병합한다. */
	acceptSnapshot(
		state: WorkspacePersistentState,
		rootUris: readonly vscode.Uri[],
	): Promise<void>;
	/** 현재 desired snapshot의 독립 복사본을 반환한다. */
	getDesiredState(): WorkspacePersistentState | undefined;
	/** 실행 중 write를 기다리고, 직전 실패가 있으면 마지막 snapshot을 한 번 재시도한다. */
	flush(): Promise<void>;
	/** 새 snapshot을 거부하고 현재 write만 완료되도록 한다. */
	dispose(): void;
}

export interface WorkspacePersistenceCoordinatorDependencies {
	readonly writeState?: WorkspaceRootStateWriter;
	readonly logger?: Pick<Console, 'warn'>;
}

interface DesiredWorkspaceSnapshot {
	readonly generation: number;
	readonly state: WorkspacePersistentState;
	readonly rootUris: readonly vscode.Uri[];
}

/**
 * 같은 state.json을 공유하는 Graph/Task 변경을 단일 직렬 경계에서 처리한다.
 * owner 이동은 source live record를 journal로 바꾼 뒤 destination을 staging하고
 * final snapshot으로 정리해, Root가 서로 교차하는 이동에서도 Task 유실을 막는다.
 */
export function createWorkspacePersistenceCoordinator(
	dependencies: WorkspacePersistenceCoordinatorDependencies = {},
): WorkspacePersistenceCoordinator {
	const writeState = dependencies.writeState ?? writeWorkspacePersistentState;
	const logger = dependencies.logger ?? console;
	let desired: DesiredWorkspaceSnapshot | undefined;
	let durableState: WorkspacePersistentState | undefined;
	let nextGeneration = 0;
	let completedGeneration = 0;
	let lastAttemptedGeneration = 0;
	let activeWrite: Promise<void> | undefined;
	let disposed = false;

	const run = async (): Promise<void> => {
		try {
			while (!disposed && desired?.generation !== completedGeneration) {
				const target = desired;
				if (!target) {
					break;
				}

				lastAttemptedGeneration = target.generation;
				const confirmedRootStates = new Map(
					partitionWorkspacePersistentStateByRoot(
						durableState ?? createDefaultWorkspacePersistentState(),
						target.rootUris,
					).map((rootState) => [
						rootState.rootUri.toString(),
						rootState,
					]),
				);
				try {
					await persistWorkspaceStateTransition(
						durableState ?? createDefaultWorkspacePersistentState(),
						target.state,
						target.rootUris,
						async (rootUri, state) => {
							await writeState(rootUri, state);
							confirmedRootStates.set(rootUri.toString(), {
								rootUri,
								state: cloneWorkspaceState(state),
							});
						},
					);
					durableState = cloneWorkspaceState(target.state);
					completedGeneration = target.generation;
				} catch (error) {
					durableState = mergeWorkspacePersistentStates([
						...confirmedRootStates.values(),
					]);
					logger.warn('[Crispy] Failed to persist Workspace State.', error);
					break;
				}
			}
		} finally {
			activeWrite = undefined;
			// 실패한 generation 자체는 busy-loop하지 않는다. 실행 중 더 최신 입력이
			// 도착한 경우에만 새 snapshot으로 다시 한 번 진행한다.
			if (
				!disposed
				&& desired
				&& desired.generation !== completedGeneration
				&& desired.generation !== lastAttemptedGeneration
			) {
				activeWrite = Promise.resolve().then(run);
			}
		}
	};

	const ensureRun = (): Promise<void> => {
		activeWrite ??= Promise.resolve().then(run);
		return activeWrite;
	};

	return {
		setInitialState(state, rootUris): void {
			if (disposed) {
				return;
			}
			const parsed = parseWorkspacePersistentState(state)
				?? createDefaultWorkspacePersistentState();
			const generation = ++nextGeneration;

			durableState = cloneWorkspaceState(parsed);
			desired = {
				generation,
				state: cloneWorkspaceState(parsed),
				rootUris: [...rootUris],
			};
			completedGeneration = generation;
			lastAttemptedGeneration = generation;
		},
		acceptSnapshot(state, rootUris): Promise<void> {
			if (disposed) {
				return Promise.resolve();
			}
			const parsed = parseWorkspacePersistentState(state);

			if (!parsed) {
				return activeWrite ?? Promise.resolve();
			}
			desired = {
				generation: ++nextGeneration,
				state: cloneWorkspaceState(parsed),
				rootUris: [...rootUris],
			};
			return ensureRun();
		},
		getDesiredState(): WorkspacePersistentState | undefined {
			return desired ? cloneWorkspaceState(desired.state) : undefined;
		},
		async flush(): Promise<void> {
			await activeWrite;
			if (
				!disposed
				&& desired
				&& desired.generation !== completedGeneration
			) {
				// 직전 실패는 deactivate/panel teardown에서 한 번만 재시도한다.
				lastAttemptedGeneration = 0;
				await ensureRun();
			}
			if (desired && desired.generation !== completedGeneration) {
				throw new Error('Workspace persistence flush did not reach desired state.');
			}
		},
		dispose(): void {
			disposed = true;
		},
	};
}

/**
 * 이전 durable snapshot에서 다음 snapshot으로 이동한다. owner가 바뀐 Task는
 * source live record를 journal로 먼저 바꾸고 destination Root를 staging한다.
 * 모든 destination staging이 성공한 뒤에만 final snapshot을 기록한다.
 */
export async function persistWorkspaceStateTransition(
	previousState: WorkspacePersistentState,
	nextState: WorkspacePersistentState,
	rootUris: readonly vscode.Uri[],
	writeState: WorkspaceRootStateWriter = writeWorkspacePersistentState,
): Promise<void> {
	const previous = parseWorkspacePersistentState(previousState)
		?? createDefaultWorkspacePersistentState();
	const next = parseWorkspacePersistentState(nextState)
		?? createDefaultWorkspacePersistentState();
	const previousByRoot = indexRootStates(
		partitionWorkspacePersistentStateByRoot(previous, rootUris),
	);
	const nextRootStates = partitionWorkspacePersistentStateByRoot(next, rootUris);
	const nextByRoot = indexRootStates(nextRootStates);
	const previousOwnerByTaskId = new Map(
		previous.tasks.map((record) => [record.task.id, record.ownerRootId]),
	);
	const moves: WorkspaceTaskRelocation[] = [];
	const moveKeys = new Set<string>();
	const destinationRootIds = new Set<string>();
	const appendMove = (move: WorkspaceTaskRelocation): void => {
		const key = JSON.stringify([move.sourceRootId, move.record.task.id]);

		if (moveKeys.has(key)) {
			return;
		}
		moveKeys.add(key);
		moves.push(move);
		destinationRootIds.add(move.record.ownerRootId);
	};

	for (const record of next.tasks) {
		const previousOwnerRootId = previousOwnerByTaskId.get(record.task.id);

		if (previousOwnerRootId && previousOwnerRootId !== record.ownerRootId) {
			appendMove({
				sourceRootId: previousOwnerRootId,
				record,
			});
		}
	}
	for (const relocation of previous.taskRelocations) {
		const recovered = next.tasks.find((record) => (
			record.task.id === relocation.record.task.id
			&& record.ownerRootId === relocation.record.ownerRootId
			&& record.storageRevision >= relocation.record.storageRevision
		));
		const journalStillDesired = next.taskRelocations.some((candidate) => (
			candidate.sourceRootId === relocation.sourceRootId
			&& candidate.record.task.id === relocation.record.task.id
		));

		if (recovered && !journalStillDesired) {
			appendMove({ ...relocation, record: recovered });
		}
	}

	// source의 기존 live record를 먼저 relocation journal로 바꾼다. 이 write가
	// 성공한 뒤에는 destination/final write 중 crash가 나도 source 단독 복원에서
	// 이전 owner Task가 다시 나타나지 않으며, 전체 Root에서는 record를 회수한다.
	const movesBySource = new Map<string, WorkspaceTaskRelocation[]>();

	for (const move of moves) {
		const sourceMoves = movesBySource.get(move.sourceRootId) ?? [];

		sourceMoves.push(move);
		movesBySource.set(move.sourceRootId, sourceMoves);
	}
	for (const rootUri of rootUris) {
		const rootId = createWorkspaceRootNodeId(rootUri);
		const sourceMoves = movesBySource.get(rootId);

		if (!sourceMoves) {
			continue;
		}
		const nextRoot = nextByRoot.get(rootUri.toString());

		if (!nextRoot) {
			continue;
		}
		await writeState(rootUri, {
			...nextRoot.state,
			taskRelocations: mergeTaskRelocationsForStaging(
				nextRoot.state.taskRelocations,
				sourceMoves,
			),
		});
	}

	for (const rootUri of rootUris) {
		const rootId = createWorkspaceRootNodeId(rootUri);

		if (!destinationRootIds.has(rootId)) {
			continue;
		}
		const nextRoot = nextByRoot.get(rootUri.toString());

		if (!nextRoot) {
			continue;
		}
		const previousRoot = previousByRoot.get(rootUri.toString());
		const sourceMoves = movesBySource.get(rootId) ?? [];
		const stagedState = {
			...nextRoot.state,
			tasks: mergeTaskRecordsForStaging(
				previousRoot?.state.tasks ?? [],
				nextRoot.state.tasks,
				new Set(sourceMoves.map((move) => move.record.task.id)),
			),
			taskRelocations: mergeTaskRelocationsForStaging(
				nextRoot.state.taskRelocations,
				sourceMoves,
			),
		};

		await writeState(rootUri, stagedState);
	}

	// staging이 모두 성공한 뒤 final snapshot을 쓴다. Root별 저수준 chain과 별개로
	// 이 함수 호출 자체가 coordinator에서 직렬화되므로 stale full snapshot이 없다.
	const failures: unknown[] = [];

	const orderedFinalRootStates = [...nextRootStates].sort((left, right) => {
		const leftDestination = destinationRootIds.has(
			createWorkspaceRootNodeId(left.rootUri),
		);
		const rightDestination = destinationRootIds.has(
			createWorkspaceRootNodeId(right.rootUri),
		);

		return leftDestination === rightDestination
			? 0
			: leftDestination ? -1 : 1;
	});

	for (const { rootUri, state } of orderedFinalRootStates) {
		try {
			await writeState(rootUri, state);
		} catch (error) {
			failures.push(error);
		}
	}

	if (failures.length > 0) {
		throw new AggregateError(failures, 'Workspace final state write failed.');
	}
}

function indexRootStates(
	rootStates: readonly WorkspaceRootPersistentState[],
): ReadonlyMap<string, WorkspaceRootPersistentState> {
	return new Map(rootStates.map((rootState) => [
		rootState.rootUri.toString(),
		rootState,
	]));
}

function mergeTaskRecordsForStaging(
	previous: WorkspacePersistentState['tasks'],
	next: WorkspacePersistentState['tasks'],
	excludedPreviousTaskIds: ReadonlySet<string> = new Set(),
): WorkspacePersistentState['tasks'] {
	const byTaskId = new Map(previous
		.filter((record) => !excludedPreviousTaskIds.has(record.task.id))
		.map((record) => [record.task.id, record]));

	for (const record of next) {
		const existing = byTaskId.get(record.task.id);

		if (!existing || record.storageRevision >= existing.storageRevision) {
			byTaskId.set(record.task.id, record);
		}
	}
	return [...byTaskId.values()];
}

function mergeTaskRelocationsForStaging(
	previous: readonly WorkspaceTaskRelocation[],
	next: readonly WorkspaceTaskRelocation[],
): readonly WorkspaceTaskRelocation[] {
	const byMove = new Map(previous.map((relocation) => [
		JSON.stringify([
			relocation.sourceRootId,
			relocation.record.task.id,
		]),
		relocation,
	]));

	for (const relocation of next) {
		const key = JSON.stringify([
			relocation.sourceRootId,
			relocation.record.task.id,
		]);
		const current = byMove.get(key);

		if (
			!current
			|| relocation.record.storageRevision
				>= current.record.storageRevision
		) {
			byMove.set(key, relocation);
		}
	}
	return [...byMove.values()];
}

function createWorkspaceRootNodeId(rootUri: vscode.Uri): string {
	return `workspace-root:${rootUri.toString()}`;
}

function cloneWorkspaceState(state: WorkspacePersistentState): WorkspacePersistentState {
	return parseWorkspacePersistentState(state)
		?? createDefaultWorkspacePersistentState();
}
