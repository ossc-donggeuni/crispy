import type { SpawnOptions } from 'node:child_process';
import type { ProviderId } from '../agent/protocol/providers';

export const MCP_PROVIDER_ENVIRONMENT_REMOVALS = Object.freeze([
	'CRISPY_MCP_TOKEN',
	'ELECTRON_RUN_AS_NODE',
] as const);

const WINDOWS_CMD_META_CHARACTERS = /([()\][%!^"`<>&|;, *?])/g;

export type AgentLauncherKind = 'direct' | 'cmd-one-shot';

/** Host-only provider launch contract. It is never exposed to the Webview. */
export interface AgentLaunchPlan {
	readonly providerId: ProviderId;
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly envOverlay: Readonly<Record<string, string>>;
	readonly envRemove: readonly string[];
	readonly launcherKind: AgentLauncherKind;
	readonly expectsMcp: boolean;
	readonly mcpServerName?: string;
}

/** Concrete process request produced only immediately before spawn. */
export interface AgentProcessSpawnRequest {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly environment: Readonly<Record<string, string>>;
	readonly windowsVerbatimArguments: boolean;
}

export interface CreateAgentProcessSpawnRequestOptions {
	readonly platform?: NodeJS.Platform;
	readonly environment: NodeJS.ProcessEnv;
}

/**
 * Base environment and a plan are combined at the final spawn boundary. Removed names and
 * overlay replacement are case-insensitive on Windows so stale credential casing cannot win.
 */
export function createAgentProcessEnvironment(
	plan: AgentLaunchPlan,
	baseEnvironment: NodeJS.ProcessEnv,
	platform: NodeJS.Platform = process.platform,
): Readonly<Record<string, string>> {
	const keyForOverlay = (name: string): string =>
		name.toLocaleUpperCase('en-US');
	const removed = new Set([
		...MCP_PROVIDER_ENVIRONMENT_REMOVALS,
		...plan.envRemove,
	].map(
		(name) => name.toLocaleUpperCase('en-US'),
	));
	const allowedOverlayEntries = Object.entries(plan.envOverlay).filter(
		([name]) => {
			const normalized = keyForOverlay(name);
			if (normalized === 'ELECTRON_RUN_AS_NODE') {
				return false;
			}
			return normalized !== 'CRISPY_MCP_TOKEN'
				|| (plan.expectsMcp && name === 'CRISPY_MCP_TOKEN');
		},
	);
	const overlayNames = new Set(allowedOverlayEntries.map(([name]) =>
		keyForOverlay(name)
	));
	const environment: Record<string, string> = {};

	for (const [name, value] of Object.entries(baseEnvironment)) {
		if (
			typeof value !== 'string'
			|| removed.has(name.toLocaleUpperCase('en-US'))
			|| overlayNames.has(keyForOverlay(name))
		) {
			continue;
		}
		environment[name] = value;
	}
	for (const [name, value] of allowedOverlayEntries) {
		if (typeof value !== 'string') {
			throw new Error('Agent launch environment is invalid.');
		}
		environment[name] = value;
	}

	return Object.freeze(environment);
}

/** Converts the provider plan into a direct or cmd.exe one-shot process invocation. */
export function createAgentProcessSpawnRequest(
	plan: AgentLaunchPlan,
	options: CreateAgentProcessSpawnRequestOptions,
): AgentProcessSpawnRequest {
	const platform = options.platform ?? process.platform;
	const environment = createAgentProcessEnvironment(
		plan,
		options.environment,
		platform,
	);
	if (plan.launcherKind === 'direct') {
		return Object.freeze({
			executable: plan.executable,
			args: Object.freeze([...plan.args]),
			cwd: plan.cwd,
			environment,
			windowsVerbatimArguments: false,
		});
	}
	if (platform !== 'win32') {
		throw new Error('Agent launcher is unsupported on this platform.');
	}

	const comSpec = readEnvironmentValue(options.environment, 'ComSpec');
	if (comSpec === undefined || comSpec.trim().length === 0) {
		throw new Error('Windows command processor is unavailable.');
	}
	const shellCommand = [
		escapeWindowsCmdCommand(plan.executable),
		...plan.args.map((argument) => escapeWindowsCmdArgument(argument)),
	].join(' ');

	return Object.freeze({
		executable: comSpec,
		args: Object.freeze(['/d', '/s', '/v:off', '/c', `"${shellCommand}"`]),
		cwd: plan.cwd,
		environment,
		windowsVerbatimArguments: true,
	});
}

/** child_process spawn options shared by the C3 smoke and the later PTY adapter. */
export function createAgentProcessSpawnOptions(
	request: AgentProcessSpawnRequest,
): SpawnOptions {
	return {
		cwd: request.cwd,
		env: request.environment,
		stdio: ['ignore', 'ignore', 'ignore'],
		shell: false,
		windowsHide: true,
		windowsVerbatimArguments: request.windowsVerbatimArguments,
	};
}

function readEnvironmentValue(
	environment: NodeJS.ProcessEnv,
	name: string,
): string | undefined {
	const expected = name.toLocaleUpperCase('en-US');
	for (const [candidate, value] of Object.entries(environment)) {
		if (
			candidate.toLocaleUpperCase('en-US') === expected
			&& typeof value === 'string'
		) {
			return value;
		}
	}
	return undefined;
}

/** cmd.exe command token escaping; raw quotes in executable paths are rejected by the resolver. */
function escapeWindowsCmdCommand(value: string): string {
	return value.replace(WINDOWS_CMD_META_CHARACTERS, '^$1');
}

/**
 * Quotes an argument for the cmd.exe parse and the npm .cmd shim parse. The second meta escape
 * keeps characters literal when the shim forwards `%*` to the native Codex executable.
 */
function escapeWindowsCmdArgument(value: string): string {
	let escaped = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
	escaped = escaped.replace(/(?=(\\+?)?)\1$/g, '$1$1');
	escaped = `"${escaped}"`;
	escaped = escaped.replace(WINDOWS_CMD_META_CHARACTERS, '^$1');
	return escaped.replace(WINDOWS_CMD_META_CHARACTERS, '^$1');
}
