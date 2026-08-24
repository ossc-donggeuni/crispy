import * as assert from 'assert';
import {
	clearAgentActivitiesBySession,
	clearAgentActivity,
	parseAgentActivityEvent,
	parseAgentActivityToWebviewMessage,
	parseGraphNodeEffectToWebviewMessage,
	parseWorkspaceToWebviewMessage,
	setAgentActivity,
	type AgentActivityKind,
	type ExtensionToWebviewMessage,
	type GraphNodeEffectClearMessage,
	type GraphNodeEffectSetMessage,
	type GraphNodeEffectTarget,
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

suite('Agent Activity messages', () => {
	const sessionId = 'session:agent-activity-1';
	const target: GraphNodeEffectTarget = {
		nodeId: 'file:file:///workspace/app/src/index.ts',
		rootId: 'detached:root:1',
	};
	const activityKinds = [
		'planned',
		'active',
		'editing',
		'completed',
		'mentioned',
		'rejected',
	] as const satisfies readonly AgentActivityKind[];

	test('6개 Activity 각각 setAgentActivity 메시지를 생성하고 parsing한다', () => {
		for (const activity of activityKinds) {
			const event = { sessionId, target, activity };
			const message = setAgentActivity(sessionId, target, activity);

			assert.deepStrictEqual(message, {
				type: 'agent.activity.set',
				sessionId,
				target,
				activity,
			});
			assert.deepStrictEqual(parseAgentActivityEvent(event), event);
			assert.deepStrictEqual(
				parseAgentActivityToWebviewMessage(message),
				message,
			);
			const extensionMessage: ExtensionToWebviewMessage = message;
			assert.strictEqual(extensionMessage.type, 'agent.activity.set');
		}
	});

	test('알 수 없는 Activity와 Event 부가 필드를 거부한다', () => {
		for (const event of [
			{ sessionId, target, activity: 'unknown' },
			{ sessionId, target, activity: '' },
			{ sessionId, target, activity: 1 },
			{ sessionId, target, activity: 'active', color: '#fff' },
		]) {
			assert.strictEqual(parseAgentActivityEvent(event), undefined);
			assert.strictEqual(parseAgentActivityToWebviewMessage({
				type: 'agent.activity.set',
				...event,
			}), undefined);
		}
	});

	test('빈 값과 기존 Session ID 규칙을 벗어난 sessionId를 거부한다', () => {
		for (const invalidSessionId of ['', ' invalid', 'a'.repeat(129), 1]) {
			assert.strictEqual(parseAgentActivityEvent({
				sessionId: invalidSessionId,
				target,
				activity: 'planned',
			}), undefined);
			assert.strictEqual(parseAgentActivityToWebviewMessage({
				type: 'agent.activity.clear',
				sessionId: invalidSessionId,
				target,
			}), undefined);
			assert.strictEqual(parseAgentActivityToWebviewMessage({
				type: 'agent.activity.clearSession',
				sessionId: invalidSessionId,
			}), undefined);
		}
	});

	test('G-11 Target parser 기준으로 잘못된 set/clear Target을 거부한다', () => {
		for (const invalidTarget of [
			{},
			{ nodeId: '' },
			{ nodeId: 'folder:src', rootId: '' },
			{ nodeId: 'folder:src', rootId: 1 },
			{ nodeId: 'folder:src', unexpected: true },
		]) {
			assert.strictEqual(parseAgentActivityEvent({
				sessionId,
				target: invalidTarget,
				activity: 'editing',
			}), undefined);
			assert.strictEqual(parseAgentActivityToWebviewMessage({
				type: 'agent.activity.clear',
				sessionId,
				target: invalidTarget,
			}), undefined);
		}
	});

	test('단일 Target Activity clear 계약을 strict하게 검증한다', () => {
		const message = clearAgentActivity(sessionId, target);

		assert.deepStrictEqual(
			parseAgentActivityToWebviewMessage(message),
			message,
		);
		for (const invalidMessage of [
			{ type: 'agent.activity.clear', sessionId },
			{ type: 'agent.activity.clear', target },
			{ type: 'agent.activity.clear', sessionId, target, activity: 'active' },
		]) {
			assert.strictEqual(
				parseAgentActivityToWebviewMessage(invalidMessage),
				undefined,
			);
		}
	});

	test('Session 전체 Activity clear 계약을 strict하게 검증한다', () => {
		const message = clearAgentActivitiesBySession(sessionId);

		assert.deepStrictEqual(
			parseAgentActivityToWebviewMessage(message),
			message,
		);
		for (const invalidMessage of [
			{ type: 'agent.activity.clearSession' },
			{ type: 'agent.activity.clearSession', sessionId, target },
			{ type: 'agent.activity.clearSession', sessionId, activity: 'completed' },
			{ type: 'agent.activity.clearAll', sessionId },
		]) {
			assert.strictEqual(
				parseAgentActivityToWebviewMessage(invalidMessage),
				undefined,
			);
		}
	});

	test('기존 Workspace/Graph Effect 메시지 parser와 허용 범위를 섞지 않는다', () => {
		const effectMessage = {
			type: 'graph.nodeEffect.set',
			target,
			effect: { kind: 'pulse', color: '#43d17a' },
		} satisfies GraphNodeEffectSetMessage;
		const workspaceMessage = {
			type: 'workspace.graphUpdated',
			graph: createWorkspaceGraph(),
		} satisfies WorkspaceToWebviewMessage;

		assert.deepStrictEqual(
			parseGraphNodeEffectToWebviewMessage(effectMessage),
			effectMessage,
		);
		assert.deepStrictEqual(
			parseWorkspaceToWebviewMessage(workspaceMessage),
			workspaceMessage,
		);
		assert.strictEqual(
			parseAgentActivityToWebviewMessage(effectMessage),
			undefined,
		);
		assert.strictEqual(
			parseAgentActivityToWebviewMessage(workspaceMessage),
			undefined,
		);
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
