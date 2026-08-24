import {
	isFile,
	isFolder,
	type File,
	type Folder,
	type Graph,
	type GraphRoot,
	type GraphRootContext,
	type ProjectContainer,
	type ProjectEntry,
} from './graphModel';
import {
	createFileBacklinkGroupId,
	createFolderBacklinkId,
	getDetachedRootOriginId,
	isDetachedRootId,
} from './graphRootPromotion';
import {
	FILE_GROUP_PAGE_SIZE,
	getRemainingFileCount,
	getVisibleFileCount,
} from './graphState';

/** Graph World 좌표계에서 Node의 좌상단 위치를 나타낸다. */
export interface GraphLayoutPosition {
	readonly x: number;
	readonly y: number;
}

/** 모든 Layout Node가 공통으로 가지는 크기와 기본 위치 정보다. */
interface GraphLayoutNodeBase {
	readonly id: string;
	readonly name: string;
	/** Graph 구조와 geometry는 유지하되 표시에서 제외할 때만 존재한다. */
	readonly hidden?: true;
	readonly depth: number;
	readonly position: GraphLayoutPosition;
	readonly width: number;
	readonly height: number;
}

/** Project Root를 나타내는 Layout Node다. */
export interface GraphProjectNode extends GraphLayoutNodeBase {
	readonly kind: 'project';
	readonly status: ProjectContainer['status'];
}

/** Folder를 나타내는 Layout Node다. */
export interface GraphFolderNode extends GraphLayoutNodeBase {
	readonly kind: 'folder';
	readonly status: ProjectContainer['status'];
}

/** 다른 Graph Root로 승격된 Folder의 원래 Tree 위치를 나타낸다. */
export interface GraphFolderBacklinkNode extends GraphLayoutNodeBase {
	readonly kind: 'folder-backlink';
	readonly targetRootId: string;
	readonly targetRootIds: readonly string[];
	readonly targetNodeId: string;
}

/** File Group Row가 실제 File인지 승격된 Root의 Backlink인지 나타낸다. */
export type GraphFilePresentation = 'normal' | 'backlink';

/** File Group child로 사용하는 File Layout 단위다. */
export interface GraphFileNode {
	readonly kind: 'file';
	readonly id: string;
	readonly name: string;
	/** File Row 또는 standalone Card를 표시에서 제외할 때만 존재한다. */
	readonly hidden?: true;
	readonly presentation: GraphFilePresentation;
	readonly targetRootId?: string;
	readonly targetRootIds?: readonly string[];
}

/** File Group Card의 표시 방식을 나타낸다. */
export type GraphFileGroupPresentation = 'grouped' | 'standalone';

/** 같은 Parent에 직접 포함되고 Filter를 통과한 File을 하나로 묶은 Layout Node다. */
export interface GraphFileGroupNode extends GraphLayoutNodeBase {
	readonly kind: 'file-group';
	readonly parentId?: string;
	readonly children: readonly GraphFileNode[];
	readonly presentation: GraphFileGroupPresentation;
}

/** Renderer가 처리하는 Project, Folder, File Group Node다. */
export type GraphLayoutNode =
	| GraphProjectNode
	| GraphFolderNode
	| GraphFolderBacklinkNode
	| GraphFileGroupNode;

/** Parent와 직접 Child 사이를 연결하는 방향성 Edge다. */
export interface GraphLayoutEdge {
	readonly id: string;
	readonly sourceId: string;
	readonly targetId: string;
	/** 연결 Node 중 하나가 숨겨져 표시에서 제외할 때만 존재한다. */
	readonly hidden?: true;
}

/** 결정된 Node 위치와 직접 Parent-Child Edge 목록이다. */
export interface GraphLayout {
	readonly nodes: readonly GraphLayoutNode[];
	readonly edges: readonly GraphLayoutEdge[];
	/** Context가 있는 Graph Root Node ID만 포함하는 Renderer 전달 Map이다. */
	readonly rootContexts: Readonly<Record<string, GraphRootContext>>;
	/** 실행 중 추가/제거되는 최신 Graph Root Node ID 집합이다. */
	readonly rootNodeIds: ReadonlySet<string>;
	/** Parent의 자동 sibling flow에 참여하는 Node ID 집합이다. */
	readonly arrangedNodeIds: ReadonlySet<string>;
	/** 수동 위치를 유지하며 Parent의 자동 sibling flow에서 제외된 Node ID 집합이다. */
	readonly unarrangedNodeIds: ReadonlySet<string>;
}

