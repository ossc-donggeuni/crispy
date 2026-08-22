import * as assert from 'assert';
import * as vscode from 'vscode';
import type { WorkspaceFilterRule } from '../../workspace/workspaceFilter';
import type { WorkspaceRootFilter } from '../../workspace/workspaceFilterPersistence';
import { createWorkspaceSnapshot } from '../../workspace/workspaceSnapshot';

type FakeDirectoryEntry = readonly [string, vscode.FileType];
type FakeDirectory = readonly FakeDirectoryEntry[] | Error;

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

	test('Workspace Root 탐색 실패를 unreadable Root로 유지한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const readError = new Error('Permission denied');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: readError,
		});
		const warningRecorder = createWarningRecorder();
		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('app', rootUri, 0)] },
			fake.fileSystem,
			warningRecorder.logger,
		);
		const root = snapshot.roots[0];

		assert.ok(root);
		assert.strictEqual(root.id, `workspace-root:${rootUri.toString()}`);
		assert.strictEqual(root.name, 'app');
		assert.strictEqual(root.uri, rootUri);
		assert.strictEqual(root.status, 'unreadable');
		assert.deepStrictEqual(root.children, []);
		assert.strictEqual(warningRecorder.calls.length, 1);
		assert.ok(
			String(warningRecorder.calls[0]?.[0]).includes(rootUri.toString()),
		);
		assert.strictEqual(warningRecorder.calls[0]?.[1], readError);
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

	test('정상적인 빈 Folder를 loaded 상태와 빈 children으로 저장한다', async () => {
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

	test('Nested Folder 탐색 실패를 unreadable Folder로 유지한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const srcUri = vscode.Uri.joinPath(rootUri, 'src');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [['src', vscode.FileType.Directory]],
			[srcUri.toString()]: new Error('Nested Folder read failed'),
		});
		const warningRecorder = createWarningRecorder();
		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('app', rootUri, 0)] },
			fake.fileSystem,
			warningRecorder.logger,
		);
		const root = snapshot.roots[0];

		assert.ok(root);
		assert.strictEqual(root.status, 'loaded');
		assert.deepStrictEqual(root.children, [{
			kind: 'folder',
			id: `folder:${srcUri.toString()}`,
			name: 'src',
			uri: srcUri,
			status: 'unreadable',
			children: [],
		}]);
	});

	test('Folder 하나의 탐색 실패와 관계없이 정상 sibling을 유지한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const privateUri = vscode.Uri.joinPath(rootUri, 'private');
		const srcUri = vscode.Uri.joinPath(rootUri, 'src');
		const indexUri = vscode.Uri.joinPath(srcUri, 'index.ts');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [
				['private', vscode.FileType.Directory],
				['src', vscode.FileType.Directory],
			],
			[privateUri.toString()]: new Error('Private Folder read failed'),
			[srcUri.toString()]: [['index.ts', vscode.FileType.File]],
		});
		const warningRecorder = createWarningRecorder();
		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('app', rootUri, 0)] },
			fake.fileSystem,
			warningRecorder.logger,
		);

		assert.deepStrictEqual(snapshot.roots[0]?.children, [
			{
				kind: 'folder',
				id: `folder:${privateUri.toString()}`,
				name: 'private',
				uri: privateUri,
				status: 'unreadable',
				children: [],
			},
			{
				kind: 'folder',
				id: `folder:${srcUri.toString()}`,
				name: 'src',
				uri: srcUri,
				status: 'loaded',
				children: [{
					kind: 'file',
					id: `file:${indexUri.toString()}`,
					name: 'index.ts',
					uri: indexUri,
				}],
			},
		]);
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

	test('Multi-root 중 Root 하나의 탐색 실패와 관계없이 다른 Root를 탐색한다', async () => {
		const appUri = vscode.Uri.file('/workspace/app');
		const apiUri = vscode.Uri.file('/workspace/api');
		const serverUri = vscode.Uri.joinPath(apiUri, 'server.ts');
		const fake = createFakeFileSystem({
			[appUri.toString()]: new Error('App Root read failed'),
			[apiUri.toString()]: [['server.ts', vscode.FileType.File]],
		});
		const warningRecorder = createWarningRecorder();
		const snapshot = await createWorkspaceSnapshot(
			{
				workspaceFolders: [
					createWorkspaceFolder('app', appUri, 0),
					createWorkspaceFolder('api', apiUri, 1),
				],
			},
			fake.fileSystem,
			warningRecorder.logger,
		);

		assert.strictEqual(snapshot.roots.length, 2);
		assert.strictEqual(snapshot.roots[0]?.status, 'unreadable');
		assert.deepStrictEqual(snapshot.roots[0]?.children, []);
		assert.strictEqual(snapshot.roots[1]?.status, 'loaded');
		assert.deepStrictEqual(snapshot.roots[1]?.children, [{
			kind: 'file',
			id: `file:${serverUri.toString()}`,
			name: 'server.ts',
			uri: serverUri,
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

	test('정확히 `.crispy`인 Directory를 탐색과 Snapshot에서 제외한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const crispyUri = vscode.Uri.joinPath(rootUri, '.crispy');
		const srcUri = vscode.Uri.joinPath(rootUri, 'src');
		const sourceFileUri = vscode.Uri.joinPath(srcUri, 'index.ts');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [
				['.crispy', vscode.FileType.Directory],
				['src', vscode.FileType.Directory],
			],
			[crispyUri.toString()]: [['state.json', vscode.FileType.File]],
			[srcUri.toString()]: [['index.ts', vscode.FileType.File]],
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
			children: [{
				kind: 'file',
				id: `file:${sourceFileUri.toString()}`,
				name: 'index.ts',
				uri: sourceFileUri,
			}],
		}]);
		assert.deepStrictEqual(
			fake.readDirectoryCalls.map((uri) => uri.toString()),
			[rootUri.toString(), srcUri.toString()],
		);
	});

	test('Folder/File basename Rule을 Snapshot에 적용하고 제외 Folder는 탐색하지 않는다', async () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const excludedFolderUri = vscode.Uri.joinPath(rootUri, 'node_modules');
		const includedFolderUri = vscode.Uri.joinPath(rootUri, 'src');
		const includedFileUri = vscode.Uri.joinPath(rootUri, 'index.ts');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [
				['node_modules', vscode.FileType.Directory],
				['src', vscode.FileType.Directory],
				['debug.log', vscode.FileType.File],
				['index.ts', vscode.FileType.File],
			],
			[excludedFolderUri.toString()]: [['package.json', vscode.FileType.File]],
			[includedFolderUri.toString()]: [],
		});

		const snapshot = await createWorkspaceSnapshot(
			{ workspaceFolders: [createWorkspaceFolder('app', rootUri, 0)] },
			fake.fileSystem,
			console,
			[createRootFilter(rootUri, [
				{ kind: 'folder', pattern: 'node_modules' },
				{ kind: 'file', pattern: '*.log' },
			])],
		);

		assert.deepStrictEqual(snapshot.roots[0]?.children, [
			{
				kind: 'folder',
				id: `folder:${includedFolderUri.toString()}`,
				name: 'src',
				uri: includedFolderUri,
				status: 'loaded',
				children: [],
			},
			{
				kind: 'file',
				id: `file:${includedFileUri.toString()}`,
				name: 'index.ts',
				uri: includedFileUri,
			},
		]);
		assert.deepStrictEqual(
			fake.readDirectoryCalls.map((uri) => uri.toString()),
			[rootUri.toString(), includedFolderUri.toString()],
		);
	});

	test('Workspace Root 자체는 Folder Rule과 이름이 일치해도 유지한다', async () => {
		const rootUri = vscode.Uri.file('/workspace/node_modules');
		const fileUri = vscode.Uri.joinPath(rootUri, 'index.js');
		const fake = createFakeFileSystem({
			[rootUri.toString()]: [['index.js', vscode.FileType.File]],
		});

		const snapshot = await createWorkspaceSnapshot(
			{
				workspaceFolders: [createWorkspaceFolder('node_modules', rootUri, 0)],
			},
			fake.fileSystem,
			console,
			[createRootFilter(rootUri, [{
				kind: 'folder',
				pattern: 'node_modules',
			}])],
		);

		assert.strictEqual(snapshot.roots[0]?.name, 'node_modules');
		assert.strictEqual(snapshot.roots[0]?.status, 'loaded');
		assert.deepStrictEqual(snapshot.roots[0]?.children, [{
			kind: 'file',
			id: `file:${fileUri.toString()}`,
			name: 'index.js',
			uri: fileUri,
		}]);
		assert.deepStrictEqual(fake.readDirectoryCalls, [rootUri]);
	});

	test('Multi-root의 서로 다른 Filter를 각 Root에만 적용한다', async () => {
		const appUri = vscode.Uri.file('/workspace/app');
		const apiUri = vscode.Uri.file('/workspace/api');
		const appDistUri = vscode.Uri.joinPath(appUri, 'dist');
		const apiDistUri = vscode.Uri.joinPath(apiUri, 'dist');
		const fake = createFakeFileSystem({
			[appUri.toString()]: [
				['dist', vscode.FileType.Directory],
				['debug.log', vscode.FileType.File],
			],
			[appDistUri.toString()]: [],
			[apiUri.toString()]: [
				['dist', vscode.FileType.Directory],
				['debug.log', vscode.FileType.File],
			],
			[apiDistUri.toString()]: [],
		});

		const snapshot = await createWorkspaceSnapshot(
			{
				workspaceFolders: [
					createWorkspaceFolder('app', appUri, 0),
					createWorkspaceFolder('api', apiUri, 1),
				],
			},
			fake.fileSystem,
			console,
			[
				createRootFilter(appUri, [{ kind: 'folder', pattern: 'dist' }]),
				createRootFilter(apiUri, [{ kind: 'file', pattern: '*.log' }]),
			],
		);

		assert.deepStrictEqual(
			snapshot.roots[0]?.children.map(({ name }) => name),
			['debug.log'],
		);
		assert.deepStrictEqual(
			snapshot.roots[1]?.children.map(({ name }) => name),
			['dist'],
		);
		assert.deepStrictEqual(
			fake.readDirectoryCalls.map((uri) => uri.toString()),
			[appUri.toString(), apiUri.toString(), apiDistUri.toString()],
		);
	});

	test('Filter를 사용할 수 없는 Root는 다른 Root의 Filter 적용을 막지 않는다', async () => {
		const unavailableUri = vscode.Uri.file('/workspace/unavailable-filter');
		const filteredUri = vscode.Uri.file('/workspace/filtered');
		const fake = createFakeFileSystem({
			[unavailableUri.toString()]: [['debug.log', vscode.FileType.File]],
			[filteredUri.toString()]: [['debug.log', vscode.FileType.File]],
		});

		const snapshot = await createWorkspaceSnapshot(
			{
				workspaceFolders: [
					createWorkspaceFolder('unavailable', unavailableUri, 0),
					createWorkspaceFolder('filtered', filteredUri, 1),
				],
			},
			fake.fileSystem,
			console,
			[
				{ rootUri: unavailableUri, filter: undefined },
				createRootFilter(filteredUri, [{ kind: 'file', pattern: '*.log' }]),
			],
		);

		assert.deepStrictEqual(
			snapshot.roots[0]?.children.map(({ name }) => name),
			['debug.log'],
		);
		assert.deepStrictEqual(snapshot.roots[1]?.children, []);
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

function createRootFilter(
	rootUri: vscode.Uri,
	rules: readonly WorkspaceFilterRule[],
): WorkspaceRootFilter {
	return {
		rootUri,
		filter: { version: 1, rules },
	};
}

function createFakeFileSystem(
	directories: Readonly<Record<string, FakeDirectory>>,
) {
	const readDirectoryCalls: vscode.Uri[] = [];
	const fileSystem = {
		async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
			readDirectoryCalls.push(uri);
			const directory = directories[uri.toString()];

			if (!directory) {
				throw new Error(`Fake Directory가 없습니다: ${uri.toString()}`);
			}

			if (directory instanceof Error) {
				throw directory;
			}

			return directory.map(([name, fileType]) => [name, fileType]);
		},
	};

	return { fileSystem, readDirectoryCalls };
}

function createWarningRecorder() {
	const calls: unknown[][] = [];
	const logger = {
		warn(...args: unknown[]): void {
			calls.push(args);
		},
	};

	return { logger, calls };
}
