import type {
	AgentActivityStore,
	AgentActivityStoreSnapshot,
} from '../../agent/webview/agentActivityStore';
import type { GraphNodeEffectTarget } from '../../messages';
import type { AgentActivityBindings } from './agentActivityBindings';
import { getAgentActivityBindingBlockHeight } from './agentActivityBindings';
import { GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE } from './graphCamera';
import {
	getGraphLayoutRootId,
	getGraphLayoutSourceId,
	GRAPH_FOLDER_NODE_HEIGHT,
	GRAPH_FOLDER_NODE_WIDTH,
	type GraphLayout,
	type GraphLayoutNode,
	type GraphLayoutPosition,
} from './graphLayout';
import type { Graph, GraphRoot, GraphRootNode } from './graphModel';
import { parseGraphNodeUri } from './graphNodeUri';
import type { GraphNodeEffects } from './graphNodeEffects';
import { createAgentActivityTargetKey } from './agentActivityProjection';
import { isDetachedRootId } from './graphRootPromotion';

/** Activity projection이 만든 저장되지 않는 Graph Node의 DOM 식별자다. */
export const AGENT_ACTIVITY_GHOST_NODE_ATTRIBUTE =
	'data-agent-activity-ghost';
/** 한 Graph panel에 동시에 표시할 유령 Node 상한이다. */
export const AGENT_ACTIVITY_GHOST_NODE_LIMIT = 64;

const GHOST_COLUMN_GAP = 62;
const GHOST_ROW_GAP = 6;

/** Store의 provisional Target 하나를 World에 표시하기 위한 파생 geometry다. */
export interface AgentActivityGhostNodeProjection {
	readonly key: string;
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly targetKind: 'file' | 'folder';
	readonly name: string;
	readonly parentLayoutNodeId: string;
	readonly position: GraphLayoutPosition;
	readonly width: number;
	readonly height: number;
	readonly bindingCount: number;
}

/** 유령 Node DOM과 Store/Layout projection의 수명주기다. */
export interface AgentActivityGhostNodes {
	/** 최신 actual Graph Layout과 runtime 위치로 projection을 다시 계산한다. */
	syncLayout(
		layout: GraphLayout,
		positions: ReadonlyMap<string, GraphLayoutPosition>,
	): boolean;
	/** 현재 표시 중인 exact ghost Target의 World 중심을 반환한다. */
	getFocusPoint(
		target: Readonly<GraphNodeEffectTarget>,
	): GraphLayoutPosition | undefined;
	/** Store 구독, Effect/Binding registration과 모든 DOM을 정리한다. */
	dispose(): void;
}

export interface AgentActivityGhostNodeOptions {
	readonly nodeEffects?: Pick<GraphNodeEffects, 'registerNode'>;
	readonly agentActivityBindings?: Pick<
		AgentActivityBindings,
		'registerTarget' | 'getBindingCount'
	>;
	readonly limit?: number;
}

interface GraphNodeOccurrence {
	readonly node: GraphRootNode;
	readonly root: GraphRoot;
}

interface GhostRegistration {
	readonly element: HTMLElement;
	readonly target: Readonly<GraphNodeEffectTarget>;
	readonly disposeEffect: () => void;
	readonly disposeBindings: () => void;
	projection: AgentActivityGhostNodeProjection;
}

/**
 * 현재 Graph에 없는 Activity Target 중 direct parent가 actual container로 보이는
 * 대상만 유령 Node로 투영한다. 중간 path segment가 하나라도 비어 있으면 direct
 * parent를 찾을 수 없으므로 projection을 만들지 않는다.
 */
