import {
	resolveGraphLayoutNodePosition,
	type GraphLayout,
	type GraphLayoutPosition,
} from '../graph/graphLayout';
import { collectGraphLayoutSubtreeNodeIds } from '../graph/graphLayoutTransition';
import type {
	Graph,
	GraphRoot,
	GraphRootNode,
	ProjectEntry,
} from '../graph/graphModel';
import {
	GRAPH_ROOT_CONTEXT_GAP,
	GRAPH_ROOT_CONTEXT_LINE_HEIGHT,
} from '../graph/graphRootContext';
import {
	TASK_NODE_WIDTH,
	TASK_SCOPE_AREA_MIN_HEIGHT,
	type TaskGraphTargetAreaLayout,
} from './taskLayout';

/** Work Scope에 등록할 수 있는 Workspace Graph Source 종류다. */
export type TaskGraphTargetKind = 'folder' | 'file';

/** Workspace Graph 순회에서 얻은 Canonical Source 표시 정보다. */
export interface TaskGraphTargetSource {
	readonly sourceId: string;
	readonly kind: TaskGraphTargetKind;
	readonly name: string;
	readonly relativePath: string;
	readonly parentId?: string;
	readonly order: number;
}

/** Canonical Source ID로 Folder/File 표시 정보를 찾는 결정적 Workspace index다. */
export type TaskGraphTargetIndex = ReadonlyMap<string, TaskGraphTargetSource>;

/** Semantic binding 하나를 표시할 실제 Graph layout occurrence다. */
export interface TaskGraphScopeOccurrenceInput {
	readonly sourceId: string;
	readonly occurrenceNodeId: string;
}

/** 기존 Graph subtree의 실제 크기와 상대 좌표를 보존한 Scope 배치 단위다. */
export interface TaskGraphScopeOccurrenceLayout {
	readonly sourceId: string;
	readonly occurrenceNodeId: string;
	readonly nodePositions: ReadonlyMap<string, GraphLayoutPosition>;
	readonly bounds: {
		readonly x: number;
		readonly y: number;
		readonly width: number;
		readonly height: number;
	};
}

/** Region 배경 크기와 그 안에 배치할 실제 Graph occurrence 목록이다. */
export interface TaskGraphScopeLayout {
	readonly width: number;
	readonly height: number;
	readonly occurrences: readonly TaskGraphScopeOccurrenceLayout[];
}

/** Region label 아래 실제 Graph subtree를 시작할 World 여백이다. */
export const TASK_SCOPE_GRAPH_HEADER_HEIGHT = 28;
export const TASK_SCOPE_GRAPH_PADDING_X = 20;
export const TASK_SCOPE_GRAPH_PADDING_Y = 12;
export const TASK_SCOPE_GRAPH_OCCURRENCE_GAP = 16;

/** Workspace Graph hierarchy/traversal order를 Canonical Folder/File index로 만든다. */
export function createTaskGraphTargetIndex(
	graph: Graph,
): TaskGraphTargetIndex {
	const sources = new Map<string, TaskGraphTargetSource>();
	let order = 0;

	const addEntry = (
		entry: ProjectEntry,
		workspaceName: string,
		path: readonly string[],
		parentId: string | undefined,
	): void => {
		if (!sources.has(entry.id)) {
			sources.set(entry.id, {
				sourceId: entry.id,
				kind: entry.kind,
				name: entry.name,
				relativePath: [workspaceName, ...path].filter(Boolean).join('/'),
				...(parentId ? { parentId } : {}),
				order,
			});
			order += 1;
		}

		if (entry.kind === 'folder') {
			for (const child of entry.children) {
				addEntry(
					child,
					workspaceName,
					[...path, child.name],
					entry.id,
				);
			}
		}
	};

	for (const root of graph.roots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			continue;
		}
		indexRoot(root, rootNode, addEntry);
	}

	return sources;
}

/** Workspace 순회 순서와 Source ID tie-breaker를 공유해 binding 순서를 안정화한다. */
export function sortTaskGraphTargetIds(
	index: TaskGraphTargetIndex,
	sourceIds: readonly string[],
): string[] {
	return [...new Set(sourceIds)].sort((left, right) => {
		const leftSource = index.get(left);
		const rightSource = index.get(right);

		if (leftSource && rightSource) {
			return leftSource.order - rightSource.order;
		}
		if (leftSource) {
			return -1;
		}
		if (rightSource) {
			return 1;
		}
		return compareSourceIds(left, right);
	});
}

/**
 * 실제 Graph occurrence들의 현재 subtree geometry를 측정한다.
 * Graph Node/Edge DOM을 만들지 않고 기존 Layout relation과 nodePositions만 읽는다.
 */
