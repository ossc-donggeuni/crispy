import * as assert from 'assert';
import type {
	AgentTabModel,
	AgentTabModelListener,
	AgentTabModelSnapshot,
} from '../../agent/UI/agentTabModel';
import { createAgentActivityStore } from '../../agent/webview/agentActivityStore';
import { createAgentSessionPresentationCoordinator } from '../../agent/webview/agentSessionPresentationCoordinator';
import {
	AGENT_SESSION_CURRENT_MESSAGE_MAX_CODE_POINTS,
	createAgentSessionPresentationStore,
} from '../../agent/webview/agentSessionPresentationStore';
import { resolveAgentSessionColor } from '../../agent/agentSessionColor';

suite('Agent Session Presentation Store', () => {
	test('수명주기와 고빈도 content 변경을 분리하고 exact session만 갱신한다', () => {
		const store = createAgentSessionPresentationStore();
		const changes: string[] = [];
		store.subscribe(({ kind, sessionId }) => changes.push(`${kind}:${sessionId}`));

		store.startSession('tab-A', 'session-A', 'Codex');
		assert.strictEqual(store.isKnownSession('session-A'), true);
		assert.strictEqual(store.isRunningSession('session-A'), false);

		store.activateSession('tab-A', 'session-A', 'Codex');
		store.updateTitle('session-A', 'Implement bindings');
		store.updateCurrentMessage('tab-other', 'session-A', 'ignored');
		store.updateCurrentMessage('tab-A', 'session-A', '  compiling\nproject  ');
		store.updateCurrentMessage('tab-A', 'session-A', 'compiling project');

		assert.deepStrictEqual(store.getSession('session-A'), {
			tabId: 'tab-A',
			sessionId: 'session-A',
			color: resolveAgentSessionColor('session-A'),
			title: 'Implement bindings',
			currentMessage: 'compiling project',
			state: 'running',
		});
		assert.deepStrictEqual(changes, [
			'lifecycle:session-A',
			'lifecycle:session-A',
			'content:session-A',
			'content:session-A',
		]);

		store.endSession('session-A');
		store.updateCurrentMessage('tab-A', 'session-A', 'late output');
		assert.strictEqual(store.getSession('session-A'), undefined);
		assert.strictEqual(changes.at(-1), 'lifecycle:session-A');
	});

	test('메시지는 Unicode code point 상한만 보관하고 같은 탭의 새 세션이 이전 세션을 대체한다', () => {
		const store = createAgentSessionPresentationStore();
		const longMessage = '한'.repeat(
			AGENT_SESSION_CURRENT_MESSAGE_MAX_CODE_POINTS + 20,
		);

		store.activateSession('tab-A', 'session-old', 'Old');
		store.updateCurrentMessage('tab-A', 'session-old', longMessage);
		assert.strictEqual(
			[...(store.getSession('session-old')?.currentMessage ?? '')].length,
			AGENT_SESSION_CURRENT_MESSAGE_MAX_CODE_POINTS,
		);

		store.startSession('tab-A', 'session-new', 'New');
		assert.strictEqual(store.getSession('session-old'), undefined);
		assert.strictEqual(store.getSessionForTab('tab-A')?.sessionId, 'session-new');
	});
});

