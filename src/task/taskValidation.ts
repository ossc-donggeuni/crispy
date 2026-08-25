import type { TaskBlueprint, TaskEdge, TaskGraphTargets } from './taskModel';

/** Task Blueprint validation에서 구분하는 구조 오류다. */
export type TaskValidationIssueCode =
	| 'start_node_count'
	| 'end_node_count'
	| 'duplicate_node_id'
	| 'invalid_graph_targets'
	| 'duplicate_graph_target'
	| 'node_position_missing'
	| 'node_position_extra'
	| 'start_node_position'
	| 'invalid_node_position'
	| 'duplicate_edge_id'
	| 'duplicate_edge'
	| 'edge_source_missing'
	| 'edge_target_missing'
	| 'start_node_incoming'
	| 'end_node_outgoing'
	| 'start_end_direct_edge'
	| 'self_edge'
	| 'cycle';

/** Task DAG가 실행 가능한 흐름인지 구분한다. */
export type TaskFlowStatus = 'ready' | 'incomplete';

/** START에서 END까지 완성된 실행 경로와 그 경로에 참여하는 Node를 나타낸다. */
export interface TaskFlowAnalysis {
	readonly status: TaskFlowStatus;
	readonly connectedNodeIds: ReadonlySet<string>;
}

/** 호출자가 오류 원인과 관련 Node/Edge를 식별할 수 있는 validation 결과다. */
export interface TaskValidationIssue {
	readonly code: TaskValidationIssueCode;
	readonly message: string;
	readonly nodeId?: string;
	readonly edgeId?: string;
}

/**
 * Task Blueprint의 최소 DAG 불변 조건을 검사한다.
 * 오류를 한 번에 돌려주며 입력 Blueprint는 변경하지 않는다.
 *
 * @param blueprint 검사할 Task Blueprint
 * @returns 발견 순서대로 정렬된 validation issue 목록
 */
