'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vscode = require('vscode');
const { isPathInside, runPtySmoke } = require('../pty-smoke');

function requiredEnvironment(name) {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error(`[installed-smoke-runner] ${name} is required.`);
	}
	return value;
}

async function run() {
	const target = requiredEnvironment('CRISPY_INSTALLED_TARGET');
	const extensionName = requiredEnvironment('CRISPY_INSTALLED_EXTENSION_NAME');
	const extensionsDirectory = fs.realpathSync(requiredEnvironment('CRISPY_INSTALLED_EXTENSIONS_DIR'));
	const candidates = vscode.extensions.all.filter((extension) => {
		if (extension.packageJSON?.name !== extensionName) {
			return false;
		}

		let realExtensionPath;
		try {
			realExtensionPath = fs.realpathSync(extension.extensionPath);
		} catch {
			return false;
		}
		return isPathInside(realExtensionPath, extensionsDirectory);
	});

	if (candidates.length !== 1) {
		throw new Error(`[installed-smoke-runner] expected one installed ${extensionName} extension, found ${candidates.length}.`);
	}

	const extension = candidates[0];
	await extension.activate();

	const installedExtensionRoot = fs.realpathSync(extension.extensionPath);
	const extensionEntry = path.join(installedExtensionRoot, 'dist', 'extension.js');
	const expectedPackageRoot = path.join(installedExtensionRoot, 'dist', 'node_modules', 'node-pty');
	const installedRequire = createRequire(extensionEntry);
	const resolvedModulePath = fs.realpathSync(installedRequire.resolve('node-pty'));
	const realExpectedPackageRoot = fs.realpathSync(expectedPackageRoot);

	if (!isPathInside(resolvedModulePath, realExpectedPackageRoot)) {
		throw new Error([
			'[installed-smoke-runner] node-pty resolution escaped the installed extension.',
			`expected=${realExpectedPackageRoot}`,
			`actual=${resolvedModulePath}`,
		].join('\n'));
	}

	const nodePty = installedRequire('node-pty');
	const smoke = await runPtySmoke(nodePty, target, installedExtensionRoot);
	console.log(`[installed-smoke-runner] activated=${extension.id}`);
	console.log(`[installed-smoke-runner] resolved=${resolvedModulePath}`);
	console.log(`[installed-smoke-runner] exit=${smoke.exitCode} resize=${smoke.resize}`);
}

module.exports = Object.freeze({ run });
