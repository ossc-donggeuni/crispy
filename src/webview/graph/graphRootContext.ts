/** Renderer가 제공한 문자열별 실제 표시 폭 측정 함수다. */
export type GraphContextTextMeasurer = (text: string) => number;

const PATH_ELLIPSIS_PREFIX = '…/';
const TEXT_ELLIPSIS = '…';

/**
 * 상대 경로를 실제 텍스트 폭 기준으로 최대 폭 안에 맞춘다.
 * 전체 경로가 넘칠 때는 상위 segment부터 제거하고, 마지막 segment까지
 * 넘치면 끝 문자를 하나씩 줄여 trailing ellipsis를 붙인다.
 *
 * @param relativePath Graph Root가 전달한 원래 Root 기준 상대 경로
 * @param maxWidth Renderer가 Root Node 실제 폭에서 계산한 최대 표시 폭
 * @param measureText 후보 문자열의 실제 렌더링 폭을 반환하는 함수
 * @returns 최대 폭에 맞는 결정적인 표시 문자열
 */
export function fitRelativePath(
	relativePath: string,
	maxWidth: number,
	measureText: GraphContextTextMeasurer,
): string {
	const normalizedPath = relativePath.replace(/\\/g, '/');

	if (Number.isNaN(maxWidth) || maxWidth <= 0) {
		return '';
	}

	if (fits(normalizedPath, maxWidth, measureText)) {
		return normalizedPath;
	}

	const segments = normalizedPath.split('/');
	let shortestPath = normalizedPath;

	for (let removedCount = 1; removedCount < segments.length; removedCount += 1) {
		shortestPath = `${PATH_ELLIPSIS_PREFIX}${segments
			.slice(removedCount)
			.join('/')}`;

		if (fits(shortestPath, maxWidth, measureText)) {
			return shortestPath;
		}
	}

	return fitWithTrailingEllipsis(shortestPath, maxWidth, measureText);
}

/** 지정 문자열이 유효한 측정값으로 최대 폭 안에 들어오는지 판별한다. */
function fits(
	text: string,
	maxWidth: number,
	measureText: GraphContextTextMeasurer,
): boolean {
	const measuredWidth = measureText(text);

	return Number.isFinite(measuredWidth) && measuredWidth <= maxWidth;
}

/** 가장 짧은 경로 후보도 넘칠 때 Unicode 문자 단위로 끝을 축약한다. */
function fitWithTrailingEllipsis(
	text: string,
	maxWidth: number,
	measureText: GraphContextTextMeasurer,
): string {
	if (!fits(TEXT_ELLIPSIS, maxWidth, measureText)) {
		return '';
	}

	const characters = Array.from(text);

	for (let length = characters.length - 1; length > 0; length -= 1) {
		const prefix = characters.slice(0, length).join('');
		const candidate = prefix === TEXT_ELLIPSIS
			? TEXT_ELLIPSIS
			: `${prefix}${TEXT_ELLIPSIS}`;

		if (fits(candidate, maxWidth, measureText)) {
			return candidate;
		}
	}

	return TEXT_ELLIPSIS;
}
