import type { GraphCamera } from './graphCamera';
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

/** Padding을 적용하기 전 Minimap 또는 Graph Viewport의 전체 렌더 크기다. */
export interface MinimapSize {
	readonly width: number;
	readonly height: number;
}

/** Client 좌표를 Minimap SVG 좌표로 바꾸는 데 필요한 화면 Bounds다. */
export interface MinimapClientBounds extends MinimapSize {
	readonly left: number;
	readonly top: number;
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

/** 현재 Camera가 보는 World 영역을 Minimap SVG 안에 Clamp한 Rect다. */
export type MinimapViewportGeometry = GraphBounds;

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

/** 기존 Camera API로 Graph Viewport의 좌상단과 우하단을 World Bounds로 변환한다. */
export function calculateCameraWorldBounds(
	camera: Pick<GraphCamera, 'viewportToWorld'>,
	viewportSize: MinimapSize,
): GraphBounds | undefined {
	if (
		!areFiniteNumbers(viewportSize.width, viewportSize.height)
		|| viewportSize.width <= 0
		|| viewportSize.height <= 0
	) {
		return undefined;
	}

	let first: MinimapPoint;
	let second: MinimapPoint;

	try {
		first = camera.viewportToWorld({ x: 0, y: 0 });
		second = camera.viewportToWorld({
			x: viewportSize.width,
			y: viewportSize.height,
		});
	} catch {
		return undefined;
	}

	if (!first || !second || !areFiniteNumbers(first.x, first.y, second.x, second.y)) {
		return undefined;
	}

	const left = Math.min(first.x, second.x);
	const top = Math.min(first.y, second.y);
	const right = Math.max(first.x, second.x);
	const bottom = Math.max(first.y, second.y);
	const width = right - left;
	const height = bottom - top;

	return areFiniteNumbers(left, top, width, height)
		? { x: left, y: top, width, height }
		: undefined;
}

/** Camera World Bounds를 현재 Graph Projection으로 변환하고 SVG 영역 안에 Clamp한다. */
export function createMinimapViewportGeometry(
	worldBounds: GraphBounds,
	projection: MinimapProjection,
	minimapSize: MinimapSize,
): MinimapViewportGeometry | undefined {
	if (
		!areFiniteNumbers(
			worldBounds.x,
			worldBounds.y,
			worldBounds.width,
			worldBounds.height,
			minimapSize.width,
			minimapSize.height,
		)
		|| worldBounds.width < 0
		|| worldBounds.height < 0
		|| minimapSize.width <= 0
		|| minimapSize.height <= 0
	) {
		return undefined;
	}

	let first: MinimapPoint;
	let second: MinimapPoint;

	try {
		first = projection.worldToMinimap({
			x: worldBounds.x,
			y: worldBounds.y,
		});
		second = projection.worldToMinimap({
			x: worldBounds.x + worldBounds.width,
			y: worldBounds.y + worldBounds.height,
		});
	} catch {
		return undefined;
	}

	if (!first || !second || !areFiniteNumbers(first.x, first.y, second.x, second.y)) {
		return undefined;
	}

	const left = clamp(Math.min(first.x, second.x), 0, minimapSize.width);
	const top = clamp(Math.min(first.y, second.y), 0, minimapSize.height);
	const right = clamp(Math.max(first.x, second.x), 0, minimapSize.width);
	const bottom = clamp(Math.max(first.y, second.y), 0, minimapSize.height);
	const width = Math.max(0, right - left);
	const height = Math.max(0, bottom - top);

	return areFiniteNumbers(left, top, width, height)
		? { x: left, y: top, width, height }
		: undefined;
}

/** Client Point를 실제 SVG 화면 크기와 viewBox 크기에 맞춰 Minimap Point로 변환한다. */
export function clientToMinimapPoint(
	clientPoint: MinimapPoint,
	clientBounds: MinimapClientBounds,
	minimapSize: MinimapSize,
): MinimapPoint | undefined {
	if (
		!areFiniteNumbers(
			clientPoint.x,
			clientPoint.y,
			clientBounds.left,
			clientBounds.top,
			clientBounds.width,
			clientBounds.height,
			minimapSize.width,
			minimapSize.height,
		)
		|| clientBounds.width <= 0
		|| clientBounds.height <= 0
		|| minimapSize.width <= 0
		|| minimapSize.height <= 0
	) {
		return undefined;
	}

	const point = {
		x: (clientPoint.x - clientBounds.left)
			* minimapSize.width / clientBounds.width,
		y: (clientPoint.y - clientBounds.top)
			* minimapSize.height / clientBounds.height,
	};

	return areFiniteNumbers(point.x, point.y) ? point : undefined;
}

/** 두 Minimap Point를 같은 Projection으로 역변환해 World 이동량을 계산한다. */
export function calculateMinimapWorldDelta(
	projection: MinimapProjection,
	start: MinimapPoint,
	current: MinimapPoint,
): MinimapPoint | undefined {
	if (!areFiniteNumbers(start.x, start.y, current.x, current.y)) {
		return undefined;
	}

	let startWorld: MinimapPoint;
	let currentWorld: MinimapPoint;

	try {
		startWorld = projection.minimapToWorld(start);
		currentWorld = projection.minimapToWorld(current);
	} catch {
		return undefined;
	}

	if (
		!startWorld
		|| !currentWorld
		|| !areFiniteNumbers(
			startWorld.x,
			startWorld.y,
			currentWorld.x,
			currentWorld.y,
		)
	) {
		return undefined;
	}

	const delta = {
		x: currentWorld.x - startWorld.x,
		y: currentWorld.y - startWorld.y,
	};

	return areFiniteNumbers(delta.x, delta.y) ? delta : undefined;
}

/** Layout과 저장 위치를 Minimap Node/Edge 좌표로 한 번에 투영한다. */
export function createMinimapGraphGeometry(
	layout: GraphLayout,
	nodePositions: Readonly<Record<string, GraphLayoutPosition | undefined>>,
	size: MinimapSize,
	padding = GRAPH_NAVIGATOR_MINIMAP_PADDING,
): MinimapGraphGeometry | undefined {
	const visibleNodes = layout.nodes.filter((node) => node.hidden !== true);
	const positionedNodes = resolvePositionedNodes(visibleNodes, nodePositions);
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
		if (edge.hidden === true) {
			return [];
		}

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

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(Math.max(value, minimum), maximum);
}
