import type { TaskBlueprint, TaskEdge } from './taskModel';

/** Task Blueprint validation에서 구분하는 구조 오류다. */
export type TaskValidationIssueCode =
	| 'start_node_count'
	| 'end_node_count'
	| 'duplicate_node_id'
	| 'duplicate_edge_id'
	| 'edge_source_missing'
	| 'edge_target_missing'
	| 'self_edge'
	| 'cycle';

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
	for (const node of blueprint.nodes) {
		if (nodeIds.has(node.id)) {
			issues.push({
				code: 'duplicate_node_id',
				message: `Task node ID must be unique: ${node.id}.`,
				nodeId: node.id,
			});
		}
		nodeIds.add(node.id);
	}

	const edgeIds = new Set<string>();
	for (const edge of blueprint.edges) {
		if (edgeIds.has(edge.id)) {
			issues.push({
				code: 'duplicate_edge_id',
				message: `Task edge ID must be unique: ${edge.id}.`,
				edgeId: edge.id,
			});
		}
		edgeIds.add(edge.id);

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

/** 유효하지 않은 Task Blueprint를 상태에 넣기 전에 예외로 거부한다. */
export function assertValidTaskBlueprint(blueprint: TaskBlueprint): void {
	const issues = validateTaskBlueprint(blueprint);

	if (issues.length > 0) {
		throw new Error(
			`Invalid TaskBlueprint: ${issues.map((issue) => issue.message).join(' ')}`,
		);
	}
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
