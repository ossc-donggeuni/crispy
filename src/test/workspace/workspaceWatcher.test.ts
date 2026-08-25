import * as assert from 'assert';
import * as vscode from 'vscode';
import { createCanvasRuntime } from '../../extension';
import { createWorkspaceRefreshCoordinator } from '../../workspace/workspaceRefresh';
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

	test('Multi-root 변경은 Runtime의 동일 Coordinator 경로로 연결되고 dispose 후 중단된다', async () => {
		const rootAUri = vscode.Uri.file('/workspace/root-a');
		const rootBUri = vscode.Uri.file('/workspace/root-b');
		const rootCUri = vscode.Uri.file('/workspace/root-c');
		const rootA = createWorkspaceFolder('root-a', rootAUri, 0);
		const rootB = createWorkspaceFolder('root-b', rootBUri, 1);
		const rootC = createWorkspaceFolder('root-c', rootCUri, 2);
		const fake = createFakeWorkspace([rootA, rootB]);
		let graphVersion = 'initial';
		let snapshotCalls = 0;
		const graphMessages: string[] = [];
		const coordinator = createWorkspaceRefreshCoordinator({
			async createWorkspaceSnapshot() {
				snapshotCalls += 1;
				return { roots: [] };
			},
			convertWorkspaceSnapshotToGraph() {
				const project = {
					kind: 'project' as const,
					id: `project:${graphVersion}`,
					name: graphVersion,
					status: 'loaded' as const,
					children: [],
				};

				return {
					roots: [{ id: `root:${graphVersion}`, nodeId: project.id }],
					rootNodes: { [project.id]: project },
				};
			},
			readWorkspaceTrust: () => true,
			createWorkspaceRootCatalog: () => [],
			async postMessage(message) {
				graphMessages.push(
					message.presentation.graph.roots[0]?.nodeId ?? 'empty',
				);
				return true;
			},
		});
		const runtime = createCanvasRuntime(
			{} as vscode.WebviewPanel,
			{ detach: () => undefined, terminate: () => undefined },
			[],
			coordinator,
			(onChange) => watchWorkspaceChanges(onChange, fake.source),
		);
		runtime.markWebviewReady();

		fake.watcher.fireChange(vscode.Uri.joinPath(rootAUri, 'saved.ts'));
		fake.watcher.fireCreate(vscode.Uri.joinPath(
			rootAUri,
			'.crispy',
			'state.json',
		));
		fake.watcher.fireDelete(vscode.Uri.joinPath(
			rootBUri,
			'packages',
			'.crispy',
			'filter.json',
		));
		await Promise.resolve();
		assert.strictEqual(snapshotCalls, 0);

		graphVersion = 'root-c-added';
		fake.fireWorkspaceFolderChange([rootC], []);
		await waitFor(() => graphMessages.length === 1);
		graphVersion = 'root-b-removed';
		fake.fireWorkspaceFolderChange([], [rootB]);
		await waitFor(() => graphMessages.length === 2);
		graphVersion = 'file-created';
		fake.watcher.fireCreate(vscode.Uri.joinPath(rootAUri, 'src', 'new.ts'));
		await waitFor(() => graphMessages.length === 3);
		graphVersion = 'folder-deleted';
		fake.watcher.fireDelete(vscode.Uri.joinPath(rootAUri, 'generated'));
		await waitFor(() => graphMessages.length === 4);

		assert.strictEqual(snapshotCalls, 4);
		assert.deepStrictEqual(graphMessages, [
			'project:root-c-added',
			'project:root-b-removed',
			'project:file-created',
			'project:folder-deleted',
		]);

		runtime.detach();
		fake.watcher.fireCreate(vscode.Uri.joinPath(rootAUri, 'after-close.ts'));
		fake.fireWorkspaceFolderChange([], [rootC]);
		await Promise.resolve();
		assert.strictEqual(snapshotCalls, 4);
		assert.strictEqual(fake.watcher.disposeCalls, 1);
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

	test('Root ownership callback은 Root refresh보다 먼저이고 일반 File event에는 호출되지 않는다', () => {
		const rootUri = vscode.Uri.file('/workspace/app');
		const root = createWorkspaceFolder('app', rootUri, 0);
		const fake = createFakeWorkspace([root]);
		const timeline: string[] = [];
		const disposable = watchWorkspaceChanges(
			() => timeline.push('refresh'),
			fake.source,
			(event) => timeline.push(
				`roots:${event.removed.length}/${event.added.length}`,
			),
		);

		fake.watcher.fireCreate(vscode.Uri.joinPath(rootUri, 'ordinary.ts'));
		assert.deepStrictEqual(timeline, ['refresh']);

		/** 동일 URI가 added에도 즉시 재등장해도 removed ownership event를 먼저 보존한다. */
		fake.fireWorkspaceFolderChange([root], [root]);
		assert.deepStrictEqual(timeline, ['refresh', 'roots:1/1', 'refresh']);
		disposable.dispose();
	});

	test('Root ownership callback 실패 시 정리 전 Graph refresh를 publish하지 않는다', () => {
		const root = createWorkspaceFolder(
			'app',
			vscode.Uri.file('/workspace/app'),
			0,
		);
		const fake = createFakeWorkspace([root]);
		let refreshes = 0;
		const disposable = watchWorkspaceChanges(
			() => refreshes += 1,
			fake.source,
			() => {
				throw new Error('ownership cleanup failed');
			},
		);

		fake.fireWorkspaceFolderChange([], [root]);

		assert.strictEqual(refreshes, 0);
		disposable.dispose();
	});

	test('Workspace Trust grant는 같은 refresh callback으로 전달된다', () => {
		const fake = createFakeWorkspace([]);
		let changes = 0;
		const disposable = watchWorkspaceChanges(() => changes += 1, fake.source);

		fake.fireWorkspaceTrustGrant();

		assert.strictEqual(changes, 1);
		disposable.dispose();
		fake.fireWorkspaceTrustGrant();
		assert.strictEqual(changes, 1);
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
	const workspaceTrustEmitter = new vscode.EventEmitter<void>();
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
		onDidGrantWorkspaceTrust: workspaceTrustEmitter.event,
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
		fireWorkspaceTrustGrant(): void {
			workspaceTrustEmitter.fire();
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

/** 비동기 Coordinator가 기대 상태에 도달할 때까지 제한적으로 진행한다. */
async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
		await Promise.resolve();
	}

	assert.strictEqual(predicate(), true);
}
