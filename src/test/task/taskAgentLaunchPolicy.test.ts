import * as assert from 'node:assert/strict';
import {
	createClaudeTaskPermissionArgs,
	createCodexTaskPermissionArgs,
} from '../../task/taskAgentLaunchPolicy';

suite('Task Agent launch permission policy', () => {
	test('Codex session permission profile은 최소 read와 exact scope 권한만 추가한다', () => {
		const args = createCodexTaskPermissionArgs([
			{ path: '/workspace/docs', kind: 'folder', access: 'read' },
			{ path: '/workspace/src/app.ts', kind: 'file', access: 'read-write' },
		]);

		assert.deepStrictEqual(args, [
			'--ask-for-approval',
			'on-request',
			'--config',
			'default_permissions="crispy-task"',
			'--config',
			'permissions.crispy-task.filesystem.":minimal"="read"',
			'--config',
			'permissions.crispy-task.filesystem."/workspace/docs"="read"',
			'--config',
			'permissions.crispy-task.filesystem."/workspace/src/app.ts"="write"',
		]);
		assert.ok(Object.isFrozen(args));
	});

	test('Claude는 외부 setting source를 비우고 assigned path만 allow/add-dir에 넣는다', () => {
		const args = createClaudeTaskPermissionArgs([
			{ path: '/workspace/docs', kind: 'folder', access: 'read' },
			{ path: '/workspace/src', kind: 'folder', access: 'read-write' },
			{ path: '/workspace/config.json', kind: 'file', access: 'read-write' },
		], '/private/task-cwd', 'crispy_canvas_0123456789abcdef0123456789abcdef');

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
		};
		assert.deepStrictEqual(settings.permissions, {
			defaultMode: 'default',
			allow: [
				'mcp__crispy_canvas_0123456789abcdef0123456789abcdef__crispy_task_complete',
				'mcp__crispy_canvas_0123456789abcdef0123456789abcdef__crispy_task_scope_request',
				'mcp__crispy_canvas_0123456789abcdef0123456789abcdef__crispy_task_scope_result',
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
					'/private/task-cwd',
					'/workspace/docs',
					'/workspace/src',
					'/workspace/config.json',
				],
				allowWrite: ['/workspace/src', '/workspace/config.json'],
			},
		});
		assert.deepStrictEqual(args.slice(6), [
			'--add-dir', '/workspace/docs',
			'--add-dir', '/workspace/src',
		]);
		assert.strictEqual(
			settings.permissions.allow.includes('Edit(//workspace/docs/**)'),
			false,
		);
		assert.throws(() => createClaudeTaskPermissionArgs(
			[],
			'/private/task-cwd',
			'bad server',
		), /server name is invalid/);
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
