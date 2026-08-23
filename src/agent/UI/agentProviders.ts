import { type ProviderId } from '../protocol';

/**
 * provider 식별자를 탭 라벨과 중앙 선택기에 표시하는 고정 문구로 연결한다.
 *
 * 식별자 목록은 protocol의 `PROVIDER_IDS`가 소유하고 여기서는 표시 문구만 정의한다.
 * `Record`가 모든 식별자를 요구하므로 provider가 추가되면 라벨 누락이 컴파일 단계에서 드러난다.
 */
export const AGENT_PROVIDER_LABELS: Readonly<Record<ProviderId, string>> =
	Object.freeze({
		codex: 'Codex',
		claude: 'Claude Code',
		antigravity: 'Antigravity',
	});

/** provider가 정해지기 전 탭 strip에 표시하는 고정 라벨이다. */
export const UNSELECTED_TAB_LABEL = 'New tab';

/** 로고나 브랜드 색상 대신 탭 식별에만 사용하는 자체 CLI 팔레트다. */
export const AGENT_PROVIDER_TAB_COLORS: Readonly<
	Partial<Record<ProviderId, string>>
> = Object.freeze({
	codex: '#7aa2e3',
	claude: '#e0a96d',
});

/**
 * 탭 라벨을 `{Provider} #{번호}` 형식으로 만든다.
 *
 * @param providerId 탭에 배정된 provider 식별자
 * @param sequence 같은 provider 안에서 순차 증가하는 번호
 * @returns 탭 strip에 표시할 라벨 문자열
 */
export function formatAgentTabLabel(
	providerId: ProviderId,
	sequence: number,
): string {
	return `${AGENT_PROVIDER_LABELS[providerId]} #${sequence}`;
}
