import { workspace } from 'vscode';
import type { Uri } from 'vscode';
import {
	createWorkspaceRootId,
	type WorkspaceRootId,
} from '../../../workspace/workspaceRootId';

/**
 * 작업공간 폴더 URI에서 정책 판단에 필요한 최소 속성만 읽는 계약이다.
 * VS Code의 URI 객체 전체가 정책 계층으로 전달되는 것을 막는다.
 */
export interface WorkspaceFolderUriReader {
	/** URI가 사용하는 스킴이다. 예: `file`, `vscode-remote`. */
	readonly scheme: string;

	/** VS Code가 URI에서 제공하는 파일 시스템 경로 문자열이다. */
	readonly fsPath: string;

	/** 공용 WorkspaceRootId를 생성할 canonical URI 문자열을 반환한다. */
	toString(): string;
}

/**
 * VS Code 작업공간 폴더에서 URI만 읽는 최소 계약이다.
 * 작업공간 이름이나 인덱스 등 정책 판단에 불필요한 정보는 포함하지 않는다.
 */
export interface WorkspaceFolderReader {
	/** 작업공간 폴더의 URI 최소 판독 인터페이스다. */
	readonly uri: WorkspaceFolderUriReader;
}

/**
 * 실제 VS Code API와 테스트 대역이 공통으로 구현할 작업공간 상태 판독 계약이다.
 * 테스트에서는 VS Code 전역 상태를 변경하지 않고 이 계약의 가짜 구현을 주입한다.
 */
export interface WorkspaceContextReader {
	/** 현재 작업공간을 사용자가 신뢰했는지 나타내는 VS Code 상태다. */
	readonly isTrusted: boolean;

	/** 현재 열린 작업공간 폴더 목록이며 폴더가 없으면 `undefined`다. */
	readonly workspaceFolders: readonly WorkspaceFolderReader[] | undefined;
}

/**
 * 정책 계층에 전달할 작업공간 폴더의 호출 시점 snapshot이다.
 * 정책 값은 문자열로 복사하고 exact lookup 성공 결과용 folder identity만 보존한다.
 */
export interface WorkspaceFolderContextSnapshot {
	/** Graph, Catalog와 execution exact lookup이 공유하는 URI 기반 식별자다. */
	readonly id: WorkspaceRootId;

	/** exact lookup에 성공했을 때 반환할 이번 호출의 fresh folder 객체다. */
	readonly workspaceFolder: WorkspaceFolderReader;

	/** 수집 시점에 문자열로 복사한 URI 스킴이다. */
	readonly scheme: string;

	/** 수집 시점에 문자열로 복사한 파일 시스템 경로다. */
	readonly fsPath: string;
}

/**
 * 특정 시점의 VS Code 작업공간 상태를 담는 Host 전용 불변 스냅샷이다.
 * 이후의 순수 정책 validator는 복사한 정책 값과 fresh folder identity만 사용한다.
 */
export interface WorkspaceContextSnapshot {
	/** 스냅샷 생성 시점의 작업공간 신뢰 상태다. */
	readonly isTrusted: boolean;

	/** 원래 순서를 유지해 복사하고 동결한 작업공간 폴더 목록이다. */
	readonly workspaceFolders: readonly WorkspaceFolderContextSnapshot[];
}

/** 작업공간 읽기 실패 시 경로나 URI를 노출하지 않는 고정 오류 메시지다. */
const WORKSPACE_CONTEXT_READ_ERROR_MESSAGE = 'Workspace context is unavailable.';

/**
 * 주입된 reader에서 정책 판단에 필요한 값만 복사해 불변 snapshot을 만든다.
 * trusted 여부나 root 지원 가능성은 판정하지 않는다.
 *
 * @param reader VS Code API 또는 테스트 대역이 제공하는 최소 작업공간 상태 판독기다.
 * @returns 원본 배열에서 분리되고 정책 값이 복사된 작업공간 상태 스냅샷이다.
 * @throws 상태를 읽는 중 실패하면 경로나 URI를 포함하지 않는 고정 오류를 던진다.
 */
export function collectWorkspaceContext(
	reader: WorkspaceContextReader,
): WorkspaceContextSnapshot {
	try {
		const workspaceFolders = reader.workspaceFolders ?? [];
		const folderSnapshots = workspaceFolders.map((workspaceFolder) => {
			const { uri } = workspaceFolder;
			return Object.freeze({
				id: createWorkspaceRootId(uri as Uri),
				workspaceFolder,
				scheme: uri.scheme,
				fsPath: uri.fsPath,
			});
		});

		return Object.freeze({
			isTrusted: reader.isTrusted,
			workspaceFolders: Object.freeze(folderSnapshots),
		});
	} catch {
		throw new Error(WORKSPACE_CONTEXT_READ_ERROR_MESSAGE);
	}
}

/**
 * Extension Host의 VS Code API에서 현재 작업공간 상태를 읽는다.
 * Webview 메시지, 경로 또는 cwd 입력을 받지 않는다.
 *
 * @returns 현재 VS Code 작업공간 상태를 최소 필드로 복사한 불변 스냅샷이다.
 * @throws 상태 수집에 실패하면 실제 작업공간 정보를 포함하지 않는 고정 오류를 던진다.
 */
export function readVsCodeWorkspaceContext(): WorkspaceContextSnapshot {
	return collectWorkspaceContext(workspace);
}
