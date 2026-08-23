import {
	assertValidTaskBlueprint,
	canAddParallelWorkAtEdge,
	canRemoveWorkNode,
	type TaskBlueprint,
	type TaskEdge,
	type TaskNode,
} from '../../task';

/** Task Graph World에서 사용하는 좌표다. */
export interface TaskLayoutPosition {
	readonly x: number;
	readonly y: number;
}

/** 모든 Task Layout Node가 공통으로 가지는 geometry와 소유 정보다. */
interface TaskLayoutNodeBase {
	readonly id: string;
	readonly taskId: string;
	readonly kind: TaskNode['kind'];
	readonly rank: number;
	readonly localPosition: TaskLayoutPosition;
	readonly position: TaskLayoutPosition;
	readonly width: number;
	readonly height: number;
}

/** TaskBlueprint 제목과 설명을 표시하는 시작 Layout Node다. */
export interface TaskStartLayoutNode extends TaskLayoutNodeBase {
	readonly kind: 'start';
	readonly title: string;
	readonly description: string;
}

/** Work Node의 표시 정보와 prompt를 제공하는 Layout Node다. */
export interface TaskWorkLayoutNode extends TaskLayoutNodeBase {
	readonly kind: 'work';
	readonly title: string;
	readonly description: string;
	readonly prompt: string;
	readonly canRemove: boolean;
}

/** Task 종료점을 표시하는 Layout Node다. */
export interface TaskEndLayoutNode extends TaskLayoutNodeBase {
	readonly kind: 'end';
}

/** Task Renderer가 처리하는 Start, Work, End Layout Node다. */
export type TaskLayoutNode =
	| TaskStartLayoutNode
	| TaskWorkLayoutNode
	| TaskEndLayoutNode;

/** Renderer Path와 Hover Action이 함께 사용하는 하나의 cubic Bézier geometry다. */
export interface TaskEdgeGeometry {
	readonly start: TaskLayoutPosition;
	readonly control1: TaskLayoutPosition;
	readonly control2: TaskLayoutPosition;
	readonly end: TaskLayoutPosition;
	readonly midpoint: TaskLayoutPosition;
}

/** Task Node 사이의 방향성 연결을 Layout ID로 전달한다. */
export interface TaskLayoutEdge {
	readonly id: string;
	readonly taskId: string;
	readonly sourceId: string;
	readonly targetId: string;
	/** Right Center → Left Center anchor와 Action midpoint를 공유하는 geometry다. */
	readonly geometry: TaskEdgeGeometry;
	/** target Work의 후속 흐름이 명확해 병렬 sibling을 추가할 수 있는지 나타낸다. */
	readonly canAddParallelWork: boolean;
}

/** 여러 Task의 Node와 Edge를 같은 World에 렌더링하기 위한 Layout이다. */
export interface TaskGraphLayout {
	readonly nodes: readonly TaskLayoutNode[];
	readonly edges: readonly TaskLayoutEdge[];
}

/** Start와 Work Card의 고정 폭이다. */
export const TASK_NODE_WIDTH = 280;
/** Start Card의 고정 높이다. */
export const TASK_START_NODE_HEIGHT = 104;
/** Work Card의 고정 높이다. */
export const TASK_WORK_NODE_HEIGHT = 132;
/** End Card의 고정 폭이다. */
export const TASK_END_NODE_WIDTH = 140;
/** End Card의 고정 높이다. */
export const TASK_END_NODE_HEIGHT = 48;
/** 같은 실행 rank에서 병렬 Node를 분리하는 기본 세로 간격이다. */
export const TASK_NODE_VERTICAL_GAP = 48;
/** 연속 실행 rank 사이의 기본 가로 간격이다. */
export const TASK_NODE_HORIZONTAL_GAP = 64;
const TASK_FLOW_CENTER_Y = TASK_START_NODE_HEIGHT / 2;
const TASK_EDGE_ANCHOR_SPACING = 12;
const TASK_EDGE_MIN_CONTROL_OFFSET = 32;

interface PreferredRankNode {
	readonly node: TaskNode;
	readonly preferredCenterY: number;
	readonly topologyOrder: number;
}

/**
 * Task Blueprint 목록을 origin 기준의 Left → Right layered Layout으로 변환한다.
 * rank는 X축, predecessor topology와 collision 해소 결과는 Y축을 결정한다.
 *
 * @param tasks 같은 Graph World에 표시할 Task Blueprint 목록
 * @returns Task 전용 Node geometry와 Edge 목록
 */
