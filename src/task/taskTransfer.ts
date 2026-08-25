import {
	createTaskEdgeId,
	createTaskNodeId,
	isWorkAgentProviderId,
	resolveWorkAgentProviderId,
	TASK_BLUEPRINT_VERSION,
	type EndNode,
	type StartNode,
	type TaskBlueprint,
	type TaskIdSource,
	type TaskNodePosition,
	type WorkAgentProviderId,
	type WorkNode,
} from './taskModel';
import {
	assertValidTaskBlueprint,
	validateTaskBlueprint,
	type TaskValidationIssue,
	type TaskValidationIssueCode,
} from './taskValidation';

/** Clipboard로 교환하는 Crispy Task 문서의 고정 식별자다. */
export const TASK_TRANSFER_FORMAT = 'crispy.task';

/** 현재 읽고 쓸 수 있는 Task transfer 문서 버전이다. */
export const TASK_TRANSFER_VERSION = 1;

/** Extension Host와 Webview가 함께 적용하는 UTF-8 JSON 최대 크기다. */
export const TASK_TRANSFER_JSON_MAX_BYTES = 1024 * 1024;

/** 외부 JSON이 과도한 메모리나 Graph 작업을 유발하지 않도록 두는 경계다. */
export const TASK_TRANSFER_LIMITS = Object.freeze({
	maxJsonBytes: TASK_TRANSFER_JSON_MAX_BYTES,
	maxNodes: 512,
	maxEdges: 4096,
	maxNodeKeyLength: 256,
	maxTextLength: 1024 * 1024,
});

/** 전송 문서 안에서만 유효한 Start 표현이다. */
export interface TaskTransferStartNode {
	readonly key: string;
	readonly kind: 'start';
}

/** 전송 문서 안에서만 유효한 Work와 inspector 입력 상태다. */
export interface TaskTransferWorkNode {
	readonly key: string;
	readonly kind: 'work';
	readonly title: string;
	readonly description: string;
	readonly prompt: string;
	readonly agentProviderId: WorkAgentProviderId;
	readonly position: TaskNodePosition;
}

/** 전송 문서 안에서만 유효한 End 표현이다. */
export interface TaskTransferEndNode {
	readonly key: string;
	readonly kind: 'end';
	readonly position: TaskNodePosition;
}

/** 런타임 ID 대신 문서 로컬 key를 가지는 Task Node다. */
export type TaskTransferNode =
	| TaskTransferStartNode
	| TaskTransferWorkNode
	| TaskTransferEndNode;

/** 문서 로컬 Node key를 잇는 전송용 Edge다. */
export interface TaskTransferEdge {
	readonly source: string;
	readonly target: string;
}

/** Workspace 범위와 world origin을 의도적으로 제외한 전송 payload다. */
export interface TaskTransferTask {
	readonly title: string;
	readonly description: string;
	readonly nodes: readonly TaskTransferNode[];
	readonly edges: readonly TaskTransferEdge[];
}

/** Clipboard JSON의 최상위 envelope다. */
export interface TaskTransferDocument {
	readonly format: typeof TASK_TRANSFER_FORMAT;
	readonly version: typeof TASK_TRANSFER_VERSION;
	readonly task: TaskTransferTask;
}

/** 외부 JSON 경계에서 구분하는 형식 또는 Task DAG 오류다. */
export type TaskTransferIssueCode =
	| 'invalid_json'
	| 'document_too_large'
	| 'invalid_type'
	| 'missing_property'
	| 'unknown_property'
	| 'invalid_value'
	| 'limit_exceeded'
	| TaskValidationIssueCode;

/** 사용자가 수정할 위치와 원인을 함께 표시할 수 있는 import 오류다. */
export interface TaskTransferIssue {
	readonly code: TaskTransferIssueCode;
	readonly path: string;
	readonly message: string;
}

export interface TaskTransferParseSuccess {
	readonly ok: true;
	readonly document: TaskTransferDocument;
}

export interface TaskTransferParseFailure {
	readonly ok: false;
	readonly issues: readonly TaskTransferIssue[];
}

/** 외부 JSON은 성공한 경우에만 typed transfer 문서로 노출한다. */
export type TaskTransferParseResult =
	| TaskTransferParseSuccess
	| TaskTransferParseFailure;

