'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const {
	nodePtyRuntimeDependency,
} = require('./runtime-dependencies');

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

function readBinary(target, artifactPath) {
	try {
		return fs.readFileSync(artifactPath);
	} catch (error) {
		throw verificationError(
			target,
			'could not read native artifact',
			artifactPath,
			'readable binary',
			'read failed',
			error,
		);
	}
}

function requireLength(target, artifactPath, binary, expectedLength, format) {
	if (binary.length < expectedLength) {
		throw verificationError(
			target,
			`${format} header is truncated`,
			artifactPath,
			`at least ${expectedLength} bytes`,
			`${binary.length} bytes`,
		);
	}
}

function hex(value) {
	return `0x${value.toString(16)}`;
}

function verifyMachO(target, artifactPath, expectedCpu, expectedFileType) {
	const binary = readBinary(target, artifactPath);
	requireLength(target, artifactPath, binary, 32, 'Mach-O 64');

	const machOMagic64 = 0xfeedfacf;
	let readUInt32;

	if (binary.readUInt32LE(0) === machOMagic64) {
		readUInt32 = (offset) => binary.readUInt32LE(offset);
	} else if (binary.readUInt32BE(0) === machOMagic64) {
		readUInt32 = (offset) => binary.readUInt32BE(offset);
	} else {
		throw verificationError(
			target,
			'native artifact is not a thin Mach-O 64 binary',
			artifactPath,
			hex(machOMagic64),
			binary.subarray(0, 4).toString('hex'),
		);
	}

	const actualCpu = readUInt32(4);
	const actualFileType = readUInt32(12);

	if (actualCpu !== expectedCpu) {
		throw verificationError(
			target,
			'Mach-O CPU architecture mismatch',
			artifactPath,
			hex(expectedCpu),
			hex(actualCpu),
		);
	}

	if (actualFileType !== expectedFileType) {
		throw verificationError(
			target,
			'Mach-O file type mismatch',
			artifactPath,
			hex(expectedFileType),
			hex(actualFileType),
		);
	}
}

function verifyElf(target, artifactPath) {
	const binary = readBinary(target, artifactPath);
	requireLength(target, artifactPath, binary, 64, 'ELF 64');

	const magic = binary.subarray(0, 4).toString('hex');

	if (magic !== '7f454c46') {
		throw verificationError(target, 'invalid ELF magic', artifactPath, '7f454c46', magic);
	}

	if (binary[4] !== 2) {
		throw verificationError(target, 'invalid ELF class', artifactPath, 'ELFCLASS64 (2)', String(binary[4]));
	}

	if (binary[5] !== 1) {
		throw verificationError(target, 'invalid ELF byte order', artifactPath, 'little-endian (1)', String(binary[5]));
	}

	const fileType = binary.readUInt16LE(16);
	const machine = binary.readUInt16LE(18);

	if (fileType !== 3) {
		throw verificationError(target, 'invalid ELF file type', artifactPath, 'ET_DYN (3)', String(fileType));
	}

	if (machine !== 62) {
		throw verificationError(target, 'invalid ELF machine', artifactPath, 'EM_X86_64 (62)', String(machine));
	}
}

function verifyPe(target, artifactPath) {
	const binary = readBinary(target, artifactPath);
	requireLength(target, artifactPath, binary, 64, 'PE');

	const dosMagic = binary.subarray(0, 2).toString('ascii');

	if (dosMagic !== 'MZ') {
		throw verificationError(target, 'invalid DOS header magic', artifactPath, 'MZ', dosMagic);
	}

	const peOffset = binary.readUInt32LE(0x3c);
	const requiredLength = peOffset + 26;

	if (!Number.isSafeInteger(requiredLength) || peOffset > binary.length || requiredLength > binary.length) {
		throw verificationError(
			target,
			'PE e_lfanew points outside the artifact',
			artifactPath,
			`offset with 26-byte header <= ${binary.length}`,
			`e_lfanew=${peOffset}`,
		);
	}

	const peMagic = binary.subarray(peOffset, peOffset + 4).toString('hex');

	if (peMagic !== '50450000') {
		throw verificationError(target, 'invalid PE signature', artifactPath, '50450000', peMagic);
	}

	const machine = binary.readUInt16LE(peOffset + 4);
	const optionalHeaderSize = binary.readUInt16LE(peOffset + 20);
	const optionalHeaderMagic = binary.readUInt16LE(peOffset + 24);

	if (machine !== 0x8664) {
		throw verificationError(target, 'invalid PE machine', artifactPath, 'IMAGE_FILE_MACHINE_AMD64 (0x8664)', hex(machine));
	}

	if (optionalHeaderSize < 2) {
		throw verificationError(target, 'PE optional header is truncated', artifactPath, 'at least 2 bytes', `${optionalHeaderSize} bytes`);
	}

	if (optionalHeaderMagic !== 0x20b) {
		throw verificationError(target, 'invalid PE optional header', artifactPath, 'PE32+ (0x20b)', hex(optionalHeaderMagic));
	}
}

