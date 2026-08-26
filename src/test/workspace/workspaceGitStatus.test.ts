import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
	createWorkspaceGitProjection,
	normalizeWorkspaceGitStatus,
	VSCODE_GIT_STATUS,
	type WorkspaceGitRepositorySnapshot,
} from '../../workspace/workspaceGitStatus';
import { WORKSPACE_FILTER_VERSION } from '../../workspace/workspaceFilter';

suite('workspaceGitStatus', () => {
	test('built-in Git status를 Graph 상태로 빠짐없이 정규화한다', () => {
		assert.equal(
			normalizeWorkspaceGitStatus(VSCODE_GIT_STATUS.UNTRACKED),
			'untracked',
		);
		assert.equal(
			normalizeWorkspaceGitStatus(VSCODE_GIT_STATUS.INDEX_ADDED),
			'added',
		);
		assert.equal(
			normalizeWorkspaceGitStatus(VSCODE_GIT_STATUS.MODIFIED),
			'modified',
		);
		assert.equal(
			normalizeWorkspaceGitStatus(VSCODE_GIT_STATUS.INDEX_RENAMED),
			'renamed',
		);
		assert.equal(
			normalizeWorkspaceGitStatus(VSCODE_GIT_STATUS.DELETED),
			'deleted',
		);
		assert.equal(
			normalizeWorkspaceGitStatus(VSCODE_GIT_STATUS.BOTH_MODIFIED),
			'conflict',
		);
		assert.equal(
			normalizeWorkspaceGitStatus(VSCODE_GIT_STATUS.IGNORED),
			undefined,
		);
	});

	test('file direct 상태와 folder/project ancestor 집계를 분리한다', () => {
		const rootUri = vscode.Uri.file('/workspace');
		const projection = createWorkspaceGitProjection([
			createRepository(rootUri, {
				workingTreeChanges: [
					change('/workspace/src/current.ts', VSCODE_GIT_STATUS.MODIFIED),
					change('/workspace/src/deleted.ts', VSCODE_GIT_STATUS.DELETED),
				],
				untrackedChanges: [
					change('/workspace/new.ts', VSCODE_GIT_STATUS.UNTRACKED),
				],
			}),
		], [workspaceFolder(rootUri)]);
		const modified = projection.entries.find(
			({ nodeId }) => nodeId === 'file:file:///workspace/src/current.ts',
		);
		const deleted = projection.entries.find(({ status }) => status === 'deleted');

		assert.deepEqual(modified, {
			status: 'modified',
			nodeId: 'file:file:///workspace/src/current.ts',
			ancestorNodeIds: [
				'folder:file:///workspace/src',
				'workspace-root:file:///workspace',
			],
		});
		assert.deepEqual(deleted, {
			status: 'deleted',
			ancestorNodeIds: [
				'folder:file:///workspace/src',
				'workspace-root:file:///workspace',
			],
		});
		assert.equal(projection.fileStates.has('file:file:///workspace/src/deleted.ts'), false);
		assert.equal(projection.fileStates.size, 2);
	});

	test('rename은 새 file node와 이전/새 ancestor 양쪽을 연결한다', () => {
		const rootUri = vscode.Uri.file('/workspace');
		const originalUri = vscode.Uri.file('/workspace/old/name.ts');
		const renameUri = vscode.Uri.file('/workspace/new/name.ts');
		const projection = createWorkspaceGitProjection([
			createRepository(rootUri, {
				indexChanges: [{
					uri: renameUri,
					originalUri,
					renameUri,
					status: VSCODE_GIT_STATUS.INDEX_RENAMED,
				}],
			}),
		], [workspaceFolder(rootUri)]);

		assert.deepEqual(projection.entries, [{
			status: 'renamed',
			nodeId: 'file:file:///workspace/new/name.ts',
			ancestorNodeIds: [
				'folder:file:///workspace/new',
				'workspace-root:file:///workspace',
				'folder:file:///workspace/old',
			],
		}]);
		assert.equal(
			projection.fileStates.get('file:file:///workspace/new/name.ts')
				?.originalUri?.toString(),
			'file:///workspace/old/name.ts',
		);
	});

	test('Workspace filter와 .crispy subtree는 Git snapshot에서도 제외한다', () => {
		const rootUri = vscode.Uri.file('/workspace');
		const projection = createWorkspaceGitProjection([
			createRepository(rootUri, {
				workingTreeChanges: [
					change('/workspace/dist/output.js', VSCODE_GIT_STATUS.MODIFIED),
					change('/workspace/visible.tmp', VSCODE_GIT_STATUS.MODIFIED),
					change('/workspace/.crispy/filter.json', VSCODE_GIT_STATUS.MODIFIED),
					change('/workspace/visible.ts', VSCODE_GIT_STATUS.MODIFIED),
				],
			}),
		], [workspaceFolder(rootUri)], [{
			rootUri,
			filter: {
				version: WORKSPACE_FILTER_VERSION,
				rules: [
					{ kind: 'folder', pattern: 'dist' },
					{ kind: 'file', pattern: '*.tmp' },
				],
			},
		}]);

		assert.deepEqual(projection.entries.map(({ nodeId }) => nodeId), [
			'file:file:///workspace/visible.ts',
		]);
	});

	test('같은 path의 복수 Git change는 충돌 우선순위로 하나만 남긴다', () => {
		const rootUri = vscode.Uri.file('/workspace');
		const projection = createWorkspaceGitProjection([
			createRepository(rootUri, {
				indexChanges: [
					change('/workspace/file.ts', VSCODE_GIT_STATUS.INDEX_ADDED),
				],
				workingTreeChanges: [
					change('/workspace/file.ts', VSCODE_GIT_STATUS.MODIFIED),
				],
				mergeChanges: [
					change('/workspace/file.ts', VSCODE_GIT_STATUS.BOTH_MODIFIED),
				],
			}),
		], [workspaceFolder(rootUri)]);

		assert.equal(projection.entries.length, 1);
		assert.equal(projection.entries[0]?.status, 'conflict');
	});
});

function workspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder {
	return { uri, name: 'workspace', index: 0 };
}

function change(filePath: string, status: number) {
	return { uri: vscode.Uri.file(filePath), status };
}

function createRepository(
	rootUri: vscode.Uri,
	state: Partial<WorkspaceGitRepositorySnapshot['state']>,
): WorkspaceGitRepositorySnapshot {
	return {
		rootUri,
		state: {
			indexChanges: state.indexChanges ?? [],
			workingTreeChanges: state.workingTreeChanges ?? [],
			untrackedChanges: state.untrackedChanges ?? [],
			mergeChanges: state.mergeChanges ?? [],
		},
	};
}
