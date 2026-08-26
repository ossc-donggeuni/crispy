import type { GraphNodeEffectTarget } from '../../messages';
import type { TaskGraphTargetIndex } from '../task/taskGraphTargetLayout';
import {
	createFileGroupId,
	createGraphLayoutNodeId,
	getGraphLayoutRootId,
	getGraphLayoutSourceId,
	GRAPH_FILE_GROUP_PADDING,
	GRAPH_FILE_GROUP_ROW_HEIGHT,
	resolveGraphLayoutNodePosition,
	type GraphLayout,
	type GraphLayoutPosition,
} from './graphLayout';
import type { Graph } from './graphModel';
import { findGraphNode, isDetachedRootId } from './graphRootPromotion';
import {
	FILE_GROUP_PAGE_SIZE,
	type GraphState,
	type GraphStateSnapshot,
} from './graphState';
import { getAgentActivityBindingBlockHeight } from './agentActivityBindings';

/** 알림 Target을 표시하기 위해 변경할 Graph state와 선택 occurrence다. */
export interface AgentActivityTargetRevealResult {
	readonly state: GraphState;
	readonly preferredRootId?: string;
}

/**
 * 접힘, Filter와 File pagination을 최소 범위로 해제해 Activity target을 표시한다.
 * Detached occurrence에서는 해당 Root 아래의 state ID만 열고 원래 occurrence는 건드리지 않는다.
 */
export function createAgentActivityTargetRevealState(
	graph: Graph,
	targetIndex: TaskGraphTargetIndex,
	target: Readonly<GraphNodeEffectTarget>,
	snapshot: GraphStateSnapshot,
): AgentActivityTargetRevealResult | undefined {
	const occurrenceRoot = target.rootId
		? graph.roots.find((root) => root.id === target.rootId)
		: findGraphNode(graph, target.nodeId)?.root
			?? graph.roots.find((root) => root.nodeId === target.nodeId);

	if (!occurrenceRoot) {
		return undefined;
	}

	const preferredRootId = isDetachedRootId(occurrenceRoot.id)
		? occurrenceRoot.id
		: undefined;
	const source = targetIndex.get(target.nodeId);
	const ancestorIds: string[] = [];
	let parentId = target.nodeId === occurrenceRoot.nodeId
		? undefined
		: source?.parentId;
	const visited = new Set<string>();

	while (parentId && !visited.has(parentId)) {
		visited.add(parentId);
		ancestorIds.push(parentId);
		if (parentId === occurrenceRoot.nodeId) {
			break;
		}
		parentId = targetIndex.get(parentId)?.parentId;
	}

	// Project는 Task target index의 등록 대상이 아니므로 최상위 child의
	// parentId에 나타나지 않는다. 그래도 Graph에서 child를 보이려면 Project
	// occurrence 자체가 열려 있어야 하므로 실제 Root container를 보충한다.
	const occurrenceRootNode = graph.rootNodes[occurrenceRoot.nodeId];
	if (
		target.nodeId !== occurrenceRoot.nodeId
		&& occurrenceRootNode?.kind !== 'file'
		&& !ancestorIds.includes(occurrenceRoot.nodeId)
	) {
		ancestorIds.push(occurrenceRoot.nodeId);
	}

	const openedFolders = { ...snapshot.openedFolders };
	for (const ancestorId of ancestorIds) {
		openedFolders[toOccurrenceStateId(preferredRootId, ancestorId)] = true;
	}

	const hiddenNodeIds = { ...snapshot.hiddenNodeIds };
	delete hiddenNodeIds[target.nodeId];
	for (const ancestorId of ancestorIds) {
		delete hiddenNodeIds[ancestorId];
	}

	const fileGroupPages = { ...snapshot.fileGroupPages };
	if (
		source?.kind === 'file'
		&& source.parentId
		&& occurrenceRoot.nodeId !== target.nodeId
	) {
		const visibleSiblingFiles = [...targetIndex.values()]
			.filter((candidate) => (
				candidate.kind === 'file'
				&& candidate.parentId === source.parentId
				&& hiddenNodeIds[candidate.sourceId] !== true
			))
			.sort((left, right) => left.order - right.order);
		const targetIndexInGroup = visibleSiblingFiles.findIndex(
			(candidate) => candidate.sourceId === target.nodeId,
		);

		if (targetIndexInGroup >= 0) {
			const requiredPage = Math.floor(
				targetIndexInGroup / FILE_GROUP_PAGE_SIZE,
			) + 1;
			const groupId = toOccurrenceStateId(
				preferredRootId,
				createFileGroupId(source.parentId),
			);

			fileGroupPages[groupId] = Math.max(
				fileGroupPages[groupId] ?? 1,
				requiredPage,
			);
		}
	}

	return {
		state: {
			camera: snapshot.camera,
			nodePositions: snapshot.nodePositions,
			fileGroupPages,
			openedFolders,
			detachedRootNodeIds: snapshot.detachedRootNodeIds,
			hiddenNodeIds,
		},
		...(preferredRootId ? { preferredRootId } : {}),
	};
}

