import * as assert from 'assert';
import * as vscode from 'vscode';
import { createDefaultTaskBlueprint } from '../../task';
import {
	createDetachedRootId,
	createFileBacklinkGroupId,
	createFolderBacklinkId,
} from '../../webview/graph/graphRootPromotion';
import { createGraphLayoutNodeId } from '../../webview/graph/graphLayout';
import {
	createDefaultWorkspacePersistentState,
	WORKSPACE_PERSISTENT_STATE_VERSION,
	type WorkspacePersistentState,
} from '../../workspace/workspaceMetadata';
import {
	createWorkspaceNodeStateIdChanges,
	createWorkspaceNodeIdRebaser,
	rebaseWorkspaceNodeState,
	removeWorkspaceNodeState,
} from '../../workspace/workspaceNodeStateMigration';

suite('Workspace Node State Migration', () => {
	test('folder rename은 subtree의 canonical/occurrence/detached 상태와 Task provenance를 옮긴다', () => {
		const oldUri = vscode.Uri.file('/workspace/src');
		const newUri = vscode.Uri.file('/workspace/source');
		const childUri = vscode.Uri.file('/workspace/src/lib/index.ts');
		const nextChildUri = vscode.Uri.file('/workspace/source/lib/index.ts');
		const folderId = `folder:${oldUri.toString()}`;
		const nextFolderId = `folder:${newUri.toString()}`;
		const childId = `file:${childUri.toString()}`;
		const nextChildId = `file:${nextChildUri.toString()}`;
		const detachedRootId = createDetachedRootId(folderId, 1);
		const occurrenceId = createGraphLayoutNodeId(detachedRootId, childId);
		const folderBacklinkId = createFolderBacklinkId(folderId);
		const childBacklinkId = createFileBacklinkGroupId(childId);
		const backlinkOccurrenceId = createGraphLayoutNodeId(
			detachedRootId,
			childBacklinkId,
		);
		const task = createDefaultTaskBlueprint({
			title: 'Rename targets',
			defaultGraphTargets: { reference: [childId], work: [folderId] },
		}, createSequentialIdSource());
		const startId = task.nodes.find(({ kind }) => kind === 'start')?.id
			?? assert.fail();
		const state: WorkspacePersistentState = {
			...createDefaultWorkspacePersistentState(),
			version: WORKSPACE_PERSISTENT_STATE_VERSION,
			nodePositions: {
				[folderId]: { x: 1, y: 2 },
				[occurrenceId]: { x: 3, y: 4 },
				[folderBacklinkId]: { x: 5, y: 6 },
				[backlinkOccurrenceId]: { x: 7, y: 8 },
			},
			fileGroupPages: { [`${folderId}:files`]: 2 },
			openedFolders: { [folderId]: true },
			detachedRootNodeIds: { [detachedRootId]: true },
			hiddenNodeIds: { [childId]: true },
			tasks: [{
				ownerRootId: `workspace-root:${vscode.Uri.file('/workspace').toString()}`,
				storageRevision: 4,
				task,
				targetOrigins: [
					{ nodeId: startId, area: 'reference', sourceId: childId, sourceRootId: 'root' },
					{ nodeId: startId, area: 'work', sourceId: folderId, sourceRootId: 'root' },
				],
			}],
		};
		const rebaser = createWorkspaceNodeIdRebaser(oldUri, newUri, 'folder');
		const stateIdChanges = createWorkspaceNodeStateIdChanges(state, rebaser);
		const result = rebaseWorkspaceNodeState(state, rebaser);
		const nextDetachedRootId = createDetachedRootId(nextFolderId, 1);
		const nextFolderBacklinkId = createFolderBacklinkId(nextFolderId);
		const nextChildBacklinkId = createFileBacklinkGroupId(nextChildId);

		assert.deepStrictEqual(result.nodePositions[nextFolderId], { x: 1, y: 2 });
		assert.deepStrictEqual(
			result.nodePositions[createGraphLayoutNodeId(nextDetachedRootId, nextChildId)],
			{ x: 3, y: 4 },
		);
		assert.deepStrictEqual(
			result.nodePositions[nextFolderBacklinkId],
			{ x: 5, y: 6 },
		);
		assert.deepStrictEqual(
			result.nodePositions[createGraphLayoutNodeId(
				nextDetachedRootId,
				nextChildBacklinkId,
			)],
			{ x: 7, y: 8 },
		);
		assert.strictEqual(result.fileGroupPages[`${nextFolderId}:files`], 2);
		assert.strictEqual(result.openedFolders[nextFolderId], true);
		assert.strictEqual(result.detachedRootNodeIds[nextDetachedRootId], true);
		assert.strictEqual(result.hiddenNodeIds[nextChildId], true);
		assert.deepStrictEqual(result.tasks[0]?.task.defaultGraphTargets, {
			reference: [nextChildId],
			work: [nextFolderId],
		});
		assert.deepStrictEqual(
			result.tasks[0]?.targetOrigins.map(({ sourceId }) => sourceId),
			[nextChildId, nextFolderId],
		);
		assert.strictEqual(result.tasks[0]?.storageRevision, 5);
		assert.strictEqual(stateIdChanges[folderId], nextFolderId);
		assert.strictEqual(stateIdChanges[occurrenceId], createGraphLayoutNodeId(
			nextDetachedRootId,
			nextChildId,
		));
		assert.strictEqual(
			stateIdChanges[backlinkOccurrenceId],
			createGraphLayoutNodeId(nextDetachedRootId, nextChildBacklinkId),
		);
	});

	test('rename target의 이전 상태는 동일한 새 ID에 남은 stale 상태보다 우선한다', () => {
		const oldUri = vscode.Uri.file('/workspace/old.ts');
		const newUri = vscode.Uri.file('/workspace/new.ts');
		const oldId = `file:${oldUri.toString()}`;
		const newId = `file:${newUri.toString()}`;
		const state: WorkspacePersistentState = {
			...createDefaultWorkspacePersistentState(),
			nodePositions: {
				[oldId]: { x: 100, y: 200 },
				[newId]: { x: -1, y: -1 },
			},
		};
		const result = rebaseWorkspaceNodeState(
			state,
			createWorkspaceNodeIdRebaser(oldUri, newUri, 'file'),
		);

		assert.deepStrictEqual(result.nodePositions, {
			[newId]: { x: 100, y: 200 },
		});
	});

	test('folder delete는 subtree 상태와 Task target/provenance만 제거한다', () => {
		const folderUri = vscode.Uri.file('/workspace/src');
		const childId = `file:${vscode.Uri.file('/workspace/src/index.ts').toString()}`;
		const siblingId = `file:${vscode.Uri.file('/workspace/test.ts').toString()}`;
		const task = createDefaultTaskBlueprint({
			title: 'Delete targets',
			defaultGraphTargets: {
				reference: [childId, siblingId],
				work: [],
			},
		}, createSequentialIdSource());
		const startId = task.nodes.find(({ kind }) => kind === 'start')?.id
			?? assert.fail();
		const state: WorkspacePersistentState = {
			...createDefaultWorkspacePersistentState(),
			nodePositions: {
				[childId]: { x: 1, y: 1 },
				[siblingId]: { x: 2, y: 2 },
			},
			tasks: [{
				ownerRootId: 'workspace-root:file:///workspace',
				storageRevision: 8,
				task,
				targetOrigins: [
					{ nodeId: startId, area: 'reference', sourceId: childId, sourceRootId: 'root' },
					{ nodeId: startId, area: 'reference', sourceId: siblingId, sourceRootId: 'root' },
				],
			}],
		};
		const result = removeWorkspaceNodeState(state, folderUri, 'folder');

		assert.strictEqual(result.nodePositions[childId], undefined);
		assert.deepStrictEqual(result.nodePositions[siblingId], { x: 2, y: 2 });
		assert.deepStrictEqual(result.tasks[0]?.task.defaultGraphTargets.reference, [
			siblingId,
		]);
		assert.deepStrictEqual(result.tasks[0]?.targetOrigins.map(({ sourceId }) => sourceId), [
			siblingId,
		]);
		assert.strictEqual(result.tasks[0]?.storageRevision, 9);
	});
});

function createSequentialIdSource(): () => string {
	let next = 0;

	return () => String(next += 1);
}
