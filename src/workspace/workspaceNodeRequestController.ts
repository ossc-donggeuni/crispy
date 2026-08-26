import {
	getWorkspaceGraphRootIds,
	parseWorkspaceRootIds,
	type ExtensionToWebviewMessage,
	type WorkspaceNodeRequestMessage,
} from '../messages';
import type { WorkspacePersistentState } from './workspaceMetadata';
import {
	deleteWorkspaceNode,
	readWorkspaceNodeDetails,
	renameWorkspaceNode,
	WORKSPACE_FILE_PREVIEW_MAX_BYTES,
	WorkspaceNodeOperationError,
	type WorkspaceNodeOperationHost,
} from './workspaceNodeOperations';
import {
	createWorkspaceNodeStateIdChanges,
	createWorkspaceNodeIdRebaser,
	rebaseWorkspaceNodeState,
	removeWorkspaceNodeState,
} from './workspaceNodeStateMigration';
import type { WorkspacePresentation } from './workspacePresentation';

export interface WorkspaceNodeRequestController {
	handle(request: WorkspaceNodeRequestMessage): void;
}

export interface WorkspaceNodeRequestControllerDependencies {
	readonly operationHost: WorkspaceNodeOperationHost;
	getWorkspaceRevision(): number;
	advanceWorkspaceRevision(): number;
	getWorkspaceContextGeneration(): number;
	getWorkspaceState(): WorkspacePersistentState;
	commitWorkspaceState(state: WorkspacePersistentState): Promise<void>;
	createWorkspacePresentation(): Promise<WorkspacePresentation>;
	postMessage(message: ExtensionToWebviewMessage): PromiseLike<boolean>;
	/** Git runtime이 연결된 경우 상세 file의 HEAD 원본을 선택적으로 제공한다. */
	getGitRevision?(): number;
	readGitOriginalText?(nodeId: string, maxBytes: number): Promise<string | undefined>;
	requestGitRefresh?(): void;
}

