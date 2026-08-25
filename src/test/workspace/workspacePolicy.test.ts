import * as assert from 'assert';
import {
	validateWorkspacePolicy,
	type WorkspacePolicyInput,
} from '../../workspace/workspacePolicy';

suite('Shared Workspace policy', () => {
	test('POSIX file root의 absolute fsPath를 변경 없이 반환한다', () => {
		const fsPath = '/workspace/../validated-root';

		assert.deepStrictEqual(validateWorkspacePolicy({
			uriScheme: 'file',
			fsPath,
			platform: 'linux',
		}), { ok: true, fsPath });
	});

	test('Windows drive와 UNC absolute path를 허용한다', () => {
		for (const fsPath of [
			'C:\\workspace\\project',
			'\\\\server\\share\\project',
		]) {
			assert.deepStrictEqual(validateWorkspacePolicy({
				uriScheme: 'file',
				fsPath,
				platform: 'win32',
			}), { ok: true, fsPath });
		}
	});

	test('file 이외 scheme은 path보다 먼저 거부한다', () => {
		assert.deepStrictEqual(validateWorkspacePolicy({
			uriScheme: 'vscode-remote',
			fsPath: '',
			platform: 'linux',
		}), {
			ok: false,
			code: 'workspace_virtual_unsupported',
		});
	});

	test('빈 path, NUL 포함 path와 현재 platform의 상대 path를 거부한다', () => {
		const invalidPaths = ['', '/workspace\0private', 'relative/workspace'];

		for (const fsPath of invalidPaths) {
			assert.deepStrictEqual(validateWorkspacePolicy({
				uriScheme: 'file',
				fsPath,
				platform: 'linux',
			}), {
				ok: false,
				code: 'workspace_path_invalid',
			});
		}
	});

	test('platform별 absolute path 규칙을 명시적으로 적용한다', () => {
		assert.deepStrictEqual(validateWorkspacePolicy({
			uriScheme: 'file',
			fsPath: 'C:\\workspace\\project',
			platform: 'linux',
		}), { ok: false, code: 'workspace_path_invalid' });
		assert.deepStrictEqual(validateWorkspacePolicy({
			uriScheme: 'file',
			fsPath: 'C:workspace\\project',
			platform: 'win32',
		}), { ok: false, code: 'workspace_path_invalid' });
	});

	test('filesystem 존재 여부를 확인하지 않는다', () => {
		const fsPath = '/definitely/not/checked/by/workspace-policy';

		assert.deepStrictEqual(validateWorkspacePolicy({
			uriScheme: 'file',
			fsPath,
			platform: 'darwin',
		}), { ok: true, fsPath });
	});

	test('입력을 변경하지 않고 실패 결과에 path나 URI를 포함하지 않는다', () => {
		const input = Object.freeze({
			uriScheme: 'vscode-remote-private',
			fsPath: '/private/workspace-do-not-leak',
			platform: 'linux',
		}) satisfies WorkspacePolicyInput;
		const before = structuredClone(input);
		const result = validateWorkspacePolicy(input);
		const serialized = JSON.stringify(result);

		assert.deepStrictEqual(input, before);
		assert.deepStrictEqual(result, {
			ok: false,
			code: 'workspace_virtual_unsupported',
		});
		assert.strictEqual(serialized.includes(input.uriScheme), false);
		assert.strictEqual(serialized.includes(input.fsPath), false);
	});
});
