import type {
	Graph,
	GraphRootNode,
} from './graphModel';

/** Navigator Root Item이 표시할 Graph Root의 최소 표현 데이터다. */
export interface GraphNavigatorRoot {
	readonly rootId: string;
	readonly nodeId: string;
	readonly name: string;
	readonly kind: GraphRootNode['kind'];
	readonly relativePath?: string;
}

/**
 * Graph Root 순서를 유지하며 Navigator 표시 데이터로 projection한다.
 * 참조하는 Root Node가 없는 항목만 건너뛰고 입력 Graph는 변경하지 않는다.
 */
export function createGraphNavigatorRoots(
	graph: Graph,
): readonly GraphNavigatorRoot[] {
	const navigatorRoots: GraphNavigatorRoot[] = [];

	for (const root of graph.roots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			continue;
		}

		const navigatorRoot: GraphNavigatorRoot = {
			rootId: root.id,
			nodeId: root.nodeId,
			name: rootNode.name,
			kind: rootNode.kind,
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