export function createTaskGraphLayout(
	tasks: readonly TaskBlueprint[],
): TaskGraphLayout {
	const nodes: TaskLayoutNode[] = [];
	const edges: TaskLayoutEdge[] = [];

	for (const task of tasks) {
		const taskLayout = createTaskLayout(task);

		nodes.push(...taskLayout.nodes);
		edges.push(...taskLayout.edges);
	}

	return { nodes, edges };
}

/** 내부 Node/Edge ID lookup이 다른 Task와 섞이지 않도록 한 Task만 Layout한다. */
function createTaskLayout(task: TaskBlueprint): TaskGraphLayout {
	assertValidTaskBlueprint(task);
	const incomingByNodeId = new Map(task.nodes.map((node) => (
		[node.id, [] as TaskEdge[]]
	)));
	const outgoingByNodeId = new Map(task.nodes.map((node) => (
		[node.id, [] as TaskEdge[]]
	)));
	const edgeIndexes = new Map(task.edges.map((edge, index) => [edge.id, index]));

	for (const edge of task.edges) {
		incomingByNodeId.get(edge.target)?.push(edge);
		outgoingByNodeId.get(edge.source)?.push(edge);
	}

	const ranks = createTaskNodeRanks(task, incomingByNodeId, outgoingByNodeId);
	const localPositions = createTaskLocalPositions(
		task,
		ranks,
		incomingByNodeId,
		edgeIndexes,
	);

	const nodes: TaskLayoutNode[] = task.nodes.map((node) => {
		const geometry = getTaskNodeGeometry(node);
		const localPosition = localPositions.get(node.id) ?? { x: 0, y: 0 };
		const base = {
			id: node.id,
			taskId: task.id,
			rank: ranks.get(node.id) ?? 0,
			localPosition,
			position: {
				x: task.origin.x + localPosition.x,
				y: task.origin.y + localPosition.y,
			},
			width: geometry.width,
			height: geometry.height,
		};

		if (node.kind === 'start') {
			return {
				...base,
				kind: node.kind,
				title: task.title,
				description: task.description,
			};
		} else if (node.kind === 'work') {
			return {
				...base,
				kind: node.kind,
				title: node.title,
				description: node.description,
				prompt: node.prompt,
				canRemove: canRemoveWorkNode(task, node.id),
			};
		} else {
			return { ...base, kind: node.kind };
		}
	});
	const nodesById = new Map(nodes.map((node) => [node.id, node]));

	for (const outgoing of outgoingByNodeId.values()) {
		outgoing.sort((left, right) => {
			const leftNode = nodesById.get(left.target);
			const rightNode = nodesById.get(right.target);
			const leftY = leftNode ? leftNode.position.y + leftNode.height / 2 : 0;
			const rightY = rightNode ? rightNode.position.y + rightNode.height / 2 : 0;

			return leftY - rightY
				|| (edgeIndexes.get(left.id) ?? 0) - (edgeIndexes.get(right.id) ?? 0);
		});
	}
	for (const incoming of incomingByNodeId.values()) {
		incoming.sort((left, right) => {
			const leftNode = nodesById.get(left.source);
			const rightNode = nodesById.get(right.source);
			const leftY = leftNode ? leftNode.position.y + leftNode.height / 2 : 0;
			const rightY = rightNode ? rightNode.position.y + rightNode.height / 2 : 0;

			return leftY - rightY
				|| (edgeIndexes.get(left.id) ?? 0) - (edgeIndexes.get(right.id) ?? 0);
		});
	}

	return {
		nodes,
		edges: task.edges.map((edge) => {
			const source = nodesById.get(edge.source);
			const target = nodesById.get(edge.target);

			if (!source || !target) {
				throw new Error(`Task Layout edge endpoint is missing: ${edge.id}.`);
			}

			const outgoing = outgoingByNodeId.get(edge.source) ?? [];
			const incoming = incomingByNodeId.get(edge.target) ?? [];

			return {
				id: edge.id,
				taskId: task.id,
				sourceId: edge.source,
				targetId: edge.target,
				geometry: createTaskEdgeGeometry(
					source,
					target,
					outgoing.findIndex((candidate) => candidate.id === edge.id),
					outgoing.length,
					incoming.findIndex((candidate) => candidate.id === edge.id),
					incoming.length,
				),
				canAddParallelWork: canAddParallelWorkAtEdge(task, edge.id),
			};
		}),
	};
}

