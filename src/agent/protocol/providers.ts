/**
 * Crispy가 다루는 terminal provider 식별자의 유일한 출처다.
 *
 * 이 목록은 식별자를 정의할 뿐 실행 가능 여부를 뜻하지 않는다.
 * 어떤 provider를 실제로 시작할 수 있는지는 Host의 provider registry가 결정하며,
 * 정의가 없는 provider 요청은 `provider_not_allowed`로 거부한다.
 * 표시 문구는 protocol의 관심사가 아니므로 Webview UI가 따로 소유한다.
 */
export const PROVIDER_IDS = ['codex', 'claude'] as const;

/** Webview가 선택할 수 있는 Host provider registry의 key다. */
export type ProviderId = typeof PROVIDER_IDS[number];

/**
 * Host 전용 provider 정의를 allowlist의 모든 provider와 정확히 연결한다.
 *
 * 실행 파일, 인자, 환경, 인증 및 timeout 정책의 구체 타입은 Extension Host가
 * 소유하며 이 공유 protocol 계층에는 포함하지 않는다.
 */
export type ProviderRegistry<ProviderDefinition> = Readonly<{
	[Id in ProviderId]: ProviderDefinition;
}>;
