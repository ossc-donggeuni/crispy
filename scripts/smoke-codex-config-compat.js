'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodePty = require('node-pty');
const {
	resolveAgentExecutable,
} = require('../out/mcp/agentExecutableResolver.js');
const {
	createAgentProcessSpawnRequest,
} = require('../out/mcp/agentLaunchPlan.js');
const {
	resolveCodexConfigStyle,
} = require('../out/mcp/codexCompatibility.js');
const {
	buildCodexMcpLaunchPlan,
} = require('../out/mcp/codexLaunchPlan.js');
const {
	McpConnectionDescriptor,
} = require('../out/mcp/sessionRuntime.js');

const smokeTimeoutMs = 15_000;
const maximumOutputLength = 1024 * 1024;

function smokeError(reason) {
	return new Error(`[codex-config-compat-smoke] ${reason}`);
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

/**
 * npm의 실제 codex.cmd와 node_modules를 특수문자 경로에서도 그대로 사용한다. Junction은
 * package를 복제하지 않으면서 cmd shim의 상대 node_modules lookup을 보존한다.
 */
function createWindowsCodexFixture(executable, temporaryRoot) {
	if (executable.launcherKind !== 'cmd-one-shot') {
		throw smokeError('Windows Codex CLI did not resolve to codex.cmd.');
	}
	const originalDirectory = path.dirname(executable.executable);
	const originalNodeModules = path.join(originalDirectory, 'node_modules');
	if (!fs.statSync(originalNodeModules).isDirectory()) {
		throw smokeError('Windows Codex npm node_modules is unavailable.');
	}

	const fixtureDirectory = path.join(
		temporaryRoot,
		'Crispy 한글 공백 100% ! & (Codex)',
	);
	fs.mkdirSync(fixtureDirectory, { recursive: true });
	const fixtureExecutable = path.join(fixtureDirectory, 'codex.cmd');
	fs.copyFileSync(executable.executable, fixtureExecutable);
	fs.symlinkSync(
		originalNodeModules,
		path.join(fixtureDirectory, 'node_modules'),
		'junction',
	);
	return Object.freeze({
		executable: fixtureExecutable,
		launcherKind: 'cmd-one-shot',
	});
}

function runPty(request) {
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
					cols: 100,
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

async function main() {
	const environment = { ...process.env };
	const temporaryRoot = fs.mkdtempSync(path.join(
		os.tmpdir(),
		'crispy-codex-config-compat-',
	));

	try {
		const installed = await resolveInstalledCodex(environment);
		const executable = process.platform === 'win32'
			? createWindowsCodexFixture(installed, temporaryRoot)
			: installed;
		const shellEnvironmentPolicyStyle = await resolveCodexConfigStyle({
			executable,
			cwd: temporaryRoot,
			platform: process.platform,
			environment,
		});
		if (shellEnvironmentPolicyStyle === undefined) {
			throw smokeError('Codex version is not compatible with MCP config selection.');
		}

		const routeId = Buffer.alloc(24, 0x43).toString('base64url');
		const token = Buffer.alloc(32, 0x54).toString('base64url');
		const connection = new McpConnectionDescriptor(
			'generation-config-compat',
			'session-config-compat',
			`http://127.0.0.1:43123/mcp/${routeId}`,
			token,
		);
		const plan = buildCodexMcpLaunchPlan({
			executable,
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
	} finally {
		fs.rmSync(temporaryRoot, { recursive: true, force: true });
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

module.exports = Object.freeze({ createWindowsCodexFixture, runPty });
