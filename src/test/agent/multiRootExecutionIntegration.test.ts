import * as assert from 'node:assert/strict';
import {
	TerminalHost,
	type McpSupervisor,
} from '../../agent/host/terminal/terminalHost';
import {
	createWorkspaceResolver,
} from '../../agent/host/workspace/workspaceResolver';
import {
	validateWorkspacePolicy,
} from '../../agent/host/workspace/workspacePolicy';
import type {
	WorkspaceContextSnapshot,
} from '../../agent/host/workspace/workspaceContext';
import type { HostToWebviewMessage } from '../../agent/protocol/messages';
import {
	buildCodexBareLaunchPlan,
	buildCodexMcpLaunchPlan,
} from '../../mcp/codexLaunchPlan';
import { createPrepareCodexTerminalLaunch } from '../../mcp/codexTerminalLaunch';
import { createPrepareClaudeTerminalLaunch } from '../../mcp/claudeTerminalLaunch';
import { McpConnectionDescriptor } from '../../mcp/sessionRuntime';
import type { WorkspaceRootId } from '../../workspace/workspaceRootId';
import { FakePtyAdapter } from './support/fakePtyAdapter';
import {
	createCaptureFailureProcessTreeController,
} from './support/fakeProcessTreeController';

const FIRST_ROOT_ID = 'workspace-root:file:///workspace/first';
const SECOND_ROOT_ID = 'workspace-root:file:///workspace/second';
const FIRST_POSIX_PATH = '/workspace/첫 번째 root';
const SECOND_POSIX_PATH = '/workspace/second root';

function folder(
	id: WorkspaceRootId,
	fsPath: string,
	scheme = 'file',
): WorkspaceContextSnapshot['workspaceFolders'][number] {
	const uriValue = id.slice('workspace-root:'.length);
	const workspaceFolder = {
		uri: { scheme, fsPath, toString: () => uriValue },
	};
	return { id, workspaceFolder, scheme, fsPath };
}

function trustedRoots(
	...workspaceFolders: WorkspaceContextSnapshot['workspaceFolders']
): WorkspaceContextSnapshot {
	return { isTrusted: true, workspaceFolders };
}

