import * as vscode from 'vscode';
import {
	parseWorkspaceFilterJson,
	type WorkspaceFilter,
} from './workspaceFilter';

type DefaultWorkspaceFilterFileSystem = Pick<
	typeof vscode.workspace.fs,
	'readFile'
>;

const DEFAULT_WORKSPACE_FILTER_PATH = [
	'resources',
	'defaultWorkspaceFilter.json',
] as const;
const textDecoder = new TextDecoder();

/**
 * Extension에 포함된 기본 Workspace Filter JSON을 읽고 현재 규약으로 검증한다.
 * 자산 읽기 또는 JSON 검증이 실패하면 예외 대신 undefined를 반환한다.
 */
export async function readDefaultWorkspaceFilter(
	extensionUri: vscode.Uri,
	fileSystem: DefaultWorkspaceFilterFileSystem = vscode.workspace.fs,
): Promise<WorkspaceFilter | undefined> {
	try {
		const content = await fileSystem.readFile(vscode.Uri.joinPath(
			extensionUri,
			...DEFAULT_WORKSPACE_FILTER_PATH,
		));

		return parseWorkspaceFilterJson(textDecoder.decode(content));
	} catch {
		return undefined;
	}
}
