import * as assert from 'node:assert/strict';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import type { GraphNodeEffectTarget } from '../../messages';
import {
	AGENT_ACTIVITY_DIRECTORY_ENTRIES,
	AGENT_ACTIVITY_DIRECTORY_NAME_UTF8_BYTES,
	AGENT_ACTIVITY_METADATA_OPS,
	createAgentActivityGraphTarget,
	createClearAgentActivityTarget,
	matchesAgentActivityLeaseWorkspaceRoot,
	validateSetAgentActivityTarget,
	type AgentActivityFileSystem,
	type AgentActivityFileSystemDirectory,
	type AgentActivityFileSystemDirent,
	type AgentActivityFileSystemStats,
	type AgentActivityTargetLeaseSnapshot,
} from '../../agent/host/terminal/agentActivityTargetValidator';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
} from '../../agent/host/workspace/types';
import { PATH_MAX_UTF8_BYTES } from '../../mcp/agentActivityProtocol';
import { createWorkspaceRootId } from '../../workspace/workspaceRootId';

const ROOT_URI = vscode.Uri.file('/trusted/activity target root');
const ROOT_FS_PATH = ROOT_URI.fsPath;
const ROOT_ID = createWorkspaceRootId(ROOT_URI);
const LEASE: AgentActivityTargetLeaseSnapshot = Object.freeze({
	workspaceRootId: ROOT_ID,
	launchRootUri: ROOT_URI.toString(),
	launchRootFsPath: ROOT_FS_PATH,
});
const ROOT = createValidatedRoot(ROOT_URI);