export function validateTaskBlueprint(
	blueprint: TaskBlueprint,
): readonly TaskValidationIssue[] {
	const issues: TaskValidationIssue[] = [];
	const startCount = blueprint.nodes.filter((node) => node.kind === 'start').length;
	const endCount = blueprint.nodes.filter((node) => node.kind === 'end').length;

	validateGraphTargets(
		(blueprint as TaskBlueprint & {
			readonly defaultGraphTargets?: unknown;
		}).defaultGraphTargets,
		issues,
		{ label: 'Task default' },
	);

	if (startCount !== 1) {
		issues.push({
			code: 'start_node_count',
			message: `Task must contain exactly one start node; found ${startCount}.`,
		});
	}

	if (endCount !== 1) {
		issues.push({
			code: 'end_node_count',
			message: `Task must contain exactly one end node; found ${endCount}.`,
		});
	}

	const nodeIds = new Set<string>();
	const nodesById = new Map(blueprint.nodes.map((node) => [node.id, node]));
	for (const node of blueprint.nodes) {
		if (nodeIds.has(node.id)) {
			issues.push({
				code: 'duplicate_node_id',
				message: `Task node ID must be unique: ${node.id}.`,
				nodeId: node.id,
			});
		}
		nodeIds.add(node.id);

		if (node.kind === 'work') {
			validateGraphTargets(
				(node as typeof node & { readonly graphTargets?: unknown }).graphTargets,
				issues,
				{ label: 'Work', nodeId: node.id },
			);
		}
	}

	const nodePositions = blueprint.nodePositions ?? {};
	for (const node of blueprint.nodes) {
		if (node.kind !== 'start' && !Object.hasOwn(nodePositions, node.id)) {
			issues.push({
				code: 'node_position_missing',
				message: `Task node position is required: ${node.id}.`,
				nodeId: node.id,
			});
		}
	}

	for (const [nodeId, position] of Object.entries(nodePositions)) {
		const node = nodesById.get(nodeId);

		if (!node) {
			issues.push({
				code: 'node_position_extra',
				message: `Task node position must reference an existing node: ${nodeId}.`,
				nodeId,
			});
			continue;
		}
		if (node.kind === 'start') {
			issues.push({
				code: 'start_node_position',
				message: `Task start node cannot have an explicit position: ${nodeId}.`,
				nodeId,
			});
		}
		if (
			typeof position?.x !== 'number'
			|| !Number.isFinite(position.x)
			|| typeof position?.y !== 'number'
			|| !Number.isFinite(position.y)
		) {
			issues.push({
				code: 'invalid_node_position',
				message: `Task node position must contain finite coordinates: ${nodeId}.`,
				nodeId,
			});
		}
	}

	const edgeIds = new Set<string>();
	const edgeConnections = new Set<string>();
	for (const edge of blueprint.edges) {
		if (edgeIds.has(edge.id)) {
			issues.push({
				code: 'duplicate_edge_id',
				message: `Task edge ID must be unique: ${edge.id}.`,
				edgeId: edge.id,
			});
		}
		edgeIds.add(edge.id);
		const connectionKey = createEdgeConnectionKey(edge.source, edge.target);

		if (edgeConnections.has(connectionKey)) {
			issues.push({
				code: 'duplicate_edge',
				message: `Task edge connection must be unique: ${edge.source} -> ${edge.target}.`,
				edgeId: edge.id,
			});
		}
		edgeConnections.add(connectionKey);

		if (!nodeIds.has(edge.source)) {
			issues.push({
				code: 'edge_source_missing',
				message: `Task edge source does not exist: ${edge.source}.`,
				edgeId: edge.id,
				nodeId: edge.source,
			});
		}

		if (!nodeIds.has(edge.target)) {
			issues.push({
				code: 'edge_target_missing',
				message: `Task edge target does not exist: ${edge.target}.`,
				edgeId: edge.id,
				nodeId: edge.target,
			});
		}

		if (nodesById.get(edge.target)?.kind === 'start') {
			issues.push({
				code: 'start_node_incoming',
				message: `Task start node cannot have an incoming edge: ${edge.id}.`,
				edgeId: edge.id,
				nodeId: edge.target,
			});
		}

		if (nodesById.get(edge.source)?.kind === 'end') {
			issues.push({
				code: 'end_node_outgoing',
				message: `Task end node cannot have an outgoing edge: ${edge.id}.`,
				edgeId: edge.id,
				nodeId: edge.source,
			});
		}

		if (
			nodesById.get(edge.source)?.kind === 'start'
			&& nodesById.get(edge.target)?.kind === 'end'
		) {
			issues.push({
				code: 'start_end_direct_edge',
				message: `Task start node cannot connect directly to end node: ${edge.id}.`,
				edgeId: edge.id,
			});
		}

		if (edge.source === edge.target) {
			issues.push({
				code: 'self_edge',
				message: `Task edge cannot connect a node to itself: ${edge.id}.`,
				edgeId: edge.id,
				nodeId: edge.source,
			});
		}
	}

	if (containsCycle(nodeIds, blueprint.edges)) {
		issues.push({
			code: 'cycle',
			message: 'Task edges must form an acyclic graph.',
		});
	}

	return issues;
}

/** legacy 누락은 허용하되 저장된 Graph Target의 배열/중복 불변성은 검사한다. */
function validateGraphTargets(
	graphTargets: unknown,
	issues: TaskValidationIssue[],
	owner: { readonly label: string; readonly nodeId?: string },
): void {
	if (graphTargets === undefined) {
		return;
	}
	if (
		typeof graphTargets !== 'object'
		|| graphTargets === null
		|| !Array.isArray((graphTargets as { readonly reference?: unknown }).reference)
		|| !Array.isArray((graphTargets as { readonly work?: unknown }).work)
	) {
		issues.push({
			code: 'invalid_graph_targets',
			message: `${owner.label} graphTargets must contain reference/work arrays.`,
			...(owner.nodeId ? { nodeId: owner.nodeId } : {}),
		});
		return;
	}

	const reference = (graphTargets as TaskGraphTargets).reference;
	const work = (graphTargets as TaskGraphTargets).work;
	const invalidTarget = [...reference, ...work].some((target) => (
		typeof target !== 'string' || target.length === 0
	));

	if (invalidTarget) {
		issues.push({
			code: 'invalid_graph_targets',
			message: `${owner.label} graphTargets must contain non-empty Source IDs.`,
			...(owner.nodeId ? { nodeId: owner.nodeId } : {}),
		});
	}

	for (const targets of [reference, work]) {
		const sourceIds = targets.filter((target): target is string => (
			typeof target === 'string'
		));

		if (new Set(sourceIds).size !== sourceIds.length) {
			issues.push({
				code: 'duplicate_graph_target',
				message: `${owner.label} graph target must be unique inside an area.`,
				...(owner.nodeId ? { nodeId: owner.nodeId } : {}),
			});
			break;
		}
	}

}

