import type {
	Graph,
	GraphRoot,
	Project,
	ProjectEntry,
} from '../webview/graph/graphModel';
import type {
	WorkspaceEntry,
	WorkspaceRoot,
	WorkspaceSnapshot,
} from './workspaceModel';

/**
 * Workspace Snapshot의 각 Root Tree를 독립적인 Project Root가 있는 Graph로 변환한다.
 *
 * @param snapshot 변환할 Workspace 탐색 결과
 * @returns Workspace 항목의 ID, 이름과 순서를 유지한 새 Graph
 */
export function convertWorkspaceSnapshotToGraph(snapshot: WorkspaceSnapshot): Graph {
	const roots: GraphRoot[] = [];
	const rootNodes: Record<string, Project> = {};

	for (const workspaceRoot of snapshot.roots) {
		const project = convertWorkspaceRoot(workspaceRoot);

		roots.push({
			id: `root:${project.id}`,
			nodeId: project.id,
		});
		rootNodes[project.id] = project;
	}

	return { roots, rootNodes };
}

/** Workspace Root를 같은 ID와 이름을 가진 Graph Project로 변환한다. */
function convertWorkspaceRoot(workspaceRoot: WorkspaceRoot): Project {
	return {
		kind: 'project',
		id: workspaceRoot.id,
		name: workspaceRoot.name,
		status: workspaceRoot.status,
		children: workspaceRoot.children.map(convertWorkspaceEntry),
	};
}

/** Workspace Folder/File union을 같은 계층의 Graph 항목으로 변환한다. */
function convertWorkspaceEntry(entry: WorkspaceEntry): ProjectEntry {
	if (entry.kind === 'folder') {
		return {
			kind: 'folder',
			id: entry.id,
			name: entry.name,
			status: entry.status,
			children: entry.children.map(convertWorkspaceEntry),
		};
	}

	return {
		kind: 'file',
		id: entry.id,
		name: entry.name,
	};
}
