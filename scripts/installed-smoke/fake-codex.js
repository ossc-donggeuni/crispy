'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ACTIVITY_SEQUENCE = Object.freeze([
	'planned',
	'active',
	'editing',
	'completed',
	'mentioned',
	'rejected',
]);
const EXPECTED_TOOLS = Object.freeze([
	'crispy_ping',
	'crispy_set_agent_activity',
	'crispy_clear_agent_activity',
]);
const TOKEN_ENVIRONMENT_NAME = 'CRISPY_MCP_TOKEN';
const CONTROL_DIRECTORY_ENVIRONMENT_NAME =
	'CRISPY_INSTALLED_ACTIVITY_CONTROL_DIR';
const STEP_TIMEOUT_MS = 30_000;

function requiredEnvironment(name) {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error(`missing_environment:${name}`);
	}
	return value;
}

function parseMcpUrlFromArguments(argv) {
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] !== '--config') {
			continue;
		}
		const assignment = argv[index + 1];
		if (assignment === undefined) {
			throw new Error('missing_config_assignment');
		}
		const match = /^mcp_servers\.[^.]+\.url=(.+)$/u.exec(assignment);
		if (match === null) {
			index += 1;
			continue;
		}
		let value;
		try {
			value = JSON.parse(match[1]);
		} catch {
			throw new Error('invalid_mcp_url_assignment');
		}
		if (typeof value !== 'string') {
			throw new Error('invalid_mcp_url_value');
		}
		const url = new URL(value);
		if (
			url.protocol !== 'http:'
			|| url.hostname !== '127.0.0.1'
			|| url.port === ''
			|| !/^\/mcp\/[A-Za-z0-9_-]+$/u.test(url.pathname)
			|| url.search !== ''
			|| url.hash !== ''
		) {
			throw new Error('invalid_mcp_url');
		}
		return url;
	}
	throw new Error('missing_mcp_url');
}

function decodeMcpResponse(responseText) {
	const dataLine = responseText
		.split(/\r?\n/u)
		.find((line) => line.startsWith('data:'));
	try {
		return JSON.parse(dataLine?.slice('data:'.length).trimStart() ?? responseText);
	} catch {
		throw new Error('invalid_mcp_response');
	}
}

async function requestMcp(url, token, id, method, params) {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id,
			method,
			...(params === undefined ? {} : { params }),
		}),
	});
	if (!response.ok) {
		throw new Error(`mcp_http_${response.status}`);
	}
	const body = decodeMcpResponse(await response.text());
	if (
		body === null
		|| typeof body !== 'object'
		|| body.jsonrpc !== '2.0'
		|| body.id !== id
		|| body.error !== undefined
	) {
		throw new Error('invalid_mcp_envelope');
	}
	return body.result;
}

function readToolJson(result) {
	const text = result?.content?.[0]?.text;
	if (typeof text !== 'string') {
		throw new Error('missing_tool_text');
	}
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error('invalid_tool_json');
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('invalid_tool_result');
	}
	return value;
}

function writeMarker(controlDirectory, name, value) {
	const target = path.join(controlDirectory, name);
	const temporary = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
		encoding: 'utf8',
		flag: 'wx',
	});
	fs.renameSync(temporary, target);
}

async function waitForMarker(controlDirectory, name) {
	const target = path.join(controlDirectory, name);
	const deadline = Date.now() + STEP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (fs.existsSync(target)) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`marker_timeout:${name}`);
}

function activityMarker(index, activity) {
	return `state-${String(index).padStart(2, '0')}-${activity}`;
}

async function runActivitySequence() {
	const controlDirectory = fs.realpathSync(
		requiredEnvironment(CONTROL_DIRECTORY_ENVIRONMENT_NAME),
	);
	const url = parseMcpUrlFromArguments(process.argv.slice(2));
	const token = requiredEnvironment(TOKEN_ENVIRONMENT_NAME);
	let requestId = 1;

	const listed = await requestMcp(url, token, requestId, 'tools/list');
	requestId += 1;
	const toolNames = listed?.tools?.map(({ name }) => name);
	if (JSON.stringify(toolNames) !== JSON.stringify(EXPECTED_TOOLS)) {
		throw new Error('activity_tools_not_exposed');
	}

	const ping = readToolJson(await requestMcp(
		url,
		token,
		requestId,
		'tools/call',
		{ name: 'crispy_ping', arguments: {} },
	));
	requestId += 1;
	if (
		ping.ok !== true
		|| ping.server !== 'crispy'
		|| ping.mode !== 'observation-only'
		|| Object.keys(ping).length !== 3
	) {
		throw new Error('ping_contract_mismatch');
	}

	writeMarker(controlDirectory, 'tools-ready.json', {
		tools: EXPECTED_TOOLS,
		ping: true,
	});

	for (let index = 0; index < ACTIVITY_SEQUENCE.length; index += 1) {
		const activity = ACTIVITY_SEQUENCE[index];
		const result = readToolJson(await requestMcp(
			url,
			token,
			requestId,
			'tools/call',
			{
				name: 'crispy_set_agent_activity',
				arguments: { path: '.', targetKind: 'folder', activity },
			},
		));
		requestId += 1;
		if (
			result.ok !== true
			|| result.accepted !== true
			|| Object.keys(result).length !== 2
		) {
			throw new Error(`set_contract_mismatch:${activity}`);
		}

		const marker = activityMarker(index, activity);
		writeMarker(controlDirectory, `${marker}.json`, { activity });
		await waitForMarker(controlDirectory, `${marker}.ack`);
	}

	const clear = readToolJson(await requestMcp(
		url,
		token,
		requestId,
		'tools/call',
		{
			name: 'crispy_clear_agent_activity',
			arguments: { path: '.', targetKind: 'folder' },
		},
	));
	if (
		clear.ok !== true
		|| clear.accepted !== true
		|| Object.keys(clear).length !== 2
	) {
		throw new Error('clear_contract_mismatch');
	}
	writeMarker(controlDirectory, 'clear.json', { cleared: true });
	await waitForMarker(controlDirectory, 'clear.ack');
	writeMarker(controlDirectory, 'done.json', { ok: true });
}

async function main() {
	if (process.argv.slice(2).includes('--version')) {
		process.stdout.write('codex-cli 0.149.0\n');
		return;
	}

	let stage = 'activity_sequence';
	try {
		await runActivitySequence();
	} catch {
		stage = 'failed';
		try {
			const controlDirectory = requiredEnvironment(
				CONTROL_DIRECTORY_ENVIRONMENT_NAME,
			);
			writeMarker(controlDirectory, 'failure.json', { stage });
		} catch {
			/** The PTY exit code remains the final failure signal when diagnostics fail. */
		}
		process.exitCode = 1;
	}
}

if (require.main === module) {
	void main();
}

module.exports = Object.freeze({
	ACTIVITY_SEQUENCE,
	activityMarker,
	decodeMcpResponse,
	parseMcpUrlFromArguments,
});
