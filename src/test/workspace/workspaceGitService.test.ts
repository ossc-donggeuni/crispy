import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type {
	ExtensionToWebviewMessage,
	WorkspaceGitStatusUpdatedMessage,
} from '../../messages';
import { createWorkspaceGitStatusService } from '../../workspace/workspaceGitService';
import {
	VSCODE_GIT_STATUS,
	type WorkspaceGitChange,
} from '../../workspace/workspaceGitStatus';

suite('Workspace Git Status Service', () => {
	test('실제 .git directory repository만 발행하고 state event를 실시간 반영한다', async () => {
		const rootUri = vscode.Uri.file('/workspace');
		const badRootUri = vscode.Uri.file('/workspace/worktree');
		const rootFolder: vscode.WorkspaceFolder = {
			uri: rootUri,
			name: 'workspace',
			index: 0,
		};
		const workspaceFoldersEmitter = new vscode.EventEmitter<
			vscode.WorkspaceFoldersChangeEvent
		>();
		const saveEmitter = new vscode.EventEmitter<vscode.TextDocument>();
		const goodStateEmitter = new vscode.EventEmitter<void>();
		const badStateEmitter = new vscode.EventEmitter<void>();
		const openEmitter = new vscode.EventEmitter<unknown>();
		const closeEmitter = new vscode.EventEmitter<unknown>();
		const enablementEmitter = new vscode.EventEmitter<boolean>();
		const goodChanges: WorkspaceGitChange[] = [{
			uri: vscode.Uri.file('/workspace/src/index.ts'),
			status: VSCODE_GIT_STATUS.MODIFIED,
		}];
		const badChanges: WorkspaceGitChange[] = [{
			uri: vscode.Uri.file('/workspace/worktree/hidden.ts'),
			status: VSCODE_GIT_STATUS.MODIFIED,
		}];
		let statusCalls = 0;
		let shownPath: string | undefined;
		const goodRepository = {
			rootUri,
			state: {
				indexChanges: [] as WorkspaceGitChange[],
				workingTreeChanges: goodChanges,
				untrackedChanges: [] as WorkspaceGitChange[],
				mergeChanges: [] as WorkspaceGitChange[],
				onDidChange: goodStateEmitter.event,
			},
			status: async () => {
				statusCalls += 1;
			},
			show: async (_ref: string, filePath: string) => {
				shownPath = filePath;
				return 'const value = 1;\n';
			},
		};
		const badRepository = {
			rootUri: badRootUri,
			state: {
				indexChanges: [] as WorkspaceGitChange[],
				workingTreeChanges: badChanges,
				untrackedChanges: [] as WorkspaceGitChange[],
				mergeChanges: [] as WorkspaceGitChange[],
				onDidChange: badStateEmitter.event,
			},
			status: async () => undefined,
			show: async () => '',
		};
		const api = {
			repositories: [goodRepository, badRepository],
			onDidOpenRepository: openEmitter.event,
			onDidCloseRepository: closeEmitter.event,
			getRepository: () => goodRepository,
		};
		const gitExtension = {
			enabled: true,
			onDidChangeEnablement: enablementEmitter.event,
			getAPI: () => api,
		};
		const extension = {
			isActive: true,
			exports: gitExtension,
		};
		const messages: WorkspaceGitStatusUpdatedMessage[] = [];
		const service = createWorkspaceGitStatusService({
			workspace: {
				workspaceFolders: [rootFolder],
				onDidChangeWorkspaceFolders: workspaceFoldersEmitter.event,
				onDidSaveTextDocument: saveEmitter.event,
				fs: {
					stat: async (uri) => ({
						type: uri.path === '/workspace/.git'
							? vscode.FileType.Directory
							: vscode.FileType.File,
						ctime: 0,
						mtime: 0,
						size: 0,
					}),
				},
				getWorkspaceFolder: (uri) => uri.path.startsWith('/workspace')
					? rootFolder
					: undefined,
			},
			getGitExtension: () => extension as never,
			loadRootFilters: async () => [],
			getWorkspaceContextGeneration: () => 4,
			postMessage: async (message: ExtensionToWebviewMessage) => {
				if (message.type === 'workspace.gitStatusUpdated') {
					messages.push(message);
				}
				return true;
			},
		});

		service.markWebviewReady();
		await waitFor(() => messages.some(({ entries }) => entries.length === 1));
		const initial = messages.find(({ entries }) => entries.length === 1);

		assert.deepStrictEqual(initial?.entries.map(({ nodeId }) => nodeId), [
			'file:file:///workspace/src/index.ts',
		]);
		assert.equal(initial?.contextGeneration, 4);
		assert.deepStrictEqual(initial?.rootIds, [
			'workspace-root:file:///workspace',
		]);

		const original = await service.readOriginalText(
			'file:file:///workspace/src/index.ts',
			1_048_576,
		);

		assert.equal(original, 'const value = 1;\n');
		assert.equal(shownPath, 'src/index.ts');

		goodRepository.state.untrackedChanges.push({
			uri: vscode.Uri.file('/workspace/new.ts'),
			status: VSCODE_GIT_STATUS.UNTRACKED,
		});
		const previousRevision = service.getGitRevision();

		goodStateEmitter.fire();
		await waitFor(() => service.getGitRevision() > previousRevision);
		const latest = messages.at(-1);

		assert.deepStrictEqual(latest?.entries.map(({ status }) => status).sort(), [
			'modified',
			'untracked',
		]);
		assert.equal(await service.readOriginalText(
			'file:file:///workspace/new.ts',
			1_048_576,
		), '');
		const revisionBeforeDisable = service.getGitRevision();

		enablementEmitter.fire(false);
		await waitFor(() => service.getGitRevision() > revisionBeforeDisable);
		assert.deepStrictEqual(messages.at(-1)?.entries, []);
		const revisionBeforeEnable = service.getGitRevision();

		enablementEmitter.fire(true);
		await waitFor(() => service.getGitRevision() > revisionBeforeEnable);
		assert.equal(messages.at(-1)?.entries.length, 2);

		await service.requestRefresh();
		assert.equal(statusCalls > 0, true);
		const revisionBeforeDispose = service.getGitRevision();

		service.dispose();
		goodStateEmitter.fire();
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(service.getGitRevision(), revisionBeforeDispose);

		workspaceFoldersEmitter.dispose();
		saveEmitter.dispose();
		goodStateEmitter.dispose();
		badStateEmitter.dispose();
		openEmitter.dispose();
		closeEmitter.dispose();
		enablementEmitter.dispose();
	});
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 2_000;

	while (!predicate()) {
		if (Date.now() > deadline) {
			assert.fail('Timed out waiting for Git service condition.');
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
