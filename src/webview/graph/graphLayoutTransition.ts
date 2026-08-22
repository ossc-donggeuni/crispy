import {
	getGraphLayoutSourceId,
	resolveGraphLayoutNodePosition,
	type GraphLayout,
	type GraphLayoutNode,
	type GraphLayoutPosition,
} from './graphLayout';

/** Transition 계산이 입력·출력으로 사용하는 절대 World 좌표 Map이다. */
export type GraphNodePositions = Readonly<Record<string, GraphLayoutPosition>>;

export interface RebaseNodePositionOptions {
	/** 새로 나타난 descendant가 가장 가까운 저장 Ancestor의 수동 offset을 상속한다. */
	readonly inheritAncestorOffsets?: boolean;
	/** 자신의 절대 위치를 고정하고 descendant에는 내부 Layout 변화만 적용할 Root다. */
	readonly stationaryRootNodeIds?: ReadonlySet<string>;
	/** Layout에서 접힌 Node도 가장 가까운 표시 Ancestor의 이동량을 따르게 하는 전체 계층이다. */
	readonly logicalParentByChild?: ReadonlyMap<string, string>;
}

export interface TranslateDetachedSubtreeOptions {
	/** Detach subtree 좌표를 덮어쓰기 전에 보존할 다음 Layout 기준 위치다. */
	readonly baseNodePositions?: GraphNodePositions;
}

/** Layout flow에 남는 Node와 독립 위치로 꺼낸 Node를 분리한 결과다. */
export interface GraphLayoutNodeArrangement {
	readonly arrangedNodeIds: ReadonlySet<string>;
	readonly unarrangedNodeIds: ReadonlySet<string>;
}

const GRAPH_LAYOUT_OFFSET_EPSILON = 1e-6;

/**
 * 저장된 수동 offset을 Parent offset과 비교해 직접 꺼낸 Node만 찾는다.
 * Parent를 따라 같은 Delta로 이동한 descendant는 새 unarranged Root로 보지 않는다.
 */
export function classifyGraphLayoutNodeArrangement(
	layout: GraphLayout,
	nodePositions: GraphNodePositions,
): GraphLayoutNodeArrangement {
	const nodesById = indexNodes(layout);
	const parentByChild = new Map(
		layout.edges.map((edge) => [edge.targetId, edge.sourceId]),
	);
	const offsets = new Map<string, GraphLayoutPosition>();

	for (const [nodeId, position] of Object.entries(nodePositions)) {
		const node = nodesById.get(nodeId);

		if (!node) {
			continue;
		}

		const offset = {
			x: position.x - node.position.x,
			y: position.y - node.position.y,
		};

		if (!isZeroOffset(offset)) {
			offsets.set(nodeId, offset);
		}
	}

	const unarrangedNodeIds = new Set<string>();

	for (const [nodeId, offset] of offsets) {
		const parentOffset = offsets.get(parentByChild.get(nodeId) ?? '');

		if (
			!parentOffset
			|| !hasSameOffset(parentOffset, offset)
		) {
			unarrangedNodeIds.add(nodeId);
		}
	}

	return {
		arrangedNodeIds: new Set(
			layout.nodes
				.map((node) => node.id)
				.filter((nodeId) => !unarrangedNodeIds.has(nodeId)),
		),
		unarrangedNodeIds,
	};
}

function isZeroOffset(offset: GraphLayoutPosition): boolean {
	return Math.abs(offset.x) <= GRAPH_LAYOUT_OFFSET_EPSILON
		&& Math.abs(offset.y) <= GRAPH_LAYOUT_OFFSET_EPSILON;
}

function hasSameOffset(
	left: GraphLayoutPosition,
	right: GraphLayoutPosition,
): boolean {
	return Math.abs(left.x - right.x) <= GRAPH_LAYOUT_OFFSET_EPSILON
		&& Math.abs(left.y - right.y) <= GRAPH_LAYOUT_OFFSET_EPSILON;
}

