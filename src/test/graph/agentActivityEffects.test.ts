import * as assert from 'assert';
import type {
	AgentActivityKind,
	GraphNodeEffect,
	GraphNodeEffectKind,
	GraphNodeEffectTarget,
} from '../../messages';
import {
	createAgentActivityStore,
	type AgentActivityStore,
} from '../../agent/webview/agentActivityStore';
import { createAgentSessionPresentationStore } from '../../agent/webview/agentSessionPresentationStore';
import { createAgentActivityEffectReconciler } from '../../webview/graph/agentActivityEffects';
import {
	getAgentActivityEffects,
	resolveAgentActivityColor,
} from '../../webview/graph/agentActivityPresentation';
import type {
	GraphNodeEffectOwner,
	GraphNodeEffectRecipeOptions,
} from '../../webview/graph/graphNodeEffects';

const TARGET_X: GraphNodeEffectTarget = { nodeId: 'file:workspace/src/x.ts' };
const TARGET_Y: GraphNodeEffectTarget = { nodeId: 'folder:workspace/src/y' };
const ACTIVITY_COLOR = 'var(--graph-viewport-accent-color, #007acc)';
const SUCCESS_COLOR =
	'var(--vscode-testing-iconPassed, var(--vscode-charts-green, #73c991))';
const ERROR_COLOR = 'var(--vscode-errorForeground, #f14c4c)';