function verifyNativeHeaders(target, artifactPaths) {
	if (target.startsWith('darwin-')) {
		const expectedCpu = target === 'darwin-arm64' ? 0x0100000c : 0x01000007;

		for (const artifactPath of artifactPaths) {
			const expectedFileType = artifactPath.endsWith('/spawn-helper') ? 2 : 8;
			verifyMachO(
				target,
				path.join(stagedPackageRoot, artifactPath),
				expectedCpu,
				expectedFileType,
			);
		}
		return;
	}

	if (target === 'linux-x64') {
		verifyElf(target, path.join(stagedPackageRoot, artifactPaths[0]));
		return;
	}

	for (const artifactPath of artifactPaths) {
		verifyPe(target, path.join(stagedPackageRoot, artifactPath));
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

function isPathInside(candidatePath, parentPath) {
	const relativePath = path.relative(parentPath, candidatePath);
	return relativePath === ''
		|| (!relativePath.startsWith(`..${path.sep}`)
			&& relativePath !== '..'
			&& !path.isAbsolute(relativePath));
}

function dispose(disposable) {
	if (disposable !== undefined && disposable !== null && typeof disposable.dispose === 'function') {
		disposable.dispose();
	}
}

function runPtySmoke(nodePty, target, smokeCwd) {
	return new Promise((resolve, reject) => {
		const nonce = `${process.pid}-${Date.now().toString(36)}`;
		const firstMarker = `crispy-initial-${nonce}`;
		const resizedMarker = `crispy-resized-${nonce}`;
		const initialNeedle = `CRISPY_INITIAL:${firstMarker}`;
		const resizedNeedle = `CRISPY_RESIZED:${resizedMarker}`;
		let output = '';
		let resizeRequested = false;
		let settled = false;
		let terminal;
		let dataListener;
		let exitListener;

		const timeout = setTimeout(() => {
			finish(new Error(`PTY smoke timed out; output=${JSON.stringify(output.slice(-2000))}`));
		}, 15000);

		function finish(error, result) {
			if (settled) {
				return;
			}

			settled = true;
			clearTimeout(timeout);
			dispose(dataListener);
			dispose(exitListener);

			if (error !== undefined) {
				if (terminal !== undefined) {
					try {
						terminal.kill();
					} catch {
						// The child may already have exited.
					}
				}
				reject(error);
				return;
			}

			resolve(result);
		}

		try {
			if (target.startsWith('win32-')) {
				terminal = nodePty.spawn(process.env.ComSpec || 'cmd.exe', [], {
					cols: 80,
					rows: 24,
					cwd: smokeCwd,
					env: process.env,
				});
			} else {
				const shellScript = [
					'stty -echo',
					'IFS= read -r first',
					'printf \'CRISPY_INITIAL:%s\\n\' "$first"',
					'IFS= read -r second',
					'current_size=$(stty size)',
					'printf \'CRISPY_RESIZED:%s\\n\' "$second"',
					'printf \'CRISPY_SIZE:%s\\n\' "$current_size"',
					'exit 0',
				].join('; ');

				terminal = nodePty.spawn('/bin/sh', ['-c', shellScript], {
					name: 'xterm-256color',
					cols: 80,
					rows: 24,
					cwd: smokeCwd,
					env: { ...process.env, TERM: 'xterm-256color' },
				});
			}

			dataListener = terminal.onData((data) => {
				output += data;

				if (!resizeRequested && output.includes(initialNeedle)) {
					resizeRequested = true;
					try {
						terminal.resize(100, 30);
						if (target.startsWith('win32-')) {
							terminal.write([
								'@set /p CRISPY_VALUE=',
								resizedMarker,
								'@echo CRISPY_RESIZED:%CRISPY_VALUE%',
								'@exit 0',
								'',
							].join('\r'));
						} else {
							terminal.write(`${resizedMarker}\n`);
						}
					} catch (error) {
						finish(error);
					}
				}
			});

			exitListener = terminal.onExit((event) => {
				if (event.exitCode !== 0) {
					finish(new Error(`PTY exited with code=${event.exitCode} signal=${event.signal}`));
					return;
				}

				if (!output.includes(initialNeedle)) {
					finish(new Error(`PTY did not return the initial marker; output=${JSON.stringify(output)}`));
					return;
				}

				if (!resizeRequested || !output.includes(resizedNeedle)) {
					finish(new Error(`PTY did not return the post-resize marker; output=${JSON.stringify(output)}`));
					return;
				}

				if (!target.startsWith('win32-') && !/CRISPY_SIZE:30\s+100(?:\r?\n|$)/.test(output)) {
					finish(new Error(`PTY size did not become 30 100; output=${JSON.stringify(output)}`));
					return;
				}

				finish(undefined, {
					exitCode: event.exitCode,
					resize: target.startsWith('win32-') ? 'completed' : '30 100',
				});
			});

			if (target.startsWith('win32-')) {
				terminal.write([
					'@set /p CRISPY_VALUE=',
					firstMarker,
					'@echo CRISPY_INITIAL:%CRISPY_VALUE%',
					'',
				].join('\r'));
			} else {
				terminal.write(`${firstMarker}\n`);
			}
		} catch (error) {
			finish(error);
		}
	});
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