suite('Agent Activity selected-root target validator', () => {
	test('공개 budget 상수는 metadata/entry/name UTF-8 hard cap을 고정한다', () => {
		assert.strictEqual(AGENT_ACTIVITY_METADATA_OPS, 1_024);
		assert.strictEqual(AGENT_ACTIVITY_DIRECTORY_ENTRIES, 65_536);
		assert.strictEqual(
			AGENT_ACTIVITY_DIRECTORY_NAME_UTF8_BYTES,
			4 * 1_024 * 1_024,
		);
	});

	test('root/file/folder Graph ID를 exact lease URI와 URI join API로 만든다', () => {
		const rootTarget = createAgentActivityGraphTarget(LEASE, ROOT, {
			path: '.',
			targetKind: 'folder',
		});
		const filePath = 'src/source files/한글%name.ts';
		const folderPath = 'packages/client app';
		const fileTarget = createAgentActivityGraphTarget(LEASE, ROOT, {
			path: filePath,
			targetKind: 'file',
		});
		const folderTarget = createAgentActivityGraphTarget(LEASE, ROOT, {
			path: folderPath,
			targetKind: 'folder',
		});

		assert.deepStrictEqual(rootTarget, { nodeId: ROOT_ID });
		assert.deepStrictEqual(fileTarget, {
			nodeId: `file:${vscode.Uri.joinPath(
				ROOT_URI,
				...filePath.split('/'),
			).toString()}`,
		});
		assert.deepStrictEqual(folderTarget, {
			nodeId: `folder:${vscode.Uri.joinPath(
				ROOT_URI,
				...folderPath.split('/'),
			).toString()}`,
		});
		assert.strictEqual(Object.isFrozen(rootTarget), true);
		assert.strictEqual(Object.isFrozen(fileTarget), true);
	});

	test('Host lexical validator를 반복하고 noncanonical child 입력을 보정하지 않는다', () => {
		for (const request of [
			{ path: 'src//index.ts', targetKind: 'file' },
			{ path: 'src\\index.ts', targetKind: 'file' },
			{ path: './src/index.ts', targetKind: 'file' },
			{ path: 'src/../index.ts', targetKind: 'file' },
			{ path: '/src/index.ts', targetKind: 'file' },
			{ path: '.', targetKind: 'file' },
		] as const) {
			assert.strictEqual(
				createAgentActivityGraphTarget(LEASE, ROOT, request),
				undefined,
				request.path,
			);
		}
	});

	test('Windows DOS device target을 Host FS validation 진입 전 drop한다', async () => {
		for (const path of [
			'devices/NUL.txt',
			'CONIN$',
			'nested/devices/conout$.txt',
			'nested/devices/CONIN$:stream',
		]) {
			const request = { path, targetKind: 'file' } as const;
			const fileSystem = new FakeAgentActivityFileSystem();

			assert.strictEqual(
				createAgentActivityGraphTarget(LEASE, ROOT, request, 'win32'),
				undefined,
			);
			assert.strictEqual(
				createClearAgentActivityTarget(LEASE, ROOT, request, 'win32'),
				undefined,
			);
			assert.strictEqual(await validateSetAgentActivityTarget(
				LEASE,
				ROOT,
				request,
				fileSystem,
				'win32',
			), undefined);
			assert.deepStrictEqual(fileSystem.metadataCalls, []);
		}
	});

	test('POSIX는 DOS device와 동일한 filename target을 보존한다', () => {
		const request = {
			path: 'devices/CONOUT$.txt',
			targetKind: 'file',
		} as const;

		assert.deepStrictEqual(
			createClearAgentActivityTarget(LEASE, ROOT, request, 'linux'),
			{
				nodeId: `file:${vscode.Uri.joinPath(
					ROOT_URI,
					'devices',
					'CONOUT$.txt',
				).toString()}`,
			},
		);
	});

	test('fresh resolver의 root ID/URI/fsPath 또는 local file identity 불일치를 거부한다', () => {
		const otherUri = vscode.Uri.file('/trusted/other-root');
		const cases: Array<readonly [
			AgentActivityTargetLeaseSnapshot,
			ValidatedWorkspaceRoot,
		]> = [
			[{ ...LEASE, workspaceRootId: createWorkspaceRootId(otherUri) }, ROOT],
			[{ ...LEASE, launchRootUri: otherUri.toString() }, ROOT],
			[{ ...LEASE, launchRootFsPath: otherUri.fsPath }, ROOT],
			[LEASE, createValidatedRoot(otherUri)],
			[LEASE, createValidatedRoot(ROOT_URI, {
				id: createWorkspaceRootId(otherUri),
			})],
			[LEASE, createValidatedRoot(ROOT_URI, {
				fsPath: otherUri.fsPath,
			})],
			[LEASE, createValidatedRoot(vscode.Uri.parse(
				'vscode-remote://ssh-remote+host/trusted/activity-target-root',
			), { scheme: 'file' })],
		];

		assert.strictEqual(matchesAgentActivityLeaseWorkspaceRoot(LEASE, ROOT), true);
		for (const [lease, root] of cases) {
			assert.strictEqual(
				matchesAgentActivityLeaseWorkspaceRoot(lease, root),
				false,
			);
			assert.strictEqual(createAgentActivityGraphTarget(lease, root, {
				path: 'src/index.ts',
				targetKind: 'file',
			}), undefined);
		}
	});

	test('clear target은 삭제·kind 변경과 무관한 canonical ID를 FS 호출 0으로 만든다', () => {
		const path = 'deleted/was-a-file.ts';
		const targetBeforeDeletion = createAgentActivityGraphTarget(LEASE, ROOT, {
			path,
			targetKind: 'file',
		});
		const target = createClearAgentActivityTarget(LEASE, ROOT, {
			path,
			targetKind: 'file',
		});

		assert.deepStrictEqual(target, targetBeforeDeletion);
		assert.deepStrictEqual(target, {
			nodeId: `file:${vscode.Uri.joinPath(
				ROOT_URI,
				...path.split('/'),
			).toString()}`,
		});
	});

	test('existing root, intermediate directory와 final file/folder kind를 검증한다', async () => {
		const rootFileSystem = createFileSystemWithPath([], 'folder');
		const rootResult = await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: '.', targetKind: 'folder' },
			rootFileSystem,
		);
		assert.deepStrictEqual(rootResult, {
			target: { nodeId: ROOT_ID },
			provisional: false,
		});
		assert.deepStrictEqual(rootFileSystem.metadataCalls.map(({ operation }) => (
			operation
		)), ['lstat', 'stat', 'realpath']);

		for (const [path, targetKind] of [
			['src/nested/index.ts', 'file'],
			['src/nested', 'folder'],
		] as const) {
			const segments = path.split('/');
			const fileSystem = createFileSystemWithPath(segments, targetKind);
			const result = await validateSetAgentActivityTarget(
				LEASE,
				ROOT,
				{ path, targetKind },
				fileSystem,
			);

			assert.deepStrictEqual(result, {
				target: {
					nodeId: `${targetKind}:${vscode.Uri.joinPath(
						ROOT_URI,
						...segments,
					).toString()}`,
				},
				provisional: false,
			});
			assert.strictEqual(
				fileSystem.closeCalls,
				segments.length,
			);
		}
	});

	test('launch-boundary root symlink alias는 허용하고 descendant symlink/junction은 거부한다', async () => {
		const realRoot = '/real/activity-target-root';
		const rootAliasFileSystem = new FakeAgentActivityFileSystem();
		rootAliasFileSystem.addNode(ROOT_FS_PATH, {
			kind: 'symlink',
			statKind: 'folder',
			realPath: realRoot,
		});
		rootAliasFileSystem.addChild(
			ROOT_FS_PATH,
			'index.ts',
			'file',
			{ realPath: nodePath.join(realRoot, 'index.ts') },
		);

		assert.deepStrictEqual(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: 'index.ts', targetKind: 'file' },
			rootAliasFileSystem,
		), {
			target: {
				nodeId: `file:${vscode.Uri.joinPath(ROOT_URI, 'index.ts').toString()}`,
			},
			provisional: false,
		});

		for (const targetKind of ['file', 'folder'] as const) {
			const descendantFileSystem = new FakeAgentActivityFileSystem();
			descendantFileSystem.addNode(ROOT_FS_PATH, { kind: 'folder' });
			descendantFileSystem.addChild(
				ROOT_FS_PATH,
				'linked',
				'symlink',
				{ statKind: targetKind },
			);

			assert.strictEqual(await validateSetAgentActivityTarget(
				LEASE,
				ROOT,
				{ path: 'linked', targetKind },
				descendantFileSystem,
			), undefined);
			assert.strictEqual(descendantFileSystem.closeCalls, 1);
		}
	});

	test('special type, intermediate file, final kind와 Dirent/metadata 불일치를 drop한다', async () => {
		const special = new FakeAgentActivityFileSystem();
		special.addNode(ROOT_FS_PATH, { kind: 'folder' });
		special.addChild(ROOT_FS_PATH, 'socket', 'special');

		const intermediateFile = new FakeAgentActivityFileSystem();
		intermediateFile.addNode(ROOT_FS_PATH, { kind: 'folder' });
		intermediateFile.addChild(ROOT_FS_PATH, 'src', 'file');

		const wrongFinalKind = createFileSystemWithPath(['src'], 'folder');

		const inconsistent = new FakeAgentActivityFileSystem();
		inconsistent.addNode(ROOT_FS_PATH, { kind: 'folder' });
		inconsistent.addChild(ROOT_FS_PATH, 'index.ts', 'file', {
			entryKind: 'folder',
		});

		for (const [fileSystem, request] of [
			[special, { path: 'socket', targetKind: 'file' }],
			[intermediateFile, { path: 'src/index.ts', targetKind: 'file' }],
			[wrongFinalKind, { path: 'src', targetKind: 'file' }],
			[inconsistent, { path: 'index.ts', targetKind: 'file' }],
		] as const) {
			assert.strictEqual(await validateSetAgentActivityTarget(
				LEASE,
				ROOT,
				request,
				fileSystem,
			), undefined);
		}
	});

	test('root realpath 안의 target만 허용하고 containment escape를 drop한다', async () => {
		const contained = createFileSystemWithPath(['src', 'index.ts'], 'file');
		const escaped = createFileSystemWithPath(['src', 'index.ts'], 'file');
		escaped.getNode(nodePath.join(ROOT_FS_PATH, 'src', 'index.ts')).realPath =
			'/outside/private/index.ts';

		assert.ok(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: 'src/index.ts', targetKind: 'file' },
			contained,
		));
		assert.strictEqual(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: 'src/index.ts', targetKind: 'file' },
			escaped,
		), undefined);
	});

	test('exact EOF와 ENOENT 뒤 suffix만 provisional이고 추가 suffix FS 작업을 하지 않는다', async () => {
		const fileSystem = new FakeAgentActivityFileSystem();
		fileSystem.addNode(ROOT_FS_PATH, { kind: 'folder' });
		const result = await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: 'new/deep/index.ts', targetKind: 'file' },
			fileSystem,
		);

		assert.deepStrictEqual(result, {
			target: {
				nodeId: `file:${vscode.Uri.joinPath(
					ROOT_URI,
					'new',
					'deep',
					'index.ts',
				).toString()}`,
			},
			provisional: true,
		});
		assert.deepStrictEqual(fileSystem.metadataCalls, [
			{ operation: 'lstat', path: ROOT_FS_PATH },
			{ operation: 'stat', path: ROOT_FS_PATH },
			{ operation: 'realpath', path: ROOT_FS_PATH },
			{ operation: 'opendir', path: ROOT_FS_PATH },
			{ operation: 'lstat', path: nodePath.join(ROOT_FS_PATH, 'new') },
		]);
		assert.strictEqual(fileSystem.directoryReadCalls, 1);
		assert.strictEqual(fileSystem.closeCalls, 1);
	});

	test('case/Unicode alias와 exact entry 뒤 deletion을 nonexistent provisional로 보정하지 않는다', async () => {
		for (const [requestedName, diskName] of [
			['index.ts', 'Index.ts'],
			['\u00e9.ts', 'e\u0301.ts'],
		] as const) {
			const fileSystem = new FakeAgentActivityFileSystem();
			fileSystem.addNode(ROOT_FS_PATH, { kind: 'folder' });
			const diskPath = fileSystem.addChild(
				ROOT_FS_PATH,
				diskName,
				'file',
			);
			fileSystem.addLookupAlias(
				nodePath.join(ROOT_FS_PATH, requestedName),
				diskPath,
			);

			assert.strictEqual(await validateSetAgentActivityTarget(
				LEASE,
				ROOT,
				{ path: requestedName, targetKind: 'file' },
				fileSystem,
			), undefined);
		}

		const deleted = new FakeAgentActivityFileSystem();
		deleted.addNode(ROOT_FS_PATH, { kind: 'folder' });
		deleted.addDirectoryEntry(ROOT_FS_PATH, 'deleted.ts', 'file');
		assert.strictEqual(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: 'deleted.ts', targetKind: 'file' },
			deleted,
		), undefined);
	});

	test('permission/read/close와 metadata inconsistency 실패에도 opened directory를 finally 닫는다', async () => {
		const readFailure = new FakeAgentActivityFileSystem();
		readFailure.addNode(ROOT_FS_PATH, {
			kind: 'folder',
			readErrorAt: 0,
		});
		assert.strictEqual(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: 'index.ts', targetKind: 'file' },
			readFailure,
		), undefined);
		assert.strictEqual(readFailure.closeCalls, 1);

		const closeFailure = createFileSystemWithPath(['index.ts'], 'file');
		closeFailure.getNode(ROOT_FS_PATH).closeError = true;
		assert.strictEqual(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: 'index.ts', targetKind: 'file' },
			closeFailure,
		), undefined);
		assert.strictEqual(closeFailure.closeCalls, 1);

		for (const operation of ['lstat', 'stat', 'realpath', 'opendir'] as const) {
			const failed = createFileSystemWithPath(['index.ts'], 'file');
			failed.failOperation(operation, ROOT_FS_PATH, 'EACCES');
			assert.strictEqual(await validateSetAgentActivityTarget(
				LEASE,
				ROOT,
				{ path: 'index.ts', targetKind: 'file' },
				failed,
			), undefined);
		}
	});

	test('metadata N까지 사용하되 N+1 operation을 시작하지 않고 close는 허용한다', async () => {
		const acceptedSegments = Array.from({ length: 255 }, () => 'a');
		const accepted = createFileSystemWithPath(acceptedSegments, 'folder');
		assert.ok(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: acceptedSegments.join('/'), targetKind: 'folder' },
			accepted,
		));
		assert.strictEqual(accepted.metadataCalls.length, 1_023);

		const overSegments = [...acceptedSegments, 'a'];
		const over = createFileSystemWithPath(overSegments, 'folder');
		assert.strictEqual(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: overSegments.join('/'), targetKind: 'folder' },
			over,
		), undefined);
		assert.strictEqual(over.metadataCalls.length, AGENT_ACTIVITY_METADATA_OPS);
		assert.deepStrictEqual(over.metadataCalls.at(-1), {
			operation: 'opendir',
			path: nodePath.join(ROOT_FS_PATH, ...acceptedSegments),
		});
		assert.strictEqual(over.closeCalls, over.openDirectoryCalls);
	});

	test('directory entry N exact match를 허용하고 N+1 entry read를 시작하지 않는다', async () => {
		const targetName = 'target.ts';
		const atLimit = new FakeAgentActivityFileSystem();
		atLimit.addNode(ROOT_FS_PATH, { kind: 'folder' });
		for (let index = 0; index < AGENT_ACTIVITY_DIRECTORY_ENTRIES - 1; index += 1) {
			atLimit.addDirectoryEntry(ROOT_FS_PATH, `entry-${index}`, 'file');
		}
		atLimit.addChild(ROOT_FS_PATH, targetName, 'file');
		assert.ok(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: targetName, targetKind: 'file' },
			atLimit,
		));
		assert.strictEqual(
			atLimit.directoryReadCalls,
			AGENT_ACTIVITY_DIRECTORY_ENTRIES,
		);

		const overLimit = new FakeAgentActivityFileSystem();
		overLimit.addNode(ROOT_FS_PATH, { kind: 'folder' });
		for (let index = 0; index < AGENT_ACTIVITY_DIRECTORY_ENTRIES; index += 1) {
			overLimit.addDirectoryEntry(ROOT_FS_PATH, `entry-${index}`, 'file');
		}
		overLimit.addChild(ROOT_FS_PATH, targetName, 'file');
		assert.strictEqual(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: targetName, targetKind: 'file' },
			overLimit,
		), undefined);
		assert.strictEqual(
			overLimit.directoryReadCalls,
			AGENT_ACTIVITY_DIRECTORY_ENTRIES,
		);
		assert.strictEqual(overLimit.closeCalls, 1);
		assert.strictEqual(overLimit.metadataCalls.some((call) => (
			call.operation === 'lstat'
			&& call.path === nodePath.join(ROOT_FS_PATH, targetName)
		)), false);
	});

	test('directory name UTF-8 N exact match를 허용하고 partial remainder N+1 read를 시작하지 않는다', async () => {
		const targetName = 't'.repeat(PATH_MAX_UTF8_BYTES);
		const atLimit = new FakeAgentActivityFileSystem();
		atLimit.addNode(ROOT_FS_PATH, { kind: 'folder' });
		for (
			let index = 0;
			index < AGENT_ACTIVITY_DIRECTORY_NAME_UTF8_BYTES
				/ PATH_MAX_UTF8_BYTES - 1;
			index += 1
		) {
			atLimit.addDirectoryEntry(
				ROOT_FS_PATH,
				fixedUtf8Name(index, PATH_MAX_UTF8_BYTES),
				'file',
			);
		}
		atLimit.addChild(ROOT_FS_PATH, targetName, 'file');
		assert.ok(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: targetName, targetKind: 'file' },
			atLimit,
		));
		assert.strictEqual(
			atLimit.directoryReadCalls,
			AGENT_ACTIVITY_DIRECTORY_NAME_UTF8_BYTES / PATH_MAX_UTF8_BYTES,
		);

		const overLimit = new FakeAgentActivityFileSystem();
		overLimit.addNode(ROOT_FS_PATH, { kind: 'folder' });
		for (
			let index = 0;
			index < AGENT_ACTIVITY_DIRECTORY_NAME_UTF8_BYTES
				/ PATH_MAX_UTF8_BYTES - 1;
			index += 1
		) {
			overLimit.addDirectoryEntry(
				ROOT_FS_PATH,
				fixedUtf8Name(index, PATH_MAX_UTF8_BYTES),
				'file',
			);
		}
		overLimit.addDirectoryEntry(
			ROOT_FS_PATH,
			'x'.repeat(PATH_MAX_UTF8_BYTES - 1),
			'file',
		);
		overLimit.addChild(ROOT_FS_PATH, 'é', 'file');
		assert.strictEqual(await validateSetAgentActivityTarget(
			LEASE,
			ROOT,
			{ path: 'é', targetKind: 'file' },
			overLimit,
		), undefined);
		assert.strictEqual(
			overLimit.directoryReadCalls,
			AGENT_ACTIVITY_DIRECTORY_NAME_UTF8_BYTES / PATH_MAX_UTF8_BYTES,
		);
		assert.strictEqual(overLimit.closeCalls, 1);
	});
});

