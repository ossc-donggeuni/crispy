import type {
	Graph,
	GraphRootNode,
} from './graphModel';
import {
	getDetachedRootOrdinal,
	isDetachedRootId,
} from './graphRootPromotion';

/** Navigator Root Item이 표시할 Graph Root의 최소 표현 데이터다. */
export interface GraphNavigatorRoot {
	readonly rootId: string;
	readonly nodeId: string;
	readonly name: string;
	readonly kind: GraphRootNode['kind'];
	readonly relativePath?: string;
	/** 동일 Source의 Detached Instance가 여러 개일 때 목록 이름에 표시할 순번이다. */
	readonly detachedOrdinal?: number;
}

/**
 * Graph Root 순서를 유지하며 Navigator 표시 데이터로 projection한다.
 * 참조하는 Root Node가 없는 항목만 건너뛰고 입력 Graph는 변경하지 않는다.
 */
export function createGraphNavigatorRoots(
	graph: Graph,
): readonly GraphNavigatorRoot[] {
	const navigatorRoots: GraphNavigatorRoot[] = [];
	const detachedCountByNodeId = new Map<string, number>();

	for (const root of graph.roots) {
		if (!isDetachedRootId(root.id)) {
			continue;
		}
		detachedCountByNodeId.set(
			root.nodeId,
			(detachedCountByNodeId.get(root.nodeId) ?? 0) + 1,
		);
	}

	for (const root of graph.roots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			continue;
		}

		const detachedInstanceCount = detachedCountByNodeId.get(root.nodeId) ?? 0;
		const detachedOrdinal = getDetachedRootOrdinal(root.id);
		const navigatorRoot: GraphNavigatorRoot = {
			rootId: root.id,
			nodeId: root.nodeId,
			name: rootNode.name,
			kind: rootNode.kind,
			...(detachedInstanceCount >= 2 && detachedOrdinal !== undefined
				? { detachedOrdinal }
				: {}),
		};

		navigatorRoots.push(root.context
			? {
				...navigatorRoot,
				relativePath: root.context.relativePath,
			}
			: navigatorRoot);
	}

	return navigatorRoots;
}
