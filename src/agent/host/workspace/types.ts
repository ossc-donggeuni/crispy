import type { WorkspaceExecutionErrorCode } from '../../protocol/errors';

/** 일반 문자열과 검증된 작업공간 파일 경로를 구분하는 컴파일 타임 표식이다. */
declare const validatedWorkspaceFsPathBrand: unique symbol;

/** 일반 URI 표현과 검증된 작업공간 URI를 구분하는 컴파일 타임 표식이다. */
declare const validatedWorkspaceUriBrand: unique symbol;

/** 검증된 URI와 Host가 선택한 작업공간 루트를 구분하는 컴파일 타임 표식이다. */
declare const validatedWorkspaceRootBrand: unique symbol;

/** 검증을 통과해 Host가 terminal cwd로 사용할 수 있는 절대 filesystem path다. */
export type ValidatedWorkspaceFsPath = string & {
	readonly [validatedWorkspaceFsPathBrand]: true;
};

/** trusted 단일 file workspace 검증을 통과한 Host 내부 URI 표현이다. */
export interface ValidatedWorkspaceUri {
	readonly scheme: 'file';
	readonly fsPath: ValidatedWorkspaceFsPath;
	readonly [validatedWorkspaceUriBrand]: true;
}

/** Graph와 모든 terminal session이 공유하는 Host 결정 workspace root다. */
export type ValidatedWorkspaceRoot = ValidatedWorkspaceUri & {
	readonly [validatedWorkspaceRootBrand]: true;
};

/** Workspace 정책에 해당하는 execution protocol 오류 code다. */
export type WorkspaceValidationErrorCode = WorkspaceExecutionErrorCode;

/** Workspace 검증이 성공했을 때만 검증된 root를 노출한다. */
export interface WorkspaceValidationSuccess {
	readonly ok: true;
	readonly root: ValidatedWorkspaceRoot;
}

/** Workspace 검증 실패 정보에는 workspace 식별 정보나 경로를 포함하지 않는다. */
export interface WorkspaceValidationFailure {
	readonly ok: false;
	readonly code: WorkspaceValidationErrorCode;
}

/** Host workspace 정책 검증의 discriminated union 결과다. */
export type WorkspaceValidationResult =
	| WorkspaceValidationSuccess
	| WorkspaceValidationFailure;
