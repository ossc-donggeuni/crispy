import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { readDefaultWorkspaceFilter } from '../../workspace/workspaceDefaultFilter';
import {
	matchesWorkspaceFilterRule,
	WORKSPACE_FILTER_VERSION,
	type WorkspaceFilter,
} from '../../workspace/workspaceFilter';

const EXPECTED_FOLDER_PATTERNS = [
	'.git',
	'node_modules',
	'dist',
	'build',
	'coverage',
	'.next',
	'__pycache__',
	'.venv',
] as const;

suite('Default Workspace Filter', () => {
	let defaultFilter: WorkspaceFilter;

	suiteSetup(async () => {
		const extensionUri = vscode.Uri.file(path.resolve(__dirname, '../../..'));
		const loadedFilter = await readDefaultWorkspaceFilter(extensionUri);

		assert.ok(loadedFilter, '기본 Workspace Filter JSON을 파싱해야 한다.');
		defaultFilter = loadedFilter;
	});

	test('기본 Filter JSON을 version 1 규약으로 파싱한다', () => {
		assert.strictEqual(defaultFilter.version, WORKSPACE_FILTER_VERSION);
		assert.strictEqual(defaultFilter.version, 1);
	});

	test('예상한 Folder Rule을 모두 포함한다', () => {
		const folderPatterns = defaultFilter.rules
			.filter((rule) => rule.kind === 'folder')
			.map((rule) => rule.pattern);

		assert.deepStrictEqual(folderPatterns, [...EXPECTED_FOLDER_PATTERNS]);
	});

	test('.DS_Store를 File Rule로 포함한다', () => {
		assert.ok(defaultFilter.rules.some(
			(rule) => rule.kind === 'file' && rule.pattern === '.DS_Store',
		));
		assert.ok(!defaultFilter.rules.some(
			(rule) => rule.kind === 'folder' && rule.pattern === '.DS_Store',
		));
	});

	test('기본 Rule이 대상 종류와 basename에 맞게 동작한다', () => {
		for (const basename of EXPECTED_FOLDER_PATTERNS) {
			assert.ok(defaultFilter.rules.some((rule) =>
				matchesWorkspaceFilterRule(rule, 'folder', basename),
			));
		}

		assert.ok(defaultFilter.rules.some((rule) =>
			matchesWorkspaceFilterRule(rule, 'file', '.DS_Store'),
		));
		assert.ok(!defaultFilter.rules.some((rule) =>
			matchesWorkspaceFilterRule(rule, 'folder', '.DS_Store'),
		));
	});

	test('.crispy를 기본 Filter Rule에 포함하지 않는다', () => {
		assert.ok(!defaultFilter.rules.some(
			(rule) => rule.pattern === '.crispy',
		));
		assert.ok(!defaultFilter.rules.some((rule) =>
			matchesWorkspaceFilterRule(rule, 'folder', '.crispy'),
		));
	});

	test('JSON 문법은 유효하지만 Filter schema가 잘못되면 안전하게 실패한다', async () => {
		const invalidSchema = await readDefaultWorkspaceFilter(
			vscode.Uri.file('/extension'),
			{
				readFile: async () => new TextEncoder().encode(JSON.stringify({
					version: 2,
					rules: [],
				})),
			},
		);

		assert.strictEqual(invalidSchema, undefined);
	});

	test('기본 Filter 자산을 읽거나 검증할 수 없으면 안전하게 실패한다', async () => {
		const extensionUri = vscode.Uri.file('/extension');
		const readFailure = await readDefaultWorkspaceFilter(extensionUri, {
			readFile: async () => Promise.reject(new Error('read failed')),
		});
		const invalidJson = await readDefaultWorkspaceFilter(extensionUri, {
			readFile: async () => new TextEncoder().encode('{'),
		});

		assert.strictEqual(readFailure, undefined);
		assert.strictEqual(invalidJson, undefined);
	});
});
