import * as vscode from 'vscode';

/** Workspace 변경 감지에 필요한 VS Code FileSystemWatcher의 최소 경계다. */
interface WorkspaceFileSystemWatcher {
	readonly onDidCreate: vscode.Event<vscode.Uri>;
	readonly onDidDelete: vscode.Event<vscode.Uri>;
	dispose(): void;
}

/** Workspace 변경 감지에 필요한 VS Code Workspace API의 최소 경계다. */
interface WorkspaceWatchSource {
	createFileSystemWatcher(
		globPattern: vscode.GlobPattern,
		ignoreCreateEvents?: boolean,
		ignoreChangeEvents?: boolean,
		ignoreDeleteEvents?: boolean,
	): WorkspaceFileSystemWatcher;
	getWorkspaceFolder(uri: vscode.Uri): vscode.WorkspaceFolder | undefined;
	readonly onDidChangeWorkspaceFolders: vscode.Event<
		vscode.WorkspaceFoldersChangeEvent
	>;
	readonly onDidGrantWorkspaceTrust?: vscode.Event<void>;
}

const CRISPY_DIRECTORY_NAME = '.crispy';
const WORKSPACE_ENTRY_GLOB = '**/*';

/**
 * Workspace Root 아래 Folder/File 생성·삭제와 Workspace Root 목록 변경을 감지한다.
 * 일반 File 내용 변경과 모든 `.crispy` Directory subtree 변경은 알리지 않는다.
 *
 * @param onChange 감지 대상 Workspace 구조 변경이 발생했을 때 호출할 callback
 * @param workspaceSource 감지에 사용할 VS Code Workspace API 경계
 * @param onWorkspaceFoldersChange Root 변경을 일반 File event와 구분해 먼저 알릴 callback
 * @returns 모든 event listener와 FileSystemWatcher를 함께 해제하는 Disposable
 */
export function watchWorkspaceChanges(
	onChange: () => void,
	workspaceSource: WorkspaceWatchSource = vscode.workspace,
	onWorkspaceFoldersChange: (
		event: vscode.WorkspaceFoldersChangeEvent,
	) => void = () => undefined,
): vscode.Disposable {
	const watcher = workspaceSource.createFileSystemWatcher(
		WORKSPACE_ENTRY_GLOB,
		false,
		true,
		false,
	);
	let disposed = false;

	const notifyFileSystemChange = (uri: vscode.Uri): void => {
		if (!disposed && !isCrispyWorkspaceUri(uri, workspaceSource)) {
			onChange();
		}
	};
	const subscriptions: vscode.Disposable[] = [
		watcher.onDidCreate(notifyFileSystemChange),
		watcher.onDidDelete(notifyFileSystemChange),
		workspaceSource.onDidChangeWorkspaceFolders((event) => {
			if (!disposed) {
				try {
					onWorkspaceFoldersChange(event);
				} catch {
					/** Ownership 정리가 끝나지 않은 snapshot은 Graph에 publish하지 않는다. */
					return;
				}
				onChange();
			}
		}),
	];
	if (workspaceSource.onDidGrantWorkspaceTrust !== undefined) {
		subscriptions.push(workspaceSource.onDidGrantWorkspaceTrust(() => {
			if (!disposed) {
				onChange();
			}
		}));
	}

	return {
		dispose(): void {
			if (disposed) {
				return;
			}
			disposed = true;

			for (const subscription of subscriptions) {
				try {
					subscription.dispose();
				} catch {
					/** 한 listener 해제 실패가 나머지 watcher 정리를 막지 않게 한다. */
				}
			}

			try {
				watcher.dispose();
			} catch {
				/** Watcher 정리 실패를 dispose 호출자에게 전파하지 않는다. */
			}
		},
	};
}

/** URI를 소유하는 Root 기준 상대 경로에 `.crispy` segment가 있는지 확인한다. */
function isCrispyWorkspaceUri(
	uri: vscode.Uri,
	workspaceSource: Pick<WorkspaceWatchSource, 'getWorkspaceFolder'>,
): boolean {
	const workspaceFolder = workspaceSource.getWorkspaceFolder(uri);

	if (!workspaceFolder) {
		return false;
	}

	const rootSegmentCount = workspaceFolder.uri.path
		.split('/')
		.filter(Boolean)
		.length;
	const relativePathSegments = uri.path
		.split('/')
		.filter(Boolean)
		.slice(rootSegmentCount);

	return relativePathSegments.includes(CRISPY_DIRECTORY_NAME);
}
