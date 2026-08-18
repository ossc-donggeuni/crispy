import * as assert from 'assert';
import { fitRelativePath } from '../../webview/graph/graphRootContext';

suite('Graph Root Context', () => {
	test('Root 폭보다 길어도 허용 최대 폭 이하면 원문을 유지한다', () => {
		const relativePath = 'src/webview/graph/graphRenderer.ts';
		const measuredWidths: Readonly<Record<string, number>> = {
			[relativePath]: 260,
		};

		assert.strictEqual(
			fitRelativePath(relativePath, 200 * 1.5, (text) => (
				measuredWidths[text] ?? Number.POSITIVE_INFINITY
			)),
			relativePath,
		);
	});

	test('허용 최대 폭을 초과할 때만 상위 segment부터 제거하고 첫 후보에서 멈춘다', () => {
		const relativePath = 'src/webview/graph/renderers/node/graphRenderer.ts';
		const measuredCandidates: string[] = [];
		const measuredWidths: Readonly<Record<string, number>> = {
			[relativePath]: 480,
			'…/webview/graph/renderers/node/graphRenderer.ts': 390,
			'…/graph/renderers/node/graphRenderer.ts': 295,
			'…/renderers/node/graphRenderer.ts': 220,
		};
		const result = fitRelativePath(relativePath, 300, (text) => {
			measuredCandidates.push(text);
			return measuredWidths[text] ?? Number.POSITIVE_INFINITY;
		});

		assert.strictEqual(result, '…/graph/renderers/node/graphRenderer.ts');
		assert.deepStrictEqual(measuredCandidates, [
			relativePath,
			'…/webview/graph/renderers/node/graphRenderer.ts',
			'…/graph/renderers/node/graphRenderer.ts',
		]);
	});

	test('trailing slash 부모 경로도 기존 상위 segment 축약 규칙을 유지한다', () => {
		const relativePath = 'packages/demo/src/multi-root-demo/components/internal/';
		const measuredWidths: Readonly<Record<string, number>> = {
			[relativePath]: 520,
			'…/demo/src/multi-root-demo/components/internal/': 430,
			'…/src/multi-root-demo/components/internal/': 340,
			'…/multi-root-demo/components/internal/': 270,
		};

		assert.strictEqual(
			fitRelativePath(relativePath, 300, (text) => (
				measuredWidths[text] ?? Number.POSITIVE_INFINITY
			)),
			'…/multi-root-demo/components/internal/',
		);
	});

	test('마지막 segment도 넘치면 문자 단위 trailing ellipsis로 폭 안에 맞춘다', () => {
		const relativePath = 'src/extremely-long-file-name-that-cannot-fit.ts';
		const measureText = (text: string): number => Array.from(text).reduce(
			(width, character) => width + (character === 'W' ? 17 : 9),
			0,
		);
		const result = fitRelativePath(relativePath, 180, measureText);

		assert.ok(result.startsWith('…/extremely-'));
		assert.ok(result.endsWith('…'));
		assert.ok(measureText(result) <= 180);
		assert.ok(measureText('…/extremely-long-file-name-that-cannot-fit.ts') > 180);
	});

	test('문자 수가 아니라 제공된 가변 글리프 폭을 사용한다', () => {
		const relativePath = 'wide/WWWW/narrow.ts';
		const measureText = (text: string): number => Array.from(text).reduce(
			(width, character) => width + (character === 'W' ? 30 : 5),
			0,
		);

		assert.strictEqual(
			fitRelativePath(relativePath, 110, measureText),
			'…/narrow.ts',
		);
	});

	test('표시 separator를 slash로 정규화한다', () => {
		const relativePath = 'src\\webview\\graphRenderer.ts';
		const result = fitRelativePath(relativePath, 1_000, (text) => text.length);

		assert.strictEqual(result, 'src/webview/graphRenderer.ts');
	});

	test('극단적으로 작은 폭에서도 예외 없이 측정 폭 이하의 결과를 반환한다', () => {
		const measureText = (text: string): number => Array.from(text).length * 10;

		assert.strictEqual(fitRelativePath('src/file.ts', 5, measureText), '');
		assert.strictEqual(fitRelativePath('src/file.ts', 10, measureText), '…');
		assert.strictEqual(measureText(fitRelativePath('src/file.ts', 10, measureText)), 10);
	});

	test('동일 입력과 동일 측정 함수에서 항상 같은 결과를 반환한다', () => {
		const measureText = (text: string): number => text.length * 8;
		const results = Array.from({ length: 5 }, () => fitRelativePath(
			'src/webview/graph/renderers/node/graphRenderer.ts',
			160,
			measureText,
		));

		assert.strictEqual(new Set(results).size, 1);
	});
});
