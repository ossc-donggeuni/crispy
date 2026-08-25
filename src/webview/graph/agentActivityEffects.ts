import type {
	GraphNodeEffect,
	GraphNodeEffectTarget,
} from '../../messages';
import type {
	AgentActivityStore,
	AgentActivityStoreSnapshot,
} from '../../agent/webview/agentActivityStore';
import type { GraphNodeEffectOwner } from './graphNodeEffects';
import { getAgentActivityEffects } from './agentActivityPresentation';
import {
	createAgentActivityTargetKey,
	getEffectiveAgentActivities,
	indexAgentActivitiesByTarget,
} from './agentActivityProjection';

/** Target별 대표 Agent Activity Effect 구독과 소유 Effect의 수명주기다. */
export interface AgentActivityEffectReconciler {
	dispose(): void;
}

interface AppliedRepresentativeActivity {
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly effects: readonly GraphNodeEffect[];
}

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
		const activitiesByTarget = indexAgentActivitiesByTarget(snapshot);

		for (const targetSnapshot of snapshot) {
			const target = targetSnapshot.target;
			const representative = getEffectiveAgentActivities(
				target,
				activitiesByTarget,
			)[0];

			if (!representative) {
				continue;
			}

			const key = createAgentActivityTargetKey(target);
			const applied = appliedByTarget.get(key);
			const effects = getAgentActivityEffects(
				representative.sessionId,
				representative.activity,
			);

			currentTargetKeys.add(key);
			if (applied && areEffectsEqual(applied.effects, effects)) {
				continue;
			}

			effectOwner.replaceNodeEffects(target, effects, {
				sourceInheritance: target.rootId === undefined ? 'merge' : 'replace',
			});
			appliedByTarget.set(key, {
				target: createTargetSnapshot(target),
				effects: effects.map((effect) => ({ ...effect })),
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

function areEffectsEqual(
	left: readonly GraphNodeEffect[],
	right: readonly GraphNodeEffect[],
): boolean {
	if (left.length !== right.length) {
		return false;
	}

	return left.every((effect, index) => {
		const candidate = right[index];
		return effect.kind === candidate.kind
			&& effect.color === candidate.color
			&& (effect.kind !== 'icon' || (
				candidate.kind === 'icon' && effect.icon === candidate.icon
			));
	});
}

function createTargetSnapshot(
	target: Readonly<GraphNodeEffectTarget>,
): Readonly<GraphNodeEffectTarget> {
	return Object.freeze({
		nodeId: target.nodeId,
		...(target.rootId === undefined ? {} : { rootId: target.rootId }),
	});
}
