export const AGENT_ACTIVITY_MINIMUM_VSCODE_VERSION = '1.125.0';

export interface StableVscodeVersion {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly version: string;
}

interface ParsedVscodeVersion extends StableVscodeVersion {
	readonly prerelease?: string;
}

const VSCODE_VERSION_PATTERN =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

const MINIMUM_VSCODE_VERSION = Object.freeze({
	major: 1,
	minor: 125,
	patch: 0,
});

function hasCanonicalPrereleaseIdentifiers(prerelease: string): boolean {
	return prerelease.split('.').every((identifier) =>
		!/^(?:0\d+)$/u.test(identifier),
	);
}

function parseVscodeVersion(value: string): ParsedVscodeVersion | undefined {
	const match = VSCODE_VERSION_PATTERN.exec(value);
	if (match === null) {
		return undefined;
	}

	const major = Number(match[1]);
	const minor = Number(match[2]);
	const patch = Number(match[3]);
	if (![major, minor, patch].every(Number.isSafeInteger)) {
		return undefined;
	}

	const prerelease = match[4];
	if (prerelease !== undefined
		&& !hasCanonicalPrereleaseIdentifiers(prerelease)) {
		return undefined;
	}

	const stableVersion = `${major}.${minor}.${patch}`;
	const version = prerelease === undefined
		? stableVersion
		: `${stableVersion}-${prerelease}`;
	if (version !== value) {
		return undefined;
	}

	return Object.freeze({
		major,
		minor,
		patch,
		version,
		...(prerelease === undefined ? {} : { prerelease }),
	});
}

/**
 * Parses only a canonical stable three-component VS Code version.
 */
export function parseStableVscodeVersion(
	value: string,
): StableVscodeVersion | undefined {
	const parsed = parseVscodeVersion(value);
	if (parsed === undefined || parsed.prerelease !== undefined) {
		return undefined;
	}

	return parsed;
}

function compareCoreVersionToMinimum(version: ParsedVscodeVersion): number {
	for (const key of ['major', 'minor', 'patch'] as const) {
		const difference = version[key] - MINIMUM_VSCODE_VERSION[key];
		if (difference !== 0) {
			return difference;
		}
	}

	return 0;
}

/**
 * Mirrors the declared `^1.125.0` Host support policy. Canonical prerelease
 * Hosts are enabled only when their core version is newer than the minimum
 * stable release; a prerelease of the minimum itself still precedes it.
 */
export function isAgentActivityVscodeVersionAllowed(version: string): boolean {
	const parsed = parseVscodeVersion(version);
	if (parsed === undefined || parsed.major !== MINIMUM_VSCODE_VERSION.major) {
		return false;
	}

	const minimumComparison = compareCoreVersionToMinimum(parsed);
	return minimumComparison > 0
		|| (minimumComparison === 0 && parsed.prerelease === undefined);
}