export function createAgentActivityGhostNodeProjections(
	snapshot: AgentActivityStoreSnapshot,
	graph: Graph,
	layout: GraphLayout,
	positions: ReadonlyMap<string, GraphLayoutPosition>,
	getBindingCount: (
		target: Readonly<GraphNodeEffectTarget>,
	) => number = (target) => snapshot.find(({ target: candidate }) => (
		createAgentActivityTargetKey(candidate)
			=== createAgentActivityTargetKey(target)
	))?.activities.length ?? 0,
	limit = AGENT_ACTIVITY_GHOST_NODE_LIMIT,
): readonly AgentActivityGhostNodeProjection[] {
	const normalizedLimit = Number.isFinite(limit)
		? Math.max(0, Math.floor(limit))
		: AGENT_ACTIVITY_GHOST_NODE_LIMIT;

	if (normalizedLimit === 0 || snapshot.length === 0) {
		return [];
	}

	const occurrences = collectGraphNodeOccurrences(graph);
	const occurrencesBySourceId = new Map<string, GraphNodeOccurrence[]>();
	const containerOccurrencesByUri = new Map<string, GraphNodeOccurrence[]>();

	for (const occurrence of occurrences) {
		const sourceOccurrences = occurrencesBySourceId.get(occurrence.node.id) ?? [];

		sourceOccurrences.push(occurrence);
		occurrencesBySourceId.set(occurrence.node.id, sourceOccurrences);
		if (occurrence.node.kind === 'file') {
			continue;
		}
		const parsed = parseGraphNodeUri(occurrence.node.id);

		if (!parsed) {
			continue;
		}
		const uriKey = createUriKey(parsed.uri);
		const containerOccurrences = containerOccurrencesByUri.get(uriKey) ?? [];

		containerOccurrences.push(occurrence);
		containerOccurrencesByUri.set(uriKey, containerOccurrences);
	}

	const candidates = snapshot
		.map((targetSnapshot) => ({
			target: targetSnapshot.target,
			sequence: Math.min(
				...targetSnapshot.activities.map(({ sequence }) => sequence),
			),
		}))
		.filter(({ target }) => getBindingCount(target) > 0)
		.sort((left, right) => (
			left.sequence - right.sequence
				|| createAgentActivityTargetKey(left.target).localeCompare(
					createAgentActivityTargetKey(right.target),
				)
		));
	const projections: AgentActivityGhostNodeProjection[] = [];
	const nextStackOffsetByParent = new Map<string, number>();

	for (const { target } of candidates) {
		if (projections.length >= normalizedLimit) {
			break;
		}
		if (hasGraphTargetOccurrence(
			occurrencesBySourceId.get(target.nodeId) ?? [],
			target,
		)) {
			continue;
		}
		const parsedTarget = parseGraphNodeUri(target.nodeId);

		if (!parsedTarget || parsedTarget.kind === 'project') {
			continue;
		}
		const parentUri = createParentUri(parsedTarget.uri);

		if (!parentUri) {
			continue;
		}
		const parent = resolveVisibleParentLayoutNode(
			containerOccurrencesByUri.get(createUriKey(parentUri)) ?? [],
			target,
			layout,
		);

		if (!parent) {
			continue;
		}
		const bindingCount = getBindingCount(target);
		const parentPosition = positions.get(parent.id) ?? parent.position;
		const arrangedChildrenBottom = resolveArrangedChildrenBottom(
			parent,
			layout,
			positions,
		);
		const stackOffset = nextStackOffsetByParent.get(parent.id) ?? 0;
		const projection: AgentActivityGhostNodeProjection = Object.freeze({
			key: createAgentActivityTargetKey(target),
			target: Object.freeze({ ...target }),
			targetKind: parsedTarget.kind,
			name: getUriBaseName(parsedTarget.uri),
			parentLayoutNodeId: parent.id,
			position: Object.freeze({
				x: parentPosition.x + parent.width + GHOST_COLUMN_GAP,
				y: (arrangedChildrenBottom === undefined
					? parentPosition.y
					: arrangedChildrenBottom + GHOST_ROW_GAP)
					+ stackOffset,
			}),
			width: GRAPH_FOLDER_NODE_WIDTH,
			height: GRAPH_FOLDER_NODE_HEIGHT,
			bindingCount,
		});

		projections.push(projection);
		nextStackOffsetByParent.set(
			parent.id,
			stackOffset + projection.height
				+ getAgentActivityBindingBlockHeight(bindingCount)
				+ GHOST_ROW_GAP,
		);
	}

	return Object.freeze(projections);
}

