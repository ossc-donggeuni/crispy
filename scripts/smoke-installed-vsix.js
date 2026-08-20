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

/** Windows archive의 code.cmd가 가리키는 versioned CLI script를 안전하게 해석한다. */
function resolveWindowsCliEntry(vscodeExecutablePath, codeCommandText) {
	const installRoot = path.win32.dirname(vscodeExecutablePath);
	const commandDirectory = path.win32.join(installRoot, 'bin');
	const references = [...codeCommandText.matchAll(/"%~dp0([^"]+)"/giu)]
		.map((match) => match[1]);
	const scriptReferences = references.filter(
		(reference) => /\.(?:c|m)?js$/iu.test(reference),
	);

	if (scriptReferences.length !== 1) {
		throw smokeError(
			'VS Code code.cmd has an ambiguous CLI script entry',
			'exactly one quoted JavaScript entry',
			`${scriptReferences.length} entries`,
		);
	}

	const cliPath = path.win32.resolve(commandDirectory, scriptReferences[0]);
	const relativePath = path.win32.relative(installRoot, cliPath);
	if (
		relativePath === ''
		|| relativePath === '..'
		|| relativePath.startsWith(`..${path.win32.sep}`)
		|| path.win32.isAbsolute(relativePath)
	) {
		throw smokeError(
			'VS Code CLI entry escaped the downloaded installation',
			'path inside VS Code installation',
			'outside installation',
		);
	}

	return cliPath;
}

/**
 * Windows에서는 code.cmd와 shell을 거치지 않고 Code.exe를 Node mode로 실행한다.
 * spawnSync가 각 인자를 직접 전달하므로 공백·비ASCII 경로가 shell parsing을 받지 않는다.
 */
function resolveCliInvocation(
	vscodeExecutablePath,
	platform = process.platform,
	environment = process.env,
	windowsCodeCommandText,
) {
	if (platform === 'win32') {
		const codeCommandPath = path.win32.join(
			path.win32.dirname(vscodeExecutablePath),
			'bin',
			'code.cmd',
		);
		let codeCommand = windowsCodeCommandText;
		if (codeCommand === undefined) {
			try {
				codeCommand = fs.readFileSync(codeCommandPath, 'utf8');
			} catch (error) {
				throw smokeError(
					'VS Code code.cmd could not be read',
					'readable downloaded CLI launcher',
					'unreadable or missing',
					error,
				);
			}
		}
		const cliPath = resolveWindowsCliEntry(vscodeExecutablePath, codeCommand);
		if (windowsCodeCommandText === undefined && !fs.existsSync(cliPath)) {
			throw smokeError(
				'VS Code CLI entry does not exist',
				'existing CLI entry from code.cmd',
				'missing',
			);
		}
		const cliEnvironment = { ...environment, ELECTRON_RUN_AS_NODE: '1' };
		delete cliEnvironment.VSCODE_DEV;
		return {
			command: vscodeExecutablePath,
			baseArgs: [cliPath],
			environment: cliEnvironment,
		};
	}

	const [command, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(
		vscodeExecutablePath,
		{ reuseMachineInstall: true },
	);
	return { command, baseArgs, environment: { ...environment } };
}

function runCli(vscodeExecutablePath, args) {
	const invocation = resolveCliInvocation(vscodeExecutablePath);
	const result = spawnSync(invocation.command, [...invocation.baseArgs, ...args], {
		cwd: repositoryRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		env: invocation.environment,
		shell: false,
		windowsHide: true,
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

		console.log(`[installed-vsix-smoke] VS Code ${vscodeVersion} Extension Host PTY and MCP child smoke passed for ${target}.`);
	} finally {
		fs.rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack : String(error));
		process.exitCode = 1;
	});
}

module.exports = Object.freeze({ resolveCliInvocation, resolveWindowsCliEntry });