type FakeFileSystemKind = 'folder' | 'file' | 'symlink' | 'special';
type MetadataOperation = 'lstat' | 'stat' | 'realpath' | 'opendir';

interface FakeDirectoryEntry {
	readonly name: string;
	readonly kind: FakeFileSystemKind;
}

interface FakeNodeOptions {
	kind: FakeFileSystemKind;
	statKind?: FakeFileSystemKind;
	realPath?: string;
	entries?: FakeDirectoryEntry[];
	readErrorAt?: number;
	closeError?: boolean;
}

interface AddChildOptions {
	readonly entryKind?: FakeFileSystemKind;
	readonly statKind?: FakeFileSystemKind;
	readonly realPath?: string;
}

class FakeAgentActivityFileSystem implements AgentActivityFileSystem {
	readonly metadataCalls: Array<Readonly<{
		operation: MetadataOperation;
		path: string;
	}>> = [];
	directoryReadCalls = 0;
	closeCalls = 0;
	openDirectoryCalls = 0;
	private readonly nodes = new Map<string, FakeNodeOptions>();
	private readonly lookupAliases = new Map<string, string>();
	private readonly failures = new Map<string, string>();

	addNode(path: string, options: FakeNodeOptions): void {
		this.nodes.set(path, {
			...options,
			entries: options.entries ?? [],
			realPath: options.realPath ?? path,
		});
	}