/**
 * 내부 Task를 사람이 복사할 수 있는 안정적인 JSON 문서로 직렬화한다.
 * 런타임 ID, world origin과 모든 Workspace Graph Target은 포함하지 않는다.
 */
export function serializeTaskTransfer(task: TaskBlueprint): string {
	assertValidTaskBlueprint(task);

	const keyByNodeId = new Map<string, string>();
	let workSequence = 0;
	for (const node of task.nodes) {
		keyByNodeId.set(
			node.id,
			node.kind === 'start'
				? 'start'
				: node.kind === 'end'
					? 'end'
					: `work-${++workSequence}`,
		);
	}

	const document: TaskTransferDocument = {
		format: TASK_TRANSFER_FORMAT,
		version: TASK_TRANSFER_VERSION,
		task: {
			title: task.title,
			description: task.description,
			nodes: task.nodes.map((node) => createTransferNode(
				node,
				readNodeKey(keyByNodeId, node.id),
				task.nodePositions,
			)),
			edges: task.edges.map((edge) => ({
				source: readNodeKey(keyByNodeId, edge.source),
				target: readNodeKey(keyByNodeId, edge.target),
			})),
		},
	};
	const json = JSON.stringify(document, undefined, 2);
	const verification = parseTaskTransferJson(json);

	if (!verification.ok) {
		throw new Error(
			`Task cannot be exported: ${verification.issues
				.map((issue) => issue.message)
				.join(' ')}`,
		);
	}

	return json;
}

/**
 * 신뢰할 수 없는 Clipboard 문자열을 strict Task transfer 문서로 파싱한다.
 * 알 수 없는 필드도 거부해 Workspace 경로나 향후 의미가 조용히 섞이지 않게 한다.
 */
export function parseTaskTransferJson(json: string): TaskTransferParseResult {
	if (typeof json !== 'string') {
		return failure({
			code: 'invalid_type',
			path: '$',
			message: 'Task transfer input must be a JSON string.',
		});
	}
	if (
		json.length > TASK_TRANSFER_JSON_MAX_BYTES
		|| new TextEncoder().encode(json).byteLength > TASK_TRANSFER_JSON_MAX_BYTES
	) {
		return failure({
			code: 'document_too_large',
			path: '$',
			message: `Task transfer JSON must not exceed ${TASK_TRANSFER_JSON_MAX_BYTES} UTF-8 bytes.`,
		});
	}

	let input: unknown;
	try {
		input = JSON.parse(json) as unknown;
	} catch (error) {
		return failure({
			code: 'invalid_json',
			path: '$',
			message: `Task transfer is not valid JSON: ${readErrorMessage(error)}`,
		});
	}

	const issues: TaskTransferIssue[] = [];
	const document = parseTransferDocument(input, issues);

	if (!document) {
		return { ok: false, issues };
	}

	validateTransferTask(document, issues);
	return issues.length > 0
		? { ok: false, issues }
		: { ok: true, document };
}

/**
 * 파싱된 전송 문서를 사용자가 import를 누른 기존 Task 자리에 materialize한다.
 * 기존 Task/Start/End identity와 world origin만 유지하고 나머지는 문서에서 복원한다.
 */