suite('Multi-root execution integration', () => {
	test('서로 다른 Claude 탭을 exact selected root cwd에서 실행한다', async () => {
		const snapshot = trustedRoots(
			folder(FIRST_ROOT_ID, FIRST_POSIX_PATH),
			folder(SECOND_ROOT_ID, SECOND_POSIX_PATH),
		);
		const workspaceResolver = createWorkspaceResolver({
			readContext: () => snapshot,
			validatePolicy: (current, workspaceRootId) =>
				validateWorkspacePolicy(current, workspaceRootId, 'linux'),
		});
		const prepareClaudeLaunch = createPrepareClaudeTerminalLaunch({
			workspaceResolver,
			resolveExecutable: async (providerId) => {
				assert.strictEqual(providerId, 'claude');
				return {
					ok: true,
					executable: {
						executable: '/opt/claude',
						launcherKind: 'direct',
					},
				};
			},
			readPlatform: () => 'linux',
			readEnvironment: () => ({ PATH: '/bin' }),
			/** Version/probe failure intentionally selects credential-free bare Claude. */
			resolveCompatibility: async () => undefined,
		});
		let mcpPrepareCalls = 0;
		const bareOnlySupervisor: McpSupervisor = {
			prepareSession: async () => {
				mcpPrepareCalls += 1;
				throw new Error('bare Claude must not prepare MCP');
			},
			getSessionRuntime: () => undefined,
			retireExactRuntime: async () => undefined,
			dispose: async () => undefined,
		};
		const adapter = new FakePtyAdapter(8401);
		const messages: HostToWebviewMessage[] = [];
		const host = new TerminalHost({
			ptyAdapter: adapter,
			prepareLaunch: async () => {
				throw new Error('Claude bare launch must not use the shell fallback');
			},
			prepareClaudeLaunch,
			mcpSupervisor: bareOnlySupervisor,
			workspaceResolver,
			readWorkspaceTrust: () => true,
			processTreeController: createCaptureFailureProcessTreeController(),
			emitMessage: (message) => messages.push(message),
		});

		try {
			host.createTab('tab-first-root');
			host.createTab('tab-second-root');
			await host.handleTerminalReady('tab-first-root', 80, 24);
			await host.handleTerminalReady('tab-second-root', 100, 30);
			await host.switchAgent(
				'tab-first-root', 'claude', FIRST_ROOT_ID, 1,
			);
			await host.switchAgent(
				'tab-second-root', 'claude', SECOND_ROOT_ID, 1,
			);

			assert.deepStrictEqual(
				adapter.spawnCalls.map(({ cwd }) => cwd),
				[FIRST_POSIX_PATH, SECOND_POSIX_PATH],
			);
			assert.deepStrictEqual(
				adapter.spawnCalls.map(({ executable }) => executable),
				['/opt/claude', '/opt/claude'],
			);
			assert.deepStrictEqual(
				adapter.handles.map(({ writes }) => writes),
				[[], []],
			);
			assert.strictEqual(mcpPrepareCalls, 0);
			assert.deepStrictEqual(host.getTabAssignment('tab-first-root'), {
				providerId: 'claude',
				workspaceRootId: FIRST_ROOT_ID,
			});
			assert.deepStrictEqual(host.getTabAssignment('tab-second-root'), {
				providerId: 'claude',
				workspaceRootId: SECOND_ROOT_ID,
			});

			await host.switchAgent(
				'tab-first-root', 'claude', SECOND_ROOT_ID, 2,
			);

			assert.strictEqual(adapter.spawnCalls.length, 2);
			assert.strictEqual(
				host.getTabAssignment('tab-first-root')?.workspaceRootId,
				FIRST_ROOT_ID,
			);
			assert.strictEqual(messages.some((message) => (
				message.type === 'terminal.error'
				&& message.code === 'workspace_change_requires_reset'
				&& message.switchAttemptId === 2
			)), true);
		} finally {
			host.dispose();
		}
	});

	test('POSIX와 Windows absolute path 규칙이 공백·Unicode root를 보존한다', () => {
		const posix = validateWorkspacePolicy(
			trustedRoots(folder(FIRST_ROOT_ID, '/opt/작업 공간/root')),
			FIRST_ROOT_ID,
			'linux',
		);
		const windows = validateWorkspacePolicy(
			trustedRoots(folder(SECOND_ROOT_ID, 'C:\\작업 공간\\second root')),
			SECOND_ROOT_ID,
			'win32',
		);

		assert.strictEqual(posix.ok, true);
		assert.strictEqual(windows.ok, true);
		if (posix.ok && windows.ok) {
			assert.strictEqual(posix.root.fsPath, '/opt/작업 공간/root');
			assert.strictEqual(windows.root.fsPath, 'C:\\작업 공간\\second root');
		}
	});

	test('Codex structured와 bare plan이 각각 선택한 root cwd를 보존한다', async () => {
		const snapshot = trustedRoots(
			folder(FIRST_ROOT_ID, FIRST_POSIX_PATH),
			folder(SECOND_ROOT_ID, SECOND_POSIX_PATH),
		);
		const workspaceResolver = createWorkspaceResolver({
			readContext: () => snapshot,
			validatePolicy: (current, workspaceRootId) =>
				validateWorkspacePolicy(current, workspaceRootId, 'linux'),
		});
		const prepare = createPrepareCodexTerminalLaunch({
			workspaceResolver,
			resolveExecutable: async () => ({
				ok: true,
				executable: {
					executable: '/opt/codex',
					launcherKind: 'direct',
				},
			}),
			readPlatform: () => 'linux',
			readEnvironment: () => ({ PATH: '/bin' }),
			resolveConfigStyle: async ({ cwd }) =>
				cwd === FIRST_POSIX_PATH ? 'keyed-filters' : undefined,
		});

		const structured = await prepare(
			'tab-structured', 'session-structured', FIRST_ROOT_ID,
		);
		const bare = await prepare(
			'tab-bare', 'session-bare', SECOND_ROOT_ID,
		);
		assert.strictEqual(structured.ok, true);
		assert.strictEqual(bare.ok, true);
		if (!structured.ok || !bare.ok) {
			return;
		}

		const connection = new McpConnectionDescriptor(
			'generation-integration',
			'session-structured',
			`http://127.0.0.1:44001/mcp/${Buffer.alloc(24, 5).toString('base64url')}`,
			Buffer.alloc(32, 7).toString('base64url'),
		);
		const structuredPlan = buildCodexMcpLaunchPlan({
			executable: structured.preparation.executable,
			cwd: structured.preparation.cwd,
			connection,
			shellEnvironmentPolicyStyle: 'keyed-filters',
			randomBytes: (length) => Buffer.alloc(length, 9),
		});
		const barePlan = buildCodexBareLaunchPlan({
			executable: bare.preparation.executable,
			cwd: bare.preparation.cwd,
		});

		assert.strictEqual(structured.preparation.shellEnvironmentPolicyStyle, 'keyed-filters');
		assert.strictEqual(bare.preparation.shellEnvironmentPolicyStyle, undefined);
		assert.strictEqual(structuredPlan.cwd, FIRST_POSIX_PATH);
		assert.strictEqual(structuredPlan.expectsMcp, true);
		assert.strictEqual(barePlan.cwd, SECOND_POSIX_PATH);
		assert.strictEqual(barePlan.expectsMcp, false);
	});
});