/** Store와 Renderer layout을 별도 ephemeral DOM projection으로 연결한다. */
export function initializeAgentActivityGhostNodes(
	nodeLayer: HTMLElement,
	store: AgentActivityStore,
	getGraph: () => Graph,
	options: AgentActivityGhostNodeOptions = {},
): AgentActivityGhostNodes {
	const registrations = new Map<string, GhostRegistration>();
	let currentLayout: GraphLayout | undefined;
	let currentPositions: ReadonlyMap<string, GraphLayoutPosition> = new Map();
	let disposed = false;

	const removeRegistration = (registration: GhostRegistration): void => {
		registration.disposeBindings();
		registration.disposeEffect();
		registration.element.remove();
	};
	const reconcile = (): boolean => {
		if (disposed || !currentLayout) {
			return false;
		}
		const projections = createAgentActivityGhostNodeProjections(
			store.getSnapshot(),
			getGraph(),
			currentLayout,
			currentPositions,
			options.agentActivityBindings?.getBindingCount,
			options.limit,
		);
		const nextKeys = new Set(projections.map(({ key }) => key));
		let changed = false;

		for (const [key, registration] of registrations) {
			if (nextKeys.has(key)) {
				continue;
			}
			removeRegistration(registration);
			registrations.delete(key);
			changed = true;
		}

		for (const projection of projections) {
			const current = registrations.get(projection.key);

			if (current) {
				current.projection = projection;
				applyGhostProjection(current.element, projection);
				continue;
			}
			const element = createGhostElement(nodeLayer.ownerDocument, projection);

			nodeLayer.append(element);
			registrations.set(projection.key, {
				element,
				target: projection.target,
				projection,
				disposeEffect: options.nodeEffects?.registerNode(
					projection.target,
					element,
				) ?? (() => {}),
				disposeBindings: options.agentActivityBindings?.registerTarget(
					projection.target,
					element,
				) ?? (() => {}),
			});
			changed = true;
		}

		return changed;
	};
	const unsubscribe = store.subscribe(() => {
		reconcile();
	});

	return {
		syncLayout(layout, positions): boolean {
			if (disposed) {
				return false;
			}
			currentLayout = layout;
			currentPositions = positions;
			return reconcile();
		},

		getFocusPoint(target): GraphLayoutPosition | undefined {
			const projection = registrations.get(
				createAgentActivityTargetKey(target),
			)?.projection;

			return projection ? {
				x: projection.position.x + projection.width / 2,
				y: projection.position.y + projection.height / 2,
			} : undefined;
		},

		dispose(): void {
			if (disposed) {
				return;
			}

			disposed = true;
			unsubscribe();
			for (const registration of registrations.values()) {
				removeRegistration(registration);
			}
			registrations.clear();
			currentLayout = undefined;
			currentPositions = new Map();
		},
	};
}

function collectGraphNodeOccurrences(graph: Graph): readonly GraphNodeOccurrence[] {
	const occurrences: GraphNodeOccurrence[] = [];

	for (const root of graph.roots) {
		const rootNode = graph.rootNodes[root.nodeId];

		if (!rootNode) {
			continue;
		}
		const visited = new Set<string>();
		const visit = (node: GraphRootNode): void => {
			if (visited.has(node.id)) {
				return;
			}
			visited.add(node.id);
			occurrences.push({ node, root });
			if (node.kind === 'file') {
				return;
			}
			for (const child of node.children) {
				visit(child);
			}
		};

		visit(rootNode);
	}

	return occurrences;
}

function hasGraphTargetOccurrence(
	occurrences: readonly GraphNodeOccurrence[],
	target: Readonly<GraphNodeEffectTarget>,
): boolean {
	return occurrences.some(({ root }) => (
		target.rootId === undefined || target.rootId === root.id
	));
}

function resolveVisibleParentLayoutNode(
	occurrences: readonly GraphNodeOccurrence[],
	target: Readonly<GraphNodeEffectTarget>,
	layout: GraphLayout,
): GraphLayoutNode | undefined {
	for (const occurrence of occurrences) {
		if (target.rootId !== undefined && target.rootId !== occurrence.root.id) {
			continue;
		}
		for (const node of layout.nodes) {
			if (
				node.hidden === true
				|| (node.kind !== 'project' && node.kind !== 'folder')
				|| getGraphLayoutSourceId(node.id) !== occurrence.node.id
			) {
				continue;
			}
			const layoutRootId = getGraphLayoutRootId(node.id);
			const occurrenceIsDetached = isDetachedRootId(occurrence.root.id);

			if (
				(occurrenceIsDetached && layoutRootId === occurrence.root.id)
				|| (!occurrenceIsDetached && layoutRootId === undefined)
			) {
				return node;
			}
		}
	}

	return undefined;
}

