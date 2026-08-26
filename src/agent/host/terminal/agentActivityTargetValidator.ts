import type { Dirent, Stats } from 'node:fs';
import * as fileSystemPromises from 'node:fs/promises';
import * as nodePath from 'node:path';
import * as vscode from 'vscode';
import {
	normalizeAgentActivityPath,
	PATH_MAX_UTF8_BYTES,
	type AgentActivityTargetKind,
} from '../../../mcp/agentActivityProtocol';
import type { GraphNodeEffectTarget } from '../../../messages';
import {
	createWorkspaceRootId,
	type WorkspaceRootId,
} from '../../../workspace/workspaceRootId';
import type { ValidatedWorkspaceRoot } from '../workspace/types';

/** 한 Activity set validation이 시작할 수 있는 filesystem metadata 작업 수다. */
export const AGENT_ACTIVITY_METADATA_OPS = 1_024;

/** 한 Activity set validation이 사용할 수 있는 streamed directory entry 수다. */
export const AGENT_ACTIVITY_DIRECTORY_ENTRIES = 65_536;

/** 한 Activity set validation이 사용할 수 있는 directory name UTF-8 byte 수다. */
export const AGENT_ACTIVITY_DIRECTORY_NAME_UTF8_BYTES = 4 * 1_024 * 1_024;

/**
 * Node Dir.read()는 다음 name byte 크기를 read 전에 노출하지 않는다. Activity가
 * 수용할 수 있는 최대 path byte를 Dirent 1개의 보수적 reservation으로
 * 사용한다. 따라서 4 KiB 미만이 남으면 실제 이름이 더 작아도 fail-closed하며,
 * 임의의 entry 조합이 actual byte cap을 정확히 끝까지 쓸 수 있음을 뜻하지
 * 않는다. 또한 4 KiB를 넘는 비정상 Dirent는 Node API상 read 후에만 크기를
 * 알 수 있어 즉시 drop하지만, 그 read 자체를 사전에 막을 수는 없다.
 */
const DIRECTORY_NAME_READ_RESERVATION_UTF8_BYTES = PATH_MAX_UTF8_BYTES;

/** Exact Host lease에서 Graph target 생성에 필요한 path-free root identity다. */
export interface AgentActivityTargetLeaseSnapshot {
	readonly workspaceRootId: WorkspaceRootId;
	readonly launchRootUri: string;
	readonly launchRootFsPath: string;
}

/** Set과 clear가 공유하는 canonical child target 입력이다. */
export interface AgentActivityTargetRequest {
	readonly path: string;
	readonly targetKind: AgentActivityTargetKind;
}

/** Node filesystem metadata에서 사용하는 최소 판독 계약이다. */
export type AgentActivityFileSystemStats = Pick<
	Stats,
	'isDirectory' | 'isFile' | 'isSymbolicLink'
>;

/** Streaming directory exact-spelling 검사에서 사용하는 최소 Dirent 계약이다. */
export type AgentActivityFileSystemDirent = Pick<
	Dirent,
	'name' | 'isDirectory' | 'isFile' | 'isSymbolicLink'
>;

/** `opendir` 결과를 budget-aware하게 한 항목씩 읽고 항상 닫는 계약이다. */
export interface AgentActivityFileSystemDirectory {
	read(): Promise<AgentActivityFileSystemDirent | null>;
	close(): Promise<void>;
}

/** Production Node fs와 결정적 테스트 fake가 공유하는 비동기 filesystem 경계다. */
export interface AgentActivityFileSystem {
	lstat(path: string): Promise<AgentActivityFileSystemStats>;
	stat(path: string): Promise<AgentActivityFileSystemStats>;
	realpath(path: string): Promise<string>;
	opendir(path: string): Promise<AgentActivityFileSystemDirectory>;
}

/** Set validation 성공 시 wire target과 provisional 여부만 다음 계층에 전달한다. */
export interface ValidatedAgentActivityTarget {
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly provisional: boolean;
}

const nodeAgentActivityFileSystem: AgentActivityFileSystem = Object.freeze({
	lstat: (path: string) => fileSystemPromises.lstat(path),
	stat: (path: string) => fileSystemPromises.stat(path),
	realpath: (path: string) => fileSystemPromises.realpath(path),
	opendir: async (path: string) => fileSystemPromises.opendir(path),
});

interface PreparedAgentActivityTarget {
	readonly canonicalPath: string;
	readonly rootUri: vscode.Uri;
	readonly target: Readonly<GraphNodeEffectTarget>;
}

