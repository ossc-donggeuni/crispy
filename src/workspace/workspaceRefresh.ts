import type { WorkspaceToWebviewMessage } from '../messages';
import type { Graph } from '../webview/graph/graphModel';
import type { WorkspaceSnapshot } from './workspaceModel';
import type { WorkspaceRootFilter } from './workspaceFilterPersistence';
import type { WorkspacePresentation } from './workspacePresentation';
import type { WorkspaceRootCatalogEntry } from './workspaceRootCatalog';

/** 현재 Workspace Snapshot 수집에 필요한 좁은 의존성 경계다. */
export interface WorkspaceSnapshotDependencies {
	loadWorkspaceFilters?(): Promise<readonly WorkspaceRootFilter[]>;
	createWorkspaceSnapshot(
		rootFilters: readonly WorkspaceRootFilter[],
	): Promise<WorkspaceSnapshot>;
}

/** 기존 Workspace Graph 생성 경계를 유지하는 변환 의존성이다. */
export interface WorkspaceGraphDependencies extends WorkspaceSnapshotDependencies {
	convertWorkspaceSnapshotToGraph(snapshot: WorkspaceSnapshot): Graph;
}

/** 같은 Snapshot에서 Graph와 Catalog presentation을 생성하는 의존성이다. */
export interface WorkspacePresentationDependencies extends WorkspaceGraphDependencies {
	readWorkspaceTrust(): boolean;
	createWorkspaceRootCatalog(
		snapshot: WorkspaceSnapshot,
		isTrusted: boolean,
	): readonly WorkspaceRootCatalogEntry[];
}

/** 현재 Workspace Presentation 생성과 Webview 전송에 필요한 의존성 경계다. */
export interface WorkspaceRefreshDependencies
	extends WorkspacePresentationDependencies {
	postMessage(message: WorkspaceToWebviewMessage): PromiseLike<boolean>;
}

/** 한 Canvas runtime에 귀속되는 Workspace Refresh 단일 진입점이다. */
export interface WorkspaceRefreshCoordinator {
	/** 실행 중 요청을 pending 후속 실행으로 병합하며 완료 Promise는 reject하지 않는다. */
	requestWorkspaceRefresh(): Promise<void>;
	/** 새 요청과 결과 전송을 차단하고 pending 후속 실행을 폐기한다. */
	dispose(): void;
}

/** 초기화, Graph와 Presentation이 공유하는 현재 Workspace Snapshot 수집 경로다. */
export async function createCurrentWorkspaceSnapshot(
	dependencies: WorkspaceSnapshotDependencies,
): Promise<WorkspaceSnapshot> {
	let rootFilters: readonly WorkspaceRootFilter[] = [];

	if (dependencies.loadWorkspaceFilters) {
		try {
			rootFilters = await dependencies.loadWorkspaceFilters();
		} catch {
			/** Filter 로드 실패는 Filter 없는 탐색으로 격리해 Graph 생성을 유지한다. */
		}
	}

	return dependencies.createWorkspaceSnapshot(rootFilters);
}

/** 기존 초기화·테스트 경계를 유지하는 현재 Workspace Snapshot → Graph 생성 경로다. */
export async function createCurrentWorkspaceGraph(
	dependencies: WorkspaceGraphDependencies,
): Promise<Graph> {
	const snapshot = await createCurrentWorkspaceSnapshot(dependencies);

	return dependencies.convertWorkspaceSnapshotToGraph(snapshot);
}

/** 같은 현재 Snapshot에서 Graph와 Catalog를 생성해 atomic presentation으로 묶는다. */
export async function createCurrentWorkspacePresentation(
	dependencies: WorkspacePresentationDependencies,
): Promise<WorkspacePresentation> {
	const snapshot = await createCurrentWorkspaceSnapshot(dependencies);
	/** Snapshot 수집 뒤 Catalog 생성에 가장 가까운 시점의 표시용 Trust를 읽는다. */
	const isTrusted = dependencies.readWorkspaceTrust();

	return {
		graph: dependencies.convertWorkspaceSnapshotToGraph(snapshot),
		rootCatalog: dependencies.createWorkspaceRootCatalog(snapshot, isTrusted),
	};
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

	const runRefreshLoop = async (): Promise<void> => {
		try {
			while (!disposed) {
				pending = false;

				try {
					const presentation = await createCurrentWorkspacePresentation(dependencies);

					if (!disposed) {
						await dependencies.postMessage({
							type: 'workspace.snapshotUpdated',
							presentation,
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
			disposed = true;
			pending = false;
		},
	};
}
