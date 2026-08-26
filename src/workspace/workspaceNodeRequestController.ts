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
	WorkspaceNodeOperationError,
	type WorkspaceNodeOperationHost,
} from './workspaceNodeOperations';
import {
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
			const details = await readWorkspaceNodeDetails(
				request,
				dependencies.operationHost,
			);
			if (request.workspaceRevision !== dependencies.getWorkspaceRevision()) {
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
		try {
			const mutation = request.type === 'workspace.nodeRename.request'
				? await renameWorkspaceNode(request, dependencies.operationHost)
				: await deleteWorkspaceNode(request, dependencies.operationHost);
			const currentState = dependencies.getWorkspaceState();
			const state = mutation.newUri
				? rebaseWorkspaceNodeState(
					currentState,
					createWorkspaceNodeIdRebaser(
						mutation.oldUri,
						mutation.newUri,
						mutation.kind,
					),
				)
				: removeWorkspaceNodeState(
					currentState,
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
			});
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
