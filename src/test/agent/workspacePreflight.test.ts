import * as assert from 'assert';
import { parse, sep } from 'node:path';
import { parseHostToWebviewMessage } from '../../agent/protocol/validator';
import {
	createWorkspacePreflight,
	runWorkspacePreflight,
	type WorkspacePreflight,
} from '../../agent/host/workspace/workspacePreflight';
import type { ValidatedWorkspaceRoot } from '../../agent/host/workspace/types';
import type { WorkspaceRootId } from '../../workspace/workspaceRootId';

/** 두 타입이 서로 정확히 같은지 판별하는 테스트 전용 타입이다. */
type Equal<Left, Right> =
	(<Value>() => Value extends Left ? 1 : 2) extends
	(<Value>() => Value extends Right ? 1 : 2)
		? true
		: false;

/** 전달된 타입 조건이 참인 경우에만 컴파일되는 테스트 전용 단언이다. */
type Assert<Condition extends true> = Condition;

/** preflight가 root, cwd 또는 Webview message를 입력받지 않는지 검증한다. */
type PreflightHasOnlyValidatedIds = Assert<Equal<
	Parameters<WorkspacePreflight>,
	[
		tabId: string,
		sessionId: string | null,
		workspaceRootId: WorkspaceRootId,
	]
>>;

/** production preflight도 동일한 입력 계약을 사용하는지 검증한다. */
type CanonicalPreflightMatchesContract = Assert<Equal<
	typeof runWorkspacePreflight,
	WorkspacePreflight
>>;

const hostRoot = parse(process.cwd()).root;
const workspacePath = `${hostRoot}workspace${sep}preflight`;
const workspaceRootId = 'workspace-root:file:///workspace/preflight';
const root = {
	scheme: 'file',
	fsPath: workspacePath,
} as ValidatedWorkspaceRoot;

suite('Workspace preflight contract', () => {
	test('성공 root를 Host 전용 결과로 반환한다', () => {
		const preflight = createWorkspacePreflight(() => ({ ok: true, root }));

		const result = preflight('tab-start', null, workspaceRootId);

		assert.deepStrictEqual(result, { ok: true, root });
		assert.strictEqual(parseHostToWebviewMessage(result).ok, false);
	});

	test('실패를 기존 protocol을 통과하는 안전한 terminal.error로 변환한다', () => {
		const preflight = createWorkspacePreflight(() => ({
			ok: false,
			code: 'workspace_untrusted',
		}));

		const result = preflight('tab-start', null, workspaceRootId);

		assert.strictEqual(result.ok, false);
		if (!result.ok) {
			assert.deepStrictEqual(result.error, {
				type: 'terminal.error',
				tabId: 'tab-start',
				sessionId: null,
				code: 'workspace_untrusted',
				message: '작업공간을 신뢰한 후 다시 시도하세요.',
				canRestart: true,
			});
			assert.strictEqual(parseHostToWebviewMessage(result.error).ok, true);
		}
	});

	test('start와 restart 호출마다 같은 resolver를 다시 실행한다', () => {
		let resolverCalls = 0;
		const preflight = createWorkspacePreflight(() => {
			resolverCalls += 1;
			return resolverCalls === 1
				? { ok: true, root }
				: { ok: false, code: 'workspace_root_unavailable' };
		});

		const startResult = preflight('tab-one', null, workspaceRootId);
		const restartResult = preflight(
			'tab-two',
			'session-two',
			workspaceRootId,
		);

		assert.strictEqual(startResult.ok, true);
		assert.strictEqual(restartResult.ok, false);
		assert.strictEqual(resolverCalls, 2);
		if (!restartResult.ok) {
			assert.strictEqual(
				restartResult.error.code,
				'workspace_root_unavailable',
			);
			assert.strictEqual(restartResult.error.sessionId, 'session-two');
			assert.strictEqual(
				JSON.stringify(restartResult).includes(workspacePath),
				false,
			);
		}
	});
});
