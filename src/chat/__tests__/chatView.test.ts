import * as assert from 'node:assert';

import { JSDOM } from 'jsdom';

import {
	ChatView,
	type ChatViewOptions,
} from '../chat';
import type { ChatTimelineItem } from '../chatTimeline';

/** jsdom 전역과 최소 Chat 옵션을 만들어 ChatView DOM을 렌더링한다. */
function createView(
	messages: readonly ChatTimelineItem[],
	onOpenExternal?: (url: string) => void,
	renderMarkdown: (markdown: string) => string = (markdown) => markdown,
	simulateLongMessages = false,
): {
	dom: JSDOM;
	root: HTMLElement;
	view: ChatView;
	flushAnimationFrames: () => void;
} {
	const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
		url: 'https://webview.local/',
	});
	const animationFrames: FrameRequestCallback[] = [];
	if (simulateLongMessages) {
		Object.defineProperty(dom.window.HTMLElement.prototype, 'scrollHeight', {
			configurable: true,
			get() {
				return (this as HTMLElement).classList.contains('chat-message-body') ? 500 : 0;
			},
		});
	}
	Object.assign(globalThis, {
		window: dom.window,
		document: dom.window.document,
		Element: dom.window.Element,
		HTMLElement: dom.window.HTMLElement,
		HTMLAnchorElement: dom.window.HTMLAnchorElement,
		Event: dom.window.Event,
		MouseEvent: dom.window.MouseEvent,
		KeyboardEvent: dom.window.KeyboardEvent,
		getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			animationFrames.push(callback);
			return animationFrames.length;
		},
		cancelAnimationFrame: () => undefined,
	});
	const root = dom.window.document.getElementById('root') as HTMLElement;
	const options: ChatViewOptions = {
		sessions: [],
		messages,
		renderMarkdown,
		agents: [{ value: 'codex', label: 'Codex' }],
		models: [{ value: 'default', label: '기본 모델' }],
		modelOptions: [{ value: 'default', label: '기본 옵션' }],
		onOpenExternal,
	};
	return {
		dom,
		root,
		view: new ChatView(root, options),
		flushAnimationFrames: () => {
			while (animationFrames.length > 0) {
				animationFrames.shift()?.(0);
			}
		},
	};
}

/** 테스트 메시지의 공통 메타데이터를 만든다. */
function message(
	overrides: Partial<ChatTimelineItem> & Pick<ChatTimelineItem, 'kind'>,
): ChatTimelineItem {
	return {
		id: `${overrides.kind}-1`,
		turnId: 'turn-1',
		text: '본문',
		createdAt: '2026-08-07T00:00:00.000Z',
		state: 'completed',
		...overrides,
	};
}

