import * as assert from 'assert';
import {
	parseGraphNodeEffectToWebviewMessage,
	parseWorkspaceToWebviewMessage,
	type ExtensionToWebviewMessage,
	type GraphNodeEffectClearMessage,
	type GraphNodeEffectSetMessage,
	type TaskJsonCopyMessage,
	type WebviewToExtensionMessage,
	type WorkspaceOpenFileMessage,
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

	test('File Open 요청은 File ID만 포함해 Host union에 연결된다', () => {
		const workspaceMessage = {
			type: 'workspace.openFile',
			fileId: 'file:file:///workspace/app/src/index.ts',
		} satisfies WorkspaceOpenFileMessage;
		const webviewMessage: WebviewToExtensionMessage = workspaceMessage;

		assert.deepStrictEqual(webviewMessage, workspaceMessage);
	});

	test('Task JSON clipboard 요청은 전송 JSON만 Host union에 연결된다', () => {
		const copyMessage = {
			type: 'task.copyJson',
			json: '{"format":"crispy.task","version":1}',
		} satisfies TaskJsonCopyMessage;
		const webviewMessage: WebviewToExtensionMessage = copyMessage;

		assert.deepStrictEqual(webviewMessage, copyMessage);
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

	test('Graph Node Effect set/clear를 최상위 Host union과 수신 경계에 연결한다', () => {
		const setMessage = {
			type: 'graph.nodeEffect.set',
			target: {
				nodeId: 'file:file:///workspace/app/src/index.ts',
				rootId: 'detached:root:1',
			},
			effect: { kind: 'icon', color: '#43d17a', icon: 'check' },
		} satisfies GraphNodeEffectSetMessage;
		const clearMessage = {
			type: 'graph.nodeEffect.clear',
			target: { nodeId: 'file:file:///workspace/app/src/index.ts' },
			kind: 'icon',
		} satisfies GraphNodeEffectClearMessage;
		const extensionMessages: ExtensionToWebviewMessage[] = [
			setMessage,
			clearMessage,
		];

		assert.deepStrictEqual(
			parseGraphNodeEffectToWebviewMessage(extensionMessages[0]),
			setMessage,
		);
		assert.deepStrictEqual(
			parseGraphNodeEffectToWebviewMessage(extensionMessages[1]),
			clearMessage,
		);
		assert.deepStrictEqual(parseGraphNodeEffectToWebviewMessage({
			type: 'graph.nodeEffect.clear',
			target: { nodeId: 'folder:src' },
		}), {
			type: 'graph.nodeEffect.clear',
			target: { nodeId: 'folder:src' },
		});
	});

	test('잘못된 Effect kind, icon, target 및 부가 필드를 조용히 거부한다', () => {
		for (const message of [
			{
				type: 'graph.nodeEffect.set',
				target: { nodeId: 'folder:src' },
				effect: { kind: 'editing', color: '#fff' },
			},
			{
				type: 'graph.nodeEffect.set',
				target: { nodeId: 'folder:src' },
				effect: { kind: 'icon', color: '#fff', icon: 'unknown' },
			},
			{
				type: 'graph.nodeEffect.set',
				target: { nodeId: '', rootId: 1 },
				effect: { kind: 'pulse', color: '#fff' },
			},
			{
				type: 'graph.nodeEffect.clear',
				target: { nodeId: 'folder:src' },
				kind: 'pulse',
				unexpected: true,
			},
		]) {
			assert.strictEqual(
				parseGraphNodeEffectToWebviewMessage(message),
				undefined,
			);
		}
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
