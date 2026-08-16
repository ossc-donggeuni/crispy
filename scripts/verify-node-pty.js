'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const {
	nodePtyRuntimeDependency,
} = require('./runtime-dependencies');
const { verifyNativeBinary } = require('./native-binary');
const { isPathInside, runPtySmoke } = require('./pty-smoke');

const repositoryRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repositoryRoot, 'dist');
const stagedPackageRoot = path.join(distRoot, 'node_modules', 'node-pty');
const { version, artifactsByTarget } = nodePtyRuntimeDependency.staging;
const supportedTargets = Object.freeze(Object.keys(artifactsByTarget));
const isolatedSmokeFlag = '--isolated-runtime-smoke';

function verificationError(target, reason, problemPath, expected, actual, cause) {
	const details = [
		`[verify-node-pty] target=${String(target)} failed: ${reason}`,
		`[verify-node-pty] path=${problemPath}`,
	];

	if (expected !== undefined) {
		details.push(`[verify-node-pty] expected=${expected}`);
	}

	if (actual !== undefined) {
		details.push(`[verify-node-pty] actual=${actual}`);
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
		throw verificationError(
			target,
			'CRISPY_VSIX_TARGET is required',
			'CRISPY_VSIX_TARGET',
			supportedTargets.join(', '),
			target === undefined ? '<unset>' : '<empty>',
		);
	}

	if (!Object.hasOwn(artifactsByTarget, target)) {
		throw verificationError(
			target,
			'unsupported VSIX target',
			'CRISPY_VSIX_TARGET',
			supportedTargets.join(', '),
			target,
		);
	}

	const hostTarget = `${process.platform}-${process.arch}`;

	if (target !== hostTarget) {
		throw verificationError(
			target,
			'cross-target verification is not supported',
			'CRISPY_VSIX_TARGET',
			hostTarget,
			target,
		);
	}

	return target;
}

function requireRegularFile(target, filePath) {
	let fileStat;

	try {
		fileStat = fs.lstatSync(filePath);
	} catch (error) {
		throw verificationError(
			target,
			'required staged file is missing',
			filePath,
			'regular file',
			'missing',
			error,
		);
	}

	if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
		throw verificationError(
			target,
			'required staged artifact is not a regular file',
			filePath,
			'regular file',
			fileStat.isSymbolicLink() ? 'symbolic link' : `mode=${fileStat.mode.toString(8)}`,
		);
	}

	return fileStat;
}

function requireRealDirectory(target, directoryPath) {
	let directoryStat;

	try {
		directoryStat = fs.lstatSync(directoryPath);
	} catch (error) {
		throw verificationError(
			target,
			'required staged directory is missing',
			directoryPath,
			'real directory',
			'missing',
			error,
		);
	}

	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
		throw verificationError(
			target,
			'required staged entry is not a real directory',
			directoryPath,
			'real directory',
			directoryStat.isSymbolicLink() ? 'symbolic link' : `mode=${directoryStat.mode.toString(8)}`,
		);
	}
}

function artifactAncestorPaths(artifactPaths) {
	const ancestors = new Set();

	for (const artifactPath of artifactPaths) {
		let parent = path.posix.dirname(artifactPath);

		while (parent !== '.') {
			ancestors.add(parent);
			parent = path.posix.dirname(parent);
		}
	}

	return ancestors;
}

function verifyAllowlistedTree(target, artifactPaths) {
	const allowedArtifacts = new Set(artifactPaths);
	const allowedArtifactDirectories = artifactAncestorPaths(artifactPaths);

	function visit(directoryPath, relativeDirectory) {
		for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
			const relativePath = relativeDirectory === ''
				? entry.name
				: `${relativeDirectory}/${entry.name}`;
			const entryPath = path.join(directoryPath, entry.name);
			const entryStat = fs.lstatSync(entryPath);

			if (entryStat.isSymbolicLink()) {
				throw verificationError(
					target,
					'staged runtime contains a symbolic link',
					entryPath,
					'real file or directory',
					'symbolic link',
				);
			}

			const isNeutralPath = relativePath === 'lib' || relativePath.startsWith('lib/');

			if (entryStat.isDirectory()) {
				if (!isNeutralPath && !allowedArtifactDirectories.has(relativePath)) {
					throw verificationError(
						target,
						'unexpected staged directory',
						entryPath,
						'target allowlist only',
						relativePath,
					);
				}

				visit(entryPath, relativePath);
				continue;
			}

			if (!entryStat.isFile()) {
				throw verificationError(
					target,
					'staged runtime contains a non-regular entry',
					entryPath,
					'regular file',
					`mode=${entryStat.mode.toString(8)}`,
				);
			}

			const isNeutralFile = relativePath === 'package.json'
				|| relativePath === 'LICENSE'
				|| relativePath.startsWith('lib/');

			if (!isNeutralFile && !allowedArtifacts.has(relativePath)) {
				throw verificationError(
					target,
					'unexpected staged file',
					entryPath,
					'target allowlist only',
					relativePath,
				);
			}
		}
	}

	requireRealDirectory(target, stagedPackageRoot);
	visit(stagedPackageRoot, '');
}

function verifyNativeHeaders(target, artifactPaths) {
	for (const artifactPath of artifactPaths) {
		const stagedArtifactPath = path.join(stagedPackageRoot, artifactPath);
		verifyNativeBinary(target, artifactPath, fs.readFileSync(stagedArtifactPath));
	}
}

