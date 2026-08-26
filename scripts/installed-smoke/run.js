'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const vscode = require('vscode');
const { isPathInside, runPtySmoke } = require('../pty-smoke');

const blockedMcpChildEnvironmentNames = new Set([
	'CRISPY_MCP_TOKEN',
	'CRISPY_MCP_GENERATION',
	'ELECTRON_RUN_AS_NODE',
	'NODE_OPTIONS',
	'NODE_PATH',
]);

const ACTIVITY_PRESENTATIONS = Object.freeze([
	Object.freeze({
		activity: 'planned',
		effects: Object.freeze(['icon', 'marching-dash']),
		animations: Object.freeze(['graph-node-effect-marching-dash']),
	}),
	Object.freeze({
		activity: 'active',
		effects: Object.freeze(['shimmer']),
		animations: Object.freeze(['graph-node-effect-shimmer']),
	}),
	Object.freeze({
		activity: 'editing',
		effects: Object.freeze(['pulse']),
		animations: Object.freeze(['graph-node-effect-pulse']),
	}),
	Object.freeze({
		activity: 'completed',
		effects: Object.freeze(['icon', 'outline']),
		animations: Object.freeze([]),
	}),
	Object.freeze({
		activity: 'mentioned',
		effects: Object.freeze(['outline-strong']),
		animations: Object.freeze([]),
	}),
	Object.freeze({
		activity: 'rejected',
		effects: Object.freeze(['icon', 'outline']),
		animations: Object.freeze([]),
	}),
]);
const EXPECTED_ACTIVITY_TOOL_NAMES = Object.freeze([
	'crispy_ping',
	'crispy_set_agent_activity',
	'crispy_clear_agent_activity',
]);
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const CDP_DISCOVERY_TIMEOUT_MS = 15_000;
const ACTIVITY_STEP_TIMEOUT_MS = 30_000;

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
		if (blockedMcpChildEnvironmentNames.has(upperName)) {
			continue;
		}
		environment[name] = value;
	}
	environment.ELECTRON_RUN_AS_NODE = '1';
	environment.CRISPY_MCP_GENERATION = generation;
	return environment;
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function decodeWebSocketData(data) {
	if (typeof data === 'string') {
		return data;
	}
	if (Buffer.isBuffer(data)) {
		return data.toString('utf8');
	}
	if (data instanceof ArrayBuffer) {
		return Buffer.from(data).toString('utf8');
	}
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
	}
	if (typeof data?.text === 'function') {
		return data.text();
	}
	throw new Error('[installed-smoke-runner] unsupported CDP WebSocket payload.');
}

