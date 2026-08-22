import {
	GRAPH_LAYOUT_ROOT_GAP,
	getGraphLayoutSourceId,
	resolveGraphLayoutNodePosition,
	type GraphLayout,
	type GraphLayoutNode,
	type GraphLayoutPosition,
} from './graphLayout';

/** Transition 계산이 입력·출력으로 사용하는 절대 World 좌표 Map이다. */
export type GraphNodePositions = Readonly<Record<string, GraphLayoutPosition>>;

export interface RebaseNodePositionOptions {
	/** 접힌 Node까지 포함하는 Root Instance별 직계 Parent 계층이다. */
	readonly logicalParentByChild?: ReadonlyMap<string, string>;
	/** 다음 Layout과 다른 arrangement snapshot을 명시해야 하는 테스트/전환용 override다. */
	readonly unarrangedNodeIds?: ReadonlySet<string>;
	/** Folder close로 사라지는 arranged descendant의 현재 Local 좌표도 저장한다. */
	readonly captureCollapsedNodePositions?: boolean;
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
 * 모든 하위 Node를 직계 Parent 좌표계에서 다시 계산한다.
 *
 * - arranged + visible: 다음 Layout의 Parent 상대 좌표를 사용한다.
 * - unarranged: 이전 Parent 상대 좌표를 유지한다.
 * - collapsed: 표시 여부와 무관하게 이전 Parent 상대 좌표를 유지한다.
 * - Root: unarranged일 때만 이전 절대 World 좌표를 유지한다.
 *
 * nodePositions는 마지막 절대 좌표 snapshot일 뿐 독립 이동 여부를 뜻하지 않는다.
 * 독립 좌표 보존 여부는 오직 unarrangedNodeIds로 결정한다.
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
	const nextParentByChild = indexParents(nextLayout);
	const parentByChild = new Map(previousParentByChild);

	for (const [nodeId, parentId] of options.logicalParentByChild ?? []) {
		parentByChild.set(nodeId, parentId);
	}
	// 표시 구조의 synthetic Backlink/File Group Parent가 논리 계층보다 우선한다.
	for (const [nodeId, parentId] of nextParentByChild) {
		parentByChild.set(nodeId, parentId);
	}

	const unarrangedNodeIds = options.unarrangedNodeIds
		?? nextLayout.unarrangedNodeIds;
	const candidateNodeIds = new Set([
		...previousNodesById.keys(),
		...nextNodesById.keys(),
		...Object.keys(nodePositions),
		...parentByChild.keys(),
		...parentByChild.values(),
	]);
	const nextPositions = new Map<string, GraphLayoutPosition>();
	const resolvingNodeIds = new Set<string>();
	const resolvePreviousPosition = (
		nodeId: string,
	): GraphLayoutPosition | undefined => (
		nodePositions[nodeId] ?? previousNodesById.get(nodeId)?.position
	);
	const resolveNextPosition = (
		nodeId: string,
	): GraphLayoutPosition | undefined => {
		const resolvedPosition = nextPositions.get(nodeId);

		if (resolvedPosition) {
			return resolvedPosition;
		}
		if (resolvingNodeIds.has(nodeId)) {
			return undefined;
		}
		resolvingNodeIds.add(nodeId);
		const previousPosition = resolvePreviousPosition(nodeId);
		const nextNode = nextNodesById.get(nodeId);
		const parentId = parentByChild.get(nodeId);
		let nextPosition: GraphLayoutPosition | undefined;

		if (!parentId) {
			nextPosition = unarrangedNodeIds.has(nodeId) && previousPosition
				? previousPosition
				: nextNode?.position ?? previousPosition;
		} else {
			const nextParentPosition = resolveNextPosition(parentId);
			const nextParent = nextNodesById.get(parentId);
			const previousParentPosition = resolvePreviousPosition(parentId);

			if (
				nextNode
				&& nextParent
				&& nextParentPosition
				&& !unarrangedNodeIds.has(nodeId)
			) {
				// 정렬 Node는 Parent가 이동했더라도 다음 Layout의 Local 좌표만 사용한다.
				nextPosition = {
					x: nextParentPosition.x
						+ nextNode.position.x - nextParent.position.x,
					y: nextParentPosition.y
						+ nextNode.position.y - nextParent.position.y,
				};
			} else if (
				previousPosition
				&& previousParentPosition
				&& nextParentPosition
			) {
				// 비정렬 또는 접힌 Node는 직계 Parent에 대한 기존 Local 좌표를 보존한다.
				nextPosition = {
					x: nextParentPosition.x
						+ previousPosition.x - previousParentPosition.x,
					y: nextParentPosition.y
						+ previousPosition.y - previousParentPosition.y,
				};
			} else if (nextNode && nextParent && nextParentPosition) {
				nextPosition = {
					x: nextParentPosition.x
						+ nextNode.position.x - nextParent.position.x,
					y: nextParentPosition.y
						+ nextNode.position.y - nextParent.position.y,
				};
			} else {
				nextPosition = nextNode?.position ?? previousPosition;
			}
		}

		resolvingNodeIds.delete(nodeId);
		if (nextPosition) {
			nextPositions.set(nodeId, nextPosition);
		}
		return nextPosition;
	};

