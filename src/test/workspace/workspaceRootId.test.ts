import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	createWorkspaceRootId,
	validateWorkspaceRootId,
	WORKSPACE_ROOT_ID_PREFIX,
} from '../../workspace/workspaceRootId';

suite('Workspace root ID contract', () => {
	test('URI 문자열에 공용 prefix를 붙여 ID를 생성한다', () => {
		const uri = vscode.Uri.parse(
			'vscode-remote://ssh-remote+dev/workspace/source%20files',
		);

		const id = createWorkspaceRootId(uri);

		assert.strictEqual(id, `${WORKSPACE_ROOT_ID_PREFIX}${uri.toString()}`);
		assert.deepStrictEqual(validateWorkspaceRootId(id), {
			ok: true,
			value: id,
		});
	});

	test('string이 아닌 값은 invalid_type으로 거부한다', () => {
		for (const value of [undefined, null, 1, {}, []]) {
			assert.deepStrictEqual(validateWorkspaceRootId(value), {
				ok: false,
				code: 'invalid_type',
			});
		}
	});

	test('공용 prefix가 없는 문자열은 invalid_prefix로 거부한다', () => {
		for (const value of ['', 'workspace-root', 'folder:file:///workspace']) {
			assert.deepStrictEqual(validateWorkspaceRootId(value), {
				ok: false,
				code: 'invalid_prefix',
			});
		}
	});

	test('prefix-only 값은 empty_payload로 거부한다', () => {
		assert.deepStrictEqual(
			validateWorkspaceRootId(WORKSPACE_ROOT_ID_PREFIX),
			{ ok: false, code: 'empty_payload' },
		);
	});

	test('한 글자와 URI에서 가능한 특수·공백·Unicode payload를 허용한다', () => {
		for (const payload of ['x', '/', '%', ' ', '\t', '작업공간', '🚀']) {
			const value = `${WORKSPACE_ROOT_ID_PREFIX}${payload}`;

			assert.deepStrictEqual(validateWorkspaceRootId(value), {
				ok: true,
				value,
			});
		}
	});

	test('임의 길이 제한 없이 매우 긴 URI를 그대로 round-trip한다', () => {
		const uri = vscode.Uri.parse(
			`vscode-remote://ssh-remote+dev/${'nested/'.repeat(3_000)}`,
		);
		const longId = createWorkspaceRootId(uri);
		const siblingId = createWorkspaceRootId(vscode.Uri.file('/workspace/sibling'));

		assert.ok(longId.length > 16_384);
		assert.deepStrictEqual(validateWorkspaceRootId(longId), {
			ok: true,
			value: longId,
		});
		assert.deepStrictEqual(validateWorkspaceRootId(siblingId), {
			ok: true,
			value: siblingId,
		});
	});
});
