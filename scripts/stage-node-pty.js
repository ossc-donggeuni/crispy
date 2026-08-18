'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
	nodePtyRuntimeDependency,
} = require('./runtime-dependencies');

const repositoryRoot = path.resolve(__dirname, '..');
const stagedPackageRoot = path.join(
	repositoryRoot,
	'dist',
	'node_modules',
	'node-pty',
);
const { version, artifactsByTarget } = nodePtyRuntimeDependency.staging;
const supportedTargets = Object.freeze(Object.keys(artifactsByTarget));

function stagingError(target, reason, problemPath, expected, actual, cause) {
	const details = [
		`[stage-node-pty] target=${String(target)} failed: ${reason}`,
		`[stage-node-pty] path=${problemPath}`,
	];

	if (expected !== undefined) {
		details.push(`[stage-node-pty] expected=${expected}`);
	}

	if (actual !== undefined) {
		details.push(`[stage-node-pty] actual=${actual}`);
	}

	const error = new Error(details.join('\n'));

	if (cause !== undefined) {
		error.cause = cause;
	}

	return error;
}

function requireTarget() {
	const target = process.env.CRISPY_VSIX_TARGET;

	if (target === undefined || target === '') {
		throw stagingError(
			target,
			'CRISPY_VSIX_TARGET is required',
			'CRISPY_VSIX_TARGET',
			supportedTargets.join(', '),
			target === undefined ? '<unset>' : '<empty>',
		);
	}

	if (!Object.hasOwn(artifactsByTarget, target)) {
		throw stagingError(
			target,
			'unsupported VSIX target',
			'CRISPY_VSIX_TARGET',
			supportedTargets.join(', '),
			target,
		);
	}

	const hostTarget = `${process.platform}-${process.arch}`;

	if (target !== hostTarget) {
		throw stagingError(
			target,
			'cross-target staging is not supported',
			'CRISPY_VSIX_TARGET',
			hostTarget,
			target,
		);
	}

	return target;
}

function resolveInstalledPackageRoot(target) {
	let packageJsonPath;

	try {
		packageJsonPath = require.resolve('node-pty/package.json', {
			paths: [repositoryRoot],
		});
	} catch (error) {
		throw stagingError(
			target,
			'could not resolve the installed node-pty package',
			path.join(repositoryRoot, 'node_modules', 'node-pty', 'package.json'),
			'installed node-pty/package.json',
			'missing or unresolvable',
			error,
		);
	}

	return path.dirname(packageJsonPath);
}

function readPackageJson(target, packageJsonPath) {
	try {
		return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	} catch (error) {
		throw stagingError(
			target,
			'could not read node-pty/package.json',
			packageJsonPath,
			'valid JSON',
			'unreadable or invalid JSON',
			error,
		);
	}
}

function copyEntry(target, packageRoot, relativePath, expectedKind) {
	const sourcePath = path.join(packageRoot, relativePath);
	const destinationPath = path.join(stagedPackageRoot, relativePath);
	let sourceStat;

	try {
		sourceStat = fs.statSync(sourcePath);
	} catch (error) {
		throw stagingError(
			target,
			'required source entry is missing',
			sourcePath,
			'file or directory',
			'missing',
			error,
		);
	}

	const actualKind = sourceStat.isFile()
		? 'file'
		: sourceStat.isDirectory() ? 'directory' : `mode=${sourceStat.mode.toString(8)}`;

	if ((expectedKind === 'file' && !sourceStat.isFile())
		|| (expectedKind === 'directory' && !sourceStat.isDirectory())) {
		throw stagingError(
			target,
			'required source entry has the wrong type',
			sourcePath,
			expectedKind,
			actualKind,
		);
	}

	try {
		fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
		fs.cpSync(sourcePath, destinationPath, {
			recursive: true,
			dereference: true,
		});
	} catch (error) {
		throw stagingError(
			target,
			'could not copy runtime entry',
			destinationPath,
			`copy of ${sourcePath}`,
			'copy failed',
			error,
		);
	}
}

function assertRealTree(target, directoryPath) {
	for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
		const entryPath = path.join(directoryPath, entry.name);
		const entryStat = fs.lstatSync(entryPath);

		if (entryStat.isSymbolicLink()) {
			throw stagingError(
				target,
				'staged runtime must not contain symbolic links',
				entryPath,
				'real file or directory',
				'symbolic link',
			);
		}

		if (entryStat.isDirectory()) {
			assertRealTree(target, entryPath);
			continue;
		}

		if (!entryStat.isFile()) {
			throw stagingError(
				target,
				'staged runtime contains a non-regular entry',
				entryPath,
				'regular file',
				`mode=${entryStat.mode.toString(8)}`,
			);
		}
	}
}

function normalizeMacOsHelper(target, artifactPaths) {
	const helperRelativePath = artifactPaths.find(
		(artifactPath) => artifactPath.endsWith('/spawn-helper'),
	);

	if (helperRelativePath === undefined) {
		throw stagingError(
			target,
			'macOS target contract has no spawn-helper',
			stagedPackageRoot,
			'spawn-helper artifact',
			'missing from contract',
		);
	}

	const helperPath = path.join(stagedPackageRoot, helperRelativePath);

	try {
		const helperStat = fs.statSync(helperPath);
		fs.chmodSync(helperPath, helperStat.mode | 0o111);
	} catch (error) {
		throw stagingError(
			target,
			'could not normalize spawn-helper permission',
			helperPath,
			'existing mode with execute bits',
			'chmod failed',
			error,
		);
	}
}

function main() {
	const target = requireTarget();
	const packageRoot = resolveInstalledPackageRoot(target);
	const packageJsonPath = path.join(packageRoot, 'package.json');
	const packageJson = readPackageJson(target, packageJsonPath);

	if (packageJson.version !== version) {
		throw stagingError(
			target,
			'installed node-pty version does not match the runtime contract',
			packageJsonPath,
			version,
			String(packageJson.version),
		);
	}

	fs.rmSync(stagedPackageRoot, { recursive: true, force: true });
	fs.mkdirSync(stagedPackageRoot, { recursive: true });

	copyEntry(target, packageRoot, 'package.json', 'file');
	copyEntry(target, packageRoot, 'LICENSE', 'file');
	copyEntry(target, packageRoot, 'lib', 'directory');

	const artifactPaths = artifactsByTarget[target];

	for (const artifactPath of artifactPaths) {
		copyEntry(target, packageRoot, artifactPath, 'file');
	}

	if (target.startsWith('darwin-')) {
		normalizeMacOsHelper(target, artifactPaths);
	}

	assertRealTree(target, stagedPackageRoot);

	console.log(
		`[stage-node-pty] Staged node-pty@${version} for ${target} at ${stagedPackageRoot}.`,
	);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
