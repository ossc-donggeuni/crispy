import { constants as filesystemConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderId, ProviderRegistry } from '../agent/protocol/providers';
import type { AgentLauncherKind } from './agentLaunchPlan';

const AGENT_EXECUTABLE_NAMES: ProviderRegistry<string> = Object.freeze({
	codex: 'codex',
	claude: 'claude',
	antigravity: 'agy',
});
const DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS = Object.freeze(['.EXE', '.CMD']);

export type AgentExecutableResolutionFailureReason =
	| 'invalid_override'
	| 'provider_unavailable'
	| 'unsupported_platform';

export interface ResolvedAgentExecutable {
	readonly executable: string;
	readonly launcherKind: AgentLauncherKind;
}

export type AgentExecutableResolution =
	| { readonly ok: true; readonly executable: ResolvedAgentExecutable }
	| { readonly ok: false; readonly reason: AgentExecutableResolutionFailureReason };

export interface ResolveAgentExecutableOptions {
	readonly platform?: NodeJS.Platform;
	readonly environment?: NodeJS.ProcessEnv;
	readonly override?: string;
	readonly isExecutableFile?: (
		candidate: string,
		platform: NodeJS.Platform,
	) => Promise<boolean>;
}

export type AgentExecutableResolver = (
	providerId: ProviderId,
	options?: ResolveAgentExecutableOptions,
) => Promise<AgentExecutableResolution>;

/** Resolves an executable path without creating a shell command string. */
export const resolveAgentExecutable: AgentExecutableResolver = async (
	providerId,
	options = {},
) => {
	const platform = options.platform ?? process.platform;
	if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
		return Object.freeze({ ok: false, reason: 'unsupported_platform' });
	}
	const environment = options.environment ?? process.env;
	const isExecutableFile = options.isExecutableFile ?? defaultIsExecutableFile;
	const override = normalizeOverride(options.override, platform);
	if (!override.ok) {
		return override;
	}

	const candidates = buildExecutableCandidates(
		AGENT_EXECUTABLE_NAMES[providerId],
		override.value,
		platform,
		environment,
	);
	if (candidates === undefined) {
		return Object.freeze({ ok: false, reason: 'invalid_override' });
	}
	for (const candidate of candidates) {
		try {
			if (await isExecutableFile(candidate.executable, platform)) {
				return Object.freeze({
					ok: true,
					executable: Object.freeze(candidate),
				});
			}
		} catch {
			/** One inaccessible candidate does not expose its path or block later candidates. */
		}
	}
	return Object.freeze({ ok: false, reason: 'provider_unavailable' });
};

function normalizeOverride(
	value: string | undefined,
	platform: NodeJS.Platform,
): { readonly ok: true; readonly value?: string } | {
	readonly ok: false;
	readonly reason: 'invalid_override';
} {
	if (value === undefined || value.trim().length === 0) {
		return Object.freeze({ ok: true });
	}
	const normalized = value.trim();
	if (
		normalized.includes('\0')
		|| (platform === 'win32' && normalized.includes('"'))
	) {
		return Object.freeze({ ok: false, reason: 'invalid_override' });
	}
	return Object.freeze({ ok: true, value: normalized });
}

function buildExecutableCandidates(
	defaultName: string,
	override: string | undefined,
	platform: 'darwin' | 'linux' | 'win32',
	environment: NodeJS.ProcessEnv,
): readonly ResolvedAgentExecutable[] | undefined {
	const pathApi = platform === 'win32' ? path.win32 : path.posix;
	const searchPath = readEnvironmentValue(environment, 'PATH', platform);
	const directories = searchPath === undefined
		? []
		: searchPath.split(platform === 'win32' ? ';' : ':').filter(Boolean);
	const requested = override ?? defaultName;

	if (platform === 'win32') {
		const extension = path.win32.extname(requested).toLocaleUpperCase('en-US');
		if (extension !== '' && extension !== '.EXE' && extension !== '.CMD') {
			return undefined;
		}
		const extensions = extension === ''
			? readWindowsExecutableExtensions(environment)
			: [extension];
		const basePaths = pathApi.isAbsolute(requested)
			? [requested]
			: directories.map((directory) => pathApi.join(directory, requested));
		return Object.freeze(basePaths.flatMap((basePath) => extensions.map(
			(candidateExtension): ResolvedAgentExecutable => {
				const executable = extension === ''
					? `${basePath}${candidateExtension.toLocaleLowerCase('en-US')}`
					: basePath;
				return Object.freeze({
					executable,
					launcherKind: candidateExtension === '.CMD'
						? 'cmd-one-shot'
						: 'direct',
				});
			},
		)));
	}

	const basePaths = pathApi.isAbsolute(requested)
		? [requested]
		: directories.map((directory) => pathApi.join(directory, requested));
	return Object.freeze(basePaths.map((executable) => Object.freeze({
		executable,
		launcherKind: 'direct' as const,
	})));
}

function readWindowsExecutableExtensions(
	environment: NodeJS.ProcessEnv,
): readonly string[] {
	const configured = readEnvironmentValue(environment, 'PATHEXT', 'win32');
	const extensions = (configured?.split(';') ?? DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS)
		.map((extension) => extension.trim().toLocaleUpperCase('en-US'))
		.filter((extension) => extension === '.EXE' || extension === '.CMD');
	return extensions.length === 0
		? DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS
		: Object.freeze([...new Set(extensions)]);
}

function readEnvironmentValue(
	environment: NodeJS.ProcessEnv,
	name: string,
	platform: NodeJS.Platform,
): string | undefined {
	if (platform !== 'win32') {
		return environment[name];
	}
	const expected = name.toLocaleUpperCase('en-US');
	for (const [candidate, value] of Object.entries(environment)) {
		if (candidate.toLocaleUpperCase('en-US') === expected) {
			return value;
		}
	}
	return undefined;
}

async function defaultIsExecutableFile(
	candidate: string,
	platform: NodeJS.Platform,
): Promise<boolean> {
	const metadata = await stat(candidate);
	if (!metadata.isFile()) {
		return false;
	}
	await access(
		candidate,
		platform === 'win32' ? filesystemConstants.F_OK : filesystemConstants.X_OK,
	);
	return true;
}
