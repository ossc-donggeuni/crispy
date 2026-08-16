'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
	downloadAndUnzipVSCode,
	resolveCliArgsFromVSCodeExecutablePath,
	runTests,
} = require('@vscode/test-electron');
const packageJson = require('../package.json');
const { nodePtyRuntimeDependency } = require('./runtime-dependencies');

const vscodeVersion = '1.125.0';
const repositoryRoot = path.resolve(__dirname, '..');
const supportedTargets = Object.freeze(Object.keys(nodePtyRuntimeDependency.staging.artifactsByTarget));

function smokeError(reason, expected, actual, cause) {
	const details = [`[installed-vsix-smoke] ${reason}`];
	if (expected !== undefined) {
		details.push(`[installed-vsix-smoke] expected=${expected}`);
	}
	if (actual !== undefined) {
		details.push(`[installed-vsix-smoke] actual=${actual}`);
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
			throw smokeError('unknown argument', '--target <target> [--vsix <path>]', argument);
		}
		if (values.has(argument) || argv[index + 1] === undefined) {
			throw smokeError(`expected exactly one ${argument} value`);
		}
		values.set(argument, argv[index + 1]);
		index += 1;
	}

	const target = values.get('--target');
	if (!supportedTargets.includes(target)) {
		throw smokeError('unsupported or missing VSIX target', supportedTargets.join(', '), target ?? '<unset>');
	}

	const hostTarget = `${process.platform}-${process.arch}`;
	if (target !== hostTarget) {
		throw smokeError('installed native smoke requires a matching host', hostTarget, target);
	}

	const defaultPath = path.join(repositoryRoot, 'artifacts', 'vsix', `${packageJson.name}-${packageJson.version}-${target}.vsix`);
	return { target, vsixPath: path.resolve(values.get('--vsix') ?? defaultPath) };
}

function runCli(vscodeExecutablePath, args) {
	const [command, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
	const result = spawnSync(command, [...baseArgs, ...args], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		shell: process.platform === 'win32',
	});

	if (result.error !== undefined) {
		throw smokeError('VS Code CLI could not start', 'successful CLI process', result.error.message, result.error);
	}
	if (result.status !== 0) {
		throw smokeError('VSIX installation failed', 'exit code 0', `exit=${result.status}; stdout=${result.stdout}; stderr=${result.stderr}`);
	}
	return result.stdout.trim();
}

async function main() {
	const { target, vsixPath } = parseArguments(process.argv.slice(2));
	if (!fs.existsSync(vsixPath)) {
		throw smokeError('VSIX does not exist', vsixPath, 'missing');
	}

	const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'crispy-installed-vsix-'));
	const userDataDirectory = path.join(temporaryRoot, 'user-data');
	const extensionsDirectory = path.join(temporaryRoot, 'extensions');
	const workspaceDirectory = path.join(temporaryRoot, 'workspace');

	try {
		fs.mkdirSync(userDataDirectory, { recursive: true });
		fs.mkdirSync(extensionsDirectory, { recursive: true });
		fs.mkdirSync(workspaceDirectory, { recursive: true });

		const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
		const installOutput = runCli(vscodeExecutablePath, [
			'--install-extension', vsixPath,
			'--force',
			'--user-data-dir', userDataDirectory,
			'--extensions-dir', extensionsDirectory,
		]);
		console.log(`[installed-vsix-smoke] ${installOutput || 'VSIX installed.'}`);

		await runTests({
			vscodeExecutablePath,
			extensionDevelopmentPath: path.join(__dirname, 'installed-smoke', 'driver-extension'),
			extensionTestsPath: path.join(__dirname, 'installed-smoke', 'run.js'),
			extensionTestsEnv: {
				CRISPY_INSTALLED_EXTENSIONS_DIR: extensionsDirectory,
				CRISPY_INSTALLED_TARGET: target,
				CRISPY_INSTALLED_EXTENSION_NAME: packageJson.name,
			},
			launchArgs: [
				workspaceDirectory,
				'--user-data-dir', userDataDirectory,
				'--extensions-dir', extensionsDirectory,
				'--disable-workspace-trust',
				'--skip-welcome',
				'--skip-release-notes',
			],
		});

		console.log(`[installed-vsix-smoke] VS Code ${vscodeVersion} Extension Host PTY smoke passed for ${target}.`);
	} finally {
		fs.rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
});
