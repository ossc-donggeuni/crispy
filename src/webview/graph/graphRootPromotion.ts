import {
	type Graph,
	type GraphRoot,
	type GraphRootNode,
} from './graphModel';

/** 원본 Tree에서 찾은 Node와 현재 소속 Graph Root 및 상대 경로다. */
export interface GraphNodeLocation {
	readonly node: GraphRootNode;
	readonly root: GraphRoot;
	/** Source Root부터 대상 Node 자신까지의 기존 상대 경로다. */
	readonly relativePath: string;
	/** 실제 Tree 순회에서 얻은 대상 Node의 Parent name segment다. */
	readonly parentPathSegments: readonly string[];
}

/** Promotion 결과에 새 Graph snapshot과 추가된 Root를 함께 제공한다. */
export interface GraphRootAddition {
	readonly graph: Graph;
	readonly root: GraphRoot;
}

const DETACHED_ROOT_ID_DELIMITER = '::detached:';
const DETACHED_ROOT_ORIGIN_DELIMITER = '::detached-from:';

/** Source Node ID와 순번으로 Detached Root의 Visual Instance ID를 만든다. */
export function createDetachedRootId(
	nodeId: string,
	ordinal: number,
	originRootId?: string,
): string {
	if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
		throw new Error(`Detached Root 순번은 1 이상의 정수여야 합니다: ${ordinal}`);
	}

	const originScope = originRootId
		? `${DETACHED_ROOT_ORIGIN_DELIMITER}${encodeURIComponent(originRootId)}`
		: '';

	return `${nodeId}${originScope}${DETACHED_ROOT_ID_DELIMITER}${ordinal}`;
}

/** Detached Root ID suffix의 양의 정수 순번을 반환한다. */
export function getDetachedRootOrdinal(rootId: string): number | undefined {
	const delimiterIndex = rootId.lastIndexOf(DETACHED_ROOT_ID_DELIMITER);

	if (delimiterIndex < 0) {
		return undefined;
	}

	const ordinalText = rootId.slice(
		delimiterIndex + DETACHED_ROOT_ID_DELIMITER.length,
	);

	if (!/^[1-9]\d*$/.test(ordinalText)) {
		return undefined;
	}

	const ordinal = Number(ordinalText);

	return Number.isSafeInteger(ordinal) ? ordinal : undefined;
}

/** ID가 순번 suffix를 가진 Detached Root ID인지 판별한다. */
export function isDetachedRootId(rootId: string): boolean {
	return getDetachedRootOrdinal(rootId) !== undefined;
}

/** Detached Root ID에서 원본 Workspace Node ID를 복원한다. */
export function getDetachedRootNodeId(rootId: string): string | undefined {
	if (!isDetachedRootId(rootId)) {
		return undefined;
	}

	const instancePrefix = rootId.slice(
		0,
		rootId.lastIndexOf(DETACHED_ROOT_ID_DELIMITER),
	);
	const originIndex = instancePrefix.lastIndexOf(
		DETACHED_ROOT_ORIGIN_DELIMITER,
	);

	return originIndex < 0
		? instancePrefix
		: instancePrefix.slice(0, originIndex);
}

/** Detached Root가 분리된 원래 Graph Root Instance를 ID suffix에서 복원한다. */
export function getDetachedRootOriginId(rootId: string): string | undefined {
	if (!isDetachedRootId(rootId)) {
		return undefined;
	}

	const instancePrefix = rootId.slice(
		0,
		rootId.lastIndexOf(DETACHED_ROOT_ID_DELIMITER),
	);
	const originIndex = instancePrefix.lastIndexOf(
		DETACHED_ROOT_ORIGIN_DELIMITER,
	);

	if (originIndex < 0) {
		return undefined;
	}

	try {
		return decodeURIComponent(instancePrefix.slice(
			originIndex + DETACHED_ROOT_ORIGIN_DELIMITER.length,
		));
	} catch {
		return undefined;
	}
}

/** 현재 같은 Source Node를 참조하는 Root의 최고 순번 다음 값을 계산한다. */
export function getNextDetachedRootOrdinal(
	graph: Graph,
	nodeId: string,
): number {
	let highestOrdinal = 0;

	for (const root of graph.roots) {
		if (root.nodeId !== nodeId) {
			continue;
		}

		highestOrdinal = Math.max(
			highestOrdinal,
			getDetachedRootOrdinal(root.id) ?? 0,
		);
	}

	return highestOrdinal + 1;
}

/** @deprecated 새 Detached ID 규약에서는 첫 번째 순번 ID를 반환한다. */
export function createPromotedGraphRootId(nodeId: string): string {
	return createDetachedRootId(nodeId, 1);
}

