import { execFile } from 'node:child_process';
import type { ProviderId, ProviderRegistry } from '../../protocol/providers';
import type { ShellLaunchPolicy } from '../shell/types';

/**
 * provider 하나를 시작할 때 Host가 적용하는 실행 정책이다.
 *
 * 현재 단계는 Shell 위에서 CLI를 자동으로 실행하는 방식만 다루므로 실행 파일 경로가
 * 아니라 Shell에 입력할 커맨드를 정의한다. 커맨드 문자열은 Extension Host가 소유하며
 * Webview는 providerId만 지정할 수 있다.
 */
export interface AgentProviderLaunchDefinition {
	/** 세션이 시작된 직후 Shell에 자동으로 입력할 CLI 커맨드다. */
	readonly autoRunCommand?: string;

	/** Windows에서 provider별로 사용할 기본 auto-run command override다. */
	readonly windowsAutoRunCommand?: string;
}

/** provider별 자동 실행 정책의 유일한 Host 소유 출처다. */
const AGENT_PROVIDER_LAUNCH: ProviderRegistry<AgentProviderLaunchDefinition> =
	Object.freeze({
		codex: Object.freeze({
			autoRunCommand: 'codex',
			windowsAutoRunCommand: 'codex',
		}),
		claude: Object.freeze({
			autoRunCommand: 'claude',
			windowsAutoRunCommand: 'claude',
		}),
		antigravity: Object.freeze({
			autoRunCommand: 'agy',
			windowsAutoRunCommand: 'agy',
		}),
	});

/** Windows에서 설치 방식별 Codex shim/native executable을 확인하는 순서다. */
export const WINDOWS_CODEX_COMMAND_CANDIDATES = Object.freeze([
	'codex',
	'codex.cmd',
	'codex.exe',
] as const);

/** Windows에서 설치 방식별 Claude shim/native executable을 확인하는 순서다. */
export const WINDOWS_CLAUDE_COMMAND_CANDIDATES = Object.freeze([
	'claude',
	'claude.cmd',
	'claude.exe',
] as const);

/** Windows에서 설치 방식별 Antigravity shim/native executable을 확인하는 순서다. */
export const WINDOWS_ANTIGRAVITY_COMMAND_CANDIDATES = Object.freeze([
	'agy',
	'agy.cmd',
	'agy.exe',
] as const);

/** Windows 자동 탐색 대상 provider별 후보 registry다. */
const WINDOWS_AGENT_COMMAND_CANDIDATES: ProviderRegistry<readonly string[]> =
	Object.freeze({
		codex: WINDOWS_CODEX_COMMAND_CANDIDATES,
		claude: WINDOWS_CLAUDE_COMMAND_CANDIDATES,
		antigravity: WINDOWS_ANTIGRAVITY_COMMAND_CANDIDATES,
	});

/** 자동 실행 커맨드를 확정하기 위해 Shell에 함께 보내는 Enter 입력이다. */
const AUTO_RUN_SUBMIT_KEY = '\r';

/** 느리거나 응답하지 않는 후보 하나가 Terminal 시작을 계속 막지 않게 하는 제한이다. */
const WINDOWS_AGENT_PROBE_TIMEOUT_MS = 2_000;

/** 실제 PTY Shell과 같은 정책에서 Windows command의 실행 가능 여부를 확인하는 경계다. */
export type WindowsAgentCommandProbe = (
	command: string,
	policy: ShellLaunchPolicy,
) => Promise<boolean>;

/** provider 자동 실행 입력을 세션 시작 전에 비동기로 결정하는 Host 내부 경계다. */
export type AgentAutoRunInputResolver = (
	providerId: ProviderId,
	policy: ShellLaunchPolicy,
) => Promise<string | undefined>;

/** Windows provider CLI 탐색 경계를 생성할 때 주입할 수 있는 의존성이다. */
export interface AgentAutoRunInputResolverOptions {
	readonly platform?: NodeJS.Platform;
	readonly probeWindowsCommand?: WindowsAgentCommandProbe;
	readonly getCliPath?: (providerId: ProviderId) => string | undefined;
}

/** PowerShell single-quoted literal 밖으로 사용자 설정값이 빠져나가지 않게 한다. */
function quotePowerShellLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** POSIX Shell single-quoted word로 executable 경로 하나를 안전하게 만든다. */
function quotePosixShellWord(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** 사용자 override는 인자가 아닌 executable 경로 하나로만 Shell에 전달한다. */
function formatOverrideCommand(
	command: string,
	platform: NodeJS.Platform,
): string {
	return platform === 'win32'
		? `& ${quotePowerShellLiteral(command)}`
		: quotePosixShellWord(command);
}

/** 공백뿐인 설정은 override로 취급하지 않는다. */
function normalizeCliPath(value: string | undefined): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}

	const normalized = value.trim();
	return normalized.length === 0 ? undefined : normalized;
}

/**
 * Windows PTY에서 사용하는 PowerShell executable로 후보의 `--version`을 실행한다.
 * 후보는 single-quoted literal로만 삽입하며 stdout/stderr와 원본 오류는 외부로 내보내지
 * 않는다.
 */