export function createTaskGraphScopeLayout(
	layout: GraphLayout,
	nodePositions: Readonly<Record<string, GraphLayoutPosition>>,
	inputs: readonly TaskGraphScopeOccurrenceInput[],
	scopeBoundaryNodeIds: ReadonlySet<string> = new Set(),
): TaskGraphScopeLayout {
	const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
	const occurrences: TaskGraphScopeOccurrenceLayout[] = [];

	for (const input of inputs) {
		const rootNode = nodesById.get(input.occurrenceNodeId);

		if (!rootNode || rootNode.hidden === true) {
			continue;
		}
		const positions = new Map<string, GraphLayoutPosition>();
		let left = Number.POSITIVE_INFINITY;
		let top = Number.POSITIVE_INFINITY;
		let right = Number.NEGATIVE_INFINITY;
		let bottom = Number.NEGATIVE_INFINITY;

		const subtreeNodeIds = collectGraphLayoutSubtreeNodeIds(
			layout,
			input.occurrenceNodeId,
		);
		const excludedNodeIds = new Set<string>();

		// Parent와 descendant가 각각 다른 Scope binding을 소유할 수 있다.
		// 별도 occurrence root부터는 자신의 Region이 위치를 소유하도록 부모의
		// footprint/translation 대상에서 해당 실제 subtree를 잘라낸다.
		for (const boundaryNodeId of scopeBoundaryNodeIds) {
			if (
				boundaryNodeId === input.occurrenceNodeId
				|| !subtreeNodeIds.has(boundaryNodeId)
			) {
				continue;
			}
			for (const nodeId of collectGraphLayoutSubtreeNodeIds(
				layout,
				boundaryNodeId,
			)) {
				excludedNodeIds.add(nodeId);
			}
		}

		for (const nodeId of subtreeNodeIds) {
			if (excludedNodeIds.has(nodeId)) {
				continue;
			}
			const node = nodesById.get(nodeId);

			if (!node || node.hidden === true) {
				continue;
			}
			const position = resolveGraphLayoutNodePosition(node, nodePositions);

			positions.set(nodeId, position);
			left = Math.min(left, position.x);
			top = Math.min(top, position.y);
			right = Math.max(right, position.x + node.width);
			bottom = Math.max(bottom, position.y + node.height);
		}

		if (positions.size === 0) {
			continue;
		}
		if (layout.rootContexts[input.occurrenceNodeId]) {
			const rootPosition = positions.get(input.occurrenceNodeId);

			if (rootPosition) {
				left = Math.min(left, rootPosition.x);
				top = Math.min(
					top,
					rootPosition.y
						- GRAPH_ROOT_CONTEXT_GAP
						- GRAPH_ROOT_CONTEXT_LINE_HEIGHT,
				);
			}
		}
		occurrences.push({
			sourceId: input.sourceId,
			occurrenceNodeId: input.occurrenceNodeId,
			nodePositions: positions,
			bounds: {
				x: left,
				y: top,
				width: right - left,
				height: bottom - top,
			},
		});
	}

	const contentWidth = occurrences.reduce(
		(maximum, occurrence) => Math.max(maximum, occurrence.bounds.width),
		0,
	);
	const contentHeight = occurrences.reduce(
		(total, occurrence) => total + occurrence.bounds.height,
		0,
	) + Math.max(0, occurrences.length - 1) * TASK_SCOPE_GRAPH_OCCURRENCE_GAP;

	return {
		width: Math.max(
			TASK_NODE_WIDTH,
			contentWidth + TASK_SCOPE_GRAPH_PADDING_X * 2,
		),
		height: Math.max(
			TASK_SCOPE_AREA_MIN_HEIGHT,
			TASK_SCOPE_GRAPH_HEADER_HEIGHT
				+ TASK_SCOPE_GRAPH_PADDING_Y * 2
				+ contentHeight,
		),
		occurrences,
	};
}

/** 측정된 실제 occurrence들을 Region 내부 World 좌표로 옮길 nodePositions를 계산한다. */
export function createTaskGraphScopeNodePositions(
	area: TaskGraphTargetAreaLayout,
	layout: TaskGraphScopeLayout,
): ReadonlyMap<string, GraphLayoutPosition> {
	const positions = new Map<string, GraphLayoutPosition>();
	let nextTop = area.position.y
		+ TASK_SCOPE_GRAPH_HEADER_HEIGHT
		+ TASK_SCOPE_GRAPH_PADDING_Y;

	for (const occurrence of layout.occurrences) {
		// Reference/Work/WORK가 공유하는 동적 폭 안에서 actual subtree를
		// 중앙 정렬하고 기존 Graph relation을 그대로 보존한다.
		const targetLeft = area.position.x
			+ (area.width - occurrence.bounds.width) / 2;
		const delta = {
			x: targetLeft - occurrence.bounds.x,
			y: nextTop - occurrence.bounds.y,
		};

		for (const [nodeId, position] of occurrence.nodePositions) {
			positions.set(nodeId, {
				x: position.x + delta.x,
				y: position.y + delta.y,
			});
		}
		nextTop += occurrence.bounds.height + TASK_SCOPE_GRAPH_OCCURRENCE_GAP;
	}

	return positions;
}

/** Root 종류에 따라 Project 자체는 제외하고 Folder/File만 순회에 넣는다. */
function indexRoot(
	root: GraphRoot,
	rootNode: GraphRootNode,
	addEntry: (
		entry: ProjectEntry,
		workspaceName: string,
		path: readonly string[],
		parentId: string | undefined,
	) => void,
): void {
	if (rootNode.kind === 'project') {
		for (const child of rootNode.children) {
			addEntry(child, rootNode.name, [child.name], undefined);
		}
		return;
	}

	const contextPath = root.context?.relativePath
		?.split('/')
		.filter(Boolean)
		.join('/') ?? '';
	addEntry(rootNode, contextPath, [rootNode.name], undefined);
}

/** locale 설정과 무관한 Source ID tie-breaker다. */
function compareSourceIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
