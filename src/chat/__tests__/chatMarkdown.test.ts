import * as assert from 'node:assert';

import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

import {
	createChatMarkdownRenderer,
	type ChatHtmlSanitizer,
} from '../chatMarkdown';

/** jsdom Window에 결합된 DOMPurify로 실제 Webview와 같은 렌더러를 만든다. */
async function createRenderer() {
	const dom = new JSDOM('<!doctype html><html><body></body></html>');
	const purifier = createDOMPurify(dom.window);
	const sanitizer: ChatHtmlSanitizer = (dirty, config) =>
		String(purifier.sanitize(dirty, config));
	return {
		dom,
		render: await createChatMarkdownRenderer(sanitizer),
	};
}

suite('Chat Markdown 보안 렌더러', () => {
	test('commentary와 final에 필요한 GFM block과 inline 문법을 렌더링한다', async () => {
		const { render } = await createRenderer();
		const html = render([
			'# 제목',
			'',
			'문단과 `inline` 및 [링크](https://example.com).',
			'',
			'- 목록',
			'',
			'> 인용',
			'',
			'| 열 | 값 |',
			'| --- | --- |',
			'| A | B |',
			'',
			'```ts',
			'const value = 1;',
			'```',
		].join('\n'));

		assert.match(html, /<h1>제목<\/h1>/);
		assert.match(html, /<ul>/);
		assert.match(html, /<blockquote>/);
		assert.match(html, /<table>/);
		assert.match(html, /<code>inline<\/code>/);
		assert.match(html, /<pre><code>/);
		assert.doesNotMatch(html, /class=/);
		assert.match(html, /href="https:\/\/example\.com"/);
	});

	test('raw HTML은 element가 아니라 escaped plain text로 렌더링한다', async () => {
		const { dom, render } = await createRenderer();
		const host = dom.window.document.createElement('div');
		host.innerHTML = render('<b>raw</b>');

		assert.strictEqual(host.querySelector('b'), null);
		assert.strictEqual(host.textContent?.trim(), '<b>raw</b>');
	});


	for (const tag of ['script', 'iframe', 'img', 'style']) {
		test(`${tag} element를 DOM으로 삽입하지 않는다`, async () => {
			const { dom, render } = await createRenderer();
			const host = dom.window.document.createElement('div');
			const payload = tag === 'img'
				? '<img src="https://example.com/image.png">'
				: `<${tag}>payload</${tag}>`;
			host.innerHTML = render(payload);
			assert.strictEqual(host.querySelector(tag), null);
		});
	}

	for (const attribute of ['onclick', 'onerror']) {
		test(`${attribute} inline event handler를 DOM attribute로 삽입하지 않는다`, async () => {
			const { dom, render } = await createRenderer();
			const host = dom.window.document.createElement('div');
			host.innerHTML = render(`<a href="https://example.com" ${attribute}="alert(1)">링크</a>`);
			assert.strictEqual(host.querySelector(`[${attribute}]`), null);
		});
	}

	test('절대 HTTP와 HTTPS 링크의 href를 허용한다', async () => {
		const { dom, render } = await createRenderer();
		const host = dom.window.document.createElement('div');
		host.innerHTML = render('[http](http://example.com) [https](https://example.com/path)');
		const links = [...host.querySelectorAll('a')];
		assert.strictEqual(links[0]?.getAttribute('href'), 'http://example.com');
		assert.strictEqual(links[1]?.getAttribute('href'), 'https://example.com/path');
	});

	for (const [label, url] of [
		['javascript', 'javascript:alert(1)'],
		['data', 'data:text/html,hello'],
		['file', 'file:///tmp/file'],
		['mailto', 'mailto:test@example.com'],
		['relative', '/relative/path'],
	] as const) {
		test(`${label} URL의 href를 제거한다`, async () => {
			const { dom, render } = await createRenderer();
			const host = dom.window.document.createElement('div');
			host.innerHTML = render(`[링크](${url})`);
			assert.strictEqual(host.querySelector('a')?.hasAttribute('href'), false);
		});
	}

	test('잘못된 URL은 이동 가능한 anchor로 만들지 않는다', async () => {
		const { dom, render } = await createRenderer();
		const host = dom.window.document.createElement('div');
		host.innerHTML = render('[링크](not a url)');
		assert.strictEqual(host.querySelector('a[href]'), null);
	});

	test('불완전한 스트리밍 Markdown도 예외 없이 매번 정화한다', async () => {
		const { render } = await createRenderer();
		assert.doesNotThrow(() => render('```ts\nconst value ='));
		assert.doesNotThrow(() => render('[링크](https://example.com'));
		assert.doesNotThrow(() => render('<script'));
	});
});
