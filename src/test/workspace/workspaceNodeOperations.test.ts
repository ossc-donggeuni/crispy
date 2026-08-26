import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	WORKSPACE_FILE_PREVIEW_MAX_BYTES,
	WorkspaceNodeOperationError,
	deleteWorkspaceNode,
	readWorkspaceNodeDetails,
	renameWorkspaceNode,
	type WorkspaceNodeOperationHost,
} from '../../workspace/workspaceNodeOperations';

suite('Workspace Node Operations', () => {
	test('UTF-8 파일 상세와 read-only Monaco preview 입력을 1 MiB 이하에서 반환한다', async () => {
		const fixture = createHost();
		const uri = vscode.Uri.file('/workspace/src/index.ts');

		fixture.files.set(uri.toString(), {
			type: vscode.FileType.File,
			ctime: 10,
			mtime: 20,
			size: 18,
		});
		fixture.contents.set(uri.toString(), new TextEncoder().encode('const answer = 42;'));
		const details = await readWorkspaceNodeDetails({
			type: 'workspace.nodeDetails.request',
			requestId: 1,
			nodeId: `file:${uri.toString()}`,
			kind: 'file',
			workspaceRevision: 0,
		}, fixture.host);

		assert.strictEqual(details.relativePath, 'src/index.ts');
		assert.strictEqual(details.canMutate, true);
		assert.deepStrictEqual(details.preview, {
			status: 'ready',
			text: 'const answer = 42;',
			languageId: 'typescript',
		});
	});

	test('1 MiB 초과 파일은 내용을 읽지 않고 preview를 제한한다', async () => {
		const fixture = createHost();
		const uri = vscode.Uri.file('/workspace/large.txt');

		fixture.files.set(uri.toString(), {
			type: vscode.FileType.File,
			ctime: 0,
			mtime: 0,
			size: WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1,
		});
		const details = await readWorkspaceNodeDetails({
			type: 'workspace.nodeDetails.request',
			requestId: 1,
			nodeId: `file:${uri.toString()}`,
			kind: 'file',
			workspaceRevision: 0,
		}, fixture.host);

		assert.deepStrictEqual(details.preview, { status: 'too-large' });
		assert.strictEqual(fixture.readFileCalls, 0);
	});

	test('rename은 같은 parent의 새 URI만 사용하고 delete는 폴더를 Trash로 recursive 처리한다', async () => {
		const fixture = createHost();
		const uri = vscode.Uri.file('/workspace/src');

		fixture.files.set(uri.toString(), createDirectoryStat());
		const renamed = await renameWorkspaceNode({
			type: 'workspace.nodeRename.request',
			requestId: 1,
			nodeId: `folder:${uri.toString()}`,
			kind: 'folder',
			newName: 'source',
			workspaceRevision: 0,
		}, fixture.host);

		assert.strictEqual(renamed.newUri?.toString(), vscode.Uri.file('/workspace/source').toString());
		assert.deepStrictEqual(fixture.renames, [[
			uri.toString(),
			vscode.Uri.file('/workspace/source').toString(),
		]]);
		await deleteWorkspaceNode({
			type: 'workspace.nodeDelete.request',
			requestId: 2,
			nodeId: `folder:${uri.toString()}`,
			kind: 'folder',
			workspaceRevision: 0,
		}, fixture.host);
		assert.deepStrictEqual(fixture.deletes, [[
			uri.toString(),
			{ recursive: true, useTrash: true },
		]]);
	});

	test('Untrusted, virtual 및 readonly mutation은 Host에서도 거부한다', async () => {
		const untrusted = createHost(false);
		const fileUri = vscode.Uri.file('/workspace/file.txt');

		untrusted.files.set(fileUri.toString(), createFileStat());
		await assert.rejects(
			deleteWorkspaceNode({
				type: 'workspace.nodeDelete.request', requestId: 1,
				nodeId: `file:${fileUri.toString()}`, kind: 'file', workspaceRevision: 0,
			}, untrusted.host),
			(error: unknown) => isReason(error, 'not-allowed'),
		);
		const virtual = createHost();
		const virtualUri = vscode.Uri.parse('memfs:/workspace/file.txt');

		virtual.files.set(virtualUri.toString(), createFileStat());
		await assert.rejects(
			renameWorkspaceNode({
				type: 'workspace.nodeRename.request', requestId: 2,
				nodeId: `file:${virtualUri.toString()}`, kind: 'file',
				newName: 'next.txt', workspaceRevision: 0,
			}, virtual.host),
			(error: unknown) => isReason(error, 'unsupported'),
		);
		const readonly = createHost();

		readonly.files.set(fileUri.toString(), {
			...createFileStat(),
			permissions: vscode.FilePermission.Readonly,
		});
		await assert.rejects(
			deleteWorkspaceNode({
				type: 'workspace.nodeDelete.request', requestId: 3,
				nodeId: `file:${fileUri.toString()}`, kind: 'file', workspaceRevision: 0,
			}, readonly.host),
			(error: unknown) => isReason(error, 'read-only'),
		);
	});
});

function createHost(isTrusted = true): {
	readonly host: WorkspaceNodeOperationHost;
	readonly files: Map<string, vscode.FileStat>;
	readonly contents: Map<string, Uint8Array>;
	readonly renames: Array<[string, string]>;
	readonly deletes: Array<[string, { recursive: boolean; useTrash: boolean }]>;
	readonly readFileCalls: number;
} {
	const rootUri = vscode.Uri.file('/workspace');
	const files = new Map<string, vscode.FileStat>();
	const contents = new Map<string, Uint8Array>();
	const renames: Array<[string, string]> = [];
	const deletes: Array<[string, { recursive: boolean; useTrash: boolean }]> = [];
	let readFileCalls = 0;
	const fixture = {
		files,
		contents,
		renames,
		deletes,
		get readFileCalls() { return readFileCalls; },
		host: {
			isTrusted,
			getWorkspaceFolder: (uri) => uri.path.startsWith('/workspace/')
				? { uri: rootUri, name: 'workspace', index: 0 }
				: undefined,
			stat: async (uri) => files.get(uri.toString())
				?? Promise.reject(vscode.FileSystemError.FileNotFound(uri)),
			readFile: async (uri) => {
				readFileCalls += 1;
				return contents.get(uri.toString()) ?? new Uint8Array();
			},
			readDirectory: async () => [],
			rename: async (oldUri, newUri) => {
				renames.push([oldUri.toString(), newUri.toString()]);
			},
			delete: async (uri, options) => {
				deletes.push([uri.toString(), options]);
			},
		},
	} satisfies {
		readonly host: WorkspaceNodeOperationHost;
		readonly files: Map<string, vscode.FileStat>;
		readonly contents: Map<string, Uint8Array>;
		readonly renames: Array<[string, string]>;
		readonly deletes: Array<[string, { recursive: boolean; useTrash: boolean }]>;
		readonly readFileCalls: number;
	};

	return fixture;
}

function createFileStat(): vscode.FileStat {
	return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
}

function createDirectoryStat(): vscode.FileStat {
	return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
}

function isReason(error: unknown, reason: string): boolean {
	return error instanceof WorkspaceNodeOperationError && error.reason === reason;
}
