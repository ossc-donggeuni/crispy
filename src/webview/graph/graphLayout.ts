import {
	isFile,
	isFolder,
	type File,
	type Graph,
	type GraphRootContext,
	type ProjectContainer,
} from './graphModel';
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
	readonly depth: number;
	readonly position: GraphLayoutPosition;
	readonly width: number;
	readonly height: number;
}

/** Project Root를 나타내는 Layout Node다. */
export interface GraphProjectNode extends GraphLayoutNodeBase {
	readonly kind: 'project';
}

/** Folder를 나타내는 Layout Node다. */
export interface GraphFolderNode extends GraphLayoutNodeBase {
	readonly kind: 'folder';
}

/** File Group child로 사용하는 File Layout 단위다. */
export interface GraphFileNode {
	readonly kind: 'file';
	readonly id: string;
	readonly name: string;
}

/** File Group Card의 표시 방식을 나타낸다. */
export type GraphFileGroupPresentation = 'grouped' | 'standalone';

/** 같은 Parent에 직접 포함된 File을 하나로 묶은 Layout Node다. */
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
	| GraphFileGroupNode;

/** Parent와 직접 Child 사이를 연결하는 방향성 Edge다. */
export interface GraphLayoutEdge {
	readonly id: string;
	readonly sourceId: string;
	readonly targetId: string;
}

/** 결정된 Node 위치와 직접 Parent-Child Edge 목록이다. */
export interface GraphLayout {
	readonly nodes: readonly GraphLayoutNode[];
	readonly edges: readonly GraphLayoutEdge[];
	/** Context가 있는 Graph Root Node ID만 포함하는 Renderer 전달 Map이다. */
	readonly rootContexts: Readonly<Record<string, GraphRootContext>>;
}

/** 순수 Layout 계산에 필요한 pagination 및 열린 Folder snapshot이다. */
export interface GraphLayoutOptions {
	readonly fileGroupPages?: Readonly<Record<string, number>>;
	readonly openedFolders?: Readonly<Record<string, true>>;
}

/** Project Root 및 Folder Node의 고정 폭이다. */
export const GRAPH_FOLDER_NODE_WIDTH = 200;
/** Project Root 및 Folder Node의 고정 높이다. */
export const GRAPH_FOLDER_NODE_HEIGHT = 42;
/** File Group Node의 고정 폭이다. */
export const GRAPH_FILE_GROUP_NODE_WIDTH = 200;
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
const GRAPH_LAYOUT_ROOT_GAP = 96;

/** Layout 계산 단계에서 사용하는 재귀 Tree Node다. */
interface LayoutTreeNode {
	readonly id: string;
	readonly name: string;
	readonly kind: GraphLayoutNode['kind'];
	readonly depth: number;
	readonly width: number;
	readonly height: number;
	readonly parentId?: string;
	readonly fileChildren?: readonly GraphFileNode[];
	readonly fileGroupPresentation?: GraphFileGroupPresentation;
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
	let rootTop = GRAPH_LAYOUT_START_Y;

	for (const root of graph.roots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			throw new Error(
				`Graph Root \"${root.id}\"가 참조하는 Node \"${root.nodeId}\"를 찾을 수 없습니다.`,
			);
		}

		if (root.context) {
			rootContexts[root.nodeId] = root.context;
		}

		const tree = rootNode.kind === 'file'
			? createStandaloneFileGroupTree(rootNode, 0)
			: createContainerTree(
				rootNode,
				0,
				options.fileGroupPages ?? {},
				options.openedFolders ?? {},
			);
		const subtreeHeight = placeTree(tree, rootTop, nodes, edges);

		rootTop += subtreeHeight + GRAPH_LAYOUT_ROOT_GAP;
	}

	return { nodes, edges, rootContexts };
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
): LayoutTreeNode {
	const isOpened = openedFolders[container.id] === true;
	const visibleChildren = isOpened ? container.children : [];
	const folderChildren = visibleChildren
		.filter(isFolder)
		.map((folder) => createContainerTree(
			folder,
			depth + 1,
			fileGroupPages,
			openedFolders,
		));
	const files = visibleChildren.filter(isFile);
	const fileNodes = files.length > 0
		? createFileLayoutTrees(container, files, depth + 1, fileGroupPages)
		: [];

	return {
		id: container.id,
		name: container.name,
		kind: container.kind,
		depth,
		width: GRAPH_FOLDER_NODE_WIDTH,
		height: GRAPH_FOLDER_NODE_HEIGHT,
		children: [...folderChildren, ...fileNodes],
	};
}

