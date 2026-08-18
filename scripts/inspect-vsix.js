'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');
const packageJson = require('../package.json');
const { verifyNativeBinary } = require('./native-binary');
const { nodePtyRuntimeDependency } = require('./runtime-dependencies');

const repositoryRoot = path.resolve(__dirname, '..');
const { version, artifactsByTarget } = nodePtyRuntimeDependency.staging;
const supportedTargets = Object.freeze(Object.keys(artifactsByTarget));

function inspectionError(target, reason, problemPath, expected, actual, cause) {
	const details = [
		`[inspect-vsix] target=${String(target)} failed: ${reason}`,
		`[inspect-vsix] path=${problemPath}`,
	];

	if (expected !== undefined) {
		details.push(`[inspect-vsix] expected=${expected}`);
	}

	if (actual !== undefined) {
		details.push(`[inspect-vsix] actual=${actual}`);
	}

	const error = new Error(details.join('\n'));
	if (cause !== undefined) {
		error.cause = cause;
	}
	return error;
}

function parseArguments(argv) {
	const values = new Map();

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--') {
			continue;
		}
		if (argument !== '--target' && argument !== '--vsix') {
			throw inspectionError(undefined, 'unknown argument', 'argv', '--target <target> --vsix <path>', argument);
		}
		if (values.has(argument) || argv[index + 1] === undefined) {
			throw inspectionError(undefined, `expected exactly one ${argument} value`, 'argv');
		}
		values.set(argument, argv[index + 1]);
		index += 1;
	}

	const target = values.get('--target');
	if (!supportedTargets.includes(target)) {
		throw inspectionError(target, 'unsupported or missing VSIX target', '--target', supportedTargets.join(', '), target ?? '<unset>');
	}

	const defaultVsixPath = path.join(repositoryRoot, 'artifacts', 'vsix', `${packageJson.name}-${packageJson.version}-${target}.vsix`);
	const vsixPath = path.resolve(values.get('--vsix') ?? defaultVsixPath);
	return { target, vsixPath };
}

function isSafeArchivePath(entryName) {
	return entryName !== ''
		&& !entryName.includes('\\')
		&& !entryName.includes('\0')
		&& !path.posix.isAbsolute(entryName)
		&& !entryName.split('/').includes('..');
}

function readEntry(zipFile, entry) {
	return new Promise((resolve, reject) => {
		zipFile.openReadStream(entry, (error, stream) => {
			if (error !== null) {
				reject(error);
				return;
			}

			const chunks = [];
			let length = 0;
			stream.on('data', (chunk) => {
				length += chunk.length;
				if (length > 64 * 1024 * 1024) {
					stream.destroy(new Error(`archive entry exceeds 64 MiB: ${entry.fileName}`));
					return;
				}
				chunks.push(chunk);
			});
			stream.once('error', reject);
			stream.once('end', () => resolve(Buffer.concat(chunks, length)));
		});
	});
}

function openArchive(vsixPath) {
	return new Promise((resolve, reject) => {
		yauzl.open(vsixPath, { lazyEntries: true, autoClose: true }, (error, zipFile) => {
			if (error !== null) {
				reject(error);
				return;
			}
			resolve(zipFile);
		});
	});
}

function unixMode(entry) {
	return Math.floor(entry.externalFileAttributes / 0x10000) & 0xffff;
}

function isUnixEntry(entry) {
	return (entry.versionMadeBy >>> 8) === 3;
}

async function collectArchive(target, vsixPath) {
	let zipFile;
	try {
		zipFile = await openArchive(vsixPath);
	} catch (error) {
		throw inspectionError(target, 'could not open VSIX archive', vsixPath, 'readable ZIP archive', 'open failed', error);
	}

	const nodePtyPrefix = 'extension/dist/node_modules/node-pty/';
	const bufferedEntries = new Set([
		`${nodePtyPrefix}package.json`,
		...artifactsByTarget[target].map((artifactPath) => `${nodePtyPrefix}${artifactPath}`),
	]);
	const entries = new Map();

	return new Promise((resolve, reject) => {
		let settled = false;

		function finish(error) {
			if (settled) {
				return;
			}
			settled = true;
			if (error !== undefined) {
				zipFile.close();
				reject(error);
				return;
			}
			resolve(entries);
		}

		zipFile.once('error', finish);
		zipFile.once('end', () => finish());
		zipFile.on('entry', (entry) => {
			(async () => {
				if (!isSafeArchivePath(entry.fileName)) {
					throw inspectionError(target, 'unsafe archive entry path', entry.fileName, 'normalized relative POSIX path', entry.fileName);
				}
				if (entries.has(entry.fileName)) {
					throw inspectionError(target, 'duplicate archive entry', entry.fileName, 'unique entry', 'duplicate');
				}

				const mode = unixMode(entry);
				if (isUnixEntry(entry) && (mode & 0o170000) === 0o120000) {
					throw inspectionError(target, 'symbolic links are not allowed in the VSIX', entry.fileName, 'regular file or directory', 'symbolic link');
				}

				const record = { entry, mode };
				entries.set(entry.fileName, record);
				if (bufferedEntries.has(entry.fileName)) {
					record.buffer = await readEntry(zipFile, entry);
				}
				zipFile.readEntry();
			})().catch(finish);
		});
		zipFile.readEntry();
	});
}