/** 기존 arranged child flow의 마지막 subtree 아래에 ghost sibling을 잇는다. */
function resolveArrangedChildrenBottom(
	parent: GraphLayoutNode,
	layout: GraphLayout,
	positions: ReadonlyMap<string, GraphLayoutPosition>,
): number | undefined {
	const nodesById = new Map(layout.nodes.map((node) => [node.id, node]));
	const arrangedChildIdsByParent = new Map<string, string[]>();

	for (const edge of layout.edges) {
		if (
			edge.hidden === true
			|| !layout.arrangedNodeIds.has(edge.targetId)
		) {
			continue;
		}
		const childIds = arrangedChildIdsByParent.get(edge.sourceId) ?? [];

		childIds.push(edge.targetId);
		arrangedChildIdsByParent.set(edge.sourceId, childIds);
	}
	const directChildIds = arrangedChildIdsByParent.get(parent.id) ?? [];

	if (directChildIds.length === 0) {
		return undefined;
	}
	const getSubtreeBottom = (nodeId: string, visited: Set<string>): number => {
		if (visited.has(nodeId)) {
			return Number.NEGATIVE_INFINITY;
		}
		visited.add(nodeId);
		const node = nodesById.get(nodeId);

		if (!node || node.hidden === true) {
			return Number.NEGATIVE_INFINITY;
		}
		const position = positions.get(node.id) ?? node.position;
		let bottom = position.y + Math.max(
			node.height,
			node.renderedHeight ?? 0,
			node.graphContentHeight ?? 0,
		);

		for (const childId of arrangedChildIdsByParent.get(nodeId) ?? []) {
			bottom = Math.max(bottom, getSubtreeBottom(childId, visited));
		}
		return bottom;
	};
	const bottoms = directChildIds.map((nodeId) => (
		getSubtreeBottom(nodeId, new Set())
	)).filter(Number.isFinite);

	return bottoms.length > 0 ? Math.max(...bottoms) : undefined;
}

function createParentUri(uri: URL): URL | undefined {
	const pathname = normalizeUriPath(uri.pathname);
	const lastSeparator = pathname.lastIndexOf('/');

	if (lastSeparator < 0 || pathname === '/') {
		return undefined;
	}
	const parent = new URL(uri.toString());

	parent.pathname = lastSeparator === 0 ? '/' : pathname.slice(0, lastSeparator);
	return parent;
}

function createUriKey(uri: URL): string {
	return JSON.stringify([
		uri.protocol,
		uri.username,
		uri.password,
		uri.host,
		normalizeUriPath(uri.pathname),
		uri.search,
		uri.hash,
	]);
}

function normalizeUriPath(pathname: string): string {
	return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function getUriBaseName(uri: URL): string {
	const pathname = normalizeUriPath(uri.pathname);
	const segment = pathname.slice(pathname.lastIndexOf('/') + 1);

	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

function createGhostElement(
	ownerDocument: Document,
	projection: AgentActivityGhostNodeProjection,
): HTMLElement {
	const element = ownerDocument.createElement('div');
	const icon = ownerDocument.createElement('span');
	const name = ownerDocument.createElement('span');

	element.className = 'graph-node graph-agent-activity-ghost-node';
	element.setAttribute(AGENT_ACTIVITY_GHOST_NODE_ATTRIBUTE, '');
	element.setAttribute(GRAPH_CAMERA_PAN_IGNORE_ATTRIBUTE, '');
	element.setAttribute('role', 'group');
	icon.className = 'graph-node-icon graph-agent-activity-ghost-icon';
	icon.setAttribute('aria-hidden', 'true');
	name.className = 'graph-agent-activity-ghost-name';
	element.append(icon, name);
	applyGhostProjection(element, projection);
	return element;
}

function applyGhostProjection(
	element: HTMLElement,
	projection: AgentActivityGhostNodeProjection,
): void {
	const displayName = projection.targetKind === 'folder'
		? `${projection.name}/`
		: projection.name;

	element.setAttribute('data-graph-node-id', projection.target.nodeId);
	element.setAttribute('data-target-kind', projection.targetKind);
	element.setAttribute('data-parent-layout-node-id', projection.parentLayoutNodeId);
	if (projection.target.rootId === undefined) {
		element.removeAttribute('data-graph-root-id');
	} else {
		element.setAttribute('data-graph-root-id', projection.target.rootId);
	}
	element.setAttribute('aria-label', `${displayName} 아직 생성되지 않음`);
	element.title = `${displayName} — 아직 생성되지 않은 대상`;
	element.style.width = `${projection.width}px`;
	element.style.height = `${projection.height}px`;
	element.style.transform = `translate(${projection.position.x}px, ${projection.position.y}px)`;
	const name = element.children[1] as HTMLElement | undefined;

	if (name) {
		name.textContent = displayName;
	}
}
