import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../../messages';
import type { Graph } from '../../webview/graph/graphModel';
import { createDefaultWorkspacePersistentState } from '../../workspace/workspaceMetadata';
import type { WorkspaceNodeOperationHost } from '../../workspace/workspaceNodeOperations';
import { createWorkspaceNodeRequestController } from '../../workspace/workspaceNodeRequestController';
import { createWorkspaceRootId } from '../../workspace/workspaceRootId';

suite('Workspace Node Request Controller', () => {
	test('rename은 상태 이관과 revision을 atomic success payload로 보내고 이전 revision을 거부한다', async () => {
		const rootUri = vscode.Uri.file('/workspace');
		const oldUri = vscode.Uri.file('/workspace/old.ts');
		const newUri = vscode.Uri.file('/workspace/new.ts');
		const oldId = `file:${oldUri.toString()}`;
		const newId = `file:${newUri.toString()}`;
		const rootId = createWorkspaceRootId(rootUri);
		const messages: ExtensionToWebviewMessage[] = [];
		let revision = 0;
		let deleteCalls = 0;
		let committed = {
			...createDefaultWorkspacePersistentState(),
			nodePositions: { [oldId]: { x: 10, y: 20 } },
		};
		const operationHost: WorkspaceNodeOperationHost = {
			isTrusted: true,
			getWorkspaceFolder: (uri) => uri.path.startsWith('/workspace/')
				? { uri: rootUri, name: 'workspace', index: 0 }
				: undefined,
			stat: async () => ({
				type: vscode.FileType.File,
				ctime: 0,
				mtime: 0,
				size: 0,
			}),
			readFile: async () => new Uint8Array(),
			readDirectory: async () => [],
			rename: async (source, target) => {
				assert.strictEqual(source.toString(), oldUri.toString());
				assert.strictEqual(target.toString(), newUri.toString());
			},
			delete: async () => {
				deleteCalls += 1;
			},
		};
		const controller = createWorkspaceNodeRequestController({
			operationHost,
			getWorkspaceRevision: () => revision,
			advanceWorkspaceRevision: () => (revision += 1),
			getWorkspaceContextGeneration: () => 4,
			getWorkspaceState: () => committed,
			commitWorkspaceState: async (state) => {
				committed = state;
			},
			createWorkspacePresentation: async () => createPresentation(
				rootId,
				newId,
			),
			postMessage: async (message) => {
				messages.push(message);
				return true;
			},
		});

		controller.handle({
			type: 'workspace.nodeRename.request',
			requestId: 1,
			nodeId: oldId,
			kind: 'file',
			newName: 'new.ts',
			workspaceRevision: 0,
		});
		await waitFor(() => messages.length === 1);

		assert.strictEqual(revision, 1);
		assert.strictEqual(committed.nodePositions[oldId], undefined);
		assert.deepStrictEqual(committed.nodePositions[newId], { x: 10, y: 20 });
		assert.deepStrictEqual(messages[0], {
			type: 'workspace.nodeMutation.result',
			requestId: 1,
			operation: 'rename',
			workspaceRevision: 1,
			status: 'success',
			contextGeneration: 4,
			rootIds: [rootId],
			presentation: createPresentation(rootId, newId),
			state: committed,
			nodeId: newId,
		});

		controller.handle({
			type: 'workspace.nodeDelete.request',
			requestId: 2,
			nodeId: newId,
			kind: 'file',
			workspaceRevision: 0,
		});
		await waitFor(() => messages.length === 2);
		assert.strictEqual(deleteCalls, 0);
		assert.deepStrictEqual(messages[1], {
			type: 'workspace.nodeMutation.result',
			requestId: 2,
			operation: 'delete',
			workspaceRevision: 1,
			status: 'error',
			reason: 'stale',
		});
	});
});

function createPresentation(rootId: ReturnType<typeof createWorkspaceRootId>, fileId: string) {
	const graph: Graph = {
		roots: [{ id: `root:${rootId}`, nodeId: rootId }],
		rootNodes: {
			[rootId]: {
				id: rootId,
				name: 'workspace',
				kind: 'project',
				status: 'loaded',
				children: [{ id: fileId, name: 'new.ts', kind: 'file' }],
			},
		},
	};

	return {
		graph,
		rootCatalog: [{
			id: rootId,
			name: 'workspace',
			description: 'file:///workspace',
			selectable: true,
		}],
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (predicate()) {
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for controller result');
}