export function materializeTaskTransfer(
	document: TaskTransferDocument,
	currentTask: TaskBlueprint,
	createId?: TaskIdSource,
): TaskBlueprint {
	assertValidTaskBlueprint(currentTask);

	const documentVerification = parseTaskTransferJson(
		JSON.stringify(document),
	);
	if (!documentVerification.ok) {
		throw new Error(
			`Invalid TaskTransferDocument: ${documentVerification.issues
				.map((issue) => issue.message)
				.join(' ')}`,
		);
	}

	const start = findSingleNode(currentTask, 'start');
	const end = findSingleNode(currentTask, 'end');
	const nodeIdByKey = new Map<string, string>();
	const nodes = documentVerification.document.task.nodes.map((node) => {
		if (node.kind === 'start') {
			nodeIdByKey.set(node.key, start.id);
			return { id: start.id, kind: 'start' } satisfies StartNode;
		}
		if (node.kind === 'end') {
			nodeIdByKey.set(node.key, end.id);
			return { id: end.id, kind: 'end' } satisfies EndNode;
		}

		const id = createTaskNodeId(createId);
		nodeIdByKey.set(node.key, id);
		return {
			id,
			kind: 'work',
			title: node.title,
			description: node.description,
			prompt: node.prompt,
			agentProviderId: node.agentProviderId,
			graphTargets: { reference: [], work: [] },
		} satisfies WorkNode;
	});
	const nodePositions = Object.fromEntries(
		documentVerification.document.task.nodes.flatMap((node) => (
			node.kind === 'start'
				? []
				: [[readNodeKey(nodeIdByKey, node.key), {
					x: node.position.x,
					y: node.position.y,
				}] as const]
		)),
	);
	const edges = documentVerification.document.task.edges.map((edge) => ({
		id: createTaskEdgeId(createId),
		source: readNodeKey(nodeIdByKey, edge.source),
		target: readNodeKey(nodeIdByKey, edge.target),
	}));
	const materialized: TaskBlueprint = {
		version: TASK_BLUEPRINT_VERSION,
		id: currentTask.id,
		title: documentVerification.document.task.title,
		description: documentVerification.document.task.description,
		defaultGraphTargets: { reference: [], work: [] },
		origin: { x: currentTask.origin.x, y: currentTask.origin.y },
		nodePositions,
		nodes,
		edges,
	};

	assertValidTaskBlueprint(materialized);
	return materialized;
}

/** 내부 Node를 Workspace 상태가 없는 문서 Node로 바꾼다. */
function createTransferNode(
	node: TaskBlueprint['nodes'][number],
	key: string,
	positions: TaskBlueprint['nodePositions'],
): TaskTransferNode {
	if (node.kind === 'start') {
		return { key, kind: 'start' };
	}

	const position = positions[node.id];
	if (!position) {
		throw new Error(`Task node position is missing: ${node.id}.`);
	}
	const copiedPosition = { x: position.x, y: position.y };

	if (node.kind === 'end') {
		return { key, kind: 'end', position: copiedPosition };
	}

	return {
		key,
		kind: 'work',
		title: node.title,
		description: node.description,
		prompt: node.prompt,
		agentProviderId: resolveWorkAgentProviderId(node),
		position: copiedPosition,
	};
}

/** Root envelope와 payload schema를 검사하고 알려진 값만 새 객체로 복사한다. */
function parseTransferDocument(
	input: unknown,
	issues: TaskTransferIssue[],
): TaskTransferDocument | undefined {
	const root = readObject(input, '$', issues);
	if (!root) {
		return undefined;
	}

	validateProperties(
		root,
		'$',
		['format', 'version', 'task'],
		['format', 'version', 'task'],
		issues,
	);
	const format = readLiteral(
		root,
		'format',
		TASK_TRANSFER_FORMAT,
		'$.format',
		issues,
	);
	const version = readLiteral(
		root,
		'version',
		TASK_TRANSFER_VERSION,
		'$.version',
		issues,
	);
	const task = parseTransferTask(root.task, '$.task', issues);

	if (
		format !== TASK_TRANSFER_FORMAT
		|| version !== TASK_TRANSFER_VERSION
		|| !task
	) {
		return undefined;
	}

	return { format, version, task };
}

/** Task payload의 inspector 문자열, Node와 Edge 배열을 strict하게 읽는다. */
function parseTransferTask(
	input: unknown,
	path: string,
	issues: TaskTransferIssue[],
): TaskTransferTask | undefined {
	const issueCount = issues.length;
	const task = readObject(input, path, issues);
	if (!task) {
		return undefined;
	}

	validateProperties(
		task,
		path,
		['title', 'description', 'nodes', 'edges'],
		['title', 'description', 'nodes', 'edges'],
		issues,
	);
	const title = readText(task, 'title', `${path}.title`, issues);
	const description = readText(
		task,
		'description',
		`${path}.description`,
		issues,
	);
	const nodes = parseArray(
		task.nodes,
		`${path}.nodes`,
		TASK_TRANSFER_LIMITS.maxNodes,
		'Task transfer nodes',
		parseTransferNode,
		issues,
	);
	const edges = parseArray(
		task.edges,
		`${path}.edges`,
		TASK_TRANSFER_LIMITS.maxEdges,
		'Task transfer edges',
		parseTransferEdge,
		issues,
	);

	if (
		issues.length !== issueCount
		|| title === undefined
		|| description === undefined
		|| !nodes
		|| !edges
	) {
		return undefined;
	}

	return { title, description, nodes, edges };
}

