export type {
	File,
	Folder,
	WorkspaceEntry,
	WorkspaceDirectoryStatus,
	WorkspaceRoot,
	WorkspaceSnapshot,
} from './workspaceModel';
export {
	createWorkspaceRootId,
	validateWorkspaceRootId,
	WORKSPACE_ROOT_ID_PREFIX,
	type WorkspaceRootId,
	type WorkspaceRootIdValidationErrorCode,
	type WorkspaceRootIdValidationFailure,
	type WorkspaceRootIdValidationResult,
	type WorkspaceRootIdValidationSuccess,
} from './workspaceRootId';
export {
	validateWorkspacePolicy,
	type WorkspacePolicyErrorCode,
	type WorkspacePolicyFailure,
	type WorkspacePolicyInput,
	type WorkspacePolicyResult,
	type WorkspacePolicySuccess,
} from './workspacePolicy';
export { createWorkspaceSnapshot } from './workspaceSnapshot';
export { convertWorkspaceSnapshotToGraph } from './workspaceToGraph';
export {
	createWorkspaceRootCatalog,
	type WorkspaceRootCatalogEntry,
	type WorkspaceRootCatalogUnavailableReason,
} from './workspaceRootCatalog';
export {
	deserializeWorkspacePresentationFromWebview,
	parseWorkspacePresentation,
	serializeWorkspacePresentationForWebview,
	type WorkspacePresentation,
} from './workspacePresentation';
export { readDefaultWorkspaceFilter } from './workspaceDefaultFilter';
export {
	matchesWorkspaceFilterRule,
	parseWorkspaceFilter,
	parseWorkspaceFilterJson,
	WORKSPACE_FILTER_VERSION,
	type WorkspaceFileFilterRule,
	type WorkspaceFilter,
	type WorkspaceFilterRule,
	type WorkspaceFilterRuleKind,
	type WorkspaceFolderFilterRule,
} from './workspaceFilter';
export {
	loadOrCreateWorkspaceFilter,
	loadOrCreateWorkspaceFilters,
	type WorkspaceRootFilter,
} from './workspaceFilterPersistence';
export {
	createDefaultWorkspacePersistentState,
	parseWorkspacePersistentState,
	WORKSPACE_PERSISTENT_STATE_VERSION,
	type WorkspacePersistentState,
	type WorkspaceTaskRelocation,
	type WorkspaceTaskStorageReceipt,
} from './workspaceMetadata';
export {
	mergeWorkspacePersistentStates,
	partitionWorkspacePersistentStateByRoot,
	readWorkspacePersistentState,
	writeWorkspacePersistentState,
	type WorkspacePersistenceWriteOutcome,
	type WorkspaceRootPersistentState,
} from './workspacePersistence';
export {
	createWorkspacePersistenceCoordinator,
	persistWorkspaceStateTransition,
	type WorkspacePersistenceCoordinator,
	type WorkspacePersistenceCoordinatorDependencies,
	type WorkspaceRootStateWriter,
} from './workspacePersistenceCoordinator';
export {
	createCurrentWorkspaceGraph,
	createCurrentWorkspacePresentation,
	createCurrentWorkspaceSnapshot,
	createWorkspaceRefreshCoordinator,
	type WorkspaceGraphDependencies,
	type WorkspacePresentationDependencies,
	type WorkspaceRefreshCoordinator,
	type WorkspaceRefreshDependencies,
	type WorkspaceSnapshotDependencies,
} from './workspaceRefresh';
export { watchWorkspaceChanges } from './workspaceWatcher';
export {
	createWorkspaceNodeStateIdChanges,
	createWorkspaceNodeIdRebaser,
	rebaseWorkspaceNodeState,
	removeWorkspaceNodeState,
	type WorkspaceMutableNodeKind,
	type WorkspaceNodeIdRebaser,
} from './workspaceNodeStateMigration';
export {
	WORKSPACE_FILE_PREVIEW_MAX_BYTES,
	WorkspaceNodeOperationError,
	defaultWorkspaceNodeOperationHost,
	deleteWorkspaceNode,
	readWorkspaceNodeDetails,
	renameWorkspaceNode,
	type WorkspaceNodeMutation,
	type WorkspaceNodeOperationHost,
} from './workspaceNodeOperations';
export {
	createWorkspaceNodeRequestController,
	type WorkspaceNodeRequestController,
	type WorkspaceNodeRequestControllerDependencies,
} from './workspaceNodeRequestController';
export {
	createWorkspaceGitProjection,
	normalizeWorkspaceGitStatus,
	VSCODE_GIT_STATUS,
	type WorkspaceGitChange,
	type WorkspaceGitFileState,
	type WorkspaceGitProjection,
	type WorkspaceGitRepositorySnapshot,
	type WorkspaceGitRepositoryState,
} from './workspaceGitStatus';
export {
	createWorkspaceGitStatusService,
	getBuiltInGitExtension,
	type WorkspaceGitStatusService,
	type WorkspaceGitStatusServiceDependencies,
} from './workspaceGitService';
