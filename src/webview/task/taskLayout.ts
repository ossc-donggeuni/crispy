import {
	assertValidTaskBlueprint,
	getTaskFlowAnalysis,
	type TaskBlueprint,
	type TaskFlowStatus,
	type TaskNode,
	type WorkGraphTargets,
} from '../../task';

/** Task Graph World에서 사용하는 좌표다. */
export interface TaskLayoutPosition {
	readonly x: number;
	readonly y: number;
}

/** Task Graph World 안에서 파생 UI가 차지하는 사각 bounds다. */
export interface TaskLayoutBounds {
	readonly position: TaskLayoutPosition;
	readonly width: number;
	readonly height: number;
}

/** Work 위 두 Scope Area의 의미 역할이다. */
export type TaskGraphTargetAreaKind = 'reference' | 'work';

/** Work 좌표와 Target 수에서 파생한 Scope Area geometry다. */
export interface TaskGraphTargetAreaLayout extends TaskLayoutBounds {
	readonly kind: TaskGraphTargetAreaKind;
	readonly sourceIds: readonly string[];
}

/** 실제 Graph occurrence footprint가 요청하는 Scope Region 크기다. */
export interface TaskGraphTargetAreaSize {
	readonly width: number;
	readonly height: number;
}

/** GraphView가 actual occurrence 측정값만 선택적으로 Layout에 주입한다. */
export interface TaskGraphLayoutOptions {
	readonly resolveGraphTargetAreaSize?: (
		taskId: string,
		nodeId: string,
		area: TaskGraphTargetAreaKind,
		sourceIds: readonly string[],
	) => TaskGraphTargetAreaSize | undefined;
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

/** Node가 START→END 완성 경로에 참여하는지 나타내는 파생 상태다. */
export type TaskNodeConnectionState = 'connected' | 'disconnected';

/** TaskBlueprint 제목을 표시하는 시작 Layout Node다. */
export interface TaskStartLayoutNode extends TaskLayoutNodeBase {
	readonly kind: 'start';
	readonly title: string;
	readonly description: string;
	readonly connectionState: TaskNodeConnectionState;
}

/** Work Node의 표시 정보와 prompt를 제공하는 Layout Node다. */
export interface TaskWorkLayoutNode extends TaskLayoutNodeBase {
	readonly kind: 'work';
	readonly title: string;
	readonly description: string;
	readonly prompt: string;
	readonly graphTargets: WorkGraphTargets;
	readonly scopeAreas: Readonly<Record<
		TaskGraphTargetAreaKind,
		TaskGraphTargetAreaLayout
	>>;
	/** 두 Scope Area와 실제 Work Card를 모두 포함하는 충돌 계산용 footprint다. */
	readonly visualBounds: TaskLayoutBounds;
	readonly canRemove: boolean;
	readonly connectionState: TaskNodeConnectionState;
}

/** TaskBlueprint 제목을 표시하는 종료 Layout Node다. */
export interface TaskEndLayoutNode extends TaskLayoutNodeBase {
	readonly kind: 'end';
	readonly title: string;
	readonly description: string;
	readonly connectionState: TaskNodeConnectionState;
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

/** START/END의 고정 폭이며 Scope가 비어 있는 WORK의 최소 폭이다. */
export const TASK_NODE_WIDTH = 280;
/** 모든 Task Card가 공유하는 컴팩트한 고정 높이다. */
export const TASK_NODE_HEIGHT = 56;
/** Target이 없어도 역할과 Drop 안내를 표시하는 Scope Area 최소 높이다. */
export const TASK_SCOPE_AREA_MIN_HEIGHT = 72;
/** Reference → Work → Work Card 사이의 world 간격이다. */
export const TASK_SCOPE_AREA_GAP = 8;
/** 실제 Scope footprint가 겹칠 때 다음 Work를 아래로 미는 최소 간격이다. */
export const TASK_WORK_VISUAL_COLLISION_GAP = 16;
const TASK_EDGE_MIN_CONTROL_OFFSET = 32;

/**
 * Task Blueprint의 명시적인 task-local 좌표를 World Node와 Edge geometry로 변환한다.
 *
 * @param tasks 같은 Graph World에 표시할 Task Blueprint 목록
 * @returns Task 전용 Node geometry와 Edge 목록
 */
export function createTaskGraphLayout(
	tasks: readonly TaskBlueprint[],
	options: TaskGraphLayoutOptions = {},
): TaskGraphLayout {
	const nodes: TaskLayoutNode[] = [];
	const edges: TaskLayoutEdge[] = [];

	for (const task of tasks) {
		const taskLayout = createTaskLayout(task, options);

		nodes.push(...taskLayout.nodes);
		edges.push(...taskLayout.edges);
	}

	return { nodes, edges };
}

/**
 * 실제 Scope 크기를 포함한 Work visual bounds가 겹치면 뒤쪽 Work의 Domain 위치를
 * 아래로 이동할 immutable Blueprint 목록을 계산한다. x/lane과 기존 순서는 보존한다.
 */
export function resolveTaskGraphWorkVisualCollisions(
	tasks: readonly TaskBlueprint[],
	layout: TaskGraphLayout,
): readonly TaskBlueprint[] {
	const orderedWorks = layout.nodes
		.map((node, index) => ({ node, index }))
		.filter((entry): entry is {
			readonly node: TaskWorkLayoutNode;
			readonly index: number;
		} => entry.node.kind === 'work')
		.sort((left, right) => (
			left.node.position.y - right.node.position.y
			|| left.node.position.x - right.node.position.x
			|| left.index - right.index
		));
	const fixedNodeBounds: TaskLayoutBounds[] = layout.nodes
		.filter((node) => node.kind !== 'work')
		.map((node) => ({
			position: node.position,
			width: node.width,
			height: node.height,
		}));
	const placedBounds: TaskLayoutBounds[] = [];
	const shiftByNodeKey = new Map<string, number>();

	for (const { node } of orderedWorks) {
		let shiftY = 0;

		// 동적으로 넓어진 WORK는 visualBounds와 node.width가 동일하므로 기본
		// 최소 폭과 비교해 START/END fixed bounds 충돌 검사를 유지한다.
		const collisionBounds = (node.width > TASK_NODE_WIDTH
			? [...fixedNodeBounds, ...placedBounds]
			: [...placedBounds])
			.sort((left, right) => (
				left.position.y - right.position.y
				|| left.position.x - right.position.x
			));

		for (const placed of collisionBounds) {
			if (!haveHorizontalOverlap(node.visualBounds, placed)) {
				continue;
			}
			const shiftedTop = node.visualBounds.position.y + shiftY;
			const shiftedBottom = shiftedTop + node.visualBounds.height;
			const placedTop = placed.position.y;
			const placedBottom = placedTop + placed.height;

			if (
				shiftedBottom > placedTop - TASK_WORK_VISUAL_COLLISION_GAP
				&& shiftedTop < placedBottom + TASK_WORK_VISUAL_COLLISION_GAP
			) {
				shiftY = Math.max(
					shiftY,
					placedBottom
						+ TASK_WORK_VISUAL_COLLISION_GAP
						- node.visualBounds.position.y,
				);
			}
		}

		placedBounds.push({
			...node.visualBounds,
			position: {
				x: node.visualBounds.position.x,
				y: node.visualBounds.position.y + shiftY,
			},
		});
		if (shiftY > 0) {
			shiftByNodeKey.set(createTaskLayoutNodeKey(node.taskId, node.id), shiftY);
		}
	}

	if (shiftByNodeKey.size === 0) {
		return tasks;
	}
	return tasks.map((task) => {
		const nodePositions = { ...task.nodePositions };
		let changed = false;

		for (const node of task.nodes) {
			if (node.kind !== 'work') {
				continue;
			}
			const shiftY = shiftByNodeKey.get(createTaskLayoutNodeKey(task.id, node.id));
			const position = nodePositions[node.id];

			if (!shiftY || !position) {
				continue;
			}
			nodePositions[node.id] = { x: position.x, y: position.y + shiftY };
			changed = true;
		}
		return changed ? { ...task, nodePositions } : task;
	});
}

function haveHorizontalOverlap(
	left: TaskLayoutBounds,
	right: TaskLayoutBounds,
): boolean {
	return left.position.x < right.position.x + right.width
		&& left.position.x + left.width > right.position.x;
}

function createTaskLayoutNodeKey(taskId: string, nodeId: string): string {
	return `${taskId}\u0000${nodeId}`;
}

/** 내부 Node/Edge ID lookup이 다른 Task와 섞이지 않도록 한 Task만 Layout한다. */
function createTaskLayout(
	task: TaskBlueprint,
	options: TaskGraphLayoutOptions,
): TaskGraphLayout {
	assertValidTaskBlueprint(task);
	const flowAnalysis = getTaskFlowAnalysis(task);
	const flowState = flowAnalysis.status;
	const taskConnected = flowState === 'ready';
	const boundaryConnectionState: TaskNodeConnectionState = taskConnected
		? 'connected'
		: 'disconnected';
	const nodes: TaskLayoutNode[] = task.nodes.map((node) => {
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
			width: TASK_NODE_WIDTH,
			height: TASK_NODE_HEIGHT,
		};

		if (node.kind === 'start') {
			return {
				...base,
				kind: node.kind,
				title: task.title,
				description: task.description,
				connectionState: boundaryConnectionState,
			};
		} else if (node.kind === 'work') {
			const graphTargets = node.graphTargets ?? {
				reference: [],
				work: [],
			};
			const scopeAreas = createTaskGraphTargetAreaLayouts(
				task.id,
				node.id,
				base.position,
				graphTargets,
				options,
			);
			const referenceArea = scopeAreas.reference;
			const synchronizedWidth = referenceArea.width;

			return {
				...base,
				width: synchronizedWidth,
				kind: node.kind,
				title: node.title,
				description: node.description,
				prompt: node.prompt,
				graphTargets,
				scopeAreas,
				visualBounds: {
					position: referenceArea.position,
					width: synchronizedWidth,
					height: base.position.y + TASK_NODE_HEIGHT
						- referenceArea.position.y,
				},
				canRemove: true,
				connectionState: flowAnalysis.connectedNodeIds.has(node.id)
					? 'connected'
					: 'disconnected',
			};
		} else {
			return {
				...base,
				kind: node.kind,
				title: task.title,
				description: task.description,
				connectionState: boundaryConnectionState,
			};
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

/** Work Card top-left 하나에서 Work/Reference Area 위치를 역방향으로 파생한다. */
function createTaskGraphTargetAreaLayouts(
	taskId: string,
	nodeId: string,
	workPosition: TaskLayoutPosition,
	graphTargets: WorkGraphTargets,
	options: TaskGraphLayoutOptions,
): Readonly<Record<TaskGraphTargetAreaKind, TaskGraphTargetAreaLayout>> {
	const resolveFootprintSize = (
		area: TaskGraphTargetAreaKind,
		sourceIds: readonly string[],
	): TaskGraphTargetAreaSize => {
		const resolved = options.resolveGraphTargetAreaSize?.(
			taskId,
			nodeId,
			area,
			sourceIds,
		);

		return {
			width: Math.max(TASK_NODE_WIDTH, resolved?.width ?? TASK_NODE_WIDTH),
			height: Math.max(
				TASK_SCOPE_AREA_MIN_HEIGHT,
				resolved?.height ?? TASK_SCOPE_AREA_MIN_HEIGHT,
			),
		};
	};
	const workSize = resolveFootprintSize('work', graphTargets.work);
	const referenceSize = resolveFootprintSize('reference', graphTargets.reference);
	// Reference와 Work 중 더 넓은 actual Graph footprint를 WORK visual 전체의
	// 단일 폭으로 사용한다. 어느 한쪽의 subtree가 열리고 닫힐 때 두 Region과
	// 실제 WORK Card가 항상 같은 left/right boundary를 공유한다.
	const synchronizedWidth = Math.max(referenceSize.width, workSize.width);
	const workTop = workPosition.y - TASK_SCOPE_AREA_GAP - workSize.height;
	const referenceTop = workTop - TASK_SCOPE_AREA_GAP - referenceSize.height;

	return {
		reference: {
			kind: 'reference',
			position: {
				x: workPosition.x,
				y: referenceTop,
			},
			width: synchronizedWidth,
			height: referenceSize.height,
			sourceIds: graphTargets.reference,
		},
		work: {
			kind: 'work',
			position: {
				x: workPosition.x,
				y: workTop,
			},
			width: synchronizedWidth,
			height: workSize.height,
			sourceIds: graphTargets.work,
		},
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
