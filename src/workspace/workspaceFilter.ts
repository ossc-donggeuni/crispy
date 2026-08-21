/** 현재 해석할 수 있는 Workspace Filter 형식 버전이다. */
export const WORKSPACE_FILTER_VERSION = 1;

/** Folder basename에만 적용되는 Workspace Filter Rule이다. */
export interface WorkspaceFolderFilterRule {
	readonly kind: 'folder';
	readonly pattern: string;
}

/** File basename에만 적용되는 Workspace Filter Rule이다. */
export interface WorkspaceFileFilterRule {
	readonly kind: 'file';
	readonly pattern: string;
}

/** 대상 종류가 discriminant로 구분되는 Workspace Filter Rule이다. */
export type WorkspaceFilterRule =
	| WorkspaceFolderFilterRule
	| WorkspaceFileFilterRule;

/** Workspace Filter Rule이 구분하는 탐색 항목 종류다. */
export type WorkspaceFilterRuleKind = WorkspaceFilterRule['kind'];

/** Workspace Root의 `.crispy/filter.json` 형식이다. */
export interface WorkspaceFilter {
	readonly version: typeof WORKSPACE_FILTER_VERSION;
	readonly rules: readonly WorkspaceFilterRule[];
}

/**
 * JSON 문자열을 현재 Workspace Filter 형식으로 안전하게 파싱한다.
 * JSON 문법 또는 schema 검증이 실패하면 예외 대신 undefined를 반환한다.
 */
export function parseWorkspaceFilterJson(
	source: string,
): WorkspaceFilter | undefined {
	try {
		return parseWorkspaceFilter(JSON.parse(source) as unknown);
	} catch {
		return undefined;
	}
}

/** 현재 버전의 Workspace Filter 값을 검증해 독립적인 객체로 복사한다. */
export function parseWorkspaceFilter(
	value: unknown,
): WorkspaceFilter | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ['version', 'rules'])) {
		return undefined;
	}

	if (
		value.version !== WORKSPACE_FILTER_VERSION
		|| !Array.isArray(value.rules)
	) {
		return undefined;
	}

	const rules: WorkspaceFilterRule[] = [];

	for (const valueRule of value.rules) {
		const rule = parseWorkspaceFilterRule(valueRule);

		if (!rule) {
			return undefined;
		}

		rules.push(rule);
	}

	return {
		version: WORKSPACE_FILTER_VERSION,
		rules,
	};
}

/**
 * Rule의 대상 종류와 basename glob이 모두 일치하는지 확인한다.
 * Pattern은 경로가 아닌 basename을 대상으로 하며 `*`와 `?`만 wildcard다.
 */
export function matchesWorkspaceFilterRule(
	rule: WorkspaceFilterRule,
	kind: WorkspaceFilterRuleKind,
	basename: string,
): boolean {
	return rule.kind === kind
		&& isBasename(basename)
		&& matchesBasenamePattern(rule.pattern, basename);
}

/** unknown Rule을 kind별 Filter Rule로 검증해 복사한다. */
function parseWorkspaceFilterRule(
	value: unknown,
): WorkspaceFilterRule | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'pattern'])) {
		return undefined;
	}

	if (
		(value.kind !== 'folder' && value.kind !== 'file')
		|| typeof value.pattern !== 'string'
		|| !isValidBasenamePattern(value.pattern)
	) {
		return undefined;
	}

	return {
		kind: value.kind,
		pattern: value.pattern,
	};
}

/** Filter pattern이 비어 있지 않은 단일 basename pattern인지 확인한다. */
function isValidBasenamePattern(pattern: string): boolean {
	return pattern.trim().length > 0
		&& !pattern.includes('/')
		&& !pattern.includes('\\')
		&& !pattern.includes('\0');
}

/** 매칭 입력이 비어 있지 않은 단일 basename인지 확인한다. */
function isBasename(value: string): boolean {
	return value.length > 0
		&& !value.includes('/')
		&& !value.includes('\\')
		&& !value.includes('\0');
}

/** `*`와 `?`를 지원하는 basename 전용 glob을 선형 시간에 매칭한다. */
function matchesBasenamePattern(pattern: string, basename: string): boolean {
	let patternIndex = 0;
	let basenameIndex = 0;
	let starPatternIndex = -1;
	let starBasenameIndex = -1;

	while (basenameIndex < basename.length) {
		const patternCharacter = pattern[patternIndex];

		if (
			patternCharacter === '?'
			|| patternCharacter === basename[basenameIndex]
		) {
			patternIndex += 1;
			basenameIndex += 1;
			continue;
		}

		if (patternCharacter === '*') {
			starPatternIndex = patternIndex;
			starBasenameIndex = basenameIndex;
			patternIndex += 1;
			continue;
		}

		if (starPatternIndex >= 0) {
			patternIndex = starPatternIndex + 1;
			starBasenameIndex += 1;
			basenameIndex = starBasenameIndex;
			continue;
		}

		return false;
	}

	while (pattern[patternIndex] === '*') {
		patternIndex += 1;
	}

	return patternIndex === pattern.length;
}

/** unknown 값이 배열이 아닌 key-value 객체인지 확인한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 객체가 schema에서 허용한 own enumerable key만 정확히 가지는지 확인한다. */
function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	const keys = Object.keys(value);

	return keys.length === allowedKeys.length
		&& allowedKeys.every((key) => Object.hasOwn(value, key));
}
