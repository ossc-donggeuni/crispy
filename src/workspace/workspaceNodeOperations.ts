import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
	WorkspaceMutableNodeKind,
	WorkspaceNodeDetails,
	WorkspaceNodeFailureReason,
	WorkspaceNodeRequestMessage,
} from '../messages';

/** 코드 preview가 Host와 Webview 경계를 통과할 수 있는 최대 byte 수다. */
export const WORKSPACE_FILE_PREVIEW_MAX_BYTES = 1_048_576;

/** VS Code 파일시스템을 테스트 가능한 최소 경계로 좁힌다. */
export interface WorkspaceNodeOperationHost {
	readonly isTrusted: boolean;
	getWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined;
	stat(uri: vscode.Uri): Thenable<vscode.FileStat>;
	readFile(uri: vscode.Uri): Thenable<Uint8Array>;
	readDirectory(uri: vscode.Uri): Thenable<[string, vscode.FileType][]>;
	rename(oldUri: vscode.Uri, newUri: vscode.Uri): Thenable<void>;
	delete(uri: vscode.Uri, options: { recursive: boolean; useTrash: boolean }): Thenable<void>;
}

export interface WorkspaceNodeMutation {
	readonly kind: WorkspaceMutableNodeKind;
	readonly oldUri: vscode.Uri;
	readonly newUri?: vscode.Uri;
	readonly nodeId?: string;
}

export class WorkspaceNodeOperationError extends Error {
	constructor(readonly reason: WorkspaceNodeFailureReason) {
		super(reason);
		this.name = 'WorkspaceNodeOperationError';
	}
}

export const defaultWorkspaceNodeOperationHost: WorkspaceNodeOperationHost = {
	get isTrusted() {
		return vscode.workspace.isTrusted;
	},
	getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri),
	stat: (uri) => vscode.workspace.fs.stat(uri),
	readFile: (uri) => vscode.workspace.fs.readFile(uri),
	readDirectory: (uri) => vscode.workspace.fs.readDirectory(uri),
	rename: (oldUri, newUri) => vscode.workspace.fs.rename(
		oldUri,
		newUri,
		{ overwrite: false },
	),
	delete: (uri, options) => vscode.workspace.fs.delete(uri, options),
};

/** 상세 조회는 Untrusted/readonly Workspace에서도 허용하되 mutation 가능성은 낮춘다. */
export async function readWorkspaceNodeDetails(
	request: Extract<WorkspaceNodeRequestMessage, {
		readonly type: 'workspace.nodeDetails.request';
	}>,
	host: WorkspaceNodeOperationHost = defaultWorkspaceNodeOperationHost,
): Promise<WorkspaceNodeDetails> {
	const { uri } = resolveWorkspaceNode(request.nodeId, request.kind, host);
	let stat: vscode.FileStat;

	try {
		stat = await host.stat(uri);
	} catch (error) {
		throw toWorkspaceNodeOperationError(error);
	}
	assertExpectedFileType(stat.type, request.kind);
	const readonly = Boolean(stat.permissions && (
		stat.permissions & vscode.FilePermission.Readonly
	));
	const workspaceFolder = host.getWorkspaceFolder(uri);
	const relativePath = workspaceFolder
		? path.posix.relative(workspaceFolder.uri.path, uri.path)
		: uri.path;
	const base: WorkspaceNodeDetails = {
		nodeId: request.nodeId,
		kind: request.kind,
		name: path.posix.basename(uri.path),
		relativePath,
		...(stat.ctime > 0 ? { createdAt: stat.ctime } : {}),
		...(stat.mtime > 0 ? { modifiedAt: stat.mtime } : {}),
		readonly,
		canMutate: host.isTrusted && uri.scheme === 'file' && !readonly,
	};

	if (request.kind === 'folder') {
		try {
			const children = await host.readDirectory(uri);

			return {
				...base,
				childFileCount: children.filter(([, type]) => (
					Boolean(type & vscode.FileType.File)
				)).length,
				childFolderCount: children.filter(([, type]) => (
					Boolean(type & vscode.FileType.Directory)
				)).length,
			};
		} catch {
			return base;
		}
	}

	if (stat.size > WORKSPACE_FILE_PREVIEW_MAX_BYTES) {
		return { ...base, size: stat.size, preview: { status: 'too-large' } };
	}
	let bytes: Uint8Array;

	try {
		bytes = await host.readFile(uri);
	} catch {
		return { ...base, size: stat.size, preview: { status: 'unavailable' } };
	}
	if (bytes.byteLength > WORKSPACE_FILE_PREVIEW_MAX_BYTES) {
		return { ...base, size: bytes.byteLength, preview: { status: 'too-large' } };
	}
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

		return {
			...base,
			size: stat.size,
			preview: hasBinaryControlCharacter(text)
				? { status: 'binary' }
				: {
					status: 'ready',
					text,
					languageId: inferMonacoLanguageId(uri.path),
				},
		};
	} catch {
		return { ...base, size: stat.size, preview: { status: 'binary' } };
	}
}