export const probeWindowsAgentCommand: WindowsAgentCommandProbe = (
	command,
	policy,
) => new Promise((resolve) => {
	const quotedCommand = quotePowerShellLiteral(command);
	const script = [
		'$ErrorActionPreference = "Stop"',
		`try { & ${quotedCommand} --version *> $null; if ($?) { exit 0 } } catch {}`,
		'exit 1',
	].join('; ');

	execFile(
		policy.executable,
		['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
		{
			cwd: policy.cwd,
			env: policy.env,
			timeout: WINDOWS_AGENT_PROBE_TIMEOUT_MS,
			windowsHide: true,
			maxBuffer: 64 * 1024,
		},
		(error) => resolve(error === null),
	);
});

/**
 * 설정된 경로와 Windows 기본 후보를 중복 없이 우선순위대로 만든다.
 * override가 기본 이름과 같더라도 안전한 인용 정책을 유지하도록 override 항목을 보존한다.
 */
function buildWindowsAgentCandidates(
	providerId: ProviderId,
	override: string | undefined,
): ReadonlyArray<{ readonly command: string; readonly isOverride: boolean }> {
	const commands: Array<{ command: string; isOverride: boolean }> = [];
	const seen = new Set<string>();

	for (const candidate of [
		...(override === undefined
			? []
			: [{ command: override, isOverride: true }]),
		...WINDOWS_AGENT_COMMAND_CANDIDATES[providerId].map((command) => ({
			command,
			isOverride: false,
		})),
	]) {
		const key = candidate.command.toLocaleLowerCase('en-US');
		if (!seen.has(key)) {
			seen.add(key);
			commands.push(candidate);
		}
	}

	return commands;
}

/** 후보 선택에 영향을 주는 실행 계약만 사용해 resolver cache key를 만든다. */
function windowsAgentCacheKey(
	providerId: ProviderId,
	override: string | undefined,
	policy: ShellLaunchPolicy,
): string {
	return JSON.stringify([
		providerId,
		override,
		policy.executable,
		policy.cwd,
		policy.env.Path,
		policy.env.PATH,
		policy.env.PATHEXT,
	]);
}

/**
 * provider에 배정된 플랫폼 기본 자동 실행 입력을 결정한다.
 * Windows CLI의 실제 후보 탐색은 `createAgentAutoRunInputResolver`가 담당한다.
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

/**
 * Windows에서는 provider 후보별 `--version`을 실제 PowerShell 정책에서 실행해 첫 항목을
 * 고른다. 성공한 결과는 PATH와 override가 같은 세션들에서 재사용한다. 모든 probe가
 * 실패하면 기본 이름을 입력해 Shell이 기존 방식으로 사용자에게 원인을 보여준다.
 */
export function createAgentAutoRunInputResolver(
	options: AgentAutoRunInputResolverOptions = {},
): AgentAutoRunInputResolver {
	const platform = options.platform ?? process.platform;
	const probe = options.probeWindowsCommand ?? probeWindowsAgentCommand;
	const getCliPath = options.getCliPath ?? (() => undefined);
	const cachedWindowsSelections = new Map<string, Promise<{
		readonly command: string;
		readonly isOverride: boolean;
		readonly verified: boolean;
	}>>();

	return async (providerId, policy) => {
		const definition = AGENT_PROVIDER_LAUNCH[providerId];
		const defaultCommand = definition.windowsAutoRunCommand
			?? definition.autoRunCommand;
		if (defaultCommand === undefined) {
			return undefined;
		}
		const override = normalizeCliPath(getCliPath(providerId));

		if (platform !== 'win32') {
			if (override !== undefined) {
				return `${formatOverrideCommand(override, platform)}${AUTO_RUN_SUBMIT_KEY}`;
			}
			return resolveAgentAutoRunInput(providerId, platform);
		}

		const cacheKey = windowsAgentCacheKey(providerId, override, policy);
		let selection = cachedWindowsSelections.get(cacheKey);
		if (selection === undefined) {
			selection = (async () => {
				for (const candidate of buildWindowsAgentCandidates(
					providerId,
					override,
				)) {
					try {
						if (await probe(candidate.command, policy)) {
							return { ...candidate, verified: true };
						}
					} catch {
						/** 한 후보의 probe 실패는 다음 설치 형식 확인으로 이어진다. */
					}
				}

				return {
					command: defaultCommand,
					isOverride: false,
					verified: false,
				};
			})();
			cachedWindowsSelections.set(cacheKey, selection);
		}

		const selected = await selection;
		if (!selected.verified && cachedWindowsSelections.get(cacheKey) === selection) {
			/** 설치나 PATH가 같은 Panel 생명주기 중 바뀐 경우 다음 재시도에서 다시 찾는다. */
			cachedWindowsSelections.delete(cacheKey);
		}
		const command = selected.isOverride
			? formatOverrideCommand(selected.command, platform)
			: selected.command;
		return `${command}${AUTO_RUN_SUBMIT_KEY}`;
	};
}

/** 실제 Extension Host에서 공유하는 표준 resolver다. */
export const resolveDetectedAgentAutoRunInput = createAgentAutoRunInputResolver();
