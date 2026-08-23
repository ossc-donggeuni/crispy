import {
	assertValidTaskBlueprint,
	canAddParallelWorkAtEdge,
	type TaskBlueprint,
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

/**
 * Task Blueprint 목록을 origin 기준의 Left → Right rank Layout으로 변환한다.
 * rank는 X축으로 진행하고 같은 rank의 병렬 Node는 중심선 주변 Y축에 배치한다.
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
	const ranks = createTaskNodeRanks(task);
	const nodesByRank = new Map<number, TaskNode[]>();

	for (const node of task.nodes) {
		const rank = ranks.get(node.id) ?? 0;
		const rankNodes = nodesByRank.get(rank) ?? [];

		rankNodes.push(node);
		nodesByRank.set(rank, rankNodes);
	}

	const localPositions = new Map<string, TaskLayoutPosition>();
	let localX = 0;
	for (const rank of [...nodesByRank.keys()].sort((left, right) => left - right)) {
		const rankNodes = nodesByRank.get(rank) ?? [];
		const rankWidth = Math.max(...rankNodes.map((node) => (
			getTaskNodeGeometry(node).width
		)));
		const rankHeight = rankNodes.reduce((height, node, index) => (
			height
			+ getTaskNodeGeometry(node).height
			+ (index === 0 ? 0 : TASK_NODE_VERTICAL_GAP)
		), 0);
		let localY = TASK_FLOW_CENTER_Y - rankHeight / 2;

		for (const node of rankNodes) {
			const geometry = getTaskNodeGeometry(node);

			localPositions.set(node.id, { x: localX, y: localY });
			localY += geometry.height + TASK_NODE_VERTICAL_GAP;
		}
		localX += rankWidth + TASK_NODE_HORIZONTAL_GAP;
	}

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
			};
		} else {
			return { ...base, kind: node.kind };
		}
	});
	const nodesById = new Map(nodes.map((node) => [node.id, node]));
	const edgeIndexes = new Map(task.edges.map((edge, index) => [edge.id, index]));

	return {
		nodes,
		edges: task.edges.map((edge) => {
			const source = nodesById.get(edge.source);
			const target = nodesById.get(edge.target);

			if (!source || !target) {
				throw new Error(`Task Layout edge endpoint is missing: ${edge.id}.`);
			}

			const outgoing = task.edges
				.filter((candidate) => candidate.source === edge.source)
				.sort((left, right) => compareEdgeTargets(
					left,
					right,
					nodesById,
					edgeIndexes,
				));
			const incoming = task.edges
				.filter((candidate) => candidate.target === edge.target)
				.sort((left, right) => compareEdgeSources(
					left,
					right,
					nodesById,
					edgeIndexes,
				));

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

function compareEdgeTargets(
	left: TaskBlueprint['edges'][number],
	right: TaskBlueprint['edges'][number],
	nodesById: ReadonlyMap<string, TaskLayoutNode>,
	edgeIndexes: ReadonlyMap<string, number>,
): number {
	return compareEdgeNodePositions(
		nodesById.get(left.target),
		nodesById.get(right.target),
		left.id,
		right.id,
		edgeIndexes,
	);
}

function compareEdgeSources(
	left: TaskBlueprint['edges'][number],
	right: TaskBlueprint['edges'][number],
	nodesById: ReadonlyMap<string, TaskLayoutNode>,
	edgeIndexes: ReadonlyMap<string, number>,
): number {
	return compareEdgeNodePositions(
		nodesById.get(left.source),
		nodesById.get(right.source),
		left.id,
		right.id,
		edgeIndexes,
	);
}

/** Branch/Join Edge 순서를 상대 Node의 중심 Y와 Blueprint 순서로 안정화한다. */
function compareEdgeNodePositions(
	left: TaskLayoutNode | undefined,
	right: TaskLayoutNode | undefined,
	leftEdgeId: string,
	rightEdgeId: string,
	edgeIndexes: ReadonlyMap<string, number>,
): number {
	const leftY = left ? left.position.y + left.height / 2 : 0;
	const rightY = right ? right.position.y + right.height / 2 : 0;

	return leftY - rightY
		|| (edgeIndexes.get(leftEdgeId) ?? 0) - (edgeIndexes.get(rightEdgeId) ?? 0);
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
function createTaskNodeRanks(task: TaskBlueprint): ReadonlyMap<string, number> {
	const incomingCounts = new Map(task.nodes.map((node) => [node.id, 0]));
	const targetsBySource = new Map(task.nodes.map((node) => (
		[node.id, [] as string[]]
	)));

	for (const edge of task.edges) {
		incomingCounts.set(edge.target, (incomingCounts.get(edge.target) ?? 0) + 1);
		targetsBySource.get(edge.source)?.push(edge.target);
	}

	const ranks = new Map(task.nodes.map((node) => [node.id, 0]));
	const queue = task.nodes
		.filter((node) => incomingCounts.get(node.id) === 0)
		.map((node) => node.id);

	for (let index = 0; index < queue.length; index += 1) {
		const sourceId = queue[index];
		if (!sourceId) {
			continue;
		}

		for (const targetId of targetsBySource.get(sourceId) ?? []) {
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
