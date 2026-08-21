import {
	parseDetachedRootNodeIds,
	parseFileGroupPages,
	parseNodePositions,
	parseOpenedFolders,
	type GraphNodePosition,
} from '../webview/graph/graphState';

/** 현재 해석할 수 있는 Workspace Persistent State 형식 버전이다. */
export const WORKSPACE_PERSISTENT_STATE_VERSION = 1;

/** 향후 Workspace Root의 `.crispy/state.json`에 저장할 Graph 상태다. */
export interface WorkspacePersistentState {
	version: typeof WORKSPACE_PERSISTENT_STATE_VERSION;
	nodePositions: Record<string, GraphNodePosition>;
	fileGroupPages: Record<string, number>;
	openedFolders: Record<string, true>;
	detachedRootNodeIds: Record<string, true>;
}

/** 외부 객체와 참조를 공유하지 않는 기본 Workspace Persistent State를 생성한다. */
export function createDefaultWorkspacePersistentState(): WorkspacePersistentState {
	return {
		version: WORKSPACE_PERSISTENT_STATE_VERSION,
		nodePositions: {},
		fileGroupPages: {},
		openedFolders: {},
		detachedRootNodeIds: {},
	};
}

/** 현재 버전의 Workspace metadata를 검증해 독립적인 객체로 복사한다. */
export function parseWorkspacePersistentState(
	value: unknown,
): WorkspacePersistentState | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;

	if (candidate.version !== WORKSPACE_PERSISTENT_STATE_VERSION) {
		return undefined;
	}

	const nodePositions = parseNodePositions(candidate.nodePositions);
	const fileGroupPages = parseFileGroupPages(candidate.fileGroupPages);
	const openedFolders = parseOpenedFolders(candidate.openedFolders);
	const detachedRootNodeIds = parseDetachedRootNodeIds(
		candidate.detachedRootNodeIds,
	);

	if (
		!nodePositions
		|| !fileGroupPages
		|| !openedFolders
		|| !detachedRootNodeIds
	) {
		return undefined;
	}

	return {
		version: WORKSPACE_PERSISTENT_STATE_VERSION,
		nodePositions,
		fileGroupPages,
		openedFolders,
		detachedRootNodeIds,
	};
}
