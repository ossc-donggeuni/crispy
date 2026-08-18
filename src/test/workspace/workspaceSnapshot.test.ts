import * as assert from 'assert';
import * as vscode from 'vscode';
import { collectWorkspaceSnapshot } from '../../workspace/workspaceSnapshot';

suite('Workspace Snapshot', () => {
	test('Workspace가 없으면 빈 Root 목록을 반환한다', () => {
		const snapshot = collectWorkspaceSnapshot({ workspaceFolders: undefined });

		assert.deepStrictEqual(snapshot.roots, []);
	});

	test('Workspace Root가 1개면 해당 Root를 수집한다', () => {
		const rootUri = vscode.Uri.file('/workspace/single');
		const snapshot = collectWorkspaceSnapshot({
			workspaceFolders: [createWorkspaceFolder('single', rootUri, 0)],
		});

		assert.strictEqual(snapshot.roots.length, 1);
		assert.deepStrictEqual(snapshot.roots[0], {
			id: `workspace-root:${rootUri.toString()}`,
			name: 'single',
			uri: rootUri,
			children: [],
		});
	});

	test('Workspace Root가 여러 개면 전체 개수를 유지한다', () => {
		const workspaceFolders = [
			createWorkspaceFolder('app', vscode.Uri.file('/workspace/app'), 0),
			createWorkspaceFolder('api', vscode.Uri.file('/workspace/api'), 1),
			createWorkspaceFolder('shared', vscode.Uri.file('/workspace/shared'), 2),
		];
		const snapshot = collectWorkspaceSnapshot({ workspaceFolders });

		assert.strictEqual(snapshot.roots.length, workspaceFolders.length);
	});

	test('Multi-root의 모든 Root를 순서와 누락 없이 수집한다', () => {
		const workspaceFolders = [
			createWorkspaceFolder('app', vscode.Uri.file('/workspace/app'), 0),
			createWorkspaceFolder('api', vscode.Uri.file('/workspace/api'), 1),
			createWorkspaceFolder('shared', vscode.Uri.file('/workspace/shared'), 2),
		];
		const snapshot = collectWorkspaceSnapshot({ workspaceFolders });

		assert.deepStrictEqual(
			snapshot.roots.map(({ id }) => id),
			workspaceFolders.map(({ uri }) => `workspace-root:${uri.toString()}`),
		);
	});

	test('각 Root의 이름과 URI를 그대로 유지한다', () => {
		const appUri = vscode.Uri.parse('file:///workspace/app');
		const remoteUri = vscode.Uri.parse('vscode-remote://ssh-remote+dev/workspace/api');
		const workspaceFolders = [
			createWorkspaceFolder('Application', appUri, 0),
			createWorkspaceFolder('Remote API', remoteUri, 1),
		];
		const snapshot = collectWorkspaceSnapshot({ workspaceFolders });

		assert.deepStrictEqual(
			snapshot.roots.map(({ name }) => name),
			['Application', 'Remote API'],
		);
		assert.strictEqual(snapshot.roots[0]?.uri, appUri);
		assert.strictEqual(snapshot.roots[1]?.uri, remoteUri);
	});
});

function createWorkspaceFolder(
	name: string,
	uri: vscode.Uri,
	index: number,
): vscode.WorkspaceFolder {
	return { name, uri, index };
}