/** 순수 Layout 계산에 필요한 pagination 및 열린 Folder snapshot이다. */
export interface GraphLayoutOptions {
	readonly fileGroupPages?: Readonly<Record<string, number>>;
	readonly openedFolders?: Readonly<Record<string, true>>;
	readonly hiddenNodeIds?: Readonly<Record<string, true>>;
	/** 수동으로 꺼내 일반 sibling flow의 subtree 높이 계산에서 제외할 Node다. */
	readonly unarrangedNodeIds?: ReadonlySet<string>;
	/** 닫힌 ancestor 아래에서도 실제 occurrence와 원래 Edge 경로를 유지할 Node다. */
	readonly pinnedNodeIds?: ReadonlySet<string>;
}

/** 저장 위치가 있으면 우선하고 없으면 Layout의 결정적 기본 위치를 반환한다. */
export function resolveGraphLayoutNodePosition(
	node: Pick<GraphLayoutNode, 'id' | 'position'>,
	nodePositions: Readonly<Record<string, GraphLayoutPosition | undefined>>,
): GraphLayoutPosition {
	return nodePositions[node.id] ?? node.position;
}

/** Project Root 및 Folder Node의 고정 폭이다. */
export const GRAPH_FOLDER_NODE_WIDTH = 240;
/** Project Root 및 Folder Node의 고정 높이다. */
export const GRAPH_FOLDER_NODE_HEIGHT = 42;
/** File Group Node의 고정 폭이다. */
export const GRAPH_FILE_GROUP_NODE_WIDTH = 240;
/** Standalone presentation File Group의 고정 높이다. */
export const GRAPH_FILE_GROUP_STANDALONE_HEIGHT = 42;
/** File Group 내부 File Row 한 줄의 높이다. */
export const GRAPH_FILE_GROUP_ROW_HEIGHT = 30;
/** File Group Border 안쪽의 상하좌우 여백이다. */
export const GRAPH_FILE_GROUP_PADDING = 9;
/** 더보기와 접기가 같은 줄에 배치되는 pagination control 영역의 높이다. */
export const GRAPH_FILE_GROUP_CONTROL_HEIGHT = 26;
/** 기존 More Bar 높이 참조와 호환되는 pagination control 높이 alias다. */
export const GRAPH_FILE_GROUP_MORE_HEIGHT = GRAPH_FILE_GROUP_CONTROL_HEIGHT;
const GRAPH_LAYOUT_START_X = 48;
const GRAPH_LAYOUT_START_Y = 48;
const GRAPH_LAYOUT_COLUMN_GAP = 62;
const GRAPH_LAYOUT_ROW_GAP = 6;
const GRAPH_LAYOUT_COLUMN_WIDTH = GRAPH_FILE_GROUP_NODE_WIDTH;
const GRAPH_NODE_BORDER_SIZE = 4;
/** 독립 Graph Root subtree 사이에 두는 세로 간격이다. */
export const GRAPH_LAYOUT_ROOT_GAP = 96;
const GRAPH_LAYOUT_ROOT_SCOPE_DELIMITER = '::node:';

/** Detached Root 안의 Source ID를 Root Instance별 Visual ID로 변환한다. */
export function createGraphLayoutNodeId(rootId: string, sourceId: string): string {
	return isDetachedRootId(rootId)
		? `${rootId}${GRAPH_LAYOUT_ROOT_SCOPE_DELIMITER}${encodeURIComponent(sourceId)}`
		: sourceId;
}

/** Root-scoped Visual ID에서 공유 Source ID를 복원한다. */
export function getGraphLayoutSourceId(layoutNodeId: string): string {
	const delimiterIndex = layoutNodeId.lastIndexOf(
		GRAPH_LAYOUT_ROOT_SCOPE_DELIMITER,
	);

	if (delimiterIndex < 0) {
		return layoutNodeId;
	}

	const encodedSourceId = layoutNodeId.slice(
		delimiterIndex + GRAPH_LAYOUT_ROOT_SCOPE_DELIMITER.length,
	);

	try {
		return decodeURIComponent(encodedSourceId);
	} catch {
		return layoutNodeId;
	}
}