/**
 * 수동 위치를 이전 Layout 기본점에 대한 Offset으로 해석해 다음 Layout에 다시 적용한다.
 * 양쪽 Layout에 존재하지 않는 저장 위치는 원본 그대로 보존한다.
 */
export function rebaseNodePositions(
	previousLayout: GraphLayout,
	nextLayout: GraphLayout,
	nodePositions: GraphNodePositions,
	options: RebaseNodePositionOptions = {},
): Record<string, GraphLayoutPosition> {
	const rebasedPositions = copyNodePositions(nodePositions);
	const previousNodesById = indexNodes(previousLayout);
	const nextNodesById = indexNodes(nextLayout);
	const previousParentByChild = indexParents(previousLayout);

	for (const [nodeId, savedPosition] of Object.entries(nodePositions)) {
		const previousNode = previousNodesById.get(nodeId);
		const nextNode = nextNodesById.get(nodeId);

		if (!previousNode || !nextNode) {
			continue;
		}

		const stationaryRootId = findNearestAncestorInSet(
			nodeId,
			previousParentByChild,
			options.stationaryRootNodeIds,
		);
		const previousStationaryRoot = stationaryRootId
			? previousNodesById.get(stationaryRootId)
			: undefined;
		const nextStationaryRoot = stationaryRootId
			? nextNodesById.get(stationaryRootId)
			: undefined;
		const stationaryRootDelta = previousStationaryRoot && nextStationaryRoot
			? {
				x: nextStationaryRoot.position.x - previousStationaryRoot.position.x,
				y: nextStationaryRoot.position.y - previousStationaryRoot.position.y,
			}
			: { x: 0, y: 0 };

		rebasedPositions[nodeId] = {
			x: nextNode.position.x
				+ savedPosition.x
				- previousNode.position.x
				- stationaryRootDelta.x,
			y: nextNode.position.y
				+ savedPosition.y
				- previousNode.position.y
				- stationaryRootDelta.y,
		};
	}

	rebaseCollapsedNodePositions(
		previousLayout,
		nextLayout,
		nodePositions,
		rebasedPositions,
		options.logicalParentByChild,
	);

	if (options.inheritAncestorOffsets) {
		inheritAncestorPositionOffsets(nextLayout, rebasedPositions);
	}

	return rebasedPositions;
}

/** Layout에 없는 저장 Node를 가장 가까운 표시 Ancestor의 실제 이동량만큼 옮긴다. */
function rebaseCollapsedNodePositions(
	previousLayout: GraphLayout,
	nextLayout: GraphLayout,
	nodePositions: GraphNodePositions,
	rebasedPositions: Record<string, GraphLayoutPosition>,
	logicalParentByChild: ReadonlyMap<string, string> | undefined,
): void {
	if (!logicalParentByChild || logicalParentByChild.size === 0) {
		return;
	}
	const previousNodesById = indexNodes(previousLayout);
	const nextNodesById = indexNodes(nextLayout);

	for (const [nodeId, savedPosition] of Object.entries(nodePositions)) {
		if (previousNodesById.has(nodeId) && nextNodesById.has(nodeId)) {
			continue;
		}
		let ancestorId = logicalParentByChild.get(nodeId);

		while (ancestorId) {
			const previousAncestor = previousNodesById.get(ancestorId);
			const nextAncestor = nextNodesById.get(ancestorId);

			if (previousAncestor && nextAncestor) {
				const previousPosition = resolveGraphLayoutNodePosition(
					previousAncestor,
					nodePositions,
				);
				const nextPosition = resolveGraphLayoutNodePosition(
					nextAncestor,
					rebasedPositions,
				);

				rebasedPositions[nodeId] = {
					x: savedPosition.x + nextPosition.x - previousPosition.x,
					y: savedPosition.y + nextPosition.y - previousPosition.y,
				};
				break;
			}

			ancestorId = logicalParentByChild.get(ancestorId);
		}
	}
}