/** kind별 허용 필드와 필수 inspector/position 값을 검사한다. */
function parseTransferNode(
	input: unknown,
	path: string,
	issues: TaskTransferIssue[],
): TaskTransferNode | undefined {
	const issueCount = issues.length;
	const node = readObject(input, path, issues);
	if (!node) {
		return undefined;
	}

	const kind = readNodeKind(node, `${path}.kind`, issues);
	if (!kind) {
		validateProperties(
			node,
			path,
			[
				'key',
				'kind',
				'title',
				'description',
				'prompt',
				'agentProviderId',
				'position',
			],
			['key', 'kind'],
			issues,
		);
		return undefined;
	}

	if (kind === 'start') {
		validateProperties(node, path, ['key', 'kind'], ['key', 'kind'], issues);
		const key = readNodeKeyValue(node, 'key', `${path}.key`, issues);

		return issues.length === issueCount && key !== undefined
			? { key, kind }
			: undefined;
	}

	if (kind === 'end') {
		validateProperties(
			node,
			path,
			['key', 'kind', 'position'],
			['key', 'kind', 'position'],
			issues,
		);
		const key = readNodeKeyValue(node, 'key', `${path}.key`, issues);
		const position = parsePosition(node.position, `${path}.position`, issues);

		return issues.length === issueCount && key !== undefined && position
			? { key, kind, position }
			: undefined;
	}

	validateProperties(
		node,
		path,
		[
			'key',
			'kind',
			'title',
			'description',
			'prompt',
			'agentProviderId',
			'position',
		],
		[
			'key',
			'kind',
			'title',
			'description',
			'prompt',
			'agentProviderId',
			'position',
		],
		issues,
	);
	const key = readNodeKeyValue(node, 'key', `${path}.key`, issues);
	const title = readText(node, 'title', `${path}.title`, issues);
	const description = readText(
		node,
		'description',
		`${path}.description`,
		issues,
	);
	const prompt = readText(node, 'prompt', `${path}.prompt`, issues);
	const agentProviderId = readAgentProvider(
		node,
		`${path}.agentProviderId`,
		issues,
	);
	const position = parsePosition(node.position, `${path}.position`, issues);

	return (
		issues.length === issueCount
		&& key !== undefined
		&& title !== undefined
		&& description !== undefined
		&& prompt !== undefined
		&& agentProviderId !== undefined
		&& position
	)
		? {
			key,
			kind,
			title,
			description,
			prompt,
			agentProviderId,
			position,
		}
		: undefined;
}

/** Edge endpoint가 문서 로컬 non-empty key인지 검사한다. */
function parseTransferEdge(
	input: unknown,
	path: string,
	issues: TaskTransferIssue[],
): TaskTransferEdge | undefined {
	const issueCount = issues.length;
	const edge = readObject(input, path, issues);
	if (!edge) {
		return undefined;
	}

	validateProperties(
		edge,
		path,
		['source', 'target'],
		['source', 'target'],
		issues,
	);
	const source = readNodeKeyValue(edge, 'source', `${path}.source`, issues);
	const target = readNodeKeyValue(edge, 'target', `${path}.target`, issues);

	return issues.length === issueCount && source !== undefined && target !== undefined
		? { source, target }
		: undefined;
}

/** x/y 외 필드를 허용하지 않고 두 좌표 모두 finite number인지 검사한다. */
function parsePosition(
	input: unknown,
	path: string,
	issues: TaskTransferIssue[],
): TaskNodePosition | undefined {
	const issueCount = issues.length;
	const position = readObject(input, path, issues);
	if (!position) {
		return undefined;
	}

	validateProperties(position, path, ['x', 'y'], ['x', 'y'], issues);
	const x = readFiniteNumber(position, 'x', `${path}.x`, issues);
	const y = readFiniteNumber(position, 'y', `${path}.y`, issues);

	return issues.length === issueCount && x !== undefined && y !== undefined
		? { x, y }
		: undefined;
}

