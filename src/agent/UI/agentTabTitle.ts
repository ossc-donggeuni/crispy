/** 화면에 표시할 탭 이름의 최대 Unicode code point 수다. */
export const AGENT_TAB_TITLE_MAX_CODE_POINTS = 40;

/** 첫 프롬프트에서 `…`까지 포함해 자동 제목으로 표시하는 Unicode code point 수다. */
export const AGENT_TAB_TITLE_PREVIEW_CODE_POINTS = 12;

/** 자동 제목 충돌 후보를 검사하는 상한이다. */
export const AGENT_TAB_TITLE_MAX_CANDIDATES = 1;

/** 수동 이름 검증이 UI에 연결하는 고정 오류 종류다. */
export type ManualTabNameError = 'empty' | 'tooLong';

/** 수동 이름 정규화 결과다. */
export type ManualTabNameResult =
	| { readonly ok: true; readonly value: string }
	| { readonly ok: false; readonly error: ManualTabNameError };

/** 문자열의 Unicode code point 수를 반환한다. */
export function countUnicodeCodePoints(value: string): number {
	return Array.from(value).length;
}

/**
 * 표시 이름 비교에 사용하는 NFC, 공백 및 대소문자 정규화 key를 만든다.
 *
 * @param value 비교할 이름
 * @returns 열린 탭 사이의 유일성 검사 key
 */
export function createAgentTabNameKey(value: string): string {
	return value
		.normalize('NFC')
		.trim()
		.replace(/\s+/gu, ' ')
		.toLocaleLowerCase('en-US');
}

/**
 * 사용자가 입력한 탭 이름을 표시 정책에 맞게 정규화하고 길이를 검증한다.
 * 줄바꿈을 포함한 Unicode control 문자는 이름에 남기지 않는다.
 *
 * @param value 사용자가 입력한 원문
 * @returns 정규화된 이름 또는 고정 오류 종류
 */
export function normalizeManualAgentTabName(value: string): ManualTabNameResult {
	const normalized = value
		.replace(/\p{Cc}/gu, ' ')
		.normalize('NFC')
		.trim()
		.replace(/\s+/gu, ' ');

	if (normalized.length === 0) {
		return { ok: false, error: 'empty' };
	}
	if (countUnicodeCodePoints(normalized) > AGENT_TAB_TITLE_MAX_CODE_POINTS) {
		return { ok: false, error: 'tooLong' };
	}

	return { ok: true, value: normalized };
}

/** 원문 prefix를 지정 길이 안에서 `…`까지 포함한 미리보기로 만든다. */
function createPromptPreview(input: string, maximumCodePoints: number): string {
	const codePoints = Array.from(input);
	if (codePoints.length <= maximumCodePoints) {
		return input;
	}

	return `${codePoints.slice(0, maximumCodePoints - 1).join('')}…`;
}

/**
 * 첫 안전 프롬프트의 원문 prefix를 자동 제목 후보로 바꾼다.
 * `undefined`는 제어/선택 응답 또는 안전하지 않은 입력으로 시도하지 않아야 함을 뜻한다.
 *
 * @param input Webview collector가 안전하게 복원한 제출 문자열
 * @returns 최대 32개의 제목 후보, 시도 제외 입력이면 `undefined`
 */
export function createAutomaticAgentTabTitleCandidates(
	input: string,
): readonly string[] | undefined {
	const normalizedInput = input
		.normalize('NFC')
		.trim()
		.replace(/\s+/gu, ' ');
	if (normalizedInput.length === 0 || /\p{Cc}/u.test(normalizedInput)) {
		return undefined;
	}

	const firstInputToken = normalizedInput.split(/\s+/u)[0] ?? '';
	const comparisonInput = normalizedInput.toLocaleLowerCase('en-US');
	if (
		firstInputToken.startsWith('/')
		|| ['exit', 'quit', 'y', 'n', 'yes', 'no'].includes(comparisonInput)
		|| /^\p{N}+$/u.test(normalizedInput)
	) {
		return undefined;
	}

	const rawTokens = normalizedInput.split(/\s+/u);
	if (
		!/[\p{L}\p{N}]/u.test(normalizedInput)
		|| rawTokens.some((token) => countUnicodeCodePoints(token) > 64)
	) {
		return undefined;
	}

	const uniqueCandidates: string[] = [];
	const candidateKeys = new Set<string>();
	for (const maximumCodePoints of [AGENT_TAB_TITLE_PREVIEW_CODE_POINTS]) {
		const candidate = createPromptPreview(normalizedInput, maximumCodePoints);
		const key = createAgentTabNameKey(candidate);
		if (candidateKeys.has(key)) {
			continue;
		}
		candidateKeys.add(key);
		uniqueCandidates.push(candidate);
	}

	return Object.freeze(uniqueCandidates);
}
