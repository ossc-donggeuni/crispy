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
import {
	resolveClaudeMcpCompatibility,
	type ClaudeMcpCompatibilityResolver,
} from './claudeCompatibility';

export interface PreparedClaudeTerminalLaunch {
	readonly executable: ResolvedAgentExecutable;
	readonly cwd: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly platform: NodeJS.Platform;
	readonly mcpCompatible: boolean;
}

export type PrepareClaudeTerminalLaunch = (
	tabId: TabId,
	sessionId: SessionId,
	workspaceRootId: WorkspaceRootId,
	signal?: AbortSignal,
) => Promise<
	| { readonly ok: true; readonly preparation: PreparedClaudeTerminalLaunch }
	| Awaited<ReturnType<PrepareTerminalLaunch>> & { readonly ok: false }
>;

export interface PrepareClaudeTerminalLaunchDependencies {
	readonly workspaceResolver: WorkspaceResolver;
	readonly resolveExecutable: AgentExecutableResolver;
	readonly readPlatform: () => NodeJS.Platform;
	readonly readEnvironment: () => NodeJS.ProcessEnv;
	readonly getCliPath?: () => string | undefined;
	readonly resolveCompatibility?: ClaudeMcpCompatibilityResolver;
}

const PROVIDER_START_ERROR = Object.freeze({
	code: 'start_failed' as const,
	message: 'Terminal process could not be started.',
	canRestart: true,
});

/**
 * Resolves the trusted workspace and Claude executable before running the bounded,
 * credential-free compatibility probe. Probe failures disable only MCP and preserve the
 * resolved executable for a bare Claude launch.
 */
export function createPrepareClaudeTerminalLaunch(
	dependencies: PrepareClaudeTerminalLaunchDependencies,
): PrepareClaudeTerminalLaunch {
	const windowsSelections = new Map<
		string,
		ReturnType<AgentExecutableResolver>
	>();
	const resolveCompatibility = dependencies.resolveCompatibility
		?? resolveClaudeMcpCompatibility;

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
				?? dependencies.resolveExecutable('claude', resolutionOptions);
			windowsSelections.set(cacheKey, resolutionPromise);
		} else {
			resolutionPromise = dependencies.resolveExecutable(
				'claude',
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

		let mcpCompatible = false;
		try {
			const compatibility = await resolveCompatibility({
				executable: resolution.executable,
				cwd: workspace.root.fsPath,
				platform,
				environment,
				signal,
			});
			mcpCompatible = compatibility?.compatible === true;
		} catch {
			/** A failed or unreadable probe deliberately falls through to bare Claude. */
		}

		return {
			ok: true,
			preparation: Object.freeze({
				executable: resolution.executable,
				cwd: workspace.root.fsPath,
				environment: Object.freeze({ ...environment }),
				platform,
				mcpCompatible,
			}),
		};
	};
}

function providerStartFailure(
	tabId: TabId,
	sessionId: SessionId,
): Awaited<ReturnType<PrepareClaudeTerminalLaunch>> & { readonly ok: false } {
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
