import * as assert from 'assert';
import * as vscode from 'vscode';
import type {
	WorkspaceDirectoryStatus,
	WorkspaceSnapshot,
} from '../../workspace/workspaceModel';
import { createWorkspaceRootCatalog } from '../../workspace/workspaceRootCatalog';
import { createWorkspaceRootId } from '../../workspace/workspaceRootId';

suite('Workspace Root Catalog', () => {
	test('trusted local root의 ID, 이름과 URI description을 selectable entry로 유지한다', () => {
		const uri = vscode.Uri.file('/workspace/app & api');
		const snapshot = createSnapshot([
			createRoot('app', uri, 'unreadable'),
		]);

		assert.deepStrictEqual(
			createWorkspaceRootCatalog(snapshot, true, 'linux'),
			[{
				id: createWorkspaceRootId(uri),
				name: 'app',
				description: uri.toString(),
				selectable: true,
			}],
		);
	});

	test('untrusted 상태는 virtual scheme과 잘못된 path보다 먼저 적용한다', () => {
		const virtualUri = vscode.Uri.parse('vscode-remote://ssh-remote+dev/workspace/app');
		const relativeFileUri = createUri('file', 'relative/workspace');
		const snapshot = createSnapshot([
			createRoot('remote', virtualUri),
			createRoot('relative', relativeFileUri),
		]);

		assert.deepStrictEqual(
			createWorkspaceRootCatalog(snapshot, false, 'linux').map((entry) => ({
				selectable: entry.selectable,
				reason: entry.reason,
			})),
			[
				{ selectable: false, reason: 'workspace_untrusted' },
				{ selectable: false, reason: 'workspace_untrusted' },
			],
		);
	});

	test('trusted 상태에서 virtual scheme과 path 오류를 공용 policy 순서로 구분한다', () => {
		const snapshot = createSnapshot([
			createRoot(
				'remote',
				vscode.Uri.parse('vscode-remote://ssh-remote+dev/workspace/app'),
			),
			createRoot('relative', createUri('file', 'relative/workspace')),
		]);

		assert.deepStrictEqual(
			createWorkspaceRootCatalog(snapshot, true, 'linux').map((entry) => entry.reason),
			['workspace_virtual_unsupported', 'workspace_path_invalid'],
		);
	});

	test('platform별 absolute path 규칙과 root 순서를 유지한다', () => {
		const windowsUri = createUri('file', 'C:\\workspace\\app');
		const posixUri = vscode.Uri.file('/workspace/api');
		const snapshot = createSnapshot([
			createRoot('windows', windowsUri),
			createRoot('posix', posixUri),
		]);

		const windowsCatalog = createWorkspaceRootCatalog(snapshot, true, 'win32');
		const posixCatalog = createWorkspaceRootCatalog(snapshot, true, 'linux');

		assert.deepStrictEqual(
			windowsCatalog.map(({ id }) => id),
			snapshot.roots.map(({ id }) => id),
		);
		assert.strictEqual(windowsCatalog[0]?.selectable, true);
		assert.strictEqual(posixCatalog[0]?.reason, 'workspace_path_invalid');
	});

	test('매우 긴 URI root가 sibling Catalog entry 생성을 방해하지 않는다', () => {
		const longUri = vscode.Uri.parse(
			`vscode-remote://ssh-remote+dev/${'nested/'.repeat(3_000)}`,
		);
		const siblingUri = vscode.Uri.file('/workspace/sibling');
		const snapshot = createSnapshot([
			createRoot('long', longUri),
			createRoot('sibling', siblingUri),
		]);
		const catalog = createWorkspaceRootCatalog(snapshot, true, 'linux');

		assert.ok(catalog[0] && catalog[0].id.length > 16_384);
		assert.strictEqual(catalog[0]?.reason, 'workspace_virtual_unsupported');
		assert.deepStrictEqual(catalog[1], {
			id: createWorkspaceRootId(siblingUri),
			name: 'sibling',
			description: siblingUri.toString(),
			selectable: true,
		});
	});
});

function createSnapshot(
	roots: WorkspaceSnapshot['roots'],
): WorkspaceSnapshot {
	return { roots };
}

function createRoot(
	name: string,
	uri: vscode.Uri,
	status: WorkspaceDirectoryStatus = 'loaded',
): WorkspaceSnapshot['roots'][number] {
	return {
		id: createWorkspaceRootId(uri),
		name,
		uri,
		status,
		children: [],
	};
}

function createUri(scheme: string, fsPath: string): vscode.Uri {
	return {
		scheme,
		fsPath,
		toString: () => `${scheme}:${fsPath}`,
	} as vscode.Uri;
}