/**
 * Detach 직전 실제 위치에서 Drop 위치까지의 Delta를 현재 Layout subtree 전체에 적용한다.
 * Grouped File Row는 Layout Node가 아니므로 이를 소유한 File Group Card 이동에 포함된다.
 */
export function translateDetachedSubtree(
	previousLayout: GraphLayout,
	nextLayout: GraphLayout,
	nodePositions: GraphNodePositions,
	rootNodeId: string,
	targetPosition: GraphLayoutPosition,
	options: TranslateDetachedSubtreeOptions = {},
): Record<string, GraphLayoutPosition> {
	const translatedPositions = copyNodePositions(
		options.baseNodePositions ?? nodePositions,
	);
	const previousNodesById = indexNodes(previousLayout);
	const nextNodesById = indexNodes(nextLayout);
	const previousRoot = previousNodesById.get(rootNodeId);
	const nextRoot = nextNodesById.get(rootNodeId);

	if (!nextRoot) {
		return translatedPositions;
	}

	if (!previousRoot) {
		const previousSourceRoot = previousNodesById.get(
			getGraphLayoutSourceId(rootNodeId),
		);

		if (previousSourceRoot) {
			const actualSourceRootPosition = resolveGraphLayoutNodePosition(
				previousSourceRoot,
				nodePositions,
			);
			const sourceDelta = {
				x: targetPosition.x - actualSourceRootPosition.x,
				y: targetPosition.y - actualSourceRootPosition.y,
			};

			for (const nodeId of collectGraphLayoutSubtreeNodeIds(
				nextLayout,
				rootNodeId,
			)) {
				const nextNode = nextNodesById.get(nodeId);
				const previousSourceNode = nextNode
					? previousNodesById.get(getGraphLayoutSourceId(nextNode.id))
					: undefined;

				if (!nextNode || !previousSourceNode) {
					continue;
				}

				const previousPosition = resolveGraphLayoutNodePosition(
					previousSourceNode,
					nodePositions,
				);

				delete translatedPositions[previousSourceNode.id];
				translatedPositions[nodeId] = {
					x: previousPosition.x + sourceDelta.x,
					y: previousPosition.y + sourceDelta.y,
				};
			}

			return translatedPositions;
		}

		for (const nodeId of collectGraphLayoutSubtreeNodeIds(
			nextLayout,
			rootNodeId,
		)) {
			const nextNode = nextNodesById.get(nodeId);

			if (!nextNode) {
				continue;
			}

			translatedPositions[nodeId] = {
				x: targetPosition.x + nextNode.position.x - nextRoot.position.x,
				y: targetPosition.y + nextNode.position.y - nextRoot.position.y,
			};
		}

		return translatedPositions;
	}

	const actualRootPosition = resolveGraphLayoutNodePosition(
		previousRoot,
		nodePositions,
	);
	const delta = {
		x: targetPosition.x - actualRootPosition.x,
		y: targetPosition.y - actualRootPosition.y,
	};

	for (const nodeId of collectGraphLayoutSubtreeNodeIds(
		previousLayout,
		rootNodeId,
	)) {
		const previousNode = previousNodesById.get(nodeId);

		if (!previousNode || !nextNodesById.has(nodeId)) {
			continue;
		}

		const actualPosition = resolveGraphLayoutNodePosition(
			previousNode,
			nodePositions,
		);

		translatedPositions[nodeId] = {
			x: actualPosition.x + delta.x,
			y: actualPosition.y + delta.y,
		};
	}

	return translatedPositions;
}

/**
 * Detached subtree의 공통 Translation을 제거하고 각 Child의 독립 수동 Offset만
 * Reattach 이후 Layout 기본 위치에 다시 적용한다. Root override는 항상 제거한다.
 */