	getNode(path: string): FakeNodeOptions {
		const node = this.nodes.get(path);
		assert.ok(node !== undefined, `Missing fake node: ${path}`);
		return node;
	}

	addChild(
		parentPath: string,
		name: string,
		kind: FakeFileSystemKind,
		options: AddChildOptions = {},
	): string {
		const childPath = nodePath.join(parentPath, name);
		this.addDirectoryEntry(
			parentPath,
			name,
			options.entryKind ?? kind,
		);
		this.addNode(childPath, {
			kind,
			statKind: options.statKind,
			realPath: options.realPath,
		});
		return childPath;
	}

	addDirectoryEntry(
		parentPath: string,
		name: string,
		kind: FakeFileSystemKind,
	): void {
		const parent = this.getNode(parentPath);
		(parent.entries ??= []).push({ name, kind });
	}

	addLookupAlias(aliasPath: string, targetPath: string): void {
		this.lookupAliases.set(aliasPath, targetPath);
	}

	failOperation(
		operation: MetadataOperation,
		path: string,
		code: string,
	): void {
		this.failures.set(`${operation}:${path}`, code);
	}

	async lstat(path: string): Promise<AgentActivityFileSystemStats> {
		this.record('lstat', path);
		return createFakeStats(this.lookupNode(path).kind);
	}

