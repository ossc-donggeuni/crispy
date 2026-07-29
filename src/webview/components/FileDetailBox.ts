import type { ProjectNode } from '../../model/projectNode';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';
import { createSymbolBlock } from './SymbolBlock';

export function createFileDetailBox(
	file: ProjectNode,
	context: GraphComponentContext,
): HTMLElement {
	const box = createElement('section', 'graph-box file-detail-box');
	box.dataset.boxId = file.id;
	box.dataset.nodeId = file.id;
	applyNodeState(box, file.id, context);

	const header = createElement('header', 'box-header box-drag-handle');
	header.dataset.dragHandle = 'true';
	header.addEventListener('pointerdown', context.onBoxPointerDown);

	const heading = createElement('div', 'box-heading');
	const eyebrow = createElement('span', 'box-eyebrow', 'FILE DETAIL');
	const title = createElement('h2', 'box-title', file.name);
	const path = createElement('span', 'box-path', file.relativePath ?? file.name);
	heading.append(eyebrow, title, path);

	const collapseButton = createElement('button', 'box-collapse', 'Close');
	collapseButton.type = 'button';
	collapseButton.title = `Close ${file.name} details`;
	collapseButton.addEventListener('click', (event) => {
		event.stopPropagation();
		context.onToggleFile(file.id);
	});
	header.append(heading, collapseButton);

	const body = createElement('div', 'box-body symbol-list');
	const symbols = file.childrenIds
		.map((childId) => context.nodesById.get(childId))
		.filter((node): node is ProjectNode => node?.type === 'symbol');

	if (symbols.length === 0) {
		body.append(
			createElement('p', 'box-empty', 'No function blocks available.'),
		);
	} else {
		for (const symbol of symbols) {
			body.append(createSymbolBlock(symbol, context));
		}
	}

	box.append(header, body);
	box.addEventListener('click', (event) => {
		const target = event.target as HTMLElement;
		if (!target.closest('button')) {
			context.onSelect(file.id);
		}
	});
	return box;
}