/** Root-scoped Visual ID를 소유한 Detached Root Instance ID를 반환한다. */
export function getGraphLayoutRootId(layoutNodeId: string): string | undefined {
	const delimiterIndex = layoutNodeId.lastIndexOf(
		GRAPH_LAYOUT_ROOT_SCOPE_DELIMITER,
	);

	if (delimiterIndex < 0) {
		return undefined;
	}

	const rootId = layoutNodeId.slice(0, delimiterIndex);

	return isDetachedRootId(rootId) ? rootId : undefined;
}

/** GraphRoot가 실제 Card로 렌더링되는 Visual Layout Node ID를 반환한다. */
export function getGraphRootLayoutNodeId(root: GraphRoot): string {
	return createGraphLayoutNodeId(root.id, root.nodeId);
}

/** Layout 계산 단계에서 사용하는 재귀 Tree Node다. */
interface LayoutTreeNode {
	readonly id: string;
	readonly name: string;
	readonly kind: GraphLayoutNode['kind'];
	readonly status?: ProjectContainer['status'];
	readonly depth: number;
	readonly width: number;
	readonly height: number;
	readonly parentId?: string;
	readonly fileChildren?: readonly GraphFileNode[];
	readonly fileGroupPresentation?: GraphFileGroupPresentation;
	readonly targetRootId?: string;
	readonly targetRootIds?: readonly string[];
	readonly targetNodeId?: string;
	readonly unarranged?: true;
	readonly children: readonly LayoutTreeNode[];
}

/**
 * 여러 Graph Root의 프로젝트 계층을 하나의 World에 배치할 Node와 Edge로 변환한다.
 * 같은 입력은 항상 같은 위치와 Edge 순서를 생성한다.
 *
 * Root 하나인 Graph는 기존 단일 Project와 동일한 기본 위치를 사용한다.
 * 후속 Root는 앞 Root의 subtree 아래에 결정적인 간격으로 배치한다.
 *
 * @param graph Layout을 생성할 Root 목록과 Project Tree
 * @param options File Group pagination과 열린 Folder snapshot
 * @returns 기본 World 위치가 계산된 Node와 직접 Parent-Child Edge
 */
export function createGraphLayout(
	graph: Graph,
	options: GraphLayoutOptions = {},
): GraphLayout {
	const nodes: GraphLayoutNode[] = [];
	const edges: GraphLayoutEdge[] = [];
	const rootContexts: Record<string, GraphRootContext> = {};
	const rootsByNodeId = groupRootsByNodeId(graph.roots);
	const rootNodeIds = new Set<string>();
	let rootTop = GRAPH_LAYOUT_START_Y;

	for (const root of graph.roots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			throw new Error(
				`Graph Root \"${root.id}\"가 참조하는 Node \"${root.nodeId}\"를 찾을 수 없습니다.`,
			);
		}
		if (
			rootNode.kind !== 'project'
			&& options.hiddenNodeIds?.[rootNode.id] === true
		) {
			continue;
		}

		const tree = rootNode.kind === 'file'
			? createStandaloneFileGroupTree(
				rootNode,
				0,
				undefined,
				undefined,
				options.unarrangedNodeIds ?? new Set(),
				root,
			)
			: createContainerTree(
				rootNode,
				0,
				options.fileGroupPages ?? {},
				options.openedFolders ?? {},
				rootsByNodeId,
				options.hiddenNodeIds ?? {},
				options.unarrangedNodeIds ?? new Set(),
				options.pinnedNodeIds ?? new Set(),
				root,
			);
		rootNodeIds.add(tree.id);

		if (root.context) {
			rootContexts[tree.id] = root.context;
		}
		const subtreeHeight = placeTree(tree, rootTop, nodes, edges);

		rootTop += subtreeHeight + GRAPH_LAYOUT_ROOT_GAP;
	}

	const unarrangedNodeIds = new Set(
		nodes
			.map((node) => node.id)
			.filter((nodeId) => options.unarrangedNodeIds?.has(nodeId) === true),
	);

	return {
		nodes,
		edges,
		rootContexts,
		rootNodeIds,
		arrangedNodeIds: new Set(
			nodes
				.map((node) => node.id)
				.filter((nodeId) => !unarrangedNodeIds.has(nodeId)),
		),
		unarrangedNodeIds,
	};
}

