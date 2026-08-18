import * as assert from 'assert';
import type { Folder, Graph, Project } from '../../webview/graph/graphModel';
import {
	deserializeGraphFromWebview,
	serializeGraphForWebview,
} from '../../webview/graph/graphTransport';

suite('Workspace Graph Transport', () => {
	test('단일 Workspace Project Graph를 Webview 초기 데이터로 유지한다', () => {
		const project = createProject('app');
		const graph = createGraph(project);

		assert.deepStrictEqual(
			deserializeGraphFromWebview(serializeGraphForWebview(graph)),
			graph,
		);
	});

	test('Multi-root Graph의 모든 Root와 Project 연결을 그대로 유지한다', () => {
		const app = createProject('app');
		const api = createProject('api');
		const graph = createGraph(app, api);
		const restored = deserializeGraphFromWebview(
			serializeGraphForWebview(graph),
		);

		assert.deepStrictEqual(restored.roots, graph.roots);
		assert.deepStrictEqual(restored.rootNodes, graph.rootNodes);
	});

	test('unreadable Directory 상태를 최종 Webview Graph까지 유지한다', () => {
		const unreadableFolder: Folder = {
			kind: 'folder',
			id: 'folder:app/private',
			name: 'private',
			status: 'unreadable',
			children: [],
		};
		const unreadableProject: Project = {
			...createProject('app'),
			status: 'unreadable',
		};
		const loadedProject: Project = {
			...createProject('api'),
			children: [unreadableFolder],
		};
		const restored = deserializeGraphFromWebview(
			serializeGraphForWebview(createGraph(unreadableProject, loadedProject)),
		);
		const restoredUnreadableProject = restored.rootNodes[unreadableProject.id];
		const restoredLoadedProject = restored.rootNodes[loadedProject.id];

		assert.ok(
			restoredUnreadableProject
				&& restoredUnreadableProject.kind === 'project',
		);
		assert.strictEqual(restoredUnreadableProject.status, 'unreadable');
		assert.ok(restoredLoadedProject && restoredLoadedProject.kind === 'project');
		const restoredFolder = restoredLoadedProject.children[0];
		assert.ok(restoredFolder && restoredFolder.kind === 'folder');
		assert.strictEqual(restoredFolder.status, 'unreadable');
	});

	test('초기 Workspace Graph가 없으면 Mock으로 대체하지 않고 실패한다', () => {
		assert.throws(
			() => deserializeGraphFromWebview(undefined),
			/Missing initial Workspace Graph/,
		);
	});
});

function createProject(name: string): Project {
	return {
		kind: 'project',
		id: `project:${name}`,
		name,
		status: 'loaded',
		children: [],
	};
}

function createGraph(...projects: Project[]): Graph {
	return {
		roots: projects.map(({ id }) => ({
			id: `root:${id}`,
			nodeId: id,
		})),
		rootNodes: Object.fromEntries(projects.map((project) => [project.id, project])),
	};
}
