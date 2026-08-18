import * as assert from 'assert';
import * as vscode from 'vscode';
import type { Graph, Project } from '../../webview/graph/graphModel';
import type {
	File as WorkspaceFile,
	Folder as WorkspaceFolder,
	WorkspaceEntry,
	WorkspaceRoot,
	WorkspaceSnapshot,
} from '../../workspace/workspaceModel';
import { convertWorkspaceSnapshotToGraph } from '../../workspace/workspaceToGraph';

suite('Workspace Snapshot to Graph', () => {
	test('빈 Workspace Snapshot을 빈 Graph로 변환한다', () => {
		const graph = convertWorkspaceSnapshotToGraph({ roots: [] });

		assert.deepStrictEqual(graph, { roots: [], rootNodes: {} });
	});

	test('Workspace Root 하나를 Project Root 하나로 변환한다', () => {
		const workspaceRoot = createWorkspaceRoot('app');
		const graph = convertWorkspaceSnapshotToGraph({ roots: [workspaceRoot] });

		assert.deepStrictEqual(graph.roots, [{
			id: `root:${workspaceRoot.id}`,
			nodeId: workspaceRoot.id,
		}]);
		assert.deepStrictEqual(graph.rootNodes[workspaceRoot.id], {
			kind: 'project',
			id: workspaceRoot.id,
			name: 'app',
			children: [],
		});
	});

	test('Multi-root Workspace의 각 Root를 독립적인 Graph Root로 변환한다', () => {
		const appRoot = createWorkspaceRoot('app', [
			createWorkspaceFile('app.ts', 'file:app/app.ts'),
		]);
		const apiRoot = createWorkspaceRoot('api', [
			createWorkspaceFile('server.ts', 'file:api/server.ts'),
		]);
		const graph = convertWorkspaceSnapshotToGraph({ roots: [appRoot, apiRoot] });

		assert.deepStrictEqual(graph.roots, [
			{ id: `root:${appRoot.id}`, nodeId: appRoot.id },
			{ id: `root:${apiRoot.id}`, nodeId: apiRoot.id },
		]);
		assert.strictEqual(graph.rootNodes[appRoot.id]?.name, 'app');
		assert.strictEqual(graph.rootNodes[apiRoot.id]?.name, 'api');
		assert.notStrictEqual(
			graph.rootNodes[appRoot.id],
			graph.rootNodes[apiRoot.id],
		);
	});

	test('Root 바로 아래 Workspace File을 Graph File로 변환한다', () => {
		const workspaceFile = createWorkspaceFile(
			'package.json',
			'file:app/package.json',
		);
		const workspaceRoot = createWorkspaceRoot('app', [workspaceFile]);
		const graph = convertWorkspaceSnapshotToGraph({ roots: [workspaceRoot] });

		assert.deepStrictEqual(getProject(graph, workspaceRoot.id).children, [{
			kind: 'file',
			id: workspaceFile.id,
			name: workspaceFile.name,
		}]);
	});

	test('Root 바로 아래 Workspace Folder를 Graph Folder로 변환한다', () => {
		const workspaceFolder = createWorkspaceFolder(
			'src',
			'folder:app/src',
		);
		const workspaceRoot = createWorkspaceRoot('app', [workspaceFolder]);
		const graph = convertWorkspaceSnapshotToGraph({ roots: [workspaceRoot] });

		assert.deepStrictEqual(getProject(graph, workspaceRoot.id).children, [{
			kind: 'folder',
			id: workspaceFolder.id,
			name: workspaceFolder.name,
			children: [],
		}]);
	});

	test('중첩된 Folder와 File Tree를 같은 계층으로 변환한다', () => {
		const indexFile = createWorkspaceFile('index.ts', 'file:app/src/lib/index.ts');
		const libFolder = createWorkspaceFolder(
			'lib',
			'folder:app/src/lib',
			[indexFile],
		);
		const srcFolder = createWorkspaceFolder(
			'src',
			'folder:app/src',
			[libFolder],
		);
		const workspaceRoot = createWorkspaceRoot('app', [srcFolder]);
		const graph = convertWorkspaceSnapshotToGraph({ roots: [workspaceRoot] });

		assert.deepStrictEqual(getProject(graph, workspaceRoot.id).children, [{
			kind: 'folder',
			id: srcFolder.id,
			name: 'src',
			children: [{
				kind: 'folder',
				id: libFolder.id,
				name: 'lib',
				children: [{
					kind: 'file',
					id: indexFile.id,
					name: 'index.ts',
				}],
			}],
		}]);
	});

	test('Folder와 File의 이름 및 안정적인 ID를 그대로 유지한다', () => {
		const workspaceFile = createWorkspaceFile(
			'actual-name.ts',
			'file:vscode-remote://workspace/src/actual-name.ts',
		);
		const workspaceFolder = createWorkspaceFolder(
			'source files',
			'folder:vscode-remote://workspace/source%20files',
			[workspaceFile],
		);
		const workspaceRoot = createWorkspaceRoot('app', [workspaceFolder]);
		const graph = convertWorkspaceSnapshotToGraph({ roots: [workspaceRoot] });
		const folder = getProject(graph, workspaceRoot.id).children[0];

		assert.ok(folder && folder.kind === 'folder');
		assert.strictEqual(folder.id, workspaceFolder.id);
		assert.strictEqual(folder.name, workspaceFolder.name);
		const file = folder.children[0];
		assert.ok(file && file.kind === 'file');
		assert.strictEqual(file.id, workspaceFile.id);
		assert.strictEqual(file.name, workspaceFile.name);
	});

	test('Folder와 File의 children 순서를 그대로 유지한다', () => {
		const workspaceEntries: WorkspaceEntry[] = [
			createWorkspaceFile('first.ts', 'file:app/first.ts'),
			createWorkspaceFolder('second', 'folder:app/second', [
				createWorkspaceFile('nested-a.ts', 'file:app/second/nested-a.ts'),
				createWorkspaceFile('nested-b.ts', 'file:app/second/nested-b.ts'),
			]),
			createWorkspaceFile('third.ts', 'file:app/third.ts'),
		];
		const workspaceRoot = createWorkspaceRoot('app', workspaceEntries);
		const graph = convertWorkspaceSnapshotToGraph({ roots: [workspaceRoot] });
		const project = getProject(graph, workspaceRoot.id);

		assert.deepStrictEqual(
			project.children.map(({ name }) => name),
			['first.ts', 'second', 'third.ts'],
		);
		const second = project.children[1];
		assert.ok(second && second.kind === 'folder');
		assert.deepStrictEqual(
			second.children.map(({ name }) => name),
			['nested-a.ts', 'nested-b.ts'],
		);
	});

	test('Graph.roots의 모든 nodeId를 올바른 rootNodes Project에 연결한다', () => {
		const workspaceRoots = [
			createWorkspaceRoot('app'),
			createWorkspaceRoot('api'),
			createWorkspaceRoot('shared'),
		];
		const graph = convertWorkspaceSnapshotToGraph({ roots: workspaceRoots });

		for (const [index, graphRoot] of graph.roots.entries()) {
			const project = graph.rootNodes[graphRoot.nodeId];

			assert.ok(project && project.kind === 'project');
			assert.strictEqual(graphRoot.nodeId, workspaceRoots[index]?.id);
			assert.strictEqual(project.id, graphRoot.nodeId);
		}
		assert.deepStrictEqual(
			Object.keys(graph.rootNodes),
			workspaceRoots.map(({ id }) => id),
		);
	});

	test('변환 과정에서 원본 Workspace Snapshot을 변경하지 않는다', () => {
		const workspaceFile = createWorkspaceFile('index.ts', 'file:app/src/index.ts');
		const workspaceFolder = createWorkspaceFolder(
			'src',
			'folder:app/src',
			[workspaceFile],
		);
		const workspaceRoot = createWorkspaceRoot('app', [workspaceFolder]);
		const snapshot: WorkspaceSnapshot = { roots: [workspaceRoot] };
		const originalRoots = snapshot.roots;
		const originalRootChildren = workspaceRoot.children;
		const originalFolderChildren = workspaceFolder.children;
		Object.freeze(workspaceFile);
		Object.freeze(workspaceFolder.children);
		Object.freeze(workspaceFolder);
		Object.freeze(workspaceRoot.children);
		Object.freeze(workspaceRoot);
		Object.freeze(snapshot.roots);
		Object.freeze(snapshot);

		const graph = convertWorkspaceSnapshotToGraph(snapshot);

		assert.strictEqual(snapshot.roots, originalRoots);
		assert.strictEqual(snapshot.roots[0], workspaceRoot);
		assert.strictEqual(workspaceRoot.children, originalRootChildren);
		assert.strictEqual(workspaceFolder.children, originalFolderChildren);
		assert.strictEqual(workspaceFolder.children[0], workspaceFile);
		assert.notStrictEqual(graph.rootNodes[workspaceRoot.id], workspaceRoot);
		assert.notStrictEqual(
			getProject(graph, workspaceRoot.id).children,
			workspaceRoot.children,
		);
	});
});

function createWorkspaceRoot(
	name: string,
	children: readonly WorkspaceEntry[] = [],
): WorkspaceRoot {
	const uri = vscode.Uri.file(`/workspace/${name}`);

	return {
		id: `workspace-root:${uri.toString()}`,
		name,
		uri,
		status: 'loaded',
		children,
	};
}

function createWorkspaceFolder(
	name: string,
	id: string,
	children: readonly WorkspaceEntry[] = [],
): WorkspaceFolder {
	return {
		kind: 'folder',
		id,
		name,
		uri: vscode.Uri.file(`/workspace/${name}`),
		status: 'loaded',
		children,
	};
}

function createWorkspaceFile(name: string, id: string): WorkspaceFile {
	return {
		kind: 'file',
		id,
		name,
		uri: vscode.Uri.file(`/workspace/${name}`),
	};
}

function getProject(graph: Graph, projectId: string): Project {
	const project = graph.rootNodes[projectId];

	assert.ok(project && project.kind === 'project');
	return project;
}
