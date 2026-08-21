import * as assert from 'assert';
import * as vscode from 'vscode';
import type { WorkspaceToWebviewMessage } from '../../messages';
import type { Graph } from '../../webview/graph/graphModel';
import type { WorkspaceFilter } from '../../workspace/workspaceFilter';
import {
	loadOrCreateWorkspaceFilters,
	type WorkspaceRootFilter,
} from '../../workspace/workspaceFilterPersistence';
import {
	createCurrentWorkspaceGraph,
	createWorkspaceRefreshCoordinator,
} from '../../workspace/workspaceRefresh';
import { createWorkspaceSnapshot } from '../../workspace/workspaceSnapshot';
import { convertWorkspaceSnapshotToGraph } from '../../workspace/workspaceToGraph';

suite('Workspace Filter Integration', () => {
	test('초기 Graph와 Refresh가 같은 경로로 현재 filter.json을 다시 읽어 적용한다', async () => {
		const extensionUri = vscode.Uri.file('/extension');
		const rootUri = vscode.Uri.file('/workspace/app');
		const generatedUri = vscode.Uri.joinPath(rootUri, 'generated');
		const distUri = vscode.Uri.joinPath(rootUri, 'dist');
		const crispyUri = vscode.Uri.joinPath(rootUri, '.crispy');
		const filterUri = vscode.Uri.joinPath(crispyUri, 'filter.json');
		const fake = createFakeWorkspaceFileSystem({
			[rootUri.toString()]: [
				['generated', vscode.FileType.Directory],
				['dist', vscode.FileType.Directory],
				['keep.ts', vscode.FileType.File],
				['.crispy', vscode.FileType.Directory],
			],
			[generatedUri.toString()]: [['generated.ts', vscode.FileType.File]],
			[distUri.toString()]: [['bundle.js', vscode.FileType.File]],
			[crispyUri.toString()]: [['filter.json', vscode.FileType.File]],
		});
		fake.setFilter(filterUri, createFolderFilter('generated'));
		const messages: WorkspaceToWebviewMessage[] = [];
		const dependencies = {
			loadWorkspaceFilters: () => loadOrCreateWorkspaceFilters(
				[rootUri],
				extensionUri,
				fake.fileSystem,
			),
			createWorkspaceSnapshot: (
				rootFilters: readonly WorkspaceRootFilter[],
			) => createWorkspaceSnapshot(
				{
					workspaceFolders: [{ name: 'app', uri: rootUri, index: 0 }],
				},
				fake.fileSystem,
				console,
				rootFilters,
			),
			convertWorkspaceSnapshotToGraph,
			async postMessage(message: WorkspaceToWebviewMessage) {
				messages.push(message);
				return true;
			},
		};

		const initialGraph = await createCurrentWorkspaceGraph(dependencies);

		assert.deepStrictEqual(getWorkspaceChildNames(initialGraph), [
			'dist',
			'keep.ts',
		]);
		assert.strictEqual(
			fake.readDirectoryCalls.some((uri) => uri.toString() === generatedUri.toString()),
			false,
		);
		assert.strictEqual(
			fake.readDirectoryCalls.some((uri) => uri.toString() === crispyUri.toString()),
			false,
		);

		fake.setFilter(filterUri, createFolderFilter('dist'));
		fake.readDirectoryCalls.length = 0;
		const coordinator = createWorkspaceRefreshCoordinator(dependencies);

		await coordinator.requestWorkspaceRefresh();

		assert.strictEqual(messages.length, 1);
		assert.deepStrictEqual(getWorkspaceChildNames(messages[0]!.graph), [
			'generated',
			'keep.ts',
		]);
		assert.strictEqual(
			fake.readDirectoryCalls.some((uri) => uri.toString() === generatedUri.toString()),
			true,
		);
		assert.strictEqual(
			fake.readDirectoryCalls.some((uri) => uri.toString() === distUri.toString()),
			false,
		);
		assert.strictEqual(
			fake.readDirectoryCalls.some((uri) => uri.toString() === crispyUri.toString()),
			false,
		);
	});
});

function createFolderFilter(pattern: string): WorkspaceFilter {
	return {
		version: 1,
		rules: [{ kind: 'folder', pattern }],
	};
}

function getWorkspaceChildNames(graph: Graph): string[] {
	const root = graph.roots[0];
	assert.ok(root);
	const project = graph.rootNodes[root.nodeId];
	assert.ok(project?.kind === 'project');

	return project.children.map(({ name }) => name);
}

function createFakeWorkspaceFileSystem(
	directories: Readonly<Record<
		string,
		readonly (readonly [string, vscode.FileType])[]
	>>,
) {
	const files = new Map<string, Uint8Array>();
	const textEncoder = new TextEncoder();
	const readDirectoryCalls: vscode.Uri[] = [];
	const fileSystem = {
		async readFile(uri: vscode.Uri): Promise<Uint8Array> {
			const content = files.get(uri.toString());

			if (!content) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}

			return content;
		},
		async createDirectory(): Promise<void> {},
		async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
			files.set(uri.toString(), content);
		},
		async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
			readDirectoryCalls.push(uri);
			const entries = directories[uri.toString()];

			if (!entries) {
				throw vscode.FileSystemError.FileNotFound(uri);
			}

			return entries.map(([name, type]) => [name, type]);
		},
	};

	return {
		fileSystem,
		readDirectoryCalls,
		setFilter(uri: vscode.Uri, filter: WorkspaceFilter): void {
			files.set(uri.toString(), textEncoder.encode(JSON.stringify(filter)));
		},
	};
}