/** Folder Backlink Layout ID를 Source Node ID에서 안정적으로 생성한다. */
export function createFolderBacklinkId(nodeId: string): string {
	const sourceNodeId = getDetachedRootNodeId(nodeId) ?? nodeId;

	return `folder-backlink:${encodeURIComponent(sourceNodeId)}`;
}

/** Singleton File Backlink Group ID를 Source Node ID에서 안정적으로 생성한다. */
export function createFileBacklinkGroupId(nodeId: string): string {
	const sourceNodeId = getDetachedRootNodeId(nodeId) ?? nodeId;

	return `file-backlink-group:${encodeURIComponent(sourceNodeId)}`;
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
	originRootId?: string,
): GraphRootAddition | undefined {
	return addGraphRootWithOrdinal(
		graph,
		nodeId,
		getNextDetachedRootOrdinal(graph, nodeId),
		originRootId,
	);
}

/** 지정 순번으로 Root를 추가하며 persistence 복원에서도 같은 검증을 공유한다. */
function addGraphRootWithOrdinal(
	graph: Graph,
	nodeId: string,
	ordinal: number,
	originRootId?: string,
): GraphRootAddition | undefined {
	const existingSourceRoot = graph.roots.find(
		(root) => root.nodeId === nodeId && isDetachedRootId(root.id),
	);
	const location = existingSourceRoot
		? undefined
		: findGraphNode(graph, nodeId);
	const node = existingSourceRoot
		? graph.rootNodes[nodeId]
		: location?.node;

	if (!node || node.kind === 'project') {
		return undefined;
	}
	const sourceRootNode = location
		? graph.rootNodes[location.root.nodeId]
		: undefined;

	if (!existingSourceRoot && (!location || !sourceRootNode)) {
		return undefined;
	}
	const context = existingSourceRoot?.context
		?? (location && sourceRootNode ? {
			relativePath: createRootContextRelativePath(
				location.root,
				sourceRootNode,
				location.parentPathSegments,
			),
		} : undefined);

	const root: GraphRoot = {
		id: createDetachedRootId(nodeId, ordinal, originRootId),
		nodeId,
		...(context ? { context } : {}),
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
				[nodeId]: node,
			},
		},
	};
}

/**
 * 저장된 Detached Root Node ID를 현재 Graph에 순서대로 다시 적용한다.
 * 이미 Root이거나 현재 Graph에 없는 Node는 상태를 정리하지 않고 건너뛴다.
 */
export function applyDetachedGraphRoots(
	graph: Graph,
	detachedRootNodeIds: Readonly<Record<string, true>>,
): Graph {
	let currentGraph = graph;

	for (const persistedId of Object.keys(detachedRootNodeIds)) {
		const nodeId = getDetachedRootNodeId(persistedId) ?? persistedId;
		const alreadyApplied = isDetachedRootId(persistedId)
			? currentGraph.roots.some((root) => root.id === persistedId)
			: currentGraph.roots.some((root) => (
				root.nodeId === nodeId && isDetachedRootId(root.id)
			));

		if (alreadyApplied) {
			continue;
		}

		const ordinal = getDetachedRootOrdinal(persistedId)
			?? getNextDetachedRootOrdinal(currentGraph, nodeId);
		const addition = addGraphRootWithOrdinal(
			currentGraph,
			nodeId,
			ordinal,
			getDetachedRootOriginId(persistedId),
		);

		if (addition) {
			currentGraph = addition.graph;
		}
	}

	return currentGraph;
}

/**
 * Source Root의 기존 Context, Source Root 이름과 실제 Tree Parent segment를 잇는다.
 * 새 대상 Node 자신의 이름은 제외하고 비어 있지 않으면 `/`로 끝낸다.
 */
export function createRootContextRelativePath(
	sourceRoot: GraphRoot,
	sourceRootNode: GraphRootNode,
	parentPathSegments: readonly string[],
): string {
	const contextSegments = splitPathSegments(
		sourceRoot.context?.relativePath ?? '',
	);
	const parentSegments = [
		...contextSegments,
		sourceRootNode.name,
		...parentPathSegments,
	];

	return parentSegments.length === 0
		? ''
		: `${parentSegments.join('/')}/`;
}

/** 기존 Context의 separator와 trailing slash를 조합 가능한 name segment로 정규화한다. */
function splitPathSegments(path: string): readonly string[] {
	return path.split(/[\\/]+/).filter((segment) => segment.length > 0);
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
			parentPathSegments: pathSegments.slice(0, -1),
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
