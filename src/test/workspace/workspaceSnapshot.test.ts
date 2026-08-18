import * as assert from 'assert';
import * as vscode from 'vscode';
import { createWorkspaceSnapshot } from '../../workspace/workspaceSnapshot';

type FakeDirectoryEntry = readonly [string, vscode.FileType];

suite('Workspace Snapshot', () => {
	test('Workspace가 없으면 FileSystem을 읽지 않고 빈 Root 목록을 반환한다', async () => {
		const fake = createFakeFileSystem({});
		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: undefined },
			fake.fileSystem,
		);

		assert.deepStrictEqual(snapshot.roots, []);
		assert.deepStrictEqual(fake.readDirectoryCalls, []);
	});

	test('Root 바로 아래 File을 Tree에 저장한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const fileUri = vscode.Uri.joinPath(rootUri, 'README.md');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [['README.md', vscode.FileType.File]],
		});
		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('app', rootUri, 0)] },
			fake.fileSystem,
		);
		const root = snapshot.roots[0];

		assert.ok(root);
		assert.strictEqual(root.id, `workspace-root:${rootUri.toString()}`);
		assert.strictEqual(root.name, 'app');
		assert.strictEqual(root.uri, rootUri);
		assert.strictEqual(root.status, 'loaded');
		assert.deepStrictEqual(root.children, [{
			kind: 'file',
			id: `file:${fileUri.toString()}`,
			name: 'README.md',
			uri: fileUri,
		}]);
	});

	test('Root 바로 아래 Folder를 재귀 탐색해 Tree에 저장한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const srcUri = vscode.Uri.joinPath(rootUri, 'src');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [['src', vscode.FileType.Directory]],
			[srcUri.toString()]: [],
		});
		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('app', rootUri, 0)] },
			fake.fileSystem,
		);

		assert.deepStrictEqual(snapshot.roots[0]?.children, [{
			kind: 'folder',
			id: `folder:${srcUri.toString()}`,
			name: 'src',
			uri: srcUri,
			status: 'loaded',
			children: [],
		}]);
	});

	test('Folder 내부 File을 children에 저장한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const srcUri = vscode.Uri.joinPath(rootUri, 'src');
		const indexUri = vscode.Uri.joinPath(srcUri, 'index.ts');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [['src', vscode.FileType.Directory]],
			[srcUri.toString()]: [['index.ts', vscode.FileType.File]],
		});
		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('app', rootUri, 0)] },
			fake.fileSystem,
		);
		const src = snapshot.roots[0]?.children[0];

		assert.ok(src && src.kind === 'folder');
		assert.deepStrictEqual(src.children, [{
			kind: 'file',
			id: `file:${indexUri.toString()}`,
			name: 'index.ts',
			uri: indexUri,
		}]);
	});

	test('여러 단계로 중첩된 Folder를 끝까지 탐색한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const srcUri = vscode.Uri.joinPath(rootUri, 'src');
		const featuresUri = vscode.Uri.joinPath(srcUri, 'features');
		const workspaceUri = vscode.Uri.joinPath(featuresUri, 'workspace');
		const snapshotFileUri = vscode.Uri.joinPath(workspaceUri, 'snapshot.ts');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [['src', vscode.FileType.Directory]],
			[srcUri.toString()]: [['features', vscode.FileType.Directory]],
			[featuresUri.toString()]: [['workspace', vscode.FileType.Directory]],
			[workspaceUri.toString()]: [['snapshot.ts', vscode.FileType.File]],
		});
		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('app', rootUri, 0)] },
			fake.fileSystem,
		);
		const src = snapshot.roots[0]?.children[0];

		assert.ok(src && src.kind === 'folder');
		const features = src.children[0];
		assert.ok(features && features.kind === 'folder');
		const workspace = features.children[0];
		assert.ok(workspace && workspace.kind === 'folder');
		assert.deepStrictEqual(workspace.children, [{
			kind: 'file',
			id: `file:${snapshotFileUri.toString()}`,
			name: 'snapshot.ts',
			uri: snapshotFileUri,
		}]);
	});

	test('Folder와 File을 함께 구성하고 Symbolic Link는 따라가지 않는다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const srcUri = vscode.Uri.joinPath(rootUri, 'src');
		const packageUri = vscode.Uri.joinPath(rootUri, 'package.json');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [
				['src', vscode.FileType.Directory],
				['package.json', vscode.FileType.File],
				['linked-src', vscode.FileType.Directory | vscode.FileType.SymbolicLink],
			],
			[srcUri.toString()]: [],
		});
		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('app', rootUri, 0)] },
			fake.fileSystem,
		);

		assert.deepStrictEqual(snapshot.roots[0]?.children, [
			{
				kind: 'folder',
				id: `folder:${srcUri.toString()}`,
				name: 'src',
				uri: srcUri,
				status: 'loaded',
				children: [],
			},
			{
				kind: 'file',
				id: `file:${packageUri.toString()}`,
				name: 'package.json',
				uri: packageUri,
			},
		]);
		assert.deepStrictEqual(
			fake.readDirectoryCalls.map((uri) => uri.toString()),
			[rootUri.toString(), srcUri.toString()],
		);
	});

	test('Multi-root Workspace의 각 Tree를 독립적으로 생성한다', async () => {
		const appUri = vscode.Uri.file('/workspace/app');
		const apiUri = vscode.Uri.file('/workspace/api');
		const appFileUri = vscode.Uri.joinPath(appUri, 'app.ts');
		const apiSrcUri = vscode.Uri.joinPath(apiUri, 'src');
		const apiFileUri = vscode.Uri.joinPath(apiSrcUri, 'server.ts');
		const fake = createFakeFileSystem({
			[appUri.toString()]: [['app.ts', vscode.FileType.File]],
			[apiUri.toString()]: [['src', vscode.FileType.Directory]],
			[apiSrcUri.toString()]: [['server.ts', vscode.FileType.File]],
		});
		const snapshot = await createWorkspaceSnapshot(
			{
				workspaceFolders: [
					createWorkspaceFolder('app', appUri, 0),
					createWorkspaceFolder('api', apiUri, 1),
				],
			},
			fake.fileSystem,
		);

		assert.strictEqual(snapshot.roots.length, 2);
		assert.deepStrictEqual(snapshot.roots[0]?.children, [{
			kind: 'file',
			id: `file:${appFileUri.toString()}`,
			name: 'app.ts',
			uri: appFileUri,
		}]);
		assert.deepStrictEqual(snapshot.roots[1]?.children, [{
			kind: 'folder',
			id: `folder:${apiSrcUri.toString()}`,
			name: 'src',
			uri: apiSrcUri,
			status: 'loaded',
			children: [{
				kind: 'file',
				id: `file:${apiFileUri.toString()}`,
				name: 'server.ts',
				uri: apiFileUri,
			}],
		}]);
	});

	test('각 Folder와 File의 이름, 실제 URI와 URI 기반 ID를 유지한다', async () => {
		const rootUri = vscode.Uri.parse('vscode-remote://ssh-remote+dev/workspace/app');
		const folderUri = vscode.Uri.joinPath(rootUri, 'source files');
		const fileUri = vscode.Uri.joinPath(folderUri, 'main file.ts');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [['source files', vscode.FileType.Directory]],
			[folderUri.toString()]: [['main file.ts', vscode.FileType.File]],
		});
		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('Remote App', rootUri, 0)] },
			fake.fileSystem,
		);
		const folder = snapshot.roots[0]?.children[0];

		assert.ok(folder && folder.kind === 'folder');
		assert.strictEqual(folder.name, 'source files');
		assert.strictEqual(folder.uri.toString(), folderUri.toString());
		assert.strictEqual(folder.id, `folder:${folderUri.toString()}`);
		const file = folder.children[0];
		assert.ok(file && file.kind === 'file');
		assert.strictEqual(file.name, 'main file.ts');
		assert.strictEqual(file.uri.toString(), fileUri.toString());
		assert.strictEqual(file.id, `file:${fileUri.toString()}`);
	});

	test('readDirectory를 Root와 발견한 모든 Directory에 한 번씩 호출한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const srcUri = vscode.Uri.joinPath(rootUri, 'src');
		const nestedUri = vscode.Uri.joinPath(srcUri, 'nested');
		const emptyUri = vscode.Uri.joinPath(rootUri, 'empty');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [
				['src', vscode.FileType.Directory],
				['empty', vscode.FileType.Directory],
				['README.md', vscode.FileType.File],
			],
			[srcUri.toString()]: [['nested', vscode.FileType.Directory]],
			[nestedUri.toString()]: [['index.ts', vscode.FileType.File]],
			[emptyUri.toString()]: [],
		});

		await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('app', rootUri, 0)] },
			fake.fileSystem,
		);

		assert.strictEqual(fake.readDirectoryCalls.length, 4);
		assert.deepStrictEqual(
			new Set(fake.readDirectoryCalls.map((uri) => uri.toString())),
			new Set([
				rootUri.toString(),
				srcUri.toString(),
				nestedUri.toString(),
				emptyUri.toString(),
			]),
		);
	});
});

function createWorkspaceFolder(
	name: string,
	uri: vscode.Uri,
	index: number,
): vscode.WorkspaceFolder {
	return { name, uri, index };
}

function createFakeFileSystem(
	directories: Readonly<Record<string, readonly FakeDirectoryEntry[]>>,
) {
	const readDirectoryCalls: vscode.Uri[] = [];
	const fileSystem = {
		async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
			readDirectoryCalls.push(uri);
			const entries = directories[uri.toString()];

			if (!entries) {
				throw new Error(`Fake Directory가 없습니다: ${uri.toString()}`);
			}

			return entries.map(([name, fileType]) => [name, fileType]);
		},
	};

	return { fileSystem, readDirectoryCalls };
}
