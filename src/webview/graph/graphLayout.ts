import {
	isFile,
	isFolder,
	type File,
	type Project,
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

/** 같은 Parent에 직접 포함된 File을 하나로 묶은 Layout Node다. */
export interface GraphFileGroupNode extends GraphLayoutNodeBase {
	readonly kind: 'file-group';
	readonly parentId: string;
	readonly files: readonly File[];
}

/** Renderer가 처리하는 Project Root, Folder, File Group Node의 합집합이다. */
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
}

/** 순수 Layout 계산에 필요한 File Group pagination snapshot이다. */
export interface GraphLayoutOptions {
	readonly fileGroupPages?: Readonly<Record<string, number>>;
}

/** Project Root 및 Folder Node의 고정 폭이다. */
export const GRAPH_FOLDER_NODE_WIDTH = 200;
/** Project Root 및 Folder Node의 고정 높이다. */
export const GRAPH_FOLDER_NODE_HEIGHT = 42;
/** File Group Node의 고정 폭이다. */
export const GRAPH_FILE_GROUP_NODE_WIDTH = 200;
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

/** Layout 계산 단계에서 사용하는 재귀 Tree Node다. */
interface LayoutTreeNode {
	readonly id: string;
	readonly name: string;
	readonly kind: GraphLayoutNode['kind'];
	readonly depth: number;
	readonly width: number;
	readonly height: number;
	readonly parentId?: string;
	readonly files?: readonly File[];
	readonly children: readonly LayoutTreeNode[];
}

/**
 * 프로젝트 계층을 왼쪽에서 오른쪽으로 배치할 Node와 직접 관계 Edge로 변환한다.
 * 같은 입력은 항상 같은 위치와 Edge 순서를 생성한다.
 *
 * @param project Layout을 생성할 Project Root
 * @param options File Group 높이에 반영할 pagination snapshot
 * @returns 기본 World 위치가 계산된 Node와 직접 Parent-Child Edge
 */
export function createGraphLayout(
	project: Project,
	options: GraphLayoutOptions = {},
): GraphLayout {
	const tree = createContainerTree(project, 0, options.fileGroupPages ?? {});
	const nodes: GraphLayoutNode[] = [];
	const edges: GraphLayoutEdge[] = [];

	placeTree(tree, GRAPH_LAYOUT_START_Y, nodes, edges);

	return { nodes, edges };
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
): LayoutTreeNode {
	const folderChildren = container.children
		.filter(isFolder)
		.map((folder) => createContainerTree(folder, depth + 1, fileGroupPages));
	const files = container.children.filter(isFile);
	const fileGroup = files.length > 0
		? createFileGroupTree(container, files, depth + 1, fileGroupPages)
		: [];

	return {
		id: container.id,
		name: container.name,
		kind: container.kind,
		depth,
		width: GRAPH_FOLDER_NODE_WIDTH,
		height: GRAPH_FOLDER_NODE_HEIGHT,
		children: [...folderChildren, ...fileGroup],
	};
}

/** Parent에 직접 속한 File을 하나의 leaf File Group Tree Node로 만든다. */
function createFileGroupTree(
	parent: ProjectContainer,
	files: readonly File[],
	depth: number,
	fileGroupPages: Readonly<Record<string, number>>,
): readonly LayoutTreeNode[] {
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
		files,
		children: [],
	}];
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
		const files = tree.files ?? [];

		return {
			...base,
			kind: 'file-group',
			parentId: tree.parentId ?? '',
			files,
		};
	}

	if (tree.kind === 'folder') {
		return { ...base, kind: 'folder' };
	}

	return { ...base, kind: 'project' };
}
