import type {
	TaskGraphLayout,
	TaskLayoutEdge,
	TaskLayoutNode,
} from './taskLayout';

/** T-03 interaction이 Task 소유권을 판별할 때 사용할 DOM attribute다. */
export const TASK_ID_ATTRIBUTE = 'data-task-id';
/** T-03 interaction이 안정적인 Task Node ID를 읽을 DOM attribute다. */
export const TASK_NODE_ID_ATTRIBUTE = 'data-task-node-id';
/** Task Node 역할을 DOM에서 판별하는 attribute다. */
export const TASK_NODE_KIND_ATTRIBUTE = 'data-task-node-kind';
/** Task Edge를 식별하는 DOM attribute다. */
export const TASK_EDGE_ID_ATTRIBUTE = 'data-task-edge-id';

/** Task Node/Edge DOM을 ID 기반으로 갱신하고 정리하는 lifecycle 경계다. */
export interface TaskRenderer {
	/** 기존 DOM을 재사용하며 최신 Task Layout을 적용한다. */
	applyLayout(layout: TaskGraphLayout): void;
	/** Task Renderer가 만든 Node와 Edge DOM을 모두 정리한다. */
	dispose(): void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * 기존 Graph World의 Edge/Node Layer에 Task 전용 DOM을 렌더링한다.
 * Workspace GraphRenderer와 Map이나 모델을 공유하지 않고 DOM Layer만 공유한다.
 *
 * @param edgeLayer Workspace Edge와 함께 표시할 기존 SVG Layer
 * @param nodeLayer Workspace Node와 함께 표시할 기존 HTML Layer
 * @param initialLayout 최초 Task Layout
 * @returns Layout 갱신과 정리를 제공하는 Task Renderer
 */
export function initializeTaskRenderer(
	edgeLayer: SVGSVGElement,
	nodeLayer: HTMLElement,
	initialLayout: TaskGraphLayout,
): TaskRenderer {
	const ownerDocument = nodeLayer.ownerDocument;
	const nodeElements = new Map<string, HTMLElement>();
	const edgeElements = new Map<string, SVGPathElement>();
	let disposed = false;

	const applyLayout = (layout: TaskGraphLayout): void => {
		if (disposed) {
			return;
		}

		const nextNodeKeys = new Set(layout.nodes.map((node) => (
			createTaskNodeRenderKey(node.taskId, node.id)
		)));
		const nextEdgeKeys = new Set(layout.edges.map((edge) => (
			createTaskEdgeRenderKey(edge.taskId, edge.id)
		)));

		for (const [renderKey, element] of nodeElements) {
			if (!nextNodeKeys.has(renderKey)) {
				element.remove();
				nodeElements.delete(renderKey);
			}
		}

		for (const [renderKey, element] of edgeElements) {
			if (!nextEdgeKeys.has(renderKey)) {
				element.remove();
				edgeElements.delete(renderKey);
			}
		}

		const nodesByRenderKey = new Map(layout.nodes.map((node) => [
			createTaskNodeRenderKey(node.taskId, node.id),
			node,
		]));

		for (const node of layout.nodes) {
			const renderKey = createTaskNodeRenderKey(node.taskId, node.id);
			let element = nodeElements.get(renderKey);

			if (!element) {
				element = ownerDocument.createElement('div');
				nodeLayer.append(element);
				nodeElements.set(renderKey, element);
			}

			syncTaskNodeElement(element, node, ownerDocument);
		}

		for (const edge of layout.edges) {
			const source = nodesByRenderKey.get(createTaskNodeRenderKey(
				edge.taskId,
				edge.sourceId,
			));
			const target = nodesByRenderKey.get(createTaskNodeRenderKey(
				edge.taskId,
				edge.targetId,
			));

			if (!source || !target) {
				continue;
			}

			const renderKey = createTaskEdgeRenderKey(edge.taskId, edge.id);
			let element = edgeElements.get(renderKey);

			if (!element) {
				element = ownerDocument.createElementNS(SVG_NAMESPACE, 'path');
				edgeLayer.append(element);
				edgeElements.set(renderKey, element);
			}

			syncTaskEdgeElement(element, edge, source, target);
		}
	};

	applyLayout(initialLayout);

	return {
		applyLayout,
		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			for (const element of nodeElements.values()) {
				element.remove();
			}
			for (const element of edgeElements.values()) {
				element.remove();
			}
			nodeElements.clear();
			edgeElements.clear();
		},
	};
}

