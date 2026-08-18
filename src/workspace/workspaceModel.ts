import type { Uri } from 'vscode';

/** Workspace 탐색 항목이 공통으로 유지하는 식별 정보다. */
interface WorkspaceItemBase {
	readonly id: string;
	readonly name: string;
	readonly uri: Uri;
}

/** 현재 열린 모든 Workspace Root의 탐색 결과다. */
export interface WorkspaceSnapshot {
	readonly roots: readonly WorkspaceRoot[];
}

/** 하나의 VS Code Workspace Root와 이후 탐색될 직계 항목이다. */
export interface WorkspaceRoot extends WorkspaceItemBase {
	readonly children: readonly WorkspaceEntry[];
}

/** 하위 Folder 또는 File을 포함할 수 있는 Workspace Folder다. */
export interface Folder extends WorkspaceItemBase {
	readonly kind: 'folder';
	readonly children: readonly WorkspaceEntry[];
}

/** Workspace Tree의 개별 File이다. */
export interface File extends WorkspaceItemBase {
	readonly kind: 'file';
}

/** Folder의 discriminant로 구분되는 Workspace Tree 항목이다. */
export type WorkspaceEntry = Folder | File;