/** 최신 Layout과 runtime 위치에서 Activity가 표시되는 Card/Row 중심을 찾는다. */
export function resolveAgentActivityTargetFocusPoint(
	layout: GraphLayout,
	nodePositions: GraphStateSnapshot['nodePositions'],
	target: Readonly<GraphNodeEffectTarget>,
	preferredRootId: string | undefined = target.rootId,
): GraphLayoutPosition | undefined {
	const candidates: Array<{
		readonly point: GraphLayoutPosition;
		readonly rootId?: string;
	}> = [];

	for (const node of layout.nodes) {
		if (node.hidden === true || node.kind === 'folder-backlink') {
			continue;
		}

		const position = resolveGraphLayoutNodePosition(node, nodePositions);
		if (node.kind !== 'file-group') {
			if (getGraphLayoutSourceId(node.id) === target.nodeId) {
				candidates.push({
					point: {
						x: position.x + node.width / 2,
						y: position.y + node.height / 2,
					},
					...(getGraphLayoutRootId(node.id)
						? { rootId: getGraphLayoutRootId(node.id) }
						: {}),
				});
			}
			continue;
		}

		if (node.presentation === 'standalone') {
			const file = node.children[0];

			if (
				file?.presentation === 'normal'
				&& file.hidden !== true
				&& getGraphLayoutSourceId(file.id) === target.nodeId
			) {
				const rootId = getGraphLayoutRootId(file.id)
					?? getGraphLayoutRootId(node.id);

				candidates.push({
					point: {
						x: position.x + node.width / 2,
						y: position.y + node.height / 2,
					},
					...(rootId ? { rootId } : {}),
				});
			}
			continue;
		}

		let rowTop = position.y + GRAPH_FILE_GROUP_PADDING;
		for (const file of node.children) {
			if (
				file.presentation === 'normal'
				&& file.hidden !== true
				&& getGraphLayoutSourceId(file.id) === target.nodeId
			) {
				const rootId = getGraphLayoutRootId(file.id)
					?? getGraphLayoutRootId(node.id);

				candidates.push({
					point: {
						x: position.x + node.width / 2,
						y: rowTop + GRAPH_FILE_GROUP_ROW_HEIGHT / 2,
					},
					...(rootId ? { rootId } : {}),
				});
			}
			rowTop += GRAPH_FILE_GROUP_ROW_HEIGHT
				+ getAgentActivityBindingBlockHeight(
					file.agentActivityBindingCount ?? 0,
				);
		}
	}

	if (target.rootId) {
		return candidates.find(({ rootId }) => rootId === target.rootId)?.point;
	}
	if (preferredRootId) {
		const preferred = candidates.find(({ rootId }) => rootId === preferredRootId);

		if (preferred) {
			return preferred.point;
		}
	}
	return candidates.find(({ rootId }) => rootId === undefined)?.point
		?? candidates[0]?.point;
}

function toOccurrenceStateId(
	rootId: string | undefined,
	sourceId: string,
): string {
	return rootId ? createGraphLayoutNodeId(rootId, sourceId) : sourceId;
}
