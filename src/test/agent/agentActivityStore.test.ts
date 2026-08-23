import * as assert from 'assert';
import type {
	AgentActivityKind,
	GraphNodeEffectTarget,
} from '../../messages';
import {
	createAgentActivityStore,
	type AgentActivityStoreSnapshot,
} from '../../agent/webview/agentActivityStore';

const TARGET_X: GraphNodeEffectTarget = { nodeId: 'file:workspace/src/x.ts' };
const TARGET_Y: GraphNodeEffectTarget = { nodeId: 'folder:workspace/src/y' };
const SESSION_A = 'session-A';
const SESSION_B = 'session-B';
const SESSION_C = 'session-C';

suite('Agent Activity Store', () => {
	test('Target의 Session Activity를 현재 snapshot으로 저장한다', () => {
		const store = createAgentActivityStore();

		store.setAgentActivity(SESSION_A, TARGET_X, 'planned');

		assert.deepStrictEqual(store.getActivities(TARGET_X), [{
			sessionId: SESSION_A,
			activity: 'planned',
		}]);
	});

	test('동일 Target과 Session의 Activity를 history 없이 최신 값으로 교체한다', () => {
		const store = createAgentActivityStore();

		store.setAgentActivity(SESSION_A, TARGET_X, 'planned');
		store.setAgentActivity(SESSION_A, TARGET_X, 'active');
		store.setAgentActivity(SESSION_A, TARGET_X, 'editing');

		assert.deepStrictEqual(store.getActivities(TARGET_X), [{
			sessionId: SESSION_A,
			activity: 'editing',
		}]);
	});

	test('동일 Target의 여러 Session을 독립적으로 유지하고 한 Session만 갱신한다', () => {
		const store = createAgentActivityStore();

		store.setAgentActivity(SESSION_A, TARGET_X, 'editing');
		store.setAgentActivity(SESSION_B, TARGET_X, 'planned');
		store.setAgentActivity(SESSION_A, TARGET_X, 'completed');

		assert.deepStrictEqual(store.getActivities(TARGET_X), [
			{ sessionId: SESSION_A, activity: 'completed' },
			{ sessionId: SESSION_B, activity: 'planned' },
		]);
	});

	test('서로 다른 Node와 root occurrence Target을 별도 bucket으로 유지한다', () => {
		const store = createAgentActivityStore();
		const occurrenceTarget: GraphNodeEffectTarget = {
			nodeId: TARGET_X.nodeId,
			rootId: 'detached:root:x',
		};

		store.setAgentActivity(SESSION_A, TARGET_X, 'editing');
		store.setAgentActivity(SESSION_A, TARGET_Y, 'active');
		store.setAgentActivity(SESSION_A, occurrenceTarget, 'mentioned');

		assert.deepStrictEqual(store.getActivities(TARGET_X), [{
			sessionId: SESSION_A,
			activity: 'editing',
		}]);
		assert.deepStrictEqual(store.getActivities(TARGET_Y), [{
			sessionId: SESSION_A,
			activity: 'active',
		}]);
		assert.deepStrictEqual(store.getActivities(occurrenceTarget), [{
			sessionId: SESSION_A,
			activity: 'mentioned',
		}]);
		assert.strictEqual(store.getSnapshot().length, 3);
	});

	test('단일 clear는 같은 Target의 다른 Session과 다른 Target을 보존한다', () => {
		const store = createAgentActivityStore();

		store.setAgentActivity(SESSION_A, TARGET_X, 'editing');
		store.setAgentActivity(SESSION_B, TARGET_X, 'planned');
		store.setAgentActivity(SESSION_A, TARGET_Y, 'active');

		store.clearAgentActivity(SESSION_A, TARGET_X);

		assert.deepStrictEqual(store.getActivities(TARGET_X), [{
			sessionId: SESSION_B,
			activity: 'planned',
		}]);
		assert.deepStrictEqual(store.getActivities(TARGET_Y), [{
			sessionId: SESSION_A,
			activity: 'active',
		}]);
	});

	test('Session 전체 clear는 모든 Target에서 해당 Session만 제거한다', () => {
		const store = createAgentActivityStore();
		const targetZ: GraphNodeEffectTarget = { nodeId: 'file:workspace/src/z.ts' };

		store.setAgentActivity(SESSION_A, TARGET_X, 'editing');
		store.setAgentActivity(SESSION_B, TARGET_X, 'active');
		store.setAgentActivity(SESSION_A, TARGET_Y, 'planned');
		store.setAgentActivity(SESSION_C, TARGET_Y, 'mentioned');
		store.setAgentActivity(SESSION_A, targetZ, 'editing');

		store.clearAgentActivitiesBySession(SESSION_A);

		assert.deepStrictEqual(store.getActivities(TARGET_X), [{
			sessionId: SESSION_B,
			activity: 'active',
		}]);
		assert.deepStrictEqual(store.getActivities(TARGET_Y), [{
			sessionId: SESSION_C,
			activity: 'mentioned',
		}]);
		assert.deepStrictEqual(store.getActivities(targetZ), []);
		assert.strictEqual(store.getSnapshot().length, 2);
	});

	test('마지막 Activity 제거 시 빈 Target entry를 정리한다', () => {
		const store = createAgentActivityStore();

		store.setAgentActivity(SESSION_A, TARGET_X, 'rejected');
		store.clearAgentActivity(SESSION_A, TARGET_X);

		assert.deepStrictEqual(store.getSnapshot(), []);

		store.setAgentActivity(SESSION_A, TARGET_Y, 'mentioned');
		store.clearAgentActivitiesBySession(SESSION_A);

		assert.deepStrictEqual(store.getSnapshot(), []);
	});

	test('실제 변경만 immutable snapshot으로 통지하고 구독 해제를 지원한다', () => {
		const store = createAgentActivityStore();
		const snapshots: AgentActivityStoreSnapshot[] = [];
		const unsubscribe = store.subscribe((snapshot) => snapshots.push(snapshot));

		store.setAgentActivity(SESSION_A, TARGET_X, 'planned');
		store.setAgentActivity(SESSION_A, TARGET_X, 'planned');
		store.clearAgentActivity(SESSION_B, TARGET_X);
		store.clearAgentActivitiesBySession(SESSION_B);

		assert.strictEqual(snapshots.length, 1);
		assert.strictEqual(Object.isFrozen(snapshots[0]), true);
		assert.strictEqual(Object.isFrozen(snapshots[0][0]), true);
		assert.strictEqual(Object.isFrozen(snapshots[0][0].target), true);
		assert.strictEqual(Object.isFrozen(snapshots[0][0].activities), true);
		assert.strictEqual(Object.isFrozen(snapshots[0][0].activities[0]), true);

		const activities = store.getActivities(TARGET_X);
		assert.throws(() => {
			(activities as Array<{
				sessionId: string;
				activity: AgentActivityKind;
			}>).push({ sessionId: SESSION_B, activity: 'active' });
		});
		assert.deepStrictEqual(store.getActivities(TARGET_X), [{
			sessionId: SESSION_A,
			activity: 'planned',
		}]);

		store.setAgentActivity(SESSION_A, TARGET_X, 'editing');
		assert.strictEqual(snapshots.length, 2);

		unsubscribe();
		store.clearAgentActivity(SESSION_A, TARGET_X);
		assert.strictEqual(snapshots.length, 2);
	});
});
