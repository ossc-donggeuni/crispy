import type {
	AgentActivityKind,
	GraphNodeEffect,
	GraphNodeEffectTarget,
} from '../../messages';
import type {
	AgentActivityStore,
	AgentActivityStoreSnapshot,
} from '../../agent/webview/agentActivityStore';
import type { GraphNodeEffectOwner } from './graphNodeEffects';

/** Target별 대표 Agent Activity Effect 구독과 소유 Effect의 수명주기다. */
export interface AgentActivityEffectReconciler {
	dispose(): void;
}

interface AppliedRepresentativeActivity {
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly activity: AgentActivityKind;
}

const AGENT_ACTIVITY_COLOR = 'var(--graph-viewport-accent-color, #007acc)';
const AGENT_ACTIVITY_SUCCESS_COLOR =
	'var(--vscode-testing-iconPassed, var(--vscode-charts-green, #73c991))';
const AGENT_ACTIVITY_ERROR_COLOR = 'var(--vscode-errorForeground, #f14c4c)';

/** G-12.3의 첫 Activity만 G-11 Effect 조합으로 동기화한다. */
export function createAgentActivityEffectReconciler(
	store: AgentActivityStore,
	effectOwner: GraphNodeEffectOwner,
): AgentActivityEffectReconciler {
	const appliedByTarget = new Map<string, AppliedRepresentativeActivity>();
	let disposed = false;

	const reconcile = (snapshot: AgentActivityStoreSnapshot): void => {
		if (disposed) {
			return;
		}

		const currentTargetKeys = new Set<string>();

		for (const targetSnapshot of snapshot) {
			const target = targetSnapshot.target;
			const representative = targetSnapshot.activities[0];

			if (!representative) {
				continue;
			}

			const key = createTargetKey(target);
			const applied = appliedByTarget.get(key);

			currentTargetKeys.add(key);
			if (applied?.activity === representative.activity) {
				continue;
			}

			if (applied) {
				effectOwner.clearNodeEffect(applied.target);
			}
			for (const effect of getAgentActivityEffects(representative.activity)) {
				effectOwner.setNodeEffect(target, effect);
			}
			appliedByTarget.set(key, {
				target: createTargetSnapshot(target),
				activity: representative.activity,
			});
		}

		for (const [key, applied] of appliedByTarget) {
			if (currentTargetKeys.has(key)) {
				continue;
			}

			effectOwner.clearNodeEffect(applied.target);
			appliedByTarget.delete(key);
		}
	};

	reconcile(store.getSnapshot());
	const unsubscribe = store.subscribe(reconcile);

	return {
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			unsubscribe();
			effectOwner.dispose();
			appliedByTarget.clear();
		},
	};
}

function getAgentActivityEffects(
	activity: AgentActivityKind,
): readonly GraphNodeEffect[] {
	switch (activity) {
		case 'planned':
			return [
				{ kind: 'marching-dash', color: AGENT_ACTIVITY_COLOR },
				{ kind: 'icon', icon: 'alert', color: AGENT_ACTIVITY_COLOR },
			];
		case 'active':
			return [{ kind: 'shimmer', color: AGENT_ACTIVITY_COLOR }];
		case 'editing':
			return [{ kind: 'pulse', color: AGENT_ACTIVITY_COLOR }];
		case 'completed':
			return [
				{ kind: 'outline', color: AGENT_ACTIVITY_SUCCESS_COLOR },
				{
					kind: 'icon',
					icon: 'check',
					color: AGENT_ACTIVITY_SUCCESS_COLOR,
				},
			];
		case 'mentioned':
			return [{ kind: 'outline-strong', color: AGENT_ACTIVITY_COLOR }];
		case 'rejected':
			return [
				{ kind: 'outline', color: AGENT_ACTIVITY_ERROR_COLOR },
				{
					kind: 'icon',
					icon: 'cancel',
					color: AGENT_ACTIVITY_ERROR_COLOR,
				},
			];
	}
}

function createTargetKey(target: GraphNodeEffectTarget): string {
	return JSON.stringify([target.nodeId, target.rootId ?? null]);
}

function createTargetSnapshot(
	target: Readonly<GraphNodeEffectTarget>,
): Readonly<GraphNodeEffectTarget> {
	return Object.freeze({
		nodeId: target.nodeId,
		...(target.rootId === undefined ? {} : { rootId: target.rootId }),
	});
}
