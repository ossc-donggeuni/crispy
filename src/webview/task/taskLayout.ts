import {
	assertValidTaskBlueprint,
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

/** Task Node 사이의 방향성 연결을 Layout ID로 전달한다. */
export interface TaskLayoutEdge {
	readonly id: string;
	readonly taskId: string;
	readonly sourceId: string;
	readonly targetId: string;
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
/** Task Node 사이의 기본 세로 간격이다. */
export const TASK_NODE_VERTICAL_GAP = 48;

/**
 * Task Blueprint 목록을 origin 기준의 단순 세로 Layout으로 변환한다.
 * 복잡한 DAG 자동 배치는 수행하지 않고 Blueprint의 Node 순서를 유지한다.
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
		assertValidTaskBlueprint(task);
		let localY = 0;

		for (const node of task.nodes) {
			const geometry = getTaskNodeGeometry(node);
			const localPosition = {
				x: (TASK_NODE_WIDTH - geometry.width) / 2,
				y: localY,
			};
			const base = {
				id: node.id,
				taskId: task.id,
				localPosition,
				position: {
					x: task.origin.x + localPosition.x,
					y: task.origin.y + localPosition.y,
				},
				width: geometry.width,
				height: geometry.height,
			};

			if (node.kind === 'start') {
				nodes.push({
					...base,
					kind: node.kind,
					title: task.title,
					description: task.description,
				});
			} else if (node.kind === 'work') {
				nodes.push({
					...base,
					kind: node.kind,
					title: node.title,
					description: node.description,
					prompt: node.prompt,
				});
			} else {
				nodes.push({ ...base, kind: node.kind });
			}

			localY += geometry.height + TASK_NODE_VERTICAL_GAP;
		}

		for (const edge of task.edges) {
			edges.push({
				id: edge.id,
				taskId: task.id,
				sourceId: edge.source,
				targetId: edge.target,
			});
		}
	}

	return { nodes, edges };
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
