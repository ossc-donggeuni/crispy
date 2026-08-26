import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ExtensionToWebviewMessage } from '../../messages';
import type { Graph } from '../../webview/graph/graphModel';
import {
	createDefaultWorkspacePersistentState,
	type WorkspacePersistentState,
} from '../../workspace/workspaceMetadata';
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
			state: committed,
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
			stateIdChanges: { [oldId]: newId },
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

	test('Host 저장 상태가 늦어도 rename 요청 snapshot의 하위 nodePosition을 이관한다', async () => {
		const rootUri = vscode.Uri.file('/workspace');
		const oldFolderUri = vscode.Uri.file('/workspace/old');
		const newFolderUri = vscode.Uri.file('/workspace/new');
		const childFolderUri = vscode.Uri.file('/workspace/old/nested');
		const standaloneFileUri = vscode.Uri.file('/workspace/old/readme.md');
		const oldFolderId = `folder:${oldFolderUri.toString()}`;
		const newFolderId = `folder:${newFolderUri.toString()}`;
		const childFolderId = `folder:${childFolderUri.toString()}`;
		const childFileGroupId = `${childFolderId}:files`;
		const standaloneFileId = `file:${standaloneFileUri.toString()}`;
		const initialPositions = {
			[oldFolderId]: { x: 100, y: 200 },
			[childFolderId]: { x: 320, y: 420 },
			[childFileGroupId]: { x: 540, y: 640 },
			[standaloneFileId]: { x: 760, y: 860 },
		};
		const requestState = {
			...createDefaultWorkspacePersistentState(),
			nodePositions: initialPositions,
		};
		const hostReceipt = {
			ownerRootId: createWorkspaceRootId(rootUri),
			taskId: 'task:host-owned-receipt',
			storageRevision: 5,
		};
		let desiredState: WorkspacePersistentState = {
			...createDefaultWorkspacePersistentState(),
			taskStorageReceipts: [hostReceipt],
		};
		let revision = 0;
		let committed = desiredState;
		const messages: ExtensionToWebviewMessage[] = [];
		const controller = createWorkspaceNodeRequestController({
			operationHost: {
				isTrusted: true,
				getWorkspaceFolder: (uri) => uri.path.startsWith('/workspace/')
					? { uri: rootUri, name: 'workspace', index: 0 }
					: undefined,
				stat: async () => ({
					type: vscode.FileType.Directory,
					ctime: 0,
					mtime: 0,
					size: 0,
				}),
				readFile: async () => new Uint8Array(),
				readDirectory: async () => [],
				rename: async () => undefined,
				delete: async () => undefined,
			},
			getWorkspaceRevision: () => revision,
			advanceWorkspaceRevision: () => (revision += 1),
			getWorkspaceContextGeneration: () => 2,
			getWorkspaceState: () => desiredState,
			commitWorkspaceState: async (state) => {
				committed = state;
				desiredState = state;
			},
			createWorkspacePresentation: async () => createPresentation(
				createWorkspaceRootId(rootUri),
				`file:${vscode.Uri.file('/workspace/placeholder.ts').toString()}`,
			),
			postMessage: async (message) => {
				messages.push(message);
				return true;
			},
		});

		controller.handle({
			type: 'workspace.nodeRename.request',
			requestId: 7,
			nodeId: oldFolderId,
			kind: 'folder',
			newName: 'new',
			workspaceRevision: 0,
			state: requestState,
		});
		await waitFor(() => messages.length === 1);

		const nextChildFolderId = `folder:${vscode.Uri.file('/workspace/new/nested').toString()}`;
		const nextChildFileGroupId = `${nextChildFolderId}:files`;
		const nextStandaloneFileId = `file:${vscode.Uri.file('/workspace/new/readme.md').toString()}`;

		assert.deepStrictEqual(committed.nodePositions, {
			[newFolderId]: initialPositions[oldFolderId],
			[nextChildFolderId]: initialPositions[childFolderId],
			[nextChildFileGroupId]: initialPositions[childFileGroupId],
			[nextStandaloneFileId]: initialPositions[standaloneFileId],
		});
		assert.deepStrictEqual(committed.taskStorageReceipts, [hostReceipt]);
		const result = messages[0];

		assert.strictEqual(result?.type, 'workspace.nodeMutation.result');
		assert.strictEqual(result?.status, 'success');
		if (result?.type !== 'workspace.nodeMutation.result' || result.status !== 'success') {
			assert.fail('rename success 결과가 필요하다.');
		}
		assert.deepStrictEqual(result.stateIdChanges, {
			[oldFolderId]: newFolderId,
			[childFolderId]: nextChildFolderId,
			[childFileGroupId]: nextChildFileGroupId,
			[standaloneFileId]: nextStandaloneFileId,
		});
	});

	test('file 상세에 같은 Git revision의 HEAD 원본만 atomic하게 결합한다', async () => {
		const rootUri = vscode.Uri.file('/workspace');
		const fileUri = vscode.Uri.file('/workspace/index.ts');
		const fileId = `file:${fileUri.toString()}`;
		const messages: ExtensionToWebviewMessage[] = [];
		let gitRevision = 5;
		let makeGitReadStale = false;
		const currentText = 'const value = 2;\n';
		const controller = createWorkspaceNodeRequestController({
			operationHost: {
				isTrusted: true,
				getWorkspaceFolder: () => ({ uri: rootUri, name: 'workspace', index: 0 }),
				stat: async () => ({
					type: vscode.FileType.File,
					ctime: 0,
					mtime: 0,
					size: new TextEncoder().encode(currentText).byteLength,
				}),
				readFile: async () => new TextEncoder().encode(currentText),
				readDirectory: async () => [],
				rename: async () => undefined,
				delete: async () => undefined,
			},
			getWorkspaceRevision: () => 0,
			advanceWorkspaceRevision: () => 0,
			getWorkspaceContextGeneration: () => 0,
			getWorkspaceState: createDefaultWorkspacePersistentState,
			commitWorkspaceState: async () => undefined,
			createWorkspacePresentation: async () => createPresentation(
				createWorkspaceRootId(rootUri),
				fileId,
			),
			getGitRevision: () => gitRevision,
			readGitOriginalText: async (nodeId, maxBytes) => {
				assert.strictEqual(nodeId, fileId);
				assert.strictEqual(maxBytes, 1_048_576);
				if (makeGitReadStale) {
					gitRevision += 1;
				}
				return 'const value = 1;\n';
			},
			postMessage: async (message) => {
				messages.push(message);
				return true;
			},
		});

		controller.handle({
			type: 'workspace.nodeDetails.request',
			requestId: 20,
			nodeId: fileId,
			kind: 'file',
			workspaceRevision: 0,
		});
		await waitFor(() => messages.length === 1);
		const success = messages[0];

		assert.strictEqual(success?.type, 'workspace.nodeDetails.result');
		assert.strictEqual(success?.status, 'success');
		if (success?.type !== 'workspace.nodeDetails.result' || success.status !== 'success') {
			assert.fail('file details success 결과가 필요하다.');
		}
		assert.deepStrictEqual(success.details.preview, {
			status: 'ready',
			text: currentText,
			languageId: 'typescript',
			originalText: 'const value = 1;\n',
		});

		makeGitReadStale = true;
		controller.handle({
			type: 'workspace.nodeDetails.request',
			requestId: 21,
			nodeId: fileId,
			kind: 'file',
			workspaceRevision: 0,
		});
		await waitFor(() => messages.length === 2);
		assert.deepStrictEqual(messages[1], {
			type: 'workspace.nodeDetails.result',
			requestId: 21,
			workspaceRevision: 0,
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
