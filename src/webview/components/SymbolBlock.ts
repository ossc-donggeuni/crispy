import type { ProjectNode } from '../../model/projectNode';
import type { SymbolDisplayKind } from '../../model/fileAnalysis';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';

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
		event.stopPropagation();
		context.onSelect(symbol.id);
	});

	return block;
}