/** typed transfer를 임시 Blueprint로 변환해 기존 DAG 불변 조건을 재사용한다. */
function validateTransferTask(
	document: TaskTransferDocument,
	issues: TaskTransferIssue[],
): void {
	const duplicateKeys = findDuplicateNodeKeys(document.task.nodes);
	for (const key of duplicateKeys) {
		issues.push({
			code: 'duplicate_node_id',
			path: findNodePath(document, key),
			message: `Task transfer node key must be unique: ${key}.`,
		});
	}
	if (duplicateKeys.length > 0) {
		return;
	}

	const temporary: TaskBlueprint = {
		version: TASK_BLUEPRINT_VERSION,
		id: 'task:transfer-validation',
		title: document.task.title,
		description: document.task.description,
		defaultGraphTargets: { reference: [], work: [] },
		origin: { x: 0, y: 0 },
		nodePositions: Object.fromEntries(document.task.nodes.flatMap((node) => (
			node.kind === 'start' ? [] : [[node.key, node.position] as const]
		))),
		nodes: document.task.nodes.map((node) => {
			if (node.kind === 'work') {
				return {
					id: node.key,
					kind: node.kind,
					title: node.title,
					description: node.description,
					prompt: node.prompt,
					agentProviderId: node.agentProviderId,
					graphTargets: { reference: [], work: [] },
				};
			}

			return { id: node.key, kind: node.kind };
		}),
		edges: document.task.edges.map((edge, index) => ({
			id: `task-edge:transfer-${index}`,
			source: edge.source,
			target: edge.target,
		})),
	};

	for (const issue of validateTaskBlueprint(temporary)) {
		issues.push(createTransferValidationIssue(document, issue));
	}
}

/** 내부 validation issue를 사용자가 입력한 JSON path와 key 중심 메시지로 바꾼다. */
function createTransferValidationIssue(
	document: TaskTransferDocument,
	issue: TaskValidationIssue,
): TaskTransferIssue {
	const edgeIndex = readTemporaryEdgeIndex(issue.edgeId);
	const edge = edgeIndex === undefined
		? undefined
		: document.task.edges[edgeIndex];
	const path = edgeIndex !== undefined
		? `$.task.edges[${edgeIndex}]`
		: issue.nodeId
			? findNodePath(document, issue.nodeId)
			: '$.task';

	return {
		code: issue.code,
		path,
		message: createTransferValidationMessage(document, issue, edge),
	};
}

/** 임시 runtime ID가 드러나지 않는 transfer 전용 DAG 오류 문구를 만든다. */
function createTransferValidationMessage(
	document: TaskTransferDocument,
	issue: TaskValidationIssue,
	edge: TaskTransferEdge | undefined,
): string {
	const edgeLabel = edge ? `${edge.source} -> ${edge.target}` : 'unknown edge';

	switch (issue.code) {
		case 'start_node_count':
			return `Task transfer must contain exactly one start node; found ${countNodes(document, 'start')}.`;
		case 'end_node_count':
			return `Task transfer must contain exactly one end node; found ${countNodes(document, 'end')}.`;
		case 'duplicate_edge':
			return `Task transfer edge connection must be unique: ${edgeLabel}.`;
		case 'edge_source_missing':
			return `Task transfer edge source key does not exist: ${edge?.source ?? issue.nodeId}.`;
		case 'edge_target_missing':
			return `Task transfer edge target key does not exist: ${edge?.target ?? issue.nodeId}.`;
		case 'start_node_incoming':
			return `Task transfer start node cannot have an incoming edge: ${edgeLabel}.`;
		case 'end_node_outgoing':
			return `Task transfer end node cannot have an outgoing edge: ${edgeLabel}.`;
		case 'start_end_direct_edge':
			return `Task transfer start node cannot connect directly to end node: ${edgeLabel}.`;
		case 'self_edge':
			return `Task transfer edge cannot connect a node to itself: ${edgeLabel}.`;
		case 'cycle':
			return 'Task transfer edges must form an acyclic graph.';
		default:
			return issue.message;
	}
}

/** JSON object만 허용한다. */
function readObject(
	input: unknown,
	path: string,
	issues: TaskTransferIssue[],
): Record<string, unknown> | undefined {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		issues.push({
			code: 'invalid_type',
			path,
			message: `${path} must be an object.`,
		});
		return undefined;
	}

	return input as Record<string, unknown>;
}

