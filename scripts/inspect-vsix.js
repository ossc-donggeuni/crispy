'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const { isBuiltin } = require('node:module');
const ts = require('typescript');
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
		const maxBytes = 64 * 1024 * 1024;
		if (
			entry.compressedSize > maxBytes
			|| entry.uncompressedSize > maxBytes
			|| (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)
		) {
			reject(new Error(`archive entry exceeds limits or uses unsupported compression: ${entry.fileName}`));
			return;
		}
		const streamOptions = entry.compressionMethod === 8
			? { decompress: false }
			: undefined;
		const onStream = (error, stream) => {
			if (error !== null) {
				reject(error);
				return;
			}

			const chunks = [];
			let length = 0;
			stream.on('data', (chunk) => {
				length += chunk.length;
				if (length > maxBytes) {
					stream.destroy(new Error(`archive entry exceeds 64 MiB: ${entry.fileName}`));
					return;
				}
				chunks.push(chunk);
			});
			stream.once('error', reject);
			stream.once('end', () => {
				try {
					const encoded = Buffer.concat(chunks, length);
					const decoded = entry.compressionMethod === 8
						? inflateRawSync(encoded, { maxOutputLength: maxBytes })
						: encoded;
					if (decoded.length !== entry.uncompressedSize) {
						throw new Error(`archive entry size mismatch: ${entry.fileName}`);
					}
					resolve(decoded);
				} catch (decompressionError) {
					reject(decompressionError);
				}
			});
		};
		if (streamOptions === undefined) {
			zipFile.openReadStream(entry, onStream);
		} else {
			zipFile.openReadStream(entry, streamOptions, onStream);
		}
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
		'extension/package.json',
		'extension/dist/mcp-server.mjs',
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

const requiredRestrictedWorkspaceConfigurations = Object.freeze([
	'crispy.codexCliPath',
	'crispy.claudeCliPath',
	'crispy.antigravityCliPath',
]);
const requiredCrispyMcpToolNames = Object.freeze([
	'crispy_ping',
	'crispy_saa',
	'crispy_caa',
]);

function findExtensionManifestCapabilityProblems(manifest) {
	const problems = [];
	if (manifest?.main !== './dist/extension.js') {
		problems.push('main');
	}
	if (manifest?.engines?.node !== '24.x') {
		problems.push('engines.node');
	}
	if (manifest?.engines?.vscode !== '^1.125.0') {
		problems.push('engines.vscode');
	}
	if (manifest?.capabilities?.untrustedWorkspaces?.supported !== 'limited') {
		problems.push('capabilities.untrustedWorkspaces.supported');
	}
	const restricted = manifest?.capabilities
		?.untrustedWorkspaces?.restrictedConfigurations;
	if (
		!Array.isArray(restricted)
		|| restricted.length !== requiredRestrictedWorkspaceConfigurations.length
		|| restricted.some((value, index) => (
			value !== requiredRestrictedWorkspaceConfigurations[index]
		))
	) {
		problems.push('capabilities.untrustedWorkspaces.restrictedConfigurations');
	}
	if (manifest?.capabilities?.virtualWorkspaces?.supported !== 'limited') {
		problems.push('capabilities.virtualWorkspaces.supported');
	}
	return Object.freeze(problems);
}

function verifyExtensionManifest(target, vsixPath, entries) {
	const entryName = 'extension/package.json';
	const record = requireEntry(target, vsixPath, entries, entryName);
	let manifest;
	try {
		manifest = JSON.parse(record.buffer.toString('utf8'));
	} catch (error) {
		throw inspectionError(
			target,
			'extension manifest is invalid',
			`${vsixPath}:${entryName}`,
			'valid JSON',
			'parse failed',
			error,
		);
	}

	const problems = findExtensionManifestCapabilityProblems(manifest);
	if (problems.length > 0) {
		throw inspectionError(
			target,
			'extension manifest execution capabilities are incomplete',
			`${vsixPath}:${entryName}`,
			'host-owned entrypoint, Node 24, VS Code ^1.125.0 and limited Workspace capabilities',
			problems.join(', '),
		);
	}
}

function requireEntry(target, vsixPath, entries, entryName) {
	const record = entries.get(entryName);
	if (record === undefined || record.entry.fileName.endsWith('/')) {
		throw inspectionError(target, 'required archive file is missing', `${vsixPath}:${entryName}`, 'regular file', 'missing');
	}
	return record;
}

function findUnexpectedVsixPayloadEntries(entryNames) {
	const allowedRootEntries = new Set([
		'[Content_Types].xml',
		'extension.vsixmanifest',
	]);
	const allowedExtensionRootEntries = new Set([
		'extension/',
		'extension/LICENSE.md',
		'extension/THIRD_PARTY_NOTICES.md',
		'extension/package.json',
		'extension/readme.md',
		'extension/resources/defaultWorkspaceFilter.json',
	]);

	return Object.freeze([...entryNames].filter((entryName) => (
		!allowedRootEntries.has(entryName)
		&& !allowedExtensionRootEntries.has(entryName)
		&& entryName !== 'extension/dist/'
		&& !entryName.startsWith('extension/dist/')
	)).sort());
}

