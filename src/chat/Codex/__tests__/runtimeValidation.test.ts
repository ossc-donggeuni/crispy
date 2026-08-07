import * as assert from 'node:assert';

import {
	isInitializeResponse,
	validateCodexInboundMessage,
} from '../runtimeValidation';

suite('Codex app-server runtime validation', () => {
	test('알 수 없는 method도 request와 notification envelope로 보존한다', () => {
		const request = validateCodexInboundMessage({
			id: 'server-1',
			method: 'future/request',
			params: { value: 1 },
			extra: true,
		});
		const notification = validateCodexInboundMessage({
			method: 'future/notification',
			params: { value: 2 },
		});

		assert.strictEqual(request.valid, true);
		assert.strictEqual(request.valid && request.message.kind, 'request');
		assert.strictEqual(notification.valid, true);
		assert.strictEqual(notification.valid && notification.message.kind, 'notification');
	});

	test('성공과 오류 response를 구분하고 잘못된 envelope를 거부한다', () => {
		const success = validateCodexInboundMessage({ id: 1, result: null });
		const failure = validateCodexInboundMessage({
			id: 2,
			error: { code: -32_000, message: 'failed', data: { retry: false } },
		});
		const ambiguous = validateCodexInboundMessage({
			id: 3,
			result: {},
			error: { code: 1, message: 'invalid' },
		});

		assert.strictEqual(success.valid, true);
		assert.strictEqual(success.valid && success.message.kind, 'response');
		assert.strictEqual(failure.valid, true);
		assert.strictEqual(failure.valid && failure.message.kind, 'errorResponse');
		assert.strictEqual(ambiguous.valid, false);
	});

	test('initialize response의 필수 생성 필드를 runtime에서 확인한다', () => {
		assert.strictEqual(isInitializeResponse({
			userAgent: 'codex-app-server-test',
			codexHome: '/tmp/codex-home',
			platformFamily: 'unix',
			platformOs: 'macos',
		}), true);
		assert.strictEqual(isInitializeResponse({
			userAgent: 'codex-app-server-test',
			codexHome: '/tmp/codex-home',
			platformFamily: 'unix',
		}), false);
	});
});