/** 상세 조회와 직렬화 mutation을 Host 단일 revision 경계로 조정한다. */
export function createWorkspaceNodeRequestController(
	dependencies: WorkspaceNodeRequestControllerDependencies,
): WorkspaceNodeRequestController {
	let mutationQueue = Promise.resolve();

	const post = (message: ExtensionToWebviewMessage): void => {
		void Promise.resolve(dependencies.postMessage(message)).catch(() => undefined);
	};
	const handleDetails = async (
		request: Extract<WorkspaceNodeRequestMessage, {
			readonly type: 'workspace.nodeDetails.request';
		}>,
	): Promise<void> => {
		if (request.workspaceRevision !== dependencies.getWorkspaceRevision()) {
			postDetailsFailure(request.requestId, 'stale');
			return;
		}
		try {
			const gitRevision = dependencies.getGitRevision?.();
			let details = await readWorkspaceNodeDetails(
				request,
				dependencies.operationHost,
			);
			if (
				details.kind === 'file'
				&& details.preview?.status === 'ready'
				&& dependencies.readGitOriginalText
			) {
				const originalText = await dependencies.readGitOriginalText(
					request.nodeId,
					WORKSPACE_FILE_PREVIEW_MAX_BYTES,
				);

				if (originalText !== undefined) {
					details = {
						...details,
						preview: { ...details.preview, originalText },
					};
				}
			}
			if (request.workspaceRevision !== dependencies.getWorkspaceRevision()) {
				postDetailsFailure(request.requestId, 'stale');
				return;
			}
			if (
				gitRevision !== undefined
				&& gitRevision !== dependencies.getGitRevision?.()
			) {
				postDetailsFailure(request.requestId, 'stale');
				return;
			}
			post({
				type: 'workspace.nodeDetails.result',
				requestId: request.requestId,
				workspaceRevision: dependencies.getWorkspaceRevision(),
				status: 'success',
				details,
			});
		} catch (error) {
			postDetailsFailure(request.requestId, getFailureReason(error));
		}
	};
	const postDetailsFailure = (
		requestId: number,
		reason: WorkspaceNodeOperationError['reason'],
	): void => post({
		type: 'workspace.nodeDetails.result',
		requestId,
		workspaceRevision: dependencies.getWorkspaceRevision(),
		status: 'error',
		reason,
	});
	const handleMutation = async (
		request: Exclude<WorkspaceNodeRequestMessage, {
			readonly type: 'workspace.nodeDetails.request';
		}>,
	): Promise<void> => {
		const operation = request.type === 'workspace.nodeRename.request'
			? 'rename'
			: 'delete';

		if (request.workspaceRevision !== dependencies.getWorkspaceRevision()) {
			postMutationFailure(request.requestId, operation, 'stale');
			return;
		}
		// Webview의 rename 요청 snapshot은 사용자가 버튼을 누른 정확한 시점의
		// Graph 상태다. 파일시스템 watcher나 Host 저장 지연이 끼어들기 전에 이를
		// transaction 기준점으로 고정해야 하위 좌표를 잃지 않는다.
		const hostState = dependencies.getWorkspaceState();
		const mutationBaseState = request.type === 'workspace.nodeRename.request'
			? {
				...request.state,
				// 이 두 필드는 Host persistence transaction이 소유하므로 Webview의
				// 의도적으로 비어 있는 projection으로 덮어쓰지 않는다.
				taskRelocations: hostState.taskRelocations,
				taskStorageReceipts: hostState.taskStorageReceipts,
			}
			: hostState;

		try {
			const mutation = request.type === 'workspace.nodeRename.request'
				? await renameWorkspaceNode(request, dependencies.operationHost)
				: await deleteWorkspaceNode(request, dependencies.operationHost);
			const rebaser = mutation.newUri
				? createWorkspaceNodeIdRebaser(
					mutation.oldUri,
					mutation.newUri,
					mutation.kind,
				)
				: undefined;
			const stateIdChanges = rebaser
				? createWorkspaceNodeStateIdChanges(mutationBaseState, rebaser)
				: undefined;
			const state = rebaser
				? rebaseWorkspaceNodeState(mutationBaseState, rebaser)
				: removeWorkspaceNodeState(
					mutationBaseState,
					mutation.oldUri,
					mutation.kind,
				);

			dependencies.advanceWorkspaceRevision();
			await dependencies.commitWorkspaceState(state);
			const presentation = await dependencies.createWorkspacePresentation();
			const rootIds = parseWorkspaceRootIds(
				getWorkspaceGraphRootIds(presentation.graph),
			);

			if (!rootIds || rootIds.length !== presentation.rootCatalog.length) {
				throw new Error('Invalid Workspace root context after mutation.');
			}
			post({
				type: 'workspace.nodeMutation.result',
				requestId: request.requestId,
				operation,
				workspaceRevision: dependencies.getWorkspaceRevision(),
				status: 'success',
				contextGeneration: dependencies.getWorkspaceContextGeneration(),
				rootIds,
				presentation,
				state,
				...(mutation.nodeId ? { nodeId: mutation.nodeId } : {}),
				...(stateIdChanges ? { stateIdChanges } : {}),
			});
			try {
				dependencies.requestGitRefresh?.();
			} catch {
				/** 완료된 filesystem mutation은 후속 Git refresh 실패로 되돌리지 않는다. */
			}
		} catch (error) {
			postMutationFailure(request.requestId, operation, getFailureReason(error));
		}
	};
	const postMutationFailure = (
		requestId: number,
		operation: 'rename' | 'delete',
		reason: WorkspaceNodeOperationError['reason'],
	): void => post({
		type: 'workspace.nodeMutation.result',
		requestId,
		operation,
		workspaceRevision: dependencies.getWorkspaceRevision(),
		status: 'error',
		reason,
	});

	return {
		handle(request): void {
			if (request.type === 'workspace.nodeDetails.request') {
				void handleDetails(request);
				return;
			}
			mutationQueue = mutationQueue.then(
				() => handleMutation(request),
				() => handleMutation(request),
			);
		},
	};
}

function getFailureReason(error: unknown): WorkspaceNodeOperationError['reason'] {
	return error instanceof WorkspaceNodeOperationError ? error.reason : 'failed';
}