/** 명시 버튼에서 전달된 basename만 같은 parent 아래로 rename한다. */
export async function renameWorkspaceNode(
	request: Omit<Extract<WorkspaceNodeRequestMessage, {
		readonly type: 'workspace.nodeRename.request';
	}>, 'state'>,
	host: WorkspaceNodeOperationHost = defaultWorkspaceNodeOperationHost,
): Promise<WorkspaceNodeMutation> {
	assertMutationAllowed(host);
	assertValidWorkspaceNodeName(request.newName);
	const { uri } = resolveWorkspaceNode(request.nodeId, request.kind, host);
	await assertWritableNode(uri, request.kind, host);
	const currentName = path.posix.basename(uri.path);

	if (request.newName === currentName) {
		throw new WorkspaceNodeOperationError('invalid-name');
	}
	const newUri = uri.with({
		path: `${path.posix.dirname(uri.path)}/${request.newName}`,
	});

	try {
		await host.rename(uri, newUri);
	} catch (error) {
		throw toWorkspaceNodeOperationError(error);
	}
	return {
		kind: request.kind,
		oldUri: uri,
		newUri,
		nodeId: `${request.kind}:${newUri.toString()}`,
	};
}

/** 파일은 단일 항목, 폴더는 subtree를 VS Code Trash 경계로만 삭제한다. */
export async function deleteWorkspaceNode(
	request: Extract<WorkspaceNodeRequestMessage, {
		readonly type: 'workspace.nodeDelete.request';
	}>,
	host: WorkspaceNodeOperationHost = defaultWorkspaceNodeOperationHost,
): Promise<WorkspaceNodeMutation> {
	assertMutationAllowed(host);
	const { uri } = resolveWorkspaceNode(request.nodeId, request.kind, host);
	await assertWritableNode(uri, request.kind, host);

	try {
		await host.delete(uri, {
			recursive: request.kind === 'folder',
			useTrash: true,
		});
	} catch (error) {
		throw toWorkspaceNodeOperationError(error);
	}
	return { kind: request.kind, oldUri: uri };
}

function resolveWorkspaceNode(
	nodeId: string,
	kind: WorkspaceMutableNodeKind,
	host: Pick<WorkspaceNodeOperationHost, 'getWorkspaceFolder'>,
): { readonly uri: vscode.Uri; readonly folder: vscode.WorkspaceFolder } {
	try {
		const prefix = `${kind}:`;
		const uri = vscode.Uri.parse(nodeId.slice(prefix.length), true);
		const folder = host.getWorkspaceFolder(uri);

		if (!folder || uri.toString() === folder.uri.toString()) {
			throw new WorkspaceNodeOperationError('not-allowed');
		}
		return { uri, folder };
	} catch (error) {
		if (error instanceof WorkspaceNodeOperationError) {
			throw error;
		}
		throw new WorkspaceNodeOperationError('not-found');
	}
}

function assertMutationAllowed(host: WorkspaceNodeOperationHost): void {
	if (!host.isTrusted) {
		throw new WorkspaceNodeOperationError('not-allowed');
	}
}

async function assertWritableNode(
	uri: vscode.Uri,
	kind: WorkspaceMutableNodeKind,
	host: WorkspaceNodeOperationHost,
): Promise<void> {
	if (uri.scheme !== 'file') {
		throw new WorkspaceNodeOperationError('unsupported');
	}
	try {
		const stat = await host.stat(uri);

		assertExpectedFileType(stat.type, kind);
		if (stat.permissions && (stat.permissions & vscode.FilePermission.Readonly)) {
			throw new WorkspaceNodeOperationError('read-only');
		}
	} catch (error) {
		throw toWorkspaceNodeOperationError(error);
	}
}

function assertExpectedFileType(
	type: vscode.FileType,
	kind: WorkspaceMutableNodeKind,
): void {
	const expected = kind === 'file' ? vscode.FileType.File : vscode.FileType.Directory;

	if (!Boolean(type & expected)) {
		throw new WorkspaceNodeOperationError('not-found');
	}
}

function assertValidWorkspaceNodeName(name: string): void {
	if (
		name.length === 0
		|| name.length > 255
		|| name === '.'
		|| name === '..'
		|| name.includes('/')
		|| name.includes('\\')
		|| name.includes('\0')
	) {
		throw new WorkspaceNodeOperationError('invalid-name');
	}
}

function toWorkspaceNodeOperationError(error: unknown): WorkspaceNodeOperationError {
	if (error instanceof WorkspaceNodeOperationError) {
		return error;
	}
	const code = error instanceof vscode.FileSystemError ? error.code : undefined;

	if (code === 'FileNotFound') {
		return new WorkspaceNodeOperationError('not-found');
	}
	if (code === 'FileExists') {
		return new WorkspaceNodeOperationError('conflict');
	}
	if (code === 'NoPermissions') {
		return new WorkspaceNodeOperationError('read-only');
	}
	if (code === 'Unavailable') {
		return new WorkspaceNodeOperationError('unsupported');
	}
	return new WorkspaceNodeOperationError('failed');
}

function hasBinaryControlCharacter(text: string): boolean {
	return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text.slice(0, 8_192));
}

function inferMonacoLanguageId(filePath: string): string {
	const extension = path.posix.extname(filePath).toLowerCase();
	const languages: Readonly<Record<string, string>> = {
		'.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cs': 'csharp', '.css': 'css',
		'.go': 'go', '.html': 'html', '.java': 'java', '.js': 'javascript',
		'.json': 'json', '.jsx': 'javascript', '.md': 'markdown', '.php': 'php',
		'.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.scss': 'scss',
		'.sh': 'shell', '.sql': 'sql', '.swift': 'swift', '.ts': 'typescript',
		'.tsx': 'typescript', '.xml': 'xml', '.yaml': 'yaml', '.yml': 'yaml',
	};

	return languages[extension] ?? 'plaintext';
}
