'use strict';

const nodePtyArtifactsByTarget = Object.freeze({
	'darwin-arm64': Object.freeze([
		'prebuilds/darwin-arm64/pty.node',
		'prebuilds/darwin-arm64/spawn-helper',
	]),
	'darwin-x64': Object.freeze([
		'prebuilds/darwin-x64/pty.node',
		'prebuilds/darwin-x64/spawn-helper',
	]),
	'linux-x64': Object.freeze([
		'build/Release/pty.node',
	]),
	'win32-x64': Object.freeze([
		'prebuilds/win32-x64/conpty.node',
		'prebuilds/win32-x64/conpty_console_list.node',
		'prebuilds/win32-x64/pty.node',
		'prebuilds/win32-x64/winpty-agent.exe',
		'prebuilds/win32-x64/winpty.dll',
		'prebuilds/win32-x64/conpty/OpenConsole.exe',
		'prebuilds/win32-x64/conpty/conpty.dll',
	]),
});

const runtimeDependencies = Object.freeze([
	Object.freeze({
		moduleName: 'vscode',
		providedBy: 'vscode',
	}),
	Object.freeze({
		moduleName: 'node-pty',
		providedBy: 'vsix',
		staging: Object.freeze({
			version: '1.1.0',
			artifactsByTarget: nodePtyArtifactsByTarget,
		}),
	}),
]);

for (const dependency of runtimeDependencies) {
	if (dependency.providedBy !== 'vscode' && dependency.providedBy !== 'vsix') {
		throw new Error(
			`Runtime external "${dependency.moduleName}" has no supported provider.`,
		);
	}

	if (dependency.providedBy === 'vsix' && dependency.staging === undefined) {
		throw new Error(
			`Runtime external "${dependency.moduleName}" has no staging contract.`,
		);
	}
}

const extensionHostRuntimeExternals = Object.freeze(
	runtimeDependencies.map((dependency) => dependency.moduleName),
);

const nodePtyRuntimeDependency = runtimeDependencies.find(
	(dependency) => dependency.moduleName === 'node-pty',
);

if (nodePtyRuntimeDependency?.staging === undefined) {
	throw new Error('The node-pty runtime staging contract is missing.');
}

module.exports = Object.freeze({
	extensionHostRuntimeExternals,
	nodePtyRuntimeDependency,
	runtimeDependencies,
});
