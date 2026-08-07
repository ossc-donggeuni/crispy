import DOMPurify, { type Config } from 'dompurify';

/** Assistant Markdown 문자열을 정화된 HTML로 바꾸는 동기 렌더러다. */
export type ChatMarkdownRenderer = (markdown: string) => string;

/** 테스트와 Webview가 주입할 수 있는 HTML 정화 함수의 최소 계약이다. */
export type ChatHtmlSanitizer = (dirty: string, config: Config) => string;

/** 정화 뒤 Markdown 본문에 허용하는 표현용 HTML element 목록이다. */
const allowedMarkdownTags = [
	'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3',
	'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table',
	'tbody', 'td', 'th', 'thead', 'tr', 'ul',
];

/** Markdown 링크에 필요한 최소 attribute 목록이다. */
const allowedMarkdownAttributes = ['href', 'title'];

/** Markdown link에 허용하는 절대 HTTP(S) URI 규칙이다. */
const allowedMarkdownUri = /^https?:\/\//i;

/** raw HTML을 markup이 아닌 일반 문자열로 표시하기 위한 escape 함수다. */
function escapeHtml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

/** Browser 전역 DOMPurify를 문자열 반환 정화 함수로 감싼다. */
const defaultSanitizer: ChatHtmlSanitizer = (dirty, config) =>
	String(DOMPurify.sanitize(dirty, config));

/**
 * ESM 전용 marked를 한 번 비동기로 로드하고 이후 snapshot에서 재사용할
 * 동기 Markdown 렌더러를 만든다.
 *
 * @param sanitizer Browser 또는 jsdom에 결합된 HTML 정화 함수.
 * @returns GFM parse와 allowlist 정화를 순서대로 수행하는 동기 렌더러.
 */
export async function createChatMarkdownRenderer(
	sanitizer: ChatHtmlSanitizer = defaultSanitizer,
): Promise<ChatMarkdownRenderer> {
	const { Marked } = await import('marked');
	const markdownParser = new Marked({
		gfm: true,
		async: false,
		renderer: {
			html(token): string {
				return escapeHtml(token.text);
			},
		},
	});
	return (markdown) => {
		const rendered = String(markdownParser.parse(markdown));
		return sanitizer(rendered, {
			ALLOWED_TAGS: allowedMarkdownTags,
			ALLOWED_ATTR: allowedMarkdownAttributes,
			ALLOW_DATA_ATTR: false,
			ALLOWED_URI_REGEXP: allowedMarkdownUri,
		});
	};
}
