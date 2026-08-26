import * as assert from 'assert';
import {
	clearAgentActivitiesBySession,
	clearAgentActivity,
	parseAgentActivityClearAppliedReceipt,
	parseAgentActivityEvent,
	parseAgentActivityTrackedClearMessage,
	parseAgentActivityToWebviewMessage,
	parseGraphNodeEffectToWebviewMessage,
	parseWorkspaceGitStatusUpdatedMessage,
	parseWorkspaceNodeDetailsResultMessage,
	parseWorkspaceNodeRequestMessage,
	parseWorkspaceToWebviewMessage,
	setAgentActivity,
	type AgentActivityClearAppliedReceipt,
	type AgentActivityKind,
	type AgentActivityTrackedClearMessage,
	type ExtensionToWebviewMessage,
	type GraphNodeEffectClearMessage,
	type GraphNodeEffectSetMessage,
	type GraphNodeEffectTarget,
	type TaskJsonCopyFailedMessage,
	type TaskJsonCopyMessage,
	type WebviewToExtensionMessage,
	type WorkspaceOpenFileMessage,
	type WorkspaceNodeRenameRequestMessage,
	type WorkspaceStateChangedMessage,
	type WorkspaceToWebviewMessage,
} from '../messages';
import type { Graph, Project } from '../webview/graph/graphModel';
import { createDefaultTaskBlueprint } from '../task';
import {
	createDefaultWorkspacePersistentState,
	WORKSPACE_PERSISTENT_STATE_VERSION,
} from '../workspace/workspaceMetadata';

