import * as vscode from 'vscode';
import type { ProjectNode } from '../model/projectNode';

export const excludedDirectoryNames: ReadonlySet<string> = new Set([
	'.git',
	'node_modules',
	'.next',
	'dist',
	'out',
	'build',
	'coverage',
	'.pnpm-store',
	'.vscode-test',
	'__MACOSX',
]);

export const excludedFileNames: ReadonlySet<string> = new Set([
	'.DS_Store',
]);

export type WorkspaceScanResult = {
	workspaceName: string;
	nodes: ProjectNode[];
	skippedEntries: number;
};

type ScannableEntry = {
	name: string;
	type: vscode.FileType.Directory | vscode.FileType.File;
	originalIndex: number;
};

export async function scanWorkspaceFolder(
	workspaceFolder: vscode.WorkspaceFolder,
): Promise<WorkspaceScanResult> {
	const projectNode: ProjectNode = {
		id: `project:${workspaceFolder.name}`,
		type: 'project',
		name: workspaceFolder.name,
		relativePath: '',
		childrenIds: [],
	};
	const nodes = [projectNode];
	let skippedEntries = 0;

	const scanDirectory = async (
		directoryUri: vscode.Uri,
		parentNode: ProjectNode,
		parentRelativePath: string,
	): Promise<void> => {
		const entries = await vscode.workspace.fs.readDirectory(directoryUri);
		const scannableEntries: ScannableEntry[] = [];

		for (const [originalIndex, [name, fileType]] of entries.entries()) {
			const isSymbolicLink =
				(fileType & vscode.FileType.SymbolicLink) !== 0;
			const isDirectory = (fileType & vscode.FileType.Directory) !== 0;
			const isFile = (fileType & vscode.FileType.File) !== 0;

			if (
				isSymbolicLink
				|| (isDirectory && excludedDirectoryNames.has(name))
				|| (isFile && excludedFileNames.has(name))
			) {
				skippedEntries += 1;
				continue;
			}

			if (isDirectory) {
				scannableEntries.push({
					name,
					type: vscode.FileType.Directory,
					originalIndex,
				});
				continue;
			}

			if (isFile) {
				scannableEntries.push({
					name,
					type: vscode.FileType.File,
					originalIndex,
				});
				continue;
			}

			skippedEntries += 1;
		}

		scannableEntries.sort(compareEntries);

		for (const entry of scannableEntries) {
			const relativePath = joinRelativePath(parentRelativePath, entry.name);
			const childUri = vscode.Uri.joinPath(directoryUri, entry.name);

			if (entry.type === vscode.FileType.Directory) {
				const directoryNode: ProjectNode = {
					id: `directory:${relativePath}`,
					type: 'directory',
					name: entry.name,
					relativePath,
					parentId: parentNode.id,
					childrenIds: [],
				};
				parentNode.childrenIds.push(directoryNode.id);
				nodes.push(directoryNode);
				await scanDirectory(childUri, directoryNode, relativePath);
				continue;
			}

			const fileNode: ProjectNode = {
				id: `file:${relativePath}`,
				type: 'file',
				name: entry.name,
				relativePath,
				parentId: parentNode.id,
				childrenIds: [],
			};
			parentNode.childrenIds.push(fileNode.id);
			nodes.push(fileNode);
		}
	};

	await scanDirectory(workspaceFolder.uri, projectNode, '');

	return {
		workspaceName: workspaceFolder.name,
		nodes,
		skippedEntries,
	};
}

function joinRelativePath(parentPath: string, name: string): string {
	return parentPath ? `${parentPath}/${name}` : name;
}

function compareEntries(left: ScannableEntry, right: ScannableEntry): number {
	const leftRank = left.type === vscode.FileType.Directory ? 0 : 1;
	const rightRank = right.type === vscode.FileType.Directory ? 0 : 1;

	if (leftRank !== rightRank) {
		return leftRank - rightRank;
	}

	const nameComparison = left.name
		.toLocaleLowerCase()
		.localeCompare(right.name.toLocaleLowerCase());

	return nameComparison || left.originalIndex - right.originalIndex;
}
