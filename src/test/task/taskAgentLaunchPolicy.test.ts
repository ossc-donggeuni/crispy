import * as assert from 'node:assert/strict';
import {
	createClaudeTaskPermissionArgs,
	createCodexTaskPermissionArgs,
	createTaskAgentPrompt,
} from '../../task/taskAgentLaunchPolicy';

const taskMcpUrl = `http://127.0.0.1:43123/mcp/${Buffer.alloc(24, 0x24).toString('base64url')}`;

suite('Task Agent launch permission policy', () => {
	test('Task Agent prompt는 공통 MCP 지침을 덧붙이지 않고 원문만 보존한다', () => {
		const prompt = 'Task: Update the feature\n\nReference areas: /workspace/docs';
		const result = createTaskAgentPrompt(prompt);

		assert.strictEqual(result, prompt);
		assert.doesNotMatch(result, /Task completion requirement/u);
		assert.doesNotMatch(result, /crispy_task_complete/u);
	});

	test('Codex session permission profile은 최소 read와 exact scope 권한만 추가한다', () => {
		const args = createCodexTaskPermissionArgs([
			{ path: '/workspace/docs', kind: 'folder', access: 'read' },
			{ path: '/workspace/src/app.ts', kind: 'file', access: 'read-write' },
		]);

		assert.deepStrictEqual(args, [
			'--strict-config',
			'--ask-for-approval',
			'on-request',
			'--config',
			'default_permissions="crispy-task"',
			'--config',
			'permissions.crispy-task.filesystem={":minimal"="read","/workspace/docs"="read","/workspace/src/app.ts"="write"}',
			'--config',
			'tui.notifications=["agent-turn-complete"]',
			'--config',
			'tui.notification_method="osc9"',
			'--config',
			'tui.notification_condition="always"',
		]);
		assert.ok(Object.isFrozen(args));
	});

	test('Codex filesystem inline table은 특수 문자가 있는 exact path도 TOML로 escape한다', () => {
		const args = createCodexTaskPermissionArgs([
			{ path: '/workspace/quote"\\한글', kind: 'file', access: 'read-write' },
		]);

		assert.strictEqual(
			args.find((argument) => argument.startsWith('permissions.')),
			'permissions.crispy-task.filesystem={":minimal"="read","/workspace/quote\\"\\\\한글"="write"}',
		);
	});

	test('Codex Task runtime은 canonical CLI 파일만 내부 read로 추가한다', () => {
		const args = createCodexTaskPermissionArgs(
			[{ path: '/workspace/src', kind: 'folder', access: 'read-write' }],
			'/opt/codex/releases/1.0/bin/codex',
		);

		assert.strictEqual(
			args.find((argument) => argument.startsWith('permissions.')),
			'permissions.crispy-task.filesystem={":minimal"="read","/workspace/src"="write","/opt/codex/releases/1.0/bin/codex"="read"}',
		);
		assert.throws(
			() => createCodexTaskPermissionArgs([], 'relative/codex'),
			/runtime executable is invalid/u,
		);
	});

	test('Claude는 외부 setting source를 비우고 assigned path만 allow/add-dir에 넣는다', () => {
		const args = createClaudeTaskPermissionArgs([
			{ path: '/workspace/docs', kind: 'folder', access: 'read' },
			{ path: '/workspace/src', kind: 'folder', access: 'read-write' },
			{ path: '/workspace/config.json', kind: 'file', access: 'read-write' },
		], 'crispy_0123456789abcdef01234567', taskMcpUrl);

		assert.deepStrictEqual(args.slice(0, 5), [
			'--setting-sources', '', '--permission-mode', 'default', '--settings',
		]);
		const settings = JSON.parse(args[5]) as {
			permissions: { defaultMode: string; allow: string[]; ask: string[] };
			sandbox: {
				enabled: boolean;
				failIfUnavailable: boolean;
				allowUnsandboxedCommands: boolean;
				filesystem: {
					denyRead: string[];
					allowRead: string[];
					allowWrite: string[];
				};
			};
			hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
		};
		assert.deepStrictEqual(settings.permissions, {
			defaultMode: 'default',
			allow: [
				'mcp__crispy_0123456789abcdef01234567__crispy_task_complete',
				'mcp__crispy_0123456789abcdef01234567__crispy_task_scope_request',
				'mcp__crispy_0123456789abcdef01234567__crispy_task_scope_result',
				'Read(//workspace/docs)',
				'Read(//workspace/docs/**)',
				'Read(//workspace/src)',
				'Read(//workspace/src/**)',
				'Edit(//workspace/src)',
				'Edit(//workspace/src/**)',
				'Read(//workspace/config.json)',
				'Edit(//workspace/config.json)',
			],
			ask: ['Bash(dangerouslyDisableSandbox:true)'],
		});
		assert.deepStrictEqual(settings.sandbox, {
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: true,
			filesystem: {
				denyRead: ['/'],
				allowRead: [
					'/workspace/docs',
					'/workspace/src',
					'/workspace/config.json',
				],
				allowWrite: ['/workspace/src', '/workspace/config.json'],
			},
		});
		assert.deepStrictEqual(
			Object.keys(settings.hooks),
			['Stop', 'StopFailure'],
		);
		for (const hookName of ['Stop', 'StopFailure']) {
			const handler = settings.hooks[hookName][0].hooks[0];
			assert.strictEqual(handler.type, 'http');
			assert.match(
				String(handler.url),
				/\/task-turn-lifecycle\/[A-Za-z0-9_-]+\/mcp__crispy_0123456789abcdef01234567__crispy_task_complete$/u,
			);
			assert.deepStrictEqual(handler.headers, {
				Authorization: 'Bearer ${CRISPY_MCP_TOKEN}',
			});
			assert.deepStrictEqual(handler.allowedEnvVars, ['CRISPY_MCP_TOKEN']);
		}
		assert.deepStrictEqual(args.slice(6), [
			'--add-dir', '/workspace/docs',
			'--add-dir', '/workspace/src',
		]);
		assert.strictEqual(
			settings.permissions.allow.includes('Edit(//workspace/docs/**)'),
			false,
		);
		for (const toolName of settings.permissions.allow.slice(0, 3)) {
			assert.ok(toolName.length <= 64, toolName);
		}
		assert.throws(() => createClaudeTaskPermissionArgs(
			[],
			'bad server',
		), /server name is invalid/);
		assert.throws(() => createClaudeTaskPermissionArgs(
			[],
			'crispy_0123456789abcdef01234567',
		), /lifecycle configuration is incomplete/);
	});

	test('상대 경로, NUL, exact 중복 scope는 provider 실행 전에 거부한다', () => {
		for (const createArgs of [
			createCodexTaskPermissionArgs,
			createClaudeTaskPermissionArgs,
		]) {
			assert.throws(() => createArgs([
				{ path: 'relative/path', kind: 'folder', access: 'read' },
			]), /scope is invalid/);
			assert.throws(() => createArgs([
				{ path: '/workspace/\0bad', kind: 'file', access: 'read' },
			]), /scope is invalid/);
			assert.throws(() => createArgs([
				{ path: '/workspace/src', kind: 'folder', access: 'read' },
				{ path: '/workspace/src', kind: 'folder', access: 'read-write' },
			]), /scope is invalid/);
		}
	});
});