	async stat(path: string): Promise<AgentActivityFileSystemStats> {
		this.record('stat', path);
		const node = this.lookupNode(path);
		return createFakeStats(node.statKind ?? node.kind);
	}

	async realpath(path: string): Promise<string> {
		this.record('realpath', path);
		return this.lookupNode(path).realPath ?? path;
	}

	async opendir(path: string): Promise<AgentActivityFileSystemDirectory> {
		this.record('opendir', path);
		this.openDirectoryCalls += 1;
		const node = this.lookupNode(path);
		if ((node.statKind ?? node.kind) !== 'folder') {
			throw fileSystemError('ENOTDIR');
		}
		let index = 0;
		let closed = false;

		return {
			read: async (): Promise<AgentActivityFileSystemDirent | null> => {
				if (closed) {
					throw fileSystemError('EBADF');
				}
				this.directoryReadCalls += 1;
				if (node.readErrorAt === index) {
					throw fileSystemError('EACCES');
				}
				const entry = node.entries?.[index];
				index += 1;
				return entry === undefined ? null : createFakeDirent(entry);
			},
			close: async (): Promise<void> => {
				this.closeCalls += 1;
				closed = true;
				if (node.closeError) {
					throw fileSystemError('EIO');
				}
			},
		};
	}

	private record(operation: MetadataOperation, path: string): void {
		this.metadataCalls.push({ operation, path });
		const failure = this.failures.get(`${operation}:${path}`);
		if (failure !== undefined) {
			throw fileSystemError(failure);
		}
	}