interface ValidationBudget {
	metadataOps: number;
	directoryEntries: number;
	directoryNameUtf8Bytes: number;
}

type FileSystemKind = 'folder' | 'file' | 'symlink' | 'special';

type MetadataResult<Value> =
	| { readonly ok: true; readonly value: Value }
	| {
		readonly ok: false;
		readonly reason: 'budget' | 'filesystem';
		readonly error?: unknown;
	};

type DirectoryEntryResult =
	| {
		readonly kind: 'found';
		readonly entry: AgentActivityFileSystemDirent;
	}
	| { readonly kind: 'missing' }
	| { readonly kind: 'failed' };

/**
 * Fresh resolver 결과가 lease가 native launch 때 capture한 exact local file root인지 검사한다.
 * URI parsing이나 path normalization으로 불일치를 보정하지 않는다.
 */
export function matchesAgentActivityLeaseWorkspaceRoot(
	lease: AgentActivityTargetLeaseSnapshot,
	root: ValidatedWorkspaceRoot,
): boolean {
	return resolveExactLeaseRootUri(lease, root) !== undefined;
}

/**
 * Canonical child path를 existing Graph URI ID로 변환한다. Filesystem은 사용하지 않는다.
 * `.` folder는 Workspace project node 자체를 가리킨다.
 */
export function createAgentActivityGraphTarget(
	lease: AgentActivityTargetLeaseSnapshot,
	root: ValidatedWorkspaceRoot,
	request: AgentActivityTargetRequest,
	platform: NodeJS.Platform = process.platform,
): Readonly<GraphNodeEffectTarget> | undefined {
	return prepareAgentActivityTarget(lease, root, request, platform)?.target;
}

/**
 * Clear의 deterministic target을 생성한다. 삭제 또는 kind 변경 뒤에도 같은 canonical
 * path와 lease root만 사용하며 lstat/stat/realpath/opendir를 호출하지 않는다.
 */
export function createClearAgentActivityTarget(
	lease: AgentActivityTargetLeaseSnapshot,
	root: ValidatedWorkspaceRoot,
	request: AgentActivityTargetRequest,
	platform: NodeJS.Platform = process.platform,
): Readonly<GraphNodeEffectTarget> | undefined {
	return createAgentActivityGraphTarget(lease, root, request, platform);
}

/**
 * Set target의 exact spelling, kind와 realpath containment를 bounded filesystem 작업으로
 * 검증한다. Exact EOF 뒤 실제로 존재하지 않는 첫 segment부터만 provisional로 허용한다.
 */
