/** Webview에서 inline SVG로 제공하는 Chat 아이콘 이름이다. */
export type ChatIconName =
	| 'back'
	| 'chevron-down'
	| 'chevron-right'
	| 'history'
	| 'plus'
	| 'send'
	| 'stop';

/** 아이콘별 24×24 viewBox SVG path 데이터다. */
const iconPaths: Readonly<Record<ChatIconName, readonly string[]>> = {
	back: ['M15 18l-6-6 6-6'],
	'chevron-down': ['M6 9l6 6 6-6'],
	'chevron-right': ['M9 6l6 6-6 6'],
	history: [
		'M3 12a9 9 0 1 0 3-6.7L3 8',
		'M3 3v5h5',
		'M12 7v5l3 2',
	],
	plus: ['M12 5v14', 'M5 12h14'],
	send: ['M12 19V5', 'M6 11l6-6 6 6'],
	stop: ['M8 8h8v8H8z'],
};

/**
 * CSP에 안전한 장식용 inline SVG 아이콘을 생성한다.
 * 접근 가능한 이름은 이 아이콘을 포함하는 button이 제공한다.
 *
 * @param name 생성할 Chat 아이콘 이름.
 * @returns `aria-hidden`과 비활성 focus를 적용한 SVG 요소.
 */
export function createChatIcon(name: ChatIconName): SVGSVGElement {
	const namespace = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(namespace, 'svg');
	svg.classList.add('chat-icon');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');

	for (const pathData of iconPaths[name]) {
		const path = document.createElementNS(namespace, 'path');
		path.setAttribute('d', pathData);
		svg.append(path);
	}

	return svg;
}
