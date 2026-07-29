import type { ProjectNode } from '../../model/projectNode';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';
import { createStructureBubble } from './StructureBubble';

export function createProjectBox(
	project: ProjectNode,
	context: GraphComponentContext,
): HTMLElement {
	const box = createElement('section', 'graph-box project-box');
	box.dataset.boxId = project.id;
	box.dataset.nodeId = project.id;
	applyNodeState(box, project.id, context);

	const header = createElement('header', 'box-header box-drag-handle');
	header.dataset.dragHandle = 'true';
	header.addEventListener('pointerdown', context.onBoxPointerDown);

	const heading = createElement('div', 'box-heading');
	const eyebrow = createElement('span', 'box-eyebrow', 'PROJECT');
	const title = createElement('h2', 'box-title', project.name);
	const path = createElement('span', 'box-path', project.relativePath ?? project.name);
	heading.append(eyebrow, title, path);

	const count = createElement(
		'span',
		'box-count',
		`${project.childrenIds.length} direct items`,
	);
	header.append(heading, count);

	const body = createElement('div', 'box-body');
	const hint = createElement(
		'p',
		'box-hint',
		'Open directories to arrange the project structure.',
	);
	const grid = createElement('div', 'bubble-grid');

	for (const childId of project.childrenIds) {
		const child = context.nodesById.get(childId);
		if (child) {
			grid.append(createStructureBubble(child, context));
		}
	}

	body.append(hint, grid);
	box.append(header, body);
	box.addEventListener('click', (event) => {
		const target = event.target as HTMLElement;
		if (!target.closest('button')) {
			context.onSelect(project.id);
		}
	});
	return box;
}
