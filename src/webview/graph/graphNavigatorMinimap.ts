import {
	resolveGraphLayoutNodePosition,
	type GraphLayout,
	type GraphLayoutNode,
	type GraphLayoutPosition,
} from './graphLayout';

/** Minimap이 포함할 Graph World의 축 정렬 Bounds다. */
export interface GraphBounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Minimap 또는 Graph World의 2차원 좌표다. */
export interface MinimapPoint {
	readonly x: number;
	readonly y: number;
}

/** Padding을 제외한 Minimap 렌더 영역 크기다. */
export interface MinimapSize {
	readonly width: number;
	readonly height: number;
}

/** Aspect ratio를 유지하는 World와 Minimap 좌표 사이의 양방향 Projection이다. */
export interface MinimapProjection {
	readonly scale: number;
	readonly worldOrigin: MinimapPoint;
	readonly minimapOrigin: MinimapPoint;
	worldToMinimap(point: MinimapPoint): MinimapPoint;
	minimapToWorld(point: MinimapPoint): MinimapPoint;
}

/** Minimap Rect로 표현할 Layout Node geometry다. */
export interface MinimapNodeGeometry extends GraphBounds {
	readonly id: string;
}

/** Minimap Line으로 표현할 Layout Edge geometry다. */
export interface MinimapEdgeGeometry {
	readonly id: string;
	readonly source: MinimapPoint;
	readonly target: MinimapPoint;
}

/** DOM과 독립적으로 계산한 현재 Minimap Graph geometry다. */
export interface MinimapGraphGeometry {
	readonly bounds: GraphBounds;
	readonly projection: MinimapProjection;
	readonly nodes: readonly MinimapNodeGeometry[];
	readonly edges: readonly MinimapEdgeGeometry[];
}

/** Minimap Container의 고정 내부 여백이다. */
export const GRAPH_NAVIGATOR_MINIMAP_PADDING = 8;

interface PositionedNode {
	readonly node: GraphLayoutNode;
	readonly position: GraphLayoutPosition;
}

/** 현재 Layout Node와 저장 위치만으로 전체 World Bounds를 계산한다. */
export function calculateGraphBounds(
	nodes: readonly GraphLayoutNode[],
	nodePositions: Readonly<Record<string, GraphLayoutPosition | undefined>> = {},
): GraphBounds | undefined {
	const positionedNodes = resolvePositionedNodes(nodes, nodePositions);

	if (positionedNodes.length === 0) {
		return undefined;
	}

	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;

	for (const { node, position } of positionedNodes) {
		left = Math.min(left, position.x, position.x + node.width);
		top = Math.min(top, position.y, position.y + node.height);
		right = Math.max(right, position.x, position.x + node.width);
		bottom = Math.max(bottom, position.y, position.y + node.height);
	}

	const width = right - left;
	const height = bottom - top;

	return areFiniteNumbers(left, top, width, height)
		? { x: left, y: top, width, height }
		: undefined;
}