suite('Agent Session Presentation Coordinator', () => {
	test('started 세션의 제목을 연결하고 exit 시 모든 Target Activity와 표시 상태를 제거한다', () => {
		const model = new FakeAgentTabModel(createSnapshot('Session title'));
		const presentations = createAgentSessionPresentationStore();
		const activities = createAgentActivityStore();
		const coordinator = createAgentSessionPresentationCoordinator(
			model.asModel(),
			presentations,
			activities,
		);

		coordinator.handleHostMessage({
			type: 'terminal.starting',
			tabId: 'tab-A',
			sessionId: 'session-A',
		});
		activities.setAgentActivity(
			'session-A',
			{ nodeId: 'file:src/a.ts' },
			'editing',
		);
		activities.setAgentActivity(
			'session-A',
			{ nodeId: 'file:src/b.ts' },
			'active',
		);
		model.setSnapshot(createSnapshot('Session title', 'session-A'));
		coordinator.handleHostMessage({
			type: 'terminal.started',
			tabId: 'tab-A',
			sessionId: 'session-A',
		});

		assert.deepStrictEqual(presentations.getSession('session-A'), {
			tabId: 'tab-A',
			sessionId: 'session-A',
			color: resolveAgentSessionColor('session-A'),
			title: 'Session title',
			currentMessage: '',
			state: 'running',
		});

		model.setSnapshot(createSnapshot('Renamed session', 'session-A'));
		assert.strictEqual(
			presentations.getSession('session-A')?.title,
			'Renamed session',
		);

		coordinator.handleHostMessage({
			type: 'terminal.exited',
			tabId: 'tab-A',
			sessionId: 'session-A',
			exitCode: 0,
		});
		assert.deepStrictEqual(activities.getSnapshot(), []);
		assert.strictEqual(presentations.getSession('session-A'), undefined);
		coordinator.dispose();
	});

	test('stale 종료는 새 세션을 해제하지 않고 reset만 current 세션을 정리한다', () => {
		const model = new FakeAgentTabModel(createSnapshot('Current', 'session-new'));
		const presentations = createAgentSessionPresentationStore();
		const activities = createAgentActivityStore();
		const coordinator = createAgentSessionPresentationCoordinator(
			model.asModel(),
			presentations,
			activities,
		);

		coordinator.handleHostMessage({
			type: 'terminal.started',
			tabId: 'tab-A',
			sessionId: 'session-new',
		});
		activities.setAgentActivity(
			'session-new',
			{ nodeId: 'file:src/current.ts' },
			'active',
		);
		coordinator.handleHostMessage({
			type: 'terminal.exited',
			tabId: 'tab-A',
			sessionId: 'session-old',
			exitCode: 9,
		});
		assert.strictEqual(presentations.isRunningSession('session-new'), true);
		coordinator.handleHostMessage({
			type: 'terminal.started',
			tabId: 'tab-A',
			sessionId: 'session-old',
		});
		assert.strictEqual(presentations.isRunningSession('session-new'), true);
		assert.strictEqual(presentations.getSession('session-old'), undefined);

		coordinator.handleHostMessage({
			type: 'terminal.error',
			tabId: 'tab-A',
			sessionId: 'session-old',
			code: 'internal_error',
			message: 'Terminal process operation failed.',
			canRestart: true,
		});
		assert.strictEqual(presentations.isRunningSession('session-new'), true);

		coordinator.handleHostMessage({
			type: 'agent.resetCompleted',
			tabId: 'tab-A',
			assignmentRevision: 2,
		});
		assert.strictEqual(presentations.getSnapshot().length, 0);
		assert.deepStrictEqual(activities.getSnapshot(), []);
		coordinator.dispose();
	});

	test('current terminal.error는 탭 모델이 session을 보존해도 Activity와 표시를 종료한다', () => {
		const model = new FakeAgentTabModel(createSnapshot('Failed session', 'session-A'));
		const presentations = createAgentSessionPresentationStore();
		const activities = createAgentActivityStore();
		const coordinator = createAgentSessionPresentationCoordinator(
			model.asModel(),
			presentations,
			activities,
		);

		coordinator.handleHostMessage({
			type: 'terminal.started',
			tabId: 'tab-A',
			sessionId: 'session-A',
		});
		activities.setAgentActivity(
			'session-A',
			{ nodeId: 'file:src/failure.ts' },
			'editing',
		);
		coordinator.handleHostMessage({
			type: 'terminal.error',
			tabId: 'tab-A',
			sessionId: 'session-A',
			code: 'internal_error',
			message: 'Terminal process operation failed.',
			canRestart: true,
		});

		assert.deepStrictEqual(activities.getSnapshot(), []);
		assert.strictEqual(presentations.getSession('session-A'), undefined);
		coordinator.dispose();
	});
});

function createSnapshot(
	displayName: string,
	sessionId?: string,
): AgentTabModelSnapshot {
	return Object.freeze({
		tabs: Object.freeze([Object.freeze({
			id: 'tab-A',
			displayName,
			label: displayName,
			titleSource: 'manual' as const,
			autoTitleAttempted: true,
			hasStartedSession: sessionId !== undefined,
			isPinned: false,
			...(sessionId === undefined ? {} : { sessionId }),
			mcpStatus: Object.freeze({ kind: 'none' as const }),
			mcpRestartPending: false,
		})]),
		activeTabId: 'tab-A',
	});
}

class FakeAgentTabModel {
	private readonly listeners = new Set<AgentTabModelListener>();

	constructor(private snapshot: AgentTabModelSnapshot) {}

	asModel(): AgentTabModel {
		return {
			getSnapshot: () => this.snapshot,
			subscribe: (listener: AgentTabModelListener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			},
		} as unknown as AgentTabModel;
	}

	setSnapshot(snapshot: AgentTabModelSnapshot): void {
		this.snapshot = snapshot;
		for (const listener of [...this.listeners]) {
			listener(snapshot);
		}
	}
}
