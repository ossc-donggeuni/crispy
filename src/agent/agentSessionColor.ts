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

const UINT32_RANGE = 0x1_0000_0000;

/**
 * 한 Webview 수명 동안 세션 색상을 할당한다.
 * Webview마다 새 random seed로 팔레트 순서를 섞고, 팔레트 크기까지는
 * 생성 순서가 다른 세션끼리 색상이 겹치지 않는다.
 */
export function createAgentSessionColorRegistry(
	seed: number = createAgentSessionColorSeed(),
): AgentSessionColorRegistry {
	const colorsBySession = new Map<SessionId, string>();
	const colors = createShuffledSessionColors(seed);
	let nextColorIndex = 0;

	return Object.freeze({
		resolve(sessionId: SessionId): string {
			const current = colorsBySession.get(sessionId);
			if (current !== undefined) {
				return current;
			}

			const color = colors[nextColorIndex % colors.length];
			nextColorIndex += 1;
			colorsBySession.set(sessionId, color);
			return color;
		},
	});
}

/** Webview에서 지원하는 CSPRNG로 수명별 32-bit 팔레트 seed를 만든다. */
function createAgentSessionColorSeed(): number {
	return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

/** 주입한 seed를 결정적인 PRNG로 확장해 팔레트의 Fisher-Yates 순서를 만든다. */
function createShuffledSessionColors(seed: number): readonly string[] {
	const colors = [...AGENT_SESSION_COLOR_PALETTE];
	const random = createSeededRandom(seed);

	for (let index = colors.length - 1; index > 0; index -= 1) {
		const swapIndex = Math.floor(random() * (index + 1));
		[colors[index], colors[swapIndex]] = [colors[swapIndex], colors[index]];
	}

	return Object.freeze(colors);
}

/** Mulberry32는 하나의 uint32 seed에서 셔플에 필요한 결정적인 값을 만든다. */
function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;

	return (): number => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;

		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / UINT32_RANGE;
	};
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