/** predecessor 중심을 선호 위치로 삼아 rank별 X와 collision-free Y를 계산한다. */
function createTaskLocalPositions(
	task: TaskBlueprint,
	ranks: ReadonlyMap<string, number>,
	incomingByNodeId: ReadonlyMap<string, readonly TaskEdge[]>,
	edgeIndexes: ReadonlyMap<string, number>,
): ReadonlyMap<string, TaskLayoutPosition> {
	const nodesByRank = new Map<number, TaskNode[]>();
	for (const node of task.nodes) {
		const rank = ranks.get(node.id) ?? 0;
		const rankNodes = nodesByRank.get(rank) ?? [];

		rankNodes.push(node);
		nodesByRank.set(rank, rankNodes);
	}

	const positions = new Map<string, TaskLayoutPosition>();
	const centerYByNodeId = new Map<string, number>();
	let localX = 0;

	for (const rank of [...nodesByRank.keys()].sort((left, right) => left - right)) {
		const rankNodes = nodesByRank.get(rank) ?? [];
		const preferredNodes: PreferredRankNode[] = rankNodes.map((node) => {
			const incoming = incomingByNodeId.get(node.id) ?? [];
			const predecessorCenters = incoming
				.map((edge) => centerYByNodeId.get(edge.source))
				.filter((center): center is number => center !== undefined);
			const preferredCenterY = node.kind === 'start'
				|| predecessorCenters.length === 0
				? TASK_FLOW_CENTER_Y
				: predecessorCenters.reduce((sum, center) => sum + center, 0)
					/ predecessorCenters.length;
			const topologyOrder = incoming.reduce((minimum, edge) => Math.min(
				minimum,
				edgeIndexes.get(edge.id) ?? Number.MAX_SAFE_INTEGER,
			), Number.MAX_SAFE_INTEGER);

			return { node, preferredCenterY, topologyOrder };
		});
		const resolvedCenters = resolveRankNodeCenters(preferredNodes);

		for (const node of rankNodes) {
			const centerY = resolvedCenters.get(node.id) ?? TASK_FLOW_CENTER_Y;
			const geometry = getTaskNodeGeometry(node);

			centerYByNodeId.set(node.id, centerY);
			positions.set(node.id, {
				x: localX,
				y: centerY - geometry.height / 2,
			});
		}
		localX += Math.max(...rankNodes.map((node) => (
			getTaskNodeGeometry(node).width
		))) + TASK_NODE_HORIZONTAL_GAP;
	}

	return positions;
}

/** preferred Y 순서를 보존하며 실제 Node 높이와 gap만큼 sibling을 분산한다. */
function resolveRankNodeCenters(
	preferredNodes: readonly PreferredRankNode[],
): ReadonlyMap<string, number> {
	const sorted = [...preferredNodes].sort((left, right) => (
		left.preferredCenterY - right.preferredCenterY
		|| left.topologyOrder - right.topologyOrder
		|| left.node.id.localeCompare(right.node.id)
	));
	const downward: number[] = [];
	const upward: number[] = [];

	for (let index = 0; index < sorted.length; index += 1) {
		const current = sorted[index];

		if (!current || index === 0) {
			downward[index] = current?.preferredCenterY ?? TASK_FLOW_CENTER_Y;
			continue;
		}
		const previous = sorted[index - 1];
		const previousCenter = downward[index - 1];

		if (!previous || previousCenter === undefined) {
			downward[index] = current.preferredCenterY;
			continue;
		}
		const minimumCenter = previousCenter
			+ getTaskNodeGeometry(previous.node).height / 2
			+ TASK_NODE_VERTICAL_GAP
			+ getTaskNodeGeometry(current.node).height / 2;

		downward[index] = Math.max(current.preferredCenterY, minimumCenter);
	}

	for (let index = sorted.length - 1; index >= 0; index -= 1) {
		const current = sorted[index];

		if (!current || index === sorted.length - 1) {
			upward[index] = current?.preferredCenterY ?? TASK_FLOW_CENTER_Y;
			continue;
		}
		const next = sorted[index + 1];
		const nextCenter = upward[index + 1];

		if (!next || nextCenter === undefined) {
			upward[index] = current.preferredCenterY;
			continue;
		}
		const maximumCenter = nextCenter
			- getTaskNodeGeometry(current.node).height / 2
			- TASK_NODE_VERTICAL_GAP
			- getTaskNodeGeometry(next.node).height / 2;

		upward[index] = Math.min(current.preferredCenterY, maximumCenter);
	}

	return new Map(sorted.map((entry, index) => [
		entry.node.id,
		((downward[index] ?? entry.preferredCenterY)
			+ (upward[index] ?? entry.preferredCenterY)) / 2,
	]));
}

