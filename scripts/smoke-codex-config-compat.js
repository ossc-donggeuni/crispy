'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stripVTControlCharacters } = require('node:util');
const nodePty = require('node-pty');
const {
	resolveAgentExecutable,
} = require('../out/mcp/agentExecutableResolver.js');
const {
	createAgentProcessSpawnRequest,
} = require('../out/mcp/agentLaunchPlan.js');
const {
	probeCodexConfigStyle,
} = require('../out/mcp/codexCompatibility.js');
const {
	buildCodexBareLaunchPlan,
	buildCodexMcpLaunchPlan,
} = require('../out/mcp/codexLaunchPlan.js');
const {
	serializeCodexTomlString,
} = require('../out/mcp/codexConfig.js');
const {
	McpConnectionDescriptor,
} = require('../out/mcp/sessionRuntime.js');
const {
	CRISPY_AGENT_ACTIVITY_REQUIRED_MARKER,
} = require('../out/mcp/agentActivityInstructions.js');

const smokeTimeoutMs = 15_000;
const maximumOutputLength = 1024 * 1024;
const promptInputPtyColumns = 4_096;
const windowsArgvMarker = 'CRISPY_WINDOWS_ARGV:';
const projectInstructionsMarker = 'CRISPY_PROJECT_INSTRUCTIONS_PRESERVED';
const userInstructionsMarker = 'CRISPY_USER_INSTRUCTIONS_PRESERVED';
const projectAgentsMarker = 'CRISPY_PROJECT_AGENTS_PRESERVED';
const userAgentsMarker = 'CRISPY_USER_AGENTS_PRESERVED';
const promptInputMarker = 'CRISPY_PROMPT_INPUT_PROBE';
const windowsTransientCleanupErrorCodes = new Set([
	'EBUSY',
	'ENOTEMPTY',
	'EPERM',
]);

function smokeError(reason) {
	return new Error(`[codex-config-compat-smoke] ${reason}`);
}

function shouldDeferTemporaryCleanup(error, platform) {
	return platform === 'win32'
		&& error !== null
		&& typeof error === 'object'
		&& 'code' in error
		&& windowsTransientCleanupErrorCodes.has(error.code);
}

function removeTemporaryRoot(temporaryRoot, platform = process.platform) {
	try {
		fs.rmSync(temporaryRoot, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 100,
		});
	} catch (error) {
		if (!shouldDeferTemporaryCleanup(error, platform)) {
			throw error;
		}
		console.warn(
			`[codex-config-compat-smoke] Temporary cleanup deferred (${error.code}).`,
		);
	}
}

function createInstructionPreservationFixture(temporaryRoot) {
	const codexHome = path.join(temporaryRoot, 'isolated-codex-home');
	const projectWorkspace = path.join(temporaryRoot, 'project-instructions-workspace');
	const userWorkspace = path.join(temporaryRoot, 'user-instructions-workspace');
	fs.mkdirSync(codexHome, { recursive: true });
	for (const workspace of [projectWorkspace, userWorkspace]) {
		fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
	}
	fs.mkdirSync(path.join(projectWorkspace, '.codex'), { recursive: true });

	const canonicalProjectWorkspace = fs.realpathSync.native(projectWorkspace);
	const canonicalUserWorkspace = fs.realpathSync.native(userWorkspace);
	fs.writeFileSync(path.join(codexHome, 'config.toml'), [
		`developer_instructions=${serializeCodexTomlString(userInstructionsMarker)}`,
		'',
		`[projects.${serializeCodexTomlString(canonicalProjectWorkspace)}]`,
		'trust_level="trusted"',
		'',
		`[projects.${serializeCodexTomlString(canonicalUserWorkspace)}]`,
		'trust_level="trusted"',
		'',
	].join('\n'), 'utf8');
	fs.writeFileSync(
		path.join(projectWorkspace, '.codex', 'config.toml'),
		`developer_instructions=${serializeCodexTomlString(projectInstructionsMarker)}\n`,
		'utf8',
	);
	fs.writeFileSync(
		path.join(projectWorkspace, 'AGENTS.md'),
		`${projectAgentsMarker}\n`,
		'utf8',
	);
	fs.writeFileSync(
		path.join(userWorkspace, 'AGENTS.md'),
		`${userAgentsMarker}\n`,
		'utf8',
	);

	return Object.freeze({
		codexHome,
		projectWorkspace: canonicalProjectWorkspace,
		userWorkspace: canonicalUserWorkspace,
	});
}