/** Source Node별 Graph Root Instance 목록을 Root 순서대로 묶는다. */
function groupRootsByNodeId(
	roots: readonly GraphRoot[],
): ReadonlyMap<string, readonly GraphRoot[]> {
	const grouped = new Map<string, GraphRoot[]>();

	for (const root of roots) {
		const sourceRoots = grouped.get(root.nodeId) ?? [];

		sourceRoots.push(root);
		grouped.set(root.nodeId, sourceRoots);
	}

	return grouped;
}

/**
 * 같은 Container에 직접 속한 File Group의 안정적인 Graph Node ID를 만든다.
 *
 * @param parentId File Group을 소유하는 Project 또는 Folder ID
 * @returns Parent ID에서 파생한 File Group ID
 */
export function createFileGroupId(parentId: string): string {
	return `${parentId}:files`;
}

/** Project/Folder 계층에 직접 File Group Child를 합성해 Layout Tree로 변환한다. */
function createContainerTree(
	container: ProjectContainer,
	depth: number,
	fileGroupPages: Readonly<Record<string, number>>,
	openedFolders: Readonly<Record<string, true>>,
	rootsByNodeId: ReadonlyMap<string, readonly GraphRoot[]>,
	hiddenNodeIds: Readonly<Record<string, true>>,
	unarrangedNodeIds: ReadonlySet<string>,
	pinnedNodeIds: ReadonlySet<string>,
	layoutRoot: GraphRoot,
): LayoutTreeNode {
	const id = createGraphLayoutNodeId(layoutRoot.id, container.id);
	const isOpened = openedFolders[id] === true
		|| (id !== container.id && openedFolders[container.id] === true);
	// Scope에 위치한 normal occurrence는 Detached 복제 없이 원래 hierarchy와
	// parent Edge를 유지한다. 닫힌 ancestor에서도 해당 occurrence까지의 실제
	// path만 projection에 남기고, 관계없는 sibling subtree는 계속 접힌다.
	const visibleChildren = isOpened
		? container.children
		: container.children.filter((child) => containsPinnedOccurrence(
			child,
			layoutRoot,
			pinnedNodeIds,
			hiddenNodeIds,
		));
	const folderChildren = visibleChildren
		.filter(isFolder)
		.filter((folder) => hiddenNodeIds[folder.id] !== true)
		.map((folder) => {
			const targetRoots = getDetachedRootsForOccurrence(
				rootsByNodeId.get(folder.id),
				layoutRoot,
			);

			return targetRoots
				? createFolderBacklinkTree(
					folder,
					depth + 1,
					targetRoots,
					layoutRoot,
				)
				: createContainerTree(
					folder,
					depth + 1,
					fileGroupPages,
					openedFolders,
					rootsByNodeId,
					hiddenNodeIds,
					unarrangedNodeIds,
					pinnedNodeIds,
					layoutRoot,
				);
		});
	const files = visibleChildren.filter(isFile);
	const fileNodes = files.length > 0
		? createFileLayoutTrees(
			container,
			files,
			depth + 1,
			fileGroupPages,
			rootsByNodeId,
			hiddenNodeIds,
			unarrangedNodeIds,
			layoutRoot,
		)
		: [];

	return {
		id,
		name: container.name,
		kind: container.kind,
		status: container.status,
		...(unarrangedNodeIds.has(id)
			? { unarranged: true as const }
			: {}),
		depth,
		width: GRAPH_FOLDER_NODE_WIDTH,
		height: GRAPH_FOLDER_NODE_HEIGHT,
		children: [...folderChildren, ...fileNodes],
	};
}

