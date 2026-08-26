import * as path from 'node:path';
import * as vscode from 'vscode';
import type {
	ExtensionToWebviewMessage,
	WorkspaceGitStatusUpdatedMessage,
} from '../messages';
import {
	createWorkspaceGitProjection,
	type WorkspaceGitFileState,
	type WorkspaceGitRepositoryState,
} from './workspaceGitStatus';
import type { WorkspaceRootFilter } from './workspaceFilterPersistence';
import { createWorkspaceRootId } from './workspaceRootId';

interface BuiltInGitRepository {
	readonly rootUri: vscode.Uri;
	readonly state: WorkspaceGitRepositoryState & {
		readonly onDidChange: vscode.Event<void>;
	};
	status(): Promise<void>;
	show(ref: string, filePath: string): Promise<string>;
}

interface BuiltInGitApi {
	readonly repositories: readonly BuiltInGitRepository[];
	readonly onDidOpenRepository: vscode.Event<BuiltInGitRepository>;
	readonly onDidCloseRepository: vscode.Event<BuiltInGitRepository>;
	getRepository(uri: vscode.Uri): BuiltInGitRepository | null;
}

interface BuiltInGitExtension {
	readonly enabled: boolean;
	readonly onDidChangeEnablement: vscode.Event<boolean>;
	getAPI(version: 1): BuiltInGitApi;
}

interface WorkspaceGitServiceWorkspace {
	readonly workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
	readonly onDidChangeWorkspaceFolders: vscode.Event<vscode.WorkspaceFoldersChangeEvent>;
	readonly onDidSaveTextDocument: vscode.Event<vscode.TextDocument>;
	readonly fs: Pick<typeof vscode.workspace.fs, 'stat'>;
	getWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined;
}

export interface WorkspaceGitStatusService extends vscode.Disposable {
	/** Webview ready 이후에만 snapshot을 발행한다. */
	markWebviewReady(): void;
	/** 현재 Git API state로 전체 snapshot을 다시 만든다. */
	requestRefresh(): Promise<void>;
	/** 상세 조회 도중 Git state가 바뀌었는지 검사할 단조 증가 revision이다. */
	getGitRevision(): number;
	/** 변경 file의 HEAD 원본이다. added/untracked는 빈 원본을 반환한다. */
	readOriginalText(nodeId: string, maxBytes: number): Promise<string | undefined>;
}

export interface WorkspaceGitStatusServiceDependencies {
	readonly workspace: WorkspaceGitServiceWorkspace;
	getGitExtension(): vscode.Extension<BuiltInGitExtension> | undefined;
	loadRootFilters(): Promise<readonly WorkspaceRootFilter[]>;
	getWorkspaceContextGeneration(): number;
	postMessage(message: ExtensionToWebviewMessage): PromiseLike<boolean>;
}

/**
 * VS Code built-in Git extension의 public API를 Graph runtime snapshot으로 연결한다.
 * Git extension 부재/비활성화/`.git` directory 부재는 오류 대신 빈 snapshot이다.
 */