	private lookupNode(path: string): FakeNodeOptions {
		const exactPath = this.lookupAliases.get(path) ?? path;
		const node = this.nodes.get(exactPath);
		if (node === undefined) {
			throw fileSystemError('ENOENT');
		}
		return node;
	}
}

function createFileSystemWithPath(
	segments: readonly string[],
	targetKind: Extract<FakeFileSystemKind, 'file' | 'folder'>,
): FakeAgentActivityFileSystem {
	const fileSystem = new FakeAgentActivityFileSystem();
	fileSystem.addNode(ROOT_FS_PATH, { kind: 'folder' });
	let parentPath = ROOT_FS_PATH;
	for (const [index, segment] of segments.entries()) {
		const final = index === segments.length - 1;
		parentPath = fileSystem.addChild(
			parentPath,
			segment,
			final ? targetKind : 'folder',
		);
	}
	return fileSystem;
}

function fixedUtf8Name(index: number, byteLength: number): string {
	const prefix = `${index}-`;
	assert.ok(Buffer.byteLength(prefix, 'utf8') <= byteLength);
	return `${prefix}${'x'.repeat(byteLength - Buffer.byteLength(prefix, 'utf8'))}`;
}

function createFakeStats(kind: FakeFileSystemKind): AgentActivityFileSystemStats {
	return {
		isDirectory: () => kind === 'folder',
		isFile: () => kind === 'file',
		isSymbolicLink: () => kind === 'symlink',
	};
}