/** 승격된 Folder의 원래 child 위치를 leaf Backlink Tree로 치환한다. */
function createFolderBacklinkTree(
	folder: Folder,
	depth: number,
	targetRoots: readonly GraphRoot[],
	layoutRoot: GraphRoot,
): LayoutTreeNode {
	const targetRoot = targetRoots[0];

	if (!targetRoot) {
		throw new Error(`Folder Backlink "${folder.id}"의 대상 Root가 없습니다.`);
	}

	return {
		id: createGraphLayoutNodeId(
			layoutRoot.id,
			createFolderBacklinkId(folder.id),
		),
		name: folder.name,
		kind: 'folder-backlink',
		depth,
		width: GRAPH_FOLDER_NODE_WIDTH,
		height: GRAPH_FOLDER_NODE_HEIGHT,
		targetRootId: targetRoot.id,
		targetRootIds: targetRoots.map((root) => root.id),
		targetNodeId: folder.id,
		children: [],
	};
}

/** File 수에 따라 standalone/grouped presentation의 File Group을 만든다. */
function createFileLayoutTrees(
	parent: ProjectContainer,
	files: readonly File[],
	depth: number,
	fileGroupPages: Readonly<Record<string, number>>,
	rootsByNodeId: ReadonlyMap<string, readonly GraphRoot[]>,
	hiddenNodeIds: Readonly<Record<string, true>>,
	unarrangedNodeIds: ReadonlySet<string>,
	layoutRoot: GraphRoot,
): readonly LayoutTreeNode[] {
	const unarrangedFiles = files.filter((file) => {
		const occurrenceNodeId = createGraphLayoutNodeId(layoutRoot.id, file.id);

		return unarrangedNodeIds.has(occurrenceNodeId)
			&& !getDetachedRootsForOccurrence(
				rootsByNodeId.get(file.id),
				layoutRoot,
			);
	});
	const unarrangedFileIds = new Set(unarrangedFiles.map((file) => file.id));
	const arrangedTrees = createArrangedFileLayoutTrees(
		parent,
		files.filter((file) => !unarrangedFileIds.has(file.id)),
		depth,
		fileGroupPages,
		rootsByNodeId,
		hiddenNodeIds,
		unarrangedNodeIds,
		layoutRoot,
	);
	const unarrangedTrees = unarrangedFiles
		.filter((file) => hiddenNodeIds[file.id] !== true)
		.map((file) => createStandaloneFileGroupTree(
			file,
			depth,
			parent.id,
			undefined,
			unarrangedNodeIds,
			layoutRoot,
		));

	return [...arrangedTrees, ...unarrangedTrees];
}

/** 닫힌 Container에서 pinned actual occurrence까지의 원래 hierarchy만 찾는다. */
function containsPinnedOccurrence(
	entry: ProjectEntry,
	layoutRoot: GraphRoot,
	pinnedNodeIds: ReadonlySet<string>,
	hiddenNodeIds: Readonly<Record<string, true>>,
): boolean {
	if (hiddenNodeIds[entry.id] === true) {
		return false;
	}
	if (pinnedNodeIds.has(createGraphLayoutNodeId(layoutRoot.id, entry.id))) {
		return true;
	}

	return entry.kind === 'folder'
		&& entry.children.some((child) => containsPinnedOccurrence(
			child,
			layoutRoot,
			pinnedNodeIds,
			hiddenNodeIds,
		));
}

/** Filter를 통과한 File을 singleton/grouped presentation 규칙으로 묶는다. */
function createArrangedFileLayoutTrees(
	parent: ProjectContainer,
	files: readonly File[],
	depth: number,
	fileGroupPages: Readonly<Record<string, number>>,
	rootsByNodeId: ReadonlyMap<string, readonly GraphRoot[]>,
	hiddenNodeIds: Readonly<Record<string, true>>,
	unarrangedNodeIds: ReadonlySet<string>,
	layoutRoot: GraphRoot,
): readonly LayoutTreeNode[] {
	const singleton = files[0];

	if (files.length === 1 && singleton) {
		if (hiddenNodeIds[singleton.id] === true) {
			return [];
		}

		return [createStandaloneFileGroupTree(
			singleton,
			depth,
			parent.id,
			getDetachedRootsForOccurrence(
				rootsByNodeId.get(singleton.id),
				layoutRoot,
			),
			unarrangedNodeIds,
			layoutRoot,
		)];
	}

	if (files.length === 0) {
		return [];
	}

	const sourceId = createFileGroupId(parent.id);
	const id = createGraphLayoutNodeId(layoutRoot.id, sourceId);
	const page = fileGroupPages[id] ?? fileGroupPages[sourceId] ?? 1;
	const visibleFiles = files.filter((file) => hiddenNodeIds[file.id] !== true);

	if (visibleFiles.length === 0) {
		return [];
	}

	const visibleFileCount = getVisibleFileCount(visibleFiles.length, page);
	const remainingFileCount = getRemainingFileCount(visibleFiles.length, page);
	const hasPaginationControls = remainingFileCount > 0
		|| (visibleFiles.length > FILE_GROUP_PAGE_SIZE && page > 1);

	return [{
		id,
		name: `${parent.name} files`,
		kind: 'file-group',
		depth,
		width: GRAPH_FILE_GROUP_NODE_WIDTH,
		height: getFileGroupHeight(visibleFileCount, hasPaginationControls),
		parentId: createGraphLayoutNodeId(layoutRoot.id, parent.id),
		fileChildren: visibleFiles.map((file) => toGraphFileNode(
			file,
			getDetachedRootsForOccurrence(
				rootsByNodeId.get(file.id),
				layoutRoot,
			),
			layoutRoot,
		)),
		fileGroupPresentation: 'grouped',
		...(unarrangedNodeIds.has(id) ? { unarranged: true as const } : {}),
		children: [],
	}];
}