suite('Extension to Webview Workspace messages', () => {
	test('Workspace Persistent State 전체 snapshot을 Webview에서 Host로 전달한다', () => {
		let sequence = 0;
		const task = createDefaultTaskBlueprint(
			{ title: 'Persisted Task' },
			() => `message-task-${++sequence}`,
		);
		const workspaceMessage = {
			type: 'workspace.stateChanged',
			contextGeneration: 3,
			rootIds: ['workspace-root:file:///workspace/app'],
			state: {
				version: WORKSPACE_PERSISTENT_STATE_VERSION,
				nodePositions: { 'folder:file:///workspace/app/src': { x: 10, y: 20 } },
				fileGroupPages: { 'folder:file:///workspace/app/src:files': 2 },
				openedFolders: { 'folder:file:///workspace/app/src': true },
				detachedRootNodeIds: { 'file:file:///workspace/app/index.ts': true },
				hiddenNodeIds: { 'folder:file:///workspace/app/private': true },
				tasks: [{
					ownerRootId: 'workspace-root:file:///workspace/app',
					storageRevision: 1,
					task,
					targetOrigins: [],
				}],
				taskRelocations: [],
				taskStorageReceipts: [],
			},
		} satisfies WorkspaceStateChangedMessage;
		const webviewMessage: WebviewToExtensionMessage = workspaceMessage;

		assert.strictEqual(webviewMessage.type, 'workspace.stateChanged');
		assert.deepStrictEqual(webviewMessage.state, workspaceMessage.state);
		assert.strictEqual(webviewMessage.state.tasks[0]?.task.title, 'Persisted Task');
	});

	test('File Open 요청은 File ID만 포함해 Host union에 연결된다', () => {
		const workspaceMessage = {
			type: 'workspace.openFile',
			fileId: 'file:file:///workspace/app/src/index.ts',
		} satisfies WorkspaceOpenFileMessage;
		const webviewMessage: WebviewToExtensionMessage = workspaceMessage;

		assert.deepStrictEqual(webviewMessage, workspaceMessage);
	});

	test('Node rename 요청은 같은 mutation에 적용할 최신 Workspace snapshot을 포함한다', () => {
		const request = {
			type: 'workspace.nodeRename.request',
			requestId: 9,
			nodeId: 'folder:file:///workspace/app/old',
			kind: 'folder',
			newName: 'new',
			workspaceRevision: 3,
			state: {
				...createDefaultWorkspacePersistentState(),
				nodePositions: {
					'file:file:///workspace/app/old/index.ts': { x: 120, y: 240 },
				},
			},
		} satisfies WorkspaceNodeRenameRequestMessage;

		assert.deepStrictEqual(parseWorkspaceNodeRequestMessage(request), request);
		assert.strictEqual(parseWorkspaceNodeRequestMessage({
			...request,
			state: undefined,
		}), undefined);
		assert.strictEqual(parseWorkspaceNodeRequestMessage({
			...request,
			state: { ...request.state, nodePositions: { broken: { x: NaN, y: 0 } } },
		}), undefined);
	});

	test('Task JSON clipboard 요청은 전송 JSON만 Host union에 연결된다', () => {
		const copyMessage = {
			type: 'task.copyJson',
			json: '{"format":"crispy.task","version":1}',
		} satisfies TaskJsonCopyMessage;
		const webviewMessage: WebviewToExtensionMessage = copyMessage;

		assert.deepStrictEqual(webviewMessage, copyMessage);
	});

	test('Task JSON 생성 실패는 allowlist reason만 Host union에 연결한다', () => {
		const failureMessage = {
			type: 'task.copyJsonFailed',
			reason: 'transfer_limit',
		} satisfies TaskJsonCopyFailedMessage;
		const webviewMessage: WebviewToExtensionMessage = failureMessage;

		assert.deepStrictEqual(webviewMessage, failureMessage);
	});

	test('Workspace 도메인 메시지가 atomic Presentation으로 최상위 Host union에 연결된다', () => {
		const graph = createWorkspaceGraph();
		const rootCatalog = [{
			id: 'workspace-root:file:///workspace/app' as const,
			name: 'app',
			description: 'file:///workspace/app',
			selectable: true as const,
		}];
		const workspaceMessage = {
			type: 'workspace.snapshotUpdated',
			presentation: { graph, rootCatalog },
			contextGeneration: 3,
			rootIds: rootCatalog.map(({ id }) => id),
		} satisfies WorkspaceToWebviewMessage;
		const extensionMessage: ExtensionToWebviewMessage = workspaceMessage;
		const graphPayload: Graph = workspaceMessage.presentation.graph;

		assert.strictEqual(extensionMessage.type, 'workspace.snapshotUpdated');
		assert.strictEqual(graphPayload, graph);
		assert.deepStrictEqual(
			parseWorkspaceToWebviewMessage(extensionMessage),
			workspaceMessage,
		);
	});

	test('Git runtime snapshot은 direct file과 ancestor ID만 strict하게 허용한다', () => {
		const message = {
			type: 'workspace.gitStatusUpdated',
			contextGeneration: 3,
			rootIds: ['workspace-root:file:///workspace/app'],
			gitRevision: 7,
			entries: [
				{
					status: 'modified',
					nodeId: 'file:file:///workspace/app/index.ts',
					ancestorNodeIds: ['workspace-root:file:///workspace/app'],
				},
				{
					status: 'deleted',
					ancestorNodeIds: [
						'folder:file:///workspace/app/src',
						'workspace-root:file:///workspace/app',
					],
				},
			],
		} as const;

		assert.deepStrictEqual(
			parseWorkspaceGitStatusUpdatedMessage(message),
			message,
		);
		assert.strictEqual(parseWorkspaceGitStatusUpdatedMessage({
			...message,
			entries: [{
				status: 'staged',
				nodeId: 'file:file:///workspace/app/index.ts',
				ancestorNodeIds: [],
			}],
		}), undefined);
		assert.strictEqual(parseWorkspaceGitStatusUpdatedMessage({
			...message,
			extra: true,
		}), undefined);
	});

	test('file 상세 preview는 제한된 HEAD originalText만 허용한다', () => {
		const message = {
			type: 'workspace.nodeDetails.result',
			requestId: 1,
			workspaceRevision: 2,
			status: 'success',
			details: {
				nodeId: 'file:file:///workspace/app/index.ts',
				kind: 'file',
				name: 'index.ts',
				relativePath: 'index.ts',
				readonly: false,
				canMutate: true,
				preview: {
					status: 'ready',
					text: 'const value = 2;\n',
					languageId: 'typescript',
					originalText: 'const value = 1;\n',
				},
			},
		} as const;

		assert.deepStrictEqual(parseWorkspaceNodeDetailsResultMessage(message), message);
		assert.strictEqual(parseWorkspaceNodeDetailsResultMessage({
			...message,
			details: {
				...message.details,
				preview: {
					...message.details.preview,
					originalText: 42,
				},
			},
		}), undefined);
	});

	test('잘못된 Workspace 메시지와 Graph를 수신 경계에서 무시한다', () => {
		const graph = createWorkspaceGraph();
		const rootIds = ['workspace-root:file:///workspace/app'] as const;
		const rootCatalog = [{
			id: rootIds[0],
			name: 'app',
			description: 'file:///workspace/app',
			selectable: true as const,
		}];

		assert.strictEqual(parseWorkspaceToWebviewMessage({
			type: 'workspace.snapshotUpdated',
			presentation: { graph, rootCatalog },
			contextGeneration: 3,
			rootIds,
			unexpected: true,
		}), undefined);
		assert.strictEqual(parseWorkspaceToWebviewMessage({
			type: 'workspace.snapshotUpdated',
			presentation: {
				graph: {
					roots: [{ id: 'root:missing', nodeId: 'project:missing' }],
					rootNodes: {},
				},
				rootCatalog: [],
			},
			contextGeneration: 3,
			rootIds: [],
		}), undefined);
		assert.strictEqual(parseWorkspaceToWebviewMessage({
			type: 'workspace.snapshotUpdated',
			presentation: {
				graph,
				rootCatalog: [{
					id: 'workspace-root:',
					name: 'invalid',
					description: 'invalid',
					selectable: true,
				}],
			},
			contextGeneration: 3,
			rootIds,
		}), undefined);
		assert.strictEqual(parseWorkspaceToWebviewMessage({
			type: 'workspace.snapshotUpdated',
			presentation: { graph, rootCatalog },
			contextGeneration: 3,
			rootIds: ['workspace-root:file:///workspace/other'],
		}), undefined);
		assert.strictEqual(parseWorkspaceToWebviewMessage({
			type: 'workspace.snapshotUpdated',
			presentation: { graph, rootCatalog },
			contextGeneration: -1,
			rootIds,
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

	test('tracked target/session clear와 applied receipt를 양방향 union에 연결한다', () => {
		const trackedTargetClear = {
			type: 'agent.activity.clearTracked',
			receiptId: 0,
			publicMessage: clearAgentActivity(sessionId, target),
		} satisfies AgentActivityTrackedClearMessage;
		const trackedSessionClear = {
			type: 'agent.activity.clearTracked',
			receiptId: Number.MAX_SAFE_INTEGER,
			publicMessage: clearAgentActivitiesBySession(sessionId),
		} satisfies AgentActivityTrackedClearMessage;
		const extensionMessages: ExtensionToWebviewMessage[] = [
			trackedTargetClear,
			trackedSessionClear,
		];

		assert.deepStrictEqual(
			parseAgentActivityTrackedClearMessage(extensionMessages[0]),
			trackedTargetClear,
		);
		assert.deepStrictEqual(
			parseAgentActivityTrackedClearMessage(extensionMessages[1]),
			trackedSessionClear,
		);

		const receipts = [
			{ type: 'agent.activity.clearApplied', receiptId: 0 },
			{
				type: 'agent.activity.clearApplied',
				receiptId: Number.MAX_SAFE_INTEGER,
			},
		] satisfies readonly AgentActivityClearAppliedReceipt[];
		const webviewMessages: WebviewToExtensionMessage[] = [...receipts];

		assert.deepStrictEqual(
			parseAgentActivityClearAppliedReceipt(webviewMessages[0]),
			receipts[0],
		);
		assert.deepStrictEqual(
			parseAgentActivityClearAppliedReceipt(webviewMessages[1]),
			receipts[1],
		);
	});

	test('tracked clear parser는 nested public parser를 재사용하고 nested set을 거부한다', () => {
		assert.strictEqual(parseAgentActivityTrackedClearMessage({
			type: 'agent.activity.clearTracked',
			receiptId: 1,
			publicMessage: setAgentActivity(sessionId, target, 'active'),
		}), undefined);
		assert.strictEqual(parseAgentActivityTrackedClearMessage({
			type: 'agent.activity.clearTracked',
			receiptId: 1,
			publicMessage: {
				type: 'agent.activity.clear',
				sessionId,
				target,
				activity: 'active',
			},
		}), undefined);
	});

	test('tracked clear와 receipt는 nonnegative safe integer와 exact own key만 허용한다', () => {
		for (const receiptId of [
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
			'1',
		]) {
			assert.strictEqual(parseAgentActivityTrackedClearMessage({
				type: 'agent.activity.clearTracked',
				receiptId,
				publicMessage: clearAgentActivity(sessionId, target),
			}), undefined);
			assert.strictEqual(parseAgentActivityClearAppliedReceipt({
				type: 'agent.activity.clearApplied',
				receiptId,
			}), undefined);
		}

		const trackedWithHiddenKey = {
			type: 'agent.activity.clearTracked',
			receiptId: 1,
			publicMessage: clearAgentActivity(sessionId, target),
		};
		Object.defineProperty(trackedWithHiddenKey, 'hidden', {
			value: true,
			enumerable: false,
		});
		assert.strictEqual(
			parseAgentActivityTrackedClearMessage(trackedWithHiddenKey),
			undefined,
		);

		const nestedClearWithHiddenKey = clearAgentActivity(
			sessionId,
			target,
		) as unknown as Record<string, unknown>;
		Object.defineProperty(nestedClearWithHiddenKey, 'hidden', {
			value: true,
			enumerable: false,
		});
		assert.deepStrictEqual(
			parseAgentActivityToWebviewMessage(nestedClearWithHiddenKey),
			clearAgentActivity(sessionId, target),
		);
		assert.strictEqual(parseAgentActivityTrackedClearMessage({
			type: 'agent.activity.clearTracked',
			receiptId: 1,
			publicMessage: nestedClearWithHiddenKey,
		}), undefined);

		const receiptWithHiddenKey = {
			type: 'agent.activity.clearApplied',
			receiptId: 1,
		};
		Object.defineProperty(receiptWithHiddenKey, 'hidden', {
			value: true,
			enumerable: false,
		});
		assert.strictEqual(
			parseAgentActivityClearAppliedReceipt(receiptWithHiddenKey),
			undefined,
		);
	});

	test('기존 Workspace/Graph Effect 메시지 parser와 허용 범위를 섞지 않는다', () => {
		const effectMessage = {
			type: 'graph.nodeEffect.set',
			target,
			effect: { kind: 'pulse', color: '#43d17a' },
		} satisfies GraphNodeEffectSetMessage;
		const workspaceMessage = {
			type: 'workspace.snapshotUpdated',
			presentation: {
				graph: createWorkspaceGraph(),
				rootCatalog: [{
					id: 'workspace-root:file:///workspace/app',
					name: 'app',
					description: 'file:///workspace/app',
					selectable: true,
				}],
			},
			contextGeneration: 2,
			rootIds: ['workspace-root:file:///workspace/app'],
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
		id: 'workspace-root:file:///workspace/app',
		name: 'workspace-message',
		status: 'loaded',
		children: [{
			kind: 'file',
			id: 'file:workspace-message/index.ts',
			name: 'index.ts',
		}],
	};

	return {
		roots: [{ id: `root:${project.id}`, nodeId: project.id }],
		rootNodes: { [project.id]: project },
	};
}