function createFakeDirent(
	entry: FakeDirectoryEntry,
): AgentActivityFileSystemDirent {
	return {
		name: entry.name,
		isDirectory: () => entry.kind === 'folder',
		isFile: () => entry.kind === 'file',
		isSymbolicLink: () => entry.kind === 'symlink',
	};
}

function createValidatedRoot(
	uri: vscode.Uri,
	overrides: Readonly<{
		id?: ValidatedWorkspaceRoot['id'];
		fsPath?: string;
		scheme?: 'file';
	}> = {},
): ValidatedWorkspaceRoot {
	return {
		id: overrides.id ?? createWorkspaceRootId(uri),
		scheme: overrides.scheme ?? 'file',
		fsPath: (overrides.fsPath ?? uri.fsPath) as ValidatedWorkspaceFsPath,
		workspaceFolder: { uri, name: 'activity target root', index: 0 },
	} as unknown as ValidatedWorkspaceRoot;
}

function fileSystemError(code: string): Error & { readonly code: string } {
	return Object.assign(new Error('fake filesystem failure'), { code });
}

/** Compile-time guard: generated public targets remain the existing Graph contract. */
type TargetContract = Readonly<GraphNodeEffectTarget>;
const _targetContract: TargetContract | undefined = createAgentActivityGraphTarget(
	LEASE,
	ROOT,
	{ path: '.', targetKind: 'folder' },
);
void _targetContract;
