/**
 * Agent UI가 DOM을 만들고 문서 수준 이벤트를 듣는 최소 경계다.
 * 실제 `document` 없이도 UI 구성을 검증할 수 있도록 주입 가능하게 둔다.
 */
export interface AgentUiDependencies {
	createElement<K extends keyof HTMLElementTagNameMap>(
		tagName: K,
	): HTMLElementTagNameMap[K];

	/**
	 * 드롭다운 바깥 클릭처럼 요소 밖에서 발생하는 이벤트를 구독한다.
	 *
	 * @returns 구독을 해제하는 함수
	 */
	addDocumentListener(
		type: string,
		listener: (event: Event) => void,
	): () => void;
}

/** 브라우저 `document`를 그대로 사용하는 기본 DOM 의존성이다. */
export const defaultAgentUiDependencies: AgentUiDependencies = {
	createElement: (tagName) => document.createElement(tagName),
	addDocumentListener: (type, listener) => {
		document.addEventListener(type, listener);
		return () => document.removeEventListener(type, listener);
	},
};
