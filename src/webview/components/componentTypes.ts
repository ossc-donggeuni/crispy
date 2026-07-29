import type { NodePlanInfo, ProjectNode } from '../../model/projectNode';

export type GraphComponentContext = {
	nodesById: ReadonlyMap<string, ProjectNode>;
	selectedNodeId?: string;
	expandedDirectoryIds: ReadonlySet<string>;
	expandedFileIds: ReadonlySet<string>;
	planInfoByNodeId: ReadonlyMap<string, NodePlanInfo>;
	onSelect: (nodeId: string) => void;
	onToggleDirectory: (nodeId: string) => void;
	onToggleFile: (nodeId: string) => void;
	onBoxPointerDown: (event: PointerEvent) => void;
};

export function applyNodeState(
	element: HTMLElement,
	nodeId: string,
	context: GraphComponentContext,
): void {
	if (context.selectedNodeId === nodeId) {
		element.classList.add('is-selected');
	}

	const planInfo = context.planInfoByNodeId.get(nodeId);
	if (planInfo) {
		element.dataset.relation = planInfo.relation;
	}
}

export function createElement<K extends keyof HTMLElementTagNameMap>(
	tagName: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tagName);
	if (className) {
		element.className = className;
	}
	if (text !== undefined) {
		element.textContent = text;
	}
	return element;
}