export function rebaseReattachedSubtree(
	previousLayout: GraphLayout,
	nextLayout: GraphLayout,
	nodePositions: GraphNodePositions,
	rootNodeId: string,
): Record<string, GraphLayoutPosition> {
	const rebasedPositions = copyNodePositions(nodePositions);
	const previousNodesById = indexNodes(previousLayout);
	const nextNodesById = indexNodes(nextLayout);
	const previousRoot = previousNodesById.get(rootNodeId);

	const previousSubtreeNodeIds = collectGraphLayoutSubtreeNodeIds(
		previousLayout,
		rootNodeId,
	);

	delete rebasedPositions[rootNodeId];

	if (!previousRoot || !nextNodesById.has(rootNodeId)) {
		for (const nodeId of previousSubtreeNodeIds) {
			delete rebasedPositions[nodeId];
		}

		return rebasedPositions;
	}

	const actualRootPosition = resolveGraphLayoutNodePosition(
		previousRoot,
		nodePositions,
	);
	const rootTranslation = {
		x: actualRootPosition.x - previousRoot.position.x,
		y: actualRootPosition.y - previousRoot.position.y,
	};

	for (const nodeId of previousSubtreeNodeIds) {
		if (nodeId === rootNodeId) {
			continue;
		}

		const savedPosition = nodePositions[nodeId];
		const previousNode = previousNodesById.get(nodeId);
		const nextNode = nextNodesById.get(nodeId);

		if (!savedPosition || !previousNode || !nextNode) {
			continue;
		}

		const manualOffset = {
			x: savedPosition.x - previousNode.position.x - rootTranslation.x,
			y: savedPosition.y - previousNode.position.y - rootTranslation.y,
		};

		if (manualOffset.x === 0 && manualOffset.y === 0) {
			delete rebasedPositions[nodeId];
			continue;
		}

		rebasedPositions[nodeId] = {
			x: nextNode.position.x + manualOffset.x,
			y: nextNode.position.y + manualOffset.y,
		};
	}

	return rebasedPositions;
}

/**
 * 비정렬 subtree를 기존 Parent의 자동 flow에 다시 넣는다.
 * 독립 Drag translation은 제거하되, 수동 이동된 Parent/Ancestor의 공통 translation은
 * 다시 더해 실제 화면상의 Parent subtree 안에 배치한다.
 */
export function rebaseArrangedSubtree(
	previousLayout: GraphLayout,
	nextLayout: GraphLayout,
	nodePositions: GraphNodePositions,
	rebasedNodePositions: GraphNodePositions,
	rootNodeId: string,
): Record<string, GraphLayoutPosition> {
	const arrangedPositions = rebaseReattachedSubtree(
		previousLayout,
		nextLayout,
		nodePositions,
		rootNodeId,
	);
	const nextNodesById = indexNodes(nextLayout);
	const nextParentByChild = indexParents(nextLayout);
	const parentId = nextParentByChild.get(rootNodeId);
	const parent = parentId ? nextNodesById.get(parentId) : undefined;

	if (!parentId || !parent || !nextNodesById.has(rootNodeId)) {
		return arrangedPositions;
	}

	const actualParentPosition = resolvePositionWithAncestorOffset(
		nextLayout,
		parentId,
		rebasedNodePositions,
	);
	const parentTranslation = {
		x: actualParentPosition.x - parent.position.x,
		y: actualParentPosition.y - parent.position.y,
	};

	if (isZeroOffset(parentTranslation)) {
		return arrangedPositions;
	}

	for (const nodeId of collectGraphLayoutSubtreeNodeIds(
		nextLayout,
		rootNodeId,
	)) {
		const node = nextNodesById.get(nodeId);

		if (!node) {
			continue;
		}

		const basePosition = arrangedPositions[nodeId] ?? node.position;

		arrangedPositions[nodeId] = {
			x: basePosition.x + parentTranslation.x,
			y: basePosition.y + parentTranslation.y,
		};
	}

	return arrangedPositions;
}

