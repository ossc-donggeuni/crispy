import type { ProviderId, ProviderRegistry } from '../../protocol/providers';

/**
 * provider 하나를 시작할 때 Host가 적용하는 실행 정책이다.
 *
 * 현재 단계는 Shell 위에서 CLI를 자동으로 실행하는 방식만 다루므로 실행 파일 경로가
 * 아니라 Shell에 입력할 커맨드를 정의한다. 커맨드 문자열은 Extension Host가 소유하며
 * Webview는 providerId만 지정할 수 있다.
 */
export interface AgentProviderLaunchDefinition {
	/**
	 * 세션이 시작된 직후 Shell에 자동으로 입력할 CLI 커맨드다.
	 * 값이 없으면 자동 실행 없이 기본 Shell 상태로 둔다.
	 */
	readonly autoRunCommand?: string;

	/** Windows PowerShell execution policy를 우회하지 않고 사용할 `.cmd` shim override다. */
	readonly windowsAutoRunCommand?: string;
}

/**
 * provider별 자동 실행 정책의 유일한 Host 소유 출처다.
 *
 * `ProviderRegistry`가 allowlist의 모든 provider를 요구하므로 provider가 추가되면
 * 정책 누락이 컴파일 단계에서 드러난다. 이번 단계에서는 Codex만 자동 실행 대상이며
 * Claude와 Antigravity는 자동 실행 없이 기본 Shell만 시작한다.
 */
const AGENT_PROVIDER_LAUNCH: ProviderRegistry<AgentProviderLaunchDefinition> =
	Object.freeze({
		codex: Object.freeze({
			autoRunCommand: 'codex',
			windowsAutoRunCommand: 'codex.cmd',
		}),
		claude: Object.freeze({}),
		antigravity: Object.freeze({}),
	});

/**
 * 자동 실행 커맨드를 확정하기 위해 Shell에 함께 보내는 실행 키 입력이다.
 * 사용자가 Enter를 누른 것과 동일한 입력이므로 PTY 규약에 맞춰 CR을 사용한다.
 */
const AUTO_RUN_SUBMIT_KEY = '\r';

/**
 * provider에 배정된 자동 실행 입력을 결정한다.
 *
 * 반환값은 Host registry에서만 만들어지며 Webview가 보낸 값을 포함하지 않는다.
 *
 * @param providerId protocol validator를 통과한 provider 식별자
 * @param platform Host가 실행 중인 Node 플랫폼이며 테스트에서만 명시적으로 주입한다.
 * @returns Shell에 그대로 입력할 커맨드 문자열 또는 자동 실행이 없으면 `undefined`
 */
export function resolveAgentAutoRunInput(
	providerId: ProviderId,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const definition = AGENT_PROVIDER_LAUNCH[providerId];
	const command = platform === 'win32'
		? definition.windowsAutoRunCommand ?? definition.autoRunCommand
		: definition.autoRunCommand;
	return command === undefined ? undefined : `${command}${AUTO_RUN_SUBMIT_KEY}`;
}
