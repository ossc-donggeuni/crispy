import * as assert from 'assert';
import { createAgentActivityStore } from '../../agent/webview/agentActivityStore';
import { createAgentSessionPresentationStore } from '../../agent/webview/agentSessionPresentationStore';
import {
	createAgentActivityNotificationEntries,
	createAgentActivitySessionNotificationKey,
	getAgentActivityNotificationStatusLabel,
	groupAgentActivityNotificationsBySession,
} from '../../webview/graph/agentActivityNotifications';
import {
	GRAPH_MOCK,
	GRAPH_MOCK_FOLDER_ROOT,
} from '../../webview/graph/graphMockData';

suite('Agent Activity Notifications', () => {
	test('모든 Target의 현재 Activity를 전역 수신 sequence 최신순으로 펼친다', () => {
		const store = createAgentActivityStore();
		const presentations = createAgentSessionPresentationStore((sessionId) => (
			sessionId === 'session-A' ? '#123456' : '#abcdef'
		));

		presentations.startSession('tab-A', 'session-A', '첫 번째 Agent');
		presentations.activateSession('tab-A', 'session-A', '첫 번째 Agent');
		presentations.startSession('tab-B', 'session-B', '두 번째 Agent');
		presentations.activateSession('tab-B', 'session-B', '두 번째 Agent');
		presentations.updateCurrentMessage('tab-A', 'session-A', '파일을 편집합니다');
		presentations.updateCurrentMessage('tab-B', 'session-B', '폴더를 분석합니다');

		store.setAgentActivity('session-A', {
			nodeId: 'file:app/src/graphView.ts',
		}, 'editing');
		store.setAgentActivity('session-B', {
			nodeId: 'folder:app/src',
		}, 'active');

		const entries = createAgentActivityNotificationEntries(
			store.getSnapshot(),
			presentations,
			GRAPH_MOCK,
		);

		assert.deepStrictEqual(entries.map((entry) => ({
			sessionId: entry.sessionId,
			nodeId: entry.target.nodeId,
			activity: entry.activity,
			sequence: entry.sequence,
		})), [
			{
				sessionId: 'session-B',
				nodeId: 'folder:app/src',
				activity: 'active',
				sequence: 2,
			},
			{
				sessionId: 'session-A',
				nodeId: 'file:app/src/graphView.ts',
				activity: 'editing',
				sequence: 1,
			},
		]);
		assert.strictEqual(entries[0]?.sessionTitle, '두 번째 Agent');
		assert.strictEqual(entries[0]?.sessionColor, '#abcdef');
		assert.strictEqual(entries[0]?.currentMessage, '폴더를 분석합니다');
		assert.strictEqual(entries[0]?.targetName, 'src');
		assert.strictEqual(entries[0]?.targetPath, 'crispy/app/src');
		assert.strictEqual(entries[1]?.targetPath, 'crispy/app/src/graphView.ts');
		assert.strictEqual(entries[1]?.sessionColor, '#123456');

		presentations.dispose();
	});

	test('같은 Target×Session 상태 전환은 행을 중복하지 않고 최신 위치로 이동한다', () => {
		const store = createAgentActivityStore();
		const presentations = createAgentSessionPresentationStore();

		presentations.startSession('tab-A', 'session-A', 'Agent A');
		presentations.activateSession('tab-A', 'session-A', 'Agent A');
		presentations.startSession('tab-B', 'session-B', 'Agent B');
		presentations.activateSession('tab-B', 'session-B', 'Agent B');
		store.setAgentActivity('session-A', { nodeId: 'folder:app/src' }, 'planned');
		store.setAgentActivity('session-B', { nodeId: 'folder:app/docs' }, 'active');
		const firstKey = createAgentActivityNotificationEntries(
			store.getSnapshot(),
			presentations,
			GRAPH_MOCK,
		).find(({ sessionId }) => sessionId === 'session-A')?.key;

		store.setAgentActivity('session-A', { nodeId: 'folder:app/src' }, 'editing');
		const entries = createAgentActivityNotificationEntries(
			store.getSnapshot(),
			presentations,
			GRAPH_MOCK,
		);

		assert.strictEqual(entries.length, 2);
		assert.strictEqual(entries[0]?.sessionId, 'session-A');
		assert.strictEqual(entries[0]?.activity, 'editing');
		assert.strictEqual(entries[0]?.sequence, 3);
		assert.strictEqual(entries[0]?.key, firstKey);

		presentations.dispose();
	});

	test('선택한 Session의 여러 Target 완료 이벤트를 안정적인 알림 하나로 합친다', () => {
		const store = createAgentActivityStore();
		const presentations = createAgentSessionPresentationStore();

		presentations.activateSession('task-tab', 'task-session', 'Task');
		store.setAgentActivity(
			'task-session',
			{ nodeId: 'folder:app/src' },
			'completed',
		);
		store.setAgentActivity(
			'task-session',
			{ nodeId: 'folder:app/docs' },
			'completed',
		);
		store.setAgentActivity(
			'task-session',
			{ nodeId: 'file:app/package.json' },
			'completed',
		);
		const grouped = groupAgentActivityNotificationsBySession(
			createAgentActivityNotificationEntries(
				store.getSnapshot(),
				presentations,
				GRAPH_MOCK,
			),
			({ sessionId }) => sessionId === 'task-session',
		);

		assert.strictEqual(grouped.length, 1);
		assert.strictEqual(
			grouped[0]?.key,
			createAgentActivitySessionNotificationKey('task-session'),
		);
		assert.strictEqual(grouped[0]?.dismissalScope, 'session');
		assert.strictEqual(grouped[0]?.groupedTargetCount, 3);
		assert.strictEqual(grouped[0]?.sequence, 1);
		assert.strictEqual(grouped[0]?.target.nodeId, 'folder:app/src');
		presentations.dispose();
	});

	test('동일 Source가 여러 Root에 있으면 명시된 Root context 경로를 사용한다', () => {
		const store = createAgentActivityStore();
		const presentations = createAgentSessionPresentationStore();
		const sharedFile = {
			kind: 'file' as const,
			id: 'file:shared.ts',
			name: 'shared.ts',
		};
		const graph = {
			roots: [
				{
					id: 'root:first',
					nodeId: sharedFile.id,
					context: { relativePath: 'workspace/first/' },
				},
				{
					id: 'root:second',
					nodeId: sharedFile.id,
					context: { relativePath: 'workspace/second/' },
				},
			],
			rootNodes: { [sharedFile.id]: sharedFile },
		};

		presentations.activateSession('tab-exact', 'session-exact', 'Exact');
		store.setAgentActivity('session-exact', {
			nodeId: sharedFile.id,
			rootId: 'root:second',
		}, 'active');
		const [entry] = createAgentActivityNotificationEntries(
			store.getSnapshot(),
			presentations,
			graph,
		);

		assert.strictEqual(entry?.targetPath, 'workspace/second/shared.ts');
		presentations.dispose();
	});

	test('running 세션만 표시하고 unavailable Target에서 내부 ID를 노출하지 않는다', () => {
		const store = createAgentActivityStore();
		const presentations = createAgentSessionPresentationStore();

		presentations.startSession('tab-starting', 'session-starting', 'Starting');
		presentations.startSession('tab-running', 'session-running', 'Running');
		presentations.activateSession('tab-running', 'session-running', 'Running');
		store.setAgentActivity(
			'session-starting',
			{ nodeId: 'file:missing/starting.ts' },
			'planned',
		);
		store.setAgentActivity(
			'session-running',
			{ nodeId: 'file:missing/running.ts' },
			'editing',
		);

		const entries = createAgentActivityNotificationEntries(
			store.getSnapshot(),
			presentations,
			GRAPH_MOCK,
		);

		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0]?.targetKind, 'unavailable');
		assert.strictEqual(entries[0]?.targetName, 'Unavailable graph target');
		assert.strictEqual(
			entries[0]?.targetPath.includes('file:missing/running.ts'),
			false,
		);

		presentations.dispose();
	});

	test('Graph snapshot에 아직 없어도 Workspace Root 안의 URI는 pending 경로로 표시한다', () => {
		const store = createAgentActivityStore();
		const presentations = createAgentSessionPresentationStore();
		const project = {
			kind: 'project' as const,
			id: 'workspace-root:file:///workspace',
			name: 'workspace',
			status: 'loaded' as const,
			children: [],
		};
		const graph = {
			roots: [{ id: `root:${project.id}`, nodeId: project.id }],
			rootNodes: { [project.id]: project },
		};

		presentations.activateSession('tab-pending', 'session-pending', 'Pending');
		store.setAgentActivity('session-pending', {
			nodeId: 'file:file:///workspace/src/new%20file.ts',
		}, 'editing');
		const [entry] = createAgentActivityNotificationEntries(
			store.getSnapshot(),
			presentations,
			graph,
		);

		assert.strictEqual(entry?.availability, 'pending');
		assert.strictEqual(entry?.targetKind, 'file');
		assert.strictEqual(entry?.targetName, 'new file.ts');
		assert.strictEqual(entry?.targetPath, 'workspace/src/new file.ts');
		assert.strictEqual(
			entry?.targetPath.includes('The target could not be found in the Workspace.'),
			false,
		);
		presentations.dispose();
	});

	test('Workspace Root URI 범위 밖 Target만 unavailable로 표시한다', () => {
		const store = createAgentActivityStore();
		const presentations = createAgentSessionPresentationStore();
		const project = {
			kind: 'project' as const,
			id: 'workspace-root:file:///workspace',
			name: 'workspace',
			status: 'loaded' as const,
			children: [],
		};
		const graph = {
			roots: [{ id: `root:${project.id}`, nodeId: project.id }],
			rootNodes: { [project.id]: project },
		};

		presentations.activateSession('tab-outside', 'session-outside', 'Outside');
		store.setAgentActivity('session-outside', {
			nodeId: 'file:file:///workspace-sibling/private.ts',
		}, 'active');
		const [entry] = createAgentActivityNotificationEntries(
			store.getSnapshot(),
			presentations,
			graph,
		);

		assert.strictEqual(entry?.availability, 'outside');
		assert.strictEqual(entry?.targetKind, 'unavailable');
		assert.strictEqual(
			entry?.targetPath,
			'The target could not be found in the Workspace.',
		);
		assert.strictEqual(entry?.targetPath.includes('private.ts'), false);
		presentations.dispose();
	});

	test('독립 Graph Root context를 포함한 사용자 경로와 상태명을 만든다', () => {
		const store = createAgentActivityStore();
		const presentations = createAgentSessionPresentationStore();

		presentations.startSession('tab-A', 'session-A', 'Agent');
		presentations.activateSession('tab-A', 'session-A', 'Agent');
		store.setAgentActivity(
			'session-A',
			{ nodeId: GRAPH_MOCK_FOLDER_ROOT.id },
			'completed',
		);
		const [entry] = createAgentActivityNotificationEntries(
			store.getSnapshot(),
			presentations,
			GRAPH_MOCK,
		);

		assert.strictEqual(
			entry?.targetPath,
			'crispy/packages/demo/src/multi-root-demo',
		);
		assert.strictEqual(getAgentActivityNotificationStatusLabel('planned'), 'Planned');
		assert.strictEqual(getAgentActivityNotificationStatusLabel('active'), 'Active');
		assert.strictEqual(getAgentActivityNotificationStatusLabel('editing'), 'Editing');
		assert.strictEqual(getAgentActivityNotificationStatusLabel('completed'), 'Completed');
		assert.strictEqual(getAgentActivityNotificationStatusLabel('mentioned'), 'Mentioned');
		assert.strictEqual(getAgentActivityNotificationStatusLabel('rejected'), 'Rejected');

		presentations.dispose();
	});
});