/** object의 required/allowed property 집합을 동시에 검사한다. */
function validateProperties(
	value: Record<string, unknown>,
	path: string,
	allowed: readonly string[],
	required: readonly string[],
	issues: TaskTransferIssue[],
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) {
			issues.push({
				code: 'unknown_property',
				path: `${path}.${key}`,
				message: `Unknown Task transfer property: ${path}.${key}.`,
			});
		}
	}

	for (const key of required) {
		if (!Object.hasOwn(value, key)) {
			issues.push({
				code: 'missing_property',
				path: `${path}.${key}`,
				message: `Required Task transfer property is missing: ${path}.${key}.`,
			});
		}
	}
}

/** 고정 format/version literal을 읽는다. */
function readLiteral<T extends string | number>(
	value: Record<string, unknown>,
	key: string,
	expected: T,
	path: string,
	issues: TaskTransferIssue[],
): T | undefined {
	if (!Object.hasOwn(value, key)) {
		return undefined;
	}
	if (value[key] !== expected) {
		issues.push({
			code: 'invalid_value',
			path,
			message: `${path} must be ${JSON.stringify(expected)}.`,
		});
		return undefined;
	}

	return expected;
}

/** inspector 문자열을 길이 제한과 함께 읽되 빈 값은 정상 편집 상태로 허용한다. */
function readText(
	value: Record<string, unknown>,
	key: string,
	path: string,
	issues: TaskTransferIssue[],
): string | undefined {
	if (!Object.hasOwn(value, key)) {
		return undefined;
	}
	const text = value[key];
	if (typeof text !== 'string') {
		issues.push({
			code: 'invalid_type',
			path,
			message: `${path} must be a string.`,
		});
		return undefined;
	}
	if (text.length > TASK_TRANSFER_LIMITS.maxTextLength) {
		issues.push({
			code: 'limit_exceeded',
			path,
			message: `${path} must not exceed ${TASK_TRANSFER_LIMITS.maxTextLength} characters.`,
		});
		return undefined;
	}

	return text;
}

/** 문서 로컬 key를 non-empty bounded string으로 읽는다. */
function readNodeKeyValue(
	value: Record<string, unknown>,
	key: string,
	path: string,
	issues: TaskTransferIssue[],
): string | undefined {
	if (!Object.hasOwn(value, key)) {
		return undefined;
	}
	const nodeKey = value[key];
	if (typeof nodeKey !== 'string') {
		issues.push({
			code: 'invalid_type',
			path,
			message: `${path} must be a string.`,
		});
		return undefined;
	}
	if (nodeKey.length === 0) {
		issues.push({
			code: 'invalid_value',
			path,
			message: `${path} must not be empty.`,
		});
		return undefined;
	}
	if (nodeKey.length > TASK_TRANSFER_LIMITS.maxNodeKeyLength) {
		issues.push({
			code: 'limit_exceeded',
			path,
			message: `${path} must not exceed ${TASK_TRANSFER_LIMITS.maxNodeKeyLength} characters.`,
		});
		return undefined;
	}

	return nodeKey;
}

/** Node kind union을 읽는다. */
function readNodeKind(
	value: Record<string, unknown>,
	path: string,
	issues: TaskTransferIssue[],
): TaskTransferNode['kind'] | undefined {
	if (!Object.hasOwn(value, 'kind')) {
		issues.push({
			code: 'missing_property',
			path,
			message: `Required Task transfer property is missing: ${path}.`,
		});
		return undefined;
	}
	const kind = value.kind;
	if (kind !== 'start' && kind !== 'work' && kind !== 'end') {
		issues.push({
			code: 'invalid_value',
			path,
			message: `${path} must be "start", "work", or "end".`,
		});
		return undefined;
	}

	return kind;
}

/** Work Agent provider allowlist를 읽는다. */
function readAgentProvider(
	value: Record<string, unknown>,
	path: string,
	issues: TaskTransferIssue[],
): WorkAgentProviderId | undefined {
	if (!Object.hasOwn(value, 'agentProviderId')) {
		return undefined;
	}
	const providerId = value.agentProviderId;
	if (!isWorkAgentProviderId(providerId)) {
		issues.push({
			code: 'invalid_value',
			path,
			message: `${path} must be a supported Work agent provider.`,
		});
		return undefined;
	}

	return providerId;
}

