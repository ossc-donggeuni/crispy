import * as assert from 'assert';
import {
	parseWorkspaceToWebviewMessage,
	type ExtensionToWebviewMessage,
	type WebviewToExtensionMessage,
	type WorkspaceStateChangedMessage,
	type WorkspaceToWebviewMessage,
} from '../messages';
import type { Graph, Project } from '../webview/graph/graphModel';

suite('Extension to Webview Workspace messages', () => {
	test('Workspace Persistent State 전체 snapshot을 Webview에서 Host로 전달한다', () => {
		const workspaceMessage = {
			type: 'workspace.stateChanged',
			state: {
				version: 1,
				nodePositions: { 'folder:file:///workspace/app/src': { x: 10, y: 20 } },
				fileGroupPages: { 'folder:file:///workspace/app/src:files': 2 },
				openedFolders: { 'folder:file:///workspace/app/src': true },
				detachedRootNodeIds: { 'file:file:///workspace/app/index.ts': true },
				hiddenNodeIds: { 'folder:file:///workspace/app/private': true },
			},
		} satisfies WorkspaceStateChangedMessage;
		const webviewMessage: WebviewToExtensionMessage = workspaceMessage;

		assert.strictEqual(webviewMessage.type, 'workspace.stateChanged');
		assert.deepStrictEqual(webviewMessage.state, workspaceMessage.state);
	});

	test('Workspace 도메인 메시지가 기존 Graph 모델로 최상위 Host union에 연결된다', () => {
		const graph = createWorkspaceGraph();
		const workspaceMessage = {
			type: 'workspace.graphUpdated',
			graph,
		} satisfies WorkspaceToWebviewMessage;
		const extensionMessage: ExtensionToWebviewMessage = workspaceMessage;
		const graphPayload: Graph = workspaceMessage.graph;

		assert.strictEqual(extensionMessage.type, 'workspace.graphUpdated');
		assert.strictEqual(graphPayload, graph);
		assert.deepStrictEqual(
			parseWorkspaceToWebviewMessage(extensionMessage),
			workspaceMessage,
		);
	});

	test('잘못된 Workspace 메시지와 Graph를 수신 경계에서 무시한다', () => {
		const graph = createWorkspaceGraph();

		assert.strictEqual(parseWorkspaceToWebviewMessage({
			type: 'workspace.graphUpdated',
			graph,
			unexpected: true,
		}), undefined);
		assert.strictEqual(parseWorkspaceToWebviewMessage({
			type: 'workspace.graphUpdated',
			graph: {
				roots: [{ id: 'root:missing', nodeId: 'project:missing' }],
				rootNodes: {},
			},
		}), undefined);
		assert.strictEqual(parseWorkspaceToWebviewMessage({
			type: 'terminal.started',
			graph,
		}), undefined);
	});
});

function createWorkspaceGraph(): Graph {
	const project: Project = {
		kind: 'project',
		id: 'project:workspace-message',
		name: 'workspace-message',
		status: 'loaded',
		children: [{
			kind: 'file',
			id: 'file:workspace-message/index.ts',
			name: 'index.ts',
		}],
	};

	return {
		roots: [{ id: 'root:workspace-message', nodeId: project.id }],
		rootNodes: { [project.id]: project },
	};
}
