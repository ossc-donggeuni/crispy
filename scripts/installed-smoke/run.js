'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const vscode = require('vscode');
const { isPathInside, runPtySmoke } = require('../pty-smoke');

function requiredEnvironment(name) {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error(`[installed-smoke-runner] ${name} is required.`);
	}
	return value;
}

function createMcpChildEnvironment(generation) {
	const environment = {};
	for (const [name, value] of Object.entries(process.env)) {
		const upperName = name.toUpperCase();
		if (
			upperName === 'CRISPY_MCP_TOKEN'
			|| upperName === 'CRISPY_MCP_GENERATION'
			|| upperName === 'ELECTRON_RUN_AS_NODE'
		) {
			continue;
		}
		environment[name] = value;
	}
	environment.ELECTRON_RUN_AS_NODE = '1';
	environment.CRISPY_MCP_GENERATION = generation;
	return environment;
}

function waitForClosedPort(port) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection({ host: '127.0.0.1', port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error('[installed-smoke-runner] old MCP port close check timed out.'));
		}, 1000);
		socket.once('connect', () => {
			clearTimeout(timer);
			socket.destroy();
			reject(new Error('[installed-smoke-runner] old MCP port still accepts connections.'));
		});
		socket.once('error', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function invokeCrispyPing(port, routeId, token) {
	const response = await fetch(`http://127.0.0.1:${port}/mcp/${routeId}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'crispy_ping', arguments: {} },
		}),
	});
	if (!response.ok) {
		throw new Error(`[installed-smoke-runner] MCP ping failed with HTTP ${response.status}.`);
	}
	const responseText = await response.text();
	const dataLine = responseText
		.split(/\r?\n/u)
		.find((line) => line.startsWith('data:'));
	let body;
	try {
		body = JSON.parse(dataLine?.slice('data:'.length).trimStart() ?? responseText);
	} catch {
		throw new Error('[installed-smoke-runner] MCP response was not valid JSON/SSE.');
	}
	const text = body?.result?.content?.[0]?.text;
	let result;
	try {
		result = JSON.parse(text);
	} catch {
		throw new Error('[installed-smoke-runner] MCP ping result was not valid JSON.');
	}
	if (
		result?.ok !== true
		|| result?.server !== 'crispy'
		|| result?.mode !== 'observation-only'
		|| Object.keys(result).length !== 3
	) {
		throw new Error('[installed-smoke-runner] MCP ping result contract mismatch.');
	}
}

async function runMcpChildSmoke(installedExtensionRoot) {
	const childEntry = fs.realpathSync(path.join(
		installedExtensionRoot,
		'dist',
		'mcp-server.mjs',
	));
	if (!isPathInside(childEntry, installedExtensionRoot)) {
		throw new Error('[installed-smoke-runner] MCP child escaped the installed extension.');
	}
	if (!fs.statSync(childEntry).isFile()) {
		throw new Error('[installed-smoke-runner] MCP child is not a regular file.');
	}

	const generation = `generation-${randomUUID()}`;
	const sessionId = `session-${randomUUID()}`;
	const routeId = randomBytes(24).toString('base64url');
	const token = randomBytes(32).toString('base64url');
	const child = spawn(process.execPath, [childEntry], {
		env: createMcpChildEnvironment(generation),
		stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		shell: false,
		windowsHide: true,
	});

	let port;
	let stage = 'ready';
	try {
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('[installed-smoke-runner] MCP child transaction timed out.'));
			}, 10_000);
			const fail = (error) => {
				clearTimeout(timeout);
				reject(error instanceof Error
					? error
					: new Error('[installed-smoke-runner] MCP child failed.'));
			};

			child.once('error', () => fail(new Error('[installed-smoke-runner] MCP child spawn failed.')));
			child.once('exit', (code, signal) => {
				clearTimeout(timeout);
				if (stage !== 'exit' || code !== 0 || signal !== null) {
					fail(new Error('[installed-smoke-runner] MCP child exited unexpectedly.'));
					return;
				}
				resolve();
			});
			child.on('message', (message) => {
				if (message?.generation !== generation) {
					return;
				}
				if (message.type === 'operation.failed') {
					fail(new Error('[installed-smoke-runner] MCP child operation failed.'));
					return;
				}
				if (stage === 'ready' && message.type === 'server.ready') {
					port = message.port;
					stage = 'registered';
					child.send({
						type: 'auth.register',
						requestId: 'register-installed-smoke',
						generation,
						sessionId,
						routeId,
						token,
					});
					return;
				}
				if (stage === 'registered' && message.type === 'auth.registered') {
					stage = 'ping';
					void invokeCrispyPing(port, routeId, token).then(() => {
						stage = 'revoked';
						child.send({
							type: 'auth.revoke',
							requestId: 'revoke-installed-smoke',
							generation,
							sessionId,
						});
					}, fail);
					return;
				}
				if (stage === 'revoked' && message.type === 'auth.revoked') {
					stage = 'exit';
					child.send({
						type: 'server.shutdown',
						requestId: 'shutdown-installed-smoke',
						generation,
					});
				}
			});
		});
	} catch (error) {
		try {
			child.kill('SIGKILL');
		} catch {
			/** 실패 smoke에서도 child를 best-effort로 회수한다. */
		}
		throw error;
	}

	await waitForClosedPort(port);
	return { childEntry, port };
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
	const mcpSmoke = await runMcpChildSmoke(installedExtensionRoot);
	console.log(`[installed-smoke-runner] activated=${extension.id}`);
	console.log(`[installed-smoke-runner] resolved=${resolvedModulePath}`);
	console.log(`[installed-smoke-runner] exit=${smoke.exitCode} resize=${smoke.resize}`);
	console.log(`[installed-smoke-runner] mcp=${mcpSmoke.childEntry} port_closed=${mcpSmoke.port}`);
}

module.exports = Object.freeze({ run });