/** File 수에 따라 standalone/grouped presentation의 File Group을 만든다. */
function createFileLayoutTrees(
	parent: ProjectContainer,
	files: readonly File[],
	depth: number,
	fileGroupPages: Readonly<Record<string, number>>,
): readonly LayoutTreeNode[] {
	const singleton = files[0];

	if (files.length === 1 && singleton) {
		return [createStandaloneFileGroupTree(singleton, depth, parent.id)];
	}

	const id = createFileGroupId(parent.id);
	const page = fileGroupPages[id] ?? 1;
	const visibleFileCount = getVisibleFileCount(files.length, page);
	const remainingFileCount = getRemainingFileCount(files.length, page);
	const hasPaginationControls = remainingFileCount > 0
		|| (files.length > FILE_GROUP_PAGE_SIZE && page > 1);

	return [{
		id,
		name: `${parent.name} files`,
		kind: 'file-group',
		depth,
		width: GRAPH_FILE_GROUP_NODE_WIDTH,
		height: getFileGroupHeight(visibleFileCount, hasPaginationControls),
		parentId: parent.id,
		fileChildren: files.map(toGraphFileNode),
		fileGroupPresentation: 'grouped',
		children: [],
	}];
}

/** File 하나를 File ID 기반 standalone presentation Group으로 만든다. */
function createStandaloneFileGroupTree(
	file: File,
	depth: number,
	parentId?: string,
): LayoutTreeNode {
	return {
		id: file.id,
		name: file.name,
		kind: 'file-group',
		depth,
		width: GRAPH_FILE_GROUP_NODE_WIDTH,
		height: GRAPH_FILE_GROUP_STANDALONE_HEIGHT,
		parentId,
		fileChildren: [toGraphFileNode(file)],
		fileGroupPresentation: 'standalone',
		children: [],
	};
}

/** Project File을 Group이 소유하는 최소 File Layout child로 변환한다. */
function toGraphFileNode(file: File): GraphFileNode {
	return {
		kind: 'file',
		id: file.id,
		name: file.name,
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
	top: number,
	nodes: GraphLayoutNode[],
	edges: GraphLayoutEdge[],
): number {
	const childHeights = tree.children.map(getSubtreeHeight);
	const childrenHeight = childHeights.reduce((sum, height) => sum + height, 0)
		+ Math.max(0, tree.children.length - 1) * GRAPH_LAYOUT_ROW_GAP;
	const subtreeHeight = Math.max(tree.height, childrenHeight);
	const position = {
		x: GRAPH_LAYOUT_START_X
			+ tree.depth * (GRAPH_LAYOUT_COLUMN_WIDTH + GRAPH_LAYOUT_COLUMN_GAP),
		y: top + (subtreeHeight - tree.height) / 2,
	};

	nodes.push(toGraphLayoutNode(tree, position));

	let childTop = top + (subtreeHeight - childrenHeight) / 2;

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
		placeTree(child, childTop, nodes, edges);
		childTop += childHeight + GRAPH_LAYOUT_ROW_GAP;
	}

	return subtreeHeight;
}

/** 자신과 모든 Child를 충돌 없이 세로 배치하는 데 필요한 Subtree 높이를 계산한다. */
function getSubtreeHeight(tree: LayoutTreeNode): number {
	if (tree.children.length === 0) {
		return tree.height;
	}

	const childrenHeight = tree.children.reduce(
		(sum, child) => sum + getSubtreeHeight(child),
		0,
	) + (tree.children.length - 1) * GRAPH_LAYOUT_ROW_GAP;

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

	if (tree.kind === 'folder') {
		return { ...base, kind: 'folder' };
	}

	return { ...base, kind: 'project' };
}
