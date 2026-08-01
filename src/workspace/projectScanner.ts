import * as vscode from 'vscode';
import type { ProjectNode } from '../model/projectNode';

/** constant excludedDirectoryNames
 *
 * - Workspace 스캔에서 기본적으로 탐색하지 않을 디렉터리 이름을 관리한다.
 */
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

/** constant excludedFileNames
 *
 * - Workspace 스캔에서 기본적으로 포함하지 않을 파일 이름을 관리한다.
 */
export const excludedFileNames: ReadonlySet<string> = new Set([
	'.DS_Store',
]);

/** type WorkspaceScanResult
 *
 * - Workspace 이름과 생성한 ProjectNode 목록 및 제외 항목 수를 정의한다.
 */
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

/** function scanWorkspaceFolder( workspaceFolder )
 *
 * - vscode.workspace.fs를 사용해 Workspace 디렉터리와 파일을 재귀 탐색한다.
 * - 제외 대상과 Symbolic Link를 건너뛰고 ProjectNode 계층을 생성한다.
 * - 각 부모의 childrenIds를 디렉터리 우선, 이름 오름차순으로 구성한다.
 *
 * @param workspaceFolder 스캔할 단일 VS Code Workspace Folder
 * @returns 				Workspace 이름, 노드 목록, 제외 항목 수
 */
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

	/** function scanDirectory( directoryUri, parentNode, parentRelativePath )
	 *
	 * - 한 디렉터리의 직접 자식을 읽고 제외 및 파일 종류 규칙을 적용한다.
	 * - 정렬한 항목을 ProjectNode로 만들고 하위 디렉터리를 재귀 탐색한다.
	 *
	 * @param directoryUri 		현재 탐색할 디렉터리 URI
	 * @param parentNode 			생성한 자식 ID를 연결할 부모 노드
	 * @param parentRelativePath Workspace 기준 부모 상대 경로
	 * @returns 					현재 디렉터리 탐색이 완료되면 끝나는 Promise
	 */
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
				// 순환 참조 가능성이 있는 Symbolic Link와 기본 제외 항목은 탐색하지 않는다.
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

		// 정렬된 순서 그대로 부모의 childrenIds와 전체 노드 목록을 구성한다.
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

	// Project 노드를 루트 부모로 사용해 Workspace 전체 탐색을 시작한다.
	await scanDirectory(workspaceFolder.uri, projectNode, '');

	return {
		workspaceName: workspaceFolder.name,
		nodes,
		skippedEntries,
	};
}

/** function joinRelativePath( parentPath, name )
 *
 * - 운영체제와 관계없이 슬래시를 사용한 Workspace 상대 경로를 만든다.
 *
 * @param parentPath 부모의 Workspace 상대 경로
 * @param name 		결합할 자식 이름
 * @returns 			결합된 상대 경로
 */
function joinRelativePath(parentPath: string, name: string): string {
	return parentPath ? `${parentPath}/${name}` : name;
}

/** function compareEntries( left, right )
 *
 * - 디렉터리를 파일보다 먼저 정렬한다.
 * - 같은 종류는 대소문자를 무시한 이름과 원래 순서로 안정적으로 정렬한다.
 *
 * @param left 	왼쪽 비교 항목
 * @param right 오른쪽 비교 항목
 * @returns 	정렬 순서를 나타내는 숫자
 */
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
