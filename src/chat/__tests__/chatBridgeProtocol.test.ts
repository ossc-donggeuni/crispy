import * as assert from 'node:assert';

import {
	isAllowedExternalUrl,
	isCodexChatHostMessage,
	isCodexChatWebviewMessage,
} from '../Codex/chatBridgeProtocol';

suite('Chat Provider 공통 bridge', () => {
	test('Webview 외부 링크 요청의 문자열 payload만 허용한다', () => {
		assert.strictEqual(isCodexChatWebviewMessage({
			type: 'chat/openExternal',
			payload: { url: 'https://example.com' },
		}), true);
		assert.strictEqual(isCodexChatWebviewMessage({
			type: 'chat/openExternal',
			payload: { url: '' },
		}), false);
		assert.strictEqual(isCodexChatWebviewMessage({
			type: 'chat/openExternal',
			payload: { url: 1 },
		}), false);
	});

	test('Host는 파싱 가능한 절대 HTTP(S) URL만 허용한다', () => {
		for (const allowed of [
			'http://example.com',
			'https://example.com',
			'https://example.com/path?value=1#hash',
		]) {
			assert.strictEqual(isAllowedExternalUrl(allowed), true, allowed);
		}
		for (const denied of [
			'/relative',
			'not a url',
			'javascript:alert(1)',
			'data:text/html,hello',
			'file:///tmp/file',
			'mailto:test@example.com',
		]) {
			assert.strictEqual(isAllowedExternalUrl(denied), false, denied);
		}
	});

	test('Host snapshot은 Provider 공통 timeline 필드를 검증한다', () => {
		const snapshot = {
			type: 'codexChat/snapshot',
			payload: {
				selectedConversationId: 'conversation-1',
				sessions: [{
					id: 'conversation-1',
					title: '대화',
					lastResponseAt: '2026-08-07T00:00:00.000Z',
				}],
				items: [{
					id: 'turn-1:assistant-1',
					turnId: 'turn-1',
					kind: 'assistantMessage',
					text: '답변',
					createdAt: '2026-08-07T00:00:00.000Z',
					state: 'completed',
					assistantPhase: 'final',
				}],
				isRunning: false,
				composerAvailable: true,
				error: null,
			},
		};
		assert.strictEqual(isCodexChatHostMessage(snapshot), true);
		assert.strictEqual(isCodexChatHostMessage({
			...snapshot,
			payload: {
				...snapshot.payload,
				items: [{ ...snapshot.payload.items[0], kind: 'agentMessage' }],
			},
		}), false);
	});

	test('Host snapshot은 kind별 phase와 Activity 조합을 검증한다', () => {
		const baseItem = {
			id: 'turn-1:item-1',
			turnId: 'turn-1',
			text: '본문',
			createdAt: '2026-08-07T00:00:00.000Z',
			state: 'completed',
		};
		const snapshot = (item: unknown) => ({
			type: 'codexChat/snapshot',
			payload: {
				selectedConversationId: 'conversation-1',
				sessions: [],
				items: [item],
				isRunning: false,
				composerAvailable: true,
				error: null,
			},
		});

		assert.strictEqual(isCodexChatHostMessage(snapshot({
			...baseItem,
			kind: 'assistantMessage',
		})), false);
		assert.strictEqual(isCodexChatHostMessage(snapshot({
			...baseItem,
			kind: 'reasoning',
		})), false);
		assert.strictEqual(isCodexChatHostMessage(snapshot({
			...baseItem,
			kind: 'status',
			assistantPhase: 'final',
		})), false);
		assert.strictEqual(isCodexChatHostMessage(snapshot({
			...baseItem,
			kind: 'execution',
			activity: { label: '실행', summary: 'pnpm test' },
		})), true);
	});
});
