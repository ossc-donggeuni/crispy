import * as assert from 'assert';
import { parse, sep } from 'node:path';
import type { WorkspaceContextSnapshot } from '../../agent/host/workspace/workspaceContext';
import { validateWorkspacePolicy } from '../../agent/host/workspace/workspacePolicy';
import {
	createWorkspaceResolver,
	resolveCurrentWorkspace,
	type WorkspaceResolver,
	type WorkspaceResolverDependencies,
} from '../../agent/host/workspace/workspaceResolver';
import type { WorkspaceValidationResult } from '../../agent/host/workspace/types';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

/** 전달된 타입 조건이 참인 경우에만 컴파일되는 테스트 전용 단언이다. */
type Assert<Condition extends true> = Condition;

/** canonical resolver가 root나 Webview/session 값을 입력받지 않는지 검증한다. */
type CanonicalResolverHasNoInput = Assert<Equal<
	Parameters<typeof resolveCurrentWorkspace>,
	[]
>>;

/** 주입된 resolver도 terminal 호출별 override를 입력받지 않는지 검증한다. */
type InjectedResolverHasNoInput = Assert<Equal<
	Parameters<WorkspaceResolver>,
	[]
>>;

/** resolver dependency가 context reader와 validator로만 제한되는지 검증한다. */
type ResolverDependenciesHaveNoOverride = Assert<Equal<
	keyof WorkspaceResolverDependencies,
	'readContext' | 'validatePolicy'
>>;

const hostRoot = parse(process.cwd()).root;
const privateWorkspacePath = `${hostRoot}private${sep}workspace-do-not-leak`;

function context(
	isTrusted: boolean,
	workspaceFolders: WorkspaceContextSnapshot['workspaceFolders'],
): WorkspaceContextSnapshot {
	return { isTrusted, workspaceFolders };
}

function trustedContext(): WorkspaceContextSnapshot {
	return context(true, [{ scheme: 'file', fsPath: privateWorkspacePath }]);
}

suite('Canonical Workspace resolver', () => {
	test('reader를 호출하고 같은 snapshot의 validator 결과를 반환한다', () => {
		const input = trustedContext();
		const expected = {
			ok: false,
			code: 'workspace_path_invalid',
		} satisfies WorkspaceValidationResult;
		let readerCalls = 0;
		let validatedSnapshot: WorkspaceContextSnapshot | undefined;
		const resolver = createWorkspaceResolver({
			readContext: () => {
				readerCalls += 1;
				return input;
			},
			validatePolicy: (snapshot) => {
				validatedSnapshot = snapshot;
				return expected;
			},
		});

		const result = resolver();

		assert.strictEqual(readerCalls, 1);
		assert.strictEqual(validatedSnapshot, input);
		assert.strictEqual(result, expected);
	});

	test('두 번 해석하면 context reader도 두 번 호출한다', () => {
		let readerCalls = 0;
		const resolver = createWorkspaceResolver({
			readContext: () => {
				readerCalls += 1;
				return trustedContext();
			},
			validatePolicy: validateWorkspacePolicy,
		});

		resolver();
		resolver();

		assert.strictEqual(readerCalls, 2);
	});

	test('첫 성공 후 untrusted가 되면 다음 호출이 실패한다', () => {
		let currentContext = trustedContext();
		const resolver = createWorkspaceResolver({
			readContext: () => currentContext,
			validatePolicy: validateWorkspacePolicy,
		});

		const startResult = resolver();
		currentContext = context(false, currentContext.workspaceFolders);
		const restartResult = resolver();

		assert.strictEqual(startResult.ok, true);
		assert.deepStrictEqual(restartResult, {
			ok: false,
			code: 'workspace_untrusted',
		});
	});

	test('첫 성공 후 multi-root가 되면 다음 호출이 실패한다', () => {
		let currentContext = trustedContext();
		const resolver = createWorkspaceResolver({
			readContext: () => currentContext,
			validatePolicy: validateWorkspacePolicy,
		});

		const startResult = resolver();
		currentContext = context(true, [
			...currentContext.workspaceFolders,
			{ scheme: 'file', fsPath: `${privateWorkspacePath}-second` },
		]);
		const restartResult = resolver();

		assert.strictEqual(startResult.ok, true);
		assert.deepStrictEqual(restartResult, {
			ok: false,
			code: 'workspace_multi_root_unsupported',
		});
	});

	test('이전 성공 root가 이후 실패 결과에 남지 않는다', () => {
		let currentContext = trustedContext();
		const resolver = createWorkspaceResolver({
			readContext: () => currentContext,
			validatePolicy: validateWorkspacePolicy,
		});

		const success = resolver();
		currentContext = context(false, []);
		const failure = resolver();
		const serializedFailure = JSON.stringify(failure);

		assert.strictEqual(success.ok, true);
		assert.deepStrictEqual(failure, {
			ok: false,
			code: 'workspace_untrusted',
		});
		assert.strictEqual(serializedFailure.includes(privateWorkspacePath), false);
		assert.strictEqual(serializedFailure.includes('root'), false);
	});

	test('서로 다른 terminal 호출도 같은 인자 없는 resolver를 사용한다', () => {
		let readerCalls = 0;
		const resolver = createWorkspaceResolver({
			readContext: () => {
				readerCalls += 1;
				return trustedContext();
			},
			validatePolicy: validateWorkspacePolicy,
		});
		const resolveForStart: WorkspaceResolver = resolver;
		const resolveForRestart: WorkspaceResolver = resolver;

		const startResult = resolveForStart();
		const restartResult = resolveForRestart();

		assert.strictEqual(startResult.ok, true);
		assert.strictEqual(restartResult.ok, true);
		assert.strictEqual(readerCalls, 2);
	});

	test('context와 validator 결과를 변경하지 않는다', () => {
		const input = Object.freeze({
			isTrusted: true,
			workspaceFolders: Object.freeze([
				Object.freeze({ scheme: 'file', fsPath: privateWorkspacePath }),
			]),
		}) satisfies WorkspaceContextSnapshot;
		const expected = Object.freeze({
			ok: false,
			code: 'workspace_path_invalid',
		}) satisfies WorkspaceValidationResult;
		const inputBefore = structuredClone(input);
		const resultBefore = structuredClone(expected);
		const resolver = createWorkspaceResolver({
			readContext: () => input,
			validatePolicy: (snapshot) => {
				assert.strictEqual(snapshot, input);
				return expected;
			},
		});

		const result = resolver();

		assert.strictEqual(result, expected);
		assert.deepStrictEqual(input, inputBefore);
		assert.deepStrictEqual(expected, resultBefore);
	});
});
