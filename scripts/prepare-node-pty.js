'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
	nodePtyRuntimeDependency,
} = require('./runtime-dependencies');

const repositoryRoot = path.resolve(__dirname, '..');
const target = `${process.platform}-${process.arch}`;
const { version, artifactsByTarget } = nodePtyRuntimeDependency.staging;
const supportedTargets = Object.freeze(Object.keys(artifactsByTarget));

function preparationError(reason, problemPath, cause) {
	const error = new Error([
		`[prepare-node-pty] target=${target} failed: ${reason}`,
		`[prepare-node-pty] path=${problemPath}`,
	].join('\n'));

	if (cause !== undefined) {
		error.cause = cause;
	}

	return error;
}

function resolveNodePtyPackageJson() {
	try {
		return require.resolve('node-pty/package.json', {
			paths: [repositoryRoot],
		});
	} catch (error) {
		throw preparationError(
			'could not resolve the installed node-pty package',
			path.join(repositoryRoot, 'node_modules', 'node-pty', 'package.json'),
			error,
		);
	}
}

function readPackageJson(packageJsonPath) {
	try {
		return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	} catch (error) {
		throw preparationError(
			'could not read node-pty/package.json',
			packageJsonPath,
			error,
		);
	}
}

function requireArtifact(artifactPath) {
	let artifactStat;

	try {
		artifactStat = fs.statSync(artifactPath);
	} catch (error) {
		throw preparationError(
			'required source artifact is missing',
			artifactPath,
			error,
		);
	}

	if (!artifactStat.isFile()) {
		throw preparationError(
			'required source artifact is not a file',
			artifactPath,
		);
	}
}

function prepareMacOsSpawnHelper(packageRoot, artifactPaths) {
	const helperRelativePath = artifactPaths.find(
		(artifactPath) => artifactPath.endsWith('/spawn-helper'),
	);

	if (helperRelativePath === undefined) {
		throw preparationError(
			'the target contract has no macOS spawn-helper',
			packageRoot,
		);
	}

	const helperPath = path.join(packageRoot, helperRelativePath);

	try {
		fs.chmodSync(helperPath, 0o755);
	} catch (error) {
		throw preparationError(
			'could not set spawn-helper mode to 0755',
			helperPath,
			error,
		);
	}

	let helperStat;

	try {
		helperStat = fs.statSync(helperPath);
	} catch (error) {
		throw preparationError(
			'could not inspect spawn-helper mode',
			helperPath,
			error,
		);
	}

	const helperMode = helperStat.mode & 0o777;

	if (helperMode !== 0o755 || (helperMode & 0o111) === 0) {
		throw preparationError(
			`spawn-helper is not executable after chmod (mode=${helperMode.toString(8)})`,
			helperPath,
		);
	}

	try {
		fs.accessSync(helperPath, fs.constants.X_OK);
	} catch (error) {
		throw preparationError(
			'spawn-helper failed the X_OK access check',
			helperPath,
			error,
		);
	}
}

function main() {
	const artifactPaths = artifactsByTarget[target];

	if (artifactPaths === undefined) {
		console.warn([
			`[prepare-node-pty] Unsupported host target: ${target}.`,
			`[prepare-node-pty] Supported targets: ${supportedTargets.join(', ')}.`,
		].join('\n'));
		return;
	}

	const packageJsonPath = resolveNodePtyPackageJson();
	const packageRoot = path.dirname(packageJsonPath);
	const packageJson = readPackageJson(packageJsonPath);

	if (packageJson.version !== version) {
		throw preparationError(
			`expected node-pty version ${version}, found ${String(packageJson.version)}`,
			packageJsonPath,
		);
	}

	for (const artifactPath of artifactPaths) {
		requireArtifact(path.join(packageRoot, artifactPath));
	}

	if (process.platform === 'darwin') {
		prepareMacOsSpawnHelper(packageRoot, artifactPaths);
	}

	console.log(
		`[prepare-node-pty] Prepared node-pty@${version} for ${target}.`,
	);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
