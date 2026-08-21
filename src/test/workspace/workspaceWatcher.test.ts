import * as assert from 'assert';
import * as vscode from 'vscode';
import { watchWorkspaceChanges } from '../../workspace/workspaceWatcher';

suite('Workspace Watcher', () => {
	test('File 생성은 변경 callback을 호출한다', () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const fake = createFakeWorkspace([createWorkspaceFolder('app', rootUri, 0)]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.watcher.fireCreate(vscode.Uri.joinPath(rootUri, 'index.ts'));

		assert.strictEqual(changes, 1);
		disposable.dispose();
	});

	test('Folder 생성은 변경 callback을 호출한다', () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const fake = createFakeWorkspace([createWorkspaceFolder('app', rootUri, 0)]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.watcher.fireCreate(vscode.Uri.joinPath(rootUri, 'src'));

		assert.strictEqual(changes, 1);
		disposable.dispose();
	});

	test('File 삭제는 변경 callback을 호출한다', () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const fake = createFakeWorkspace([createWorkspaceFolder('app', rootUri, 0)]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.watcher.fireDelete(vscode.Uri.joinPath(rootUri, 'README.md'));

		assert.strictEqual(changes, 1);
		disposable.dispose();
	});

	test('Folder 삭제는 변경 callback을 호출한다', () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const fake = createFakeWorkspace([createWorkspaceFolder('app', rootUri, 0)]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.watcher.fireDelete(vscode.Uri.joinPath(rootUri, 'src'));

		assert.strictEqual(changes, 1);
		disposable.dispose();
	});

	test('File 내용 변경은 callback을 호출하지 않는다', () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const fake = createFakeWorkspace([createWorkspaceFolder('app', rootUri, 0)]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.watcher.fireChange(vscode.Uri.joinPath(rootUri, 'index.ts'));

		assert.strictEqual(changes, 0);
		assert.deepStrictEqual(fake.createWatcherCalls, [{
			globPattern: '**/*',
			ignoreCreateEvents: false,
			ignoreChangeEvents: true,
			ignoreDeleteEvents: false,
		}]);
		disposable.dispose();
	});

	test('`.crispy` Directory와 내부 생성·삭제는 callback을 호출하지 않는다', () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const crispyUri = vscode.Uri.joinPath(rootUri, '.crispy');
		const nestedCrispyUri = vscode.Uri.joinPath(rootUri, 'packages', '.crispy');
		const fake = createFakeWorkspace([createWorkspaceFolder('app', rootUri, 0)]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.watcher.fireCreate(crispyUri);
		fake.watcher.fireCreate(vscode.Uri.joinPath(crispyUri, 'state.json'));
		fake.watcher.fireDelete(vscode.Uri.joinPath(crispyUri, 'future.json'));
		fake.watcher.fireDelete(vscode.Uri.joinPath(nestedCrispyUri, 'filter.json'));

		assert.strictEqual(changes, 0);
		disposable.dispose();
	});

	test('Root와 event URI의 path casing이 달라도 `.crispy` 변경을 제외한다', () => {
		const rootUri = vscode.Uri.file('/workspace/Project');
		const eventRootUri = vscode.Uri.file('/workspace/project');
		const root = createWorkspaceFolder('Project', rootUri, 0);
		const fake = createFakeWorkspace([root]);
		fake.source.getWorkspaceFolder = () => root;
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.watcher.fireCreate(vscode.Uri.joinPath(
			eventRootUri,
			'.crispy',
			'state.json',
		));
		fake.watcher.fireDelete(vscode.Uri.joinPath(
			eventRootUri,
			'packages',
			'.crispy',
			'filter.json',
		));

		assert.strictEqual(changes, 0);
		disposable.dispose();
	});

	test('Multi-root Workspace의 각 Root에서 생성·삭제를 감지한다', () => {
		const frontendUri = vscode.Uri.file('/workspace/frontend');
		const backendUri = vscode.Uri.file('/workspace/backend');
		const fake = createFakeWorkspace([
			createWorkspaceFolder('frontend', frontendUri, 0),
			createWorkspaceFolder('backend', backendUri, 1),
		]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.watcher.fireCreate(vscode.Uri.joinPath(frontendUri, 'src', 'app.ts'));
		fake.watcher.fireDelete(vscode.Uri.joinPath(backendUri, 'lib'));

		assert.strictEqual(changes, 2);
		disposable.dispose();
	});

	test('Workspace Root 추가와 제거를 각각 감지한다', () => {
		const existingUri = vscode.Uri.file('/workspace/app');
		const addedUri = vscode.Uri.file('/workspace/api');
		const existing = createWorkspaceFolder('app', existingUri, 0);
		const added = createWorkspaceFolder('api', addedUri, 1);
		const fake = createFakeWorkspace([existing]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.fireWorkspaceFolderChange([added], []);
		fake.fireWorkspaceFolderChange([], [existing]);

		assert.strictEqual(changes, 2);
		disposable.dispose();
	});

	test('Workspace가 없어도 Root 추가를 감지한다', () => {
		const root = createWorkspaceFolder(
			'app',
			vscode.Uri.file('/workspace/app'),
			0,
		);
		const fake = createFakeWorkspace([]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.fireWorkspaceFolderChange([root], []);

		assert.strictEqual(changes, 1);
		disposable.dispose();
	});

	test('dispose 이후에는 어떤 변경도 callback을 호출하지 않는다', () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const root = createWorkspaceFolder('app', rootUri, 0);
		const fake = createFakeWorkspace([root]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		disposable.dispose();
		disposable.dispose();
		fake.watcher.fireCreate(vscode.Uri.joinPath(rootUri, 'created.ts'));
		fake.watcher.fireDelete(vscode.Uri.joinPath(rootUri, 'deleted.ts'));
		fake.watcher.fireChange(vscode.Uri.joinPath(rootUri, 'changed.ts'));
		fake.fireWorkspaceFolderChange([], [root]);

		assert.strictEqual(changes, 0);
		assert.strictEqual(fake.watcher.disposeCalls, 1);
	});
});

interface CreateWatcherCall {
	readonly globPattern: vscode.GlobPattern;
	readonly ignoreCreateEvents: boolean | undefined;
	readonly ignoreChangeEvents: boolean | undefined;
	readonly ignoreDeleteEvents: boolean | undefined;
}

/** FileSystemWatcher event를 동기적으로 발생시키는 테스트 대역이다. */
class FakeFileSystemWatcher {
	private readonly createEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	private readonly deleteEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidCreate = this.createEmitter.event;
	readonly onDidDelete = this.deleteEmitter.event;
	disposeCalls = 0;

	fireCreate(uri: vscode.Uri): void {
		this.createEmitter.fire(uri);
	}

	fireChange(uri: vscode.Uri): void {
		this.changeEmitter.fire(uri);
	}

	fireDelete(uri: vscode.Uri): void {
		this.deleteEmitter.fire(uri);
	}

	dispose(): void {
		this.disposeCalls += 1;
		this.createEmitter.dispose();
		this.changeEmitter.dispose();
		this.deleteEmitter.dispose();
	}
}

/** Workspace API의 watcher 생성, Root 조회와 Root change event를 제공한다. */
function createFakeWorkspace(initialFolders: readonly vscode.WorkspaceFolder[]) {
	const watcher = new FakeFileSystemWatcher();
	const workspaceFoldersEmitter = new vscode.EventEmitter<
		vscode.WorkspaceFoldersChangeEvent
	>();
	const createWatcherCalls: CreateWatcherCall[] = [];
	let workspaceFolders = [...initialFolders];
	const source = {
		createFileSystemWatcher(
			globPattern: vscode.GlobPattern,
			ignoreCreateEvents?: boolean,
			ignoreChangeEvents?: boolean,
			ignoreDeleteEvents?: boolean,
		): FakeFileSystemWatcher {
			createWatcherCalls.push({
				globPattern,
				ignoreCreateEvents,
				ignoreChangeEvents,
				ignoreDeleteEvents,
			});
			return watcher;
		},
		getWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
			return workspaceFolders
				.filter(({ uri: rootUri }) => isUriInsideRoot(uri, rootUri))
				.sort((left, right) => right.uri.path.length - left.uri.path.length)[0];
		},
		onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
	};

	return {
		source,
		watcher,
		createWatcherCalls,
		fireWorkspaceFolderChange(
			added: readonly vscode.WorkspaceFolder[],
			removed: readonly vscode.WorkspaceFolder[],
		): void {
			const removedUris = new Set(removed.map(({ uri }) => uri.toString()));
			workspaceFolders = workspaceFolders
				.filter(({ uri }) => !removedUris.has(uri.toString()))
				.concat(added);
			workspaceFoldersEmitter.fire({ added, removed });
		},
	};
}

/** URI가 scheme/authority와 path segment 경계를 포함해 Root 아래인지 확인한다. */
function isUriInsideRoot(uri: vscode.Uri, rootUri: vscode.Uri): boolean {
	if (uri.scheme !== rootUri.scheme || uri.authority !== rootUri.authority) {
		return false;
	}

	const rootPath = rootUri.path.replace(/\/+$/, '');

	return uri.path === rootPath || uri.path.startsWith(`${rootPath}/`);
}

/** Snapshot 테스트와 같은 최소 VS Code WorkspaceFolder fixture를 만든다. */
function createWorkspaceFolder(
	name: string,
	uri: vscode.Uri,
	index: number,
): vscode.WorkspaceFolder {
	return { name, uri, index };
}