/** Graph Bounds를 Padding 안에 aspect ratio를 유지하며 중앙 정렬한다. */
export function createMinimapProjection(
	bounds: GraphBounds,
	size: MinimapSize,
	padding = GRAPH_NAVIGATOR_MINIMAP_PADDING,
): MinimapProjection | undefined {
	if (
		!areFiniteNumbers(
			bounds.x,
			bounds.y,
			bounds.width,
			bounds.height,
			size.width,
			size.height,
			padding,
		)
		|| bounds.width < 0
		|| bounds.height < 0
		|| size.width <= 0
		|| size.height <= 0
		|| padding < 0
	) {
		return undefined;
	}

	const availableWidth = size.width - padding * 2;
	const availableHeight = size.height - padding * 2;

	if (availableWidth <= 0 || availableHeight <= 0) {
		return undefined;
	}

	const scaleCandidates = [
		bounds.width > 0 ? availableWidth / bounds.width : undefined,
		bounds.height > 0 ? availableHeight / bounds.height : undefined,
	].filter((scale): scale is number => (
		scale !== undefined && Number.isFinite(scale) && scale > 0
	));
	const scale = scaleCandidates.length > 0
		? Math.min(...scaleCandidates)
		: 1;
	const projectedWidth = bounds.width * scale;
	const projectedHeight = bounds.height * scale;
	const worldOrigin = { x: bounds.x, y: bounds.y };
	const minimapOrigin = {
		x: padding + (availableWidth - projectedWidth) / 2,
		y: padding + (availableHeight - projectedHeight) / 2,
	};
	const worldToMinimap = (point: MinimapPoint): MinimapPoint => ({
		x: (point.x - worldOrigin.x) * scale + minimapOrigin.x,
		y: (point.y - worldOrigin.y) * scale + minimapOrigin.y,
	});
	const minimapToWorld = (point: MinimapPoint): MinimapPoint => ({
		x: (point.x - minimapOrigin.x) / scale + worldOrigin.x,
		y: (point.y - minimapOrigin.y) / scale + worldOrigin.y,
	});

	return {
		scale,
		worldOrigin,
		minimapOrigin,
		worldToMinimap,
		minimapToWorld,
	};
}

/** Layout과 저장 위치를 Minimap Node/Edge 좌표로 한 번에 투영한다. */
export function createMinimapGraphGeometry(
	layout: GraphLayout,
	nodePositions: Readonly<Record<string, GraphLayoutPosition | undefined>>,
	size: MinimapSize,
	padding = GRAPH_NAVIGATOR_MINIMAP_PADDING,
): MinimapGraphGeometry | undefined {
	const positionedNodes = resolvePositionedNodes(layout.nodes, nodePositions);
	const bounds = calculateGraphBounds(
		positionedNodes.map(({ node }) => node),
		nodePositions,
	);
	const projection = bounds
		? createMinimapProjection(bounds, size, padding)
		: undefined;

	if (!bounds || !projection) {
		return undefined;
	}

	const positionsById = new Map(
		positionedNodes.map(({ node, position }) => [node.id, { node, position }]),
	);
	const nodes = positionedNodes.map(({ node, position }) => {
		const topLeft = projection.worldToMinimap(position);

		return {
			id: node.id,
			x: topLeft.x,
			y: topLeft.y,
			width: node.width * projection.scale,
			height: node.height * projection.scale,
		};
	});
	const edges = layout.edges.flatMap((edge): MinimapEdgeGeometry[] => {
		const source = positionsById.get(edge.sourceId);
		const target = positionsById.get(edge.targetId);

		if (!source || !target) {
			return [];
		}

		return [{
			id: edge.id,
			source: projection.worldToMinimap({
				x: source.position.x + source.node.width,
				y: source.position.y + source.node.height / 2,
			}),
			target: projection.worldToMinimap({
				x: target.position.x,
				y: target.position.y + target.node.height / 2,
			}),
		}];
	});

	return { bounds, projection, nodes, edges };
}

/** 유효한 좌표와 크기를 가진 Layout Node만 Minimap 계산에 포함한다. */
function resolvePositionedNodes(
	nodes: readonly GraphLayoutNode[],
	nodePositions: Readonly<Record<string, GraphLayoutPosition | undefined>>,
): PositionedNode[] {
	return nodes.flatMap((node): PositionedNode[] => {
		const position = resolveGraphLayoutNodePosition(node, nodePositions);
		const right = position.x + node.width;
		const bottom = position.y + node.height;

		return areFiniteNumbers(
			position.x,
			position.y,
			node.width,
			node.height,
			right,
			bottom,
		)
			&& node.width >= 0
			&& node.height >= 0
			? [{ node, position }]
			: [];
	});
}

function areFiniteNumbers(...values: readonly number[]): boolean {
	return values.every(Number.isFinite);
}
