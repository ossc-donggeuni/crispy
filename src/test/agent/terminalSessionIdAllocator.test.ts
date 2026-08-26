import * as assert from 'node:assert/strict';
import { ID_MAX_LENGTH, ID_PATTERN } from '../../agent/protocol/limits';
import { TerminalSessionIdAllocator } from '../../agent/host/terminal/terminalSessionIdAllocator';

suite('TerminalSessionIdAllocator', () => {
	test('panel nonce와 monotonic counter만 사용하고 active collision을 재시도하지 않는다', () => {
		const allocator = new TerminalSessionIdAllocator({ nonce: 'panel-A' });
		const active = new Set(['session-panel-A-1']);

		assert.strictEqual(
			allocator.allocate((sessionId) => active.has(sessionId)),
			undefined,
		);
		assert.strictEqual(
			allocator.allocate((sessionId) => active.has(sessionId)),
			'session-panel-A-2',
		);
	});

	test('removed-session churn에도 historical Set 없이 counter를 재사용하지 않는다', () => {
		const allocator = new TerminalSessionIdAllocator({ nonce: 'panel-churn' });
		const issued: string[] = [];

		for (let index = 0; index < 256; index += 1) {
			const sessionId = allocator.allocate(() => false);
			assert.ok(sessionId !== undefined);
			issued.push(sessionId);
		}

		assert.strictEqual(new Set(issued).size, issued.length);
		assert.strictEqual(issued[0], 'session-panel-churn-1');
		assert.strictEqual(issued.at(-1), 'session-panel-churn-256');
	});

	test('MAX_SAFE_INTEGER는 한 번 발급한 뒤 overflow나 wrap 없이 영구 fail-closed다', () => {
		const allocator = new TerminalSessionIdAllocator({
			nonce: 'panel-max',
			initialCounter: Number.MAX_SAFE_INTEGER - 1,
		});

		assert.strictEqual(
			allocator.allocate(() => false),
			`session-panel-max-${Number.MAX_SAFE_INTEGER - 1}`,
		);
		assert.strictEqual(
			allocator.allocate(() => false),
			`session-panel-max-${Number.MAX_SAFE_INTEGER}`,
		);
		assert.strictEqual(allocator.allocate(() => false), undefined);
		assert.strictEqual(allocator.allocate(() => false), undefined);
	});

	test('nonce와 candidate의 ASCII grammar/128 code-unit 위반은 fail-closed다', () => {
		for (const nonce of ['bad nonce', '한글', 'x'.repeat(ID_MAX_LENGTH)]) {
			const allocator = new TerminalSessionIdAllocator({ nonce });
			assert.strictEqual(allocator.allocate(() => false), undefined);
		}

		const exactLimit = new TerminalSessionIdAllocator({
			nonce: 'x'.repeat(ID_MAX_LENGTH - 'session--1'.length),
		});
		const exactLimitSessionId = exactLimit.allocate(() => false);
		assert.ok(exactLimitSessionId !== undefined);
		assert.strictEqual(exactLimitSessionId.length, ID_MAX_LENGTH);

		const overLimit = new TerminalSessionIdAllocator({
			nonce: 'x'.repeat(ID_MAX_LENGTH - 'session--1'.length + 1),
		});
		assert.strictEqual(overLimit.allocate(() => false), undefined);

		const allocator = new TerminalSessionIdAllocator({ nonce: 'valid_nonce' });
		const sessionId = allocator.allocate(() => false);
		assert.ok(sessionId !== undefined);
		assert.match(sessionId, ID_PATTERN);
		assert.ok(sessionId.length <= ID_MAX_LENGTH);
	});

	test('panel nonce는 runtime에서도 교체할 수 없다', () => {
		const allocator = new TerminalSessionIdAllocator({ nonce: 'panel-fixed' });
		const mutableView = allocator as unknown as { nonce: string };

		assert.strictEqual(Reflect.set(mutableView, 'nonce', 'forged'), false);
		assert.strictEqual(
			allocator.allocate(() => false),
			'session-panel-fixed-1',
		);
	});
});
