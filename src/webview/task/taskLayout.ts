import {
	assertValidTaskBlueprint,
	getTaskFlowStatus,
	type TaskBlueprint,
	type TaskFlowStatus,
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
	readonly flowState: TaskFlowStatus;
	/** Blueprint에 저장한 task-local 위치이며 Start만 `{ x: 0, y: 0 }`이다. */
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
const TASK_EDGE_MIN_CONTROL_OFFSET = 32;

/**
 * Task Blueprint의 명시적인 task-local 좌표를 World Node와 Edge geometry로 변환한다.
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
	const flowState = getTaskFlowStatus(task);
	const nodes: TaskLayoutNode[] = task.nodes.map((node) => {
		const geometry = getTaskNodeGeometry(node);
		const storedPosition = task.nodePositions[node.id];

		if (node.kind !== 'start' && !storedPosition) {
			throw new Error(`Task Layout node position is missing: ${node.id}.`);
		}
		const localPosition = node.kind === 'start'
			? { x: 0, y: 0 }
			: storedPosition;
		const base = {
			id: node.id,
			taskId: task.id,
			flowState,
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
				canRemove: true,
			};
		} else {
			return { ...base, kind: node.kind };
		}
	});
	const nodesById = new Map(nodes.map((node) => [node.id, node]));

	return {
		nodes,
		edges: task.edges.map((edge) => {
			const source = nodesById.get(edge.source);
			const target = nodesById.get(edge.target);

			if (!source || !target) {
				throw new Error(`Task Layout edge endpoint is missing: ${edge.id}.`);
			}

			return {
				id: edge.id,
				taskId: task.id,
				sourceId: edge.source,
				targetId: edge.target,
				geometry: createTaskEdgeGeometry(
					getTaskPortCenter(source, 'output'),
					getTaskPortCenter(target, 'input'),
				),
			};
		}),
	};
}

/** CSS Port 원의 중심과 같은 Node border 좌표를 반환한다. */
export function getTaskPortCenter(
	node: TaskLayoutNode,
	direction: 'input' | 'output',
): TaskLayoutPosition {
	return {
		x: node.position.x + (direction === 'output' ? node.width : 0),
		y: node.position.y + node.height / 2,
	};
}

/** 두 Anchor를 실제 Edge와 Preview가 공유하는 horizontal cubic으로 연결한다. */
export function createTaskEdgeGeometry(
	start: TaskLayoutPosition,
	end: TaskLayoutPosition,
): TaskEdgeGeometry {
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
