import type { SessionId } from './protocol';

/** 탭과 Graph Activity가 공유하는 세션 식별 팔레트다. */
export const AGENT_SESSION_COLOR_PALETTE = Object.freeze([
	'#22d3ee',
	'#a78bfa',
	'#fb923c',
	'#f472b6',
	'#4ade80',
	'#60a5fa',
	'#facc15',
	'#f87171',
	'#2dd4bf',
	'#c084fc',
	'#a3e635',
	'#fb7185',
] as const);

/** Debug command의 여섯 예시가 독립 resolver에서도 항상 서로 다른 색을 쓰게 한다. */
const DEBUG_SESSION_COLOR_INDICES: Readonly<Record<string, number>> = Object.freeze({
	'debug-g12-planned': 0,
	'debug-g12-active': 1,
	'debug-g12-editing': 2,
	'debug-g12-completed': 3,
	'debug-g12-mentioned': 4,
	'debug-g12-rejected': 5,
	'debug-g12-detached': 6,
	'debug-g12-extra': 7,
});

export type AgentSessionColorResolver = (sessionId: SessionId) => string;

export interface AgentSessionColorRegistry {
	/** 같은 세션에는 같은 색을, 먼저 등록된 세션에는 서로 다른 팔레트 색을 반환한다. */
	readonly resolve: AgentSessionColorResolver;
}

/**
 * 한 Webview 수명 동안 세션 색상을 할당한다.
 * 팔레트 크기까지는 생성 순서가 다른 세션끼리 색상이 겹치지 않는다.
 */
export function createAgentSessionColorRegistry(): AgentSessionColorRegistry {
	const colorsBySession = new Map<SessionId, string>();
	let nextColorIndex = 0;

	return Object.freeze({
		resolve(sessionId: SessionId): string {
			const current = colorsBySession.get(sessionId);
			if (current !== undefined) {
				return current;
			}

			const color = AGENT_SESSION_COLOR_PALETTE[
				nextColorIndex % AGENT_SESSION_COLOR_PALETTE.length
			];
			nextColorIndex += 1;
			colorsBySession.set(sessionId, color);
			return color;
		},
	});
}

/** 독립 컴포넌트와 테스트가 공유 Registry 없이도 같은 세션 색을 얻는 fallback이다. */
export function resolveAgentSessionColor(sessionId: SessionId): string {
	const debugColorIndex = DEBUG_SESSION_COLOR_INDICES[sessionId];
	if (debugColorIndex !== undefined) {
		return AGENT_SESSION_COLOR_PALETTE[debugColorIndex];
	}

	let hash = 2166136261;
	for (const character of sessionId) {
		hash ^= character.charCodeAt(0);
		hash = Math.imul(hash, 16777619) >>> 0;
	}

	return AGENT_SESSION_COLOR_PALETTE[hash % AGENT_SESSION_COLOR_PALETTE.length];
}