suite('Representative Agent Activity Effects', () => {
	test('running presentation이 있는 Session만 대표 Effect 후보로 사용한다', () => {
		const store = createAgentActivityStore();
		const presentations = createAgentSessionPresentationStore();
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(
			store,
			effectOwner,
			presentations,
		);

		store.setAgentActivity('session-A', TARGET_X, 'editing');
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), []);

		presentations.startSession('tab-A', 'session-A', 'Agent A');
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), []);
		presentations.activateSession('tab-A', 'session-A', 'Agent A');
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), [
			{ kind: 'pulse', color: ACTIVITY_COLOR },
		]);

		presentations.updateCurrentMessage('tab-A', 'session-A', 'working');
		assert.strictEqual(effectOwner.setCalls.length, 1);
		presentations.endSession('session-A');
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), []);
		reconciler.dispose();
	});

	test('6개 Activity를 각각 지정된 G-11 Effect 조합으로 변환한다', () => {
		const mappings: ReadonlyArray<readonly [
			AgentActivityKind,
			readonly GraphNodeEffect[],
		]> = [
			['planned', [
				{ kind: 'marching-dash', color: ACTIVITY_COLOR },
				{ kind: 'icon', icon: 'alert', color: ACTIVITY_COLOR },
			]],
			['active', [{ kind: 'shimmer', color: ACTIVITY_COLOR }]],
			['editing', [{ kind: 'pulse', color: ACTIVITY_COLOR }]],
			['completed', [
				{ kind: 'outline', color: SUCCESS_COLOR },
				{ kind: 'icon', icon: 'check', color: SUCCESS_COLOR },
			]],
			['mentioned', [{ kind: 'outline-strong', color: ACTIVITY_COLOR }]],
			['rejected', [
				{ kind: 'outline', color: ERROR_COLOR },
				{ kind: 'icon', icon: 'cancel', color: ERROR_COLOR },
			]],
		];
		const store = createAgentActivityStore();
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(store, effectOwner);

		for (const [activity, expectedEffects] of mappings) {
			store.setAgentActivity('session-A', TARGET_X, activity);

			assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), expectedEffects);
		}

		reconciler.dispose();
	});

	test('debug-g12 Session은 안정적이고 서로 구분되는 presentation 색을 사용한다', () => {
		const sessionIds = [
			'debug-g12-planned',
			'debug-g12-active',
			'debug-g12-editing',
			'debug-g12-completed',
			'debug-g12-mentioned',
			'debug-g12-rejected',
		] as const;
		const colors = sessionIds.map((sessionId) => (
			resolveAgentActivityColor(sessionId, 'editing')
		));

		assert.strictEqual(new Set(colors).size, sessionIds.length);
		assert.strictEqual(
			resolveAgentActivityColor('debug-g12-editing', 'editing'),
			resolveAgentActivityColor('debug-g12-editing', 'editing'),
		);
	});

	test('production Session은 기존 semantic color 정책을 유지한다', () => {
		assert.deepStrictEqual(getAgentActivityEffects('session-A', 'active'), [
			{ kind: 'shimmer', color: ACTIVITY_COLOR },
		]);
		assert.deepStrictEqual(getAgentActivityEffects('session-A', 'completed'), [
			{ kind: 'outline', color: SUCCESS_COLOR },
			{ kind: 'icon', icon: 'check', color: SUCCESS_COLOR },
		]);
		assert.deepStrictEqual(getAgentActivityEffects('session-A', 'rejected'), [
			{ kind: 'outline', color: ERROR_COLOR },
			{ kind: 'icon', icon: 'cancel', color: ERROR_COLOR },
		]);
	});

	test('G-12.3 ordered 조회의 첫 Activity만 대표 Effect로 사용한다', () => {
		const store = createAgentActivityStore();
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(store, effectOwner);

		store.setAgentActivity('session-A', TARGET_X, 'planned');
		store.setAgentActivity('session-B', TARGET_X, 'editing');
		store.setAgentActivity('session-C', TARGET_X, 'active');

		assert.deepStrictEqual(
			store.getActivities(TARGET_X).map(({ activity }) => activity),
			['editing', 'active', 'planned'],
		);
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), [
			{ kind: 'pulse', color: ACTIVITY_COLOR },
		]);
		assert.strictEqual(effectOwner.setCalls.length, 3);

		reconciler.dispose();
	});

	test('reconcile은 subscriber snapshot만 사용하고 Target Activity를 재조회하지 않는다', () => {
		const sourceStore = createAgentActivityStore();
		let getActivitiesCallCount = 0;
		const store: AgentActivityStore = {
			...sourceStore,
			getActivities(target) {
				getActivitiesCallCount += 1;
				return sourceStore.getActivities(target);
			},
		};
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(store, effectOwner);

		store.setAgentActivity('session-A', TARGET_X, 'editing');

		assert.strictEqual(getActivitiesCallCount, 0);
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), [
			{ kind: 'pulse', color: ACTIVITY_COLOR },
		]);

		reconciler.dispose();
	});

	test('대표 Activity 제거 시 다음 ordered Activity Effect로 교체한다', () => {
		const store = createAgentActivityStore();
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(store, effectOwner);

		store.setAgentActivity('session-A', TARGET_X, 'editing');
		store.setAgentActivity('session-B', TARGET_X, 'planned');
		store.clearAgentActivity('session-A', TARGET_X);

		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), [
			{ kind: 'marching-dash', color: ACTIVITY_COLOR },
			{ kind: 'icon', icon: 'alert', color: ACTIVITY_COLOR },
		]);
		assert.strictEqual(effectOwner.replaceCalls.length, 2);

		reconciler.dispose();
	});

	test('대표 Activity가 같으면 Effect를 제거하거나 다시 생성하지 않는다', () => {
		const store = createAgentActivityStore();
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(store, effectOwner);

		store.setAgentActivity('session-A', TARGET_X, 'editing');
		store.setAgentActivity('session-B', TARGET_X, 'planned');
		const setCount = effectOwner.setCalls.length;
		const clearCount = effectOwner.clearCalls.length;
		const replaceCount = effectOwner.replaceCalls.length;

		store.setAgentActivity('session-B', TARGET_X, 'active');

		assert.strictEqual(effectOwner.setCalls.length, setCount);
		assert.strictEqual(effectOwner.clearCalls.length, clearCount);
		assert.strictEqual(effectOwner.replaceCalls.length, replaceCount);
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), [
			{ kind: 'pulse', color: ACTIVITY_COLOR },
		]);

		reconciler.dispose();
	});

	test('대표 Activity가 같아도 debug Session 색이 바뀌면 Effect를 갱신한다', () => {
		const store = createAgentActivityStore();
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(store, effectOwner);

		store.setAgentActivity('debug-g12-active', TARGET_X, 'active');
		store.setAgentActivity('debug-g12-editing', TARGET_X, 'active');
		store.clearAgentActivity('debug-g12-active', TARGET_X);

		const expectedColor = resolveAgentActivityColor(
			'debug-g12-editing',
			'active',
		);
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), [
			{ kind: 'shimmer', color: expectedColor },
		]);
		assert.strictEqual(effectOwner.clearCalls.length, 0);
		assert.strictEqual(effectOwner.setCalls.length, 2);
		assert.strictEqual(effectOwner.replaceCalls.length, 2);

		reconciler.dispose();
	});

	test('마지막 Activity 제거 시 G-12 소유 Effect를 모두 제거한다', () => {
		const store = createAgentActivityStore();
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(store, effectOwner);

		store.setAgentActivity('session-A', TARGET_X, 'completed');
		store.clearAgentActivity('session-A', TARGET_X);

		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), []);
		assert.deepStrictEqual(effectOwner.clearCalls, [{ target: TARGET_X }]);

		reconciler.dispose();
	});

	test('Session 전체 clear가 여러 Target의 대표 Effect를 한 snapshot으로 reconcile한다', () => {
		const store = createAgentActivityStore();
		const agentEffectOwner = new RecordingGraphNodeEffectOwner();
		const externalEffectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(
			store,
			agentEffectOwner,
		);
		externalEffectOwner.setNodeEffect(TARGET_X, {
			kind: 'outline-strong',
			color: '#abcdef',
		});
		externalEffectOwner.setNodeEffect(TARGET_Y, {
			kind: 'icon',
			icon: 'check',
			color: '#abcdef',
		});

		store.setAgentActivity('session-A', TARGET_X, 'editing');
		store.setAgentActivity('session-B', TARGET_X, 'planned');
		store.setAgentActivity('session-A', TARGET_Y, 'active');

		assert.deepStrictEqual(agentEffectOwner.getEffects(TARGET_X), [
			{ kind: 'pulse', color: ACTIVITY_COLOR },
		]);
		assert.deepStrictEqual(agentEffectOwner.getEffects(TARGET_Y), [
			{ kind: 'shimmer', color: ACTIVITY_COLOR },
		]);

		store.clearAgentActivitiesBySession('session-A');

		assert.deepStrictEqual(store.getActivities(TARGET_X), [{
			sessionId: 'session-B',
			activity: 'planned',
			sequence: 2,
		}]);
		assert.deepStrictEqual(store.getActivities(TARGET_Y), []);
		assert.deepStrictEqual(agentEffectOwner.getEffects(TARGET_X), [
			{ kind: 'marching-dash', color: ACTIVITY_COLOR },
			{ kind: 'icon', icon: 'alert', color: ACTIVITY_COLOR },
		]);
		assert.deepStrictEqual(agentEffectOwner.getEffects(TARGET_Y), []);
		assert.deepStrictEqual(agentEffectOwner.clearCalls, [
			{ target: TARGET_Y },
		]);
		assert.strictEqual(agentEffectOwner.replaceCalls.length, 3);
		assert.deepStrictEqual(externalEffectOwner.getEffects(TARGET_X), [{
			kind: 'outline-strong',
			color: '#abcdef',
		}]);
		assert.deepStrictEqual(externalEffectOwner.getEffects(TARGET_Y), [{
			kind: 'icon',
			icon: 'check',
			color: '#abcdef',
		}]);

		reconciler.dispose();
		externalEffectOwner.dispose();
	});

	test('root occurrence는 Source와 병합한 대표 recipe로 같은 owner Source를 대체한다', () => {
		const occurrenceTarget: GraphNodeEffectTarget = {
			nodeId: TARGET_X.nodeId,
			rootId: 'detached:root:x',
		};
		const store = createAgentActivityStore();
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(store, effectOwner);

		store.setAgentActivity('session-A', TARGET_X, 'planned');
		store.setAgentActivity('session-A', occurrenceTarget, 'editing');

		assert.deepStrictEqual(effectOwner.getEffects(occurrenceTarget), [
			{ kind: 'pulse', color: ACTIVITY_COLOR },
		]);
		assert.deepStrictEqual(
			effectOwner.replaceCalls.at(-1)?.options,
			{ sourceInheritance: 'replace' },
		);

		store.clearAgentActivity('session-A', occurrenceTarget);

		assert.deepStrictEqual(effectOwner.getEffects(occurrenceTarget), []);
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), [
			{ kind: 'marching-dash', color: ACTIVITY_COLOR },
			{ kind: 'icon', icon: 'alert', color: ACTIVITY_COLOR },
		]);

		reconciler.dispose();
	});

	test('Source와 다른 occurrence Session도 canonical Priority로 한 recipe만 선택한다', () => {
		const occurrenceTarget: GraphNodeEffectTarget = {
			nodeId: TARGET_X.nodeId,
			rootId: 'detached:root:priority',
		};
		const store = createAgentActivityStore();
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(store, effectOwner);

		store.setAgentActivity('session-A', TARGET_X, 'rejected');
		store.setAgentActivity('session-B', occurrenceTarget, 'planned');

		assert.deepStrictEqual(effectOwner.getEffects(occurrenceTarget), [
			{ kind: 'outline', color: ERROR_COLOR },
			{ kind: 'icon', icon: 'cancel', color: ERROR_COLOR },
		]);

		store.setAgentActivity('session-A', TARGET_X, 'planned');
		store.setAgentActivity('session-B', occurrenceTarget, 'editing');

		assert.deepStrictEqual(effectOwner.getEffects(occurrenceTarget), [
			{ kind: 'pulse', color: ACTIVITY_COLOR },
		]);

		reconciler.dispose();
	});

	test('dispose가 구독과 소유 Effect를 정리하고 이후 Store 변경을 무시한다', () => {
		const store = createAgentActivityStore();
		const effectOwner = new RecordingGraphNodeEffectOwner();
		const reconciler = createAgentActivityEffectReconciler(store, effectOwner);

		store.setAgentActivity('session-A', TARGET_X, 'editing');
		const setCount = effectOwner.setCalls.length;

		reconciler.dispose();
		store.setAgentActivity('session-B', TARGET_Y, 'planned');

		assert.strictEqual(effectOwner.disposed, true);
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_X), []);
		assert.deepStrictEqual(effectOwner.getEffects(TARGET_Y), []);
		assert.strictEqual(effectOwner.setCalls.length, setCount);
	});
});