function requireEntry(target, vsixPath, entries, entryName) {
	const record = entries.get(entryName);
	if (record === undefined || record.entry.fileName.endsWith('/')) {
		throw inspectionError(target, 'required archive file is missing', `${vsixPath}:${entryName}`, 'regular file', 'missing');
	}
	return record;
}

function verifyNodePtyTree(target, vsixPath, entries) {
	const prefix = 'extension/dist/node_modules/node-pty/';
	const allowedArtifacts = new Set(artifactsByTarget[target]);
	const allowedDirectories = new Set();

	for (const artifactPath of allowedArtifacts) {
		let parent = path.posix.dirname(artifactPath);
		while (parent !== '.') {
			allowedDirectories.add(parent);
			parent = path.posix.dirname(parent);
		}
	}

	for (const entryName of entries.keys()) {
		if (!entryName.startsWith(prefix) || entryName === prefix) {
			continue;
		}

		const relativePath = entryName.slice(prefix.length).replace(/\/$/, '');
		const isDirectory = entryName.endsWith('/');
		const isNeutral = relativePath === 'lib'
			|| relativePath.startsWith('lib/')
			|| (!isDirectory && (relativePath === 'package.json' || relativePath === 'LICENSE'));
		const isAllowedArtifact = !isDirectory && allowedArtifacts.has(relativePath);
		const isAllowedDirectory = isDirectory && allowedDirectories.has(relativePath);

		if (!isNeutral && !isAllowedArtifact && !isAllowedDirectory) {
			throw inspectionError(target, 'unexpected node-pty archive entry', `${vsixPath}:${entryName}`, 'target allowlist only', relativePath);
		}
	}
}

async function inspectVsix(target, vsixPath) {
	if (!fs.existsSync(vsixPath)) {
		throw inspectionError(target, 'VSIX does not exist', vsixPath, 'existing VSIX', 'missing');
	}

	const entries = await collectArchive(target, vsixPath);
	requireEntry(target, vsixPath, entries, 'extension/dist/extension.js');
	requireEntry(target, vsixPath, entries, 'extension/dist/node_modules/node-pty/LICENSE');
	const packageRecord = requireEntry(target, vsixPath, entries, 'extension/dist/node_modules/node-pty/package.json');

	let archivedPackageJson;
	try {
		archivedPackageJson = JSON.parse(packageRecord.buffer.toString('utf8'));
	} catch (error) {
		throw inspectionError(target, 'archived node-pty package.json is invalid', `${vsixPath}:extension/dist/node_modules/node-pty/package.json`, 'valid JSON', 'parse failed', error);
	}

	if (archivedPackageJson.version !== version) {
		throw inspectionError(target, 'archived node-pty version mismatch', `${vsixPath}:extension/dist/node_modules/node-pty/package.json`, version, String(archivedPackageJson.version));
	}

	verifyNodePtyTree(target, vsixPath, entries);

	for (const artifactPath of artifactsByTarget[target]) {
		const entryName = `extension/dist/node_modules/node-pty/${artifactPath}`;
		const record = requireEntry(target, vsixPath, entries, entryName);
		verifyNativeBinary(target, artifactPath, record.buffer);
	}

	if (target.startsWith('darwin-')) {
		const helperPath = artifactsByTarget[target].find((artifactPath) => artifactPath.endsWith('/spawn-helper'));
		const entryName = `extension/dist/node_modules/node-pty/${helperPath}`;
		const helperRecord = requireEntry(target, vsixPath, entries, entryName);
		if (!isUnixEntry(helperRecord.entry) || helperRecord.mode === 0) {
			throw inspectionError(target, 'spawn-helper has no archived Unix mode', `${vsixPath}:${entryName}`, 'Unix mode 0755', 'missing');
		}
		const permission = helperRecord.mode & 0o777;
		if (permission !== 0o755 || (permission & 0o111) === 0) {
			throw inspectionError(target, 'spawn-helper archived permission mismatch', `${vsixPath}:${entryName}`, '0755 with executable bits', permission.toString(8).padStart(4, '0'));
		}
	}

	console.log(`[inspect-vsix] Verified ${entries.size} archive entries for ${target}: ${vsixPath}`);
}

async function main() {
	const { target, vsixPath } = parseArguments(process.argv.slice(2));
	await inspectVsix(target, vsixPath);
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack : String(error));
		process.exitCode = 1;
	});
}

module.exports = Object.freeze({ inspectVsix });
