import * as assert from 'assert';
import {
	matchesWorkspaceFilterRule,
	parseWorkspaceFilter,
	parseWorkspaceFilterJson,
	WORKSPACE_FILTER_VERSION,
	type WorkspaceFilterRule,
} from '../../workspace/workspaceFilter';

suite('Workspace Filter', () => {
	test('정상 Filter JSON을 파싱한다', () => {
		assert.deepStrictEqual(parseWorkspaceFilterJson(JSON.stringify({
			version: 1,
			rules: [
				{ kind: 'folder', pattern: 'node_modules' },
				{ kind: 'file', pattern: '*.log' },
			],
		})), {
			version: WORKSPACE_FILTER_VERSION,
			rules: [
				{ kind: 'folder', pattern: 'node_modules' },
				{ kind: 'file', pattern: '*.log' },
			],
		});
	});

	test('현재 version 1만 허용한다', () => {
		for (const version of [undefined, 0, 2, '1', null]) {
			assert.strictEqual(parseWorkspaceFilter({
				version,
				rules: [],
			}), undefined);
		}
	});

	test('folder와 file Rule을 검증한다', () => {
		assert.deepStrictEqual(parseWorkspaceFilter({
			version: 1,
			rules: [
				{ kind: 'folder', pattern: 'dist' },
				{ kind: 'file', pattern: '*.tmp' },
			],
		}), {
			version: 1,
			rules: [
				{ kind: 'folder', pattern: 'dist' },
				{ kind: 'file', pattern: '*.tmp' },
			],
		});
	});

	test('알 수 없는 kind를 거부한다', () => {
		for (const kind of ['directory', 'Folder', '', 1, undefined]) {
			assert.strictEqual(parseWorkspaceFilter({
				version: 1,
				rules: [{ kind, pattern: '*' }],
			}), undefined);
		}
	});

	test('비어 있거나 basename 규약에 맞지 않는 pattern을 거부한다', () => {
		for (const pattern of [
			'',
			'   ',
			'src/generated',
			'src\\generated',
			'bad\0name',
			1,
			null,
			undefined,
		]) {
			assert.strictEqual(parseWorkspaceFilter({
				version: 1,
				rules: [{ kind: 'folder', pattern }],
			}), undefined);
		}
	});

	test('잘못된 JSON과 전체 Filter 구조를 안전하게 거부한다', () => {
		for (const source of ['', '{', '{"version":1,}', 'null']) {
			assert.doesNotThrow(() => parseWorkspaceFilterJson(source));
			assert.strictEqual(parseWorkspaceFilterJson(source), undefined);
		}

		for (const value of [
			null,
			[],
			{},
			{ version: 1 },
			{ version: 1, rules: {} },
			{ version: 1, rules: [null] },
			{ version: 1, rules: [], unexpected: true },
			{
				version: 1,
				rules: [{ kind: 'file', pattern: '*', unexpected: true }],
			},
		]) {
			assert.doesNotThrow(() => parseWorkspaceFilter(value));
			assert.strictEqual(parseWorkspaceFilter(value), undefined);
		}
	});

	test('입력 Rule 객체와 mutation을 공유하지 않는다', () => {
		const input = {
			version: 1,
			rules: [{ kind: 'file', pattern: '*.log' }],
		};
		const filter = parseWorkspaceFilter(input);

		assert.ok(filter);
		input.rules[0]!.pattern = '*.tmp';

		assert.deepStrictEqual(filter.rules, [
			{ kind: 'file', pattern: '*.log' },
		]);
		assert.notStrictEqual(filter.rules, input.rules);
		assert.notStrictEqual(filter.rules[0], input.rules[0]);
	});

	test('Folder와 File basename을 exact 또는 wildcard pattern으로 매칭한다', () => {
		assert.strictEqual(matchesWorkspaceFilterRule(
			{ kind: 'folder', pattern: 'node_modules' },
			'folder',
			'node_modules',
		), true);
		assert.strictEqual(matchesWorkspaceFilterRule(
			{ kind: 'file', pattern: '*.log' },
			'file',
			'debug.log',
		), true);
		assert.strictEqual(matchesWorkspaceFilterRule(
			{ kind: 'file', pattern: 'debug-?.log' },
			'file',
			'debug-1.log',
		), true);
		assert.strictEqual(matchesWorkspaceFilterRule(
			{ kind: 'file', pattern: '*.log' },
			'file',
			'debug.txt',
		), false);
		assert.strictEqual(matchesWorkspaceFilterRule(
			{ kind: 'file', pattern: '*.log' },
			'file',
			'logs/debug.log',
		), false);
	});

	test('Folder Rule은 File에, File Rule은 Folder에 적용하지 않는다', () => {
		const folderRule: WorkspaceFilterRule = {
			kind: 'folder',
			pattern: '*',
		};
		const fileRule: WorkspaceFilterRule = {
			kind: 'file',
			pattern: '*',
		};

		assert.strictEqual(
			matchesWorkspaceFilterRule(folderRule, 'file', 'node_modules'),
			false,
		);
		assert.strictEqual(
			matchesWorkspaceFilterRule(fileRule, 'folder', 'debug.log'),
			false,
		);
	});
});
