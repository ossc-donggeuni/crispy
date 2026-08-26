import type {
	GraphLayout,
	GraphLayoutNode,
	GraphLayoutPosition,
} from './graphLayout';

/** G-11 visible subtree Effect Region 바깥 여백이다. */
export const GRAPH_NODE_EFFECT_REGION_PADDING = 6;

/** Graph World 좌표계의 G-11 visible subtree Effect Region이다. */
export interface GraphNodeEffectRegionBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * G-11 Parent Effect와 G-12 Binding이 공유하는 visible subtree bounds다.
 * Root 자신의 Binding은 제외하고 하위 Node의 Binding까지 포함하며,
 * Backlink는 너비에만 포함하고 숨김 Node는 제외한다.
 */
export function getGraphNodeEffectRegionBounds(
	layout: GraphLayout,
	positions: ReadonlyMap<string, GraphLayoutPosition>,
	rootNodeId: string,
): GraphNodeEffectRegionBounds | undefined {
	const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
	const childrenByParent = new Map<string, string[]>();

	for (const edge of layout.edges) {
		if (edge.hidden) {
			continue;
		}
		const childIds = childrenByParent.get(edge.sourceId) ?? [];

		childIds.push(edge.targetId);
		childrenByParent.set(edge.sourceId, childIds);
	}

	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	const visited = new Set<string>();
	const pending = [rootNodeId];

	while (pending.length > 0) {
		const nodeId = pending.pop();

		if (!nodeId || visited.has(nodeId)) {
			continue;
		}
		visited.add(nodeId);
		const node = nodesById.get(nodeId);

		if (!node || node.hidden) {
			continue;
		}
		const position = positions.get(nodeId) ?? node.position;

		minX = Math.min(minX, position.x);
		maxX = Math.max(maxX, position.x + node.width);
		pending.push(...(childrenByParent.get(nodeId) ?? []));
		if (isBacklinkOnlyNode(node)) {
			continue;
		}
		minY = Math.min(minY, position.y);
		maxY = Math.max(
			maxY,
			position.y + (
				nodeId === rootNodeId
					? node.height
					: (node.graphContentHeight ?? node.height)
			),
		);
	}

	if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
		return undefined;
	}

	return {
		x: minX - GRAPH_NODE_EFFECT_REGION_PADDING,
		y: minY - GRAPH_NODE_EFFECT_REGION_PADDING,
		width: maxX - minX + GRAPH_NODE_EFFECT_REGION_PADDING * 2,
		height: maxY - minY + GRAPH_NODE_EFFECT_REGION_PADDING * 2,
	};
}

function isBacklinkOnlyNode(node: GraphLayoutNode): boolean {
	return node.kind === 'folder-backlink'
		|| (
			node.kind === 'file-group'
			&& node.children.every((file) => file.presentation === 'backlink')
		);
}
