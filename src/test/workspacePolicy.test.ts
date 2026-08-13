import * as assert from 'assert';
import { isAbsolute, parse, sep } from 'node:path';
import type { WorkspaceContextSnapshot } from '../agent/host/workspace/workspaceContext';
import { validateWorkspacePolicy } from '../agent/host/workspace/workspacePolicy';

const hostRoot = parse(process.cwd()).root;
const absoluteWorkspacePath = `${hostRoot}workspace${sep}..${sep}validated-root`;

function snapshot(
	isTrusted: boolean,
	workspaceFolders: WorkspaceContextSnapshot['workspaceFolders'],
): WorkspaceContextSnapshot {
	return { isTrusted, workspaceFolders };
}

suite('Workspace policy validator', () => {
	test('trusted 단일 file workspace의 absolute fsPath를 그대로 반환한다', () => {
		assert.strictEqual(isAbsolute(absoluteWorkspacePath), true);

		const result = validateWorkspacePolicy(snapshot(true, [{
			scheme: 'file',
			fsPath: absoluteWorkspacePath,
		}]));

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.root.scheme, 'file');
			assert.strictEqual(result.root.fsPath, absoluteWorkspacePath);
		}
	});

	test('untrusted workspace를 거부한다', () => {
		const result = validateWorkspacePolicy(snapshot(false, [{
			scheme: 'file',
			fsPath: absoluteWorkspacePath,
		}]));

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_untrusted',
		});
	});

	test('workspace folder가 없으면 거부한다', () => {
		const result = validateWorkspacePolicy(snapshot(true, []));

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_not_found',
		});
	});

	test('multi-root workspace를 거부한다', () => {
		const folder = { scheme: 'file', fsPath: absoluteWorkspacePath };
		const result = validateWorkspacePolicy(snapshot(true, [folder, folder]));

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_multi_root_unsupported',
		});
	});

	test('virtual workspace를 거부한다', () => {
		const result = validateWorkspacePolicy(snapshot(true, [{
			scheme: 'vscode-remote',
			fsPath: absoluteWorkspacePath,
		}]));

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_virtual_unsupported',
		});
	});

	test('빈 fsPath를 거부한다', () => {
		const result = validateWorkspacePolicy(snapshot(true, [{
			scheme: 'file',
			fsPath: '',
		}]));

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_path_invalid',
		});
	});

	test('현재 Host에서 상대 경로인 fsPath를 거부한다', () => {
		const relativePath = `relative${sep}workspace`;
		assert.strictEqual(isAbsolute(relativePath), false);

		const result = validateWorkspacePolicy(snapshot(true, [{
			scheme: 'file',
			fsPath: relativePath,
		}]));

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_path_invalid',
		});
	});

	test('null byte가 있는 fsPath를 거부한다', () => {
		const result = validateWorkspacePolicy(snapshot(true, [{
			scheme: 'file',
			fsPath: `${absoluteWorkspacePath}\0private`,
		}]));

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_path_invalid',
		});
	});

	test('여러 실패 조건이 겹쳐도 고정된 검증 우선순위를 유지한다', () => {
		const invalidFolders = [
			{ scheme: 'vscode-remote', fsPath: '' },
			{ scheme: 'file', fsPath: 'relative' },
		];

		assert.deepStrictEqual(
			validateWorkspacePolicy(snapshot(false, invalidFolders)),
			{ ok: false, code: 'workspace_untrusted' },
		);
		assert.deepStrictEqual(
			validateWorkspacePolicy(snapshot(true, invalidFolders)),
			{ ok: false, code: 'workspace_multi_root_unsupported' },
		);
		assert.deepStrictEqual(
			validateWorkspacePolicy(snapshot(true, [invalidFolders[0]])),
			{ ok: false, code: 'workspace_virtual_unsupported' },
		);
	});

	test('입력 snapshot을 변경하지 않는다', () => {
		const input = snapshot(true, [{
			scheme: 'file',
			fsPath: absoluteWorkspacePath,
		}]);
		const before = structuredClone(input);

		validateWorkspacePolicy(input);

		assert.deepStrictEqual(input, before);
	});

	test('실패 결과 직렬화에 실제 path나 URI를 포함하지 않는다', () => {
		const privatePath = `${absoluteWorkspacePath}${sep}private-do-not-leak`;
		const privateUri = 'vscode-remote://private-authority/private-do-not-leak';
		const result = validateWorkspacePolicy(snapshot(true, [{
			scheme: 'vscode-remote',
			fsPath: `${privatePath}:${privateUri}`,
		}]));
		const serialized = JSON.stringify(result);

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_virtual_unsupported',
		});
		assert.strictEqual(serialized.includes(privatePath), false);
		assert.strictEqual(serialized.includes(privateUri), false);
	});
});
