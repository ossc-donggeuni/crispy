import * as assert from 'assert';
import { isAbsolute, parse, sep } from 'node:path';
import type { WorkspaceContextSnapshot } from '../../agent/host/workspace/workspaceContext';
import { validateWorkspacePolicy } from '../../agent/host/workspace/workspacePolicy';
import type { WorkspaceRootId } from '../../workspace/workspaceRootId';

const hostRoot = parse(process.cwd()).root;
const absoluteWorkspacePath = `${hostRoot}workspace${sep}..${sep}validated-root`;
const ROOT_ID = 'workspace-root:file:///workspace/validated-root';
const SECOND_ROOT_ID = 'workspace-root:file:///workspace/second';

function folder(
	scheme: string,
	fsPath: string,
	id: WorkspaceRootId = ROOT_ID,
): WorkspaceContextSnapshot['workspaceFolders'][number] {
	const uriValue = id.slice('workspace-root:'.length);
	const workspaceFolder = {
		uri: { scheme, fsPath, toString: () => uriValue },
	};
	return { id, workspaceFolder, scheme, fsPath };
}

function snapshot(
	isTrusted: boolean,
	workspaceFolders: WorkspaceContextSnapshot['workspaceFolders'],
): WorkspaceContextSnapshot {
	return { isTrusted, workspaceFolders };
}

suite('Workspace policy validator', () => {
	test('trusted 단일 file workspace의 absolute fsPath를 그대로 반환한다', () => {
		assert.strictEqual(isAbsolute(absoluteWorkspacePath), true);

		const result = validateWorkspacePolicy(
			snapshot(true, [folder('file', absoluteWorkspacePath)]),
			ROOT_ID,
		);

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.root.scheme, 'file');
			assert.strictEqual(result.root.fsPath, absoluteWorkspacePath);
			assert.strictEqual(result.root.id, ROOT_ID);
		}
	});

	test('주입한 platform 규칙으로 공용 root policy를 적용한다', () => {
		const windowsPath = 'C:\\workspace\\validated-root';

		const input = snapshot(true, [folder('file', windowsPath)]);
		const windowsResult = validateWorkspacePolicy(input, ROOT_ID, 'win32');
		const posixResult = validateWorkspacePolicy(input, ROOT_ID, 'linux');

		assert.strictEqual(windowsResult.ok, true);
		if (windowsResult.ok) {
			assert.strictEqual(windowsResult.root.fsPath, windowsPath);
		}
		assert.deepStrictEqual(posixResult, {
			ok: false,
			code: 'workspace_path_invalid',
		});
	});

	test('untrusted workspace를 거부한다', () => {
		const result = validateWorkspacePolicy(
			snapshot(false, [folder('file', absoluteWorkspacePath)]),
			ROOT_ID,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_untrusted',
		});
	});

	test('workspace folder가 없으면 거부한다', () => {
		const result = validateWorkspacePolicy(snapshot(true, []), ROOT_ID);

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_root_unavailable',
		});
	});

	test('multi-root에서 요청한 ID를 exact match한다', () => {
		const selected = folder('file', absoluteWorkspacePath);
		const result = validateWorkspacePolicy(snapshot(true, [
			folder('file', `${absoluteWorkspacePath}-other`, SECOND_ROOT_ID),
			selected,
		]), ROOT_ID);

		assert.strictEqual(result.ok, true);
		if (result.ok) {
			assert.strictEqual(result.root.id, ROOT_ID);
			assert.strictEqual(result.root.workspaceFolder, selected.workspaceFolder);
		}
	});

	test('virtual workspace를 거부한다', () => {
		const result = validateWorkspacePolicy(
			snapshot(true, [folder('vscode-remote', absoluteWorkspacePath)]),
			ROOT_ID,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_virtual_unsupported',
		});
	});

	test('빈 fsPath를 거부한다', () => {
		const result = validateWorkspacePolicy(
			snapshot(true, [folder('file', '')]),
			ROOT_ID,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_path_invalid',
		});
	});

	test('현재 Host에서 상대 경로인 fsPath를 거부한다', () => {
		const relativePath = `relative${sep}workspace`;
		assert.strictEqual(isAbsolute(relativePath), false);

		const result = validateWorkspacePolicy(
			snapshot(true, [folder('file', relativePath)]),
			ROOT_ID,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_path_invalid',
		});
	});

	test('null byte가 있는 fsPath를 거부한다', () => {
		const result = validateWorkspacePolicy(
			snapshot(true, [folder('file', `${absoluteWorkspacePath}\0private`)]),
			ROOT_ID,
		);

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_path_invalid',
		});
	});

	test('여러 실패 조건이 겹쳐도 고정된 검증 우선순위를 유지한다', () => {
		const invalidFolders = [
			folder('vscode-remote', ''),
			folder('file', 'relative', SECOND_ROOT_ID),
		];

		assert.deepStrictEqual(
			validateWorkspacePolicy(snapshot(false, invalidFolders), ROOT_ID),
			{ ok: false, code: 'workspace_untrusted' },
		);
		assert.deepStrictEqual(
			validateWorkspacePolicy(snapshot(true, invalidFolders), ROOT_ID),
			{ ok: false, code: 'workspace_virtual_unsupported' },
		);
		assert.deepStrictEqual(
			validateWorkspacePolicy(snapshot(true, [invalidFolders[0]!]), ROOT_ID),
			{ ok: false, code: 'workspace_virtual_unsupported' },
		);
	});

	test('입력 snapshot을 변경하지 않는다', () => {
		const input = snapshot(true, [folder('file', absoluteWorkspacePath)]);
		const before = input.workspaceFolders.map(({ id, scheme, fsPath }) => ({
			id,
			scheme,
			fsPath,
		}));

		validateWorkspacePolicy(input, ROOT_ID);

		assert.deepStrictEqual(
			input.workspaceFolders.map(({ id, scheme, fsPath }) => ({
				id,
				scheme,
				fsPath,
			})),
			before,
		);
	});

	test('실패 결과 직렬화에 실제 path나 URI를 포함하지 않는다', () => {
		const privatePath = `${absoluteWorkspacePath}${sep}private-do-not-leak`;
		const privateUri = 'vscode-remote://private-authority/private-do-not-leak';
		const result = validateWorkspacePolicy(
			snapshot(true, [folder(
				'vscode-remote',
				`${privatePath}:${privateUri}`,
			)]),
			ROOT_ID,
		);
		const serialized = JSON.stringify(result);

		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_virtual_unsupported',
		});
		assert.strictEqual(serialized.includes(privatePath), false);
		assert.strictEqual(serialized.includes(privateUri), false);
	});
});
