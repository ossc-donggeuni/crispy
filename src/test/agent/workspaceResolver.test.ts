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
import type { WorkspaceRootId } from '../../workspace/workspaceRootId';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

/** 전달된 타입 조건이 참인 경우에만 컴파일되는 테스트 전용 단언이다. */
type Assert<Condition extends true> = Condition;

/** canonical resolver가 Host가 검증한 WorkspaceRootId 하나만 입력받는지 검증한다. */
type CanonicalResolverAcceptsWorkspaceRootId = Assert<Equal<
	Parameters<typeof resolveCurrentWorkspace>,
	[workspaceRootId: WorkspaceRootId]
>>;

/** 주입된 resolver도 raw path 대신 WorkspaceRootId만 입력받는지 검증한다. */
type InjectedResolverAcceptsWorkspaceRootId = Assert<Equal<
	Parameters<WorkspaceResolver>,
	[workspaceRootId: WorkspaceRootId]
>>;

/** resolver dependency가 context reader와 validator로만 제한되는지 검증한다. */
type ResolverDependenciesHaveNoOverride = Assert<Equal<
	keyof WorkspaceResolverDependencies,
	'readContext' | 'validatePolicy'
>>;

const hostRoot = parse(process.cwd()).root;
const privateWorkspacePath = `${hostRoot}private${sep}workspace-do-not-leak`;
const ROOT_ID = 'workspace-root:file:///private/workspace-do-not-leak';
const SECOND_ROOT_ID = 'workspace-root:file:///private/second';

function folder(
	id: WorkspaceRootId,
	fsPath: string,
): WorkspaceContextSnapshot['workspaceFolders'][number] {
	const workspaceFolder = {
		uri: {
			scheme: 'file',
			fsPath,
			toString: () => id.slice('workspace-root:'.length),
		},
	};
	return { id, workspaceFolder, scheme: 'file', fsPath };
}

function context(
	isTrusted: boolean,
	workspaceFolders: WorkspaceContextSnapshot['workspaceFolders'],
): WorkspaceContextSnapshot {
	return { isTrusted, workspaceFolders };
}

function trustedContext(): WorkspaceContextSnapshot {
	return context(true, [folder(ROOT_ID, privateWorkspacePath)]);
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
		let validatedRootId: WorkspaceRootId | undefined;
		const resolver = createWorkspaceResolver({
			readContext: () => {
				readerCalls += 1;
				return input;
			},
			validatePolicy: (snapshot, workspaceRootId) => {
				validatedSnapshot = snapshot;
				validatedRootId = workspaceRootId;
				return expected;
			},
		});

		const result = resolver(ROOT_ID);

		assert.strictEqual(readerCalls, 1);
		assert.strictEqual(validatedSnapshot, input);
		assert.strictEqual(validatedRootId, ROOT_ID);
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

		resolver(ROOT_ID);
		resolver(ROOT_ID);

		assert.strictEqual(readerCalls, 2);
	});

	test('첫 성공 후 untrusted가 되면 다음 호출이 실패한다', () => {
		let currentContext = trustedContext();
		const resolver = createWorkspaceResolver({
			readContext: () => currentContext,
			validatePolicy: validateWorkspacePolicy,
		});

		const startResult = resolver(ROOT_ID);
		currentContext = context(false, currentContext.workspaceFolders);
		const restartResult = resolver(ROOT_ID);

		assert.strictEqual(startResult.ok, true);
		assert.deepStrictEqual(restartResult, {
			ok: false,
			code: 'workspace_untrusted',
		});
	});

	test('multi-root가 되어도 같은 ID를 exact lookup하고 root 제거 후 실패한다', () => {
		let currentContext = trustedContext();
		const resolver = createWorkspaceResolver({
			readContext: () => currentContext,
			validatePolicy: validateWorkspacePolicy,
		});

		const startResult = resolver(ROOT_ID);
		currentContext = context(true, [
			...currentContext.workspaceFolders,
			folder(SECOND_ROOT_ID, `${privateWorkspacePath}-second`),
		]);
		const multiRootResult = resolver(ROOT_ID);
		currentContext = context(true, [
			folder(SECOND_ROOT_ID, `${privateWorkspacePath}-second`),
		]);
		const restartResult = resolver(ROOT_ID);

		assert.strictEqual(startResult.ok, true);
		assert.strictEqual(multiRootResult.ok, true);
		assert.deepStrictEqual(restartResult, {
			ok: false,
			code: 'workspace_root_unavailable',
		});
	});

	test('이전 성공 root가 이후 실패 결과에 남지 않는다', () => {
		let currentContext = trustedContext();
		const resolver = createWorkspaceResolver({
			readContext: () => currentContext,
			validatePolicy: validateWorkspacePolicy,
		});

		const success = resolver(ROOT_ID);
		currentContext = context(false, []);
		const failure = resolver(ROOT_ID);
		const serializedFailure = JSON.stringify(failure);

		assert.strictEqual(success.ok, true);
		assert.deepStrictEqual(failure, {
			ok: false,
			code: 'workspace_untrusted',
		});
		assert.strictEqual(serializedFailure.includes(privateWorkspacePath), false);
		assert.strictEqual(serializedFailure.includes('root'), false);
	});

	test('서로 다른 terminal 호출도 같은 ID 기반 resolver를 fresh하게 사용한다', () => {
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

		const startResult = resolveForStart(ROOT_ID);
		const restartResult = resolveForRestart(ROOT_ID);

		assert.strictEqual(startResult.ok, true);
		assert.strictEqual(restartResult.ok, true);
		assert.strictEqual(readerCalls, 2);
	});

	test('context와 validator 결과를 변경하지 않는다', () => {
		const frozenFolder = Object.freeze(folder(ROOT_ID, privateWorkspacePath));
		const input = Object.freeze({
			isTrusted: true,
			workspaceFolders: Object.freeze([frozenFolder]),
		}) satisfies WorkspaceContextSnapshot;
		const expected = Object.freeze({
			ok: false,
			code: 'workspace_path_invalid',
		}) satisfies WorkspaceValidationResult;
		const resultBefore = structuredClone(expected);
		const resolver = createWorkspaceResolver({
			readContext: () => input,
			validatePolicy: (snapshot, workspaceRootId) => {
				assert.strictEqual(snapshot, input);
				assert.strictEqual(workspaceRootId, ROOT_ID);
				return expected;
			},
		});

		const result = resolver(ROOT_ID);

		assert.strictEqual(result, expected);
		assert.strictEqual(input.workspaceFolders[0], frozenFolder);
		assert.deepStrictEqual(expected, resultBefore);
	});
});