	for (const nodeId of candidateNodeIds) {
		const nextPosition = resolveNextPosition(nodeId);
		const nextNode = nextNodesById.get(nodeId);

		if (!nextPosition) {
			continue;
		}
		if (nextNode) {
			if (
				unarrangedNodeIds.has(nodeId)
				|| !hasSameOffset(nextPosition, nextNode.position)
			) {
				rebasedPositions[nodeId] = nextPosition;
			} else {
				delete rebasedPositions[nodeId];
			}
		} else if (
			parentByChild.has(nodeId)
			&& (
				nodePositions[nodeId]
				|| (
					options.captureCollapsedNodePositions === true
					&& previousNodesById.has(nodeId)
				)
			)
		) {
			// 닫히는 순간 자동 Node도 저장하여 이후 직계 Parent chain을 잃지 않는다.
			rebasedPositions[nodeId] = nextPosition;
		}
	}

	return rebasedPositions;
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
 * 선택한 Detached Root의 현재 표시 subtree 바로 아래에 같은 X로 새 Root 위치를 잡는다.
 * Root 간격은 기본 Layout과 같은 값을 사용하며 absolute Action UI는 bounds에 포함하지 않는다.
 */
export function calculateDetachedRootDuplicatePosition(
	layout: GraphLayout,
	nodePositions: GraphNodePositions,
	rootNodeId: string,
): GraphLayoutPosition | undefined {
	const nodesById = indexNodes(layout);
	const rootNode = nodesById.get(rootNodeId);

	if (!rootNode || !layout.rootNodeIds.has(rootNodeId)) {
		return undefined;
	}

	const rootPosition = resolveGraphLayoutNodePosition(rootNode, nodePositions);
	let subtreeBottom = rootPosition.y + rootNode.height;

	for (const nodeId of collectGraphLayoutSubtreeNodeIds(layout, rootNodeId)) {
		const node = nodesById.get(nodeId);

		if (!node || node.hidden === true) {
			continue;
		}

		const position = resolveGraphLayoutNodePosition(node, nodePositions);

		subtreeBottom = Math.max(subtreeBottom, position.y + node.height);
	}

	return {
		x: rootPosition.x,
		y: subtreeBottom + GRAPH_LAYOUT_ROOT_GAP,
	};
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

function copyNodePositions(
	nodePositions: GraphNodePositions,
): Record<string, GraphLayoutPosition> {
	return Object.fromEntries(Object.entries(nodePositions).map(([nodeId, position]) => [
		nodeId,
		{ ...position },
	]));
}