/** File 하나를 File ID 기반 standalone presentation Group으로 만든다. */
function createStandaloneFileGroupTree(
	file: File,
	depth: number,
	parentId?: string,
	targetRoots?: readonly GraphRoot[],
	unarrangedNodeIds: ReadonlySet<string> = new Set(),
	layoutRoot?: GraphRoot,
): LayoutTreeNode {
	const targetRoot = targetRoots?.[0];
	const sourceId = targetRoot ? createFileBacklinkGroupId(file.id) : file.id;
	const id = layoutRoot
		? createGraphLayoutNodeId(layoutRoot.id, sourceId)
		: sourceId;

	return {
		id,
		name: file.name,
		kind: 'file-group',
		depth,
		width: GRAPH_FILE_GROUP_NODE_WIDTH,
		height: GRAPH_FILE_GROUP_STANDALONE_HEIGHT,
		parentId: parentId && layoutRoot
			? createGraphLayoutNodeId(layoutRoot.id, parentId)
			: parentId,
		fileChildren: [toGraphFileNode(file, targetRoots, layoutRoot)],
		fileGroupPresentation: 'standalone',
		...(unarrangedNodeIds.has(id) ? { unarranged: true as const } : {}),
		children: [],
	};
}

/** Project File을 Group이 소유하는 최소 File Layout child로 변환한다. */
function toGraphFileNode(
	file: File,
	targetRoots: readonly GraphRoot[] | undefined,
	layoutRoot?: GraphRoot,
): GraphFileNode {
	const targetRoot = targetRoots?.[0];

	return {
		kind: 'file',
		id: layoutRoot
			? createGraphLayoutNodeId(layoutRoot.id, file.id)
			: file.id,
		name: file.name,
		presentation: targetRoot ? 'backlink' : 'normal',
		...(targetRoot === undefined ? {} : {
			targetRootId: targetRoot.id,
			targetRootIds: targetRoots?.map((root) => root.id),
		}),
	};
}

/** 표시 Row와 선택적 단일 control 영역을 포함한 File Group 높이를 계산한다. */
export function getFileGroupHeight(
	visibleFileCount: number,
	hasPaginationControls: boolean,
): number {
	return GRAPH_NODE_BORDER_SIZE
		+ GRAPH_FILE_GROUP_PADDING * 2
		+ visibleFileCount * GRAPH_FILE_GROUP_ROW_HEIGHT
		+ (hasPaginationControls ? GRAPH_FILE_GROUP_CONTROL_HEIGHT : 0);
}