export async function validateSetAgentActivityTarget(
	lease: AgentActivityTargetLeaseSnapshot,
	root: ValidatedWorkspaceRoot,
	request: AgentActivityTargetRequest,
	fileSystem: AgentActivityFileSystem = nodeAgentActivityFileSystem,
	platform: NodeJS.Platform = process.platform,
): Promise<ValidatedAgentActivityTarget | undefined> {
	const prepared = prepareAgentActivityTarget(lease, root, request, platform);
	if (prepared === undefined) {
		return undefined;
	}

	const budget: ValidationBudget = {
		metadataOps: 0,
		directoryEntries: 0,
		directoryNameUtf8Bytes: 0,
	};
	const rootLstat = await runMetadataOperation(
		budget,
		() => fileSystem.lstat(lease.launchRootFsPath),
	);
	if (!rootLstat.ok) {
		return undefined;
	}
	const rootLstatKind = classifyStats(rootLstat.value);
	if (rootLstatKind !== 'folder' && rootLstatKind !== 'symlink') {
		return undefined;
	}

	const rootStat = await runMetadataOperation(
		budget,
		() => fileSystem.stat(lease.launchRootFsPath),
	);
	if (!rootStat.ok || classifyStats(rootStat.value) !== 'folder') {
		return undefined;
	}

	const rootRealpath = await runMetadataOperation(
		budget,
		() => fileSystem.realpath(lease.launchRootFsPath),
	);
	if (
		!rootRealpath.ok
		|| !nodePath.isAbsolute(rootRealpath.value)
	) {
		return undefined;
	}
	const realRootPath = rootRealpath.value;
	let parentFsPath = lease.launchRootFsPath;
	let parentRealPath = realRootPath;
	const segments = prepared.canonicalPath === '.'
		? []
		: prepared.canonicalPath.split('/');

	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (segment === undefined || !isRealpathContained(realRootPath, parentRealPath)) {
			return undefined;
		}

		const entryResult = await readExactDirectoryEntry(
			fileSystem,
			parentFsPath,
			segment,
			budget,
		);
		const candidateFsPath = nodePath.join(parentFsPath, segment);
		if (entryResult.kind === 'failed') {
			return undefined;
		}
		if (entryResult.kind === 'missing') {
			/**
			 * On case/Unicode-insensitive filesystems an inexact spelling may still resolve.
			 * Only ENOENT after exact streamed EOF establishes a provisional suffix.
			 */
			const aliasProbe = await runMetadataOperation(
				budget,
				() => fileSystem.lstat(candidateFsPath),
			);
			if (
				aliasProbe.ok
				|| aliasProbe.reason !== 'filesystem'
				|| !isMissingFileSystemError(aliasProbe.error)
			) {
				return undefined;
			}

			return Object.freeze({
				target: prepared.target,
				provisional: true,
			});
		}

		const directoryKind = classifyDirent(entryResult.entry);
		if (directoryKind === 'symlink' || directoryKind === 'special') {
			return undefined;
		}

		const candidateLstat = await runMetadataOperation(
			budget,
			() => fileSystem.lstat(candidateFsPath),
		);
		if (!candidateLstat.ok) {
			return undefined;
		}
		const candidateLstatKind = classifyStats(candidateLstat.value);
		if (
			candidateLstatKind === 'symlink'
			|| candidateLstatKind === 'special'
			|| candidateLstatKind !== directoryKind
		) {
			return undefined;
		}

		const candidateStat = await runMetadataOperation(
			budget,
			() => fileSystem.stat(candidateFsPath),
		);
		if (!candidateStat.ok) {
			return undefined;
		}
		const candidateStatKind = classifyStats(candidateStat.value);
		if (
			candidateStatKind === 'symlink'
			|| candidateStatKind === 'special'
			|| candidateStatKind !== candidateLstatKind
		) {
			return undefined;
		}

		const isFinalSegment = index === segments.length - 1;
		if (
			(!isFinalSegment && candidateStatKind !== 'folder')
			|| (
				isFinalSegment
				&& candidateStatKind !== request.targetKind
			)
		) {
			return undefined;
		}

		const candidateRealpath = await runMetadataOperation(
			budget,
			() => fileSystem.realpath(candidateFsPath),
		);
		if (
			!candidateRealpath.ok
			|| !nodePath.isAbsolute(candidateRealpath.value)
			|| !isRealpathContained(realRootPath, candidateRealpath.value)
		) {
			return undefined;
		}

		parentFsPath = candidateFsPath;
		parentRealPath = candidateRealpath.value;
	}

	return Object.freeze({
		target: prepared.target,
		provisional: false,
	});
}

function prepareAgentActivityTarget(
	lease: AgentActivityTargetLeaseSnapshot,
	root: ValidatedWorkspaceRoot,
	request: AgentActivityTargetRequest,
	platform: NodeJS.Platform,
): PreparedAgentActivityTarget | undefined {
	const normalized = normalizeAgentActivityPath(
		request.path,
		request.targetKind,
		platform,
	);
	if (!normalized.ok || normalized.path !== request.path) {
		return undefined;
	}

	const rootUri = resolveExactLeaseRootUri(lease, root);
	if (rootUri === undefined) {
		return undefined;
	}

	const target = normalized.path === '.'
		? Object.freeze({ nodeId: lease.workspaceRootId })
		: Object.freeze({
			nodeId: `${request.targetKind}:${vscode.Uri.joinPath(
				rootUri,
				...normalized.path.split('/'),
			).toString()}`,
		});

	return Object.freeze({
		canonicalPath: normalized.path,
		rootUri,
		target,
	});
}

function resolveExactLeaseRootUri(
	lease: AgentActivityTargetLeaseSnapshot,
	root: ValidatedWorkspaceRoot,
): vscode.Uri | undefined {
	if (
		root.id !== lease.workspaceRootId
		|| root.scheme !== 'file'
		|| root.fsPath !== lease.launchRootFsPath
		|| !nodePath.isAbsolute(lease.launchRootFsPath)
	) {
		return undefined;
	}

	try {
		const freshRootUri = root.workspaceFolder.uri;
		if (
			freshRootUri.scheme !== 'file'
			|| freshRootUri.fsPath !== lease.launchRootFsPath
			|| freshRootUri.toString() !== lease.launchRootUri
		) {
			return undefined;
		}

		const leaseRootUri = vscode.Uri.parse(lease.launchRootUri, true);
		if (
			leaseRootUri.scheme !== 'file'
			|| leaseRootUri.query.length !== 0
			|| leaseRootUri.fragment.length !== 0
			|| leaseRootUri.fsPath !== lease.launchRootFsPath
			|| leaseRootUri.toString() !== lease.launchRootUri
			|| createWorkspaceRootId(leaseRootUri) !== lease.workspaceRootId
		) {
			return undefined;
		}

		return leaseRootUri;
	} catch {
		return undefined;
	}
}