function createIsolatedCodexEnvironment(environment, codexHome) {
	const isolated = Object.fromEntries(Object.entries(environment).filter(
		([name]) => name.toUpperCase() !== 'CODEX_HOME',
	));
	isolated.CODEX_HOME = codexHome;
	return isolated;
}

/** Restores JSON bytes that ConPTY may decorate or physically wrap for the terminal viewport. */
function normalizeCodexPromptInputOutput(output) {
	return stripVTControlCharacters(output).replace(/[\r\n]/gu, '');
}

function parseCodexPromptInputOutput(output) {
	const normalized = normalizeCodexPromptInputOutput(output);
	const startMatch = /\[\s*\{/u.exec(normalized);
	const end = normalized.lastIndexOf(']');
	if (startMatch === null || end < startMatch.index) {
		throw smokeError('Codex prompt-input output did not contain a JSON input list.');
	}

	let parsed;
	try {
		parsed = JSON.parse(normalized.slice(startMatch.index, end + 1));
	} catch {
		throw smokeError('Codex prompt-input output was not valid JSON.');
	}
	if (!Array.isArray(parsed)) {
		throw smokeError('Codex prompt-input output was not a JSON input list.');
	}
	return parsed;
}

function collectPromptInputStrings(value, strings = []) {
	if (typeof value === 'string') {
		strings.push(value);
		return strings;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			collectPromptInputStrings(entry, strings);
		}
		return strings;
	}
	if (value !== null && typeof value === 'object') {
		for (const entry of Object.values(value)) {
			collectPromptInputStrings(entry, strings);
		}
	}
	return strings;
}

function assertInstructionPreservationOutput(output, options) {
	const normalizedOutput = normalizeCodexPromptInputOutput(output);
	if (normalizedOutput.includes(options.token)) {
		throw smokeError('Codex exposed the MCP credential in prompt-input output.');
	}
	const promptStrings = collectPromptInputStrings(
		parseCodexPromptInputOutput(output),
	);
	const includes = (marker) => promptStrings.some((value) =>
		value.includes(marker)
	);
	if (!includes(promptInputMarker)) {
		throw smokeError('Codex prompt-input probe did not reach the user prompt.');
	}
	if (options.expectedMarker !== undefined
		&& !includes(options.expectedMarker)) {
		throw smokeError(`${options.layer} developer instructions were not preserved.`);
	}
	if (!includes(options.expectedAgentsMarker)) {
		throw smokeError(`${options.layer} AGENTS.md instructions were not preserved.`);
	}
	for (const unexpectedMarker of options.unexpectedMarkers ?? []) {
		if (includes(unexpectedMarker)) {
			throw smokeError(`${options.layer} config did not have the expected precedence.`);
		}
	}
	if (options.expectsGraphInstructions
		!== includes(CRISPY_AGENT_ACTIVITY_REQUIRED_MARKER)) {
		throw smokeError(`${options.layer} graph instruction authority is incorrect.`);
	}
}

async function runInstructionPreservationSmoke(options) {
	const fixture = createInstructionPreservationFixture(options.temporaryRoot);
	const environment = createIsolatedCodexEnvironment(
		options.environment,
		fixture.codexHome,
	);
	const cases = Object.freeze([
		{
			layer: 'project ping-only',
			cwd: fixture.projectWorkspace,
			agentActivityCompatible: false,
			expectedMarker: projectInstructionsMarker,
			expectedAgentsMarker: projectAgentsMarker,
			unexpectedMarkers: [userInstructionsMarker],
			expectsGraphInstructions: false,
			randomByte: 0x71,
		},
		{
			layer: 'project Activity-enabled',
			cwd: fixture.projectWorkspace,
			agentActivityCompatible: true,
			expectedAgentsMarker: projectAgentsMarker,
			unexpectedMarkers: [
				projectInstructionsMarker,
				userInstructionsMarker,
			],
			expectsGraphInstructions: true,
			randomByte: 0x72,
		},
		{
			layer: 'user Activity-enabled',
			cwd: fixture.userWorkspace,
			agentActivityCompatible: true,
			expectedAgentsMarker: userAgentsMarker,
			unexpectedMarkers: [
				userInstructionsMarker,
				projectInstructionsMarker,
			],
			expectsGraphInstructions: true,
			randomByte: 0x73,
		},
	]);

	for (const testCase of cases) {
		const plan = buildCodexMcpLaunchPlan({
			executable: options.installed,
			cwd: testCase.cwd,
			connection: options.connection,
			argsBeforeConfig: ['debug'],
			argsAfterConfig: ['prompt-input', promptInputMarker],
			randomBytes: (size) => Buffer.alloc(size, testCase.randomByte),
			shellEnvironmentPolicyStyle: options.shellEnvironmentPolicyStyle,
			agentActivityCompatible: testCase.agentActivityCompatible,
		});
		const request = createAgentProcessSpawnRequest(plan, {
			platform: process.platform,
			environment,
		});
		const output = await runPty(request, { cols: promptInputPtyColumns });
		assertInstructionPreservationOutput(output, {
			...testCase,
			token: options.token,
		});
	}
}

async function resolveInstalledCodex(environment) {
	const resolutionEnvironment = process.platform === 'win32'
		? Object.fromEntries([
			...Object.entries(environment).filter(
				([name]) => name.toUpperCase() !== 'PATHEXT',
			),
			['PATHEXT', '.CMD'],
		])
		: environment;
	const resolution = await resolveAgentExecutable('codex', {
		platform: process.platform,
		environment: resolutionEnvironment,
	});
	if (!resolution.ok) {
		throw smokeError('Codex CLI is unavailable.');
	}
	return resolution.executable;
}

/** Creates a self-contained cmd fixture that never resolves its own metacharacter path. */
function createWindowsLauncherFixture(temporaryRoot) {
	const fixtureDirectory = path.join(
		temporaryRoot,
		'Crispy 한글 공백 %CRISPY_FIXTURE% 100% ! & (Codex)',
	);
	fs.mkdirSync(fixtureDirectory, { recursive: true });
	const probeScript = path.join(temporaryRoot, 'windows-launcher-fixture.js');
	const fixtureExecutable = path.join(fixtureDirectory, 'codex.cmd');
	fs.writeFileSync(probeScript, [
		"'use strict';",
		"const crypto = require('node:crypto');",
		`const marker = ${JSON.stringify(windowsArgvMarker)};`,
		'const args = process.argv.slice(2);',
		"if (args.length === 1 && args[0] === '--version') {",
		"	console.log('codex-cli 999.0.0');",
		'} else {',
		"	const digest = crypto.createHash('sha256').update(JSON.stringify(args), 'utf8').digest('base64url');",
		'	console.log(marker + digest);',
		'}',
		'',
	].join('\n'), 'utf8');
	fs.writeFileSync(fixtureExecutable, createWindowsBatchFixtureSource(
		process.execPath,
		probeScript,
	), 'utf8');
	return Object.freeze({
		executable: fixtureExecutable,
		launcherKind: 'cmd-one-shot',
	});
}

function createWindowsBatchFixtureSource(nodeExecutable, probeScript) {
	const quoteBatchValue = (value) => {
		if (/[\r\n"]/u.test(value)) {
			throw smokeError('Windows fixture path is invalid.');
		}
		return `"${value.replaceAll('%', '%%')}"`;
	};
	return [
		'@ECHO off',
		'SETLOCAL DisableDelayedExpansion',
		`${quoteBatchValue(nodeExecutable)} ${quoteBatchValue(probeScript)} %*`,
		'',
	].join('\r\n');
}

function runPty(request, options = {}) {
	return new Promise((resolve, reject) => {
		let terminal;
		try {
			terminal = nodePty.spawn(
				request.executable,
				request.windowsVerbatimArguments
					? request.args.join(' ')
					: request.args,
				{
					name: 'xterm-256color',
					cols: options.cols ?? 100,
					rows: 30,
					cwd: request.cwd,
					env: { ...request.environment },
				},
			);
		} catch {
			reject(smokeError('node-pty could not start Codex.'));
			return;
		}

		let settled = false;
		let output = '';
		let timer;
		let dataDisposable;
		let exitDisposable;
		const settle = (error) => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			dataDisposable?.dispose();
			exitDisposable?.dispose();
			if (error === undefined) {
				resolve(output);
			} else {
				reject(error);
			}
		};
		dataDisposable = terminal.onData((data) => {
			output += data;
			if (output.length > maximumOutputLength) {
				try {
					terminal.kill();
				} catch {
					/** The bounded smoke already fails below. */
				}
				settle(smokeError('Codex emitted excessive output.'));
			}
		});
		exitDisposable = terminal.onExit(({ exitCode, signal }) => {
			settle(exitCode === 0 && (signal === undefined || signal === 0)
				? undefined
				: smokeError('Codex config parsing exited unsuccessfully.'));
		});
		timer = setTimeout(() => {
			try {
				terminal.kill();
			} catch {
				/** The bounded smoke already fails below. */
			}
			settle(smokeError('Codex config parsing timed out.'));
		}, smokeTimeoutMs);
	});
}

async function runWindowsCmdOneShotSmoke(temporaryRoot, environment) {
	const executable = createWindowsLauncherFixture(temporaryRoot);
	const fixtureEnvironment = {
		...environment,
		CRISPY_FIXTURE: 'EXPANDED',
	};
	const compatibility = await probeCodexConfigStyle({
		executable,
		cwd: temporaryRoot,
		platform: 'win32',
		environment: fixtureEnvironment,
		resolveWorkspaceCwdBeforeSpawn: () => temporaryRoot,
	});
	if (!compatibility.ok) {
		throw smokeError(
			`Windows cmd-one-shot version probe failed (${compatibility.reason}).`,
		);
	}

	const expectedArguments = Object.freeze([
		'--fixture-probe',
		'space value',
		'한글',
		'100% ! & (Codex)',
		'%CRISPY_FIXTURE%',
		'%PATH%',
	]);
	const plan = buildCodexBareLaunchPlan({
		executable,
		cwd: temporaryRoot,
		args: expectedArguments,
	});
	const request = createAgentProcessSpawnRequest(plan, {
		platform: 'win32',
		environment: fixtureEnvironment,
	});
	const output = await runPty(request);
	const expectedMarker = windowsArgvMarker + crypto.createHash('sha256')
		.update(JSON.stringify(expectedArguments), 'utf8')
		.digest('base64url');
	if (!output.includes(expectedMarker)) {
		throw smokeError(
			'Windows cmd-one-shot did not preserve special-path arguments.',
		);
	}
}

async function main() {
	const environment = { ...process.env };
	const temporaryRoot = fs.mkdtempSync(path.join(
		os.tmpdir(),
		'crispy-codex-config-compat-',
	));

	try {
		const installed = await resolveInstalledCodex(environment);
		const compatibility = await probeCodexConfigStyle({
			executable: installed,
			cwd: temporaryRoot,
			platform: process.platform,
			environment,
			resolveWorkspaceCwdBeforeSpawn: () => temporaryRoot,
		});
		if (!compatibility.ok) {
			throw smokeError(`Codex version probe failed (${compatibility.reason}).`);
		}
		const shellEnvironmentPolicyStyle = compatibility.style;

		const routeId = Buffer.alloc(24, 0x43).toString('base64url');
		const token = Buffer.alloc(32, 0x54).toString('base64url');
		const connection = new McpConnectionDescriptor(
			'generation-config-compat',
			'session-config-compat',
			`http://127.0.0.1:43123/mcp/${routeId}`,
			token,
		);
		const plan = buildCodexMcpLaunchPlan({
			executable: installed,
			cwd: temporaryRoot,
			connection,
			argsAfterConfig: ['features', 'list'],
			randomBytes: (size) => Buffer.alloc(size, 0x63),
			shellEnvironmentPolicyStyle,
		});
		const request = createAgentProcessSpawnRequest(plan, {
			platform: process.platform,
			environment,
		});
		const output = await runPty(request);
		if (output.includes(token)) {
			throw smokeError('Codex exposed the MCP credential in output.');
		}

		console.log(
			`[codex-config-compat-smoke] ${shellEnvironmentPolicyStyle} config parsed through node-pty.`,
		);

		await runInstructionPreservationSmoke({
			temporaryRoot,
			installed,
			connection,
			environment,
			shellEnvironmentPolicyStyle,
			token,
		});
		console.log(
			'[codex-config-compat-smoke] Host graph authority and Workspace AGENTS.md precedence passed for both Activity gates.',
		);

		if (process.platform === 'win32') {
			await runWindowsCmdOneShotSmoke(temporaryRoot, environment);
			console.log(
				'[codex-config-compat-smoke] Windows cmd-one-shot special-path launch passed.',
			);
		}
	} finally {
		removeTemporaryRoot(temporaryRoot);
	}
}

if (require.main === module) {
	main().then(
		() => process.exit(0),
		(error) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		},
	);
}

module.exports = Object.freeze({
	assertInstructionPreservationOutput,
	createInstructionPreservationFixture,
	createWindowsBatchFixtureSource,
	createWindowsLauncherFixture,
	normalizeCodexPromptInputOutput,
	parseCodexPromptInputOutput,
	shouldDeferTemporaryCleanup,
	runPty,
	runWindowsCmdOneShotSmoke,
});