/** Subtree 높이를 기준으로 Node를 배치하고 직접 Child Edge를 순서대로 생성한다. */
function placeTree(
	tree: LayoutTreeNode,
	nodeTop: number,
	nodes: GraphLayoutNode[],
	edges: GraphLayoutEdge[],
): number {
	const childHeights = tree.children.map(getSubtreeHeight);
	const arrangedChildHeights = childHeights.filter((height) => height > 0);
	const childrenHeight = arrangedChildHeights.reduce(
		(sum, height) => sum + height,
		0,
	) + Math.max(0, arrangedChildHeights.length - 1) * GRAPH_LAYOUT_ROW_GAP;
	const subtreeHeight = Math.max(tree.height, childrenHeight);
	const position = {
		x: GRAPH_LAYOUT_START_X
			+ tree.depth * (GRAPH_LAYOUT_COLUMN_WIDTH + GRAPH_LAYOUT_COLUMN_GAP),
		// 자신의 subtree 높이가 바뀌어도 Node 자체의 World 좌표는 유지한다.
		y: nodeTop,
	};

	nodes.push(toGraphLayoutNode(tree, position));

	let childSubtreeTop = nodeTop + (tree.height - childrenHeight) / 2;

	for (let index = 0; index < tree.children.length; index += 1) {
		const child = tree.children[index];
		const childHeight = childHeights[index];

		if (!child || childHeight === undefined) {
			continue;
		}

		edges.push({
			id: `${tree.id}->${child.id}`,
			sourceId: tree.id,
			targetId: child.id,
		});
		if (child.unarranged) {
			placeTree(child, nodeTop, nodes, edges);
			continue;
		}

		placeTree(
			child,
			childSubtreeTop + (childHeight - child.height) / 2,
			nodes,
			edges,
		);
		childSubtreeTop += childHeight + GRAPH_LAYOUT_ROW_GAP;
	}

	return tree.unarranged ? 0 : subtreeHeight;
}

/** Detached child Root는 자신이 분리된 Graph Root Instance에만 Backlink로 표시한다. */
function getDetachedRootsForOccurrence(
	roots: readonly GraphRoot[] | undefined,
	layoutRoot: GraphRoot,
): readonly GraphRoot[] | undefined {
	if (!roots) {
		return undefined;
	}

	const occurrenceRootId = isDetachedRootId(layoutRoot.id)
		? layoutRoot.id
		: undefined;
	const matchingRoots = roots.filter((root) => (
		getDetachedRootOriginId(root.id) === occurrenceRootId
	));

	return matchingRoots.length > 0 ? matchingRoots : undefined;
}

/** 자신과 모든 Child를 충돌 없이 세로 배치하는 데 필요한 Subtree 높이를 계산한다. */
function getSubtreeHeight(tree: LayoutTreeNode): number {
	if (tree.unarranged) {
		return 0;
	}

	if (tree.children.length === 0) {
		return tree.height;
	}

	const arrangedChildHeights = tree.children
		.map(getSubtreeHeight)
		.filter((height) => height > 0);
	const childrenHeight = arrangedChildHeights.reduce(
		(sum, height) => sum + height,
		0,
	) + Math.max(0, arrangedChildHeights.length - 1) * GRAPH_LAYOUT_ROW_GAP;

	return Math.max(tree.height, childrenHeight);
}

/** 내부 Layout Tree Node를 Renderer가 사용하는 판별 가능한 Layout Node로 변환한다. */
function toGraphLayoutNode(
	tree: LayoutTreeNode,
	position: GraphLayoutPosition,
): GraphLayoutNode {
	const base = {
		id: tree.id,
		name: tree.name,
		depth: tree.depth,
		position,
		width: tree.width,
		height: tree.height,
	};

	if (tree.kind === 'file-group') {
		return {
			...base,
			kind: 'file-group',
			...(tree.parentId === undefined ? {} : { parentId: tree.parentId }),
			children: tree.fileChildren ?? [],
			presentation: tree.fileGroupPresentation ?? 'grouped',
		};
	}

	if (tree.kind === 'folder-backlink') {
		if (!tree.targetRootId || !tree.targetNodeId) {
			throw new Error(`Folder Backlink \"${tree.id}\"의 대상 정보가 없습니다.`);
		}

		return {
			...base,
			kind: 'folder-backlink',
			targetRootId: tree.targetRootId,
			targetRootIds: tree.targetRootIds ?? [tree.targetRootId],
			targetNodeId: tree.targetNodeId,
		};
	}

	if (!tree.status) {
		throw new Error(`Directory Layout Node "${tree.id}"의 상태가 없습니다.`);
	}

	if (tree.kind === 'folder') {
		return { ...base, kind: 'folder', status: tree.status };
	}

	return { ...base, kind: 'project', status: tree.status };
}
