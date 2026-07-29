import type { ProjectNode } from '../../model/projectNode';
import {
	applyNodeState,
	createElement,
	type GraphComponentContext,
} from './componentTypes';

function getTypeLabel(node: ProjectNode): string {
	if (node.type === 'directory') {
		return 'DIR';
	}

	const extension = node.name.split('.').pop();
	return extension?.toUpperCase() ?? 'FILE';
}

export function createStructureBubble(
	node: ProjectNode,
	context: GraphComponentContext,
): HTMLElement {
	const isDirectory = node.type === 'directory';
	const isExpanded = isDirectory
		? context.expandedDirectoryIds.has(node.id)
		: context.expandedFileIds.has(node.id);

	const bubble = createElement('article', 'structure-bubble');
	bubble.dataset.nodeId = node.id;
	bubble.dataset.kind = node.type;
	bubble.classList.toggle('is-expanded', isExpanded);
	applyNodeState(bubble, node.id, context);

	const selectButton = createElement('button', 'bubble-main');
	selectButton.type = 'button';
	selectButton.title = isDirectory
		? `${isExpanded ? 'Collapse' : 'Open'} ${node.name}`
		: `Select ${node.name}`;
	selectButton.setAttribute('aria-pressed', String(context.selectedNodeId === node.id));

	const typeBadge = createElement('span', 'bubble-type', getTypeLabel(node));
	typeBadge.setAttribute('aria-hidden', 'true');
	const label = createElement('span', 'bubble-label', node.name);
	selectButton.append(typeBadge, label);

	selectButton.addEventListener('click', (event) => {
		event.stopPropagation();
		if (isDirectory) {
			context.onToggleDirectory(node.id);
			return;
		}
		context.onSelect(node.id);
	});

	const actionButton = createElement(
		'button',
		'bubble-action',
		isExpanded ? '−' : '+',
	);
	actionButton.type = 'button';
	actionButton.title = isDirectory
		? `${isExpanded ? 'Collapse' : 'Open'} directory`
		: `${isExpanded ? 'Close' : 'Open'} file details`;
	actionButton.setAttribute('aria-label', actionButton.title);
	actionButton.setAttribute('aria-expanded', String(isExpanded));
	actionButton.addEventListener('click', (event) => {
		event.stopPropagation();
		if (isDirectory) {
			context.onToggleDirectory(node.id);
			return;
		}
		context.onToggleFile(node.id);
	});

	bubble.append(selectButton, actionButton);
	return bubble;
}
