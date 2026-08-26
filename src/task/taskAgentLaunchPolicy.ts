import * as nodePath from 'node:path';
import { serializeCodexTomlString } from '../mcp/codexConfig';

export interface TaskAgentScopePath {
	readonly path: string;
	readonly kind: 'file' | 'folder';
	readonly access: 'read' | 'read-write';
}

const CODEX_TASK_PERMISSION_PROFILE = 'crispy-task';
const CLAUDE_TASK_MCP_TOOL_NAMES = Object.freeze([
	'crispy_task_complete',
	'crispy_task_scope_request',
	'crispy_task_scope_result',
]);

/** Codex permission profile을 session-only CLI config로 고정한다. */
export function createCodexTaskPermissionArgs(
	scope: readonly TaskAgentScopePath[],
	runtimeExecutablePath?: string,
): readonly string[] {
	assertValidTaskAgentScope(scope);
	if (
		runtimeExecutablePath !== undefined
		&& (
			!nodePath.isAbsolute(runtimeExecutablePath)
			|| runtimeExecutablePath.includes('\0')
		)
	) {
		throw new Error('Task Agent runtime executable is invalid.');
	}
	const runtimeFilesystem = runtimeExecutablePath !== undefined
		&& !scope.some(({ path }) => path === runtimeExecutablePath)
		? [
			`${serializeCodexTomlString(runtimeExecutablePath)}=${serializeCodexTomlString('read')}`,
		]
		: [];
	const filesystem = [
		`${serializeCodexTomlString(':minimal')}=${serializeCodexTomlString('read')}`,
		...scope.map((target) =>
			`${serializeCodexTomlString(target.path)}=${serializeCodexTomlString(
				target.access === 'read-write' ? 'write' : 'read',
			)}`
		),
		...runtimeFilesystem,
	].join(',');
	return Object.freeze([
		'--strict-config',
		'--ask-for-approval',
		'on-request',
		'--config',
		`default_permissions=${serializeCodexTomlString(CODEX_TASK_PERMISSION_PROFILE)}`,
		'--config',
		`permissions.${CODEX_TASK_PERMISSION_PROFILE}.filesystem={${filesystem}}`,
	]);
}

/**
 * Claude Code는 기존 interactive CLI를 그대로 사용한다. Filesystem setting source는
 * session inline 설정만 선택하고, assigned path는 permission allow/add-dir 및 Bash
 * sandbox read/write allowlist로 제공한다. Task 소유 Workspace는 실행 cwd일 뿐 명시적
 * allowRead가 아니므로, 그 밖의 접근은 default permission UI와 sandbox 경계를 거친다.
 */
export function createClaudeTaskPermissionArgs(
	scope: readonly TaskAgentScopePath[],
	mcpServerName?: string,
): readonly string[] {
	assertValidTaskAgentScope(scope);
	if (
		mcpServerName !== undefined
		&& !/^crispy_canvas_[a-f0-9]{32}$/u.test(mcpServerName)
	) {
		throw new Error('Task Agent MCP server name is invalid.');
	}
	const allow = new Set<string>();
	const additionalDirectories = new Set<string>();
	const allowRead = new Set<string>();
	const allowWrite = new Set<string>();
	if (mcpServerName !== undefined) {
		for (const toolName of CLAUDE_TASK_MCP_TOOL_NAMES) {
			allow.add(`mcp__${mcpServerName}__${toolName}`);
		}
	}
	for (const target of scope) {
		const permissionPath = toClaudeAbsolutePermissionPath(target.path);
		allowRead.add(target.path);
		allow.add(`Read(${permissionPath})`);
		if (target.kind === 'folder') {
			allow.add(`Read(${permissionPath}/**)`);
			additionalDirectories.add(target.path);
		}
		if (target.access === 'read-write') {
			allow.add(`Edit(${permissionPath})`);
			if (target.kind === 'folder') {
				allow.add(`Edit(${permissionPath}/**)`);
			}
			allowWrite.add(target.path);
		}
	}
	const settings = {
		permissions: {
			defaultMode: 'default',
			allow: [...allow],
			ask: ['Bash(dangerouslyDisableSandbox:true)'],
		},
		sandbox: {
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: true,
			filesystem: {
				denyRead: ['/'],
				allowRead: [...allowRead],
				allowWrite: [...allowWrite],
			},
		},
	};
	return Object.freeze([
		'--setting-sources',
		'',
		'--permission-mode',
		'default',
		'--settings',
		JSON.stringify(settings),
		...[...additionalDirectories].flatMap((path) => ['--add-dir', path]),
	]);
}

function assertValidTaskAgentScope(scope: readonly TaskAgentScopePath[]): void {
	const seen = new Set<string>();
	for (const target of scope) {
		if (
			!nodePath.isAbsolute(target.path)
			|| target.path.includes('\0')
			|| (target.kind !== 'file' && target.kind !== 'folder')
			|| (target.access !== 'read' && target.access !== 'read-write')
			|| seen.has(target.path)
		) {
			throw new Error('Task Agent scope is invalid.');
		}
		seen.add(target.path);
	}
}

function toClaudeAbsolutePermissionPath(path: string): string {
	const normalized = path.replaceAll('\\', '/');
	const windowsDrive = /^([A-Za-z]):\/(.*)$/u.exec(normalized);
	if (windowsDrive !== null) {
		return `//${windowsDrive[1].toLowerCase()}/${windowsDrive[2]}`;
	}
	return normalized.startsWith('/') ? `/${normalized}` : `//${normalized}`;
}
