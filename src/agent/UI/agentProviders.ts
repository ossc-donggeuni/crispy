import { type ProviderId } from '../protocol';

/**
 * provider 식별자를 탭 라벨과 드롭다운에 표시하는 고정 문구로 연결한다.
 *
 * 식별자 목록은 protocol의 `PROVIDER_IDS`가 소유하고 여기서는 표시 문구만 정의한다.
 * `Record`가 모든 식별자를 요구하므로 provider가 추가되면 라벨 누락이 컴파일 단계에서 드러난다.
 */
export const AGENT_PROVIDER_LABELS: Readonly<Record<ProviderId, string>> =
	Object.freeze({
		codex: 'Codex',
		claude: 'Claude',
		antigravity: 'Antigravity',
	});

/** provider 미선택 상태에서 드롭다운에 표시하는 placeholder 문구다. */
export const UNSELECTED_PROVIDER_LABEL = 'Select agent';

/** provider가 정해지기 전 탭 strip에 표시하는 고정 라벨이다. */
export const UNSELECTED_TAB_LABEL = 'New tab';

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