async function readExactDirectoryEntry(
	fileSystem: AgentActivityFileSystem,
	parentFsPath: string,
	exactName: string,
	budget: ValidationBudget,
): Promise<DirectoryEntryResult> {
	const opened = await runMetadataOperation(
		budget,
		() => fileSystem.opendir(parentFsPath),
	);
	if (!opened.ok) {
		return { kind: 'failed' };
	}

	let result: DirectoryEntryResult = { kind: 'failed' };
	let closeSucceeded = false;
	try {
		while (true) {
			/** Do not issue the read which could return entry N+1. */
			const remainingNameUtf8Bytes =
				AGENT_ACTIVITY_DIRECTORY_NAME_UTF8_BYTES
				- budget.directoryNameUtf8Bytes;
			if (
				budget.directoryEntries >= AGENT_ACTIVITY_DIRECTORY_ENTRIES
				|| remainingNameUtf8Bytes
					< DIRECTORY_NAME_READ_RESERVATION_UTF8_BYTES
			) {
				break;
			}

			const entry = await opened.value.read();
			if (entry === null) {
				result = { kind: 'missing' };
				break;
			}
			if (typeof entry.name !== 'string') {
				break;
			}

			const nameBytes = Buffer.byteLength(entry.name, 'utf8');
			if (
				nameBytes > DIRECTORY_NAME_READ_RESERVATION_UTF8_BYTES
				|| budget.directoryEntries + 1
					> AGENT_ACTIVITY_DIRECTORY_ENTRIES
				|| budget.directoryNameUtf8Bytes + nameBytes
					> AGENT_ACTIVITY_DIRECTORY_NAME_UTF8_BYTES
			) {
				break;
			}
			budget.directoryEntries += 1;
			budget.directoryNameUtf8Bytes += nameBytes;

			if (entry.name === exactName) {
				result = { kind: 'found', entry };
				break;
			}
		}
	} catch {
		result = { kind: 'failed' };
	} finally {
		try {
			await opened.value.close();
			closeSucceeded = true;
		} catch {
			closeSucceeded = false;
		}
	}

	return closeSucceeded ? result : { kind: 'failed' };
}

async function runMetadataOperation<Value>(
	budget: ValidationBudget,
	operation: () => Promise<Value>,
): Promise<MetadataResult<Value>> {
	if (budget.metadataOps >= AGENT_ACTIVITY_METADATA_OPS) {
		return { ok: false, reason: 'budget' };
	}
	budget.metadataOps += 1;

	try {
		return { ok: true, value: await operation() };
	} catch (error) {
		return { ok: false, reason: 'filesystem', error };
	}
}

function classifyStats(stats: AgentActivityFileSystemStats): FileSystemKind {
	try {
		if (stats.isSymbolicLink()) {
			return 'symlink';
		}
		const directory = stats.isDirectory();
		const file = stats.isFile();
		if (directory === file) {
			return 'special';
		}
		return directory ? 'folder' : 'file';
	} catch {
		return 'special';
	}
}

function classifyDirent(
	entry: AgentActivityFileSystemDirent,
): FileSystemKind {
	try {
		if (entry.isSymbolicLink()) {
			return 'symlink';
		}
		const directory = entry.isDirectory();
		const file = entry.isFile();
		if (directory === file) {
			return 'special';
		}
		return directory ? 'folder' : 'file';
	} catch {
		return 'special';
	}
}

function isRealpathContained(rootPath: string, candidatePath: string): boolean {
	const relative = nodePath.relative(rootPath, candidatePath);
	return relative.length === 0
		|| (
			!nodePath.isAbsolute(relative)
			&& relative !== '..'
			&& !relative.startsWith(`..${nodePath.sep}`)
		);
}

function isMissingFileSystemError(error: unknown): boolean {
	return typeof error === 'object'
		&& error !== null
		&& 'code' in error
		&& error.code === 'ENOENT';
}
