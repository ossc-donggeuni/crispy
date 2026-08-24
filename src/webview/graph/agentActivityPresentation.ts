import type { AgentActivityKind, GraphNodeEffect } from '../../messages';

const AGENT_ACTIVITY_COLOR = 'var(--graph-viewport-accent-color, #007acc)';
const AGENT_ACTIVITY_SUCCESS_COLOR =
	'var(--vscode-testing-iconPassed, var(--vscode-charts-green, #73c991))';
const AGENT_ACTIVITY_ERROR_COLOR = 'var(--vscode-errorForeground, #f14c4c)';
const DEBUG_SESSION_PREFIX = 'debug-g12-';

/** Debug 전용 Session은 production message 계약과 별개로 안정적인 demo 색을 받는다. */
const DEBUG_SESSION_COLORS = [
	'#22d3ee',
	'#a78bfa',
	'#fb923c',
	'#f472b6',
	'#4ade80',
	'#60a5fa',
	'#facc15',
	'#f87171',
] as const;

const DEBUG_SESSION_COLOR_INDICES: Readonly<Record<string, number>> = {
	'debug-g12-planned': 0,
	'debug-g12-active': 1,
	'debug-g12-editing': 2,
	'debug-g12-completed': 3,
	'debug-g12-mentioned': 4,
	'debug-g12-rejected': 5,
	'debug-g12-detached': 6,
	'debug-g12-extra': 7,
};

/** Activity와 Session의 presentation 색을 한 곳에서 결정한다. */
export function resolveAgentActivityColor(
	sessionId: string,
	activity: AgentActivityKind,
): string {
	if (sessionId.startsWith(DEBUG_SESSION_PREFIX)) {
		return DEBUG_SESSION_COLORS[getDebugSessionColorIndex(sessionId)];
	}

	switch (activity) {
		case 'completed':
			return AGENT_ACTIVITY_SUCCESS_COLOR;
		case 'rejected':
			return AGENT_ACTIVITY_ERROR_COLOR;
		default:
			return AGENT_ACTIVITY_COLOR;
	}
}

/** G-12 representative와 Binding row가 공유하는 Activity → G-11 Effect 조합이다. */
export function getAgentActivityEffects(
	sessionId: string,
	activity: AgentActivityKind,
): readonly GraphNodeEffect[] {
	const color = resolveAgentActivityColor(sessionId, activity);

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

function getDebugSessionColorIndex(sessionId: string): number {
	const knownIndex = DEBUG_SESSION_COLOR_INDICES[sessionId];
	if (knownIndex !== undefined) {
		return knownIndex;
	}

	let hash = 0;
	for (const character of sessionId) {
		hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
	}

	return hash % DEBUG_SESSION_COLORS.length;
}
