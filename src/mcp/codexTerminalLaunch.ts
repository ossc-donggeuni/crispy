import { realpath } from 'node:fs/promises';
import * as nodePath from 'node:path';
import type {
	SessionId,
	TabId,
	WorkspaceRootId,
} from '../agent/protocol/messages';
import { buildShellEnv } from '../agent/host/shell/shellResolver';
import type { PrepareTerminalLaunch } from '../agent/host/terminal/prepareTerminalLaunch';
import { mapWorkspaceFailureToTerminalError } from '../agent/host/workspace/workspaceErrorMessage';
import type { WorkspaceResolver } from '../agent/host/workspace/workspaceResolver';
import type {
	AgentExecutableResolver,
	ResolvedAgentExecutable,
} from './agentExecutableResolver';
import type { WorkspaceValidationFailure } from '../agent/host/workspace/types';
import {
	resolveCodexConfigStyle,
	type CodexConfigStyleResolver,
} from './codexCompatibility';
import type { CodexShellEnvironmentPolicyStyle } from './codexConfig';

export interface PreparedCodexTerminalLaunch {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly platform: NodeJS.Platform;
	readonly shellEnvironmentPolicyStyle?: CodexShellEnvironmentPolicyStyle;
}

export type PrepareCodexTerminalLaunch = (
	tabId: TabId,
	sessionId: SessionId,
	workspaceRootId: WorkspaceRootId,
	signal?: AbortSignal,
) => Promise<
	| { readonly ok: true; readonly preparation: PreparedCodexTerminalLaunch }
	| Awaited<ReturnType<PrepareTerminalLaunch>> & { readonly ok: false }
>;

export interface PrepareCodexTerminalLaunchDependencies {
	readonly workspaceResolver: WorkspaceResolver;
	readonly resolveExecutable: AgentExecutableResolver;
	readonly readPlatform: () => NodeJS.Platform;
	readonly readEnvironment: () => NodeJS.ProcessEnv;
	readonly getCliPath?: () => string | undefined;
	readonly resolveConfigStyle?: CodexConfigStyleResolver;
	/** PATH symlink를 Task sandbox 안에서도 재실행 가능한 실제 파일로 고정한다. */
	readonly canonicalizeExecutable?: (executable: string) => Promise<string>;
}

const PROVIDER_START_ERROR = Object.freeze({
	code: 'start_failed' as const,
	message: 'Terminal process could not be started.',
	canRestart: true,
});

/**
 * Resolves the trusted workspace and Codex executable without resolving or spawning an
 * interactive shell. Successful Windows path selections are the only cached values.
 */