/** 같은 내부 Node ID를 가진 Task DOM을 분리하는 Renderer 전용 identity다. */
function createTaskNodeRenderKey(taskId: string, nodeId: string): string {
	return `${taskId}:${nodeId}`;
}

/** 같은 내부 Edge ID를 가진 Task SVG를 분리하는 Renderer 전용 identity다. */
function createTaskEdgeRenderKey(taskId: string, edgeId: string): string {
	return `${taskId}:${edgeId}`;
}

/** Task Node Card의 내용, 식별 정보와 World geometry를 최신 Layout과 맞춘다. */
function syncTaskNodeElement(
	element: HTMLElement,
	node: TaskLayoutNode,
	ownerDocument: Document,
): void {
	element.className = `graph-node task-node task-${node.kind}-node`;
	element.setAttribute(TASK_ID_ATTRIBUTE, node.taskId);
	element.setAttribute(TASK_NODE_ID_ATTRIBUTE, node.id);
	element.setAttribute(TASK_NODE_KIND_ATTRIBUTE, node.kind);
	element.setAttribute('role', 'group');
	element.setAttribute('aria-label', createTaskNodeAriaLabel(node));
	element.style.width = `${node.width}px`;
	element.style.height = `${node.height}px`;
	element.style.transform = `translate(${node.position.x}px, ${node.position.y}px)`;
	element.replaceChildren(...createTaskNodeContents(node, ownerDocument));
}

/** Task Node kind에 맞는 label과 Blueprint 텍스트 DOM을 생성한다. */
function createTaskNodeContents(
	node: TaskLayoutNode,
	ownerDocument: Document,
): HTMLElement[] {
	const kind = ownerDocument.createElement('span');

	kind.className = 'task-node-kind';
	kind.textContent = node.kind === 'start'
		? 'Start'
		: node.kind === 'work' ? 'Work' : 'End';

	if (node.kind === 'end') {
		return [kind];
	}

	const title = ownerDocument.createElement('strong');
	const description = ownerDocument.createElement('span');

	title.className = 'task-node-title';
	title.textContent = node.title;
	description.className = 'task-node-description';
	description.textContent = node.description;

	if (node.kind === 'start' || node.prompt.length === 0) {
		return [kind, title, description];
	}

	const prompt = ownerDocument.createElement('span');

	prompt.className = 'task-node-prompt';
	prompt.textContent = node.prompt;
	return [kind, title, description, prompt];
}

/** 접근성 이름은 화면에 표시하는 kind와 주요 제목만 포함한다. */
function createTaskNodeAriaLabel(node: TaskLayoutNode): string {
	if (node.kind === 'end') {
		return 'Task End';
	}

	return `Task ${node.kind === 'start' ? 'Start' : 'Work'}: ${node.title}`;
}

/** Task Edge의 소유권과 세로 Bezier geometry를 SVG path에 적용한다. */
function syncTaskEdgeElement(
	element: SVGPathElement,
	edge: TaskLayoutEdge,
	source: TaskLayoutNode,
	target: TaskLayoutNode,
): void {
	element.setAttribute('class', 'graph-edge task-edge');
	element.setAttribute(TASK_ID_ATTRIBUTE, edge.taskId);
	element.setAttribute(TASK_EDGE_ID_ATTRIBUTE, edge.id);
	element.setAttribute('data-task-edge-source', edge.sourceId);
	element.setAttribute('data-task-edge-target', edge.targetId);
	element.setAttribute('d', createTaskEdgePath(source, target));
}

/** Source 하단 중앙에서 Target 상단 중앙을 잇는 세로 Cubic Bezier path를 만든다. */
function createTaskEdgePath(
	source: TaskLayoutNode,
	target: TaskLayoutNode,
): string {
	const sourceX = source.position.x + source.width / 2;
	const sourceY = source.position.y + source.height;
	const targetX = target.position.x + target.width / 2;
	const targetY = target.position.y;
	const direction = targetY >= sourceY ? 1 : -1;
	const controlOffset = Math.max(24, Math.abs(targetY - sourceY) / 2);

	return [
		`M ${sourceX} ${sourceY}`,
		`C ${sourceX} ${sourceY + controlOffset * direction}`,
		`${targetX} ${targetY - controlOffset * direction}`,
		`${targetX} ${targetY}`,
	].join(' ');
}