function findUnresolvedMcpRuntimeSpecifiers(source) {
	const sourceFile = ts.createSourceFile(
		'mcp-server.mjs',
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.JS,
	);
	if (sourceFile.parseDiagnostics.length > 0) {
		throw new Error('MCP child bundle JavaScript parsing failed.');
	}

	const specifiers = new Set();
	function addStringLiteral(node) {
		if (node !== undefined && ts.isStringLiteralLike(node)) {
			specifiers.add(node.text);
		}
	}
	function visit(node) {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
			addStringLiteral(node.moduleSpecifier);
		} else if (
			ts.isImportEqualsDeclaration(node)
			&& ts.isExternalModuleReference(node.moduleReference)
		) {
			addStringLiteral(node.moduleReference.expression);
		} else if (ts.isCallExpression(node)) {
			const callee = node.expression;
			const isRuntimeLoader = callee.kind === ts.SyntaxKind.ImportKeyword
				|| (ts.isIdentifier(callee)
					&& (callee.text === 'require' || callee.text === '__require'))
				|| (ts.isPropertyAccessExpression(callee)
					&& callee.name.text === 'require');
			if (isRuntimeLoader) {
				addStringLiteral(node.arguments[0]);
			}
		}
		ts.forEachChild(node, visit);
	}
	ts.forEachChild(sourceFile, visit);

	return Object.freeze(
		[...specifiers].filter((specifier) => !isBuiltin(specifier)).sort(),
	);
}

function findMissingCrispyMcpToolNames(source) {
	return Object.freeze(requiredCrispyMcpToolNames.filter(
		(toolName) => !source.includes(toolName),
	));
}

function verifyMcpChildBundle(target, vsixPath, entries) {
	const entryName = 'extension/dist/mcp-server.mjs';
	const record = requireEntry(target, vsixPath, entries, entryName);
	if (record.entry.uncompressedSize <= 0 || record.buffer?.length <= 0) {
		throw inspectionError(
			target,
			'MCP child bundle is empty',
			`${vsixPath}:${entryName}`,
			'non-empty regular file',
			`${record.entry.uncompressedSize} bytes`,
		);
	}
	if (isUnixEntry(record.entry)) {
		const kind = record.mode & 0o170000;
		if (kind !== 0 && kind !== 0o100000) {
			throw inspectionError(
				target,
				'MCP child artifact is not a regular file',
				`${vsixPath}:${entryName}`,
				'regular file',
				`mode=${record.mode.toString(8)}`,
			);
		}
	}
	if (entries.has(`${entryName}.map`)) {
		throw inspectionError(
			target,
			'production MCP child source map is not allowed',
			`${vsixPath}:${entryName}.map`,
			'absent',
			'present',
		);
	}

	const source = record.buffer.toString('utf8');
	let unresolvedSpecifiers;
	try {
		unresolvedSpecifiers = findUnresolvedMcpRuntimeSpecifiers(source);
	} catch (error) {
		throw inspectionError(
			target,
			'MCP child bundle could not be parsed',
			`${vsixPath}:${entryName}`,
			'valid JavaScript module',
			'parse failed',
			error,
		);
	}
	if (unresolvedSpecifiers.length > 0) {
		throw inspectionError(
			target,
			'MCP child has an unresolved non-built-in runtime import',
			`${vsixPath}:${entryName}`,
			'Node built-ins only',
			unresolvedSpecifiers.join(', '),
		);
	}
	if (!source.includes('crispy_ping')) {
		throw inspectionError(
			target,
			'MCP child bundle does not contain the Crispy protocol implementation',
			`${vsixPath}:${entryName}`,
			'bundled crispy_ping implementation',
			'missing',
		);
	}
	const missingToolNames = findMissingCrispyMcpToolNames(source);
	if (missingToolNames.length > 0) {
		throw inspectionError(
			target,
			'MCP child bundle does not contain every Crispy Tool implementation',
			`${vsixPath}:${entryName}`,
			requiredCrispyMcpToolNames.join(', '),
			`missing: ${missingToolNames.join(', ')}`,
		);
	}

	const forbiddenRuntimePrefixes = [
		'extension/node_modules/@modelcontextprotocol/',
		'extension/node_modules/zod/',
		'extension/node_modules/hono/',
		'extension/dist/node_modules/@modelcontextprotocol/',
		'extension/dist/node_modules/zod/',
		'extension/dist/node_modules/hono/',
	];
	for (const entry of entries.keys()) {
		if (forbiddenRuntimePrefixes.some((prefix) => entry.startsWith(prefix))) {
			throw inspectionError(
				target,
				'MCP child dependency must be bundled into mcp-server.mjs',
				`${vsixPath}:${entry}`,
				'no external MCP/Zod/Hono runtime tree',
				'archive dependency present',
			);
		}
	}
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
	const unexpectedPayloadEntries = findUnexpectedVsixPayloadEntries(entries.keys());
	if (unexpectedPayloadEntries.length > 0) {
		throw inspectionError(
			target,
			'VSIX contains files outside the production payload allowlist',
			vsixPath,
			'extension metadata and dist/** only',
			unexpectedPayloadEntries.join(', '),
		);
	}
	requireEntry(target, vsixPath, entries, 'extension/dist/extension.js');
	verifyExtensionManifest(target, vsixPath, entries);
	verifyMcpChildBundle(target, vsixPath, entries);
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

module.exports = Object.freeze({
	findExtensionManifestCapabilityProblems,
	findMissingCrispyMcpToolNames,
	findUnresolvedMcpRuntimeSpecifiers,
	findUnexpectedVsixPayloadEntries,
	inspectVsix,
});
