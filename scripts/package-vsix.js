'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageJson = require('../package.json');
const { nodePtyRuntimeDependency } = require('./runtime-dependencies');

const repositoryRoot = path.resolve(__dirname, '..');
const supportedTargets = Object.freeze(Object.keys(nodePtyRuntimeDependency.staging.artifactsByTarget));

function fail(reason, expected, actual) {
	const details = [`[package-vsix] ${reason}`];
	if (expected !== undefined) {
		details.push(`[package-vsix] expected=${expected}`);
	}
	if (actual !== undefined) {
		details.push(`[package-vsix] actual=${actual}`);
	}
	throw new Error(details.join('\n'));
}

function readTarget(argv) {
	let target;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === '--') {
			continue;
		}

		if (argument === '--target') {
			if (target !== undefined || argv[index + 1] === undefined) {
				fail('expected exactly one --target value');
			}
			target = argv[index + 1];
			index += 1;
			continue;
		}

		if (argument.startsWith('--target=')) {
			if (target !== undefined) {
				fail('expected exactly one --target value');
			}
			target = argument.slice('--target='.length);
			continue;
		}

		fail('unknown argument', '--target <target>', argument);
	}

	if (target === undefined || target === '') {
		fail('--target is required', supportedTargets.join(', '), target ?? '<unset>');
	}

	if (!supportedTargets.includes(target)) {
		fail('unsupported VSIX target', supportedTargets.join(', '), target);
	}

	const hostTarget = `${process.platform}-${process.arch}`;
	if (target !== hostTarget) {
		fail('cross packaging is not supported', hostTarget, target);
	}

	return target;
}

function run(command, args, environment) {
	const result = spawnSync(command, args, {
		cwd: repositoryRoot,
		env: environment,
		stdio: 'inherit',
		shell: false,
	});

	if (result.error !== undefined) {
		throw result.error;
	}

	if (result.status !== 0) {
		fail('child process failed', 'exit code 0', `${command} exited with ${result.status ?? result.signal}`);
	}
}

function main() {
	const target = readTarget(process.argv.slice(2));
	const outputDirectory = path.join(repositoryRoot, 'artifacts', 'vsix');
	const outputPath = path.join(outputDirectory, `${packageJson.name}-${packageJson.version}-${target}.vsix`);
	const childEnvironment = { ...process.env, CRISPY_VSIX_TARGET: target };
	const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

	fs.mkdirSync(outputDirectory, { recursive: true });
	fs.rmSync(outputPath, { force: true });

	run(pnpmCommand, [
		'exec',
		'vsce',
		'package',
		'--target', target,
		'--out', outputPath,
		'--no-dependencies',
		'--allow-missing-repository',
		'--skip-license',
	], childEnvironment);

	run(process.execPath, [
		path.join(__dirname, 'inspect-vsix.js'),
		'--target', target,
		'--vsix', outputPath,
	], childEnvironment);

	console.log(`[package-vsix] Created and inspected ${outputPath}`);
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
}