/** Parent → Child Edge만 따라 Root 자신과 현재 Layout subtree ID를 수집한다. */
export function collectGraphLayoutSubtreeNodeIds(
	layout: GraphLayout,
	rootNodeId: string,
): ReadonlySet<string> {
	const childrenByParent = new Map<string, string[]>();

	for (const edge of layout.edges) {
		const children = childrenByParent.get(edge.sourceId) ?? [];

		children.push(edge.targetId);
		childrenByParent.set(edge.sourceId, children);
	}

	const nodeIds = new Set<string>();
	const pending = [rootNodeId];

	while (pending.length > 0) {
		const nodeId = pending.pop();

		if (!nodeId || nodeIds.has(nodeId)) {
			continue;
		}

		nodeIds.add(nodeId);
		pending.push(...(childrenByParent.get(nodeId) ?? []));
	}

	return nodeIds;
}

function indexNodes(layout: GraphLayout): ReadonlyMap<string, GraphLayoutNode> {
	return new Map(layout.nodes.map((node) => [node.id, node]));
}

function indexParents(layout: GraphLayout): ReadonlyMap<string, string> {
	return new Map(layout.edges.map((edge) => [edge.targetId, edge.sourceId]));
}

function findNearestAncestorInSet(
	nodeId: string,
	parentByChild: ReadonlyMap<string, string>,
	nodeIds: ReadonlySet<string> | undefined,
): string | undefined {
	if (!nodeIds || nodeIds.size === 0) {
		return undefined;
	}

	let candidateId: string | undefined = nodeId;

	while (candidateId) {
		if (nodeIds.has(candidateId)) {
			return candidateId;
		}

		candidateId = parentByChild.get(candidateId);
	}

	return undefined;
}

/** 직접 저장값이 없으면 가장 가까운 저장 Ancestor의 공통 offset을 상속한다. */
function resolvePositionWithAncestorOffset(
	layout: GraphLayout,
	nodeId: string,
	nodePositions: GraphNodePositions,
): GraphLayoutPosition {
	const nodesById = indexNodes(layout);
	const parentByChild = indexParents(layout);
	const node = nodesById.get(nodeId);

	if (!node) {
		return { x: 0, y: 0 };
	}

	const directPosition = nodePositions[nodeId];

	if (directPosition) {
		return directPosition;
	}

	let ancestorId = parentByChild.get(nodeId);

	while (ancestorId) {
		const ancestor = nodesById.get(ancestorId);
		const ancestorPosition = nodePositions[ancestorId];

		if (ancestor && ancestorPosition) {
			return {
				x: node.position.x + ancestorPosition.x - ancestor.position.x,
				y: node.position.y + ancestorPosition.y - ancestor.position.y,
			};
		}

		ancestorId = parentByChild.get(ancestorId);
	}

	return node.position;
}

function copyNodePositions(
	nodePositions: GraphNodePositions,
): Record<string, GraphLayoutPosition> {
	return Object.fromEntries(Object.entries(nodePositions).map(([nodeId, position]) => [
		nodeId,
		{ ...position },
	]));
}

/** 저장 위치가 없는 새 descendant에 가장 가까운 이동된 Ancestor offset을 적용한다. */
function inheritAncestorPositionOffsets(
	layout: GraphLayout,
	nodePositions: Record<string, GraphLayoutPosition>,
): void {
	const nodesById = indexNodes(layout);
	const parentByChild = new Map(
		layout.edges.map((edge) => [edge.targetId, edge.sourceId]),
	);

	for (const node of layout.nodes) {
		if (nodePositions[node.id]) {
			continue;
		}

		let ancestorId = parentByChild.get(node.id);

		while (ancestorId) {
			const ancestor = nodesById.get(ancestorId);
			const ancestorPosition = nodePositions[ancestorId];

			if (ancestor && ancestorPosition) {
				const offset = {
					x: ancestorPosition.x - ancestor.position.x,
					y: ancestorPosition.y - ancestor.position.y,
				};

				if (offset.x !== 0 || offset.y !== 0) {
					nodePositions[node.id] = {
						x: node.position.x + offset.x,
						y: node.position.y + offset.y,
					};
				}
				break;
			}

			ancestorId = parentByChild.get(ancestorId);
		}
	}
}
