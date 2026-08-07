import * as assert from 'node:assert';

import { JsonlLineDecoder } from '../jsonl';

suite('Codex JsonlLineDecoder', () => {
	test('UTF-8 문자와 JSONL 줄이 chunk 경계에서 나뉘어도 원문을 복원한다', () => {
		const decoder = new JsonlLineDecoder();
		const source = '{"text":"한글"}\n{"value":2}\r\n';
		const bytes = Buffer.from(source);
		const lines: string[] = [];

		for (let index = 0; index < bytes.length; index += 1) {
			lines.push(...decoder.push(bytes.subarray(index, index + 1)));
		}

		assert.deepStrictEqual(lines, [
			'{"text":"한글"}',
			'{"value":2}',
		]);
		assert.deepStrictEqual(decoder.finish(), []);
	});

	test('한 chunk의 여러 줄과 마지막 미개행 줄을 모두 반환한다', () => {
		const decoder = new JsonlLineDecoder();

		assert.deepStrictEqual(
			decoder.push('{"first":true}\n{"second":true}\n{"last":true}'),
			['{"first":true}', '{"second":true}'],
		);
		assert.deepStrictEqual(decoder.finish(), ['{"last":true}']);
		assert.deepStrictEqual(decoder.finish(), []);
		assert.throws(() => decoder.push('{}\n'), /종료된 JSONL decoder/);
	});
});
