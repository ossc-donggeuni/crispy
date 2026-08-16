'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const packageJson = require('../package.json');
const { nodePtyRuntimeDependency } = require('./runtime-dependencies');

const repositoryRoot = path.resolve(__dirname, '..');
const supportedTargets = Object.freeze(Object.keys(nodePtyRuntimeDependency.staging.artifactsByTarget));
const vsceCliPath = require.resolve('@vscode/vsce/vsce');

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

	fs.mkdirSync(outputDirectory, { recursive: true });
	fs.rmSync(outputPath, { force: true });

	/*
	 * Windows에서 .cmd shim을 spawnSync로 직접 실행하면 Node 버전에 따라
	 * EINVAL이 발생할 수 있다. 설치된 VSCE CLI를 현재 Node로 직접 실행해
	 * shell과 package-manager shim 없이 모든 플랫폼에서 같은 경계를 사용한다.
	 */
	run(process.execPath, [
		vsceCliPath,
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
