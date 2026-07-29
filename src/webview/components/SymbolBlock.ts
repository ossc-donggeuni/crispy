import type { ProjectNode } from '../../model/projectNode';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';

function getStartLine(symbol: ProjectNode): string {
	const line = symbol.id.slice(symbol.id.lastIndexOf(':') + 1);
	return /^\d+$/.test(line) ? line : '—';
}

export function createSymbolBlock(
	symbol: ProjectNode,
	context: GraphComponentContext,
): HTMLElement {
	const block = createElement('button', 'symbol-block');
	block.type = 'button';
	block.dataset.nodeId = symbol.id;
	block.title = `Select ${symbol.name}`;
	applyNodeState(block, symbol.id, context);

	const icon = createElement('span', 'symbol-icon', 'ƒ');
	icon.setAttribute('aria-hidden', 'true');
	const content = createElement('span', 'symbol-content');
	const name = createElement('strong', 'symbol-name', symbol.name);
	const meta = createElement(
		'span',
		'symbol-meta',
		`Function · Line ${getStartLine(symbol)}`,
	);
	content.append(name, meta);
	block.append(icon, content);
	block.addEventListener('click', (event) => {
		event.stopPropagation();
		context.onSelect(symbol.id);
	});

	return block;
}
