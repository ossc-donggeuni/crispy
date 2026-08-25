import {
	getWorkspaceGraphRootIds,
	type WorkspaceToWebviewMessage,
} from '../messages';
import type { Graph } from '../webview/graph/graphModel';
import type { WorkspaceSnapshot } from './workspaceModel';
import type { WorkspaceRootFilter } from './workspaceFilterPersistence';
import type { WorkspacePersistentState } from './workspaceMetadata';

/** 현재 Workspace Graph 생성과 Webview 전송에 필요한 좁은 의존성 경계다. */
export interface WorkspaceRefreshDependencies {
	loadWorkspaceFilters?(): Promise<readonly WorkspaceRootFilter[]>;
	createWorkspaceSnapshot(
		rootFilters: readonly WorkspaceRootFilter[],
	): Promise<WorkspaceSnapshot>;
	convertWorkspaceSnapshotToGraph(snapshot: WorkspaceSnapshot): Graph;
	/** Root 추가/제거 시 새 Root의 Task까지 함께 복원할 Workspace snapshot이다. */
	loadWorkspaceState?(
		graph: Graph,
		rootIds: readonly string[],
		signal: AbortSignal,
	): Promise<WorkspacePersistentState | undefined>;
	/** loadWorkspaceState가 확정한 Host Root context epoch를 반환한다. */
	getWorkspaceContextGeneration?(): number;
	postMessage(message: WorkspaceToWebviewMessage): PromiseLike<boolean>;
}

/** 한 Canvas runtime에 귀속되는 Workspace Refresh 단일 진입점이다. */
export interface WorkspaceRefreshCoordinator {
	/** Canvas runtime detach와 동시에 중단되는 이 coordinator의 lifecycle 신호다. */
	readonly signal: AbortSignal;
	/** 실행 중 요청을 pending 후속 실행으로 병합하며 완료 Promise는 reject하지 않는다. */
	requestWorkspaceRefresh(): Promise<void>;
	/** 새 요청과 결과 전송을 차단하고 pending 후속 실행을 폐기한다. */
	dispose(): void;
}

/** 초기화와 Refresh가 공유하는 현재 Workspace Snapshot → Graph 생성 경로다. */
export async function createCurrentWorkspaceGraph(
	dependencies: Pick<
		WorkspaceRefreshDependencies,
		| 'loadWorkspaceFilters'
		| 'createWorkspaceSnapshot'
		| 'convertWorkspaceSnapshotToGraph'
	>,
): Promise<Graph> {
	let rootFilters: readonly WorkspaceRootFilter[] = [];

	if (dependencies.loadWorkspaceFilters) {
		try {
			rootFilters = await dependencies.loadWorkspaceFilters();
		} catch {
			/** Filter 로드 실패는 Filter 없는 탐색으로 격리해 Graph 생성을 유지한다. */
		}
	}

	const snapshot = await dependencies.createWorkspaceSnapshot(rootFilters);

	return dependencies.convertWorkspaceSnapshotToGraph(snapshot);
}

/**
 * 병렬 탐색 없이 실행 중 요청을 다음 Refresh 한 번으로 병합하는 coordinator다.
 * 각 실행의 Snapshot/변환/전송 실패는 해당 결과만 버리고 pending loop는 유지한다.
 */
export function createWorkspaceRefreshCoordinator(
	dependencies: WorkspaceRefreshDependencies,
): WorkspaceRefreshCoordinator {
	let refreshing = false;
	let pending = false;
	let activeRefresh: Promise<void> | undefined;
	let disposed = false;
	const abortController = new AbortController();
	const { signal } = abortController;

	const runRefreshLoop = async (): Promise<void> => {
		try {
			while (!disposed) {
				pending = false;

				try {
					const graph = await createCurrentWorkspaceGraph(dependencies);
					if (signal.aborted) {
						break;
					}
					const rootIds = getWorkspaceGraphRootIds(graph);
					const workspaceState = await dependencies.loadWorkspaceState?.(
						graph,
						rootIds,
						signal,
					);
					if (signal.aborted) {
						break;
					}
					const contextGeneration =
						dependencies.getWorkspaceContextGeneration?.() ?? 0;

					if (
						!Number.isSafeInteger(contextGeneration)
						|| contextGeneration < 0
					) {
						throw new Error('Invalid Workspace context generation.');
					}

					if (!disposed) {
						await dependencies.postMessage({
							type: 'workspace.graphUpdated',
							graph,
							contextGeneration,
							rootIds,
							...(workspaceState ? { state: workspaceState } : {}),
						} satisfies WorkspaceToWebviewMessage);
					}
				} catch {
					/** 실패한 결과는 전송하지 않고 실행 중 쌓인 pending 요청만 계속한다. */
				}

				if (!pending) {
					break;
				}
			}
		} finally {
			refreshing = false;
			activeRefresh = undefined;
		}
	};

	return {
		signal,
		requestWorkspaceRefresh(): Promise<void> {
			if (disposed) {
				return Promise.resolve();
			}

			if (refreshing) {
				pending = true;
				return activeRefresh ?? Promise.resolve();
			}

			refreshing = true;
			const refresh = Promise.resolve()
				.then(runRefreshLoop)
				.catch(() => undefined);

			activeRefresh = refresh;
			return refresh;
		},
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			pending = false;
			abortController.abort();
		},
	};
}
