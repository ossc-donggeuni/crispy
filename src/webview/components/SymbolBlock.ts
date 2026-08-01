import type { ProjectNode } from '../../model/projectNode';
import type { SymbolDisplayKind } from '../../model/fileAnalysis';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';

/** function getStartLine( symbol )
 *
 * - 메타데이터가 없는 기존 Mock Symbol ID의 마지막 구간에서 줄 번호를 읽는다.
 *
 * @param symbol 줄 번호를 확인할 Symbol 노드
 * @returns 		표시할 줄 번호 또는 알 수 없음을 나타내는 문자
 */
function getStartLine(symbol: ProjectNode): string {
	const line = symbol.id.slice(symbol.id.lastIndexOf(':') + 1);
	return /^\d+$/.test(line) ? line : '—';
}

const symbolKindLabels: Record<SymbolDisplayKind, string> = {
	function: 'Function',
	class: 'Class',
	method: 'Method',
	constructor: 'Constructor',
	interface: 'Interface',
	enum: 'Enum',
	struct: 'Struct',
	module: 'Module',
};

const symbolKindIcons: Record<SymbolDisplayKind, string> = {
	function: 'ƒ',
	class: 'C',
	method: 'm',
	constructor: '◇',
	interface: 'I',
	enum: 'E',
	struct: 'S',
	module: 'M',
};

/** function createSymbolBlock( symbol, context )
 *
 * - Symbol 이름과 실제 종류 및 선언 줄 번호를 선택 가능한 Block으로 표시한다.
 * - 메타데이터가 없으면 기존 Mock ID와 Function 표시 규칙을 사용한다.
 * - 선택 이벤트를 기존 노드 선택 경로에 전달한다.
 *
 * @param symbol 표시할 Symbol 노드
 * @param context 그래프 컴포넌트 공통 컨텍스트
 * @returns 		렌더링된 Symbol Block 요소
 */
export function createSymbolBlock(
	symbol: ProjectNode,
	context: GraphComponentContext,
): HTMLElement {
	const metadata = context.symbolMetadataByNodeId.get(symbol.id);
	const kind = metadata?.kind ?? 'function';
	const startLine = metadata?.startLine.toString() ?? getStartLine(symbol);
	const block = createElement('button', 'symbol-block');
	block.type = 'button';
	block.dataset.nodeId = symbol.id;
	block.dataset.symbolKind = kind;
	block.title = metadata?.detail
		? `${metadata.detail} · Select ${symbol.name}`
		: `Select ${symbol.name}`;
	applyNodeState(block, symbol.id, context);

	const icon = createElement('span', 'symbol-icon', symbolKindIcons[kind]);
	icon.setAttribute('aria-hidden', 'true');
	const content = createElement('span', 'symbol-content');
	const name = createElement('strong', 'symbol-name', symbol.name);
	const meta = createElement(
		'span',
		'symbol-meta',
		`${symbolKindLabels[kind]} · Line ${startLine}`,
	);
	content.append(name, meta);
	block.append(icon, content);
	block.addEventListener('click', (event) => {
		// File Detail Box 선택으로 전파하지 않고 Symbol 자체를 선택한다.
		event.stopPropagation();
		context.onSelect(symbol.id);
	});

	return block;
}
