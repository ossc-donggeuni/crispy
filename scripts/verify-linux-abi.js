'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nodePtyRuntimeDependency } = require('./runtime-dependencies');

const repositoryRoot = path.resolve(__dirname, '..');
const linuxArtifacts = nodePtyRuntimeDependency.staging.artifactsByTarget['linux-x64'];
const binaryRelativePath = linuxArtifacts.find((artifactPath) => artifactPath.endsWith('/pty.node'));

if (binaryRelativePath === undefined) {
	throw new Error('[verify-linux-abi] linux-x64 pty.node is missing from the runtime contract.');
}

const binaryPath = path.join(
	repositoryRoot,
	'dist',
	'node_modules',
	'node-pty',
	binaryRelativePath,
);
const baselines = Object.freeze({ GLIBC: '2.28', GLIBCXX: '3.4.25' });

function compareVersions(left, right) {
	const leftParts = left.split('.').map(Number);
	const rightParts = right.split('.').map(Number);
	const length = Math.max(leftParts.length, rightParts.length);

	for (let index = 0; index < length; index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

function main() {
	if (process.platform !== 'linux' || process.arch !== 'x64') {
		throw new Error(`[verify-linux-abi] expected linux-x64 host, actual=${process.platform}-${process.arch}`);
	}
	if (!fs.existsSync(binaryPath)) {
		throw new Error(`[verify-linux-abi] staged pty.node is missing: ${binaryPath}`);
	}

	const result = spawnSync('readelf', ['--version-info', binaryPath], {
		encoding: 'utf8',
		maxBuffer: 4 * 1024 * 1024,
	});
	if (result.error !== undefined) {
		throw new Error('[verify-linux-abi] readelf could not inspect pty.node.', { cause: result.error });
	}
	if (result.status !== 0) {
		throw new Error(`[verify-linux-abi] readelf failed with exit=${result.status}: ${result.stderr}`);
	}

	for (const [family, baseline] of Object.entries(baselines)) {
		const pattern = new RegExp(`\\b${family}_(\\d+(?:\\.\\d+)+)\\b`, 'g');
		const versions = [...result.stdout.matchAll(pattern)].map((match) => match[1]);
		const excessive = versions.filter((version) => compareVersions(version, baseline) > 0);
		if (excessive.length > 0) {
			const highest = excessive.sort(compareVersions).at(-1);
			throw new Error(`[verify-linux-abi] ${family} baseline exceeded: expected <= ${baseline}, actual=${highest}`);
		}
		const highest = versions.sort(compareVersions).at(-1) ?? '<none>';
		console.log(`[verify-linux-abi] ${family} maximum=${highest}, baseline<=${baseline}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
}
