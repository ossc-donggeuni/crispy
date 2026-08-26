import type { AgentActivityKind, GraphNodeEffect } from '../../messages';
import { resolveAgentSessionColor } from '../../agent/agentSessionColor';

/** Activity와 Session의 presentation 색을 한 곳에서 결정한다. */
export function resolveAgentActivityColor(
	sessionId: string,
	_activity: AgentActivityKind,
): string {
	return resolveAgentSessionColor(sessionId);
}

/** G-12 representative와 Binding row가 공유하는 Activity → G-11 Effect 조합이다. */
export function getAgentActivityEffects(
	sessionId: string,
	activity: AgentActivityKind,
	sessionColor: string = resolveAgentActivityColor(sessionId, activity),
): readonly GraphNodeEffect[] {
	const color = sessionColor;

	switch (activity) {
		case 'planned':
			return [
				{ kind: 'marching-dash', color },
				{ kind: 'icon', icon: 'alert', color },
			];
		case 'active':
			return [{ kind: 'shimmer', color }];
		case 'editing':
			return [{ kind: 'pulse', color }];
		case 'completed':
			return [
				{ kind: 'outline', color },
				{ kind: 'icon', icon: 'check', color },
			];
		case 'mentioned':
			return [{ kind: 'outline-strong', color }];
		case 'rejected':
			return [
				{ kind: 'outline', color },
				{ kind: 'icon', icon: 'cancel', color },
			];
	}
}