class RecordingGraphNodeEffectOwner implements GraphNodeEffectOwner {
	readonly setCalls: Array<{
		readonly target: GraphNodeEffectTarget;
		readonly effect: GraphNodeEffect;
	}> = [];

	readonly clearCalls: Array<{
		readonly target: GraphNodeEffectTarget;
		readonly kind?: GraphNodeEffectKind;
	}> = [];

	readonly replaceCalls: Array<{
		readonly target: GraphNodeEffectTarget;
		readonly effects: readonly GraphNodeEffect[];
		readonly options: GraphNodeEffectRecipeOptions;
	}> = [];

	readonly effectsByTarget = new Map<
		string,
		Map<GraphNodeEffectKind, GraphNodeEffect>
	>();

	disposed = false;

	setNodeEffect(target: GraphNodeEffectTarget, effect: GraphNodeEffect): void {
		if (this.disposed) {
			return;
		}

		const effects = this.effectsByTarget.get(createTargetKey(target))
			?? new Map<GraphNodeEffectKind, GraphNodeEffect>();

		effects.set(effect.kind, effect);
		this.effectsByTarget.set(createTargetKey(target), effects);
		this.setCalls.push({ target, effect });
	}

	replaceNodeEffects(
		target: GraphNodeEffectTarget,
		effects: readonly GraphNodeEffect[],
		options: GraphNodeEffectRecipeOptions = {},
	): void {
		if (this.disposed) {
			return;
		}

		this.effectsByTarget.set(
			createTargetKey(target),
			new Map(effects.map((effect) => [effect.kind, effect])),
		);
		for (const effect of effects) {
			this.setCalls.push({ target, effect });
		}
		this.replaceCalls.push({ target, effects, options });
	}

	clearNodeEffect(
		target: GraphNodeEffectTarget,
		kind?: GraphNodeEffectKind,
	): void {
		if (this.disposed) {
			return;
		}

		const key = createTargetKey(target);
		const effects = this.effectsByTarget.get(key);

		if (kind) {
			effects?.delete(kind);
			if (effects?.size === 0) {
				this.effectsByTarget.delete(key);
			}
		} else {
			this.effectsByTarget.delete(key);
		}
		this.clearCalls.push({ target, ...(kind ? { kind } : {}) });
	}

	getEffects(target: GraphNodeEffectTarget): readonly GraphNodeEffect[] {
		return [...(this.effectsByTarget.get(createTargetKey(target))?.values() ?? [])];
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}

		this.disposed = true;
		this.effectsByTarget.clear();
	}
}

function createTargetKey(target: GraphNodeEffectTarget): string {
	return JSON.stringify([target.nodeId, target.rootId ?? null]);
}
