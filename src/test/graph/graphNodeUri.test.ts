import * as assert from 'assert';
import {
	getGraphNodeUriRelativeSegments,
	getNormalizedGraphUriPathLength,
	isGraphNodeUriWithinRoot,
	parseGraphNodeUri,
} from '../../webview/graph/graphNodeUri';

suite('Graph Node URI', () => {
	test('production Graph prefix와 absolute URI만 구조적으로 복원한다', () => {
		assert.deepStrictEqual(
			parseGraphNodeUri('file:file:///workspace/src/index.ts'),
			{ kind: 'file', uri: new URL('file:///workspace/src/index.ts') },
		);
		assert.strictEqual(parseGraphNodeUri('file:relative/index.ts'), undefined);
		assert.strictEqual(parseGraphNodeUri('mock:file:///workspace/index.ts'), undefined);
	});

	test('scheme, authority와 path segment 경계 안쪽만 Root에 포함한다', () => {
		const root = new URL('file:///workspace/root/');

		assert.strictEqual(
			isGraphNodeUriWithinRoot(new URL('file:///workspace/root'), root),
			true,
		);
		assert.strictEqual(
			isGraphNodeUriWithinRoot(new URL('file:///workspace/root/src/a.ts'), root),
			true,
		);
		assert.strictEqual(
			isGraphNodeUriWithinRoot(new URL('file:///workspace/root-other/a.ts'), root),
			false,
		);
		assert.strictEqual(
			isGraphNodeUriWithinRoot(new URL('https://host/workspace/root/a.ts'), root),
			false,
		);
	});

	test('Root 상대 URI segment를 표시할 때만 decode한다', () => {
		assert.deepStrictEqual(
			getGraphNodeUriRelativeSegments(
				new URL('file:///workspace/src/new%20file.ts'),
				new URL('file:///workspace/'),
			),
			['src', 'new file.ts'],
		);
		assert.strictEqual(
			getGraphNodeUriRelativeSegments(
				new URL('file:///workspace-sibling/new.ts'),
				new URL('file:///workspace/'),
			),
			undefined,
		);
	});

	test('trailing slash를 제외한 Root path 길이를 반환한다', () => {
		assert.strictEqual(
			getNormalizedGraphUriPathLength(new URL('file:///workspace/root///')),
			'/workspace/root'.length,
		);
	});
});
