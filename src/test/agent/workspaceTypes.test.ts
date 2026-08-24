import * as assert from 'assert';
import type {
	ValidatedWorkspaceFsPath,
	ValidatedWorkspaceRoot,
	WorkspaceValidationErrorCode,
	WorkspaceValidationFailure,
	WorkspaceValidationResult,
} from '../../agent/host/workspace/types';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

/** 전달된 타입 조건이 참인 경우에만 컴파일되는 테스트 전용 단언이다. */
type Assert<Condition extends true> = Condition;

/** 작업공간 검증에서 허용해야 하는 오류 코드의 전체 목록이다. */
type ExpectedWorkspaceErrorCode =
	| 'workspace_root_unavailable'
	| 'workspace_untrusted'
	| 'workspace_virtual_unsupported'
	| 'workspace_path_invalid';

/** 작업공간 오류 코드가 기존 프로토콜의 정의와 정확히 일치하는지 검증한다. */
type WorkspaceErrorCodesMatchProtocol = Assert<Equal<
	WorkspaceValidationErrorCode,
	ExpectedWorkspaceErrorCode
>>;

/** 실패 결과가 경로나 작업공간 루트를 노출하지 않는지 검증한다. */
type FailureDoesNotExposeRoot = Assert<Equal<
	keyof WorkspaceValidationFailure,
	'ok' | 'code'
>>;

/** 성공 결과에서만 터미널 작업 디렉터리로 사용할 검증된 경로를 반환한다. */
function terminalCwd(
	result: WorkspaceValidationResult,
): ValidatedWorkspaceFsPath | undefined {
	if (!result.ok) {
		return undefined;
	}

	return result.root.fsPath;
}

suite('Workspace Host type contract', () => {
	test('성공 결과에서만 terminal cwd용 fsPath를 얻는다', () => {
		const failure = {
			ok: false,
			code: 'workspace_root_unavailable',
		} satisfies WorkspaceValidationResult;
		const fsPath = '/validated/workspace' as ValidatedWorkspaceFsPath;
		const root = {
			scheme: 'file',
			fsPath,
		} as ValidatedWorkspaceRoot;
		const success = {
			ok: true,
			root,
		} satisfies WorkspaceValidationResult;

		assert.strictEqual(terminalCwd(failure), undefined);
		assert.strictEqual(terminalCwd(success), fsPath);
	});
});
