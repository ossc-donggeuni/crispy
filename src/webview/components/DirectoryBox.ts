import type { ProjectNode } from '../../model/projectNode';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';
import { createStructureBubble } from './StructureBubble';

export function createDirectoryBox(
	directory: ProjectNode,
	context: GraphComponentContext,
): HTMLElement {
	const box = createElement('section', 'graph-box directory-box');
	box.dataset.boxId = directory.id;
	box.dataset.nodeId = directory.id;
	applyNodeState(box, directory.id, context);

	const header = createElement('header', 'box-header box-drag-handle');
	header.dataset.dragHandle = 'true';
	header.addEventListener('pointerdown', context.onBoxPointerDown);

	const heading = createElement('div', 'box-heading');
	const eyebrow = createElement('span', 'box-eyebrow', 'DIRECTORY');
	const titleRow = createElement('div', 'box-title-row');
	const title = createElement('h2', 'box-title', directory.name);
	const count = createElement(
		'span',
		'box-count compact',
		String(directory.childrenIds.length),
	);
	titleRow.append(title, count);
	const path = createElement(
		'span',
		'box-path',
		directory.relativePath ?? directory.name,
	);
	heading.append(eyebrow, titleRow, path);

	const collapseButton = createElement('button', 'box-collapse', 'Collapse');
	collapseButton.type = 'button';
	collapseButton.title = `Collapse ${directory.name}`;
	collapseButton.addEventListener('click', (event) => {
		event.stopPropagation();
		context.onToggleDirectory(directory.id);
	});

	header.append(heading, collapseButton);

	const body = createElement('div', 'box-body');
	if (directory.childrenIds.length === 0) {
		body.append(createElement('p', 'box-empty', 'This directory is empty.'));
	} else {
		const grid = createElement('div', 'bubble-grid');
		for (const childId of directory.childrenIds) {
			const child = context.nodesById.get(childId);
			if (child) {
				grid.append(createStructureBubble(child, context));
			}
		}
		body.append(grid);
	}

	box.append(header, body);
	box.addEventListener('click', (event) => {
		const target = event.target as HTMLElement;
		if (!target.closest('button')) {
			context.onSelect(directory.id);
		}
	});
	return box;
}
