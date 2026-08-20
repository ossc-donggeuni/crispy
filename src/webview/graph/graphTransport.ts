import type {
	Graph,
	GraphRoot,
	GraphRootContext,
	GraphRootNode,
	ProjectEntry,
} from './graphModel';

/** Extension Host가 Webview 초기 HTML에 Graph를 전달할 수 있도록 직렬화한다. */
export function serializeGraphForWebview(graph: Graph): string {
	return encodeURIComponent(JSON.stringify(graph));
}

/** Webview 초기 HTML에서 전달받은 Graph를 복원한다. */
export function deserializeGraphFromWebview(
	serializedGraph: string | undefined,
): Graph {
	if (!serializedGraph) {
		throw new Error('Missing initial Workspace Graph');
	}

	return JSON.parse(decodeURIComponent(serializedGraph)) as Graph;
}

/** Workspace 메시지로 받은 unknown 값을 기존 Graph 모델로 검증하고 복사한다. */
export function parseGraph(value: unknown): Graph | undefined {
	if (!isRecord(value) || !hasExactFields(value, ['roots', 'rootNodes'])) {
		return undefined;
	}
	if (!Array.isArray(value.roots) || !isRecord(value.rootNodes)) {
		return undefined;
	}

	const roots: GraphRoot[] = [];
	for (const valueRoot of value.roots) {
		const root = parseGraphRoot(valueRoot);

		if (!root) {
			return undefined;
		}

		roots.push(root);
	}

	const rootNodeEntries: Array<[string, GraphRootNode]> = [];
	for (const [nodeId, valueNode] of Object.entries(value.rootNodes)) {
		const node = parseGraphRootNode(valueNode, new WeakSet());

		if (!node || node.id !== nodeId) {
			return undefined;
		}

		rootNodeEntries.push([nodeId, node]);
	}

	const rootNodes = Object.fromEntries(rootNodeEntries);
	if (roots.some((root) => !Object.hasOwn(rootNodes, root.nodeId))) {
		return undefined;
	}

	return { roots, rootNodes };
}

/** Graph Root의 필수 ID와 선택적 Context만 허용한다. */
function parseGraphRoot(value: unknown): GraphRoot | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const fields = Object.hasOwn(value, 'context')
		? ['id', 'nodeId', 'context']
		: ['id', 'nodeId'];

	if (
		!hasExactFields(value, fields)
		|| typeof value.id !== 'string'
		|| typeof value.nodeId !== 'string'
	) {
		return undefined;
	}

	if (!Object.hasOwn(value, 'context')) {
		return { id: value.id, nodeId: value.nodeId };
	}

	const context = parseGraphRootContext(value.context);

	return context
		? { id: value.id, nodeId: value.nodeId, context }
		: undefined;
}

/** Detached Root의 원래 상대 경로 Context를 검증한다. */
function parseGraphRootContext(value: unknown): GraphRootContext | undefined {
	return isRecord(value)
		&& hasExactFields(value, ['relativePath'])
		&& typeof value.relativePath === 'string'
		? { relativePath: value.relativePath }
		: undefined;
}

/** Project, Folder와 File Tree를 순환 참조 없이 기존 Graph Node로 복사한다. */
function parseGraphRootNode(
	value: unknown,
	ancestors: WeakSet<object>,
): GraphRootNode | undefined {
	if (!isRecord(value) || ancestors.has(value)) {
		return undefined;
	}

	if (value.kind === 'file') {
		return hasExactFields(value, ['kind', 'id', 'name'])
			&& typeof value.id === 'string'
			&& typeof value.name === 'string'
			? { kind: 'file', id: value.id, name: value.name }
			: undefined;
	}

	if (
		(value.kind !== 'project' && value.kind !== 'folder')
		|| !hasExactFields(value, ['kind', 'id', 'name', 'status', 'children'])
		|| typeof value.id !== 'string'
		|| typeof value.name !== 'string'
		|| (value.status !== 'loaded' && value.status !== 'unreadable')
		|| !Array.isArray(value.children)
	) {
		return undefined;
	}

	ancestors.add(value);
	const children: ProjectEntry[] = [];

	for (const valueChild of value.children) {
		const child = parseGraphRootNode(valueChild, ancestors);

		if (!child || child.kind === 'project') {
			ancestors.delete(value);
			return undefined;
		}

		children.push(child);
	}

	ancestors.delete(value);
	return value.kind === 'project'
		? {
			kind: 'project',
			id: value.id,
			name: value.name,
			status: value.status,
			children,
		}
		: {
			kind: 'folder',
			id: value.id,
			name: value.name,
			status: value.status,
			children,
		};
}

/** 배열과 null을 제외한 일반 객체인지 판별한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 객체가 허용된 필드를 빠짐없이 정확히 한 번씩 가지는지 확인한다. */
function hasExactFields(
	value: Readonly<Record<string, unknown>>,
	fields: readonly string[],
): boolean {
	const keys = Object.keys(value);

	return keys.length === fields.length
		&& fields.every((field) => Object.hasOwn(value, field));
}