/** JSON number가 finite 좌표인지 읽는다. */
function readFiniteNumber(
	value: Record<string, unknown>,
	key: string,
	path: string,
	issues: TaskTransferIssue[],
): number | undefined {
	if (!Object.hasOwn(value, key)) {
		return undefined;
	}
	const number = value[key];
	if (typeof number !== 'number' || !Number.isFinite(number)) {
		issues.push({
			code: 'invalid_type',
			path,
			message: `${path} must be a finite number.`,
		});
		return undefined;
	}

	return number;
}

/** bounded 배열의 모든 항목을 path-aware parser로 읽는다. */
function parseArray<T>(
	input: unknown,
	path: string,
	maxLength: number,
	label: string,
	parseItem: (
		input: unknown,
		path: string,
		issues: TaskTransferIssue[],
	) => T | undefined,
	issues: TaskTransferIssue[],
): readonly T[] | undefined {
	if (!Array.isArray(input)) {
		issues.push({
			code: 'invalid_type',
			path,
			message: `${path} must be an array.`,
		});
		return undefined;
	}
	if (input.length > maxLength) {
		issues.push({
			code: 'limit_exceeded',
			path,
			message: `${label} must not contain more than ${maxLength} items.`,
		});
		return undefined;
	}

	const items: T[] = [];
	for (const [index, value] of input.entries()) {
		const item = parseItem(value, `${path}[${index}]`, issues);
		if (item) {
			items.push(item);
		}
	}

	return items.length === input.length ? items : undefined;
}

/** 같은 key가 두 번 이상 나타나면 key별 한 번만 반환한다. */
function findDuplicateNodeKeys(
	nodes: readonly TaskTransferNode[],
): readonly string[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();

	for (const node of nodes) {
		if (seen.has(node.key)) {
			duplicates.add(node.key);
		}
		seen.add(node.key);
	}

	return [...duplicates];
}

/** 오류 key가 있는 첫 Node의 JSON path를 찾는다. */
function findNodePath(document: TaskTransferDocument, key: string): string {
	const index = document.task.nodes.findIndex((node) => node.key === key);
	return index >= 0 ? `$.task.nodes[${index}]` : '$.task.nodes';
}

/** 임시 Edge ID에서 원래 JSON array index를 복원한다. */
function readTemporaryEdgeIndex(edgeId: string | undefined): number | undefined {
	if (!edgeId?.startsWith('task-edge:transfer-')) {
		return undefined;
	}
	const index = Number(edgeId.slice('task-edge:transfer-'.length));
	return Number.isInteger(index) ? index : undefined;
}

/** Task 안에서 kind에 맞는 유일 Node를 반환한다. */
function findSingleNode(
	task: TaskBlueprint,
	kind: 'start',
): StartNode;
function findSingleNode(
	task: TaskBlueprint,
	kind: 'end',
): EndNode;
function findSingleNode(
	task: TaskBlueprint,
	kind: 'start' | 'end',
): StartNode | EndNode {
	const node = task.nodes.find((candidate) => candidate.kind === kind);

	if (!node || node.kind !== kind) {
		throw new Error(`Task ${kind} node is missing.`);
	}
	return node;
}

/** Node ID/key map의 누락을 프로그래밍 오류로 명시한다. */
function readNodeKey(
	keyById: ReadonlyMap<string, string>,
	id: string,
): string {
	const key = keyById.get(id);
	if (!key) {
		throw new Error(`Task transfer node mapping is missing: ${id}.`);
	}

	return key;
}

/** 지정 kind Node 개수를 센다. */
function countNodes(
	document: TaskTransferDocument,
	kind: TaskTransferNode['kind'],
): number {
	return document.task.nodes.filter((node) => node.kind === kind).length;
}

/** catch 값의 안전한 사용자 메시지를 만든다. */
function readErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 한 issue를 가진 실패 결과를 만든다. */
function failure(issue: TaskTransferIssue): TaskTransferParseFailure {
	return { ok: false, issues: [issue] };
}