export function createWorkspaceGitStatusService(
	dependencies: WorkspaceGitStatusServiceDependencies,
): WorkspaceGitStatusService {
	let disposed = false;
	let webviewReady = false;
	let gitRevision = 0;
	let api: BuiltInGitApi | undefined;
	let filters: readonly WorkspaceRootFilter[] = [];
	let fileStates: ReadonlyMap<string, WorkspaceGitFileState> = new Map();
	let refreshQueue = Promise.resolve();
	let refreshScheduled = false;
	let extensionSubscription: vscode.Disposable | undefined;
	let apiSubscriptions: vscode.Disposable[] = [];
	let repositorySubscriptions: vscode.Disposable[] = [];
	const lifecycleSubscriptions: vscode.Disposable[] = [
		dependencies.workspace.onDidChangeWorkspaceFolders(() => {
			void reloadWorkspaceContext();
		}),
		dependencies.workspace.onDidSaveTextDocument((document) => {
			void refreshSavedDocument(document.uri);
		}),
	];

	const postSnapshot = async (): Promise<void> => {
		if (disposed || !webviewReady) {
			return;
		}
		const repositories = await getEligibleRepositories();

		if (disposed || !webviewReady) {
			return;
		}
		const workspaceFolders = dependencies.workspace.workspaceFolders ?? [];
		const projection = createWorkspaceGitProjection(
			repositories,
			workspaceFolders,
			filters,
		);

		fileStates = projection.fileStates;
		gitRevision = nextRevision(gitRevision);
		const message: WorkspaceGitStatusUpdatedMessage = {
			type: 'workspace.gitStatusUpdated',
			contextGeneration: dependencies.getWorkspaceContextGeneration(),
			rootIds: workspaceFolders.map(({ uri }) => createWorkspaceRootId(uri)),
			gitRevision,
			entries: projection.entries,
		};

		try {
			await dependencies.postMessage(message);
		} catch {
			/** Webview dispose와 경합한 snapshot은 다음 Panel runtime에 남기지 않는다. */
		}
	};
	const queueRefresh = (): Promise<void> => {
		refreshQueue = refreshQueue.then(postSnapshot, postSnapshot);
		return refreshQueue;
	};
	const scheduleRefresh = (): void => {
		if (disposed || refreshScheduled) {
			return;
		}
		refreshScheduled = true;
		queueMicrotask(() => {
			refreshScheduled = false;
			if (!disposed) {
				void queueRefresh();
			}
		});
	};
	const bindRepositories = (): void => {
		disposeAll(repositorySubscriptions);
		repositorySubscriptions = api?.repositories.map((repository) => (
			repository.state.onDidChange(scheduleRefresh)
		)) ?? [];
		scheduleRefresh();
	};
	const bindApi = (nextApi: BuiltInGitApi | undefined): void => {
		disposeAll(apiSubscriptions);
		disposeAll(repositorySubscriptions);
		apiSubscriptions = [];
		repositorySubscriptions = [];
		api = nextApi;

		if (api) {
			apiSubscriptions = [
				api.onDidOpenRepository(bindRepositories),
				api.onDidCloseRepository(bindRepositories),
			];
		}
		bindRepositories();
	};
	const initialize = async (): Promise<void> => {
		let extension: vscode.Extension<BuiltInGitExtension> | undefined;

		try {
			extension = dependencies.getGitExtension();
		} catch {
			scheduleRefresh();
			return;
		}

		if (!extension) {
			scheduleRefresh();
			return;
		}
		let gitExtension: BuiltInGitExtension;

		try {
			gitExtension = extension.isActive
				? extension.exports
				: await extension.activate();
		} catch {
			scheduleRefresh();
			return;
		}
		if (disposed) {
			return;
		}
		const bindExtensionApi = (enabled: boolean): void => {
			try {
				bindApi(enabled ? gitExtension.getAPI(1) : undefined);
			} catch {
				bindApi(undefined);
			}
		};

		extensionSubscription = gitExtension.onDidChangeEnablement(bindExtensionApi);
		bindExtensionApi(gitExtension.enabled);
	};
	const reloadWorkspaceContext = async (): Promise<void> => {
		try {
			filters = await dependencies.loadRootFilters();
		} catch {
			filters = [];
		}
		if (!disposed) {
			bindRepositories();
		}
	};
	const getEligibleRepositories = async (): Promise<BuiltInGitRepository[]> => {
		const candidates = api?.repositories ?? [];
		const eligible = await Promise.all(candidates.map(async (repository) => {
			if (!dependencies.workspace.getWorkspaceFolder(repository.rootUri)) {
				return undefined;
			}
			try {
				const stat = await dependencies.workspace.fs.stat(
					vscode.Uri.joinPath(repository.rootUri, '.git'),
				);

				return stat.type & vscode.FileType.Directory ? repository : undefined;
			} catch {
				return undefined;
			}
		}));

		return eligible.filter(
			(repository): repository is BuiltInGitRepository => repository !== undefined,
		);
	};
	const refreshSavedDocument = async (uri: vscode.Uri): Promise<void> => {
		if (disposed || !api) {
			return;
		}
		const repository = api.getRepository(uri);

		if (!repository || !dependencies.workspace.getWorkspaceFolder(repository.rootUri)) {
			return;
		}
		try {
			await repository.status();
		} catch {
			/** built-in Git refresh 실패는 다음 state event까지 기존 snapshot을 유지한다. */
		}
		scheduleRefresh();
	};
	const refreshRepositories = async (): Promise<void> => {
		if (disposed) {
			return;
		}
		const repositories = api?.repositories ?? [];

		await Promise.all(repositories.map(async (repository) => {
			try {
				await repository.status();
			} catch {
				/** 한 repository 실패가 다른 repository snapshot을 막지 않는다. */
			}
		}));
		await queueRefresh();
	};

	void reloadWorkspaceContext().then(initialize);

	return {
		markWebviewReady(): void {
			if (disposed || webviewReady) {
				return;
			}
			webviewReady = true;
			scheduleRefresh();
		},
		requestRefresh: refreshRepositories,
		getGitRevision: () => gitRevision,
		async readOriginalText(
			nodeId: string,
			maxBytes: number,
		): Promise<string | undefined> {
			const fileState = fileStates.get(nodeId);

			if (!fileState || fileState.status === 'deleted') {
				return undefined;
			}
			if (fileState.status === 'added' || fileState.status === 'untracked') {
				return '';
			}
			const repository = api?.repositories.find(({ rootUri }) => (
				rootUri.toString() === fileState.repositoryRootUri.toString()
			));

			if (!repository) {
				return undefined;
			}
			const sourceUri = fileState.originalUri ?? fileState.uri;

			if (
				sourceUri.scheme !== repository.rootUri.scheme
				|| sourceUri.authority !== repository.rootUri.authority
			) {
				return undefined;
			}
			const relativePath = path.posix.relative(
				repository.rootUri.path,
				sourceUri.path,
			);

			if (
				relativePath === '..'
				|| relativePath.startsWith('../')
				|| path.posix.isAbsolute(relativePath)
			) {
				return undefined;
			}
			try {
				const text = await repository.show('HEAD', relativePath);

				return new TextEncoder().encode(text).byteLength <= maxBytes
					&& !hasBinaryControlCharacter(text)
					? text
					: undefined;
			} catch {
				return undefined;
			}
		},
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;
			fileStates = new Map();
			extensionSubscription?.dispose();
			disposeAll(apiSubscriptions);
			disposeAll(repositorySubscriptions);
			disposeAll(lifecycleSubscriptions);
		},
	};
}

/** Production에서만 VS Code global extension registry에 결합한다. */
export function getBuiltInGitExtension(): vscode.Extension<BuiltInGitExtension> | undefined {
	return vscode.extensions.getExtension<BuiltInGitExtension>('vscode.git');
}

function disposeAll(disposables: readonly vscode.Disposable[]): void {
	for (const disposable of disposables) {
		try {
			disposable.dispose();
		} catch {
			/** 한 public Git event listener 해제 실패가 나머지 정리를 막지 않는다. */
		}
	}
}

function nextRevision(revision: number): number {
	return revision < Number.MAX_SAFE_INTEGER ? revision + 1 : revision;
}

function hasBinaryControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);

		if (code === 0 || code < 8 || code === 11 || code === 12 || code > 13 && code < 32) {
			return true;
		}
	}

	return false;
}