class CdpClient {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		this.closed = false;
		socket.addEventListener('message', (event) => {
			void decodeWebSocketData(event.data).then(
				(text) => this.handleMessage(text),
				() => this.closeWithError(
					new Error('[installed-smoke-runner] CDP message decode failed.'),
				),
			);
		});
		socket.addEventListener('close', () => {
			this.closeWithError(
				new Error('[installed-smoke-runner] CDP WebSocket closed.'),
			);
		});
		socket.addEventListener('error', () => {
			this.closeWithError(
				new Error('[installed-smoke-runner] CDP WebSocket failed.'),
			);
		});
	}

	static async connect(port) {
		if (typeof WebSocket !== 'function') {
			throw new Error('[installed-smoke-runner] WebSocket API is unavailable.');
		}
		const deadline = Date.now() + CDP_DISCOVERY_TIMEOUT_MS;
		let webSocketDebuggerUrl;
		while (Date.now() < deadline) {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/json/version`);
				if (response.ok) {
					const version = await response.json();
					if (typeof version?.webSocketDebuggerUrl === 'string') {
						webSocketDebuggerUrl = version.webSocketDebuggerUrl;
						break;
					}
				}
			} catch {
				/** VS Code may still be bringing up the loopback debugger. */
			}
			await delay(50);
		}
		if (webSocketDebuggerUrl === undefined) {
			throw new Error('[installed-smoke-runner] CDP endpoint did not become ready.');
		}

		const parsed = new URL(webSocketDebuggerUrl);
		if (
			(parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
			|| (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost')
			|| parsed.port !== String(port)
		) {
			throw new Error('[installed-smoke-runner] CDP endpoint escaped loopback.');
		}

		const socket = new WebSocket(webSocketDebuggerUrl);
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error('[installed-smoke-runner] CDP WebSocket open timed out.'));
			}, CDP_COMMAND_TIMEOUT_MS);
			const finish = (callback) => {
				clearTimeout(timer);
				socket.removeEventListener('open', onOpen);
				socket.removeEventListener('error', onError);
				callback();
			};
			const onOpen = () => finish(resolve);
			const onError = () => finish(() => reject(
				new Error('[installed-smoke-runner] CDP WebSocket open failed.'),
			));
			socket.addEventListener('open', onOpen, { once: true });
			socket.addEventListener('error', onError, { once: true });
		});
		return new CdpClient(socket);
	}

	handleMessage(text) {
		let message;
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		if (!Number.isSafeInteger(message?.id)) {
			return;
		}
		const pending = this.pending.get(message.id);
		if (pending === undefined) {
			return;
		}
		this.pending.delete(message.id);
		clearTimeout(pending.timer);
		if (message.error !== undefined) {
			pending.reject(new Error(
				`[installed-smoke-runner] CDP command failed: ${pending.method}.`,
			));
			return;
		}
		pending.resolve(message.result ?? {});
	}

	send(method, params = {}, sessionId) {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(
				new Error('[installed-smoke-runner] CDP client is closed.'),
			);
		}
		const id = this.nextId;
		this.nextId += 1;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(
					`[installed-smoke-runner] CDP command timed out: ${method}.`,
				));
			}, CDP_COMMAND_TIMEOUT_MS);
			this.pending.set(id, { method, resolve, reject, timer });
			try {
				this.socket.send(JSON.stringify({
					id,
					method,
					params,
					...(sessionId === undefined ? {} : { sessionId }),
				}));
			} catch {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(
					`[installed-smoke-runner] CDP command could not be sent: ${method}.`,
				));
			}
		});
	}

	closeWithError(error) {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	close() {
		if (!this.closed) {
			try {
				this.socket.close();
			} catch {
				/** Closing the already-terminating VS Code debugger is best effort. */
			}
		}
		this.closeWithError(new Error('[installed-smoke-runner] CDP client disposed.'));
	}
}

async function evaluateInTarget(cdp, sessionId, expression, executionContextId) {
	const response = await cdp.send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true,
		...(executionContextId === undefined
			? {}
			: { contextId: executionContextId }),
	}, sessionId);
	if (response.exceptionDetails !== undefined) {
		throw new Error('[installed-smoke-runner] Webview CDP evaluation failed.');
	}
	return response.result?.value;
}

function collectFrameIds(frameTree, target = []) {
	if (typeof frameTree?.frame?.id === 'string') {
		target.push(frameTree.frame.id);
	}
	for (const child of frameTree?.childFrames ?? []) {
		collectFrameIds(child, target);
	}
	return target;
}

async function findCrispyWebviewTarget(cdp) {
	const deadline = Date.now() + CDP_DISCOVERY_TIMEOUT_MS;
	let lastTargetSummary = [];
	while (Date.now() < deadline) {
		const targetResult = await cdp.send('Target.getTargets');
		const candidates = (targetResult.targetInfos ?? []).filter(({ type }) => (
			type !== 'browser'
		));
		lastTargetSummary = candidates.map(({ type, title, url }) => ({
			type,
			title,
			url,
		}));
		for (const candidate of candidates) {
			let sessionId;
			try {
				const attached = await cdp.send('Target.attachToTarget', {
					targetId: candidate.targetId,
					flatten: true,
				});
				sessionId = attached.sessionId;
				await cdp.send('Page.enable', {}, sessionId);
				const frameTree = await cdp.send('Page.getFrameTree', {}, sessionId);
				for (const frameId of collectFrameIds(frameTree.frameTree)) {
					const world = await cdp.send('Page.createIsolatedWorld', {
						frameId,
						worldName: 'crispy-installed-smoke',
					}, sessionId);
					const matches = await evaluateInTarget(
						cdp,
						sessionId,
						'Boolean(document.querySelector(".crispy-layout"))',
						world.executionContextId,
					);
					if (matches === true) {
						return {
							sessionId,
							targetId: candidate.targetId,
							executionContextId: world.executionContextId,
						};
					}
				}
			} catch {
				/** Non-DOM and transient targets are expected during workbench startup. */
			}
			if (sessionId !== undefined) {
				await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
			}
		}
		await delay(50);
	}
	throw new Error([
		'[installed-smoke-runner] Crispy Webview CDP target was not found.',
		`targets=${JSON.stringify(lastTargetSummary)}`,
	].join('\n'));
}

async function waitForWebviewValue(
	cdp,
	sessionId,
	executionContextId,
	expression,
	predicate,
	reason,
	timeoutMs = ACTIVITY_STEP_TIMEOUT_MS,
) {
	const deadline = Date.now() + timeoutMs;
	let lastValue;
	while (Date.now() < deadline) {
		try {
			lastValue = await evaluateInTarget(
				cdp,
				sessionId,
				expression,
				executionContextId,
			);
			if (predicate(lastValue)) {
				return lastValue;
			}
		} catch {
			/** A newly navigated Webview may briefly lack an execution context. */
		}
		await delay(50);
	}
	throw new Error([
		`[installed-smoke-runner] ${reason}.`,
		`last=${JSON.stringify(lastValue)}`,
	].join('\n'));
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
		cwd: path.dirname(childEntry),
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
						agentActivityCompatible: false,
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

function activityMarker(index, activity) {
	return `state-${String(index).padStart(2, '0')}-${activity}`;
}

async function waitForControlMarker(controlDirectory, name) {
	const target = path.join(controlDirectory, name);
	const failure = path.join(controlDirectory, 'failure.json');
	const deadline = Date.now() + ACTIVITY_STEP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (fs.existsSync(failure)) {
			throw new Error('[installed-smoke-runner] fake Codex activity sequence failed.');
		}
		if (fs.existsSync(target)) {
			let value;
			try {
				value = JSON.parse(fs.readFileSync(target, 'utf8'));
			} catch {
				throw new Error(`[installed-smoke-runner] invalid control marker: ${name}.`);
			}
			return value;
		}
		await delay(25);
	}
	throw new Error(`[installed-smoke-runner] control marker timed out: ${name}.`);
}

function acknowledgeControlMarker(controlDirectory, name) {
	fs.writeFileSync(path.join(controlDirectory, name), 'ok\n', {
		encoding: 'utf8',
		flag: 'wx',
	});
}

const PROVIDER_BUTTON_STATE_EXPRESSION = `(() => {
	const button = document.querySelector(
		'.agent-provider-option[data-provider-id="codex"]',
	);
	return {
		exists: button instanceof HTMLButtonElement,
		enabled: button instanceof HTMLButtonElement
			&& !button.disabled
			&& button.offsetParent !== null,
	};
})()`;

const CLICK_CODEX_PROVIDER_EXPRESSION = `(() => {
	const button = document.querySelector(
		'.agent-provider-option[data-provider-id="codex"]',
	);
	if (!(button instanceof HTMLButtonElement) || button.disabled) {
		return false;
	}
	button.click();
	return true;
})()`;

const READ_ACTIVITY_DOM_EXPRESSION = `(() => {
	const bindings = Array.from(document.querySelectorAll(
		'.graph-agent-activity-binding',
	));
	const effects = [];
	const animations = new Set();
	const collectAnimations = (style) => {
		const names = style.animationName.split(',').map((name) => name.trim());
		const durations = style.animationDuration
			.split(',')
			.map((duration) => duration.trim());
		for (let index = 0; index < names.length; index += 1) {
			const name = names[index];
			const duration = durations[index] ?? durations.at(-1) ?? '0s';
			if (name !== 'none' && duration !== '0s' && duration !== '0ms') {
				animations.add(name);
			}
		}
	};
	for (const binding of bindings) {
		for (const effect of binding.querySelectorAll('[data-graph-node-effect]')) {
			effects.push(effect.getAttribute('data-graph-node-effect'));
		}
		for (const element of [binding, ...binding.querySelectorAll('*')]) {
			collectAnimations(getComputedStyle(element));
			collectAnimations(getComputedStyle(element, '::before'));
			collectAnimations(getComputedStyle(element, '::after'));
		}
	}
	return {
		bindings: bindings
			.map((binding) => binding.getAttribute('data-activity'))
			.filter((activity) => typeof activity === 'string')
			.sort(),
		effects: effects
			.filter((effect) => typeof effect === 'string')
			.sort(),
		animations: Array.from(animations).sort(),
	};
})()`;

function uniqueSorted(values) {
	return [...new Set(values)].sort();
}

function matchesActivityPresentation(snapshot, expected) {
	if (
		snapshot === null
		|| typeof snapshot !== 'object'
		|| !Array.isArray(snapshot.bindings)
		|| !Array.isArray(snapshot.effects)
		|| !Array.isArray(snapshot.animations)
		|| snapshot.bindings.length === 0
		|| !snapshot.bindings.every((activity) => activity === expected.activity)
	) {
		return false;
	}
	if (
		JSON.stringify(uniqueSorted(snapshot.effects))
		!== JSON.stringify([...expected.effects].sort())
	) {
		return false;
	}
	if (expected.animations.length === 0) {
		return snapshot.animations.length === 0;
	}
	return expected.animations.every((animation) => (
		snapshot.animations.includes(animation)
	));
}

function isClearedActivityPresentation(snapshot) {
	return snapshot !== null
		&& typeof snapshot === 'object'
		&& Array.isArray(snapshot.bindings)
		&& Array.isArray(snapshot.effects)
		&& Array.isArray(snapshot.animations)
		&& snapshot.bindings.length === 0
		&& snapshot.effects.length === 0
		&& snapshot.animations.length === 0;
}

async function runInstalledActivityCanvasSmoke(
	fakeCodexPath,
	controlDirectory,
	cdpPort,
) {
	await vscode.workspace.getConfiguration('crispy').update(
		'codexCliPath',
		fakeCodexPath,
		vscode.ConfigurationTarget.Global,
	);
	if (
		vscode.workspace.getConfiguration('crispy').get('codexCliPath')
		!== fakeCodexPath
	) {
		throw new Error('[installed-smoke-runner] fake Codex configuration was not applied.');
	}

	await vscode.commands.executeCommand('crispy.openCanvas');
	const cdp = await CdpClient.connect(cdpPort);
	let webviewTarget;
	try {
		webviewTarget = await findCrispyWebviewTarget(cdp);
		await waitForWebviewValue(
			cdp,
			webviewTarget.sessionId,
			webviewTarget.executionContextId,
			PROVIDER_BUTTON_STATE_EXPRESSION,
			(value) => value?.exists === true && value.enabled === true,
			'Codex provider button did not become enabled',
		);
		const clicked = await evaluateInTarget(
			cdp,
			webviewTarget.sessionId,
			CLICK_CODEX_PROVIDER_EXPRESSION,
			webviewTarget.executionContextId,
		);
		if (clicked !== true) {
			throw new Error('[installed-smoke-runner] Codex provider button was not clicked.');
		}

		const toolsReady = await waitForControlMarker(
			controlDirectory,
			'tools-ready.json',
		);
		if (
			toolsReady?.ping !== true
			|| JSON.stringify(toolsReady.tools) !== JSON.stringify(
				EXPECTED_ACTIVITY_TOOL_NAMES,
			)
		) {
			throw new Error('[installed-smoke-runner] installed Activity tool surface mismatch.');
		}

		for (let index = 0; index < ACTIVITY_PRESENTATIONS.length; index += 1) {
			const presentation = ACTIVITY_PRESENTATIONS[index];
			const marker = activityMarker(index, presentation.activity);
			const stateMarker = await waitForControlMarker(
				controlDirectory,
				`${marker}.json`,
			);
			if (
				stateMarker?.activity !== presentation.activity
				|| Object.keys(stateMarker).length !== 1
			) {
				throw new Error(
					`[installed-smoke-runner] invalid Activity marker: ${presentation.activity}.`,
				);
			}
			await waitForWebviewValue(
				cdp,
				webviewTarget.sessionId,
				webviewTarget.executionContextId,
				READ_ACTIVITY_DOM_EXPRESSION,
				(value) => matchesActivityPresentation(value, presentation),
				`Canvas did not render ${presentation.activity} Activity`,
			);
			acknowledgeControlMarker(controlDirectory, `${marker}.ack`);
		}

		const clearMarker = await waitForControlMarker(controlDirectory, 'clear.json');
		if (clearMarker?.cleared !== true || Object.keys(clearMarker).length !== 1) {
			throw new Error('[installed-smoke-runner] invalid Activity clear marker.');
		}
		await waitForWebviewValue(
			cdp,
			webviewTarget.sessionId,
			webviewTarget.executionContextId,
			READ_ACTIVITY_DOM_EXPRESSION,
			isClearedActivityPresentation,
			'Canvas did not clear Activity DOM and effects',
		);
		acknowledgeControlMarker(controlDirectory, 'clear.ack');
		const done = await waitForControlMarker(controlDirectory, 'done.json');
		if (done?.ok !== true || Object.keys(done).length !== 1) {
			throw new Error('[installed-smoke-runner] fake Codex completion mismatch.');
		}
	} finally {
		if (webviewTarget !== undefined) {
			await cdp.send('Target.detachFromTarget', {
				sessionId: webviewTarget.sessionId,
			}).catch(() => undefined);
		}
		cdp.close();
	}
}

async function run() {
	const target = requiredEnvironment('CRISPY_INSTALLED_TARGET');
	const extensionName = requiredEnvironment('CRISPY_INSTALLED_EXTENSION_NAME');
	const extensionsDirectory = fs.realpathSync(requiredEnvironment('CRISPY_INSTALLED_EXTENSIONS_DIR'));
	const fakeCodexPath = fs.realpathSync(
		requiredEnvironment('CRISPY_INSTALLED_FAKE_CODEX_PATH'),
	);
	const activityControlDirectory = fs.realpathSync(
		requiredEnvironment('CRISPY_INSTALLED_ACTIVITY_CONTROL_DIR'),
	);
	const cdpPort = Number(requiredEnvironment('CRISPY_INSTALLED_CDP_PORT'));
	if (!Number.isSafeInteger(cdpPort) || cdpPort < 1 || cdpPort > 65_535) {
		throw new Error('[installed-smoke-runner] invalid CDP port.');
	}
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
	await runInstalledActivityCanvasSmoke(
		fakeCodexPath,
		activityControlDirectory,
		cdpPort,
	);
	console.log(`[installed-smoke-runner] activated=${extension.id}`);
	console.log(`[installed-smoke-runner] resolved=${resolvedModulePath}`);
	console.log(`[installed-smoke-runner] exit=${smoke.exitCode} resize=${smoke.resize}`);
	console.log(`[installed-smoke-runner] mcp=${mcpSmoke.childEntry} port_closed=${mcpSmoke.port}`);
	console.log('[installed-smoke-runner] activity=tools+host+canvas+animations+clear');
}

module.exports = Object.freeze({ run });