export function createPrepareCodexTerminalLaunch(
	dependencies: PrepareCodexTerminalLaunchDependencies,
): PrepareCodexTerminalLaunch {
	const windowsSelections = new Map<
		string,
		ReturnType<AgentExecutableResolver>
	>();
	const resolveConfigStyle = dependencies.resolveConfigStyle
		?? resolveCodexConfigStyle;
	const canonicalizeExecutable = dependencies.canonicalizeExecutable
		?? realpath;

	return async (tabId, sessionId, workspaceRootId, signal) => {
		if (signal?.aborted) {
			return providerStartFailure(tabId, sessionId);
		}
		const workspace = dependencies.workspaceResolver(workspaceRootId);
		if (!workspace.ok) {
			return {
				ok: false,
				error: mapWorkspaceFailureToTerminalError(
					workspace,
					tabId,
					sessionId,
				),
			};
		}

		const platform = dependencies.readPlatform();
		const environment = buildShellEnv(dependencies.readEnvironment());
		const override = dependencies.getCliPath?.();
		const resolutionOptions = { platform, environment, override } as const;
		let resolutionPromise: ReturnType<AgentExecutableResolver>;
		let cacheKey: string | undefined;
		if (platform === 'win32') {
			cacheKey = JSON.stringify([
				override,
				readEnvironmentValue(environment, 'PATH'),
				readEnvironmentValue(environment, 'PATHEXT'),
			]);
			resolutionPromise = windowsSelections.get(cacheKey)
				?? dependencies.resolveExecutable('codex', resolutionOptions);
			windowsSelections.set(cacheKey, resolutionPromise);
		} else {
			resolutionPromise = dependencies.resolveExecutable(
				'codex',
				resolutionOptions,
			);
		}

		let resolution: Awaited<ReturnType<AgentExecutableResolver>>;
		try {
			resolution = await resolutionPromise;
		} catch {
			if (
				cacheKey !== undefined
				&& windowsSelections.get(cacheKey) === resolutionPromise
			) {
				windowsSelections.delete(cacheKey);
			}
			return providerStartFailure(tabId, sessionId);
		}
		if (!resolution.ok) {
			if (
				cacheKey !== undefined
				&& windowsSelections.get(cacheKey) === resolutionPromise
			) {
				windowsSelections.delete(cacheKey);
			}
			return providerStartFailure(tabId, sessionId);
		}
		if (signal?.aborted) {
			return providerStartFailure(tabId, sessionId);
		}
		const executable = await canonicalizeResolvedExecutable(
			resolution.executable,
			platform,
			canonicalizeExecutable,
		);

		let shellEnvironmentPolicyStyle: CodexShellEnvironmentPolicyStyle | undefined;
		let probeWorkspaceFailure: WorkspaceValidationFailure | undefined;
		let probeWorkspaceReadFailed = false;
		let probeWorkspaceCwd = workspace.root.fsPath;
		try {
			shellEnvironmentPolicyStyle = await resolveConfigStyle({
				executable,
				cwd: workspace.root.fsPath,
				platform,
				environment,
				signal,
				resolveWorkspaceCwdBeforeSpawn: () => {
					if (signal?.aborted) {
						return undefined;
					}
					try {
						const freshWorkspace = dependencies.workspaceResolver(workspaceRootId);
						if (!freshWorkspace.ok) {
							probeWorkspaceFailure = freshWorkspace;
							return undefined;
						}
						probeWorkspaceCwd = freshWorkspace.root.fsPath;
						return probeWorkspaceCwd;
					} catch {
						probeWorkspaceReadFailed = true;
						return undefined;
					}
				},
			});
		} catch {
			/** An unreadable Codex version disables MCP but leaves bare Codex available. */
		}
		if (signal?.aborted || probeWorkspaceReadFailed) {
			return providerStartFailure(tabId, sessionId);
		}
		if (probeWorkspaceFailure !== undefined) {
			return {
				ok: false,
				error: mapWorkspaceFailureToTerminalError(
					probeWorkspaceFailure,
					tabId,
					sessionId,
				),
			};
		}

		return {
			ok: true,
			preparation: Object.freeze({
				executable,
				cwd: probeWorkspaceCwd,
				environment: Object.freeze({ ...environment }),
				platform,
				...(shellEnvironmentPolicyStyle === undefined
					? {}
					: { shellEnvironmentPolicyStyle }),
			}),
		};
	};
}

/**
 * Codex app-server는 초기 thread 생성 중 현재 CLI를 sandbox 안에서 다시 실행한다.
 * macOS의 restricted filesystem profile은 PATH symlink의 exec를 거부할 수 있으므로,
 * spawn과 Task runtime read grant가 같은 canonical executable을 사용하게 한다.
 */
async function canonicalizeResolvedExecutable(
	executable: ResolvedAgentExecutable,
	platform: NodeJS.Platform,
	canonicalize: (path: string) => Promise<string>,
): Promise<ResolvedAgentExecutable> {
	try {
		const canonicalPath = await canonicalize(executable.executable);
		const pathApi = platform === 'win32' ? nodePath.win32 : nodePath.posix;
		if (
			!pathApi.isAbsolute(canonicalPath)
			|| canonicalPath.includes('\0')
		) {
			return executable;
		}
		return Object.freeze({
			...executable,
			executable: canonicalPath,
		});
	} catch {
		/** 실행 파일 교체 race는 기존 검증된 후보로 귀결되어 상위 start 오류로 처리된다. */
		return executable;
	}
}

function providerStartFailure(
	tabId: TabId,
	sessionId: SessionId,
): Awaited<ReturnType<PrepareCodexTerminalLaunch>> & { readonly ok: false } {
	return {
		ok: false,
		error: {
			type: 'terminal.error',
			tabId,
			sessionId,
			...PROVIDER_START_ERROR,
		},
	};
}

function readEnvironmentValue(
	environment: NodeJS.ProcessEnv,
	name: string,
): string | undefined {
	const expected = name.toLocaleUpperCase('en-US');
	for (const [candidate, value] of Object.entries(environment)) {
		if (candidate.toLocaleUpperCase('en-US') === expected) {
			return value;
		}
	}
	return undefined;
}
