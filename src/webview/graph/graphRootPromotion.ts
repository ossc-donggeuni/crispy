import {
	type Graph,
	type GraphRoot,
	type GraphRootNode,
} from './graphModel';

/** 원본 Tree에서 찾은 Node와 현재 소속 Graph Root 및 상대 경로다. */
export interface GraphNodeLocation {
	readonly node: GraphRootNode;
	readonly root: GraphRoot;
	readonly relativePath: string;
}

/** Promotion 결과에 새 Graph snapshot과 추가된 Root를 함께 제공한다. */
export interface GraphRootAddition {
	readonly graph: Graph;
	readonly root: GraphRoot;
}

/** Promotion Root ID를 Node ID에서 결정적으로 생성한다. */
export function createPromotedGraphRootId(nodeId: string): string {
	return `root:promoted:${encodeURIComponent(nodeId)}`;
}

/** Folder Backlink Layout ID를 실제 Node/Root ID와 충돌하지 않게 생성한다. */
export function createFolderBacklinkId(targetRootId: string): string {
	return `folder-backlink:${encodeURIComponent(targetRootId)}`;
}

/** Singleton File Backlink Group ID를 실제 File Root ID와 충돌하지 않게 생성한다. */
export function createFileBacklinkGroupId(targetRootId: string): string {
	return `file-backlink-group:${encodeURIComponent(targetRootId)}`;
}

/**
 * 현재 Graph Root 경계를 존중하며 Node를 원본 Tree 관계로 찾는다.
 * 다른 Root로 승격된 subtree는 원래 Root 소속이 아니므로 순회를 중단한다.
 */
export function findGraphNode(
	graph: Graph,
	nodeId: string,
): GraphNodeLocation | undefined {
	const rootsByNodeId = new Map(
		graph.roots.map((root) => [root.nodeId, root]),
	);

	for (const root of graph.roots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			continue;
		}

		const result = findNodeInRoot(
			rootNode,
			nodeId,
			root,
			rootsByNodeId,
			[],
			true,
		);

		if (result) {
			return result;
		}
	}

	return undefined;
}

/**
 * Folder/File을 새 Root로 추가한 immutable Graph snapshot을 만든다.
 * Project, 기존 Root, 존재하지 않는 Node는 변경하지 않는다.
 */
export function addGraphRoot(
	graph: Graph,
	nodeId: string,
): GraphRootAddition | undefined {
	if (graph.roots.some((root) => root.nodeId === nodeId)) {
		return undefined;
	}

	const location = findGraphNode(graph, nodeId);

	if (!location || location.node.kind === 'project') {
		return undefined;
	}

	const root: GraphRoot = {
		id: createPromotedGraphRootId(nodeId),
		nodeId,
		context: {
			relativePath: location.relativePath,
		},
	};

	if (graph.roots.some((candidate) => candidate.id === root.id)) {
		return undefined;
	}

	return {
		root,
		graph: {
			roots: [...graph.roots, root],
			rootNodes: {
				...graph.rootNodes,
				[nodeId]: location.node,
			},
		},
	};
}

/** 향후 Reattach가 재사용할 수 있도록 Root 하나를 immutable하게 제거한다. */
export function removeGraphRoot(graph: Graph, rootId: string): Graph {
	const root = graph.roots.find((candidate) => candidate.id === rootId);

	if (!root) {
		return graph;
	}

	const roots = graph.roots.filter((candidate) => candidate.id !== rootId);
	const rootNodes = { ...graph.rootNodes };

	if (!roots.some((candidate) => candidate.nodeId === root.nodeId)) {
		delete rootNodes[root.nodeId];
	}

	return { roots, rootNodes };
}

/** 한 Root의 실제 Tree를 DFS하며 이름 segment로 상대 경로를 축적한다. */
function findNodeInRoot(
	node: GraphRootNode,
	targetNodeId: string,
	root: GraphRoot,
	rootsByNodeId: ReadonlyMap<string, GraphRoot>,
	pathSegments: readonly string[],
	isRootNode: boolean,
): GraphNodeLocation | undefined {
	if (!isRootNode && rootsByNodeId.has(node.id)) {
		return undefined;
	}

	if (node.id === targetNodeId) {
		return {
			node,
			root,
			relativePath: pathSegments.join('/'),
		};
	}

	if (node.kind === 'file') {
		return undefined;
	}

	for (const child of node.children) {
		const result = findNodeInRoot(
			child,
			targetNodeId,
			root,
			rootsByNodeId,
			[...pathSegments, child.name],
			false,
		);

		if (result) {
			return result;
		}
	}

	return undefined;
}
