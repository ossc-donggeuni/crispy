import type { WorkspaceToWebviewMessage } from '../messages';
import type { Graph } from '../webview/graph/graphModel';
import type { WorkspaceSnapshot } from './workspaceModel';

/** 현재 Workspace Graph 생성과 Webview 전송에 필요한 좁은 의존성 경계다. */
export interface WorkspaceRefreshDependencies {
	createWorkspaceSnapshot(): Promise<WorkspaceSnapshot>;
	convertWorkspaceSnapshotToGraph(snapshot: WorkspaceSnapshot): Graph;
	postMessage(message: WorkspaceToWebviewMessage): PromiseLike<boolean>;
}

/** 한 Canvas runtime에 귀속되는 Workspace Refresh 단일 진입점이다. */
export interface WorkspaceRefreshCoordinator {
	/** 실행 중 요청을 pending 후속 실행으로 병합하며 완료 Promise는 reject하지 않는다. */
	requestWorkspaceRefresh(): Promise<void>;
}

/** 초기화와 Refresh가 공유하는 현재 Workspace Snapshot → Graph 생성 경로다. */
export async function createCurrentWorkspaceGraph(
	dependencies: Pick<
		WorkspaceRefreshDependencies,
		'createWorkspaceSnapshot' | 'convertWorkspaceSnapshotToGraph'
	>,
): Promise<Graph> {
	const snapshot = await dependencies.createWorkspaceSnapshot();

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

	const runRefreshLoop = async (): Promise<void> => {
		try {
			do {
				pending = false;

				try {
					const graph = await createCurrentWorkspaceGraph(dependencies);

					await dependencies.postMessage({
						type: 'workspace.graphUpdated',
						graph,
					} satisfies WorkspaceToWebviewMessage);
				} catch {
					/** 실패한 결과는 전송하지 않고 실행 중 쌓인 pending 요청만 계속한다. */
				}
			} while (pending);
		} finally {
			refreshing = false;
			activeRefresh = undefined;
		}
	};

	return {
		requestWorkspaceRefresh(): Promise<void> {
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
	};
}