suite('ChatView Provider 공통 timeline DOM', () => {
	test('긴 final에는 collapse class를 만들지 않는다', () => {
		const final = message({
			kind: 'assistantMessage',
			assistantPhase: 'final',
			text: Array.from({ length: 12 }, (_, index) => `줄 ${index}`).join('\n'),
		});
		const { root, view, flushAnimationFrames } = createView(
			[final],
			undefined,
			undefined,
			true,
		);
		flushAnimationFrames();

		assert.strictEqual(root.querySelector('.chat-message-body.is-collapsed'), null);
		assert.strictEqual(root.querySelector('.chat-message-content.is-collapsible'), null);
		view.dispose();
	});

	test('긴 final에는 더 보기 버튼을 만들지 않는다', () => {
		const final = message({
			kind: 'assistantMessage',
			assistantPhase: 'final',
			text: Array.from({ length: 12 }, (_, index) => `줄 ${index}`).join('\n'),
		});
		const { root, view } = createView([final]);

		assert.strictEqual(
			root.querySelector('.chat-message.is-final .chat-message-overflow-controls'),
			null,
		);
		assert.strictEqual(root.querySelector('.chat-message.is-final .chat-message-toggle'), null);
		view.dispose();
	});

	test('긴 non-final 메시지는 기존 8줄 collapse 동작을 유지한다', () => {
		const commentary = message({
			kind: 'assistantMessage',
			assistantPhase: 'commentary',
			text: '진행 설명',
		});
		const { root, view, flushAnimationFrames } = createView(
			[commentary],
			undefined,
			undefined,
			true,
		);
		flushAnimationFrames();

		assert.ok(root.querySelector('.chat-message-body.is-collapsed'));
		assert.ok(root.querySelector('.chat-message-content.is-collapsible'));
		assert.strictEqual(
			root.querySelector<HTMLButtonElement>('.chat-message-toggle')?.textContent,
			'더 보기',
		);
		view.dispose();
	});

	test('Activity는 유형·상태·요약을 표시한다', () => {
		const activity = message({
			kind: 'execution',
			state: 'streaming',
			activity: {
				label: '실행',
				summary: 'pnpm test',
				details: '<b>line 1</b>\nline 2',
			},
		});
		const { root, view } = createView([activity]);
		const details = root.querySelector<HTMLDetailsElement>('.chat-activity');
		const summary = root.querySelector<HTMLElement>('.chat-activity-summary');

		assert.ok(details);
		assert.match(summary?.textContent ?? '', /실행.*진행 중.*pnpm test/);
		view.dispose();
	});

	test('Activity details는 기본 접힘이고 마우스로 펼침·접힘을 전환한다', () => {
		const activity = message({
			kind: 'execution',
			activity: { label: '실행', summary: '명령', details: '출력' },
		});
		const { root, view } = createView([activity]);
		const details = root.querySelector<HTMLDetailsElement>('.chat-activity');
		const summary = root.querySelector<HTMLElement>('.chat-activity-summary');
		assert.ok(details);
		assert.strictEqual(details.open, false);
		summary?.click();
		assert.strictEqual(details.open, true);
		summary?.click();
		assert.strictEqual(details.open, false);
		view.dispose();
	});

	test('Activity는 native summary 키보드 접근성 계약을 유지한다', () => {
		const activity = message({
			kind: 'execution',
			activity: { label: '실행', summary: '명령', details: '출력' },
		});
		const { dom, root, view } = createView([activity]);
		const details = root.querySelector<HTMLDetailsElement>('.chat-activity');
		const summary = root.querySelector<HTMLElement>('.chat-activity-summary');
		assert.strictEqual(summary?.tagName, 'SUMMARY');
		assert.strictEqual(summary?.tabIndex, 0);
		summary?.focus();
		assert.strictEqual(dom.window.document.activeElement, summary);
		const keydown = new dom.window.KeyboardEvent('keydown', {
			key: 'Enter',
			bubbles: true,
			cancelable: true,
		});
		assert.strictEqual(summary?.dispatchEvent(keydown), true);
		summary?.click();
		assert.strictEqual(details?.open, true);
		view.dispose();
	});

	for (const kind of ['execution', 'fileChange'] as const) {
		test(`${kind} details는 plain text·줄바꿈·가로 스크롤 class를 유지한다`, () => {
			const activity = message({
				kind,
				activity: {
					label: kind === 'execution' ? '실행' : '파일 변경',
					summary: '요약',
					details: '<b>line 1</b>\n  line 2',
				},
			});
			const { root, view } = createView([activity]);
			const body = root.querySelector<HTMLElement>('.chat-activity-details.is-output');
			assert.strictEqual(body?.textContent, '<b>line 1</b>\n  line 2');
			assert.strictEqual(body?.querySelector('b'), null);
			assert.strictEqual(body?.tagName, 'PRE');
			view.dispose();
		});
	}

	test('reasoning details는 같은 Activity 안에서 prose class를 사용한다', () => {
		const reasoning = message({
			kind: 'reasoning',
			activity: { label: '추론', summary: '분석', details: '문장입니다.' },
		});
		const { root, view } = createView([reasoning]);
		assert.ok(root.querySelector('.chat-activity-details.is-prose'));
		view.dispose();
	});

	test('사용자 본문은 HTML을 해석하지 않고 plain text로 표시한다', () => {
		const user = message({ kind: 'userMessage', text: '<img src=x onerror=alert(1)>' });
		const { root, view } = createView([user]);
		const body = root.querySelector('.chat-message-body');
		assert.strictEqual(body?.textContent, '<img src=x onerror=alert(1)>');
		assert.strictEqual(body?.querySelector('img'), null);
		view.dispose();
	});

	test('Markdown 링크는 Webview 이동 대신 외부 링크 callback만 호출한다', () => {
		const opened: string[] = [];
		const assistant = message({
			kind: 'assistantMessage',
			assistantPhase: 'final',
			text: '[링크](https://example.com)',
		});
		const { dom, root, view } = createView(
			[assistant],
			(url) => opened.push(url),
			() => '<p><a href="https://example.com">링크</a></p>',
		);
		const link = root.querySelector<HTMLAnchorElement>('a');
		const click = new dom.window.MouseEvent('click', {
			bubbles: true,
			cancelable: true,
		});
		assert.strictEqual(link?.dispatchEvent(click), false);
		assert.deepStrictEqual(opened, ['https://example.com']);
		assert.strictEqual(dom.window.location.href, 'https://webview.local/');
		view.dispose();
	});

	test('렌더링 class에 Codex 스키마 이름을 노출하지 않는다', () => {
		const activity = message({
			kind: 'execution',
			activity: { label: '실행', summary: '명령' },
		});
		const { root, view } = createView([activity]);
		assert.doesNotMatch(root.innerHTML, /commandExecution|agentMessage|CodexChatItemType/);
		view.dispose();
	});
});
