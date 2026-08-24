import type { GraphNodeEffectTarget } from '../../messages';
import {
	compareAgentActivities,
	type AgentActivityStoreSnapshot,
	type AgentSessionActivitySnapshot,
} from '../../agent/webview/agentActivityStore';

export type AgentActivitiesByTarget = ReadonlyMap<
	string,
	readonly AgentSessionActivitySnapshot[]
>;

/** Immutable Store snapshot을 exact Graph Target 조회용 index로 만든다. */
export function indexAgentActivitiesByTarget(
	snapshot: AgentActivityStoreSnapshot,
): AgentActivitiesByTarget {
	return new Map(snapshot.map((targetSnapshot) => [
		createAgentActivityTargetKey(targetSnapshot.target),
		targetSnapshot.activities,
	]));
}

/** Source를 occurrence에 투영하고 같은 Session의 occurrence Activity로 덮어쓴다. */
export function getEffectiveAgentActivities(
	target: Readonly<GraphNodeEffectTarget>,
	activitiesByTarget: AgentActivitiesByTarget,
): readonly AgentSessionActivitySnapshot[] {
	const sourceActivities = activitiesByTarget.get(createAgentActivityTargetKey({
		nodeId: target.nodeId,
	})) ?? [];

	if (target.rootId === undefined) {
		return sourceActivities;
	}

	const occurrenceActivities = activitiesByTarget.get(
		createAgentActivityTargetKey(target),
	) ?? [];

	if (occurrenceActivities.length === 0) {
		return sourceActivities;
	}
	if (sourceActivities.length === 0) {
		return occurrenceActivities;
	}

	const occurrenceSessionIds = new Set(
		occurrenceActivities.map((entry) => entry.sessionId),
	);
	const inheritedActivities = sourceActivities.filter(
		(entry) => !occurrenceSessionIds.has(entry.sessionId),
	);

	return mergeOrderedActivities(inheritedActivities, occurrenceActivities);
}

export function createAgentActivityTargetKey(
	target: Readonly<GraphNodeEffectTarget>,
): string {
	return JSON.stringify([target.nodeId, target.rootId ?? null]);
}

/** 두 G-12.3 ordered 배열을 canonical comparator로 병합하며 다시 sort하지 않는다. */
function mergeOrderedActivities(
	left: readonly AgentSessionActivitySnapshot[],
	right: readonly AgentSessionActivitySnapshot[],
): readonly AgentSessionActivitySnapshot[] {
	const merged: AgentSessionActivitySnapshot[] = [];
	let leftIndex = 0;
	let rightIndex = 0;

	while (leftIndex < left.length && rightIndex < right.length) {
		const leftEntry = left[leftIndex];
		const rightEntry = right[rightIndex];

		if (compareAgentActivities(leftEntry, rightEntry) <= 0) {
			merged.push(leftEntry);
			leftIndex += 1;
		} else {
			merged.push(rightEntry);
			rightIndex += 1;
		}
	}

	merged.push(...left.slice(leftIndex), ...right.slice(rightIndex));
	return Object.freeze(merged);
}