function verifyStaticRuntime(target) {
	const packageJsonPath = path.join(stagedPackageRoot, 'package.json');
	requireRegularFile(target, packageJsonPath);
	requireRegularFile(target, path.join(stagedPackageRoot, 'LICENSE'));
	requireRealDirectory(target, path.join(stagedPackageRoot, 'lib'));

	let packageJson;

	try {
		packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
	} catch (error) {
		throw verificationError(
			target,
			'could not parse staged package.json',
			packageJsonPath,
			'valid JSON',
			'unreadable or invalid JSON',
			error,
		);
	}

	if (packageJson.version !== version) {
		throw verificationError(
			target,
			'staged node-pty version mismatch',
			packageJsonPath,
			version,
			String(packageJson.version),
		);
	}

	const artifactPaths = artifactsByTarget[target];

	for (const artifactPath of artifactPaths) {
		requireRegularFile(target, path.join(stagedPackageRoot, artifactPath));
	}

	verifyAllowlistedTree(target, artifactPaths);

	if (target.startsWith('darwin-')) {
		const helperPath = path.join(
			stagedPackageRoot,
			artifactPaths.find((artifactPath) => artifactPath.endsWith('/spawn-helper')),
		);
		const helperMode = fs.statSync(helperPath).mode & 0o777;

		if (helperMode !== 0o755) {
			throw verificationError(
				target,
				'spawn-helper permission mismatch',
				helperPath,
				'0755',
				helperMode.toString(8).padStart(4, '0'),
			);
		}

		try {
			fs.accessSync(helperPath, fs.constants.X_OK);
		} catch (error) {
			throw verificationError(
				target,
				'spawn-helper failed the executable access check',
				helperPath,
				'fs.access(X_OK) succeeds',
				'access denied',
				error,
			);
		}
	}

	verifyNativeHeaders(target, artifactPaths);
}

async function isolatedRuntimeSmoke(extensionRoot, target) {
	const extensionDist = path.join(extensionRoot, 'dist');
	const extensionEntry = path.join(extensionDist, 'extension.js');
	const expectedPackageRoot = path.join(extensionDist, 'node_modules', 'node-pty');
	const isolatedRequire = createRequire(extensionEntry);
	const resolvedModulePath = isolatedRequire.resolve('node-pty');
	const realResolvedModulePath = fs.realpathSync(resolvedModulePath);
	const realExpectedPackageRoot = fs.realpathSync(expectedPackageRoot);

	if (!isPathInside(realResolvedModulePath, realExpectedPackageRoot)) {
		throw verificationError(
			target,
			'isolated node-pty resolution escaped the temporary extension',
			resolvedModulePath,
			realExpectedPackageRoot,
			realResolvedModulePath,
		);
	}

	const nodePty = isolatedRequire('node-pty');
	const smoke = await runPtySmoke(nodePty, target, extensionRoot);

	console.log(JSON.stringify({
		resolvedModulePath: realResolvedModulePath,
		...smoke,
	}));
}

function verifyIsolatedRuntime(target) {
	requireRegularFile(target, path.join(distRoot, 'extension.js'));

	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crispy-node-pty-'));
	const temporaryExtension = path.join(temporaryRoot, 'extension');
	const temporaryDist = path.join(temporaryExtension, 'dist');

	try {
		if (isPathInside(fs.realpathSync(temporaryRoot), fs.realpathSync(repositoryRoot))) {
			throw verificationError(
				target,
				'isolated verification directory is inside the repository',
				temporaryRoot,
				'path outside repository',
				temporaryRoot,
			);
		}

		fs.mkdirSync(temporaryExtension, { recursive: true });
		fs.cpSync(distRoot, temporaryDist, { recursive: true, dereference: true });

		const childEnvironment = { ...process.env };
		delete childEnvironment.NODE_PATH;
		delete childEnvironment.NODE_OPTIONS;

		const result = spawnSync(
			process.execPath,
			[__filename, isolatedSmokeFlag, temporaryExtension, target],
			{
				cwd: temporaryRoot,
				env: childEnvironment,
				encoding: 'utf8',
				timeout: 25000,
				maxBuffer: 1024 * 1024,
			},
		);

		if (result.error !== undefined) {
			throw verificationError(
				target,
				'isolated runtime process could not complete',
				temporaryExtension,
				'successful child process',
				result.error.message,
				result.error,
			);
		}

		if (result.status !== 0) {
			throw verificationError(
				target,
				'isolated runtime verification failed',
				temporaryExtension,
				'exit code 0',
				`exit code ${result.status}; stderr=${result.stderr.trim()}`,
			);
		}

		let summary;

		try {
			summary = JSON.parse(result.stdout.trim());
		} catch (error) {
			throw verificationError(
				target,
				'isolated runtime process returned an invalid summary',
				temporaryExtension,
				'JSON summary',
				result.stdout.trim(),
				error,
			);
		}

		console.log(
			`[verify-node-pty] Isolated resolution: ${summary.resolvedModulePath}`,
		);
		console.log(
			`[verify-node-pty] PTY smoke: exit=${summary.exitCode}, resize=${summary.resize}.`,
		);
	} finally {
		fs.rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

function main() {
	const target = requireTarget();
	verifyStaticRuntime(target);
	verifyIsolatedRuntime(target);
	console.log(`[verify-node-pty] Verified staged node-pty@${version} for ${target}.`);
}

if (process.argv[2] === isolatedSmokeFlag) {
	const extensionRoot = process.argv[3];
	const target = process.argv[4];

	isolatedRuntimeSmoke(extensionRoot, target).catch((error) => {
		console.error(error instanceof Error ? error.stack : String(error));
		process.exitCode = 1;
	});
} else {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
