/** Crispy가 현재 지원하는 terminal provider 식별자 allowlist다. */
export const PROVIDER_IDS = ['codex'] as const;

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