/** Source와 target 문자열 경계를 보존하는 Edge 연결 identity다. */
function createEdgeConnectionKey(sourceId: string, targetId: string): string {
	return JSON.stringify([sourceId, targetId]);
}

/** 유효하지 않은 Task Blueprint를 상태에 넣기 전에 예외로 거부한다. */
export function assertValidTaskBlueprint(blueprint: TaskBlueprint): void {
	const issues = validateTaskBlueprint(blueprint);

	if (issues.length > 0) {
		throw new Error(
			`Invalid TaskBlueprint: ${issues.map((issue) => issue.message).join(' ')}`,
		);
	}
}

/**
 * Structurally valid Task에 Start에서 End까지 완성된 실행 경로가 있는지 판별한다.
 * 편집 중의 disconnected Task는 정상 Blueprint이지만 incomplete이다.
 */
export function getTaskFlowStatus(blueprint: TaskBlueprint): TaskFlowStatus {
	return getTaskFlowAnalysis(blueprint).status;
}

/** START 순방향과 END 역방향 reachability의 교집합으로 완성 경로를 분석한다. */
export function getTaskFlowAnalysis(
	blueprint: TaskBlueprint,
): TaskFlowAnalysis {
	if (validateTaskBlueprint(blueprint).length > 0) {
		return { status: 'incomplete', connectedNodeIds: new Set() };
	}

	const start = blueprint.nodes.find((node) => node.kind === 'start');
	const end = blueprint.nodes.find((node) => node.kind === 'end');
	if (!start || !end) {
		return { status: 'incomplete', connectedNodeIds: new Set() };
	}

	const outgoingByNodeId = new Map(blueprint.nodes.map((node) => (
		[node.id, [] as string[]]
	)));
	const incomingByNodeId = new Map(blueprint.nodes.map((node) => (
		[node.id, [] as string[]]
	)));

	for (const edge of blueprint.edges) {
		outgoingByNodeId.get(edge.source)?.push(edge.target);
		incomingByNodeId.get(edge.target)?.push(edge.source);
	}

	const reachableFromStart = collectReachableNodes(start.id, outgoingByNodeId);
	const reachingEnd = collectReachableNodes(end.id, incomingByNodeId);
	if (!reachableFromStart.has(end.id)) {
		return { status: 'incomplete', connectedNodeIds: new Set() };
	}
	const connectedNodeIds = new Set(blueprint.nodes.flatMap((node) => (
		reachableFromStart.has(node.id) && reachingEnd.has(node.id)
			? [node.id]
			: []
	)));
	const hasIncompleteBoundaryConnection = blueprint.nodes.some((node) => (
		node.kind === 'work'
		&& reachableFromStart.has(node.id) !== reachingEnd.has(node.id)
	));

	return {
		status: hasIncompleteBoundaryConnection ? 'incomplete' : 'ready',
		connectedNodeIds,
	};
}

/** 인접 Node map을 따라 시작 Node에서 도달 가능한 ID를 모은다. */
function collectReachableNodes(
	startNodeId: string,
	adjacentByNodeId: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
	const reachable = new Set<string>();
	const pending = [startNodeId];

	while (pending.length > 0) {
		const nodeId = pending.pop();
		if (!nodeId || reachable.has(nodeId)) {
			continue;
		}

		reachable.add(nodeId);
		pending.push(...(adjacentByNodeId.get(nodeId) ?? []));
	}

	return reachable;
}

/** 존재하는 Node 사이의 non-self Edge만으로 directed cycle을 검사한다. */
function containsCycle(
	nodeIds: ReadonlySet<string>,
	edges: readonly TaskEdge[],
): boolean {
	const targetsBySource = new Map<string, string[]>();

	for (const nodeId of nodeIds) {
		targetsBySource.set(nodeId, []);
	}

	for (const edge of edges) {
		if (
			edge.source !== edge.target
			&& nodeIds.has(edge.source)
			&& nodeIds.has(edge.target)
		) {
			targetsBySource.get(edge.source)?.push(edge.target);
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (nodeId: string): boolean => {
		if (visiting.has(nodeId)) {
			return true;
		}
		if (visited.has(nodeId)) {
			return false;
		}

		visiting.add(nodeId);
		for (const targetId of targetsBySource.get(nodeId) ?? []) {
			if (visit(targetId)) {
				return true;
			}
		}
		visiting.delete(nodeId);
		visited.add(nodeId);
		return false;
	};

	for (const nodeId of nodeIds) {
		if (visit(nodeId)) {
			return true;
		}
	}

	return false;
}