/** 한 Node의 여러 Edge anchor를 center 주변에 작은 Y offset으로 분산한다. */
function createEdgeAnchorOffset(
	index: number,
	count: number,
	nodeHeight: number,
): number {
	if (count <= 1 || index < 0) {
		return 0;
	}

	const spacing = Math.min(TASK_EDGE_ANCHOR_SPACING, nodeHeight / (count + 1));
	return (index - (count - 1) / 2) * spacing;
}

/** Right Center → Left Center 흐름의 cubic control과 실제 midpoint를 계산한다. */
function createTaskEdgeGeometry(
	source: TaskLayoutNode,
	target: TaskLayoutNode,
	sourceEdgeIndex: number,
	sourceEdgeCount: number,
	targetEdgeIndex: number,
	targetEdgeCount: number,
): TaskEdgeGeometry {
	const start = {
		x: source.position.x + source.width,
		y: source.position.y + source.height / 2 + createEdgeAnchorOffset(
			sourceEdgeIndex,
			sourceEdgeCount,
			source.height,
		),
	};
	const end = {
		x: target.position.x,
		y: target.position.y + target.height / 2 + createEdgeAnchorOffset(
			targetEdgeIndex,
			targetEdgeCount,
			target.height,
		),
	};
	const direction = end.x >= start.x ? 1 : -1;
	const controlOffset = Math.max(
		TASK_EDGE_MIN_CONTROL_OFFSET,
		Math.abs(end.x - start.x) / 2,
	);
	const control1 = {
		x: start.x + controlOffset * direction,
		y: start.y,
	};
	const control2 = {
		x: end.x - controlOffset * direction,
		y: end.y,
	};

	return {
		start,
		control1,
		control2,
		end,
		midpoint: getCubicBezierPoint(start, control1, control2, end, 0.5),
	};
}

/** Cubic Bézier의 지정 t 위치를 반환하는 Renderer 독립 pure helper다. */
export function getCubicBezierPoint(
	start: TaskLayoutPosition,
	control1: TaskLayoutPosition,
	control2: TaskLayoutPosition,
	end: TaskLayoutPosition,
	t: number,
): TaskLayoutPosition {
	const inverse = 1 - t;
	const startWeight = inverse ** 3;
	const control1Weight = 3 * inverse ** 2 * t;
	const control2Weight = 3 * inverse * t ** 2;
	const endWeight = t ** 3;

	return {
		x: startWeight * start.x
			+ control1Weight * control1.x
			+ control2Weight * control2.x
			+ endWeight * end.x,
		y: startWeight * start.y
			+ control1Weight * control1.y
			+ control2Weight * control2.y
			+ endWeight * end.y,
	};
}

/** DAG의 longest predecessor path를 실행 rank로 계산한다. */
function createTaskNodeRanks(
	task: TaskBlueprint,
	incomingByNodeId: ReadonlyMap<string, readonly TaskEdge[]>,
	outgoingByNodeId: ReadonlyMap<string, readonly TaskEdge[]>,
): ReadonlyMap<string, number> {
	const incomingCounts = new Map(task.nodes.map((node) => [
		node.id,
		incomingByNodeId.get(node.id)?.length ?? 0,
	]));

	const ranks = new Map(task.nodes.map((node) => [node.id, 0]));
	const queue = task.nodes
		.filter((node) => incomingCounts.get(node.id) === 0)
		.map((node) => node.id);

	for (let index = 0; index < queue.length; index += 1) {
		const sourceId = queue[index];
		if (!sourceId) {
			continue;
		}

		for (const edge of outgoingByNodeId.get(sourceId) ?? []) {
			const targetId = edge.target;

			ranks.set(targetId, Math.max(
				ranks.get(targetId) ?? 0,
				(ranks.get(sourceId) ?? 0) + 1,
			));
			const remainingIncoming = (incomingCounts.get(targetId) ?? 0) - 1;

			incomingCounts.set(targetId, remainingIncoming);
			if (remainingIncoming === 0) {
				queue.push(targetId);
			}
		}
	}

	return ranks;
}

/** Task Node kind에 대응하는 이번 단계의 고정 Card 크기를 반환한다. */
function getTaskNodeGeometry(node: TaskNode): {
	readonly width: number;
	readonly height: number;
} {
	if (node.kind === 'start') {
		return { width: TASK_NODE_WIDTH, height: TASK_START_NODE_HEIGHT };
	}
	if (node.kind === 'work') {
		return { width: TASK_NODE_WIDTH, height: TASK_WORK_NODE_HEIGHT };
	}

	return { width: TASK_END_NODE_WIDTH, height: TASK_END_NODE_HEIGHT };
}
